import { createHmac, randomBytes } from 'node:crypto';
import { resolveMx, resolveTxt } from 'node:dns/promises';
import type { App } from './app.js';
import { type Config, DEFAULTS, HARD_DAILY_LIMIT, settingsProblems } from './config.js';
import { all, getMeta, likeText, logEvent, one, run, setMeta } from './db.js';

const FREE_WORDS = 6;
// Said plainly, a request to stop needs no model. Anything less clear goes to the model, which can tell "stop emailing me" from "does it stop emailing people?".
const DIRECT_STOP = [
  /(^|[.!,;]\s+)(please\s+|pls\s+|kindly\s+)?(stop|quit)\s+(emailing|e-mailing|contacting|writing|messaging|mailing|sending)\b/im,
  /\b(remove|unsubscribe|delete)\s+me\b/i, /\btake\s+me\s+off\b/i, /\bopt\s+me\s+out\b/i, /\bdelete\s+my\s+(data|details|information)\b/i,
  /\b(do\s+not|don'?t|never)\s+(email|e-mail|contact|write\s+to|message)\s+(me|us)\b/i, /\bno\s+more\s+e-?mails?\b/i, /\bwithdraw\s+my\s+consent\b/i,
  // Spanish, German, French, Polish, Portuguese, Italian, Russian
  /\b(darme\s+de\s+baja|dejen?\s+de\s+(escribir|enviar)|no\s+me\s+(escriban|env[ií]en|escribas))\b/i,
  /\b(abmelden|abbestellen|keine\s+e-?mails?\s+mehr|nicht\s+mehr\s+(kontaktieren|schreiben|anschreiben)|schreiben\s+sie\s+mir\s+nicht)\b/i,
  /(d[ée]sabonner|d[ée]sinscrire|ne\s+plus\s+(m'|me\s+)(envoyer|contacter|[ée]crire)|arr[êe]tez\s+de\s+m)/i,
  /(wypisz|wypisa[ćc]|nie\s+pisz|prosz[ęe]\s+nie\s+pisa[ćc]|usu[ńn]\s+mnie|usu[ńn]cie\s+mnie)/i,
  /(descadastr|parem?\s+de\s+(me\s+)?(enviar|escrever)|n[ãa]o\s+me\s+(envie|escreva))/i, /(disiscriv|non\s+scrivetemi|smettete\s+di)/i,
  /(отпиш|не\s+пишите|удалите\s+меня|перестаньте\s+писать)/i,
];
const SHORT_STOP = /^\W*(please\s+)?(stop|unsubscribe|opt[\s-]?out|remove|no\s+thanks?|no\s+thank\s+you|not\s+interested)\W*((thanks?|thank\s+you|please|now|sorry)\W*)*$/i;
const SUBJECT_STOP = /^\s*((re|aw|sv|odp)\s*:\s*)?(stop|unsubscribe|remove\s+me|opt[\s-]?out)\s*[.!]*\s*$/i;

/** What the person wrote, without the mail they quoted or their signature: above or below a quote, it may be anywhere. */
export function ownWords(text: string): string {
  const out: string[] = [];
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*--\s*$/.test(line)) break; // the signature, and our own footer when it comes back unquoted
    if (/^\s*>/.test(line) || /^\s*On\b.*\bwrote:\s*$/.test(line) || /^\s*-{2,}\s*(Original|Forwarded) Message/i.test(line)) continue;
    if (/Reply "stop" and I won't write again/.test(line)) continue;
    out.push(line);
  }
  return out.join('\n').trim();
}

export function asksToStop(subject: string, text: string): boolean {
  const own = ownWords(text);
  if (SUBJECT_STOP.test(subject)) return true;
  if (DIRECT_STOP.some((re) => re.test(own))) return true;
  if (own.split(/\s+/).filter(Boolean).length <= FREE_WORDS && !/\bbut\b/i.test(own) && !own.includes('?')) return SHORT_STOP.test(own);
  return false;
}

const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';
/** a+work@b.com and a@b.com reach one person. */
export const baseAddress = (email: string) => { const [local = '', domain = ''] = email.trim().toLowerCase().split('@'); return domain ? `${local.split('+')[0]}@${domain}` : email.trim().toLowerCase(); };
const cleanEntry = (v: string) => v.trim().toLowerCase().replace(/^@/, '').replace(/^www\./, '').replace(/^https?:\/\//, '').replace(/\/.*$/, '');
// a.b.example.com is also covered by b.example.com and example.com
const suffixes = (d: string) => { const p = d.split('.'); return p.slice(0, -1).map((_, i) => p.slice(i).join('.')); };

export function isSuppressed(a: App, email: string): string | null {
  const e = email.trim().toLowerCase(); const scope = new Set([e, baseAddress(e), ...suffixes(domainOf(e))]);
  if (a.config.do_not_contact.some((x) => scope.has(cleanEntry(x)))) return 'on your do-not-contact list';
  for (const v of scope) { const hit = one<{ reason: string }>(a.db, 'select reason from suppression where value = ?', v); if (hit) return hit.reason; }
  return null;
}

export function suppress(a: App, value: string, reason: string) {
  const v = value.includes('@') ? baseAddress(value) : cleanEntry(value);
  run(a.db, 'insert into suppression (value, reason, created_at) values (?, ?, ?) on conflict (value) do nothing', v, reason, a.now().toISOString());
  const alias = v.includes('@') ? `${likeText(v.split('@')[0]!)}+%@${likeText(v.split('@')[1] ?? '')}` : `%@${likeText(v)}`;
  run(a.db, `update drafts set status = 'cancelled' where status in ('pending','approved','blocked')
    and contact_id in (select id from contacts where email = ? or email like ? escape '\\' or email like ? escape '\\')`, v, alias, `%.${likeText(v)}`);
  logEvent(a.db, a.now(), 'suppression.added', { value: v, reason });
}

export const isStopped = (a: App) => getMeta(a.db, 'stopped_reason');
export function stopSending(a: App, reason: string) { setMeta(a.db, 'stopped_reason', reason); logEvent(a.db, a.now(), 'sending.stopped', { reason }); }
// Bounces before a resume were looked at by a person: they count from here, or the stop would fire again at once.
export function resumeSending(a: App) { setMeta(a.db, 'stopped_reason', null); setMeta(a.db, 'bounces_since', a.now().toISOString()); logEvent(a.db, a.now(), 'sending.resumed'); }

/** Ramp from warmup_start, capped by the config, and by a ceiling the config cannot raise. Anything unreadable means the lowest figure. */
export function dailyLimit(c: Config, now: Date): number {
  const num = (v: unknown, dflt: number) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : dflt);
  const ceiling = Math.min(num(c.limits.max_per_day, HARD_DAILY_LIMIT), HARD_DAILY_LIMIT);
  const start = Math.min(num(c.limits.start_per_day, DEFAULTS.limits.start_per_day), ceiling);
  const from = c.warmup_start ? new Date(c.warmup_start).getTime() : NaN;
  if (Number.isNaN(from)) return start;
  const days = Math.max(0, Math.floor((now.getTime() - from) / 86_400_000));
  return Math.min(start + days * num(c.limits.add_per_day, 0), ceiling);
}

export function inSendingHours(c: Config, now: Date): boolean {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: c.limits.timezone, hour: 'numeric', hourCycle: 'h23', weekday: 'short' }).formatToParts(now);
  const hour = Number(parts.find((p) => p.type === 'hour')?.value);
  const wd = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'].indexOf(parts.find((p) => p.type === 'weekday')?.value ?? '');
  return c.limits.weekdays.includes(wd) && hour >= c.limits.send_hours[0] && hour < c.limits.send_hours[1];
}

export const sentToday = (a: App) => {
  const since = new Date(a.now().getTime() - 86_400_000).toISOString();
  return one<{ n: number }>(a.db, "select count(*) as n from drafts where status = 'sent' and sent_at > ?", since)?.n ?? 0;
};

/**
 * Of the last 200 people written to, the share whose address bounced. Stops all sending above the limit, once there is
 * something to go on: 20 people, or 3 bounces, so a bad list is caught early and one unlucky address among 10 is not.
 */
export function checkBounces(a: App): boolean {
  const since = getMeta(a.db, 'bounces_since') ?? '';
  const people = all<{ status: string }>(a.db, `select p.status, min(d.sent_at) as first_sent from drafts d join contacts p on p.id = d.contact_id
    where d.status = 'sent' and d.sent_at > ? group by p.id order by first_sent desc limit 200`, since);
  const bounced = people.filter((p) => p.status === 'bounced').length;
  if (people.length < 20 && bounced < 3) return false;
  const rate = bounced / people.length;
  if (rate <= a.config.limits.bounce_stop_rate) return false;
  stopSending(a, `${bounced} of the last ${people.length} people bounced (${(rate * 100).toFixed(1)}%). Check your list, then outlevo resume.`);
  return true;
}

export function footer(c: Config): string {
  return `\n\n--\n${c.sender.name}, ${c.sender.company}\n${c.sender.postal_address}\nNot for you? Reply "stop" and I won't write again.`;
}

/** Names the person in the subject, not the address: it works on any mail server, and an unsubscribe sent from a forwarded mailbox still finds who it is for. Signed, so nobody can opt out someone else. */
export function unsubscribeToken(a: App, contactId: number) {
  let secret = getMeta(a.db, 'unsubscribe_secret');
  if (!secret) { secret = randomBytes(24).toString('hex'); setMeta(a.db, 'unsubscribe_secret', secret); }
  return `u${contactId}-${createHmac('sha256', secret).update(String(contactId)).digest('hex').slice(0, 16)}`;
}
export const unsubscribeHeader = (a: App, contactId?: number | null) => ({ 'List-Unsubscribe': `<mailto:${a.config.sender.email}?subject=unsubscribe${contactId ? `-${unsubscribeToken(a, contactId)}` : ''}>` });
/** The contact an unsubscribe subject really names, if any. */
export function unsubscribedContact(a: App, subject: string): number | null {
  const m = subject.match(/\bunsubscribe-(u(\d+)-[0-9a-f]{16})\b/i);
  return m && m[1]!.toLowerCase() === unsubscribeToken(a, Number(m[2])) ? Number(m[2]) : null;
}

export type Check = { name: string; ok: boolean; blocking: boolean; detail: string };
type Dns = { txt: (name: string) => Promise<string[][]>; mx: (name: string) => Promise<unknown[]> };
const realDns: Dns = { txt: resolveTxt, mx: resolveMx };

/** What must hold before the first email leaves. Blocking checks stop sending; the rest are advice. */
export async function readiness(a: App, dns: Dns = realDns): Promise<Check[]> {
  const c = a.config; const out: Check[] = [];
  const add = (name: string, ok: boolean, blocking: boolean, detail: string) => out.push({ name, ok, blocking, detail });
  const domain = domainOf(c.sender.email);
  add('Sender name and company', !!c.sender.name && !!c.sender.company, true, 'sender.name and sender.company');
  add('Postal address', String(c.sender.postal_address ?? '').trim().length > 10, true, 'CAN-SPAM needs a real postal address in every email: sender.postal_address');
  const wrong = settingsProblems(c);
  add('Settings', !wrong.length, true, wrong.join('; '));
  add('Sending address', !!domain, true, 'sender.email: an address on a separate domain you bought for sending, not your main one');
  add('Mailbox', !!c.smtp.host && !!c.smtp.user && !!a.secrets.smtp_password, true, 'From your email provider\'s SMTP settings: smtp.host and smtp.user (and smtp.port, smtp.secure if not 465 with TLS), and the password in OUTLEVO_SMTP_PASSWORD');
  add('Replies can be read', !!c.imap.host && !!c.imap.user && !!a.secrets.imap_password, true, 'Opt-outs arrive as replies, so sending needs imap.host and imap.user from the same provider (imap.port, imap.secure if not 993 with TLS)');
  add('Booking link', !!c.booking_url.trim(), false, 'booking_url, your Calendly or Cal.com link, so an interested reply can book a meeting');
  add('A source of contacts', !!a.secrets.hunter_key || !!a.secrets.outlevo_key, false, 'HUNTER_API_KEY or outlevo cloud connect. Without one you can only write to people you import or addresses printed on their sites');
  add('Model', c.model.provider !== 'anthropic' || !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN, false, 'ANTHROPIC_API_KEY, to research and write');
  if (domain) {
    const txt = async (n: string) => (await dns.txt(n).catch(() => [] as string[][])).map((r) => r.join(''));
    const mx = await dns.mx(domain).catch(() => []);
    const spf = (await txt(domain)).some((r) => /^v=spf1/i.test(r));
    const dmarc = (await txt(`_dmarc.${domain}`)).some((r) => /^v=dmarc1/i.test(r));
    let dkim = false;
    for (const s of ['google', 'selector1', 'selector2', 'default', 'k1', 's1', 's2', 'dkim', 'mail']) if ((await txt(`${s}._domainkey.${domain}`)).some((r) => /p=/.test(r))) { dkim = true; break; }
    add('MX record', mx.length > 0, true, `${domain} must be able to receive replies. Your email provider gives you the MX records to add at the place you bought the domain`);
    add('SPF', spf, true, `SPF tells the world who may send for your domain. At the place you bought ${domain}, add a TXT record named @ with what your provider gives you, for example: v=spf1 include:_spf.google.com ~all (that one is for Google Workspace)`);
    add('DMARC', dmarc, true, `DMARC says what to do with mail that fails those checks. Add a TXT record named _dmarc with: v=DMARC1; p=none; rua=mailto:${c.sender.email}`);
    add('DKIM', dkim, false, 'DKIM signs your mail. Turn it on in your email provider\'s admin page, which gives you a record to add. No key under the usual names was found; a custom one will not show here');
    const own = c.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    add('A separate sending domain', domain !== own, false, 'Cold email from your main domain can land all your company mail in spam. Use something like get' + (own ?? 'yourcompany.com'));
    add('Warm-up date', !!c.warmup_start, false, `warmup_start. New mailboxes need 2-4 weeks of warm-up. Until it is set you send ${c.limits.start_per_day} a day at most`);
  }
  return out;
}
export const ready = (checks: Check[]) => checks.every((x) => x.ok || !x.blocking);
