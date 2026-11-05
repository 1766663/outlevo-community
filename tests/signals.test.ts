import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { all } from '../src/db.js';
import { boardApi, boardsIn, freshPostings, parseBoard } from '../src/jobs.js';
import { buildPack, DONE_FOR_YOU_URL } from '../src/pack.js';
import { addCompany, learnIcp, learnProduct, researchCompany, rewriteEmails, writeForCompany } from '../src/pipeline.js';
import { TUESDAY_NOON, testApp } from './helpers.js';

// Hiring signals from the job board a company's own site links to (Greenhouse, Lever, Ashby: public JSON, no key, no
// model call), LinkedIn notes to send by hand (written with the emails, held to the same rules, never blocking them),
// and the pack's fourth way to send: have Outlevo's team run it.

const page = (url: string, text: string, links: string[] = []) => ({ url, title: null, links, text });
const pages = {
  'https://acme-tools.com/': page('https://acme-tools.com/', 'Acme Tools helps sales teams ramp new reps with a clear plan every quarter.'),
  'https://northwind.com/': page('https://northwind.com/', 'Northwind sells routing software to logistics companies across the US.', ['https://northwind.com/careers']),
  'https://northwind.com/careers': page('https://northwind.com/careers', 'Join us at Northwind. See all of our open roles on the board below.', ['https://boards.greenhouse.io/northwind', 'https://jobs.lever.co/someone-else-entirely/']),
};
const GH = 'https://boards-api.greenhouse.io/v1/boards/northwind/jobs';
const LV = 'https://api.lever.co/v0/postings/someone-else-entirely?mode=json&limit=100';
const json = {
  [GH]: { jobs: [
    { title: 'Senior Account Executive', absolute_url: 'https://boards.greenhouse.io/northwind/jobs/1', location: { name: 'Austin, TX' }, first_published: '2026-10-28T10:00:00Z' },
    { title: 'Revenue Operations Manager', absolute_url: 'https://evil.example/phish', location: { name: 'Remote' }, first_published: '2026-10-30T10:00:00Z', updated_at: '2026-10-30T10:00:00Z' },
    { title: 'Edited Old Role', absolute_url: 'https://boards.greenhouse.io/northwind/jobs/4', location: null, first_published: '2025-01-02T10:00:00Z', updated_at: '2026-11-01T10:00:00Z' },
    { title: 'From The Future', absolute_url: 'https://boards.greenhouse.io/northwind/jobs/5', location: null, first_published: '2099-01-01T10:00:00Z' },
    null,
    { title: 'Office Manager', absolute_url: 'https://boards.greenhouse.io/northwind/jobs/3', location: null, first_published: '2026-01-02T10:00:00Z' },
  ] },
  [LV]: [{ text: 'Account Executive', hostedUrl: 'https://jobs.lever.co/someone-else-entirely/9', createdAt: Date.parse('2026-11-01T00:00:00Z'), categories: { location: 'NYC' } }],
};
const ICP = { summary: 'B2B software', industries: ['software'], company_size: '10-200', markets: ['US'], buyer_titles: ['Head of Sales'], must_have: [], rule_out: [], learned_from: 'website' };
const idOf = (r: any, title: string) => Number(new RegExp(`\\[(\\d+)\\] (?:\\(hiring\\) )?Hiring: ${title}`).exec(r.user)![1]);
const write = (li: Record<string, unknown> | null) => (r: any) => {
  const id = idOf(r, 'Senior Account Executive');
  return { angle: 'hiring', emails: [
    { subject: 'Your AE search', body: 'Saw you are hiring a Senior Account Executive. We help new reps ramp. Who owns that?', delay_days: 0, claims: [{ text: 'hiring a Senior Account Executive', fact_id: id }] },
    { subject: 'A thought', body: 'A short note on onboarding new reps, if useful.', delay_days: 3, claims: [] },
    { subject: 'Closing the loop', body: 'I will leave it here. Good luck with the hires.', delay_days: 5, claims: [] },
  ], linkedin: li ? { claims: [{ text: 'hiring a Senior Account Executive', fact_id: id }], ...li } : undefined };
};
const answers = (li: Record<string, unknown> | null): any => ({
  learn_product: { summary: 'Sales ramp software', facts: [] }, learn_icp: ICP,
  research: { name: 'Northwind', facts: [], people: [] },
  qualify: (r: any) => ({ fit: true, score: 80, reasons: [{ text: 'Hiring sellers', fact_id: idOf(r, 'Senior Account Executive') }], missing: [] }),
  write: write(li),
});
const GOOD_LI = { note: 'Hi, saw you are hiring a Senior Account Executive. I work on how new reps ramp, and would be glad to connect.', message: 'Thanks for connecting. When a new AE starts, who decides which accounts they get first?' };

async function researched(li: Record<string, unknown> | null = GOOD_LI) {
  const a = testApp({ pages, json, answers: answers(li) });
  await learnProduct(a); await learnIcp(a, {});
  const c = addCompany(a, 'northwind.com', 'manual');
  const r = await researchCompany(a, c.id);
  return { a, c, r };
}

describe('hiring signals from job boards', () => {
  it('finds only the boards the company\'s own pages link to', () => {
    expect(boardsIn([pages['https://northwind.com/careers']])).toEqual([{ kind: 'greenhouse', token: 'northwind' }, { kind: 'lever', token: 'someone-else-entirely' }]);
    expect(boardsIn([page('https://x.com/', '', ['https://job-boards.greenhouse.io/embed/job_board?for=acme', 'https://jobs.ashbyhq.com/Acme/123', 'https://greenhouse.io/blog'])]))
      .toEqual([{ kind: 'greenhouse', token: 'acme' }, { kind: 'ashby', token: 'acme' }]);
    expect(boardApi({ kind: 'ashby', token: 'acme' })).toBe('https://api.ashbyhq.com/posting-api/job-board/acme');
    expect(boardsIn([page('https://x.com/', '', ['https://job-boards.eu.greenhouse.io/acme/jobs/1', 'https://boards.greenhouse.io/embed/job_board/js?for=globex'])]))
      .toEqual([{ kind: 'greenhouse', token: 'acme', eu: true }, { kind: 'greenhouse', token: 'globex' }]);
    expect(boardsIn([page('https://x.com/', '', ['https://jobs.lever.co/acme./'])])).toEqual([]);
    expect(boardApi({ kind: 'greenhouse', token: 'acme', eu: true })).toBe('https://boards-api.eu.greenhouse.io/v1/boards/acme/jobs');
  });

  it('reads each board\'s shape; a link off the board or the company\'s site becomes the board\'s page; old postings drop out', () => {
    const gh = parseBoard({ kind: 'greenhouse', token: 'northwind' }, json[GH], 'northwind.com');
    expect(gh.map((p) => p.url)).toEqual(['https://boards.greenhouse.io/northwind/jobs/1', 'https://boards.greenhouse.io/northwind', 'https://boards.greenhouse.io/northwind/jobs/4', 'https://boards.greenhouse.io/northwind/jobs/5', 'https://boards.greenhouse.io/northwind/jobs/3']);
    expect(freshPostings(gh, TUESDAY_NOON).map((p) => p.title)).toEqual(['Revenue Operations Manager', 'Senior Account Executive']);
    expect(parseBoard({ kind: 'lever', token: 'x' }, json[LV], 'x.com')[0]).toMatchObject({ title: 'Account Executive', location: 'NYC', posted_at: '2026-11-01' });
    expect(parseBoard({ kind: 'ashby', token: 'a' }, { jobs: [{ title: 'Head of Sales‮', jobUrl: 'https://jobs.ashbyhq.com/a/1', location: 'Berlin', publishedAt: '2026-10-20' }] }, 'a.com')[0])
      .toMatchObject({ title: 'Head of Sales', location: 'Berlin' });
    expect(parseBoard({ kind: 'greenhouse', token: 'n' }, { nope: 1 }, 'n.com')).toEqual([]);
  });

  it('become dated facts the company is qualified and written on, with the posting as the source', async () => {
    const { a, r } = await researched();
    // Lever's someone-else-entirely is linked from their careers page but is not their board: left out
    expect(r).toMatchObject({ status: 'qualified', jobs: 2 });
    expect(all<any>(a.db, "select data from events where kind = 'company.job_board_skipped'").map((e) => JSON.parse(e.data).token)).toEqual(['someone-else-entirely']);
    const facts = all<any>(a.db, "select text, quote, source_url, published_at from facts where kind = 'hiring' order by id");
    expect(facts).toContainEqual({ text: 'Hiring: Senior Account Executive (Austin, TX)', quote: 'Senior Account Executive', source_url: 'https://boards.greenhouse.io/northwind/jobs/1', published_at: '2026-10-28' });
    expect(facts.map((f) => f.quote)).not.toContain('Office Manager');
    expect(a.calls.find((c) => c.name === 'qualify')!.user).toContain('Hiring: Senior Account Executive');
  });
});

describe('LinkedIn notes to send by hand', () => {
  it('are written with the emails, checked by the same second reading, and land in the pack', async () => {
    const { a, c } = await researched();
    const before = a.calls.length;
    await writeForCompany(a, c.id);
    expect(a.calls.slice(before).map((x) => x.name)).toEqual(['write', 'verify_email']);
    expect(a.calls.at(-1)!.user).toContain('LinkedIn connection note');
    const dir = join(mkdtempSync(join(tmpdir(), 'pack-')), 'sales-pack');
    const p = buildPack(a, dir);
    expect(p.linkedin).toBe(1);
    const md = readFileSync(join(dir, 'linkedin.md'), 'utf8');
    expect(md).toContain(GOOD_LI.note);
    expect(md).toContain('this tool never touches LinkedIn');
    expect(md).toContain('"Senior Account Executive" https://boards.greenhouse.io/northwind/jobs/1');
    expect(readFileSync(join(dir, 'companies.csv'), 'utf8').split('\n')[0]).toMatch(/,linkedin_note,linkedin_message$/);
    const html = readFileSync(join(dir, 'index.html'), 'utf8');
    expect(html).toContain('LinkedIn, to send by hand');
    expect(html).toContain(DONE_FOR_YOU_URL);
  });

  it('a note that breaks a rule is left out, a follow-up that does is dropped alone, and neither holds back the emails', async () => {
    const cases: Array<[Record<string, string>, 'none' | 'note only']> = [
      [{ ...GOOD_LI, note: `${GOOD_LI.note} ${'More words here. '.repeat(20)}` }, 'none'],
      [{ ...GOOD_LI, note: 'Hi, saw you are hiring a Senior Account Executive. See acme-tools.com/ramp for how we help.' }, 'none'],
      [{ ...GOOD_LI, note: 'Following up on my last email: saw you are hiring a Senior Account Executive.' }, 'none'],
      [{ ...GOOD_LI, message: 'Thanks for connecting. I emailed you about this last week, did you see it?' }, 'note only'],
      [{ ...GOOD_LI, message: 'Thanks for connecting. Teams like yours cut ramp time by 40% with us. Worth a chat?' }, 'note only'],
      // naming a company by its domain is a name, not a link; saying what you sell is about email is not a claim of contact
      [{ ...GOOD_LI, message: 'Thanks for connecting. Northwind.com and acme-tools.com both care about email outreach that ramps reps. How do you handle it?' }, 'note and message' as never],
    ];
    for (const [bad, want] of cases) {
      const { a, c } = await researched(bad);
      expect((await writeForCompany(a, c.id)).status).toBe('ready');
      const row = all<{ note: string; message: string }>(a.db, 'select note, message from linkedin_notes')[0];
      if (want === 'none') expect(row, bad.note).toBeUndefined();
      else if (want === 'note only') expect(row, bad.message).toEqual({ note: GOOD_LI.note, message: '' });
      else expect(row).toEqual({ note: GOOD_LI.note, message: bad.message });
    }
  });

  it('a rewrite replaces them, or removes them when the new ones fail', async () => {
    const { a, c } = await researched();
    await writeForCompany(a, c.id);
    a.model = () => ({ json: async (r: any) => (r.name === 'write' ? write({ ...GOOD_LI, note: 'As I mentioned in my email, hi.' })(r) : { unsupported: [] }) }) as any;
    expect((await rewriteEmails(a, 'northwind.com', 'shorter')).rewritten).toBe(true);
    expect(all(a.db, 'select 1 from linkedin_notes')).toHaveLength(0);
  });
});

// Form D funding signals (SEC EDGAR) and posts you bring.
import { fundingFacts, legalName, onTheirSite, parseFormD } from '../src/funding.js';
import { excerpt, importSignals } from '../src/brought.js';
import { writeFileSync } from 'node:fs';

const FORM_D = (name: string, zip: string, phone: string, sold = '2500000', industry = 'Other Technology') => `<edgarSubmission><primaryIssuer><cik>0001719932</cik><entityName>${name}</entityName>
<issuerAddress><street1>1 Main St</street1><city>Austin</city><stateOrCountry>TX</stateOrCountry><zipCode>${zip}</zipCode></issuerAddress><issuerPhoneNumber>${phone}</issuerPhoneNumber></primaryIssuer>
<offeringData><industryGroup><industryGroupType>${industry}</industryGroupType></industryGroup><typeOfFiling><dateOfFirstSale><value>2026-09-30</value></dateOfFirstSale></typeOfFiling>
<offeringSalesAmounts><totalOfferingAmount>5000000</totalOfferingAmount><totalAmountSold>${sold}</totalAmountSold></offeringSalesAmounts></offeringData></edgarSubmission>`;
const hit = (name: string, adsh: string, filed = '2026-10-15') => ({ _source: { display_names: [`${name}  (CIK 0001719932)`], ciks: ['0001719932'], adsh, file_date: filed } });
const efts = (name: string) => `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${name}"`)}&forms=D&dateRange=custom&startdt=2026-05-07&enddt=2026-11-03`;
const doc = (adsh: string) => `https://www.sec.gov/Archives/edgar/data/1719932/${adsh.replace(/-/g, '')}/primary_doc.xml`;
const site = [page('https://northwind.com/', 'Northwind, 1 Main St, Austin, TX 78701. Call (512) 555-0100.')];

describe('funding signals from Form D', () => {
  it('names match without the legal form, a ticker, or a generic tail; other names do not', () => {
    expect(legalName('Northwind Technologies, Inc.  (NWTX)  (CIK 0001)')).toBe('northwind');
    expect(legalName('Northwind')).toBe('northwind');
    expect(legalName('Northwind Capital Fund I, L.P.')).not.toBe('northwind');
    expect(legalName('Northwind Holdings Inc.')).not.toBe('northwind');
    expect(legalName('Ünïcode SA')).toBe('ünïcode');
    const t = Date.now(); legalName('('.repeat(60_000)); legalName(' tech'.repeat(40_000)); expect(Date.now() - t).toBeLessThan(200);
  });

  it('counts a filing only when its ZIP code or phone is on the company\'s own pages', () => {
    const f = parseFormD(FORM_D('Northwind, Inc.', '78701', '512-555-0100'), '1719932', '0001719932-26-000001', '2026-10-15')!;
    expect(f).toMatchObject({ entity: 'Northwind, Inc.', zip: '78701', phone: '5125550100', sold: 2500000, offered: 5000000, first_sale: '2026-09-30' });
    expect(onTheirSite(f, site)).toBe(true);
    const at = (zip: string, phone: string, city = 'Austin', state = 'TX') => ({ zip, phone, city, state });
    expect(onTheirSite(at('94104', '4158053000', 'San Francisco', 'CA'), site)).toBe(false);
    // a phone counts only with the filing's city on the pages too: filing agents share their phones
    expect(onTheirSite(at('94104', '5125550100', 'San Francisco', 'CA'), site)).toBe(false);
    expect(onTheirSite(at('99999', '5125550100', 'Austin', 'XX'), site)).toBe(true);
    // a bare ZIP or loose digits elsewhere on a page are no address
    expect(onTheirSite(at('78701', '0000000000', 'Dallas', 'NY'), site)).toBe(false);
    expect(onTheirSite(at('55555', '5125550100'), [page('https://x.com/', 'Order 51255 then 50100. Our customer at 55555.')])).toBe(false);
  });

  it('becomes one dated fact with the filing\'s amount as its quote; a fund, another name or another address gives none', async () => {
    const ok = '0001719932-26-000001';
    const a = testApp({ json: { [efts('Northwind')]: { hits: { hits: [hit('Northwind Capital Fund I, L.P.', '0001719932-26-000009'), hit('Northwind, Inc.', ok)] } } }, text: { [doc(ok)]: FORM_D('Northwind, Inc.', '78701', '512-555-0100') } });
    expect(await fundingFacts(a, 'Northwind', site, 'globex.com')).toEqual([]);
    expect(await fundingFacts(a, 'Northwind', site, 'northwind.com')).toEqual([{ kind: 'funding', published_at: '2026-10-15', quote: 'Total Amount Sold $2,500,000',
      text: 'Raised money privately: a Form D filed 2026-10-15, $2,500,000 sold so far, first sale 2026-09-30', source_url: 'https://www.sec.gov/Archives/edgar/data/1719932/000171993226000001/xslFormDX01/primary_doc.xml' }]);
    const elsewhere = testApp({ json: { [efts('Northwind')]: { hits: { hits: [hit('Northwind, Inc.', ok)] } } }, text: { [doc(ok)]: FORM_D('Northwind, Inc.', '10001', '212-555-0199') } });
    expect(await fundingFacts(elsewhere, 'Northwind', site)).toEqual([]);
    expect(all(elsewhere.db, "select kind from events")).toEqual([{ kind: 'company.form_d_unmatched' }]);
    const fund = testApp({ json: { [efts('Northwind')]: { hits: { hits: [hit('Northwind, Inc.', ok)] } } }, text: { [doc(ok)]: FORM_D('Northwind, Inc.', '78701', '512-555-0100', '0', 'Pooled Investment Fund') } });
    expect(await fundingFacts(fund, 'Northwind', site)).toEqual([]);
    expect(await fundingFacts(testApp({}), 'NW', site)).toEqual([]);
  });

  it('can be turned off', async () => {
    const a = testApp({ pages, json, answers: answers(null), config: { signals: { job_boards: false, sec_form_d: false } } as any });
    await learnProduct(a); await learnIcp(a, {});
    let asked = 0; const read = a.fetchJson; a.fetchJson = async (u) => { asked++; return read(u); };
    await researchCompany(a, addCompany(a, 'northwind.com', 'manual').id).catch(() => null);
    expect(asked).toBe(0);
    expect(all(a.db, "select 1 from facts where kind in ('hiring','funding')")).toHaveLength(0);
  });
});

describe('posts you bring', () => {
  const csv = (rows: string) => { const p = join(mkdtempSync(join(tmpdir(), 'sig-')), 'posts.csv'); writeFileSync(p, rows); return p; };
  const POST = 'Honestly our payroll is a mess this quarter, three systems and nobody owns it. Anyone fixed this?';

  it('quotes the author\'s own words, cut at a sentence', () => {
    expect(excerpt(`${'Our ramp is slow. '.repeat(10)}${'x'.repeat(300)}`).endsWith('slow.')).toBe(true);
    expect(excerpt('Short post about payroll pain.')).toBe('Short post about payroll pain.');
  });

  it('imports posts with their company, skips rows it cannot use, and the email is written to the author', async () => {
    const a = testApp({ pages, json, answers: { ...answers(GOOD_LI), qualify: (r: any) => ({ fit: true, score: 70, reasons: [{ text: 'Posted about payroll', fact_id: Number(/\[(\d+)\] Jordan Lee/.exec(r.user)![1]) }], missing: [] }),
      write: (r: any) => { const id = Number(/\[(\d+)\] \(post\)/.exec(r.user)![1]); return { angle: 'post', emails: [
        { subject: 'Your payroll post', body: 'Read your post: "our payroll is a mess this quarter". We help with that. Who owns it now?', delay_days: 0, claims: [{ text: 'our payroll is a mess this quarter', fact_id: id }] },
      ], linkedin: undefined }; } } });
    await learnProduct(a); await learnIcp(a, {});
    const r = importSignals(a, csv(`domain,name,title,text,post_url,date\nnorthwind.com,Jordan Lee,Controller,"${POST}",https://www.linkedin.com/posts/jordan-1,2026-11-02\nnorthwind.com,No Text,CFO,,https://x.com/1,\n,Pat,CFO,"${POST}",https://x.com/2,\nacme-tools.com,Me,Founder,"${POST}",https://x.com/3,\nnorthwind.com,Jordan Lee,Controller,"${POST}",https://www.linkedin.com/posts/jordan-1,\n`));
    expect(r).toMatchObject({ added: 1, duplicates: 1, companies: ['northwind.com'] });
    expect(r.skipped.map((x) => x.reason)).toEqual(['no post text (copy the words of the post into a text column)', 'no company domain', 'your own company']);
    const c = await researchCompany(a, 1);
    expect(c.status).toBe('qualified');
    expect(all<any>(a.db, "select text, quote, source_url, published_at from facts where kind = 'post'")).toEqual([{ text: `Jordan Lee, Controller, wrote in a post: "${POST}"`, quote: POST, source_url: 'https://www.linkedin.com/posts/jordan-1', published_at: '2026-11-02' }]);
    await writeForCompany(a, 1);
    expect(a.calls.findLast((x) => x.name === 'write')!.user).toContain('Jordan Lee, Controller (wrote the post the first email opens on), at');
    expect(all<any>(a.db, 'select to_title from company_emails')[0].to_title).toMatch(/^Jordan Lee, Controller/);
    // research again keeps the post
    await researchCompany(a, 1);
    expect(all(a.db, "select 1 from facts where kind = 'post'")).toHaveLength(1);
  });
});

import { boardUrls, structuredAddress } from '../src/fetcher.js';
describe('what a page hides in its scripts', () => {
  it('finds board URLs in raw HTML and JSON, and an address in JSON-LD', () => {
    const html = `<script>{"jobs":"https:\\/\\/jobs.ashbyhq.com\\/ramp\\/123","x":"https://boards.greenhouse.io/vercel"}</script><script type="application/ld+json">{"address":{"addressLocality":"San Francisco","addressRegion":"CA","postalCode":"94104"},"telephone":"+1 415-805-3000"}</script>`;
    expect(boardUrls(html)).toEqual(['https://jobs.ashbyhq.com/ramp/123', 'https://boards.greenhouse.io/vercel']);
    expect(structuredAddress(html)).toBe('\nSan Francisco, CA 94104\nPhone +1 415-805-3000');
    expect(onTheirSite({ zip: '94104', phone: null, city: 'San Francisco', state: 'CA' }, [page('https://mercury.com/', `Mercury${structuredAddress(html)}`)])).toBe(true);
  });
});
