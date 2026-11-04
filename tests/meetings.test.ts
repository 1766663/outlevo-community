import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { findContacts, HunterRefused } from '../src/contacts.js';
import { all, one, run } from '../src/db.js';
import { cycle } from '../src/loop.js';
import { addCompany, addContact, approve, learnIcp, learnProduct, nextToWrite, researchCompany } from '../src/pipeline.js';
import { addMeeting, checkReplies, senderProven, withBookingLink } from '../src/replies.js';
import { sendNext } from '../src/send.js';
import { BudgetExhausted } from '../src/model.js';
import { prepareSite, start } from '../src/start.js';
import { OK_CHECKS, testApp, TUESDAY_NOON } from './helpers.js';

const packDir = () => join(mkdtempSync(join(tmpdir(), 'pack-')), 'p');
const NOT_READY = async () => [{ name: 'Mailbox', ok: false, blocking: true, detail: '' }];

const inbox = (messages: any[]) => ({ fetchNew: async () => ({ messages: messages.map((m, i) => ({ uid: i + 1, messageId: `<r${i}@x>`, subject: 'Re: hi', receivedAt: TUESDAY_NOON, text: '', ...m })), lastUid: messages.length }) });
function person(a: any, email = 'dana@northwind.com', sent = true) {
  const c = addCompany(a, email.split('@')[1]!, 'manual');
  addContact(a, { company_id: c.id, first_name: 'Dana', email, email_source: 'verified' });
  const p = one<any>(a.db, 'select id, company_id from contacts where email = ?', email);
  if (sent) run(a.db, `insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at, sent_at) values (?, 1, 's', 'b', '[]', '[]', 'sent', 'x', '2026-11-01T00:00:00Z')`, p.id);
  return p;
}
const booking = (m: any) => ({ from: 'no-reply@calendly.com', authenticated: true, ...m });

describe('booking link', () => {
  it('is added to an answer to someone interested, once', () => {
    const a = testApp(); a.config.booking_url = 'https://cal.com/sam';
    expect(withBookingLink(a, 'interested', 'Happy to talk.')).toBe('Happy to talk.\n\nPick a time here: https://cal.com/sam');
    expect(withBookingLink(a, 'interested', 'Book at https://cal.com/sam')).toBe('Book at https://cal.com/sam');
  });
  it('gives someone interested a draft even if the model wrote none', () => {
    const a = testApp(); a.config.booking_url = 'https://cal.com/sam';
    expect(withBookingLink(a, 'interested', null)).toContain('https://cal.com/sam');
    expect(withBookingLink(a, 'not_now', null)).toBeNull();
  });
  it('is left out of other answers, or when none is set', () => {
    const a = testApp(); a.config.booking_url = 'https://cal.com/sam';
    expect(withBookingLink(a, 'question', 'It costs less.')).toBe('It costs less.');
    a.config.booking_url = '';
    expect(withBookingLink(a, 'interested', 'Yes.')).toBe('Yes.');
  });
  it('reaches the drafted answer, which still waits for a person', async () => {
    const a = testApp({ answers: { classify_reply: { class: 'interested', reason: 'Wants a call', suggested_reply: 'Glad to chat.' } } });
    a.config.booking_url = 'https://cal.com/sam'; person(a);
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', text: 'Sounds good, tell me more.' }]));
    const r = one<any>(a.db, 'select suggested, suggested_status from replies');
    expect(r.suggested).toContain('https://cal.com/sam');
    expect(r.suggested_status).toBe('pending');
    expect(a.sent).toHaveLength(0);
  });
});

describe('senderProven', () => {
  it('accepts DMARC or DKIM passing for that domain', () => {
    expect(senderProven('mx.google.com; dkim=pass header.i=@calendly.com; spf=pass', 'calendly.com')).toBe(true);
    expect(senderProven('mx.google.com; dmarc=pass (p=REJECT) header.from=calendly.com', 'calendly.com')).toBe(true);
    expect(senderProven('mx.google.com; dkim=pass header.d=mail.calendly.com', 'calendly.com')).toBe(true);
  });
  it('a verdict inside a comment or a quoted string is not a verdict', () => {
    expect(senderProven('mx; dkim=fail (comment dkim=pass header.d=calendly.com) header.d=evil.example', 'calendly.com')).toBe(false);
    expect(senderProven('mx; x="dkim=pass header.d=calendly.com"; dkim=fail', 'calendly.com')).toBe(false);
  });
  it('refuses a longer domain that only starts with theirs', () => {
    expect(senderProven('mx; dkim=pass header.d=calendly.com.evil.com', 'calendly.com')).toBe(false);
    expect(senderProven('mx; dmarc=pass header.from=calendly.com.evil.com', 'calendly.com')).toBe(false);
  });
  it('refuses a failure, another domain, a lookalike, or no verdict', () => {
    expect(senderProven('mx; dkim=fail header.d=calendly.com; dmarc=fail header.from=calendly.com', 'calendly.com')).toBe(false);
    expect(senderProven('mx; dkim=pass header.d=evil.example', 'calendly.com')).toBe(false);
    expect(senderProven('mx; dkim=pass header.d=notcalendly.com', 'calendly.com')).toBe(false);
    expect(senderProven(undefined, 'calendly.com')).toBe(false);
  });
  it('reads only the topmost header, the one your provider added', () => {
    expect(senderProven(['mx; dkim=fail header.d=calendly.com', 'fake; dkim=pass header.d=calendly.com'], 'calendly.com')).toBe(false);
  });
});

describe('meetings', () => {
  it('counts a Calendly booking with someone we wrote to, once, and stops the sequence', async () => {
    const a = testApp(); const p = person(a);
    run(a.db, `insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at) values (?, 2, 's', 'b', '[]', '[]', 'approved', 'x')`, p.id);
    const m = booking({ subject: 'New Event: Dana Reed - 30 Minute Meeting', text: 'Invitee Email: dana@northwind.com' });
    await checkReplies(a, inbox([m])); await checkReplies(a, inbox([m]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(1);
    expect(one<any>(a.db, 'select status, source from meetings')).toEqual({ status: 'booked', source: 'calendly.com' });
    expect(one<any>(a.db, "select status from drafts where step = 2").status).toBe('cancelled');
    expect(a.calls).toHaveLength(0);
  });
  it('understands Cal.com and Google Calendar', async () => {
    const a = testApp(); person(a); person(a, 'lee@contoso.com');
    await checkReplies(a, inbox([
      { from: 'hello@cal.com', authenticated: true, subject: 'New event: Intro call', text: 'Attendee dana@northwind.com' },
      { from: 'calendar-notification@google.com', authenticated: true, subject: 'Invitation: Intro', text: 'Guests: lee@contoso.com' },
    ]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(2);
  });
  it('ignores a booking from someone we never wrote to', async () => {
    const a = testApp(); person(a);
    await checkReplies(a, inbox([booking({ subject: 'New Event: x', text: 'Invitee Email: stranger@else.example' })]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(0);
  });
  it('marks a cancelled booking', async () => {
    const a = testApp(); person(a);
    await checkReplies(a, inbox([booking({ subject: 'New Event: x', text: 'dana@northwind.com' }), booking({ subject: 'Canceled: x', text: 'dana@northwind.com', messageId: '<c@x>' })]));
    expect(one<any>(a.db, 'select status from meetings').status).toBe('cancelled');
  });
  it('a forged sender on a reply is not a meeting, and an ordinary reply is still read', async () => {
    const a = testApp({ answers: { classify_reply: { class: 'other', reason: 'x', suggested_reply: null } } }); person(a);
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', subject: 'New Event: fake', text: 'dana@northwind.com' }]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(0);
    expect(all(a.db, 'select 1 from replies')).toHaveLength(1);
  });
  it('does nothing on a forged booking: no meeting, and the emails keep going', async () => {
    const a = testApp(); const p = person(a);
    run(a.db, `insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at) values (?, 2, 's', 'b', '[]', '[]', 'approved', 'x')`, p.id);
    await checkReplies(a, inbox([{ from: 'no-reply@calendly.com', authenticated: false, subject: 'New Event: x', text: 'dana@northwind.com' }]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(0);
    expect(one<any>(a.db, 'select status from drafts where step = 2').status).toBe('approved');
    expect(one<any>(a.db, "select count(*) as n from events where kind = 'meeting.unproven'").n).toBe(1);
  });
  it('a forged cancellation leaves a real meeting alone', async () => {
    const a = testApp(); person(a);
    await checkReplies(a, inbox([booking({ subject: 'New Event: x', text: 'dana@northwind.com' }), { from: 'no-reply@calendly.com', messageId: '<f@x>', subject: 'Canceled: x', text: 'dana@northwind.com' }]));
    expect(one<any>(a.db, 'select status from meetings').status).toBe('booked');
  });
  it('matches an exact address, not part of a longer one', async () => {
    const a = testApp(); person(a, 'ann@acme.com');
    await checkReplies(a, inbox([booking({ subject: 'New Event: x', text: 'Invitee: joann@acme.com and ann@acme.com.au' })]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(0);
  });
  it('ignores someone we never actually wrote to', async () => {
    const a = testApp(); person(a, 'dana@northwind.com', false);
    await checkReplies(a, inbox([booking({ subject: 'New Event: x', text: 'dana@northwind.com' })]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(0);
  });
  it('with several guests, picks the person we wrote to', async () => {
    const a = testApp(); person(a, 'lee@contoso.com', false); person(a);
    await checkReplies(a, inbox([booking({ subject: 'Invitation: Intro', text: 'Guests: lee@contoso.com, dana@northwind.com' })]));
    const m = one<any>(a.db, 'select p.email from meetings m join contacts p on p.id = m.contact_id');
    expect(m.email).toBe('dana@northwind.com');
  });
  it('a reminder, an update or a new time adds no second meeting', async () => {
    const a = testApp(); person(a);
    await checkReplies(a, inbox([
      booking({ subject: 'New Event: x', text: 'dana@northwind.com' }),
      booking({ messageId: '<2@x>', subject: 'Reminder: x is tomorrow', text: 'dana@northwind.com' }),
      booking({ messageId: '<3@x>', subject: 'Updated invitation: x', text: 'dana@northwind.com' }),
      booking({ messageId: '<4@x>', subject: 'Rescheduled: x', text: 'dana@northwind.com' }),
    ]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(1);
  });
  it('a reminder alone is not a meeting', async () => {
    const a = testApp(); person(a);
    await checkReplies(a, inbox([booking({ subject: 'Reminder: invitation confirmed', text: 'dana@northwind.com' })]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(0);
  });
  it('a declined invitation cancels, and booking again counts', async () => {
    const a = testApp(); person(a);
    await checkReplies(a, inbox([booking({ subject: 'New Event: x', text: 'dana@northwind.com' }), booking({ messageId: '<2@x>', subject: 'Declined: x', text: 'dana@northwind.com' }), booking({ messageId: '<3@x>', subject: 'New Event: y', text: 'dana@northwind.com' })]));
    expect(all<any>(a.db, 'select status from meetings order by id').map((m) => m.status)).toEqual(['cancelled', 'booked']);
  });
  it('withdraws an answer still waiting once they have booked', async () => {
    const a = testApp({ answers: { classify_reply: { class: 'interested', reason: 'Yes', suggested_reply: 'Glad to chat.' } } }); person(a);
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', text: 'Tell me more.' }]));
    await checkReplies(a, { fetchNew: async () => ({ messages: [{ uid: 2, messageId: '<b@x>', ...booking({ subject: 'New Event: x', text: 'dana@northwind.com' }), receivedAt: TUESDAY_NOON }], lastUid: 2 }) });
    expect(one<any>(a.db, 'select suggested_status from replies').suggested_status).toBe('dismissed');
  });
  it('a reply from someone we wrote to at cal.com is a reply, and their opt-out counts', async () => {
    const a = testApp(); person(a, 'dana@cal.com');
    await checkReplies(a, inbox([{ from: 'dana@cal.com', authenticated: true, subject: 'Re: invitation', text: 'Please unsubscribe me.' }]));
    expect(one<any>(a.db, 'select class from replies').class).toBe('unsubscribe');
    expect(one<any>(a.db, 'select value from suppression').value).toBe('dana@cal.com');
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(0);
  });
  it('can be recorded by hand', () => {
    const a = testApp(); const p = person(a);
    addMeeting(a, p.id, 'manual', null);
    expect(one<any>(a.db, "select count(*) as n from events where kind = 'meeting.booked'").n).toBe(1);
    expect(() => addMeeting(a, 999, 'manual', null)).toThrow(/No contact/);
  });
});

const ICP = { summary: 'B2B software', industries: [], company_size: '', markets: [], buyer_titles: ['Head of Sales'], must_have: [], rule_out: [], learned_from: 'website' };
function hunterFake(emails: any[], status: (e: string) => string) {
  const urls: string[] = [];
  const doFetch = (async (u: string) => {
    urls.push(String(u));
    if (String(u).includes('/domain-search')) return new Response(JSON.stringify({ data: { emails } }));
    const e = new URL(String(u)).searchParams.get('email')!;
    return new Response(JSON.stringify({ data: { status: status(e) } }));
  }) as unknown as typeof fetch;
  return { doFetch, urls };
}
function qualified(a: any, domain = 'northwind.com') {
  const c = addCompany(a, domain, 'manual');
  run(a.db, "update companies set status = 'qualified' where id = ?", c.id);
  return c.id;
}
const icpIn = (a: any) => run(a.db, "insert into icp (id, body, source, updated_at) values (1, ?, 'website', 'x')", JSON.stringify(ICP));

describe('findContacts', () => {
  const people = [
    { value: 'office@northwind.com', first_name: 'Olive', position: 'Office Manager', confidence: 99 },
    { value: 'dana@northwind.com', first_name: 'Dana', last_name: 'Reed', position: 'Head of Sales', confidence: 80 },
    { value: 'no-name@northwind.com', first_name: null, position: 'Head of Sales', confidence: 99 },
  ];
  it('checks the person closest to the buyers first, keeps the first valid one and stops spending', async () => {
    const a = testApp(); a.secrets = { hunter_key: 'k' }; icpIn(a); qualified(a);
    const { doFetch, urls } = hunterFake(people, () => 'valid');
    expect(await findContacts(a, { limit: 5, doFetch })).toMatchObject({ companies: 1, added: 1, not_verified: 0 });
    expect(all<any>(a.db, 'select email, email_source from contacts')).toEqual([{ email: 'dana@northwind.com', email_source: 'verified' }]);
    expect(urls.filter((u) => u.includes('email-verifier'))).toHaveLength(1);
  });
  it('leaves out anything Hunter does not call valid', async () => {
    const a = testApp(); a.secrets = { hunter_key: 'k' }; icpIn(a); qualified(a);
    const { doFetch } = hunterFake(people, () => 'accept_all');
    expect(await findContacts(a, { limit: 5, doFetch })).toMatchObject({ added: 0, not_verified: 2 });
    expect(nextToWrite(a, 5)).toEqual([]);
  });
  it('does not search the same company twice', async () => {
    const a = testApp(); a.secrets = { hunter_key: 'k' }; icpIn(a); qualified(a);
    const { doFetch, urls } = hunterFake([], () => 'valid');
    await findContacts(a, { limit: 5, doFetch }); await findContacts(a, { limit: 5, doFetch });
    expect(urls).toHaveLength(1);
  });
  it('skips a company that already has someone to write to', async () => {
    const a = testApp(); a.secrets = { hunter_key: 'k' }; icpIn(a); const id = qualified(a);
    addContact(a, { company_id: id, first_name: 'X', email: 'x@northwind.com', email_source: 'imported' });
    const { doFetch, urls } = hunterFake(people, () => 'valid');
    await findContacts(a, { limit: 5, doFetch });
    expect(urls).toHaveLength(0);
  });
  it('stops at the daily limit of lookups', async () => {
    const a = testApp(); a.secrets = { hunter_key: 'k' }; a.config.contacts.max_lookups_per_day = 1; icpIn(a); qualified(a); qualified(a, 'contoso.com');
    const { doFetch, urls } = hunterFake(people, () => 'valid');
    await findContacts(a, { limit: 5, doFetch });
    expect(urls).toHaveLength(1);
  });
  it('a company cut short by the limit gets its turn again the next day', async () => {
    const a = testApp(); a.secrets = { hunter_key: 'k' }; a.config.contacts.max_lookups_per_day = 1; icpIn(a); qualified(a);
    const { doFetch } = hunterFake(people, () => 'valid');
    expect((await findContacts(a, { limit: 5, doFetch })).added).toBe(0);
    a.clock.now = new Date(a.clock.now.getTime() + 86_400_000); a.config.contacts.max_lookups_per_day = 5;
    expect((await findContacts(a, { limit: 5, doFetch })).added).toBe(1);
  });
  it('counts only companies with nobody to write to as waiting', async () => {
    const a = testApp(); a.secrets = { hunter_key: 'k' }; icpIn(a); const id = qualified(a); qualified(a, 'contoso.com'); qualified(a, 'fabrikam.com');
    addContact(a, { company_id: id, first_name: 'X', email: 'x@northwind.com', email_source: 'imported' });
    const { doFetch } = hunterFake([], () => 'valid');
    expect((await findContacts(a, { limit: 5, doFetch })).waiting).toBe(2);
  });
  it('explains a refused key, and never puts the key in the message', async () => {
    const a = testApp(); a.secrets = { hunter_key: 'SECRET' }; icpIn(a); qualified(a);
    const err = await findContacts(a, { limit: 5, doFetch: (async () => new Response('{}', { status: 401 })) as any }).catch((e) => e);
    expect(err).toBeInstanceOf(HunterRefused);
    expect(err.message).not.toContain('SECRET');
  });
  it('without a key says what to do instead', async () => {
    await expect(findContacts(testApp(), { limit: 1 })).rejects.toThrow(/HUNTER_API_KEY/);
  });
});

const pages = {
  'https://acme-tools.com/': { url: 'https://acme-tools.com/', title: 'Acme', links: [], text: 'Acme Tools helps sales teams ramp new reps faster than before, with a clear plan.' },
  'https://northwind.com/': { url: 'https://northwind.com/', title: 'N', links: [], text: 'We are hiring account executives in Austin. Our head of sales is Dana Reed, dana@northwind.com.' },
};
const answers = {
  learn_product: { summary: 'Sales ramp software', facts: [{ kind: 'other', text: 'Ramps reps', quote: 'helps sales teams ramp new reps', source_url: 'https://acme-tools.com/', published_at: null }] },
  learn_icp: ICP,
  research: { name: 'Northwind', facts: [{ kind: 'hiring', text: 'Hiring AEs', quote: 'We are hiring account executives in Austin', source_url: 'https://northwind.com/', published_at: null }], people: [{ first_name: 'Dana', last_name: 'Reed', title: 'Head of Sales', email: 'dana@northwind.com', quote: 'Our head of sales is Dana Reed', source_url: 'https://northwind.com/' }] },
  qualify: (r: any) => ({ fit: true, score: 80, reasons: [{ text: 'Hiring', fact_id: Number(r.user.match(/\[(\d+)\]/)[1]) }], missing: [] }),
  write: (r: any) => ({ angle: 'hiring', emails: [{ subject: 'Austin hires', body: 'Saw you are hiring account executives in Austin. Who owns ramp?', delay_days: 0, claims: [{ text: 'hiring account executives in Austin', fact_id: Number(r.user.match(/\[(\d+)\]/)[1]) }] }] }),
};

describe('start', () => {
  const quiet = () => {};
  const withSearch = (a: any, domains: string[]) => { const m = a.model(); (a as any).model = () => ({ ...m, searchJson: async () => ({ companies: domains.map((d) => ({ name: d, domain: d, why: 'x' })) }) }); };
  it('goes from a website to emails waiting for review, sending nothing', async () => {
    const a = testApp({ pages, answers }); withSearch(a, ['northwind.com']);
    const lines: string[] = [];
    const r = await start(a, { count: 1, out: packDir() }, (l) => lines.push(l), { checks: NOT_READY });
    expect(r).toMatchObject({ qualified: 1, to_review: 1, ready_to_send: false });
    expect(a.sent).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/Nothing was sent/);
      });
  it('picks up where it stopped and pays for nothing twice', async () => {
    const a = testApp({ pages, answers }); withSearch(a, ['northwind.com']);
    await start(a, { count: 1, out: packDir() }, quiet, { checks: NOT_READY });
    const before = a.calls.length;
    await start(a, { count: 1, out: packDir() }, quiet, { checks: NOT_READY });
    expect(a.calls.length).toBe(before);
  });
  it('names the gap when nobody can be written to', async () => {
    const noPeople = { ...answers, research: { ...answers.research, people: [] } };
    const a = testApp({ pages, answers: noPeople }); withSearch(a, ['northwind.com']);
    const r = await start(a, { count: 1, out: packDir() }, quiet, { checks: NOT_READY });
    expect(r.no_person).toBe(1);
    expect(r.next.join(' ')).toMatch(/needs? a person.*HUNTER_API_KEY/);
  });
  it('carries on when the model cannot search, with what you imported', async () => {
    const a = testApp({ pages, answers }); addCompany(a, 'northwind.com', 'csv');
    const lines: string[] = [];
    const r = await start(a, { count: 5, out: packDir() }, (l) => lines.push(l), { checks: NOT_READY });
    expect(lines.join()).toMatch(/no web search/);
    expect(r.qualified).toBe(1);
  });
});

describe('prepareSite', () => {
  const withProduct = () => { const a = testApp(); run(a.db, "insert into product (id, url, summary, updated_at) values (1, 'https://acme-tools.com', 's', 'x')"); run(a.db, "insert into icp (id, body, source, updated_at) values (1, '{}', 'website', 'x')"); return a; };
  it('refuses to reuse a folder for another product without being told', () => {
    const a = withProduct(); const before = a.config.website;
    expect(() => prepareSite(a, 'https://other.example', false)).toThrow(/set up for acme-tools\.com.*--relearn/);
    expect(a.config.website).toBe(before);
    expect(one(a.db, 'select 1 from product')).toBeTruthy();
  });
  it('accepts the same site written differently', () => {
    expect(() => prepareSite(withProduct(), 'https://www.acme-tools.com/', false)).not.toThrow();
  });
  it('--relearn clears the product and sends every company back for research', () => {
    const a = withProduct(); const id = qualified(a);
    prepareSite(a, 'https://other.example', true);
    expect(one(a.db, 'select 1 from product')).toBeUndefined();
    expect(one(a.db, 'select 1 from icp')).toBeUndefined();
    expect(one<any>(a.db, 'select status from companies where id = ?', id).status).toBe('new');
    expect(a.config.website).toBe('https://other.example');
  });
});

describe('start at the daily limit', () => {
  it('still reports where things stand', async () => {
    const a = testApp({ pages, answers: { ...answers, research: () => { throw new BudgetExhausted(1); } } });
    addCompany(a, 'northwind.com', 'csv');
    const lines: string[] = [];
    const r = await start(a, { count: 1, out: packDir() }, (l) => lines.push(l), { checks: NOT_READY });
    expect(r.stopped_early).toMatch(/limit/);
    expect(r.next[0]).toMatch(/tomorrow/);
    expect(lines.join('\n')).toMatch(/Stopped early/);
  });
  it('other errors still surface', async () => {
    const a = testApp({ pages: {}, answers });
    await expect(start(a, { count: 1, out: packDir() }, () => {}, { checks: NOT_READY })).rejects.toThrow(/Could not read/);
  });
});

describe('the path to a meeting', () => {
  it('runs from research to a counted meeting', async () => {
    const a = testApp({ pages, answers: { ...answers, classify_reply: { class: 'interested', reason: 'Yes', suggested_reply: 'Glad to chat.' } } });
    a.config.booking_url = 'https://cal.com/sam';
    await learnProduct(a); await learnIcp(a, {});
    await researchCompany(a, addCompany(a, 'northwind.com', 'manual').id);
    const send = () => sendNext(a, { checks: OK_CHECKS });
    await cycle(a, { send });
    const p = one<any>(a.db, 'select id from contacts');
    approve(a, p.id);
    await send();
    expect(a.sent).toHaveLength(1);
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', text: 'Interesting, tell me more.' }]));
    expect(one<any>(a.db, 'select suggested from replies').suggested).toContain('cal.com/sam');
    await checkReplies(a, { fetchNew: async () => ({ messages: [{ uid: 2, messageId: '<b@x>', from: 'no-reply@calendly.com', authenticated: true, subject: 'New Event: Dana', text: 'dana@northwind.com', receivedAt: TUESDAY_NOON }], lastUid: 2 }) });
    expect(one<any>(a.db, "select count(*) as n from meetings where status = 'booked'").n).toBe(1);
  });
});
