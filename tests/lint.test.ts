import { describe, expect, it } from 'vitest';
import { hasErrors, lintEmail, parseEmailFile } from '../src/lint.js';

const facts = [{ id: 1, text: 'Northwind is hiring 4 account executives', quote: 'We are hiring 4 account executives in Austin.' }];
const good = { subject: 'Your Austin AE hires', body: 'Northwind is hiring account executives in Austin. We help new reps find their first accounts. Who owns ramp for them?', step: 1, claims: [{ text: 'Northwind is hiring account executives in Austin', fact_id: 1 }], facts };
const rules = (i: Parameters<typeof lintEmail>[0]) => lintEmail(i).filter((x) => x.level === 'error').map((x) => x.rule);

describe('lintEmail', () => {
  it('passes an email whose claims are sourced', () => { expect(rules(good)).toEqual([]); });
  it('refuses a first email that says nothing sourced', () => { expect(rules({ ...good, claims: [] })).toContain('no-claim'); });
  it('refuses a claim citing a fact that does not exist', () => { expect(rules({ ...good, claims: [{ text: good.claims[0]!.text, fact_id: 99 }] })).toContain('unknown-fact'); });
  it('refuses a claim whose words are not in the email', () => { expect(rules({ ...good, claims: [{ text: 'Northwind raised a Series B', fact_id: 1 }] })).toContain('claim-not-in-email'); });
  it('refuses a number that no cited fact contains', () => {
    expect(rules({ ...good, body: `${good.body} Teams like yours ramp 37% faster.` })).toContain('unsourced-number');
    expect(rules({ ...good, body: 'Northwind is hiring account executives in Austin, 4 of them. Who owns ramp?' })).toEqual([]);
  });
  it('allows a number from a fact about the product', () => {
    expect(rules({ ...good, body: `${good.body} We save 3 hours a week.`, productFacts: [{ text: 'Saves 3 hours a week', quote: 'Saves 3 hours a week' }] })).toEqual([]);
  });
  it('refuses a fake thread and fake history', () => {
    expect(rules({ ...good, subject: 'Re: our chat' })).toContain('fake-thread');
    expect(rules({ ...good, body: `${good.body} As we discussed last week.` })).toContain('fake-history');
  });
  it('refuses placeholders that would go out blank', () => {
    expect(rules({ ...good, body: `Hi {{first_name}}, ${good.body}` })).toContain('merge-tag');
    expect(rules({ ...good, body: `Hi [First Name], ${good.body}` })).toContain('merge-tag');
  });
  it('refuses links to anywhere but the two companies', () => {
    expect(rules({ ...good, body: `${good.body} https://evil.example/x`, allowedLinkDomains: ['acme.com', 'northwind.com'] })).toContain('link-domain');
    expect(rules({ ...good, body: `${good.body} https://www.acme.com/x`, allowedLinkDomains: ['acme.com'] })).toEqual([]);
  });
  it('without facts, warns rather than refuses what it cannot judge', () => {
    const issues = lintEmail({ subject: 'Hello', body: 'We grew revenue 400%. Click here https://a.example https://b.example', strict: false });
    expect(hasErrors(issues)).toBe(false);
    expect(issues.map((i) => i.rule)).toEqual(expect.arrayContaining(['links', 'spam-word']));
  });
  it('still refuses fake history in a file check', () => { expect(hasErrors(lintEmail({ subject: 'Re: hi', body: 'x', strict: false }))).toBe(true); });
});

describe('outlevo check on an honest email', () => {
  const clean = (body: string) => lintEmail({ subject: 'A question', body, strict: false });
  it('raises no alarm on ordinary words and figures', () => {
    expect(clean('We improve cashflow in Q3 2026. It runs 24/7, from $29, in 30 minutes, for the top 10 teams.')).toEqual([]);
    expect(hasErrors(clean('As discussed in your 2025 blog post, hiring is hard.'))).toBe(false);
  });
  it('still points at a figure it cannot check', () => {
    expect(clean('Teams grow 312% with us.').map((i) => i.rule)).toContain('check-number');
  });
  it('says how to give a subject', () => {
    expect(lintEmail({ subject: '', body: 'x', strict: false })[0]!.message).toMatch(/Subject:/);
  });
});

describe('numbers against the page', () => {
  it('a number only the model wrote in its summary of a fact does not count', () => {
    const facts = [{ id: 1, text: 'Hiring 40 people', quote: 'We are hiring in Austin this year' }];
    const r = lintEmail({ subject: 'Hi', body: 'You are hiring 40 people in Austin.', step: 1, claims: [{ text: 'hiring 40 people', fact_id: 1 }], facts });
    expect(r.map((x) => x.rule)).toContain('unsourced-number');
  });
});

describe('parseEmailFile', () => {
  it('reads the subject line and the body', () => { expect(parseEmailFile('Subject: Hi\n\nBody here\n')).toEqual({ subject: 'Hi', body: 'Body here' }); });
  it('takes a file with no subject as the body', () => { expect(parseEmailFile('Body only')).toEqual({ subject: '', body: 'Body only' }); });
});
