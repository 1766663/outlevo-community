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
    { title: 'Revenue Operations Manager', absolute_url: 'https://evil.example/phish', location: { name: 'Remote' }, updated_at: '2026-10-30T10:00:00Z' },
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
  });

  it('reads each board\'s shape; a link off the board or the company\'s site becomes the board\'s page; old postings drop out', () => {
    const gh = parseBoard({ kind: 'greenhouse', token: 'northwind' }, json[GH], 'northwind.com');
    expect(gh.map((p) => p.url)).toEqual(['https://boards.greenhouse.io/northwind/jobs/1', 'https://boards.greenhouse.io/northwind', 'https://boards.greenhouse.io/northwind/jobs/3']);
    expect(freshPostings(gh, TUESDAY_NOON).map((p) => p.title)).toEqual(['Revenue Operations Manager', 'Senior Account Executive']);
    expect(parseBoard({ kind: 'lever', token: 'x' }, json[LV], 'x.com')[0]).toMatchObject({ title: 'Account Executive', location: 'NYC', posted_at: '2026-11-01' });
    expect(parseBoard({ kind: 'ashby', token: 'a' }, { jobs: [{ title: 'Head of Sales‮', jobUrl: 'https://jobs.ashbyhq.com/a/1', location: 'Berlin', publishedAt: '2026-10-20' }] }, 'a.com')[0])
      .toMatchObject({ title: 'Head of Sales', location: 'Berlin' });
    expect(parseBoard({ kind: 'greenhouse', token: 'n' }, { nope: 1 }, 'n.com')).toEqual([]);
  });

  it('become dated facts the company is qualified and written on, with the posting as the source', async () => {
    const { a, r } = await researched();
    expect(r).toMatchObject({ status: 'qualified', jobs: 3 });
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

  it('a note that breaks a rule is left out, and never holds back the emails', async () => {
    for (const bad of [
      { ...GOOD_LI, note: `${GOOD_LI.note} ${'More words here. '.repeat(20)}` },
      { ...GOOD_LI, message: 'Thanks for connecting. I emailed you about this last week, did you see it?' },
      { ...GOOD_LI, note: 'Hi, saw you are hiring a Senior Account Executive. See acme-tools.com/ramp for how we help.' },
      { ...GOOD_LI, message: 'Thanks for connecting. Teams like yours cut ramp time by 40% with us. Worth a chat?' },
    ]) {
      const { a, c } = await researched(bad);
      const w = await writeForCompany(a, c.id);
      expect(w.status).toBe('ready');
      expect(all(a.db, 'select 1 from linkedin_notes')).toHaveLength(0);
    }
  });

  it('a rewrite replaces them, or removes them when the new ones fail', async () => {
    const { a, c } = await researched();
    await writeForCompany(a, c.id);
    a.model = () => ({ json: async (r: any) => (r.name === 'write' ? write({ ...GOOD_LI, message: 'I emailed you, any thoughts?' })(r) : { unsupported: [] }) }) as any;
    expect((await rewriteEmails(a, 'northwind.com', 'shorter')).rewritten).toBe(true);
    expect(all(a.db, 'select 1 from linkedin_notes')).toHaveLength(0);
  });
});
