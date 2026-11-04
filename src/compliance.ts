import { resolveMx, resolveTxt } from 'node:dns/promises';
import type { App } from './app.js';
import { type Config, HARD_DAILY_LIMIT } from './config.js';
import { all, getMeta, logEvent, one, run, setMeta } from './db.js';

export const OPT_OUT = /\b(unsubscribe|remove me|take me off|opt[- ]?out|stop (emailing|contacting|writing)|do not (email|contact)|don'?t (email|contact|write)|no thanks|not interested)\b|^\s*stop\s*[.!]?\s*$/im;

const domainOf = (email: string) => email.split('@')[1]?.toLowerCase() ?? '';

export function isSuppressed(a: App, email: string): string | null {
  const e = email.toLowerCase(); const d = domainOf(e);
  if (a.config.do_not_contact.map((x) => x.toLowerCase()).some((x) => x === e || x === d || d.endsWith(`.${x}`))) return 'on your do-not-contact list';
  const hit = one<{ reason: string }>(a.db, 'select reason from suppression where value = ? or value = ?', e, d);
  return hit?.reason ?? null;
}

export function suppress(a: App, value: string, reason: string) {
  run(a.db, 'insert into suppression (value, reason, created_at) values (?, ?, ?) on conflict (value) do nothing', value.trim().toLowerCase(), reason, a.now().toISOString());
  const v = value.trim().toLowerCase();
  run(a.db, `update drafts set status = 'cancelled' where status in ('pending','approved','blocked')
    and contact_id in (select id from contacts where email = ? or email like ?)`, v, `%@${v}`);
  logEvent(a.db, a.now(), 'suppression.added', { value: v, reason });
}

export const isStopped = (a: App) => getMeta(a.db, 'stopped_reason');
export function stopSending(a: App, reason: string) { setMeta(a.db, 'stopped_reason', reason); logEvent(a.db, a.now(), 'sending.stopped', { reason }); }
export function resumeSending(a: App) { setMeta(a.db, 'stopped_reason', null); logEvent(a.db, a.now(), 'sending.resumed'); }

/** Ramp from warmup_start, capped by the config, and by a ceiling the config cannot raise. */
export function dailyLimit(c: Config, now: Date): number {
  const ceiling = Math.min(c.limits.max_per_day, HARD_DAILY_LIMIT);
  if (!c.warmup_start) return Math.min(c.limits.start_per_day, ceiling);
  const days = Math.max(0, Math.floor((now.getTime() - new Date(c.warmup_start).getTime()) / 86_400_000));
  return Math.min(c.limits.start_per_day + days * c.limits.add_per_day, ceiling);
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

/** Stops all sending when the bounces of recent mail pass the limit. A burnt domain does not recover. */
export function checkBounces(a: App): boolean {
  const recent = all<{ id: number }>(a.db, "select contact_id as id from drafts where status = 'sent' order by sent_at desc limit 200");
  if (recent.length < 20) return false;
  const bounced = one<{ n: number }>(a.db, "select count(*) as n from contacts where status = 'bounced'")?.n ?? 0;
  const rate = bounced / recent.length;
  if (rate <= a.config.limits.bounce_stop_rate) return false;
  stopSending(a, `Bounces are at ${(rate * 100).toFixed(1)}%. Check your list before sending again.`);
  return true;
}

export function footer(c: Config): string {
  return `\n\n--\n${c.sender.name}, ${c.sender.company}\n${c.sender.postal_address}\nNot for you? Reply "stop" and I won't write again.`;
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
  add('Postal address', c.sender.postal_address.trim().length > 10, true, 'CAN-SPAM needs a real postal address in every email: sender.postal_address');
  add('Sending address', !!domain, true, 'sender.email');
  add('Mailbox', !!c.smtp.host && !!c.smtp.user && !!a.secrets.smtp_password, true, 'smtp.host, smtp.user and OUTLEVO_SMTP_PASSWORD');
  add('Replies can be read', !!c.imap.host && !!c.imap.user && !!a.secrets.imap_password, true, 'Opt-outs arrive as replies, so sending needs imap.host and imap.user');
  add('Model', c.model.provider !== 'anthropic' || !!process.env.ANTHROPIC_API_KEY || !!process.env.ANTHROPIC_AUTH_TOKEN, false, 'ANTHROPIC_API_KEY, to research and write');
  if (domain) {
    const txt = async (n: string) => (await dns.txt(n).catch(() => [] as string[][])).map((r) => r.join(''));
    const mx = await dns.mx(domain).catch(() => []);
    const spf = (await txt(domain)).some((r) => /^v=spf1/i.test(r));
    const dmarc = (await txt(`_dmarc.${domain}`)).some((r) => /^v=dmarc1/i.test(r));
    let dkim = false;
    for (const s of ['google', 'selector1', 'selector2', 'default', 'k1', 's1', 's2', 'dkim', 'mail']) if ((await txt(`${s}._domainkey.${domain}`)).some((r) => /p=/.test(r))) { dkim = true; break; }
    add('MX record', mx.length > 0, true, `${domain} must be able to receive replies`);
    add('SPF', spf, true, `Add an SPF record on ${domain}`);
    add('DMARC', dmarc, true, `Add a DMARC record at _dmarc.${domain}`);
    add('DKIM', dkim, false, 'No key under the usual selectors. Check it with your mail provider; a custom selector will not show here');
    const own = c.website.replace(/^https?:\/\/(www\.)?/, '').split('/')[0];
    add('A separate sending domain', domain !== own, false, 'Cold email from your main domain can land all your company mail in spam. Use something like get' + (own ?? 'yourcompany.com'));
    add('Warm-up date', !!c.warmup_start, false, `warmup_start. New mailboxes need 2-4 weeks of warm-up. Until it is set you send ${c.limits.start_per_day} a day at most`);
  }
  return out;
}
export const ready = (checks: Check[]) => checks.every((x) => x.ok || !x.blocking);
