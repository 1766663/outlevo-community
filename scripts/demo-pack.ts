// Builds the example sales pack published at https://outlevo.github.io/outlevo-community/ with the real pack renderer.
// Everything in it is made up, and the page says so: the companies are on reserved .example domains. No model, no network.
// Run: node --import tsx scripts/demo-pack.ts
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../src/app.js';
import { DEFAULTS } from '../src/config.js';
import { openPath, run } from '../src/db.js';
import { buildPack } from '../src/pack.js';

const home = mkdtempSync(join(tmpdir(), 'demo-'));
const now = new Date('2026-11-05T12:00:00Z');
const a = { db: openPath(join(home, 'demo.db')), now: () => now, config: structuredClone(DEFAULTS), home, secrets: {} } as unknown as App;
const at = now.toISOString();
run(a.db, 'insert into product (id, url, summary, updated_at) values (1, ?, ?, ?)', 'https://acme-ramp.example', 'Acme Ramp helps B2B sales teams get new reps selling faster, with a ramp plan for each hire.', at);
run(a.db, "insert into icp (id, body, source, updated_at) values (1, ?, 'deals', ?)", JSON.stringify({
  summary: 'B2B software companies of 50 to 300 people that are hiring their first or second sales team.', industries: ['B2B software'], company_size: '50-300', markets: ['United States'],
  buyer_titles: ['Head of Sales', 'VP Sales'], must_have: ['A sales team that is growing'], rule_out: ['Companies selling sales training'], learned_from: 'What 6 won and 4 lost deals have in common.',
}), at);

const companies = [
  { domain: 'northwind.example', name: 'Northwind', score: 86, to: 'Head of Sales', why: 'They are hiring account executives', fact: 'Hiring 4 account executives in Austin', quote: 'We are hiring 4 account executives in Austin', url: 'https://northwind.example/careers',
    emails: [['Austin AE hires', 'Saw you are hiring 4 account executives in Austin. We help new reps find their first accounts faster. Who owns ramp for them?', 'hiring 4 account executives in Austin'], ['Their first 30 days', 'With 4 new hires starting together, who decides which accounts each one gets first? We build that plan per rep. Worth comparing with yours?', null], ['Closing the loop', 'I will leave it here. Good luck with the Austin team.', null]],
    note: 'Saw you are hiring 4 account executives in Austin. I work on how new reps get to their first accounts, and would be glad to connect.', message: 'Thanks for connecting. When the Austin hires start, who decides which accounts each one gets first?' },
  { domain: 'brightpath.example', name: 'Brightpath', score: 78, to: 'VP Sales', why: 'They opened a new region', fact: 'Opened a Denver office for its sales team', quote: 'Our new Denver office is home to our growing sales team', url: 'https://brightpath.example/news',
    emails: [['Your Denver team', 'Read that your new Denver office is home to your growing sales team. We help reps in a new region find their first accounts. Who owns that for Denver?', 'new Denver office is home to your growing sales team'], ['A new region', 'A new office often starts without account history to lean on. How are Denver reps choosing who to call first?', null], ['Closing the loop', 'I will stop here. All the best with Denver.', null]],
    note: 'Read that your new Denver office is home to your growing sales team. Glad to connect.', message: 'Thanks for connecting. How are the Denver reps choosing who to call first?' },
];
companies.forEach((c, i) => {
  const id = Number(run(a.db, "insert into companies (domain, name, source, status, score, reasons, created_at, researched_at) values (?, ?, 'discover', 'qualified', ?, ?, ?, ?)", c.domain, c.name, c.score, '{"reasons":[]}', at, at).lastInsertRowid);
  const fact = Number(run(a.db, "insert into facts (company_id, kind, text, quote, source_url, published_at, fetched_at) values (?, 'hiring', ?, ?, ?, '2026-10-20', ?)", id, c.fact, c.quote, c.url, at).lastInsertRowid);
  run(a.db, 'update companies set reasons = ? where id = ?', JSON.stringify({ reasons: [{ text: c.why, fact_id: fact }] }), id);
  c.emails.forEach(([subject, body, claim], n) => run(a.db, "insert into company_emails (company_id, step, subject, body, claims, angle, delay_days, lint, blocked, to_title, created_at) values (?, ?, ?, ?, ?, 'hiring', ?, '[]', 0, ?, ?)",
    id, n + 1, subject!, body!, JSON.stringify(claim ? [{ text: claim, fact_id: fact }] : []), [0, 3, 5][n]!, c.to, at));
  run(a.db, 'insert into linkedin_notes (company_id, note, message, claims, created_at) values (?, ?, ?, ?, ?)', id, c.note, c.message, JSON.stringify([{ text: c.quote, fact_id: fact }]), at);
  void i;
});

const out = join(home, 'pack');
buildPack(a, out);
const target = join(process.cwd(), 'docs');
rmSync(target, { recursive: true, force: true });
cpSync(out, target, { recursive: true, filter: (f) => !f.endsWith('.outlevo-pack') });
writeFileSync(join(target, '.nojekyll'), '');
const banner = '<p class="box"><strong>An example.</strong> Every company, person and quote on this page is made up. Run <code>outlevo start</code> on your own website to get yours. <a href="https://github.com/Outlevo/outlevo-community">Outlevo Community on GitHub</a>.</p>';
const html = readFileSync(join(target, 'index.html'), 'utf8').replace('<h1>Your sales pack</h1>', `${banner}<h1>Your sales pack</h1>`);
writeFileSync(join(target, 'index.html'), html);
console.log(`Written to ${target}`);
