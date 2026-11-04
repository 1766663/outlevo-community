import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { type App, nullable, obj, S, UNTRUSTED, untrusted } from './app.js';
import { asksToStop, type Check, checkBounces, footer, isStopped, isSuppressed, ownWords, readiness, ready, suppress } from './compliance.js';
import { all, getMeta, logEvent, one, run, setMeta } from './db.js';

export type Incoming = { messageId: string; from: string; subject: string; text: string; autoSubmitted?: boolean; authenticated?: boolean; inReplyTo?: string | undefined; references?: string[]; receivedAt: Date };
export interface Inbox { fetchNew(sinceUid: number): Promise<{ messages: Array<Incoming & { uid: number }>; lastUid: number }> }

const CLASSES = ['interested', 'question', 'not_now', 'wrong_person', 'unsubscribe', 'out_of_office', 'other'] as const;

export function imapInbox(a: App): Inbox {
  const { imap } = a.config;
  if (!imap.host || !imap.user || !a.secrets.imap_password) throw new Error('Set imap.host, imap.user and OUTLEVO_IMAP_PASSWORD so replies can be read');
  return {
    async fetchNew(sinceUid) {
      const c = new ImapFlow({ host: imap.host, port: imap.port, secure: imap.secure, auth: { user: imap.user, pass: a.secrets.imap_password! }, logger: false });
      await c.connect();
      const lock = await c.getMailboxLock('INBOX');
      const messages: Array<Incoming & { uid: number }> = []; let lastUid = sinceUid;
      try {
        for await (const m of c.fetch(`${sinceUid + 1}:*`, { uid: true, source: true }, { uid: true })) {
          if (m.uid <= sinceUid || !m.source) continue;
          lastUid = Math.max(lastUid, m.uid);
          const p = await simpleParser(m.source);
          const from = p.from?.value[0]?.address?.toLowerCase() ?? '';
          messages.push({ uid: m.uid, messageId: p.messageId ?? `uid-${m.uid}`, from, authenticated: senderProven(p.headers.get('authentication-results'), from.split('@')[1] ?? ''), subject: p.subject ?? '', text: [p.text ?? '', ...p.attachments.filter((x) => /delivery-status|rfc822-headers/i.test(x.contentType)).map((x) => x.content.toString('utf8'))].join('\n'), inReplyTo: p.inReplyTo, references: ([] as string[]).concat(p.references ?? []), autoSubmitted: /auto-replied|auto-generated/i.test(String(p.headers.get('auto-submitted') ?? '')), receivedAt: p.date ?? new Date() });
        }
      } finally { lock.release(); await c.logout(); }
      return { messages, lastUid };
    },
  };
}

// A booking tool or a calendar says so by email. A booking stops a company's emails, so the sender has to be proven:
// a From header costs nothing to forge, the verdict your mail provider put on the message does not.
const BOOKING_SENDER = /@((.*\.)?calendly\.com|(.*\.)?cal\.com)$|^calendar-notification@google\.com$/i;
const REMINDER = /\breminder\b/i;
const CANCELLED = /\b(cancel+ed|declined)\b/i;
const BOOKED = /\b(new event|invitation|booked|confirmed|scheduled|rescheduled)\b/i;
const ADDRESS = /[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi;

/** Reads the topmost Authentication-Results, the one your own provider added. Anything else in the message came from the sender. */
export function senderProven(header: unknown, fromDomain: string): boolean {
  const first = Array.isArray(header) ? header[0] : header;
  const text = typeof first === 'string' ? first : typeof (first as any)?.value === 'string' ? (first as any).value : '';
  const d = fromDomain.toLowerCase().replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const own = `@?(?:[a-z0-9-]+\\.)*${d}(?![a-z0-9.-])`;
  return new RegExp(`\\bdmarc=pass\\b[^;]*header\\.from=${own}`, 'i').test(text)
    || new RegExp(`\\bdkim=pass\\b[^;]*header\\.[di]=${own}`, 'i').test(text);
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
  if (!m.authenticated) { logEvent(a.db, a.now(), 'meeting.unproven', { from: m.from, subject: m.subject.slice(0, 200) }); return true; }
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
  if (!/^(mailer-daemon|postmaster|mail-daemon)@/i.test(m.from)) return false;
  const hit = all<{ id: number; email: string }>(a.db, "select id, email from contacts where status = 'active'").find((c) => m.text.toLowerCase().includes(c.email));
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
  const plus = all<Who>(a.db, `${q}email like ?`, `%@${domain}`).find((c) => c.email.split('@')[0]!.split('+')[0] === local.split('+')[0]);
  if (plus) return { contact: plus, direct: true };
  for (const id of [m.inReplyTo, ...(m.references ?? [])]) {
    if (!id) continue;
    const t = one<Who>(a.db, `select p.id, p.first_name, p.company_id, p.email from drafts d join contacts p on p.id = d.contact_id where d.message_id = ?`, id);
    if (t) return { contact: t, direct: false };
  }
  // A colleague with no thread is only taken at their word when asking to stop.
  const colleague = domain ? one<Who>(a.db, `select p.id, p.first_name, p.company_id, p.email from contacts p join drafts d on d.contact_id = p.id where d.status = 'sent' and p.email like ? order by d.sent_at desc`, `%@${domain}`) : undefined;
  return colleague && asksToStop(m.subject, m.text) ? { contact: colleague, direct: false } : { contact: undefined, direct: false };
}

/** Reads new mail. Nothing goes out from here: an answer is only ever a suggestion waiting for you. */
export async function checkReplies(a: App, inbox: Inbox = imapInbox(a)) {
  const since = Number(getMeta(a.db, 'imap_last_uid') ?? 0);
  const { messages, lastUid } = await inbox.fetchNew(since);
  let handled = 0;
  for (const m of messages) {
    if (handleBounce(a, m)) { handled++; continue; }
    // A person we wrote to who works at Calendly or Cal.com is a person: their reply, or their opt-out, comes first.
    const { contact } = whoWrote(a, m);
    if (!contact && handleBooking(a, m)) { handled++; continue; }
    if (!contact) { logEvent(a.db, a.now(), 'mail.unmatched', { from: m.from, subject: m.subject.slice(0, 200) }); continue; }
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
    run(a.db, `insert into replies (contact_id, message_id, from_addr, subject, text, class, reason, received_at, suggested, suggested_status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      contact.id, m.messageId, m.from, m.subject, m.text.slice(0, 20_000), cls, reason, m.receivedAt.toISOString(), suggested, suggested ? 'pending' : 'none');
    logEvent(a.db, a.now(), 'reply.received', { contact_id: contact.id, class: cls });
  }
  setMeta(a.db, 'imap_last_uid', String(lastUid));
  return { read: messages.length, handled };
}

/** An answer is mail too: the kill switch, suppression and the readiness checks hold. Hours and daily limits do not: they asked. */
export async function sendSuggestedReply(a: App, replyId: number, deps: { checks?: () => Promise<Check[]> } = {}) {
  const r = one<{ id: number; from_addr: string; subject: string | null; suggested: string | null; suggested_status: string; message_id: string }>(a.db, 'select * from replies where id = ?', replyId);
  if (!r?.suggested || r.suggested_status !== 'pending') throw new Error(`Reply ${replyId} has no answer waiting`);
  const stopped = isStopped(a);
  if (stopped) throw new Error(`Sending is stopped: ${stopped}`);
  const why = isSuppressed(a, r.from_addr);
  if (why) throw new Error(`Not sent: ${r.from_addr} is suppressed (${why})`);
  const checks = await (deps.checks ? deps.checks() : readiness(a));
  if (!ready(checks)) throw new Error(`Not ready to send: ${checks.filter((c) => !c.ok && c.blocking).map((c) => c.name).join(', ')}. Run: outlevo doctor`);
  if (!run(a.db, "update replies set suggested_status = 'sent' where id = ? and suggested_status = 'pending'", replyId).changes) throw new Error(`Reply ${replyId} has no answer waiting`);
  const s = a.config.sender;
  try {
    await a.mailer().send({ from: `${s.name} <${s.email}>`, to: r.from_addr, subject: /^re:/i.test(r.subject ?? '') ? r.subject! : `Re: ${r.subject ?? ''}`, text: r.suggested + footer(a.config), inReplyTo: r.message_id, references: r.message_id });
  } catch (e) { run(a.db, "update replies set suggested_status = 'pending' where id = ?", replyId); throw e; }
  logEvent(a.db, a.now(), 'reply.sent', { reply_id: replyId });
  return { sent: true };
}
