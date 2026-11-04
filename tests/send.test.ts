import { describe, expect, it } from 'vitest';
import { asksToStop, checkBounces, dailyLimit, inSendingHours, isStopped, isSuppressed, ownWords, readiness, ready, resumeSending, stopSending, suppress } from '../src/compliance.js';
import { HARD_DAILY_LIMIT, DEFAULTS } from '../src/config.js';
import { all, one, run } from '../src/db.js';
import { addCompany, addContact, approve } from '../src/pipeline.js';
import { checkReplies, sendSuggestedReply } from '../src/replies.js';
import { nextDue, sendNext } from '../src/send.js';
import { OK_CHECKS, testApp, TUESDAY_NOON } from './helpers.js';

const BODY = 'Saw you are hiring account executives in Austin. Who owns ramp?';
function seed(a: ReturnType<typeof testApp>, email = 'dana@northwind.com', domain = 'northwind.com') {
  const c = addCompany(a, domain, 'manual');
  run(a.db, "update companies set status = 'qualified' where id = ?", c.id);
  const f = run(a.db, "insert into facts (company_id, kind, text, quote, source_url, fetched_at) values (?, 'hiring', 'Hiring', 'hiring account executives in Austin', 'https://x.example/', '2026-11-01')", c.id);
  addContact(a, { company_id: c.id, first_name: 'Dana', email, email_source: 'published' });
  const p = one<any>(a.db, 'select id from contacts where email = ?', email);
  const ins = (step: number, subject: string, body: string, delay: number, claims: unknown[]) => run(a.db, `insert into drafts (contact_id, step, subject, body, claims, delay_days, lint, status, created_at) values (?, ?, ?, ?, ?, ?, '[]', 'pending', '2026-11-01')`, p.id, step, subject, body, JSON.stringify(claims), delay);
  ins(1, 'Austin hires', BODY, 0, [{ text: 'hiring account executives in Austin', fact_id: Number(f.lastInsertRowid) }]);
  ins(2, 'A thought', 'A short note on onboarding, if useful.', 3, []);
  return p.id as number;
}
const send = (a: any) => sendNext(a, { checks: OK_CHECKS });
const later = (a: any, minutes: number) => { a.clock.now = new Date(a.clock.now.getTime() + minutes * 60_000); };

describe('sending', () => {
  it('sends nothing that was not approved', async () => {
    const a = testApp(); seed(a);
    expect(await send(a)).toEqual({ sent: false, reason: 'Nothing is due' });
    expect(a.sent).toHaveLength(0);
  });
  it('sends an approved email with the postal address, the opt-out and the unsubscribe header', async () => {
    const a = testApp(); approve(a, seed(a));
    expect((await send(a)).sent).toBe(true);
    const m = a.sent[0]!;
    expect(m.to).toBe('dana@northwind.com');
    expect(m.text).toContain('1 Main St, Springfield, IL 62701');
    expect(m.text).toContain('Reply "stop"');
    expect(m.headers?.['List-Unsubscribe']).toBe('<mailto:sam@getacme.com?subject=unsubscribe>');
  });
  it('refuses when a blocking check fails', async () => {
    const a = testApp(); approve(a, seed(a));
    const r = await sendNext(a, { checks: async () => [{ name: 'SPF', ok: false, blocking: true, detail: '' }] });
    expect(r).toMatchObject({ sent: false }); expect(a.sent).toHaveLength(0);
  });
  it('waits for sending hours, the gap between emails and the day limit', async () => {
    const a = testApp(); approve(a, seed(a)); approve(a, seed(a, 'lee@contoso.com', 'contoso.com'));
    a.clock.now = new Date('2026-11-03T03:00:00Z');
    expect((await send(a) as any).reason).toBe('Outside sending hours');
    a.clock.now = TUESDAY_NOON;
    expect((await send(a)).sent).toBe(true);
    expect((await send(a) as any).reason).toBe('Waiting between emails');
    a.config.limits.start_per_day = 1;
    later(a, 10);
    expect((await send(a) as any).reason).toMatch(/limit of 1/);
    expect(a.sent).toHaveLength(1);
  });
  it('sends a follow-up only after its delay, in the same thread', async () => {
    const a = testApp(); approve(a, seed(a));
    await send(a);
    later(a, 60);
    expect(nextDue(a)).toBeNull();
    later(a, 3 * 24 * 60);
    expect((await send(a)).sent).toBe(true);
    expect(a.sent[1]!.subject).toBe('Re: Austin hires');
    expect(a.sent[1]!.inReplyTo).toBe('<m1@test>');
  });
  it('does not write to a second person at a company it has already written to', async () => {
    const a = testApp(); approve(a, seed(a));
    await send(a); later(a, 10);
    const c = one<any>(a.db, 'select company_id from contacts');
    addContact(a, { company_id: c.company_id, first_name: 'Two', email: 'two@northwind.com', email_source: 'imported' });
    const two = one<any>(a.db, "select id from contacts where email = 'two@northwind.com'");
    run(a.db, `insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at) values (?, 1, 's', ?, '[]', '[]', 'approved', '2026-11-01')`, two.id, BODY);
    expect(nextDue(a)).toBeNull();
  });
  it('re-checks the rules at sending: a body edited after approval does not go', async () => {
    const a = testApp(); approve(a, seed(a));
    run(a.db, "update drafts set body = 'Saw you are hiring account executives in Austin. You grew 900%.' where step = 1");
    const r = await send(a);
    expect(r.sent).toBe(false);
    expect(a.sent).toHaveLength(0);
    expect(one<any>(a.db, 'select status from drafts where step = 1').status).toBe('blocked');
  });
  it('dry run sends nothing and changes nothing', async () => {
    const a = testApp(); approve(a, seed(a));
    expect((await sendNext(a, { dryRun: true, checks: OK_CHECKS })).sent).toBe(true);
    expect(a.sent).toHaveLength(0);
    expect(one<any>(a.db, 'select status from drafts where step = 1').status).toBe('approved');
  });
  it('the kill switch stops everything until resumed', async () => {
    const a = testApp(); approve(a, seed(a));
    stopSending(a, 'test');
    expect((await send(a) as any).reason).toMatch(/stopped/);
    resumeSending(a);
    expect((await send(a)).sent).toBe(true);
  });
});

describe('sending at the same time', () => {
  it('two sends cannot both pass the limit or send one email twice', async () => {
    const a = testApp(); approve(a, seed(a)); approve(a, seed(a, 'lee@contoso.com', 'contoso.com'));
    a.config.limits.start_per_day = 1;
    const results = await Promise.all([send(a), send(a), send(a), send(a)]);
    expect(results.filter((r) => r.sent)).toHaveLength(1);
    expect(a.sent).toHaveLength(1);
  });
  it('a failed send goes back in the queue', async () => {
    const a = testApp(); const id = seed(a); approve(a, id);
    (a as any).mailer = () => ({ send: async () => { throw new Error('smtp down'); }, verify: async () => true });
    await expect(send(a)).rejects.toThrow('smtp down');
    expect(one<any>(a.db, 'select status, sent_at from drafts where step = 1')).toEqual({ status: 'approved', sent_at: null });
  });
  it('refuses an address with a comma in it, whichever way it got in', async () => {
    const a = testApp(); const id = seed(a);
    approve(a, id);
    run(a.db, "update contacts set email = 'x,sup@qz0.example' where id = ?", id);
    const r = await send(a);
    expect(r.sent).toBe(false);
    expect(a.sent).toHaveLength(0);
    expect(addContact(a, { company_id: 1, first_name: 'X', email: 'y,sup@qz0.example', email_source: 'imported' })).toBe(false);
  });
});

describe('answers', () => {
  const pending = async () => {
    const a = testApp({ answers: { classify_reply: { class: 'interested', reason: 'x', suggested_reply: 'Sure.' } } }); seed(a);
    await checkReplies(a, { fetchNew: async () => ({ messages: [{ uid: 1, messageId: '<r@x>', from: 'dana@northwind.com', subject: 'Re: hi', text: 'Tell me more about it', receivedAt: TUESDAY_NOON }], lastUid: 1 }) });
    return { a, id: one<any>(a.db, 'select id from replies').id as number };
  };
  it('stop holds answers too', async () => {
    const { a, id } = await pending(); stopSending(a, 'test');
    await expect(sendSuggestedReply(a, id, { checks: OK_CHECKS })).rejects.toThrow(/stopped/);
    expect(a.sent).toHaveLength(0);
  });
  it('suppression holds answers too', async () => {
    const { a, id } = await pending(); suppress(a, 'dana@northwind.com', 'x');
    await expect(sendSuggestedReply(a, id, { checks: OK_CHECKS })).rejects.toThrow(/suppressed/);
    expect(a.sent).toHaveLength(0);
  });
  it('readiness holds answers too', async () => {
    const { a, id } = await pending();
    await expect(sendSuggestedReply(a, id, { checks: async () => [{ name: 'SPF', ok: false, blocking: true, detail: '' }] })).rejects.toThrow(/Not ready/);
    expect(one<any>(a.db, 'select suggested_status from replies').suggested_status).toBe('pending');
  });
});

describe('suppression', () => {
  it('cancels what is waiting and blocks the address', async () => {
    const a = testApp(); approve(a, seed(a));
    suppress(a, 'dana@northwind.com', 'asked');
    expect((await send(a)).sent).toBe(false);
    expect(all<any>(a.db, 'select status from drafts').every((d) => d.status === 'cancelled')).toBe(true);
  });
  it('covers subdomains and however an entry was written', () => {
    const a = testApp();
    suppress(a, 'example.org', 'x');
    expect(isSuppressed(a, 'x@sub.example.org')).toBeTruthy();
    a.config.do_not_contact = ['@acme.com', 'www.beta.com', 'https://gamma.com/about', 'Exact@Delta.com'];
    for (const e of ['x@acme.com', 'x@mail.beta.com', 'y@gamma.com', 'exact@delta.com']) expect(isSuppressed(a, e), e).toBeTruthy();
    expect(isSuppressed(a, 'other@delta.com')).toBeNull();
    expect(isSuppressed(a, 'x@notacme.com')).toBeNull();
  });
  it('a whole domain, and the do-not-contact list, block at the moment of sending', async () => {
    const a = testApp(); approve(a, seed(a));
    a.config.do_not_contact = ['northwind.com'];
    const r = await send(a);
    expect(r.sent).toBe(false);
    expect((r as any).reason).toMatch(/do-not-contact/);
    expect(a.sent).toHaveLength(0);
  });
});

describe('from the second skeptic round', () => {
  it('an alias of a suppressed address is suppressed too, either way round', () => {
    const a = testApp(); suppress(a, 'a5@a5.example', 'x');
    expect(isSuppressed(a, 'a5+work@a5.example')).toBeTruthy();
    suppress(a, 'b0+tag@b0.example', 'x');
    expect(isSuppressed(a, 'b0@b0.example')).toBeTruthy();
    expect(isSuppressed(a, 'b0other@b0.example')).toBeNull();
  });
  it('suppressing cancels what waits for an alias', () => {
    const a = testApp(); const id = seed(a, 'c1+work@c1.example', 'c1.example'); approve(a, id);
    suppress(a, 'c1@c1.example', 'x');
    expect(all<any>(a.db, 'select distinct status from drafts').map((d) => d.status)).toEqual(['cancelled']);
  });
  it('a bounce blames the exact address, not one inside it', async () => {
    const a = testApp(); const c = addCompany(a, 'e.example', 'manual');
    addContact(a, { company_id: c.id, first_name: 'Ann', email: 'ann@e.example', email_source: 'imported' });
    addContact(a, { company_id: c.id, first_name: 'Jo', email: 'joann@e.example', email_source: 'imported' });
    await checkReplies(a, { fetchNew: async () => ({ messages: [{ uid: 1, messageId: '<b@x>', from: 'mailer-daemon@m.example', subject: 'Undelivered', text: 'Delivery to joann@e.example failed.', receivedAt: TUESDAY_NOON }], lastUid: 1 }) });
    expect(all<any>(a.db, 'select email, status from contacts order by id')).toEqual([{ email: 'ann@e.example', status: 'active' }, { email: 'joann@e.example', status: 'bounced' }]);
  });
  it('a stranger asking to stop is put on the list', async () => {
    const a = testApp();
    await checkReplies(a, { fetchNew: async () => ({ messages: [{ uid: 1, messageId: '<s@x>', from: 'who@else.example', subject: 'Hi', text: 'Please stop emailing me', receivedAt: TUESDAY_NOON }], lastUid: 1 }) });
    expect(isSuppressed(a, 'who@else.example')).toBeTruthy();
  });
  it('"please stop by Friday" is an invitation', () => {
    expect(asksToStop('Re: hi', 'Please stop by Friday.')).toBe(false);
    expect(asksToStop('Re: hi', 'Please stop, thanks')).toBe(true);
  });
});

describe('limits', () => {
  it('ramps from the warm-up date', () => {
    const c = structuredClone(DEFAULTS);
    expect(dailyLimit(c, TUESDAY_NOON)).toBe(5);
    c.warmup_start = '2026-11-01T00:00:00Z';
    expect(dailyLimit(c, TUESDAY_NOON)).toBe(5 + 2 * 3);
    c.warmup_start = '2020-01-01T00:00:00Z';
    expect(dailyLimit(c, TUESDAY_NOON)).toBe(30);
  });
  it('the config cannot raise the ceiling', () => {
    const c = structuredClone(DEFAULTS); c.warmup_start = '2020-01-01T00:00:00Z'; c.limits.max_per_day = 5000;
    expect(dailyLimit(c, TUESDAY_NOON)).toBe(HARD_DAILY_LIMIT);
  });
  it('reads sending hours in the configured time zone, on weekdays', () => {
    const c = structuredClone(DEFAULTS);
    expect(inSendingHours(c, TUESDAY_NOON)).toBe(true);
    expect(inSendingHours(c, new Date('2026-11-01T17:00:00Z'))).toBe(false); // Sunday
    expect(inSendingHours(c, new Date('2026-11-03T23:00:00Z'))).toBe(false); // 18:00
  });
  it('stops all sending when bounces pass the limit', () => {
    const a = testApp();
    const c = addCompany(a, 'x.example', 'manual');
    for (let i = 0; i < 25; i++) {
      addContact(a, { company_id: c.id, first_name: 'P', email: `p${i}@x.example`, email_source: 'imported' });
      const p = one<any>(a.db, 'select id from contacts where email = ?', `p${i}@x.example`);
      run(a.db, `insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at, sent_at) values (?, 1, 's', 'b', '[]', '[]', 'sent', 'x', '2026-11-01')`, p.id);
      if (i < 2) run(a.db, "update contacts set status = 'bounced' where id = ?", p.id);
    }
    expect(checkBounces(a)).toBe(true);
    expect(isStopped(a)).toMatch(/8\.0%/);
  });
  it('catches a bad list early, and is not fooled by follow-ups or by one bounce', () => {
    const a = testApp();
    const c = addCompany(a, 'x.example', 'manual');
    const person = (i: number, bounced: boolean) => {
      addContact(a, { company_id: c.id, first_name: 'P', email: `q${i}@x.example`, email_source: 'imported' });
      const p = one<any>(a.db, 'select id from contacts where email = ?', `q${i}@x.example`);
      for (const step of [1, 2, 3]) run(a.db, `insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at, sent_at) values (?, ?, 's', 'b', '[]', '[]', 'sent', 'x', '2026-11-01')`, p.id, step);
      if (bounced) run(a.db, "update contacts set status = 'bounced' where id = ?", p.id);
    };
    person(0, true); person(1, false);
    expect(checkBounces(a)).toBe(false);
    person(2, true); person(3, true);
    expect(checkBounces(a)).toBe(true);
    resumeSending(a);
    expect(checkBounces(a)).toBe(false);
  });
  it('a nonsense warm-up date never means no limit', () => {
    const c = structuredClone(DEFAULTS); c.warmup_start = '2026-1101';
    expect(dailyLimit(c, TUESDAY_NOON)).toBe(5);
    c.limits.max_per_day = Number('x');
    expect(dailyLimit(c, TUESDAY_NOON)).toBe(5);
  });
});

describe('readiness', () => {
  const dns = (records: Record<string, string[]>) => ({ txt: async (n: string) => (records[n] ?? []).map((r) => [r]), mx: async () => [{ exchange: 'mx', priority: 1 }] });
  it('blocks without SPF, DMARC, a mailbox or a way to read replies', async () => {
    const a = testApp();
    const c = await readiness(a, dns({}));
    expect(ready(c)).toBe(false);
    expect(c.filter((x) => !x.ok && x.blocking).map((x) => x.name)).toEqual(expect.arrayContaining(['SPF', 'DMARC', 'Mailbox', 'Replies can be read']));
  });
  it('passes once they are there, and only advises on the rest', async () => {
    const a = testApp();
    a.config.smtp.host = 's'; a.config.smtp.user = 'u'; a.config.imap.host = 'i'; a.config.imap.user = 'u';
    a.secrets = { smtp_password: 'p', imap_password: 'p' };
    expect(ready(await readiness(a, dns({ 'getacme.com': ['v=spf1 -all'], '_dmarc.getacme.com': ['v=DMARC1; p=none'] })))).toBe(true);
  });
  it('blocks without a postal address', async () => {
    const a = testApp(); a.config.sender.postal_address = '';
    expect((await readiness(a, dns({}))).find((x) => x.name === 'Postal address')?.ok).toBe(false);
  });
});

describe('replies', () => {
  const inbox = (messages: any[]) => ({ fetchNew: async () => ({ messages: messages.map((m, i) => ({ uid: i + 1, messageId: `<r${i}@x>`, subject: 'Re: Austin hires', receivedAt: TUESDAY_NOON, ...m })), lastUid: messages.length }) });
  const classified = (ans: any) => testApp({ answers: { classify_reply: ans } });

  it('an opt-out needs no model, cancels everything and suppresses the address', async () => {
    const a = classified({}); approve(a, seed(a));
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', text: 'Please remove me from your list.' }]));
    expect(a.calls).toHaveLength(0);
    expect(one<any>(a.db, 'select class from replies').class).toBe('unsubscribe');
    expect(one<any>(a.db, 'select value from suppression').value).toBe('dana@northwind.com');
    expect((await send(a)).sent).toBe(false);
  });
  it('any reply stops that person and their company', async () => {
    const a = classified({ class: 'not_now', reason: 'Later', suggested_reply: null }); const id = seed(a); approve(a, id);
    await send(a);
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', text: 'Ask me next year.' }]));
    expect(one<any>(a.db, 'select status from drafts where step = 2').status).toBe('cancelled');
  });
  it('an answer is only a suggestion until a person sends it', async () => {
    const a = classified({ class: 'interested', reason: 'Asked for more', suggested_reply: 'Happy to share more.' }); approve(a, seed(a));
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', text: 'Tell me more.' }]));
    expect(a.sent).toHaveLength(0);
    const r = one<any>(a.db, 'select id, suggested_status from replies');
    expect(r.suggested_status).toBe('pending');
    await sendSuggestedReply(a, r.id, { checks: OK_CHECKS });
    expect(a.sent[0]!.inReplyTo).toBe('<r0@x>');
    await expect(sendSuggestedReply(a, r.id, { checks: OK_CHECKS })).rejects.toThrow(/no answer waiting/);
  });
  it('a bounce marks the address, suppresses it and sends no more', async () => {
    const a = classified({}); approve(a, seed(a));
    await checkReplies(a, inbox([{ from: 'mailer-daemon@mail.example', subject: 'Undelivered', text: 'Delivery to dana@northwind.com failed permanently.' }]));
    expect(one<any>(a.db, 'select status from contacts').status).toBe('bounced');
    expect((await send(a)).sent).toBe(false);
  });
  it('a reply the model cannot classify still stops the sequence', async () => {
    const a = testApp({ answers: { classify_reply: () => { throw new Error('down'); } } }); approve(a, seed(a));
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', text: 'Hmm.' }]));
    expect(one<any>(a.db, 'select class from replies').class).toBe('other');
    expect((await send(a)).sent).toBe(false);
  });
  it('ignores mail from strangers, and the same message twice', async () => {
    const a = classified({ class: 'other', reason: 'x', suggested_reply: null }); seed(a);
    const i = inbox([{ from: 'stranger@else.example', text: 'Buy now' }, { from: 'dana@northwind.com', text: 'ok' }]);
    await checkReplies(a, i); await checkReplies(a, i);
    expect(all(a.db, 'select 1 from replies')).toHaveLength(1);
  });
  it('recognises the usual ways of saying stop', () => {
    for (const t of ['stop', 'STOP.', 'Stop, thanks', 'Please stop', 'Stop sending me emails', 'Unsubscribe', 'please take me off this', "don't email me", 'not interested, thanks', 'GDPR: delete my data', 'Por favor darme de baja', 'Bitte abmelden', 'Merci de me désabonner', 'Proszę nie pisać', 'Отпишите меня']) expect(asksToStop('Re: hi', t), t).toBe(true);
    expect(asksToStop('STOP', '')).toBe(true);
  });
  it('does not take interest, or talk about stopping, for a request to stop', () => {
    for (const t of ['This could help us stop losing deals', 'I am not interested in the cheap plan, but I would like a demo', 'To unsubscribe from our newsletter click here to see our offers today', 'Does your tool stop emailing people who ask? We want a demo']) expect(asksToStop('Re: hi', t), t).toBe(false);
  });
  it('reads a reply below a quote, and not the quote or our own footer', () => {
    expect(asksToStop('Re: hi', 'On Tue, Sam wrote:\n> We help teams.\n\nPlease stop')).toBe(true);
    expect(asksToStop('Re: hi', '> please stop emailing me\nYes, tell me more about it.')).toBe(false);
    expect(asksToStop('Re: hi', 'Sounds good, tell me more.\n\n--\nSam Lee\nNot for you? Reply "stop" and I won\'t write again.')).toBe(false);
    expect(ownWords('Yes please.\n> quoted')).toBe('Yes please.');
  });
  it('an opt-out from an alias or a colleague counts, and an out-of-office does not end anything', async () => {
    const a = classified({}); const id = seed(a, 'olive+tag@northwind.com'); approve(a, id);
    await send(a);
    await checkReplies(a, inbox([{ from: 'olive@northwind.com', text: 'Please remove me.' }]));
    expect(isSuppressed(a, 'olive+tag@northwind.com')).toBeTruthy();
    expect(isSuppressed(a, 'olive@northwind.com')).toBeTruthy();
    const b = classified({}); approve(b, seed(b));
    await send(b);
    await checkReplies(b, inbox([{ from: 'assistant@northwind.com', text: 'Please take Dana off your list, remove me too.' }]));
    expect(isSuppressed(b, 'dana@northwind.com')).toBeTruthy();
    expect(one<any>(b.db, 'select status from drafts where step = 2').status).toBe('cancelled');
  });
  it('a reply on our thread from another address is theirs, by its headers', async () => {
    const a = classified({ class: 'not_now', reason: 'Later', suggested_reply: null }); approve(a, seed(a));
    await send(a);
    await checkReplies(a, inbox([{ from: 'someone@forward.example', inReplyTo: '<m1@test>', text: 'Ask me next year.' }]));
    expect(one<any>(a.db, 'select status from drafts where step = 2').status).toBe('cancelled');
  });
  it('an out-of-office leaves the sequence going', async () => {
    const a = classified({}); approve(a, seed(a));
    await send(a);
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', autoSubmitted: true, text: 'I am away until Monday.' }]));
    expect(one<any>(a.db, 'select class from replies').class).toBe('out_of_office');
    expect(one<any>(a.db, 'select status from drafts where step = 2').status).toBe('approved');
  });
  it('a stranger leaves a trace and nothing else', async () => {
    const a = classified({}); seed(a);
    await checkReplies(a, inbox([{ from: 'stranger@else.example', text: 'Buy my thing' }]));
    expect(one<any>(a.db, "select count(*) as n from events where kind = 'mail.unmatched'").n).toBe(1);
    expect(all(a.db, 'select 1 from replies')).toHaveLength(0);
  });
});
