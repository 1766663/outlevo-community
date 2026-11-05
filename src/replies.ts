import { ImapFlow, type MailboxObject } from 'imapflow';
import { simpleParser } from 'mailparser';
import { type App, nullable, obj, S, UNTRUSTED, untrusted } from './app.js';
import { asksToStop, type Check, checkBounces, footer, isStopped, isSuppressed, ownWords, readiness, ready, suppress, unsubscribedContact, unsubscribeHeader } from './compliance.js';
import { all, getMeta, likeText, logEvent, one, run, setMeta } from './db.js';
import { normalizeDomain } from './csv.js';
import { lintEmail, linksIn } from './lint.js';
import { linkDomains } from './pipeline.js';

export type Incoming = { messageId: string; from: string; subject: string; text: string; autoSubmitted?: boolean; authenticated?: boolean; authServer?: string; inReplyTo?: string | undefined; references?: string[]; receivedAt: Date };
export interface Inbox { fetchNew(sinceUid: number, knownValidity?: string | null): Promise<{ messages: Array<Incoming & { uid: number }>; lastUid: number; validity?: string }> }

/**
 * Where to read from. A mailbox that started numbering again would hide new mail below the last number read, opt-outs and bounces included.
 * So it is read from the start: what was already handled is recognised by its Message-ID, and costs no model call.
 */
export const readFrom = (sinceUid: number, known: string | null | undefined, mailbox: { validity: string; uidNext: number }) =>
  (known && known !== mailbox.validity) || mailbox.uidNext <= sinceUid ? 0 : sinceUid;

const CLASSES = ['interested', 'question', 'not_now', 'wrong_person', 'unsubscribe', 'out_of_office', 'other'] as const;

/** The words of a message, with what a delivery report attaches: the status, and the mail it is about. */
export const mailText = (p: { text?: string | undefined; attachments: Array<{ contentType: string; content: Buffer }> }) =>
  [p.text ?? '', ...p.attachments.filter((x) => /delivery-status|rfc822/i.test(x.contentType)).map((x) => x.content.toString('utf8'))].join('\n');

export function imapInbox(a: App): Inbox {
  const { imap } = a.config;
  if (!imap.host || !imap.user || !a.secrets.imap_password) throw new Error('Set imap.host, imap.user and OUTLEVO_IMAP_PASSWORD so replies can be read');
  return {
    async fetchNew(sinceUid, knownValidity) {
      const c = new ImapFlow({ host: imap.host, port: imap.port, secure: imap.secure, ...(imap.secure ? {} : { doSTARTTLS: true }), auth: { user: imap.user, pass: a.secrets.imap_password! }, logger: false });
      await c.connect();
      const lock = await c.getMailboxLock('INBOX');
      const box = c.mailbox as MailboxObject;
      const validity = String(box.uidValidity);
      const start = readFrom(sinceUid, knownValidity, { validity, uidNext: box.uidNext });
      const messages: Array<Incoming & { uid: number }> = []; let lastUid = start;
      try {
        for await (const m of c.fetch(`${start + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (m.uid <= start || !m.source) continue;
          lastUid = Math.max(lastUid, m.uid);
          const p = await simpleParser(m.source);
          const from = p.from?.value[0]?.address?.toLowerCase() ?? '';
          messages.push({ uid: m.uid, messageId: p.messageId ?? `uid-${m.uid}`, from, authenticated: from.split('@').length === 2 && senderProven(p.headers.get('authentication-results'), from.split('@')[1]!, authServers(imap)), authServer: authServerOf(p.headers.get('authentication-results')), subject: p.subject ?? '', text: mailText(p), inReplyTo: p.inReplyTo, references: ([] as string[]).concat(p.references ?? []), autoSubmitted: /auto-replied|auto-generated/i.test(String(p.headers.get('auto-submitted') ?? '')), receivedAt: p.date ?? new Date() });
        }
      } finally { lock.release(); await c.logout(); }
      return { messages, lastUid, validity };
    },
  };
}

// A booking tool or a calendar says so by email. A booking stops a company's emails, so the sender has to be proven:
// a From header costs nothing to forge, the verdict your mail provider put on the message does not.
const BOOKING_SENDER = /^[^@]+@((.*\.)?calendly\.com|(.*\.)?cal\.com)$|^calendar-notification@google\.com$/i;
const REMINDER = /\breminder\b/i;
const CANCELLED = /\b(cancel+ed|declined)\b/i;
const BOOKED = /\b(new event|invitation|booked|confirmed|scheduled|rescheduled)\b/i;
const ADDRESS = /(?<![a-z0-9._%+-])[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;
const MESSAGE_ID = /<[^<>\s]+@[^<>\s]+>/g;
const MAX_NAMED = 100;

const topHeader = (header: unknown): string => {
  const first = Array.isArray(header) ? header[0] : header;
  return typeof first === 'string' ? first : typeof (first as any)?.value === 'string' ? (first as any).value : '';
};
/** The server that signed a verdict, the first word of the header. */
export const authServerOf = (header: unknown) => topHeader(header).replace(/\([^)]*\)/g, ' ').split(';')[0]!.trim().split(/\s+/)[0]!.toLowerCase();

const AUTH_SERVERS: Record<string, string> = { 'gmail.com': 'google.com', 'googlemail.com': 'google.com', 'fastmail.com': 'messagingengine.com', 'zoho.com': 'zohomail.com', 'zoho.eu': 'zohomail.eu' };
/**
 * Whose verdict counts: your mail provider's. A sender can write the same header, and if the provider adds none, theirs is on top.
 * imap.auth_server says who, for a provider this cannot work out, and "any" trusts the top header whoever wrote it.
 */
export function authServers(imap: { host: string; auth_server?: string }): string[] | undefined {
  const set = imap.auth_server?.trim().toLowerCase();
  if (set === 'any') return undefined;
  if (set) return [set];
  const labels = imap.host.toLowerCase().split('.');
  const short = labels.length > 2 && labels.at(-1)!.length === 2 && /^(co|com|org|net|ac|gov)$/.test(labels.at(-2)!);
  const base = labels.slice(short ? -3 : -2).join('.');
  return [base, ...(AUTH_SERVERS[base] ? [AUTH_SERVERS[base]!] : [])];
}

/** Reads the topmost Authentication-Results, the one your own provider added, if `servers` names who that is. Anything else in the message came from the sender. */
export function senderProven(header: unknown, fromDomain: string, servers?: string[]): boolean {
  if (!fromDomain) return false;
  const raw = topHeader(header);
  if (servers) { const by = authServerOf(header); if (!servers.some((s) => by === s || by.endsWith(`.${s}`))) return false; }
  // Comments and quoted strings can carry anything: only the verdicts themselves count, one method at a time.
  const verdicts = raw.replace(/\([^)]*\)/g, ' ').replace(/"[^"]*"/g, ' ').split(';').map((x: string) => x.trim());
  const d = fromDomain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = `@?(?:[a-z0-9-]+\\.)*${d}(?![a-z0-9.-])`;
  const dmarc = new RegExp(`^dmarc=pass\\b.*\\bheader\\.from=${own}`, 'i'); const dkim = new RegExp(`^dkim=pass\\b.*\\bheader\\.[di]=${own}`, 'i');
  return verdicts.some((v: string) => dmarc.test(v) || dkim.test(v));
}

/** The person this booking is with: an exact address in the message, someone we really wrote to, the latest first. */
function bookedContact(a: App, text: string) {
  const found = new Set((text.match(ADDRESS) ?? []).map((x) => x.toLowerCase()));
  return all<{ id: number; email: string }>(a.db, `select p.id, p.email from contacts p
    where exists (select 1 from drafts d where d.contact_id = p.id and d.status = 'sent')
    order by (select max(d.sent_at) from drafts d where d.contact_id = p.id) desc`).find((c) => found.has(c.email));
}

function handleBooking(a: App, m: Incoming): boolean {
  if (!BOOKING_SENDER.test(m.from)) return false;
  if (!m.authenticated) { logEvent(a.db, a.now(), 'meeting.unproven', { from: m.from, subject: m.subject.slice(0, 200), verdict_by: m.authServer ?? null }); return true; }
  if (REMINDER.test(m.subject)) return true;
  const who = bookedContact(a, `${m.subject}\n${m.text}`);
  if (!who) return true;
  if (CANCELLED.test(m.subject)) {
    run(a.db, "update meetings set status = 'cancelled' where contact_id = ? and status = 'booked'", who.id);
    logEvent(a.db, a.now(), 'meeting.cancelled', { contact_id: who.id });
  } else if (BOOKED.test(m.subject)) addMeeting(a, who.id, m.from.split('@')[1] ?? 'email', m.subject, m.messageId);
  return true;
}

/** One booked meeting a person: a reminder, an update or a new time does not make another. */
export function addMeeting(a: App, contactId: number, source: string, title: string | null, messageId: string | null = null) {
  const c = one<{ company_id: number }>(a.db, 'select company_id from contacts where id = ?', contactId);
  if (!c) throw new Error(`No contact ${contactId}`);
  if (one(a.db, "select 1 from meetings where contact_id = ? and status = 'booked'", contactId)) return;
  if (messageId && one(a.db, 'select 1 from meetings where message_id = ?', messageId)) return;
  run(a.db, 'insert into meetings (contact_id, source, title, message_id, booked_at) values (?, ?, ?, ?, ?)', contactId, source, title, messageId, a.now().toISOString());
  run(a.db, "update drafts set status = 'cancelled' where status in ('pending','approved','blocked') and contact_id in (select id from contacts where company_id = ?)", c.company_id);
  // They have a time now: an answer still waiting would only offer them the calendar again.
  run(a.db, "update replies set suggested_status = 'dismissed' where suggested_status = 'pending' and contact_id in (select id from contacts where company_id = ?)", c.company_id);
  logEvent(a.db, a.now(), 'meeting.booked', { contact_id: contactId, source });
}

/** Someone interested always gets a draft with the booking link, even if the model wrote none: this step is too important to leave to it. */
export function withBookingLink(a: App, cls: string, suggested: string | null): string | null {
  const url = a.config.booking_url.trim();
  if (!url || cls !== 'interested' || suggested?.includes(url)) return suggested;
  return `${suggested?.trimEnd() || 'Glad to talk it through.'}\n\nPick a time here: ${url}`;
}

const cancelRest = (a: App, contactId: number) => run(a.db, "update drafts set status = 'cancelled' where contact_id = ? and status in ('pending','approved','blocked')", contactId);

function handleBounce(a: App, m: Incoming): boolean {
  if (!/^(mailer-daemon|postmaster|mail-daemon)@[^@]+$/i.test(m.from)) return false;
  // Someone we wrote to at postmaster@ is a person answering, and may be asking to stop.
  if (one(a.db, 'select 1 from contacts where email = ?', m.from)) return false;
  // A bounce stops a person and can stop all sending, and a From line costs nothing to forge. The surest proof is our own Message-ID quoted back:
  // only whoever received that email has it, and then it is that person's own address at stake.
  const ids = [...new Set(m.text.match(MESSAGE_ID) ?? [])].slice(0, 100);
  const quoted = ids.length ? one<{ id: number; email: string }>(a.db, `select p.id, p.email from drafts d join contacts p on p.id = d.contact_id where d.status = 'sent' and d.message_id in (${ids.map(() => '?').join(',')}) limit 1`, ...ids) : undefined;
  // An exact address: ann@ must not take the blame for joann@.
  const named = [...new Set((m.text.match(ADDRESS) ?? []).map((x) => x.toLowerCase()))].slice(0, MAX_NAMED); // A real bounce names a few; this much would overflow the query and jam the inbox.
  const hit = quoted ?? bookedContact(a, m.text) ?? (named.length ? one<{ id: number; email: string }>(a.db, `select id, email from contacts where status = 'active' and email in (${named.map(() => '?').join(',')}) limit 1`, ...named) : undefined);
  // Failing that, a verified sender, on your domain or theirs: a stranger can verify a mailer-daemon on a domain of their own.
  const host = m.from.split('@')[1] ?? '';
  const onSide = (email: string) => [email.split('@')[1], a.config.sender.email.split('@')[1]].some((d) => d && (host === d || host.endsWith(`.${d}`)));
  if (hit && !quoted && !(m.authenticated && onSide(hit.email))) {
    logEvent(a.db, a.now(), 'bounce.unproven', { from: m.from, contact_id: hit.id, subject: m.subject.slice(0, 200) });
    return true;
  }
  if (hit) {
    run(a.db, "update contacts set status = 'bounced' where id = ?", hit.id);
    cancelRest(a, hit.id);
    suppress(a, hit.email, 'bounced');
    logEvent(a.db, a.now(), 'email.bounced', { contact_id: hit.id });
    checkBounces(a);
  }
  return true;
}

type Who = { id: number; first_name: string; company_id: number; email: string };
/** Who this is from. An alias, an assistant or a forward answering our thread still counts: an opt-out must not get lost on the address it came from. */
function whoWrote(a: App, m: Incoming): { contact: Who | undefined; direct: boolean } {
  const q = 'select id, first_name, company_id, email from contacts where ';
  const exact = one<Who>(a.db, `${q}email = ?`, m.from);
  if (exact) return { contact: exact, direct: true };
  const [local = '', domain = ''] = m.from.split('@');
  const plus = all<Who>(a.db, `${q}email like ? escape '\\'`, `%@${likeText(domain)}`).find((c) => c.email.split('@')[0]!.split('+')[0] === local.split('+')[0]);
  if (plus) return { contact: plus, direct: true };
  for (const id of [m.inReplyTo, ...(m.references ?? [])]) {
    if (!id) continue;
    const t = one<Who>(a.db, `select p.id, p.first_name, p.company_id, p.email from drafts d join contacts p on p.id = d.contact_id where d.message_id = ?`, id);
    if (t) return { contact: t, direct: false };
  }
  // A colleague with no thread is only taken at their word when asking to stop.
  const colleague = domain ? one<Who>(a.db, `select p.id, p.first_name, p.company_id, p.email from contacts p join drafts d on d.contact_id = p.id where d.status = 'sent' and p.email like ? escape '\\' order by d.sent_at desc`, `%@${likeText(domain)}`) : undefined;
  return colleague && asksToStop(m.subject, m.text) ? { contact: colleague, direct: false } : { contact: undefined, direct: false };
}

/** The List-Unsubscribe mailto, signed for one person: it counts for them from whichever address it arrives. */
function handleUnsubscribe(a: App, m: Incoming): boolean {
  const id = unsubscribedContact(a, m.subject);
  const contact = id ? one<Who>(a.db, 'select id, first_name, company_id, email from contacts where id = ?', id) : undefined;
  if (!contact) return false;
  if (one(a.db, 'select 1 from replies where message_id = ?', m.messageId)) return true;
  cancelRest(a, contact.id);
  run(a.db, "update drafts set status = 'cancelled' where status in ('pending','approved') and contact_id in (select id from contacts where company_id = ?)", contact.company_id);
  suppress(a, contact.email, 'asked to stop');
  if (m.from.includes('@') && m.from !== contact.email) suppress(a, m.from, 'asked to stop');
  run(a.db, "insert into replies (contact_id, message_id, from_addr, subject, text, class, reason, received_at, suggested_status, verified) values (?, ?, ?, ?, ?, 'unsubscribe', 'Used the unsubscribe link', ?, 'none', 1)", contact.id, m.messageId, m.from, m.subject, m.text.slice(0, 20_000), m.receivedAt.toISOString());
  logEvent(a.db, a.now(), 'reply.received', { contact_id: contact.id, class: 'unsubscribe' });
  return true;
}

/** Reads new mail. Nothing goes out from here: an answer is only ever a suggestion waiting for you. */
export async function checkReplies(a: App, inbox: Inbox = imapInbox(a)) {
  const since = Number(getMeta(a.db, 'imap_last_uid') ?? 0);
  const { messages, lastUid, validity } = await inbox.fetchNew(since, getMeta(a.db, 'imap_uid_validity'));
  let handled = 0;
  for (const m of messages) {
    if (handleUnsubscribe(a, m)) { handled++; continue; }
    if (handleBounce(a, m)) { handled++; continue; }
    // A person we wrote to who works at Calendly or Cal.com is a person: their reply, or their opt-out, comes first.
    const { contact } = whoWrote(a, m);
    if (!contact && handleBooking(a, m)) { handled++; continue; }
    if (!contact) {
      // Asked by someone we cannot place: costs nothing to honour.
      if (m.from.includes('@') && asksToStop(m.subject, m.text)) suppress(a, m.from, 'asked to stop');
      logEvent(a.db, a.now(), 'mail.unmatched', { from: m.from, subject: m.subject.slice(0, 200) });
      continue;
    }
    if (one(a.db, 'select 1 from replies where message_id = ?', m.messageId)) continue;
    handled++;

    let cls: (typeof CLASSES)[number]; let reason: string | null = null; let suggested: string | null = null;
    const words = ownWords(m.text);
    if (asksToStop(m.subject, m.text)) { cls = 'unsubscribe'; reason = 'Asked not to be written to'; }
    else if (m.autoSubmitted) { cls = 'out_of_office'; reason = 'An automatic reply'; }
    else {
      try {
        const product = one<{ summary: string }>(a.db, 'select summary from product');
        const facts = all<{ text: string }>(a.db, 'select text from product_facts');
        const r = await a.model().json<{ class: (typeof CLASSES)[number]; reason: string; suggested_reply: string | null }>({
          name: 'classify_reply', effort: 'medium',
          system: `You read a reply to a cold email and draft an answer for a founder to review. ${UNTRUSTED} Answer only from the facts about our product; when they do not cover a question, say the founder will come back on it. Suggest a reply for interested and question only, under 80 words, plain text; otherwise null. To someone interested, propose a short call and do not invent a time or a link: the booking link is added for you. Treat a request to stop, in any language, as unsubscribe. A person saying they are not interested counts as unsubscribe only if they want no more email.`,
          user: `We sell: ${product?.summary ?? ''}\nFacts:\n${facts.map((f) => `- ${f.text}`).join('\n')}\n\nReply from ${contact.first_name}:\n${untrusted(m.from, (words || m.text).slice(0, 6000))}`,
          schema: obj({ class: { type: 'string', enum: [...CLASSES] }, reason: S, suggested_reply: nullable('string') }),
        });
        cls = r.class; reason = r.reason; suggested = withBookingLink(a, r.class, r.suggested_reply);
      } catch (e) { cls = 'other'; reason = `Not classified: ${(e as Error).message}`; }
    }
    // Out of office is not an answer: the sequence carries on when its time comes. Anything else stops it, for the company too.
    if (cls !== 'out_of_office') {
      cancelRest(a, contact.id);
      run(a.db, "update drafts set status = 'cancelled' where status in ('pending','approved') and contact_id in (select id from contacts where company_id = ?)", contact.company_id);
    }
    if (cls === 'unsubscribe') { suppress(a, contact.email, 'asked to stop'); if (m.from !== contact.email) suppress(a, m.from, 'asked to stop'); }
    run(a.db, `insert into replies (contact_id, message_id, from_addr, subject, text, class, reason, received_at, suggested, suggested_status, verified) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      contact.id, m.messageId, m.from, m.subject, m.text.slice(0, 20_000), cls, reason, m.receivedAt.toISOString(), suggested, suggested ? 'pending' : 'none', m.authenticated ? 1 : 0);
    logEvent(a.db, a.now(), 'reply.received', { contact_id: contact.id, class: cls });
  }
  setMeta(a.db, 'imap_last_uid', String(lastUid));
  if (validity) setMeta(a.db, 'imap_uid_validity', validity);
  return { read: messages.length, handled };
}

/** An answer is mail too: the kill switch, suppression and the readiness checks hold. Hours and daily limits do not: they asked. */
export async function sendSuggestedReply(a: App, replyId: number, deps: { checks?: () => Promise<Check[]> } = {}) {
  const r = one<{ id: number; contact_id: number | null; from_addr: string; subject: string | null; suggested: string | null; suggested_status: string; message_id: string }>(a.db, 'select * from replies where id = ?', replyId);
  if (!r?.suggested || r.suggested_status !== 'pending') throw new Error(`Reply ${replyId} has no answer waiting`);
  const stopped = isStopped(a);
  if (stopped) throw new Error(`Sending is stopped: ${stopped}`);
  // Someone can write from an alias after asking to stop on their main address, or the other way round.
  const who = r.contact_id ? one<{ email: string; domain: string }>(a.db, 'select p.email, c.domain from contacts p join companies c on c.id = p.company_id where p.id = ?', r.contact_id) : undefined;
  for (const address of [r.from_addr, ...(who ? [who.email] : [])]) {
    const why = isSuppressed(a, address);
    if (why) throw new Error(`Not sent: ${address} is suppressed (${why})`);
  }
  // A model drafted this after reading a stranger's words, so it may not carry a link they planted.
  const booking = normalizeDomain(a.config.booking_url);
  const allowedLinkDomains = [...linkDomains(a, who?.domain ?? r.from_addr.split('@')[1] ?? ''), ...(booking ? [booking] : [])];
  const badLink = lintEmail({ subject: 'x', body: r.suggested, strict: false, allowedLinkDomains }).find((x) => x.rule === 'link-domain');
  if (badLink) throw new Error(`Not sent: ${badLink.message}. Dismiss this answer and write your own.`);
  // calendly.com/you is your calendar, calendly.com/them is not.
  if (booking && !linkDomains(a, who?.domain ?? '').includes(booking)) {
    const own = new URL(/^https?:/i.test(a.config.booking_url) ? a.config.booking_url : `https://${a.config.booking_url}`).pathname.replace(/\/$/, '');
    for (const l of linksIn(r.suggested)) {
      const u = new URL(l.url); const host = u.hostname.replace(/^www\./, '');
      if ((host === booking || host.endsWith(`.${booking}`)) && u.pathname !== own && !u.pathname.startsWith(`${own}/`)) throw new Error(`Not sent: a link goes to ${host}${u.pathname}, which is not your booking page. Dismiss this answer and write your own.`);
    }
  }
  const checks = await (deps.checks ? deps.checks() : readiness(a));
  if (!ready(checks)) throw new Error(`Not ready to send: ${checks.filter((c) => !c.ok && c.blocking).map((c) => c.name).join(', ')}. Run: outlevo doctor`);
  if (!run(a.db, "update replies set suggested_status = 'sent' where id = ? and suggested_status = 'pending'", replyId).changes) throw new Error(`Reply ${replyId} has no answer waiting`);
  const s = a.config.sender;
  try {
    await a.mailer().send({ from: `${s.name} <${s.email}>`, to: r.from_addr, subject: /^re:/i.test(r.subject ?? '') ? r.subject! : `Re: ${r.subject ?? ''}`, text: r.suggested + footer(a.config), headers: unsubscribeHeader(a, r.contact_id), inReplyTo: r.message_id, references: r.message_id });
  } catch (e) { run(a.db, "update replies set suggested_status = 'pending' where id = ?", replyId); throw e; }
  logEvent(a.db, a.now(), 'reply.sent', { reply_id: replyId });
  return { sent: true };
}
