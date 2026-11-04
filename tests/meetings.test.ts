import { describe, expect, it } from 'vitest';
import { findContacts, HunterRefused } from '../src/contacts.js';
import { all, one, run } from '../src/db.js';
import { cycle } from '../src/loop.js';
import { addCompany, addContact, approve, learnIcp, learnProduct, nextToWrite, researchCompany } from '../src/pipeline.js';
import { addMeeting, checkReplies, withBookingLink } from '../src/replies.js';
import { sendNext } from '../src/send.js';
import { start } from '../src/start.js';
import { OK_CHECKS, testApp, TUESDAY_NOON } from './helpers.js';

const NOT_READY = async () => [{ name: 'Mailbox', ok: false, blocking: true, detail: '' }];

const inbox = (messages: any[]) => ({ fetchNew: async () => ({ messages: messages.map((m, i) => ({ uid: i + 1, messageId: `<r${i}@x>`, subject: 'Re: hi', receivedAt: TUESDAY_NOON, text: '', ...m })), lastUid: messages.length }) });
function person(a: any, email = 'dana@northwind.com') {
  const c = addCompany(a, email.split('@')[1]!, 'manual');
  addContact(a, { company_id: c.id, first_name: 'Dana', email, email_source: 'verified' });
  return one<any>(a.db, 'select id, company_id from contacts where email = ?', email);
}

describe('booking link', () => {
  it('is added to an answer to someone interested, once', () => {
    const a = testApp(); a.config.booking_url = 'https://cal.com/sam';
    expect(withBookingLink(a, 'interested', 'Happy to talk.')).toBe('Happy to talk.\n\nPick a time here: https://cal.com/sam');
    expect(withBookingLink(a, 'interested', 'Book at https://cal.com/sam')).toBe('Book at https://cal.com/sam');
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

describe('meetings', () => {
  it('counts a Calendly booking with someone we wrote to, once, and stops the sequence', async () => {
    const a = testApp(); const p = person(a);
    run(a.db, `insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at) values (?, 2, 's', 'b', '[]', '[]', 'approved', 'x')`, p.id);
    const m = { from: 'no-reply@calendly.com', subject: 'New Event: Dana Reed - 30 Minute Meeting', text: 'Invitee Email: dana@northwind.com' };
    await checkReplies(a, inbox([m])); await checkReplies(a, inbox([m]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(1);
    expect(one<any>(a.db, 'select status, source from meetings')).toEqual({ status: 'booked', source: 'calendly.com' });
    expect(one<any>(a.db, 'select status from drafts').status).toBe('cancelled');
    expect(a.calls).toHaveLength(0);
  });
  it('understands Cal.com and Google Calendar', async () => {
    const a = testApp(); person(a); person(a, 'lee@contoso.com');
    await checkReplies(a, inbox([
      { from: 'hello@cal.com', subject: 'New event: Intro call', text: 'Attendee dana@northwind.com' },
      { from: 'calendar-notification@google.com', subject: 'Invitation: Intro', text: 'Guests: lee@contoso.com' },
    ]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(2);
  });
  it('ignores a booking from someone we never wrote to', async () => {
    const a = testApp(); person(a);
    await checkReplies(a, inbox([{ from: 'no-reply@calendly.com', subject: 'New Event: x', text: 'Invitee Email: stranger@else.example' }]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(0);
  });
  it('marks a cancelled booking', async () => {
    const a = testApp(); person(a);
    await checkReplies(a, inbox([{ from: 'no-reply@calendly.com', subject: 'New Event: x', text: 'dana@northwind.com' }, { from: 'no-reply@calendly.com', subject: 'Canceled: x', text: 'dana@northwind.com', messageId: '<c@x>' }]));
    expect(one<any>(a.db, 'select status from meetings').status).toBe('cancelled');
  });
  it('a forged sender on a reply is not a meeting, and an ordinary reply is still read', async () => {
    const a = testApp({ answers: { classify_reply: { class: 'other', reason: 'x', suggested_reply: null } } }); person(a);
    await checkReplies(a, inbox([{ from: 'dana@northwind.com', subject: 'New Event: fake', text: 'dana@northwind.com' }]));
    expect(all(a.db, 'select 1 from meetings')).toHaveLength(0);
    expect(all(a.db, 'select 1 from replies')).toHaveLength(1);
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
    const r = await start(a, { count: 1 }, (l) => lines.push(l), { checks: NOT_READY });
    expect(r).toMatchObject({ qualified: 1, to_review: 1, ready_to_send: false });
    expect(a.sent).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/Nothing was sent/);
    expect(r.next.join()).toMatch(/booking_url/);
  });
  it('picks up where it stopped and pays for nothing twice', async () => {
    const a = testApp({ pages, answers }); withSearch(a, ['northwind.com']);
    await start(a, { count: 1 }, quiet, { checks: NOT_READY });
    const before = a.calls.length;
    await start(a, { count: 1 }, quiet, { checks: NOT_READY });
    expect(a.calls.length).toBe(before);
  });
  it('names the gap when nobody can be written to', async () => {
    const noPeople = { ...answers, research: { ...answers.research, people: [] } };
    const a = testApp({ pages, answers: noPeople }); withSearch(a, ['northwind.com']);
    const r = await start(a, { count: 1 }, quiet, { checks: NOT_READY });
    expect(r.no_person).toBe(1);
    expect(r.next[0]).toMatch(/nobody to write to.*HUNTER_API_KEY/);
  });
  it('carries on when the model cannot search, with what you imported', async () => {
    const a = testApp({ pages, answers }); addCompany(a, 'northwind.com', 'csv');
    const lines: string[] = [];
    const r = await start(a, { count: 5 }, (l) => lines.push(l), { checks: NOT_READY });
    expect(lines.join()).toMatch(/no web search/);
    expect(r.qualified).toBe(1);
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
    await checkReplies(a, { fetchNew: async () => ({ messages: [{ uid: 2, messageId: '<b@x>', from: 'no-reply@calendly.com', subject: 'New Event: Dana', text: 'dana@northwind.com', receivedAt: TUESDAY_NOON }], lastUid: 2 }) });
    expect(one<any>(a.db, "select count(*) as n from meetings where status = 'booked'").n).toBe(1);
  });
});
