import { readFileSync } from 'node:fs';
import { type App, arr, nullable, obj, S, UNTRUSTED, untrusted } from './app.js';
import { normalizeDomain, parseCsv } from './csv.js';
import { all, logEvent, one, run } from './db.js';
import { type Page, quoteIsOn } from './fetcher.js';
import { type Claim, hasErrors, type KnownFact, lintEmail } from './lint.js';

const MAX_PAGES = 6; const MAX_PAGE_CHARS = 20_000;
const iso = (a: App) => a.now().toISOString();
const PAGE_WORTH: Array<[RegExp, number]> = [[/about|company|team|leadership/, 5], [/customers?|case-stud|clients/, 5], [/pricing|plans/, 4], [/careers?|jobs|hiring/, 4], [/news|press|blog|changelog|updates/, 3], [/product|platform|solutions?|features/, 2]];

async function readSite(a: App, domain: string, maxPages = MAX_PAGES): Promise<Page[]> {
  const home = (await a.fetchPage(`https://${domain}/`).catch(() => null)) ?? (await a.fetchPage(`https://www.${domain}/`).catch(() => null));
  if (!home) return [];
  const sameSite = (u: string) => { const h = new URL(u).hostname.replace(/^www\./, ''); return h === domain || h.endsWith(`.${domain}`); };
  const score = (u: string) => { const p = new URL(u).pathname.toLowerCase(); return PAGE_WORTH.find(([re]) => re.test(p))?.[1] ?? 0; };
  const picks = home.links.filter((u) => u !== home.url && sameSite(u) && score(u) > 0).sort((x, y) => score(y) - score(x) || x.length - y.length).slice(0, maxPages - 1);
  const rest = await Promise.all(picks.map((u) => a.fetchPage(u).catch(() => null)));
  return [home, ...rest.filter((p): p is Page => !!p && p.text.length > 40)];
}
const pagesFor = (pages: Page[]) => pages.map((p) => untrusted(p.url, p.text.slice(0, MAX_PAGE_CHARS))).join('\n\n');

const FACT = obj({ kind: { type: 'string', enum: ['what_they_do', 'customers', 'hiring', 'funding', 'launch', 'leadership', 'pricing', 'tech', 'other'] }, text: S, quote: S, source_url: S, published_at: nullable('string') });
const QUOTE_RULE = 'Every fact carries a quote: a short sentence copied word for word from the page, and that page\'s exact URL. No quote on the page, no fact. Do not infer, round or embellish.';

export async function learnProduct(a: App, url = a.config.website) {
  const domain = normalizeDomain(url);
  if (!domain) throw new Error('Set your website first: outlevo config set website https://yourcompany.com');
  const pages = await readSite(a, domain);
  if (!pages.length) throw new Error(`Could not read ${domain}: nothing came back, or robots.txt refuses it`);
  const r = await a.model().json<{ summary: string; facts: Array<{ kind: string; text: string; quote: string; source_url: string; published_at: string | null }> }>({
    name: 'learn_product', effort: 'medium',
    system: `You read a company's own website and record what it sells. ${UNTRUSTED} ${QUOTE_RULE}`,
    user: `Summarise what this company sells, to whom and what problem it solves (at most 80 words), then list up to 20 facts a salesperson could rely on.\n\n${pagesFor(pages)}`,
    schema: obj({ summary: S, facts: arr(FACT) }),
  });
  const kept = r.facts.filter((f) => pages.some((p) => p.url === f.source_url && quoteIsOn(f.quote, p.text)));
  run(a.db, 'delete from product_facts');
  for (const f of kept) run(a.db, 'insert into product_facts (text, quote, source_url, fetched_at) values (?, ?, ?, ?)', f.text, f.quote, f.source_url, iso(a));
  run(a.db, 'insert into product (id, url, summary, updated_at) values (1, ?, ?, ?) on conflict (id) do update set url = excluded.url, summary = excluded.summary, updated_at = excluded.updated_at', `https://${domain}`, r.summary, iso(a));
  logEvent(a.db, a.now(), 'product.learned', { domain, facts: kept.length, dropped: r.facts.length - kept.length });
  return { summary: r.summary, facts: kept.length, dropped: r.facts.length - kept.length };
}

export type Icp = { summary: string; industries: string[]; company_size: string; markets: string[]; buyer_titles: string[]; must_have: string[]; rule_out: string[]; learned_from: string };
const ICP_SCHEMA = obj({ summary: S, industries: arr(S), company_size: S, markets: arr(S), buyer_titles: arr(S), must_have: arr(S), rule_out: arr(S), learned_from: S });

const domainsOf = (path?: string) => (path ? parseCsv(readFileSync(path, 'utf8')).map((r) => normalizeDomain(r.domain ?? r.website ?? r.company_domain ?? '')).filter((d): d is string => !!d) : []);

/** From the website alone, or, far better, from the companies you actually won and lost. */
export async function learnIcp(a: App, opts: { won?: string; lost?: string; brief?: string }) {
  const product = one<{ summary: string }>(a.db, 'select summary from product');
  if (!product) throw new Error('Read your product first: outlevo product learn');
  const won = domainsOf(opts.won).slice(0, 15); const lost = domainsOf(opts.lost).slice(0, 15);
  const read = async (domains: string[], label: string) => {
    const pages = await Promise.all(domains.map(async (d) => [d, (await readSite(a, d, 1))[0]] as const));
    return pages.filter(([, p]) => p).map(([d, p]) => untrusted(`${label}: ${d}`, p!.text.slice(0, 3000))).join('\n');
  };
  const icp = await a.model().json<Icp>({
    name: 'learn_icp', effort: 'high',
    system: `You define who a B2B company should sell to. ${UNTRUSTED} Prefer what the won and lost companies show over what the website claims; name in learned_from which it came from. When there are no deals, say so in learned_from.`,
    user: `What we sell: ${product.summary}\n${opts.brief ? `The founder says: ${opts.brief}\n` : ''}\nCompanies we won:\n${await read(won, 'won') || '(none given)'}\n\nCompanies we lost:\n${await read(lost, 'lost') || '(none given)'}\n\nDefine the ideal customer: what the won companies share and the lost ones lack.`,
    schema: ICP_SCHEMA,
  });
  run(a.db, 'insert into icp (id, body, source, updated_at) values (1, ?, ?, ?) on conflict (id) do update set body = excluded.body, source = excluded.source, updated_at = excluded.updated_at', JSON.stringify(icp), won.length || lost.length ? 'deals' : 'website', iso(a));
  logEvent(a.db, a.now(), 'icp.learned', { won: won.length, lost: lost.length });
  return icp;
}
export const getIcp = (a: App) => { const r = one<{ body: string }>(a.db, 'select body from icp'); return r ? (JSON.parse(r.body) as Icp) : null; };

export function addCompany(a: App, input: string, source: string, name?: string): { id: number; domain: string; added: boolean } {
  const domain = normalizeDomain(input);
  if (!domain) throw new Error(`Not a domain: ${input}`);
  const seen = one<{ id: number }>(a.db, 'select id from companies where domain = ?', domain);
  if (seen) return { id: seen.id, domain, added: false };
  const r = run(a.db, 'insert into companies (domain, name, source, created_at) values (?, ?, ?, ?)', domain, name ?? null, source, iso(a));
  return { id: Number(r.lastInsertRowid), domain, added: true };
}

export function importCompanies(a: App, path: string) {
  let added = 0; const skipped: string[] = [];
  for (const row of parseCsv(readFileSync(path, 'utf8'))) {
    const v = row.domain ?? row.website ?? row.company_domain ?? '';
    try { if (addCompany(a, v, 'csv', row.name ?? row.company).added) added++; } catch { skipped.push(v); }
  }
  logEvent(a.db, a.now(), 'companies.imported', { added, skipped: skipped.length });
  return { added, skipped };
}

/** Web search through the model. Every company it names is still read and checked before anything is written. */
export async function discoverCompanies(a: App, count: number, brief?: string) {
  const icp = getIcp(a);
  if (!icp) throw new Error('Define your ICP first: outlevo icp learn');
  const m = a.model();
  if (!m.searchJson) throw new Error('This model provider has no web search. Import a CSV (outlevo companies import) or use outlevo cloud find.');
  const r = await m.searchJson<{ companies: Array<{ name: string; domain: string; why: string }> }>({
    name: 'discover_companies', maxSearches: 5, effort: 'medium',
    system: `You find real companies that fit a brief. ${UNTRUSTED} List only companies you saw on the web, with their own website's domain, never a directory or a list article.`,
    user: `Find ${count} companies for this ICP:\n${JSON.stringify(icp)}\n${brief ? `Also: ${brief}\n` : ''}Leave out: ${all<{ domain: string }>(a.db, 'select domain from companies limit 500').map((c) => c.domain).join(', ') || 'nothing'}.`,
    schema: obj({ companies: arr(obj({ name: S, domain: S, why: S })) }),
  });
  const added: string[] = [];
  for (const c of r.companies.slice(0, count)) { try { const x = addCompany(a, c.domain, 'discover', c.name); if (x.added) added.push(x.domain); } catch { /* the model named something that is no domain */ } }
  logEvent(a.db, a.now(), 'companies.discovered', { added: added.length });
  return { added };
}

type Extract = {
  name: string | null;
  facts: Array<{ kind: string; text: string; quote: string; source_url: string; published_at: string | null }>;
  people: Array<{ first_name: string; last_name: string | null; title: string | null; email: string | null; quote: string; source_url: string }>;
};
type Verdict = { fit: boolean; score: number; reasons: Array<{ text: string; fact_id: number }>; missing: string[] };

export async function researchCompany(a: App, companyId: number) {
  const c = one<{ id: number; domain: string }>(a.db, 'select id, domain from companies where id = ?', companyId);
  if (!c) throw new Error(`No company ${companyId}`);
  const icp = getIcp(a);
  if (!icp) throw new Error('Define your ICP first: outlevo icp learn');
  const fail = (error: string) => { run(a.db, "update companies set status = 'error', error = ?, researched_at = ? where id = ?", error, iso(a), c.id); return { id: c.id, domain: c.domain, status: 'error', error }; };
  const pages = await readSite(a, c.domain);
  if (!pages.length) return fail('The site could not be read, or robots.txt refuses it');

  const x = await a.model().json<Extract>({
    name: 'research', effort: 'medium',
    system: `You research a company from its own website for a salesperson. ${UNTRUSTED} ${QUOTE_RULE} Prefer recent, specific facts (hiring for a role, a launch, a named customer) over generic marketing. List a person only if the page names them with their job; give an email only if it is printed on the page.`,
    user: `Company: ${c.domain}\n\n${pagesFor(pages)}`,
    schema: obj({ name: nullable('string'), facts: arr(FACT), people: arr(obj({ first_name: S, last_name: nullable('string'), title: nullable('string'), email: nullable('string'), quote: S, source_url: S })) }),
  });
  const pageOf = (url: string) => pages.find((p) => p.url === url);
  const facts = x.facts.filter((f) => { const p = pageOf(f.source_url); return p && quoteIsOn(f.quote, p.text); });
  run(a.db, 'delete from facts where company_id = ?', c.id);
  const known: KnownFact[] = facts.map((f) => {
    const r = run(a.db, 'insert into facts (company_id, kind, text, quote, source_url, published_at, fetched_at) values (?, ?, ?, ?, ?, ?, ?)', c.id, f.kind, f.text, f.quote, f.source_url, f.published_at, iso(a));
    return { id: Number(r.lastInsertRowid), text: f.text, quote: f.quote };
  });
  let people = 0;
  for (const p of x.people) {
    const page = pageOf(p.source_url);
    if (!page || !quoteIsOn(p.quote, page.text)) continue;
    if (p.email && page.text.toLowerCase().includes(p.email.toLowerCase())) people += addContact(a, { company_id: c.id, first_name: p.first_name, last_name: p.last_name, title: p.title, email: p.email, email_source: 'published' }) ? 1 : 0;
  }
  if (!known.length) { run(a.db, 'update companies set name = coalesce(?, name) where id = ?', x.name, c.id); return fail('Nothing on the site could be quoted'); }

  const v = await a.model().json<Verdict>({
    name: 'qualify', effort: 'medium',
    system: `You decide whether a company fits an ideal customer profile, only from the facts given. ${UNTRUSTED} Unknown is not a match: name what is missing. Cite fact ids for each reason.`,
    user: `ICP:\n${JSON.stringify(icp)}\n\nFacts about ${c.domain}:\n${untrusted(c.domain, known.map((f) => `[${f.id}] ${f.text} ("${f.quote}")`).join('\n'))}`,
    schema: obj({ fit: { type: 'boolean' }, score: { type: 'integer' }, reasons: arr(obj({ text: S, fact_id: { type: 'integer' } })), missing: arr(S) }),
  });
  const ids = new Set(known.map((f) => f.id));
  const reasons = v.reasons.filter((r) => ids.has(r.fact_id));
  const fit = v.fit && reasons.length > 0;
  const status = fit ? 'qualified' : 'disqualified';
  run(a.db, 'update companies set name = coalesce(?, name), status = ?, score = ?, reasons = ?, error = null, researched_at = ? where id = ?', x.name, status, v.score, JSON.stringify({ reasons, missing: v.missing }), iso(a), c.id);
  logEvent(a.db, a.now(), 'company.researched', { domain: c.domain, status, facts: known.length, dropped: x.facts.length - known.length });
  return { id: c.id, domain: c.domain, status, score: v.score, facts: known.length, people, dropped: x.facts.length - known.length };
}

export type NewContact = { company_id: number; first_name: string; last_name?: string | null; title?: string | null; email: string; email_source: 'imported' | 'published' | 'guess' | 'verified'; cloud_id?: string };
const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
export function addContact(a: App, n: NewContact): boolean {
  const email = n.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return false;
  const r = run(a.db, `insert into contacts (company_id, first_name, last_name, title, email, email_source, cloud_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (email) do nothing`, n.company_id, n.first_name.trim(), n.last_name ?? null, n.title ?? null, email, n.email_source, n.cloud_id ?? null, iso(a));
  return Number(r.changes) > 0;
}

export function importContacts(a: App, path: string) {
  let added = 0; const skipped: string[] = [];
  for (const row of parseCsv(readFileSync(path, 'utf8'))) {
    const email = row.email ?? ''; const domain = row.domain ?? row.website ?? row.company_domain ?? email.split('@')[1] ?? '';
    const first = row.first_name ?? row.firstname ?? (row.name ?? '').split(' ')[0] ?? '';
    if (!first || !EMAIL.test(email)) { skipped.push(email || JSON.stringify(row)); continue; }
    try {
      const c = addCompany(a, domain, 'csv', row.company);
      if (addContact(a, { company_id: c.id, first_name: first, last_name: row.last_name ?? row.lastname ?? ((row.name ?? '').split(' ').slice(1).join(' ') || null), title: row.title ?? row.job_title, email, email_source: 'imported' })) added++;
    } catch { skipped.push(email); }
  }
  logEvent(a.db, a.now(), 'contacts.imported', { added, skipped: skipped.length });
  return { added, skipped };
}

type Written = { angle: string; emails: Array<{ subject: string; body: string; delay_days: number; claims: Claim[] }> };

function lintSequence(a: App, seq: Written, facts: KnownFact[], domain: string) {
  const productFacts = all<{ text: string; quote: string }>(a.db, 'select text, quote from product_facts');
  const own = (one<{ url: string }>(a.db, 'select url from product')?.url ?? '').replace(/^https?:\/\//, '');
  return seq.emails.map((e, i) => lintEmail({ subject: e.subject, body: e.body, step: i + 1, claims: e.claims, facts, productFacts, allowedLinkDomains: [own, domain].filter(Boolean) }));
}

/** Three emails for one person. Rejected by the rules, it gets one more try; then it is kept as blocked, with the reasons, and cannot be approved. */
export async function writeSequence(a: App, contactId: number) {
  const row = one<{ id: number; first_name: string; last_name: string | null; title: string | null; company_id: number; domain: string; name: string | null; status: string }>(a.db,
    `select p.id, p.first_name, p.last_name, p.title, c.id as company_id, c.domain, c.name, c.status from contacts p join companies c on c.id = p.company_id where p.id = ?`, contactId);
  if (!row) throw new Error(`No contact ${contactId}`);
  if (row.status !== 'qualified') throw new Error(`${row.domain} is ${row.status}; only qualified companies get emails`);
  const product = one<{ summary: string }>(a.db, 'select summary from product');
  const productFacts = all<{ text: string; quote: string }>(a.db, 'select text, quote from product_facts');
  const facts = all<KnownFact & { kind: string; source_url: string }>(a.db, 'select id, kind, text, quote, source_url from facts where company_id = ?', row.company_id);
  if (!product || !facts.length) throw new Error('Nothing to write from: read the product and research the company first');

  const ask = (feedback: string) => a.model().json<Written>({
    name: 'write', effort: 'high',
    system: `You write short cold email for a founder, in plain ${a.config.language === 'en-GB' ? 'British' : 'American'} English. ${UNTRUSTED}
First email: under 90 words, opens on one specific fact about this company, says what we do in one line, asks one easy question. No meeting request. Follow-ups: under 60 words, each adds something new, the last one closes the loop politely.
Only state what the facts say. Each statement about the prospect is a claim: copy its exact words from the email into claims.text and cite its fact_id. No number may appear unless it is in a fact you cite or in a fact about our product. No links. No greeting formula, no flattery, no fake familiarity, no footer (it is added on sending). Write the final text: no placeholders.`,
    user: `We sell: ${product.summary}\nFacts about us:\n${productFacts.map((f) => `- ${f.text}`).join('\n')}\nFrom: ${a.config.sender.name}, ${a.config.sender.company}\n\nTo: ${row.first_name} ${row.last_name ?? ''}, ${row.title ?? 'job unknown'}, at ${row.name ?? row.domain}\nFacts about them:\n${untrusted(row.domain, facts.map((f) => `[${f.id}] (${f.kind}) ${f.text}`).join('\n'))}\n\nWrite 3 emails. delay_days is 0 for the first, then days since the one before.${feedback}`,
    schema: obj({ angle: S, emails: arr(obj({ subject: S, body: S, delay_days: { type: 'integer' }, claims: arr(obj({ text: S, fact_id: { type: 'integer' } })) })) }),
  });

  let seq = await ask(''); let issues = lintSequence(a, seq, facts, row.domain);
  if (issues.some(hasErrors)) {
    const list = issues.flatMap((x, i) => x.filter((y) => y.level === 'error').map((y) => `Email ${i + 1}: ${y.message}`)).join('\n');
    seq = await ask(`\n\nYour last try was refused:\n${list}\nFix every one of these.`);
    issues = lintSequence(a, seq, facts, row.domain);
  }
  const emails = seq.emails.slice(0, 3); const blocked = issues.slice(0, 3).some(hasErrors);
  a.db.exec('begin');
  try {
    run(a.db, "delete from drafts where contact_id = ? and status in ('pending','blocked','rejected')", contactId);
    emails.forEach((e, i) => run(a.db, `insert into drafts (contact_id, step, subject, body, claims, angle, delay_days, lint, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      contactId, i + 1, e.subject, e.body, JSON.stringify(e.claims), seq.angle, Math.max(i === 0 ? 0 : 2, e.delay_days), JSON.stringify(issues[i] ?? []), blocked ? 'blocked' : 'pending', iso(a)));
    a.db.exec('commit');
  } catch (e) { a.db.exec('rollback'); throw e; }
  logEvent(a.db, a.now(), 'sequence.written', { contact_id: contactId, blocked });
  return { contact_id: contactId, status: blocked ? 'blocked' : 'pending', issues: issues.flat().filter((x) => x.level === 'error') };
}

/** The person to write to next: emails we may send to, at qualified companies, one per company, not yet written. */
export function nextToWrite(a: App, limit: number) {
  return all<{ id: number }>(a.db, `select min(p.id) as id from contacts p join companies c on c.id = p.company_id
    where c.status = 'qualified' and p.status = 'active' and p.email_source in ('imported','published','verified')
      and not exists (select 1 from drafts d join contacts q on q.id = d.contact_id where q.company_id = c.id)
    group by c.id order by coalesce(c.score, 0) desc limit ?`, limit).map((r) => r.id);
}

export function reviewQueue(a: App) {
  const drafts = all<any>(a.db, `select d.*, p.first_name, p.last_name, p.title, p.email, p.email_source, c.domain, c.name as company, c.id as company_id, c.score
    from drafts d join contacts p on p.id = d.contact_id join companies c on c.id = p.company_id
    where d.status in ('pending','blocked') order by d.contact_id, d.step`);
  const byContact = new Map<number, any>();
  for (const d of drafts) {
    const g = byContact.get(d.contact_id) ?? { contact_id: d.contact_id, name: `${d.first_name} ${d.last_name ?? ''}`.trim(), title: d.title, email: d.email, email_source: d.email_source, domain: d.domain, company: d.company, score: d.score, status: d.status, angle: d.angle, emails: [], company_id: d.company_id };
    const claims: Claim[] = JSON.parse(d.claims);
    g.emails.push({ step: d.step, subject: d.subject, body: d.body, delay_days: d.delay_days, issues: JSON.parse(d.lint),
      claims: claims.map((c) => ({ ...c, source: one(a.db, 'select quote, source_url, fetched_at from facts where id = ?', c.fact_id) ?? null })) });
    byContact.set(d.contact_id, g);
  }
  return [...byContact.values()];
}

export function approve(a: App, contactId: number) {
  const n = run(a.db, "update drafts set status = 'approved', approved_at = ? where contact_id = ? and status = 'pending'", iso(a), contactId).changes;
  if (!n) {
    const blocked = one(a.db, "select 1 from drafts where contact_id = ? and status = 'blocked'", contactId);
    throw new Error(blocked ? 'These emails failed the checks and cannot be approved. Write them again: outlevo write --contact ' + contactId : `Nothing waits for approval for contact ${contactId}`);
  }
  logEvent(a.db, a.now(), 'sequence.approved', { contact_id: contactId, emails: Number(n) });
  return { approved: Number(n) };
}

export function reject(a: App, contactId: number) {
  const n = run(a.db, "update drafts set status = 'rejected' where contact_id = ? and status in ('pending','blocked')", contactId).changes;
  logEvent(a.db, a.now(), 'sequence.rejected', { contact_id: contactId });
  return { rejected: Number(n) };
}
