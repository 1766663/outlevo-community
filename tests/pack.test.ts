import { existsSync, mkdtempSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { all, one, run } from '../src/db.js';
import { buildPack } from '../src/pack.js';
import { DEFAULTS } from '../src/config.js';
import { addCompany, addContact, discoverCompanies, learnIcp, learnProduct, nextToWrite, researchCompany, writeForCompany, writeSequence } from '../src/pipeline.js';
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
    expect(readdirSync(dir).sort()).toEqual(['companies.csv', 'emails', 'ideal-customer.md', 'index.html']);
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
