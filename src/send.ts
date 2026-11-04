import type { App } from './app.js';
import { type Check, checkBounces, dailyLimit, footer, inSendingHours, isStopped, isSuppressed, readiness, ready, sentToday } from './compliance.js';
import { all, logEvent, one, run } from './db.js';
import { hasErrors, lintEmail } from './lint.js';

export type SendResult = { sent: false; reason: string } | { sent: true; to: string; subject: string; step: number };

type Due = { id: number; contact_id: number; step: number; subject: string; body: string; claims: string; email: string; company_id: number; message_id_prev: string | null };

/** The next approved email whose turn has come. Anyone who replied, bounced or opted out has already had theirs cancelled. */
export function nextDue(a: App): Due | null {
  const rows = all<Due & { delay_days: number; prev_status: string | null; prev_sent: string | null }>(a.db, `
    select d.id, d.contact_id, d.step, d.subject, d.body, d.claims, d.delay_days, p.email, p.company_id,
      prev.status as prev_status, prev.sent_at as prev_sent, prev.message_id as message_id_prev
    from drafts d join contacts p on p.id = d.contact_id
    left join drafts prev on prev.contact_id = d.contact_id and prev.step = d.step - 1
    where d.status = 'approved' and p.status = 'active' order by d.step desc, d.approved_at, d.id`);
  for (const r of rows) {
    if (r.step === 1) {
      const companyTouched = one(a.db, `select 1 from drafts x join contacts q on q.id = x.contact_id where q.company_id = ? and x.status = 'sent' and x.contact_id <> ?`, r.company_id, r.contact_id);
      if (!companyTouched) return r;
    } else if (r.prev_status === 'sent' && r.prev_sent && a.now().getTime() - new Date(r.prev_sent).getTime() >= r.delay_days * 86_400_000) return r;
  }
  return null;
}

export const validAddress = (e: string) => /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i.test(e);

/** At most one email a call. Every guard is checked here, at the moment of sending, not when the email was approved. */
export async function sendNext(a: App, opts: { dryRun?: boolean; checks?: () => Promise<Check[]> } = {}): Promise<SendResult> {
  const no = (reason: string): SendResult => ({ sent: false, reason });
  const stopped = isStopped(a);
  if (stopped) return no(`Sending is stopped: ${stopped}`);
  if (checkBounces(a)) return no(isStopped(a)!);
  const checks = await (opts.checks ? opts.checks() : readiness(a));
  if (!ready(checks)) return no(`Not ready to send: ${checks.filter((c) => !c.ok && c.blocking).map((c) => c.name).join(', ')}. Run: outlevo doctor`);
  if (!inSendingHours(a.config, a.now())) return no('Outside sending hours');

  // Two runs at once must not both see room for one more. The email is claimed as sent inside one write transaction,
  // before the network: if the send fails it goes back, and if the machine dies it counts as sent, never as twice.
  const claim = (): SendResult | Due => {
    if (isStopped(a)) return no(`Sending is stopped: ${isStopped(a)}`);
    const limit = dailyLimit(a.config, a.now());
    if (sentToday(a) >= limit) return no(`Today's limit of ${limit} is reached`);
    const last = one<{ at: string | null }>(a.db, "select max(sent_at) as at from drafts where status = 'sent'")?.at;
    if (last && a.now().getTime() - new Date(last).getTime() < a.config.limits.min_gap_minutes * 60_000) return no('Waiting between emails');
    const d = nextDue(a);
    if (!d) return no('Nothing is due');
    const why = !validAddress(d.email) ? 'not a single valid address' : isSuppressed(a, d.email);
    if (why) {
      run(a.db, "update drafts set status = 'cancelled' where contact_id = ? and status = 'approved'", d.contact_id);
      logEvent(a.db, a.now(), 'send.suppressed', { contact_id: d.contact_id, why });
      return no(`Skipped ${d.email}: ${why}`);
    }
    // Facts may have changed, and a hand edit in the database must not get past the rules.
    const facts = all<any>(a.db, 'select f.id, f.text, f.quote from facts f join contacts p on p.company_id = f.company_id where p.id = ?', d.contact_id);
    const issues = lintEmail({ subject: d.subject, body: d.body, step: d.step, claims: JSON.parse(d.claims), facts, productFacts: all<any>(a.db, 'select text, quote from product_facts') });
    if (hasErrors(issues)) {
      run(a.db, "update drafts set status = 'blocked', lint = ? where id = ?", JSON.stringify(issues), d.id);
      return no(`Blocked email ${d.id}: it no longer passes the checks`);
    }
    if (opts.dryRun) return { sent: true, to: d.email, subject: d.subject, step: d.step };
    run(a.db, "update drafts set status = 'sent', sent_at = ? where id = ? and status = 'approved'", a.now().toISOString(), d.id);
    return d;
  };
  a.db.exec('begin immediate');
  let got: SendResult | Due;
  try { got = claim(); a.db.exec('commit'); } catch (e) { a.db.exec('rollback'); throw e; }
  if ('sent' in got) return got;
  const d = got;

  const s = a.config.sender;
  const subject = d.step > 1 ? `Re: ${one<{ subject: string }>(a.db, 'select subject from drafts where contact_id = ? and step = 1', d.contact_id)?.subject ?? d.subject}` : d.subject;
  let res: { messageId: string };
  try {
    res = await a.mailer().send({
      from: `${s.name} <${s.email}>`, to: d.email, subject, text: d.body + footer(a.config),
      headers: { 'List-Unsubscribe': `<mailto:${s.email}?subject=unsubscribe>` },
      ...(d.message_id_prev ? { inReplyTo: d.message_id_prev, references: d.message_id_prev } : {}),
    });
  } catch (e) {
    run(a.db, "update drafts set status = 'approved', sent_at = null where id = ?", d.id);
    throw e;
  }
  run(a.db, 'update drafts set message_id = ? where id = ?', res.messageId, d.id);
  logEvent(a.db, a.now(), 'email.sent', { draft_id: d.id, to: d.email, step: d.step });
  return { sent: true, to: d.email, subject, step: d.step };
}
