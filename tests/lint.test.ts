import { describe, expect, it } from 'vitest';
import { hasErrors, lintEmail, linksIn, parseEmailFile } from '../src/lint.js';

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
  it('refuses a first email pretending to follow something up, but lets a follow-up say so', () => {
    expect(rules({ ...good, body: `Following up on my last email. ${good.body}` })).toContain('fake-history');
    expect(rules({ subject: 'A thought', body: 'Following up on my last email with one idea.', step: 2 })).toEqual([]);
  });
  it('refuses placeholders that would go out blank', () => {
    expect(rules({ ...good, body: `Hi {{first_name}}, ${good.body}` })).toContain('merge-tag');
    expect(rules({ ...good, body: `Hi [First Name], ${good.body}` })).toContain('merge-tag');
  });
  it('refuses links to anywhere but the two companies', () => {
    expect(rules({ ...good, body: `${good.body} https://evil.example/x`, allowedLinkDomains: ['acme.com', 'northwind.com'] })).toContain('link-domain');
    expect(rules({ ...good, body: `${good.body} https://www.acme.com/x`, allowedLinkDomains: ['acme.com'] })).toEqual([]);
  });
  it('refuses links with no scheme, which mail programs still make clickable', () => {
    const allowed = { ...good, allowedLinkDomains: ['acme.com', 'northwind.com'] };
    for (const planted of ['evil.example/login', 'evil.example', 'EVIL.COM', 'www.evil.example', 'evil.example:8080/x', '(evil.zip)', '<evil.xyz/a>', 'see evil.co.uk.', 'пример.рф', 'xn--e1afmkfd.xn--p1ai', '1.2.3.4/login', 'acme.com@evil.example/login', 'acme.com.evil.example', 'notacme.com'])
      expect(rules({ ...allowed, body: `${good.body} ${planted}` }), planted).toContain('link-domain');
  });
  it('takes the allowed domains in any form, and leaves words and addresses alone', () => {
    const allowed = { ...good, allowedLinkDomains: ['acme.com', 'northwind.com'] };
    for (const fine of ['acme.com', 'www.acme.com/pricing', 'docs.acme.com/a', 'Northwind.com', 'sam@evil.example', 'sam.lee@evil.example', 'Node.js', 'report.pdf', 'ASP.NET', 'e.g. this', 'i.e. that', 'the U.S. market', 'at 3 p.m. today', 'version 2.5 or 1.2.3', 'costs 3.5k'])
      expect(rules({ ...allowed, body: `${good.body} ${fine}` }), fine).not.toContain('link-domain');
  });
  it('counts bare links with a path as links, and a domain merely named as none', () => {
    expect(rules({ ...good, body: `${good.body} acme.com/a acme.com/b` })).toContain('links');
    expect(rules({ ...good, body: `${good.body} https://acme.com/a acme.com/b` })).toContain('links');
    expect(rules({ ...good, body: `${good.body} On northwind.com, and https://acme.com/a` })).not.toContain('links');
  });
  it('does not read the path of a link as a second link', () => {
    expect(linksIn('https://acme.com/evil.example/x')).toEqual([{ url: 'https://acme.com/evil.example/x', full: true }]);
  });
  it('without facts, warns rather than refuses what it cannot judge', () => {
    const issues = lintEmail({ subject: 'Hello', body: 'We grew revenue 400%. Click here https://a.example https://b.example', strict: false });
    expect(hasErrors(issues)).toBe(false);
    expect(issues.map((i) => i.rule)).toEqual(expect.arrayContaining(['links', 'spam-word']));
  });
  it('still refuses fake history in a file check', () => { expect(hasErrors(lintEmail({ subject: 'Re: hi', body: 'x', strict: false }))).toBe(true); });
});

describe('general claims with no source', () => {
  const said = (extra: string) => rules({ ...good, body: `${good.body} ${extra}` });
  it('refuses how people behave, stated as fact', () => {
    expect(said('Buyers like that delete generic pitches fast.')).toContain('general-claim');
    expect(said('Teams that size often worry about control.')).toContain('general-claim');
  });
  it('lets it be asked, and leaves other sentences alone', () => {
    expect(said('Do buyers like that delete generic pitches?')).not.toContain('general-claim');
    expect(said('Our customers approve the first emails.')).not.toContain('general-claim');
    expect(said('We find firms like that from your website.')).not.toContain('general-claim');
    expect(said('With it, a team that size can run outbound.')).not.toContain('general-claim');
  });
  it('only warns in outlevo check, which has no sources', () => {
    expect(lintEmail({ subject: 'x', body: 'Buyers like that delete pitches.', strict: false }).filter((x) => x.rule === 'general-claim').map((x) => x.level)).toEqual(['warning']);
  });
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
