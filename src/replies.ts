import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { type App, nullable, obj, S, UNTRUSTED, untrusted } from './app.js';
import { checkBounces, footer, OPT_OUT, suppress } from './compliance.js';
import { all, getMeta, logEvent, one, run, setMeta } from './db.js';

export type Incoming = { messageId: string; from: string; subject: string; text: string; autoSubmitted?: boolean; receivedAt: Date };
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
          messages.push({ uid: m.uid, messageId: p.messageId ?? `uid-${m.uid}`, from: p.from?.value[0]?.address?.toLowerCase() ?? '', subject: p.subject ?? '', text: p.text ?? '', autoSubmitted: /auto-replied|auto-generated/i.test(String(p.headers.get('auto-submitted') ?? '')), receivedAt: p.date ?? new Date() });
        }
      } finally { lock.release(); await c.logout(); }
      return { messages, lastUid };
    },
  };
}

// A booking tool or a calendar says so by email. Forged mail could only raise a counter here: nothing is sent because of it.
const BOOKING_SENDER = /@(calendly\.com|cal\.com|.*\.cal\.com)$|^calendar-notification@google\.com$/i;
const BOOKED = /\b(new event|invitation|booked|confirmed|scheduled)\b/i;
const CANCELLED = /\b(cancel+ed|canceled event)\b/i;

function handleBooking(a: App, m: Incoming): boolean {
  if (!BOOKING_SENDER.test(m.from)) return false;
  const body = `${m.subject}\n${m.text}`.toLowerCase();
  const who = all<{ id: number; email: string; company_id: number }>(a.db, 'select id, email, company_id from contacts').find((c) => body.includes(c.email));
  if (!who) return true;
  if (CANCELLED.test(m.subject)) {
    run(a.db, "update meetings set status = 'cancelled' where contact_id = ? and status = 'booked'", who.id);
    logEvent(a.db, a.now(), 'meeting.cancelled', { contact_id: who.id });
  } else if (BOOKED.test(m.subject)) addMeeting(a, who.id, m.from.split('@')[1] ?? 'email', m.subject, m.messageId);
  return true;
}

export function addMeeting(a: App, contactId: number, source: string, title: string | null, messageId: string | null = null) {
  const c = one<{ company_id: number }>(a.db, 'select company_id from contacts where id = ?', contactId);
  if (!c) throw new Error(`No contact ${contactId}`);
  if (messageId && one(a.db, 'select 1 from meetings where message_id = ?', messageId)) return;
  run(a.db, 'insert into meetings (contact_id, source, title, message_id, booked_at) values (?, ?, ?, ?, ?)', contactId, source, title, messageId, a.now().toISOString());
  run(a.db, "update drafts set status = 'cancelled' where status in ('pending','approved','blocked') and contact_id in (select id from contacts where company_id = ?)", c.company_id);
  logEvent(a.db, a.now(), 'meeting.booked', { contact_id: contactId, source });
}

/** The answer to someone interested always carries the booking link: that step is too important to leave to the model. */
export function withBookingLink(a: App, cls: string, suggested: string | null): string | null {
  const url = a.config.booking_url.trim();
  if (!suggested || !url || cls !== 'interested' || suggested.includes(url)) return suggested;
  return `${suggested.trimEnd()}\n\nPick a time here: ${url}`;
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

/** Reads new mail. Nothing goes out from here: an answer is only ever a suggestion waiting for you. */
export async function checkReplies(a: App, inbox: Inbox = imapInbox(a)) {
  const since = Number(getMeta(a.db, 'imap_last_uid') ?? 0);
  const { messages, lastUid } = await inbox.fetchNew(since);
  let handled = 0;
  for (const m of messages) {
    if (handleBounce(a, m)) { handled++; continue; }
    if (handleBooking(a, m)) { handled++; continue; }
    const contact = one<{ id: number; first_name: string; company_id: number; email: string }>(a.db, 'select id, first_name, company_id, email from contacts where email = ?', m.from);
    if (!contact) continue;
    if (one(a.db, 'select 1 from replies where message_id = ?', m.messageId)) continue;
    handled++;
    cancelRest(a, contact.id);
    // The rest of the company waits too: one person answering is enough for now.
    run(a.db, "update drafts set status = 'cancelled' where status in ('pending','approved') and contact_id in (select id from contacts where company_id = ?)", contact.company_id);

    let cls: (typeof CLASSES)[number]; let reason: string | null = null; let suggested: string | null = null;
    const firstLines = m.text.split(/\n>|\nOn .* wrote:/)[0] ?? m.text;
    if (OPT_OUT.test(firstLines) || /unsubscribe/i.test(m.subject)) { cls = 'unsubscribe'; reason = 'Asked not to be written to'; }
    else if (m.autoSubmitted) { cls = 'out_of_office'; reason = 'An automatic reply'; }
    else {
      try {
        const product = one<{ summary: string }>(a.db, 'select summary from product');
        const facts = all<{ text: string }>(a.db, 'select text from product_facts');
        const r = await a.model().json<{ class: (typeof CLASSES)[number]; reason: string; suggested_reply: string | null }>({
          name: 'classify_reply', effort: 'medium',
          system: `You read a reply to a cold email and draft an answer for a founder to review. ${UNTRUSTED} Answer only from the facts about our product; when they do not cover a question, say the founder will come back on it. Suggest a reply for interested and question only, under 80 words, plain text; otherwise null. To someone interested, propose a short call and do not invent a time or a link: the booking link is added for you. Treat a request to stop as unsubscribe.`,
          user: `We sell: ${product?.summary ?? ''}\nFacts:\n${facts.map((f) => `- ${f.text}`).join('\n')}\n\nReply from ${contact.first_name}:\n${untrusted(m.from, firstLines.slice(0, 6000))}`,
          schema: obj({ class: { type: 'string', enum: [...CLASSES] }, reason: S, suggested_reply: nullable('string') }),
        });
        cls = r.class; reason = r.reason; suggested = withBookingLink(a, r.class, r.suggested_reply);
      } catch (e) { cls = 'other'; reason = `Not classified: ${(e as Error).message}`; }
    }
    if (cls === 'unsubscribe') suppress(a, contact.email, 'asked to stop');
    run(a.db, `insert into replies (contact_id, message_id, from_addr, subject, text, class, reason, received_at, suggested, suggested_status) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      contact.id, m.messageId, m.from, m.subject, m.text.slice(0, 20_000), cls, reason, m.receivedAt.toISOString(), suggested, suggested ? 'pending' : 'none');
    logEvent(a.db, a.now(), 'reply.received', { contact_id: contact.id, class: cls });
  }
  setMeta(a.db, 'imap_last_uid', String(lastUid));
  return { read: messages.length, handled };
}

export function sendSuggestedReply(a: App, replyId: number) {
  const r = one<{ id: number; from_addr: string; subject: string | null; suggested: string | null; suggested_status: string; message_id: string }>(a.db, 'select * from replies where id = ?', replyId);
  if (!r?.suggested || r.suggested_status !== 'pending') throw new Error(`Reply ${replyId} has no answer waiting`);
  const s = a.config.sender;
  return a.mailer().send({ from: `${s.name} <${s.email}>`, to: r.from_addr, subject: /^re:/i.test(r.subject ?? '') ? r.subject! : `Re: ${r.subject ?? ''}`, text: r.suggested + footer(a.config), inReplyTo: r.message_id, references: r.message_id })
    .then(() => { run(a.db, "update replies set suggested_status = 'sent' where id = ?", replyId); logEvent(a.db, a.now(), 'reply.sent', { reply_id: replyId }); return { sent: true }; });
}
