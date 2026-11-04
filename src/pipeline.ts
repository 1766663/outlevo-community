import { readFileSync } from 'node:fs';
import { type App, arr, nullable, obj, S, UNTRUSTED, untrusted } from './app.js';
import { normalizeDomain, parseCsv } from './csv.js';
import { all, logEvent, one, run } from './db.js';
import { type Page, quoteIsOn } from './fetcher.js';
import { isSuppressed } from './compliance.js';
import { type Claim, hasErrors, type KnownFact, lintEmail, type LintIssue } from './lint.js';

const MAX_PAGES = 6; const MAX_PAGE_CHARS = 20_000; const WRITE_TRIES = 3;
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

const FREE_MAIL = new Set(['gmail.com', 'googlemail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'live.com', 'aol.com', 'icloud.com', 'proton.me', 'protonmail.com', 'gmx.com', 'mail.com']);
/** The deals worth reading from a file, and what was left out of it and why. */
function dealsIn(a: App, path?: string) {
  const domains = new Set<string>(); const skipped: Array<{ row: string; reason: string }> = [];
  (path ? parseCsv(readFileSync(path, 'utf8')) : []).forEach((r, i) => {
    const raw = r.domain ?? r.website ?? r.company_domain ?? ''; const d = normalizeDomain(raw);
    const label = raw.slice(0, 80) || `row ${i + 2}`;
    if (!d) skipped.push({ row: label, reason: 'not a domain' });
    else if (FREE_MAIL.has(d)) skipped.push({ row: label, reason: 'a personal email service, not a company' });
    else if (isOwnDomain(a, d)) skipped.push({ row: label, reason: 'your own company' });
    else if (domains.has(d)) skipped.push({ row: label, reason: 'listed twice' });
    else domains.add(d);
  });
  return { domains: [...domains], skipped };
}

/** From the website alone, or, far better, from the companies you actually won and lost. */
export async function learnIcp(a: App, opts: { won?: string; lost?: string; brief?: string }) {
  const product = one<{ summary: string }>(a.db, 'select summary from product');
  if (!product) throw new Error('Read your product first: outlevo product learn');
  const wonIn = dealsIn(a, opts.won); const lostIn = dealsIn(a, opts.lost);
  const won = wonIn.domains.slice(0, 15); const lost = lostIn.domains.slice(0, 15);
  const beyond = (d: string[]) => d.slice(15).map((x) => ({ row: x, reason: 'only the first 15 are read' }));
  const skipped = [...wonIn.skipped, ...lostIn.skipped, ...beyond(wonIn.domains), ...beyond(lostIn.domains)];
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
  return { ...icp, deals_read: { won, lost, skipped } };
}
export const getIcp = (a: App) => { const r = one<{ body: string }>(a.db, 'select body from icp'); return r ? (JSON.parse(r.body) as Icp) : null; };

export class OwnCompany extends Error {}
const isOwnDomain = (a: App, domain: string) => {
  const own = [a.config.website, one<{ url: string }>(a.db, 'select url from product')?.url ?? '', a.config.sender.email.split('@')[1] ?? ''].map((x) => normalizeDomain(x)).filter(Boolean) as string[];
  return own.some((d) => domain === d || domain.endsWith(`.${d}`));
};

export function addCompany(a: App, input: string, source: string, name?: string): { id: number; domain: string; added: boolean } {
  const domain = normalizeDomain(input);
  if (!domain) throw new Error(`Not a domain: ${input}`);
  if (isOwnDomain(a, domain)) throw new OwnCompany(`${domain} is your own company`);
  const seen = one<{ id: number }>(a.db, 'select id from companies where domain = ?', domain);
  if (seen) return { id: seen.id, domain, added: false };
  const r = run(a.db, 'insert into companies (domain, name, source, created_at) values (?, ?, ?, ?)', domain, name ?? null, source, iso(a));
  return { id: Number(r.lastInsertRowid), domain, added: true };
}

export function importCompanies(a: App, path: string) {
  let added = 0; let duplicates = 0; const skipped: Array<{ row: string; reason: string }> = [];
  for (const row of parseCsv(readFileSync(path, 'utf8'))) {
    const v = row.domain ?? row.website ?? row.company_domain ?? '';
    if (!v) { skipped.push({ row: JSON.stringify(row).slice(0, 80), reason: 'no domain column or value' }); continue; }
    try { if (addCompany(a, v, 'csv', row.name ?? row.company).added) added++; else duplicates++; }
    catch (e) { skipped.push({ row: v.slice(0, 80), reason: e instanceof OwnCompany ? 'your own company' : 'not a domain' }); }
  }
  logEvent(a.db, a.now(), 'companies.imported', { added, duplicates, skipped: skipped.length });
  return { added, duplicates, skipped };
}

/** Web search through the model. Every company it names is still read and checked before anything is written. */
export async function discoverCompanies(a: App, count: number, brief?: string) {
  const icp = getIcp(a);
  if (!icp) throw new Error('Define your ICP first: outlevo icp learn');
  const m = a.model();
  if (!m.searchJson) throw new Error('This model provider has no web search. Import a CSV (outlevo companies import) or use outlevo cloud find.');
  // As many as were asked for: search in rounds until there are enough or a round finds nothing new.
  const added: string[] = [];
  while (added.length < count) {
    const want = Math.min(count - added.length, 25);
    const r = await m.searchJson<{ companies: Array<{ name: string; domain: string; why: string }> }>({
      name: 'discover_companies', maxSearches: 5, effort: 'medium',
      system: `You find real companies that fit a brief. ${UNTRUSTED} List only companies you saw on the web, with their own website's domain, never a directory or a list article.`,
      user: `Find ${want} companies for this ICP:\n${JSON.stringify(icp)}\n${brief ? `Also: ${brief}\n` : ''}Leave out: ${[normalizeDomain(a.config.website), ...all<{ domain: string }>(a.db, 'select domain from companies order by id desc limit 500').map((c) => c.domain)].filter(Boolean).join(', ')}.`,
      schema: obj({ companies: arr(obj({ name: S, domain: S, why: S })) }),
    });
    const before = added.length;
    for (const c of r.companies) {
      if (added.length >= count) break;
      try { const x = addCompany(a, c.domain, 'discover', c.name); if (x.added) added.push(x.domain); } catch { /* your own company, or the model named something that is no domain */ }
    }
    if (added.length === before) break;
  }
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
  run(a.db, 'delete from company_emails where company_id = ?', c.id);
  run(a.db, 'delete from facts where company_id = ?', c.id);
  const known: KnownFact[] = facts.map((f) => {
    const r = run(a.db, 'insert into facts (company_id, kind, text, quote, source_url, published_at, fetched_at) values (?, ?, ?, ?, ?, ?, ?)', c.id, f.kind, f.text, f.quote, f.source_url, f.published_at, iso(a));
    return { id: Number(r.lastInsertRowid), text: f.text, quote: f.quote };
  });
  let people = 0;
  for (const p of x.people) {
    const page = pageOf(p.source_url);
    if (!page || !quoteIsOn(p.quote, page.text)) continue;
    // Printed on the page as this exact address, on this company's own domain.
    const printed = new Set((page.text.match(/[a-z0-9._%+-]+@[a-z0-9-]+(?:\.[a-z0-9-]+)+/gi) ?? []).map((x) => x.toLowerCase()));
    const mail = p.email?.trim().toLowerCase() ?? ''; const host = mail.split('@')[1] ?? '';
    if (p.email && printed.has(mail) && (host === c.domain || host.endsWith(`.${c.domain}`))) people += addContact(a, { company_id: c.id, first_name: p.first_name, last_name: p.last_name, title: p.title, email: p.email, email_source: 'published' }) ? 1 : 0;
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
const EMAIL = /^[a-z0-9._%+'-]+@[a-z0-9-]+(\.[a-z0-9-]+)+$/i;
const PERSONAL = /@(gmail|googlemail|yahoo|ymail|hotmail|outlook|live|msn|aol|icloud|me|mac|proton|protonmail|gmx|mail|yandex|zoho)\.[a-z.]+$/i;
export function addContact(a: App, n: NewContact): boolean {
  const email = n.email.trim().toLowerCase();
  if (!EMAIL.test(email)) return false;
  const r = run(a.db, `insert into contacts (company_id, first_name, last_name, title, email, email_source, cloud_id, created_at) values (?, ?, ?, ?, ?, ?, ?, ?)
    on conflict (email) do nothing`, n.company_id, n.first_name.trim(), n.last_name ?? null, n.title ?? null, email, n.email_source, n.cloud_id ?? null, iso(a));
  return Number(r.changes) > 0;
}

export function importContacts(a: App, path: string) {
  let added = 0; let duplicates = 0; const newCompanies: string[] = []; const skipped: Array<{ row: string; reason: string }> = [];
  for (const row of parseCsv(readFileSync(path, 'utf8'))) {
    const email = (row.email ?? row.email_address ?? '').trim(); const domain = row.domain ?? row.website ?? row.company_domain ?? email.split('@')[1] ?? '';
    const first = row.first_name ?? row.firstname ?? (row.name ?? '').split(' ')[0] ?? '';
    const label = (email || [first, row.last_name ?? row.lastname, row.company ?? domain].filter(Boolean).join(' ') || 'a blank row').slice(0, 80);
    if (!email) { skipped.push({ row: label, reason: 'no email' }); continue; }
    if (!EMAIL.test(email)) { skipped.push({ row: label, reason: 'not a single valid email address' }); continue; }
    if (PERSONAL.test(email)) { skipped.push({ row: label, reason: 'a personal address, not a work one' }); continue; }
    if (!first) { skipped.push({ row: label, reason: 'no first name' }); continue; }
    try {
      const c = addCompany(a, domain, 'csv', row.company);
      if (c.added) newCompanies.push(c.domain);
      if (addContact(a, { company_id: c.id, first_name: first, last_name: row.last_name ?? row.lastname ?? ((row.name ?? '').split(' ').slice(1).join(' ') || null), title: row.title ?? row.job_title, email, email_source: 'imported' })) added++;
      else duplicates++;
    } catch (e) { skipped.push({ row: label, reason: e instanceof OwnCompany ? 'your own company' : `no usable company domain (${domain})` }); }
  }
  logEvent(a.db, a.now(), 'contacts.imported', { added, duplicates, new_companies: newCompanies.length, skipped: skipped.length });
  return { added, duplicates, new_companies: newCompanies, skipped };
}

type Written = { angle: string; emails: Array<{ subject: string; body: string; delay_days: number; claims: Claim[] }> };

function lintSequence(a: App, seq: Written, facts: KnownFact[], domain: string) {
  const productFacts = all<{ text: string; quote: string }>(a.db, 'select text, quote from product_facts');
  const own = (one<{ url: string }>(a.db, 'select url from product')?.url ?? '').replace(/^https?:\/\//, '');
  return seq.emails.map((e, i) => lintEmail({ subject: e.subject, body: e.body, step: i + 1, claims: e.claims, facts, productFacts, allowedLinkDomains: [own, domain].filter(Boolean) }));
}

type Recipient = { domain: string; company: string | null; company_id: number; to: string; change?: { instruction: string; emails: Array<{ subject: string; body: string }> } };

/** Three emails, by a model, then the rules, then a second reading. Refused, it tries again. Returned with its reasons either way. */
async function compose(a: App, r: Recipient) {
  const product = one<{ summary: string }>(a.db, 'select summary from product');
  const productFacts = all<{ text: string; quote: string }>(a.db, 'select text, quote from product_facts');
  const facts = all<KnownFact & { kind: string; source_url: string }>(a.db, 'select id, kind, text, quote, source_url from facts where company_id = ?', r.company_id);
  if (!product || !facts.length) throw new Error('Nothing to write from: read the product and research the company first');

  const ask = (feedback: string) => a.model().json<Written>({
    name: 'write', effort: 'high',
    system: `You write short cold email for a founder, in plain ${a.config.language === 'en-GB' ? 'British' : 'American'} English. ${UNTRUSTED}
First email: under 90 words, opens on one specific fact about this company, says what we do in one line, asks one easy question. No meeting request. Follow-ups: under 60 words, each adds something new, the last one closes the loop politely.
Only state what the quotes say: a fact's summary can go further than its quote, and the quote is what your email is checked against. Each statement about the prospect is a claim: copy its exact words from the email into claims.text and cite its fact_id. No number may appear unless it is in a fact you cite or in a fact about our product. No links. No greeting and no name of the recipient, no flattery, no fake familiarity, no footer (it is added on sending). Write the final text: no placeholders.`,
    user: `We sell: ${product.summary}\nFacts about us:\n${productFacts.map((f) => `- ${f.text}`).join('\n')}\nFrom: ${a.config.sender.name || 'the founder'}${a.config.sender.company ? `, ${a.config.sender.company}` : ''}\n\nTo: ${r.to}, at ${r.company ?? r.domain}\nFacts about them:\n${untrusted(r.domain, facts.map((f) => `[${f.id}] (${f.kind}) ${f.text}\n  Quote: ${f.quote}`).join('\n'))}\n\nWrite 3 emails. delay_days is 0 for the first, then days since the one before.${r.change ? `\n\nThe emails as they stand:\n${r.change.emails.map((e, i) => `Email ${i + 1}. Subject: ${e.subject}\n${e.body}`).join('\n\n')}\n\nThe founder asks you to change them: ${r.change.instruction}\nChange what was asked and keep the rest. Everything above about facts and claims still holds, whatever the request.` : ''}${feedback}`,
    schema: obj({ angle: S, emails: arr(obj({ subject: S, body: S, delay_days: { type: 'integer' }, claims: arr(obj({ text: S, fact_id: { type: 'integer' } })) })) }),
  });
  // The rules catch what was declared. A second reading catches what was not: anything said about them that no quote supports.
  const reread = async (emails: Array<{ n: number; subject: string; body: string }>) => {
    const v = await a.model().json<{ unsupported: Array<{ email: number; statement: string }> }>({
      name: 'verify_email', effort: 'medium',
      system: `You check cold emails against quotes from a company's own website. ${UNTRUSTED} List every statement about the recipient or their company that the quotes do not plainly support, including anything hinted at. A question, or a statement about the sender, is not one. If all is supported, the list is empty.`,
      user: `Quotes:\n${untrusted(r.domain, facts.map((f) => `- ${f.quote}`).join('\n'))}\n\nEmails:\n${emails.map((e) => `Email ${e.n}. Subject: ${e.subject}\n${e.body}`).join('\n\n')}`,
      schema: obj({ unsupported: arr(obj({ email: { type: 'integer' }, statement: S })) }),
    });
    // No clear verdict is not a pass.
    if (!Array.isArray(v?.unsupported)) throw new Error(`The second check of the emails to ${r.domain} gave no clear answer`);
    return v.unsupported;
  };
  const checked = async (seq: Written, settled: boolean[]) => {
    const out = lintSequence(a, seq, facts, r.domain);
    const toRead = seq.emails.map((e, i) => ({ n: i + 1, subject: e.subject, body: e.body })).filter((e) => !settled[e.n - 1] && !hasErrors(out[e.n - 1]!));
    if (!toRead.length) return out;
    for (const u of await reread(toRead)) {
      // A verdict naming an email it was not shown still counts, against all it was shown.
      const hit = toRead.some((e) => e.n === u.email) ? [u.email] : toRead.map((e) => e.n);
      for (const n of hit) out[n - 1]!.push({ level: 'error', rule: 'unsupported-statement', message: `"${u.statement}" is not supported by any quote` });
    }
    return out;
  };
  // An email that passed is kept, so a refused follow-up costs that follow-up and not the company. Without a first email there is nothing.
  const passed: Array<{ email: Written['emails'][number]; issues: LintIssue[] } | undefined> = [];
  let seq!: Written; let issues: LintIssue[][] = []; let feedback = '';
  for (let tries = 0; tries < WRITE_TRIES; tries++) {
    seq = await ask(feedback);
    seq = { ...seq, emails: seq.emails.slice(0, 3) };
    issues = await checked(seq, seq.emails.map((_, i) => !!passed[i]));
    seq.emails.forEach((email, i) => { if (!passed[i] && !hasErrors(issues[i]!)) passed[i] = { email, issues: issues[i]! }; });
    if (seq.emails.every((_, i) => passed[i])) break;
    const kept = passed.flatMap((p, i) => p ? [`Email ${i + 1}. Subject: ${p.email.subject}\n${p.email.body}`] : []);
    const refused = issues.flatMap((x, i) => passed[i] ? [] : x.filter((y) => y.level === 'error').map((y) => `Email ${i + 1}: ${y.message}`));
    feedback = `\n\nYour last try was refused:\n${refused.join('\n')}\nFix every one of these, and say nothing the quotes do not say.${kept.length ? `\nThese passed. Return them word for word:\n${kept.join('\n\n')}` : ''}`;
  }
  if (!passed[0]) return { seq, emails: seq.emails, issues, blocked: true };
  const good = passed.filter((p) => !!p);
  return { seq, emails: good.map((p) => p.email), issues: good.map((p) => p.issues), blocked: false };
}
const delayOf = (i: number, days: number) => Math.max(i === 0 ? 0 : 2, days);

/** Emails for a company with nobody to address yet: the pack is whole without a contact, and an address is only needed to send. */
export async function writeForCompany(a: App, companyId: number) {
  const c = one<{ id: number; domain: string; name: string | null; status: string }>(a.db, 'select id, domain, name, status from companies where id = ?', companyId);
  if (!c) throw new Error(`No company ${companyId}`);
  if (c.status !== 'qualified') throw new Error(`${c.domain} is ${c.status}; only qualified companies get emails`);
  const title = getIcp(a)?.buyer_titles[0] ?? 'the person who owns this problem';
  const w = await compose(a, { domain: c.domain, company: c.name, company_id: c.id, to: title });
  a.db.exec('begin');
  try {
    run(a.db, 'delete from company_emails where company_id = ?', c.id);
    w.emails.forEach((e, i) => run(a.db, 'insert into company_emails (company_id, step, subject, body, claims, angle, delay_days, lint, blocked, to_title, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
      c.id, i + 1, e.subject, e.body, JSON.stringify(e.claims), w.seq.angle, delayOf(i, e.delay_days), JSON.stringify(w.issues[i] ?? []), w.blocked ? 1 : 0, title, iso(a)));
    a.db.exec('commit');
  } catch (e) { a.db.exec('rollback'); throw e; }
  logEvent(a.db, a.now(), 'company.written', { company_id: c.id, blocked: w.blocked });
  return { company_id: c.id, domain: c.domain, status: w.blocked ? 'blocked' : 'ready', issues: w.issues.flat().filter((x) => x.level === 'error') };
}

/** Three emails for one person, waiting for review. Rejected by the checks, they are kept as blocked, with the reasons, and cannot be approved. */
export async function writeSequence(a: App, contactId: number) {
  const row = one<{ id: number; first_name: string; last_name: string | null; title: string | null; company_id: number; domain: string; name: string | null; status: string }>(a.db,
    `select p.id, p.first_name, p.last_name, p.title, c.id as company_id, c.domain, c.name, c.status from contacts p join companies c on c.id = p.company_id where p.id = ?`, contactId);
  if (!row) throw new Error(`No contact ${contactId}`);
  if (row.status !== 'qualified') throw new Error(`${row.domain} is ${row.status}; only qualified companies get emails`);
  if (one(a.db, "select 1 from drafts where contact_id = ? and status in ('approved','sent','cancelled')", contactId)) throw new Error(`The emails to contact ${contactId} were already approved, sent or stopped, so they are not written again. To change unsent ones: outlevo rewrite ${row.domain} "what to change"`);

  // Emails already written for this company carry no name, so they fit whoever turns up: no second bill.
  const ready = all<{ step: number; subject: string; body: string; claims: string; angle: string | null; delay_days: number; lint: string }>(a.db, 'select step, subject, body, claims, angle, delay_days, lint from company_emails where company_id = ? and blocked = 0 order by step', row.company_id);
  let rows: Array<{ step: number; subject: string; body: string; claims: string; angle: string | null; delay_days: number; lint: string }>; let blocked = false; let errors: LintIssue[] = [];
  if (ready.length) rows = ready;
  else {
    const w = await compose(a, { domain: row.domain, company: row.name, company_id: row.company_id, to: `${row.first_name} ${row.last_name ?? ''}, ${row.title ?? 'job unknown'}` });
    rows = w.emails.map((e, i) => ({ step: i + 1, subject: e.subject, body: e.body, claims: JSON.stringify(e.claims), angle: w.seq.angle, delay_days: delayOf(i, e.delay_days), lint: JSON.stringify(w.issues[i] ?? []) }));
    blocked = w.blocked; errors = w.issues.flat().filter((x) => x.level === 'error');
  }
  a.db.exec('begin');
  try {
    run(a.db, "delete from drafts where contact_id = ? and status in ('pending','blocked','rejected')", contactId);
    for (const e of rows) run(a.db, `insert into drafts (contact_id, step, subject, body, claims, angle, delay_days, lint, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      contactId, e.step, e.subject, e.body, e.claims, e.angle, e.delay_days, e.lint, blocked ? 'blocked' : 'pending', iso(a));
    a.db.exec('commit');
  } catch (e) { a.db.exec('rollback'); throw e; }
  logEvent(a.db, a.now(), 'sequence.written', { contact_id: contactId, blocked, reused: ready.length > 0 });
  return { contact_id: contactId, domain: row.domain, status: blocked ? 'blocked' : 'pending', issues: errors };
}

const companyByRef = (a: App, ref: string) => {
  const d = normalizeDomain(ref);
  const c = one<{ id: number; domain: string; name: string | null; status: string }>(a.db, 'select id, domain, name, status from companies where domain = ? or id = ?', d ?? '', /^\d+$/.test(ref) ? Number(ref) : -1);
  if (!c) throw new Error(`No company ${ref}. See: outlevo companies list`);
  return c;
};

/**
 * Rewrites a company's emails as asked. The new ones go through every check the first ones did, and if they fail,
 * the old ones stay. Approved emails go back to waiting for approval: what was approved is no longer what would go out.
 */
export async function rewriteEmails(a: App, ref: string, instruction: string) {
  const c = companyByRef(a, ref);
  if (c.status !== 'qualified') throw new Error(`${c.domain} is ${c.status}; only qualified companies have emails`);
  if (one(a.db, "select 1 from drafts d join contacts p on p.id = d.contact_id where p.company_id = ? and d.status = 'sent'", c.id)) throw new Error(`Emails to ${c.domain} have already started, so they can no longer be rewritten`);
  const draft = all<{ contact_id: number; subject: string; body: string; status: string }>(a.db, "select d.contact_id, d.subject, d.body, d.status from drafts d join contacts p on p.id = d.contact_id where p.company_id = ? and d.status in ('pending','approved','blocked') order by d.step", c.id);
  const own = all<{ subject: string; body: string; to_title: string | null }>(a.db, 'select subject, body, to_title from company_emails where company_id = ? order by step', c.id);
  const emails = draft.length ? draft : own;
  if (!emails.length) throw new Error(`${c.domain} has no emails yet. Run: outlevo start, or outlevo write`);
  const person = draft[0] ? one<{ first_name: string; last_name: string | null; title: string | null }>(a.db, 'select first_name, last_name, title from contacts where id = ?', draft[0].contact_id) : null;
  const to = person ? `${person.first_name} ${person.last_name ?? ''}, ${person.title ?? 'job unknown'}` : own[0]?.to_title ?? getIcp(a)?.buyer_titles[0] ?? 'the person who owns this problem';
  const w = await compose(a, { domain: c.domain, company: c.name, company_id: c.id, to, change: { instruction, emails } });
  const errors = w.issues.flat().filter((x) => x.level === 'error');
  if (w.blocked) { logEvent(a.db, a.now(), 'emails.rewrite_refused', { company_id: c.id }); return { domain: c.domain, rewritten: false, approval_reset: false, issues: errors, emails: [] as typeof w.emails }; }
  a.db.exec('begin');
  try {
    if (draft[0]) {
      run(a.db, "delete from drafts where contact_id = ? and status in ('pending','approved','blocked')", draft[0].contact_id);
      w.emails.forEach((e, i) => run(a.db, `insert into drafts (contact_id, step, subject, body, claims, angle, delay_days, lint, status, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`, draft[0]!.contact_id, i + 1, e.subject, e.body, JSON.stringify(e.claims), w.seq.angle, delayOf(i, e.delay_days), JSON.stringify(w.issues[i] ?? []), iso(a)));
    }
    if (own.length) {
      run(a.db, 'delete from company_emails where company_id = ?', c.id);
      w.emails.forEach((e, i) => run(a.db, 'insert into company_emails (company_id, step, subject, body, claims, angle, delay_days, lint, blocked, to_title, created_at) values (?, ?, ?, ?, ?, ?, ?, ?, 0, ?, ?)', c.id, i + 1, e.subject, e.body, JSON.stringify(e.claims), w.seq.angle, delayOf(i, e.delay_days), JSON.stringify(w.issues[i] ?? []), own[0]?.to_title ?? null, iso(a)));
    }
    a.db.exec('commit');
  } catch (e) { a.db.exec('rollback'); throw e; }
  logEvent(a.db, a.now(), 'emails.rewritten', { company_id: c.id });
  return { domain: c.domain, rewritten: true, approval_reset: draft.some((d) => d.status === 'approved'), issues: [] as LintIssue[], emails: w.emails };
}

/** Takes a company out of the pack and the queue. It stays known, so a later search does not bring it back. */
export function dropCompany(a: App, ref: string, undo = false) {
  const c = companyByRef(a, ref);
  if (undo) {
    if (c.status !== 'dropped') throw new Error(`${c.domain} is not dropped`);
    run(a.db, "update companies set status = 'qualified' where id = ?", c.id);
    // Only what the drop stopped comes back, and it waits for a person again. Whoever answered, bounced or opted out meanwhile stays stopped.
    const held = all<{ id: number; was: string; email: string }>(a.db, `select d.id, h.was, p.email from dropped_drafts h join drafts d on d.id = h.draft_id join contacts p on p.id = d.contact_id
      where p.company_id = ? and p.status = 'active' and not exists (select 1 from replies r where r.contact_id = p.id)
        and not exists (select 1 from meetings m join contacts q on q.id = m.contact_id where q.company_id = p.company_id and m.status = 'booked')`, c.id);
    const back = held.filter((d) => !isSuppressed(a, d.email));
    for (const d of back) run(a.db, 'update drafts set status = ? where id = ?', d.was === 'blocked' ? 'blocked' : 'pending', d.id);
    run(a.db, 'delete from dropped_drafts where draft_id in (select d.id from drafts d join contacts p on p.id = d.contact_id where p.company_id = ?)', c.id);
    logEvent(a.db, a.now(), 'company.restored', { company_id: c.id });
    return { domain: c.domain, status: 'qualified', restored: back.length };
  }
  run(a.db, "update companies set status = 'dropped' where id = ?", c.id);
  run(a.db, "insert or replace into dropped_drafts (draft_id, was) select id, status from drafts where status in ('pending','approved','blocked') and contact_id in (select id from contacts where company_id = ?)", c.id);
  run(a.db, "update drafts set status = 'cancelled' where status in ('pending','approved','blocked') and contact_id in (select id from contacts where company_id = ?)", c.id);
  logEvent(a.db, a.now(), 'company.dropped', { company_id: c.id });
  return { domain: c.domain, status: 'dropped', restored: 0 };
}

/** Qualified companies with no emails yet and nobody to write to. */
export const companiesToWrite = (a: App, limit: number) => all<{ id: number }>(a.db, `select c.id from companies c where c.status = 'qualified'
  and not exists (select 1 from company_emails e where e.company_id = c.id)
  and not exists (select 1 from drafts d join contacts p on p.id = d.contact_id where p.company_id = c.id)
  and not exists (select 1 from contacts p where p.company_id = c.id and p.status = 'active' and p.email_source in ('imported','published','verified'))
  order by coalesce(c.score, 0) desc limit ?`, limit).map((r) => r.id);

const words = (s: string) => new Set(s.toLowerCase().split(/[^a-z]+/).filter((w) => w.length > 1 && !['of', 'the', 'and', 'for'].includes(w)));
/** How close a job title is to the buyers in the ICP: the share of a buyer title's words it contains. */
export function titleFit(title: string | null, buyers: string[]): number {
  if (!title) return 0;
  const t = words(title);
  return Math.max(0, ...buyers.map((b) => { const w = [...words(b)]; return w.length ? w.filter((x) => t.has(x)).length / w.length : 0; }));
}

/** Who to write to next: at each qualified company nobody has been written to at, the usable address closest to the ICP's buyers. */
export function nextToWrite(a: App, limit: number) {
  const buyers = getIcp(a)?.buyer_titles ?? [];
  const rows = all<{ id: number; company_id: number; title: string | null }>(a.db, `select p.id, p.title, c.id as company_id from contacts p join companies c on c.id = p.company_id
    where c.status = 'qualified' and p.status = 'active' and p.email_source in ('imported','published','verified')
      and not exists (select 1 from drafts d join contacts q on q.id = d.contact_id where q.company_id = c.id)
    order by coalesce(c.score, 0) desc, c.id, p.id`);
  const best = new Map<number, { id: number; fit: number }>();
  for (const r of rows) {
    const fit = titleFit(r.title, buyers);
    const cur = best.get(r.company_id);
    if (!cur || fit > cur.fit) best.set(r.company_id, { id: r.id, fit });
  }
  return [...best.values()].slice(0, limit).map((b) => b.id);
}

export function reviewQueue(a: App) {
  const drafts = all<any>(a.db, `select d.*, p.first_name, p.last_name, p.title, p.email, p.email_source, c.domain, c.name as company, c.id as company_id, c.score
    from drafts d join contacts p on p.id = d.contact_id join companies c on c.id = p.company_id
    where d.status in ('pending','blocked') order by d.contact_id, d.step`);
  const byContact = new Map<number, any>();
  for (const d of drafts) {
    const g = byContact.get(d.contact_id) ?? { why: JSON.parse(one<{ reasons: string | null }>(a.db, 'select reasons from companies where id = ?', d.company_id)?.reasons ?? '{}').reasons?.map((r: { text: string }) => r.text) ?? [], contact_id: d.contact_id, name: `${d.first_name} ${d.last_name ?? ''}`.trim(), title: d.title, email: d.email, email_source: d.email_source, domain: d.domain, company: d.company, score: d.score, status: d.status, angle: d.angle, emails: [], company_id: d.company_id };
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
