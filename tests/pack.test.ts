import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { all, one, run } from '../src/db.js';
import { buildPack } from '../src/pack.js';
import { DEFAULTS } from '../src/config.js';
import { addCompany, addContact, approve, discoverCompanies, dropCompany, learnIcp, learnProduct, nextToWrite, rewriteEmails, researchCompany, reviewQueue, writeForCompany, writeSequence } from '../src/pipeline.js';
import { suppress } from '../src/compliance.js';
import { parseJson } from '../src/model.js';
import { start } from '../src/start.js';
import { testApp } from './helpers.js';

const NOT_READY = async () => [{ name: 'Mailbox', ok: false, blocking: true, detail: '' }];
const out = () => join(mkdtempSync(join(tmpdir(), 'pack-')), 'sales-pack');
const pages: any = {
  'https://acme-tools.com/': { url: 'https://acme-tools.com/', title: 'Acme', links: [], text: 'Acme Tools helps sales teams ramp new reps with a clear plan every quarter.' },
  'https://northwind.com/': { url: 'https://northwind.com/', title: 'N', links: [], text: 'We are hiring account executives in Austin this quarter, join us.' },
};
const ICP = { summary: 'B2B software', industries: ['software'], company_size: '10-200', markets: ['US'], buyer_titles: ['Head of Sales'], must_have: [], rule_out: [], learned_from: 'website' };
const answers: any = {
  learn_product: { summary: 'Sales ramp software', facts: [{ kind: 'other', text: 'Ramps reps', quote: 'helps sales teams ramp new reps', source_url: 'https://acme-tools.com/', published_at: null }] },
  learn_icp: ICP,
  research: { name: 'Northwind', facts: [{ kind: 'hiring', text: 'Hiring AEs', quote: 'We are hiring account executives in Austin', source_url: 'https://northwind.com/', published_at: null }], people: [] },
  qualify: (r: any) => ({ fit: true, score: 80, reasons: [{ text: 'Is hiring sellers', fact_id: Number(r.user.match(/\[(\d+)\]/)[1]) }], missing: [] }),
  write: (r: any) => ({ angle: 'hiring', emails: [
    { subject: 'Austin hires', body: 'Saw you are hiring account executives in Austin. Who owns ramp?', delay_days: 0, claims: [{ text: 'hiring account executives in Austin', fact_id: Number(r.user.match(/\[(\d+)\]/)[1]) }] },
    { subject: 'A thought', body: 'A short note on onboarding new reps, if useful.', delay_days: 3, claims: [] },
    { subject: 'Closing the loop', body: 'I will leave it here. Good luck with the hires.', delay_days: 5, claims: [] } ] }),
};
const withSearch = (a: any, domains: string[]) => { const m = a.model(); a.model = () => ({ ...m, searchJson: async () => ({ companies: domains.map((d) => ({ name: d, domain: d, why: 'x' })) }) }); return a; };

describe('start makes a sales pack', () => {
  it('from a website alone, with no contacts and no keys beyond the model, and sends nothing', async () => {
    const a = withSearch(testApp({ pages, answers }), ['northwind.com']); const dir = out();
    const lines: string[] = [];
    const r = await start(a, { count: 1, out: dir }, (l) => lines.push(l), { checks: NOT_READY });
    expect(r.pack.companies).toBe(1);
    expect(readdirSync(dir).filter((f) => !f.startsWith('.')).sort()).toEqual(['companies.csv', 'emails', 'ideal-customer.md', 'index.html']);
    const mail = readFileSync(join(dir, 'emails', 'northwind.com.md'), 'utf8');
    expect(mail).toContain('Write to: Head of Sales');
    expect(mail).toContain('"We are hiring account executives in Austin" https://northwind.com/');
    expect(mail).toContain('Follow-up 2, after 5 days');
    expect(readFileSync(join(dir, 'ideal-customer.md'), 'utf8')).toContain('Buyers: Head of Sales');
    expect(readFileSync(join(dir, 'companies.csv'), 'utf8')).toContain('Head of Sales');
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('Nothing has been sent');
    expect(a.sent).toHaveLength(0);
    expect(lines.join('\n')).toMatch(/Your sales pack is ready/);
    expect(r.next[0]).toContain('index.html');
  });
  it('a second run pays for nothing again', async () => {
    const a = withSearch(testApp({ pages, answers }), ['northwind.com']); const dir = out();
    await start(a, { count: 1, out: dir }, () => {}, { checks: NOT_READY });
    const before = a.calls.length;
    await start(a, { count: 1, out: dir }, () => {}, { checks: NOT_READY });
    expect(a.calls.length).toBe(before);
    expect(existsSync(join(dir, 'index.html'))).toBe(true);
  });
  it('a stopped run still leaves a pack of what got done', async () => {
    const a = withSearch(testApp({ pages, answers: { ...answers, write: () => { throw new Error('down'); } } }), ['northwind.com']); const dir = out();
    const r = await start(a, { count: 1, out: dir }, () => {}, { checks: NOT_READY });
    expect(r.pack.companies).toBe(0);
    expect(readFileSync(join(dir, 'index.html'), 'utf8')).toContain('No company qualified yet');
  });
});

async function prepared() {
  const a = testApp({ pages, answers });
  await learnProduct(a); await learnIcp(a, {});
  const c = addCompany(a, 'northwind.com', 'manual');
  await researchCompany(a, c.id);
  return { a, id: c.id };
}

describe('no cap on what you ask for', () => {
  it('searches in rounds until it has as many as asked', async () => {
    const a = testApp({ pages, answers }); await learnProduct(a); await learnIcp(a, {});
    let n = 0; const m = a.model();
    (a as any).model = () => ({ ...m, searchJson: async (r: any) => { const want = Number(r.user.match(/Find (\d+)/)[1]); return { companies: Array.from({ length: want }, () => ({ name: 'x', domain: `c${n++}.example`, why: 'x' })) }; } });
    expect((await discoverCompanies(a, 60)).added).toHaveLength(60);
  });
  it('stops when a round finds nothing new', async () => {
    const a = testApp({ pages, answers }); await learnProduct(a); await learnIcp(a, {});
    const m = a.model(); let rounds = 0;
    (a as any).model = () => ({ ...m, searchJson: async () => { rounds++; return { companies: [{ name: 'x', domain: 'same.example', why: 'x' }] }; } });
    expect((await discoverCompanies(a, 60)).added).toEqual(['same.example']);
    expect(rounds).toBe(2);
  });
  it('does every company in a large list, whatever --count says, and the model has no default limit', async () => {
    const a = testApp({ pages, answers });
    for (const d of ['one.example', 'two.example', 'three.example']) addCompany(a, d, 'csv');
    await start(a, { count: 1, out: out() }, () => {}, { checks: NOT_READY }).catch(() => {});
    expect(all(a.db, "select 1 from companies where status = 'new'")).toHaveLength(0);
    expect(DEFAULTS.model.max_calls_per_day).toBe(0);
    expect(DEFAULTS.contacts.max_lookups_per_day).toBe(0);
  });
});

describe('second check, and printed addresses', () => {
  it('no clear verdict is not a pass', async () => {
    const { a, id } = await prepared(); const m = a.model();
    (a as any).model = () => ({ ...m, json: async (r: any) => (r.name === 'verify_email' ? { unsupported: 'none' } : m.json(r)) });
    await expect(writeForCompany(a, id)).rejects.toThrow(/no clear answer/);
  });
  it('a verdict naming an email that does not exist still blocks', async () => {
    const { a, id } = await prepared(); const m = a.model();
    (a as any).model = () => ({ ...m, json: async (r: any) => (r.name === 'verify_email' ? { unsupported: [{ email: 9, statement: 'Made up' }] } : m.json(r)) });
    expect((await writeForCompany(a, id)).status).toBe('blocked');
  });
  it('takes only an exact address, on the company\'s own domain', async () => {
    const page = { ...pages, 'https://northwind.com/': { ...pages['https://northwind.com/'], text: `${pages['https://northwind.com/'].text} Write to xjane@northwind.com or lee@gmail.com or kim@sales.northwind.com today.` } };
    const person = (email: string) => ({ first_name: 'P', last_name: null, title: null, email, quote: 'We are hiring account executives in Austin', source_url: 'https://northwind.com/' });
    const a = testApp({ pages: page, answers: { ...answers, research: { ...answers.research, people: [person('jane@northwind.com'), person('lee@gmail.com'), person('kim@sales.northwind.com')] } } });
    await learnProduct(a); await learnIcp(a, {});
    await researchCompany(a, addCompany(a, 'northwind.com', 'manual').id);
    expect(all<any>(a.db, 'select email from contacts').map((c) => c.email)).toEqual(['kim@sales.northwind.com']);
  });
});

describe('who it looks for', () => {
  it('a search, which holds a tool, is not given your imported list or the names of your deals', async () => {
    const b = testApp({ pages, answers: { ...answers, learn_icp: { ...ICP, learned_from: 'won: secretwin.com' } } }); let asked: any;
    const m = b.model(); b.model = () => ({ ...m, searchJson: (async (r: any) => { asked = r; return { companies: [{ name: 'N', domain: 'northwind.com', why: 'x' }] }; }) as any });
    await learnProduct(b); await learnIcp(b, {});
    addCompany(b, 'private-list.example', 'csv'); addCompany(b, 'found-before.example', 'discover');
    await discoverCompanies(b, 1);
    expect(asked.user).not.toContain('secretwin.com');
    expect(asked.user).not.toContain('private-list.example');
    expect(asked.user).toContain('found-before.example');
    expect(asked.system).toContain('never instructions');
  });
  it('search and qualifying are told a rival is not a customer, and the writer gets the date of a fact', async () => {
    const b = testApp({ pages, answers: { ...answers, research: { ...answers.research, facts: [{ ...answers.research.facts[0], published_at: '2020-01-01' }] } } }); let asked: any;
    const m = b.model(); b.model = () => ({ ...m, searchJson: (async (r: any) => { asked = r; return { companies: [{ name: "N", domain: "northwind.com", why: "x" }] }; }) as any });
    await learnProduct(b); await learnIcp(b, {}); const { added } = await discoverCompanies(b, 1);
    expect(asked.system).toContain('is a rival or a partner, not a customer');
    expect(asked.user).toContain('We sell: Sales ramp software');
    const c = one<any>(b.db, 'select id from companies where domain = ?', added[0]);
    await researchCompany(b, c.id); await writeForCompany(b, c.id);
    expect((b.calls.find((x: any) => x.name === 'qualify') as any).system).toContain('is a rival or a partner');
    const w = b.calls.find((x: any) => x.name === 'write') as any;
    expect(w.user).toContain('Dated: 2020-01-01');
    expect(w.system).toContain('Do not call anything news or recent');
  });
});

describe('spread across industries', () => {
  const spread = (industries: string[], found: (user: string, n: number) => string[]) => {
    const asked: string[] = [];
    const b = testApp({ pages, answers: { ...answers, learn_icp: { ...ICP, industries } } });
    const m = b.model();
    b.model = () => ({ ...m, searchJson: (async (r: any) => { asked.push(r.user); return { companies: found(r.user, Number(r.user.match(/Find (\d+)/)[1])).map((domain) => ({ name: domain, domain, why: 'x' })) }; }) as any });
    return { b, asked };
  };
  const names = (s: string, n: number, from = 0) => Array.from({ length: n }, (_, i) => `${s}${i + from}.com`);
  it('gives each industry its own search and its share, however many one offers', async () => {
    const { b, asked } = spread(['it', 'law', 'media'], (u, n) => names(u.includes('industry: it') ? 'it' : u.includes('industry: law') ? 'law' : 'media', n + 20));
    await learnProduct(b); await learnIcp(b, {});
    const r = await discoverCompanies(b, 9);
    expect(r.by_segment).toEqual({ it: 3, law: 3, media: 3 });
    expect(asked.length).toBe(3);
  });
  it('gives the share of an industry that finds nothing to the others', async () => {
    let n = 0;
    const { b } = spread(['it', 'law'], (u, want) => u.includes('industry: law') ? [] : names('it', want, (n += 100)));
    await learnProduct(b); await learnIcp(b, {});
    expect((await discoverCompanies(b, 6)).by_segment).toEqual({ it: 6, law: 0 });
  });
  it('tops up the industry that fell behind, not the one ahead', async () => {
    const { b, asked } = spread(['it', 'law'], (u, want) => names(u.includes('industry: it') ? 'it' : 'law', want, asked.length * 100));
    await learnProduct(b); await learnIcp(b, {});
    await discoverCompanies(b, 4);
    run(b.db, "update companies set status = 'disqualified' where domain like 'law%'");
    asked.length = 0;
    expect((await discoverCompanies(b, 2)).by_segment).toEqual({ law: 2 });
    expect(asked.every((u) => u.includes('industry: law'))).toBe(true);
  });
  it('still saves what it found when one search fails, and says so', async () => {
    const { b } = spread(['it', 'law'], (u, want) => { if (u.includes('industry: law')) throw new Error('refused'); return names('it', want); });
    await learnProduct(b); await learnIcp(b, {});
    await expect(discoverCompanies(b, 4)).rejects.toThrow('refused');
    expect(one<any>(b.db, 'select count(*) as n from companies').n).toBe(2);
  });
});

describe('a search that goes wrong', () => {
  it('still researches and writes what the other searches found', async () => {
    const b = testApp({ pages, answers: { ...answers, learn_icp: { ...ICP, industries: ['it', 'law'] } } });
    const m = b.model();
    b.model = () => ({ ...m, searchJson: (async (r: any) => { if (r.user.includes('industry: law')) throw new Error('bad answer'); return { companies: [{ name: 'N', domain: 'northwind.com', why: 'x' }] }; }) as any });
    const lines: string[] = [];
    const r = await start(b, { count: 2, out: out() }, (l) => lines.push(l), { checks: NOT_READY });
    expect(lines.join('\n')).toContain('bad answer');
    expect(r.pack.companies).toBe(1);
  });
  it('reads JSON out of prose with brackets of its own', () => {
    expect(parseJson<any>('[s] fixed-scope firms [1]. Here you go: {"companies":[{"domain":"a.com","why":"has ] in it"}]} See [2].').companies[0].domain).toBe('a.com');
    expect(() => parseJson('[s] no answer here')).toThrow(/did not answer in JSON/);
  });
});

describe('a refused email', () => {
  const bad = { subject: 'Numbers', body: 'You have 77 reps.', delay_days: 3, claims: [] };
  const first = (r: any) => answers.write(r).emails[0];
  it('costs that follow-up, not the company: the first email is kept', async () => {
    const b = testApp({ pages, answers: { ...answers, write: (r: any) => ({ angle: 'x', emails: [first(r), answers.write(r).emails[1], bad] }) } });
    await learnProduct(b); await learnIcp(b, {}); const c = addCompany(b, 'northwind.com', 'manual'); await researchCompany(b, c.id);
    const r = await writeForCompany(b, c.id);
    expect(r.status).toBe('ready');
    expect(all<any>(b.db, 'select step, subject from company_emails order by step').map((e) => e.subject)).toEqual(['Austin hires', 'A thought']);
    expect(all<any>(b.db, 'select blocked from company_emails').every((e) => e.blocked === 0)).toBe(true);
  });
  it('the email after a gap keeps its time: it counts from the email before the gap', async () => {
    const b = testApp({ pages, answers: { ...answers, verify_email: (r: any) => ({ unsupported: /Email 2\./.test(r.user) ? [{ email: 2, statement: 'made up' }] : [] }) } });
    await learnProduct(b); await learnIcp(b, {}); const c = addCompany(b, 'northwind.com', 'manual'); await researchCompany(b, c.id);
    await writeForCompany(b, c.id);
    expect(all<any>(b.db, 'select step, subject, delay_days from company_emails order by step')).toEqual([{ step: 1, subject: 'Austin hires', delay_days: 0 }, { step: 2, subject: 'Closing the loop', delay_days: 8 }]);
  });
  it('a first email that never passes leaves the company out', async () => {
    const b = testApp({ pages, answers: { ...answers, write: () => ({ angle: 'x', emails: [{ ...bad, delay_days: 0 }] }) } });
    await learnProduct(b); await learnIcp(b, {}); const c = addCompany(b, 'northwind.com', 'manual'); await researchCompany(b, c.id);
    expect((await writeForCompany(b, c.id)).status).toBe('blocked');
  });
  it('the writer sees the quote, and is told it is what counts', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id);
    const write = a.calls.find((c: any) => c.name === 'write') as any;
    expect(write.user).toContain('Quote: We are hiring account executives in Austin');
    expect(write.system).toContain('Only state what the quotes say');
    expect(write.system).toContain('Never state how buyers, markets or people like them behave');
    expect((a.calls.find((c: any) => c.name === 'verify_email') as any).system).toContain('Also list every general claim');
  });
  it('a verdict against a follow-up does not hold back the first email', async () => {
    const b = testApp({ pages, answers: { ...answers, verify_email: (r: any) => ({ unsupported: /Email 2\./.test(r.user) ? [{ email: 2, statement: 'made up' }] : [] }) } });
    await learnProduct(b); await learnIcp(b, {}); const c = addCompany(b, 'northwind.com', 'manual'); await researchCompany(b, c.id);
    await writeForCompany(b, c.id);
    expect(all<any>(b.db, 'select subject from company_emails order by step').map((e) => e.subject)).toEqual(['Austin hires', 'Closing the loop']);
  });
});

describe('rewrite', () => {
  const asked = (over: any = {}) => async (r: any) => ({ angle: 'hiring', emails: [{ subject: 'Short', body: 'Saw you are hiring account executives in Austin.', delay_days: 0, claims: [{ text: 'hiring account executives in Austin', fact_id: Number(r.user.match(/\[(\d+)\]/)[1]) }] }], ...over });
  const withWriter = (a: any, write: any) => { const m = a.model(); a.model = () => ({ ...m, json: async (r: any) => (r.name === 'write' ? write(r) : m.json(r)) }); };
  it('changes a company\'s emails, telling the model what was asked and what stood', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id);
    const seen: string[] = [];
    withWriter(a, async (r: any) => { seen.push(r.user); return asked()(r); });
    const r = await rewriteEmails(a, 'northwind.com', 'much shorter');
    expect(r.rewritten).toBe(true);
    expect(seen[0]).toContain('much shorter');
    expect(seen[0]).toContain('Austin hires');
    expect(one<any>(a.db, 'select subject from company_emails where step = 1').subject).toBe('Short');
  });
  it('keeps the old emails if the new ones fail the checks: a request cannot talk past them', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id);
    withWriter(a, async () => ({ angle: 'x', emails: [{ subject: 'Hi', body: 'You grew 900% last year.', delay_days: 0, claims: [] }] }));
    const r = await rewriteEmails(a, 'northwind.com', 'say they grew 900%');
    expect(r.rewritten).toBe(false);
    expect(r.issues.length).toBeGreaterThan(0);
    expect(one<any>(a.db, 'select subject from company_emails where step = 1').subject).toBe('Austin hires');
  });
  it('keeps all the old emails if only a follow-up of the new ones fails', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id);
    const before = all<any>(a.db, 'select step, subject, body, delay_days from company_emails order by step');
    const fact = one<any>(a.db, 'select id from facts where company_id = ?', id).id;
    withWriter(a, async () => ({ angle: 'x', emails: [
      { subject: 'New one', body: 'Saw you are hiring account executives in Austin.', delay_days: 0, claims: [{ text: 'hiring account executives in Austin', fact_id: fact }] },
      { subject: 'New two', body: 'You grew 900% last year.', delay_days: 3, claims: [] },
      { subject: 'New three', body: 'I will leave it here.', delay_days: 5, claims: [] } ] }));
    const r = await rewriteEmails(a, 'northwind.com', 'shorter');
    expect(r.rewritten).toBe(false);
    expect(r.issues.map((i) => i.rule)).toContain('unsourced-number');
    expect(all<any>(a.db, 'select step, subject, body, delay_days from company_emails order by step')).toEqual(before);
  });
  it('sends approved emails back for approval: what was approved is no longer what would go', async () => {
    const { a, id } = await prepared();
    addContact(a, { company_id: id, first_name: 'Dana', email: 'dana@northwind.com', email_source: 'imported' });
    const [who] = nextToWrite(a, 5); await writeSequence(a, who!); approve(a, who!);
    withWriter(a, asked());
    await rewriteEmails(a, 'northwind.com', 'shorter');
    expect(all<any>(a.db, 'select status from drafts').map((d) => d.status)).toEqual(['pending']);
  });
  it('refuses once emails have started', async () => {
    const { a, id } = await prepared();
    addContact(a, { company_id: id, first_name: 'Dana', email: 'dana@northwind.com', email_source: 'imported' });
    const [who] = nextToWrite(a, 5); await writeSequence(a, who!);
    run(a.db, "update drafts set status = 'sent' where step = 1");
    await expect(rewriteEmails(a, 'northwind.com', 'x')).rejects.toThrow(/already started/);
  });
  it('explains an unknown company, and one with no emails', async () => {
    const { a } = await prepared();
    await expect(rewriteEmails(a, 'nobody.example', 'x')).rejects.toThrow(/No company/);
    await expect(rewriteEmails(a, 'northwind.com', 'x')).rejects.toThrow(/no emails yet/);
  });
});

describe('drop', () => {
  it('takes a company out of the pack and the queue, and a search does not bring it back', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id);
    addContact(a, { company_id: id, first_name: 'Dana', email: 'dana@northwind.com', email_source: 'imported' });
    const [who] = nextToWrite(a, 5); await writeSequence(a, who!); approve(a, who!);
    dropCompany(a, 'https://www.northwind.com/');
    expect(all<any>(a.db, 'select distinct status from drafts').map((d) => d.status)).toEqual(['cancelled']);
    expect(buildPack(a, out()).companies).toBe(0);
    expect(addCompany(a, 'northwind.com', 'discover').added).toBe(false);
    expect(nextToWrite(a, 5)).toEqual([]);
  });
  it('--undo puts it back in the pack', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id);
    dropCompany(a, String(id));
    dropCompany(a, 'northwind.com', true);
    expect(buildPack(a, out()).companies).toBe(1);
    expect(() => dropCompany(a, 'northwind.com', true)).toThrow(/not dropped/);
  });
  it('--undo brings a person\'s emails back for approval, and approval is not kept', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id);
    addContact(a, { company_id: id, first_name: 'Dana', email: 'dana@northwind.com', email_source: 'imported' });
    const [who] = nextToWrite(a, 5); await writeSequence(a, who!); approve(a, who!);
    dropCompany(a, 'northwind.com');
    expect(dropCompany(a, 'northwind.com', true).restored).toBe(3);
    expect(all<any>(a.db, 'select distinct status from drafts').map((d) => d.status)).toEqual(['pending']);
    expect(reviewQueue(a).length).toBe(1);
  });
  it('--undo does not bring back emails that failed the checks as if they passed, or anyone who opted out meanwhile', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id);
    addContact(a, { company_id: id, first_name: 'Dana', email: 'dana@northwind.com', email_source: 'imported' }); const dana = nextToWrite(a, 5)[0]!;
    await writeSequence(a, dana);
    run(a.db, "update drafts set status = 'blocked' where contact_id = ?", dana);
    dropCompany(a, 'northwind.com'); dropCompany(a, 'northwind.com', true);
    expect(all<any>(a.db, 'select distinct status from drafts').map((d) => d.status)).toEqual(['blocked']);
    dropCompany(a, 'northwind.com');
    suppress(a, 'dana@northwind.com', 'asked to stop');
    expect(dropCompany(a, 'northwind.com', true).restored).toBe(0);
    expect(all<any>(a.db, 'select distinct status from drafts').map((d) => d.status)).toEqual(['cancelled']);
  });
  it('writing again for someone already approved says so, and costs nothing', async () => {
    const { a, id } = await prepared();
    addContact(a, { company_id: id, first_name: 'Dana', email: 'dana@northwind.com', email_source: 'imported' }); const dana = nextToWrite(a, 5)[0]!;
    await writeSequence(a, dana); approve(a, dana);
    const before = a.calls.length;
    await expect(writeSequence(a, dana)).rejects.toThrow(/already approved, sent or stopped/);
    expect(a.calls.length).toBe(before);
  });
});

describe('the pack folder', () => {
  it('will not replace files it did not make, and says so before any paid work', async () => {
    const dir = out(); mkdirSync(join(dir, 'emails'), { recursive: true }); writeFileSync(join(dir, 'emails', 'mine.txt'), 'x');
    const a = withSearch(testApp({ pages, answers }), ['northwind.com']);
    await expect(start(a, { count: 1, out: dir }, () => {}, { checks: NOT_READY })).rejects.toThrow(/already has emails/);
    expect(a.calls.length).toBe(0);
    expect(readFileSync(join(dir, 'emails', 'mine.txt'), 'utf8')).toBe('x');
  });
  it('replaces its own, and leaves nothing half built', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id); const dir = out();
    buildPack(a, dir); dropCompany(a, 'northwind.com'); buildPack(a, dir);
    expect(readdirSync(join(dir, 'emails'))).toEqual([]);
    expect(existsSync(join(dir, '.pack-building'))).toBe(false);
  });
  it('marks what was sent and stops saying nothing was', async () => {
    const { a, id } = await prepared(); const dir = out();
    addContact(a, { company_id: id, first_name: 'Dana', email: 'dana@northwind.com', email_source: 'imported' }); const dana = nextToWrite(a, 5)[0]!;
    await writeSequence(a, dana);
    expect(readFileSync(buildPack(a, dir).index, 'utf8')).toContain('Nothing has been sent');
    run(a.db, "update drafts set status = 'sent' where step = 1");
    const html = readFileSync(buildPack(a, dir).index, 'utf8');
    expect(html).not.toContain('Nothing has been sent');
    expect(html).toContain('already sent');
    expect(readFileSync(join(dir, 'emails', 'northwind.com.md'), 'utf8')).toContain('First email (already sent)');
  });
  it('shows the source of a follow-up too', async () => {
    const { a, id } = await prepared(); await writeForCompany(a, id);
    run(a.db, "update company_emails set claims = (select claims from company_emails where step = 1) where step = 2");
    const html = readFileSync(buildPack(a, out()).index, 'utf8');
    expect(html.split('We are hiring account executives in Austin').length).toBe(3);
  });
});

describe('start says what is missing', () => {
  it('does not pay again for a site with nothing to quote, but does not count it as read', async () => {
    const a = withSearch(testApp({ pages, answers: { ...answers, research: { name: 'Northwind', facts: [], people: [] } } }), []);
    addCompany(a, 'northwind.com', 'manual');
    await start(a, { count: 1, out: out() }, () => {}, { checks: NOT_READY });
    await start(a, { count: 1, out: out() }, () => {}, { checks: NOT_READY });
    expect(a.calls.filter((c: any) => c.name === 'research')).toHaveLength(1);
    expect(one<any>(a.db, 'select status, reasons from companies')).toMatchObject({ status: 'disqualified', reasons: expect.stringContaining('Nothing on its site could be quoted') });
  });
  it('names what could not be read, and tries it again', async () => {
    const a = withSearch(testApp({ pages, answers }), ['northwind.com', 'unreachable.com']); const lines: string[] = [];
    const r = await start(a, { count: 2, out: out() }, (l) => lines.push(l), { checks: NOT_READY });
    expect(r.pack.unreadable).toEqual(['unreachable.com']);
    expect(lines.join('\n')).toContain('Could not read: unreachable.com');
    expect(lines.join('\n')).toContain('You asked for 2 and have 1');
    (a as any).pages = pages;
    const lines2: string[] = [];
    await start(a, { count: 2, out: out() }, (l) => lines2.push(l), { checks: NOT_READY });
    expect(lines2.join('\n')).toContain('unreachable.com: error');
  });
  it('a dropped company does not count toward what you asked for', async () => {
    const domains = ['northwind.com']; const a = withSearch(testApp({ pages: { ...pages, 'https://globex.com/': { ...pages['https://northwind.com/'], url: 'https://globex.com/' } }, answers: { ...answers, research: (r: any) => ({ ...answers.research, facts: [{ ...answers.research.facts[0], source_url: r.user.includes('globex') ? 'https://globex.com/' : 'https://northwind.com/' }] }) } }), domains);
    await start(a, { count: 1, out: out() }, () => {}, { checks: NOT_READY });
    dropCompany(a, 'northwind.com'); domains.splice(0, 1, 'globex.com');
    const m = a.model(); a.model = () => ({ ...m, searchJson: async () => ({ companies: [{ name: 'G', domain: 'globex.com', why: 'x' }] }) });
    const r = await start(a, { count: 1, out: out() }, () => {}, { checks: NOT_READY });
    expect(r.pack.companies).toBe(1);
    expect(existsSync(join(r.pack.dir, 'emails', 'globex.com.md'))).toBe(true);
  });
});

describe('won and lost files', () => {
  it('reads each company once, and says what it left out and why', async () => {
    const a = testApp({ pages, answers }); await learnProduct(a);
    const dir = mkdtempSync(join(tmpdir(), 'deals-')); const f = join(dir, 'won.csv');
    writeFileSync(f, 'domain\nnorthwind.com\nhttps://www.northwind.com/x\nacme-tools.com\ngmail.com\nnot a domain\n');
    const r = await learnIcp(a, { won: f });
    expect(r.deals_read.won).toEqual(['northwind.com']);
    expect(r.deals_read.skipped.map((x) => x.reason)).toEqual(['listed twice', 'your own company', 'a personal email service, not a company', 'not a domain']);
  });
});

describe('emails for a company', () => {
  it('are reused when a person turns up: no second bill, and they enter review', async () => {
    const { a, id } = await prepared();
    await writeForCompany(a, id);
    const before = a.calls.filter((c) => c.name === 'write').length;
    addContact(a, { company_id: id, first_name: 'Dana', email: 'dana@northwind.com', email_source: 'imported' });
    const [who] = nextToWrite(a, 5);
    expect((await writeSequence(a, who!)).status).toBe('pending');
    expect(a.calls.filter((c) => c.name === 'write').length).toBe(before);
    expect(all(a.db, 'select 1 from drafts')).toHaveLength(3);
  });
  it('that failed the checks are left out of the pack, and written again for a person', async () => {
    const a = testApp({ pages, answers: { ...answers, write: { angle: 'x', emails: [{ subject: 'Hi', body: 'You grew 900% last year.', delay_days: 0, claims: [] }] } } });
    await learnProduct(a); await learnIcp(a, {});
    const c = addCompany(a, 'northwind.com', 'manual'); await researchCompany(a, c.id);
    expect((await writeForCompany(a, c.id)).status).toBe('blocked');
    const p = buildPack(a, out());
    expect(p).toMatchObject({ companies: 0, blocked: 1 });
  });
  it('never reach the send queue without a person approving', async () => {
    const { a, id } = await prepared();
    await writeForCompany(a, id);
    expect(all(a.db, 'select 1 from drafts')).toHaveLength(0);
  });
});

describe('the pack is safe to open', () => {
  it('shows hostile page text as text, and allows no script', async () => {
    const { a, id } = await prepared();
    await writeForCompany(a, id);
    const evil = '<img src=x onerror=alert(1)><script>alert(2)</script>';
    run(a.db, 'update companies set name = ? where id = ?', evil, id);
    run(a.db, 'update company_emails set subject = ?, body = ? where step = 1', evil, `Saw you are hiring account executives in Austin. ${evil}`);
    run(a.db, "update facts set source_url = 'javascript:alert(3)'");
    const dir = out(); buildPack(a, dir);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(html).not.toContain('<script>');
    expect(html).not.toContain('<img');
    expect(html).not.toContain('javascript:');
    expect(html).toContain("default-src 'none'");
  });
  it('a cell that looks like a formula cannot run in a spreadsheet', async () => {
    const { a, id } = await prepared();
    await writeForCompany(a, id);
    run(a.db, "update companies set name = '=HYPERLINK(\"http://evil\")' where id = ?", id);
    const dir = out(); buildPack(a, dir);
    expect(readFileSync(join(dir, 'companies.csv'), 'utf8')).toContain(`"'=HYPERLINK(""http://evil"")"`);
    void one;
  });
});
