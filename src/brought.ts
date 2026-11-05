import { readFileSync } from 'node:fs';
import type { App } from './app.js';
import { normalizeDomain, parseCsv } from './csv.js';
import { all, logEvent, one, run } from './db.js';
import { CONTROL } from './fetcher.js';
import { addCompany, addContact, addressFits, OwnCompany } from './pipeline.js';

// Signals you bring: posts you found yourself (on LinkedIn or anywhere), with who wrote them and where. This tool never
// reads LinkedIn: you paste what you saw. Each post becomes a fact about the author's company, quoting their own words
// and linking to the post, so the email and the LinkedIn note to that person can open on what they wrote. The company
// is still researched and qualified against your ICP like any other.

/** At most this much of a post is quoted: enough to open on, short enough to check. */
export const QUOTE_MAX = 280;
const MIN_TEXT = 20;

const clean = (s: string | undefined, max: number) => (s ?? '').replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max);
/** The start of the post, cut at a sentence (else a word) under QUOTE_MAX: still the author's exact words. */
export function excerpt(text: string): string {
  const t = clean(text, 5000);
  if (t.length <= QUOTE_MAX) return t;
  const cut = t.slice(0, QUOTE_MAX);
  const sentence = cut.match(/^[\s\S]*[.!?](?=\s)/)?.[0];
  return sentence && sentence.length >= 60 ? sentence : cut.replace(/\s+\S*$/, '');
}
const webUrl = (u: string) => { try { const x = new URL(u); return x.protocol === 'https:' || x.protocol === 'http:' ? x.href : null; } catch { return null; } };
const isoDate = (v: string | undefined) => { const d = v ? new Date(v) : null; return d && !Number.isNaN(+d) ? d.toISOString().slice(0, 10) : null; };

export type Brought = { id: number; company_id: number; name: string; title: string | null; post_url: string; text: string; posted_at: string | null };

/** The facts a company's brought posts give, added to what research found (research clears facts, so it calls this again). */
export function postFacts(a: App, companyId: number) {
  const posts = all<Brought>(a.db, 'select id, company_id, name, title, post_url, text, posted_at from brought_signals where company_id = ? order by id', companyId);
  const added: Array<{ id: number; text: string; quote: string }> = [];
  for (const p of posts) {
    const quote = excerpt(p.text);
    if (one(a.db, 'select 1 from facts where company_id = ? and quote = ?', companyId, quote)) continue;
    const text = `${p.name}${p.title ? `, ${p.title},` : ''} wrote in a post: "${quote}"`;
    const r = run(a.db, "insert into facts (company_id, kind, text, quote, source_url, published_at, fetched_at) values (?, 'post', ?, ?, ?, ?, ?)", companyId, text, quote, p.post_url, p.posted_at, a.now().toISOString());
    added.push({ id: Number(r.lastInsertRowid), text, quote });
  }
  return added;
}

/** The person a company's emails go to when a post of theirs is the reason: "Jordan Lee, Controller". */
export const postAuthor = (a: App, companyId: number) => {
  const p = one<{ name: string; title: string | null }>(a.db, 'select name, title from brought_signals where company_id = ? order by id limit 1', companyId);
  return p ? `${p.name}, ${p.title ?? 'job unknown'} (wrote the post the first email opens on)` : null;
};

/**
 * outlevo signals import posts.csv. Columns: domain (their company's website), name, text (the post, as you copied
 * it), post_url; optional: title, date, email. Rows without those are skipped with the reason.
 */
export function importSignals(a: App, path: string) {
  let added = 0; let duplicates = 0; const companies = new Set<string>(); const skipped: Array<{ row: string; reason: string }> = [];
  for (const row of parseCsv(readFileSync(path, 'utf8'))) {
    const name = clean(row.name ?? row.author ?? [row.first_name, row.last_name].filter(Boolean).join(' '), 120);
    const text = clean(row.text ?? row.post ?? row.post_text, 5000);
    const url = webUrl(clean(row.post_url ?? row.url, 500));
    const domain = normalizeDomain(row.domain ?? row.website ?? row.company_domain ?? '');
    const label = (name || url || 'a blank row').slice(0, 80);
    if (!name) { skipped.push({ row: label, reason: 'no name' }); continue; }
    if (text.length < MIN_TEXT) { skipped.push({ row: label, reason: 'no post text (copy the words of the post into a text column)' }); continue; }
    if (!url) { skipped.push({ row: label, reason: 'no post_url: the email cites where the words came from' }); continue; }
    if (!domain) { skipped.push({ row: label, reason: 'no company domain' }); continue; }
    let c: { id: number; domain: string; added: boolean };
    try { c = addCompany(a, domain, 'signal'); } catch (e) { skipped.push({ row: label, reason: e instanceof OwnCompany ? 'your own company' : 'not a domain' }); continue; }
    const r = run(a.db, `insert into brought_signals (company_id, name, title, post_url, text, posted_at, created_at) values (?, ?, ?, ?, ?, ?, ?) on conflict (company_id, post_url) do nothing`,
      c.id, name, clean(row.title ?? row.job_title, 120) || null, url, text, isoDate(row.date ?? row.posted_at), a.now().toISOString());
    if (!Number(r.changes)) { duplicates++; continue; }
    added++; companies.add(c.domain);
    const email = clean(row.email, 320).toLowerCase();
    if (email && addressFits(a, email, c.domain)) addContact(a, { company_id: c.id, first_name: name.split(' ')[0]!, last_name: name.split(' ').slice(1).join(' ') || null, title: clean(row.title, 120) || null, email, email_source: 'imported' });
    // a company already researched gets the post at once; a new one gets it when research runs
    if (one(a.db, "select 1 from companies where id = ? and status = 'qualified'", c.id)) postFacts(a, c.id);
  }
  logEvent(a.db, a.now(), 'signals.imported', { added, duplicates, companies: companies.size, skipped: skipped.length });
  return { added, duplicates, companies: [...companies], skipped };
}
