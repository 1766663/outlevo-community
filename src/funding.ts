import type { App } from './app.js';
import { logEvent } from './db.js';
import { CONTROL, type Page } from './fetcher.js';

// Funding signals from SEC Form D filings. A US company raising money privately files a Form D with the date of its
// first sale and how much it sold: a dated, public fact, often months before any press release. EDGAR is free and
// needs no key; its search matches loosely ("Ramp" finds "BroadLight Capital DV Ramp, L.P."), so a filing counts only
// when both hold:
//   - the issuer's legal name, without its legal form (Inc, LLC, Ltd…), is the company's own name, and
//   - the filing's ZIP code or phone number is printed on a page of the company's own website that was read.
// Investment funds are skipped. Read 2026-11-05:
//   efts.sec.gov/LATEST/search-index?q="<name>"&forms=D&dateRange=custom&startdt&enddt
//     → {hits: {hits: [{_id: "<adsh>:primary_doc.xml", _source: {ciks, display_names, file_date, adsh, biz_locations}}]}}
//   www.sec.gov/Archives/edgar/data/<cik>/<adsh without dashes>/primary_doc.xml → <entityName>, <zipCode>,
//     <issuerPhoneNumber>, <industryGroupType>, <dateOfFirstSale><value>, <totalAmountSold>, <totalOfferingAmount>
//   The same filing for people: …/xslFormDX01/primary_doc.xml

/** A filing counts this long after it was filed. */
export const FRESH_DAYS = 180;
const MAX_DOCS = 3;

const LEGAL = /\b(incorporated|inc|corporation|corp|company|co|limited|ltd|llc|l\s?l\s?c|lp|l\s?p|llp|plc|gmbh|ag|sa|sas|bv|nv|pbc)\b\.?/gi;
/** Words a brand drops from its legal name: "Clay" is Clay Labs Inc., "Mercury" is Mercury Technologies, Inc. */
const GENERIC_WORDS = new Set(['technologies', 'technology', 'tech', 'labs', 'software', 'systems', 'platforms', 'solutions', 'hq', 'ai', 'io', 'app', 'group', 'global', 'usa', 'us']);
/** "Northwind, Inc." and "NORTHWIND INC" are one name; "Northwind Capital Fund I" is another. Tickers and CIKs in brackets go. */
export const legalName = (s: string | null | undefined) => {
  // Bracketed text dropped in one pass (a regex over many "(" takes seconds), and nothing longer than a name is read.
  let out = ''; let depth = 0;
  for (const ch of String(s ?? '').slice(0, 200).toLowerCase()) { if (ch === '(') depth++; else if (ch === ')') depth = Math.max(0, depth - 1); else if (!depth) out += ch; }
  const words = out.replace(/&/g, ' and ').replace(LEGAL, ' ').replace(/[^\p{L}\p{N}]+/gu, ' ').trim().split(' ');
  while (words.length > 1 && GENERIC_WORDS.has(words.at(-1)!)) words.pop();
  return words.join(' ');
};

export type FormD = { cik: string; adsh: string; filed: string; entity: string; city: string | null; state: string | null; zip: string | null; phone: string | null; industry: string | null; first_sale: string | null; sold: number | null; offered: number | null };

/** The first <name>…</name>'s text, found with indexOf: a regex over a hostile document can take seconds. */
const tag = (xml: string, name: string, after = 0) => {
  const lower = xml.toLowerCase(); const open = lower.indexOf(`<${name.toLowerCase()}>`, after);
  if (open < 0) return null;
  const start = open + name.length + 2; const end = xml.indexOf('<', start);
  const XML_ENTITY: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
  return xml.slice(start, end < 0 ? start : Math.min(end, start + 300)).replace(/&(amp|lt|gt|quot|apos);/g, (_, e: string) => XML_ENTITY[e]!)
    .replace(CONTROL, '').replace(/\s+/g, ' ').trim() || null;
};
const money = (v: string | null) => (v && /^\d{1,13}(\.\d+)?$/.test(v) ? Number(v) : null);

/** The fields a filing gives, from its primary document. */
export function parseFormD(raw: string, cik: string, adsh: string, filed: string): FormD | null {
  const xml = raw.slice(0, 300_000);
  const entity = tag(xml, 'entityName')?.slice(0, 150) ?? null;
  if (!entity) return null;
  const saleAt = xml.toLowerCase().indexOf('<dateoffirstsale>');
  const sale = saleAt < 0 ? null : tag(xml, 'value', saleAt);
  return {
    cik, adsh, filed, entity, city: tag(xml, 'city'), state: tag(xml, 'stateOrCountry'),
    zip: tag(xml, 'zipCode')?.slice(0, 5) ?? null, phone: tag(xml, 'issuerPhoneNumber')?.replace(/\D/g, '').slice(-10) ?? null,
    industry: tag(xml, 'industryGroupType'), first_sale: sale && /^\d{4}-\d{2}-\d{2}$/.test(sale) ? sale : null,
    sold: money(tag(xml, 'totalAmountSold')), offered: money(tag(xml, 'totalOfferingAmount')),
  };
}

const escRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
/**
 * Whether the filing is this company: its address (the ZIP code right after its city or state, as an address is
 * written) or its phone number, written as one, is on the company's own pages. A bare five digits or loose digits
 * elsewhere on a page do not count.
 */
export function onTheirSite(f: Pick<FormD, 'zip' | 'phone' | 'city' | 'state'>, pages: Page[]): boolean {
  const text = pages.map((p) => p.text).join('\n').slice(0, 2_000_000);
  const places = [f.city, f.state].filter((x): x is string => Boolean(x && x.length >= 2 && x.length <= 40)).map(escRe);
  if (f.zip && /^\d{5}$/.test(f.zip) && places.length && new RegExp(`(?:${places.join('|')})[^\\n\\d]{0,12}${f.zip}(?!\\d)`, 'i').test(text)) return true;
  // A phone alone is weak (filing agents share theirs): it counts with the filing's city on the same pages.
  if (!f.phone || f.phone.length !== 10 || !f.city || !new RegExp(escRe(f.city), 'i').test(text)) return false;
  const [x, y, z] = [f.phone.slice(0, 3), f.phone.slice(3, 6), f.phone.slice(6)];
  return new RegExp(`(?<!\\d)(?:\\+?1[\\s.-]?)?\\(?${x}\\)?[\\s.-]?${y}[\\s.-]?${z}(?!\\d)`).test(text);
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const docUrl = (cik: string, adsh: string, view = false) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, '')}/${view ? 'xslFormDX01/' : ''}primary_doc.xml`;

export type FundingFact = { kind: 'funding'; text: string; quote: string; source_url: string; published_at: string | null };

const ADDRESS_PAGE = /\/(contact|contact-us|about|company|legal|terms|terms-of-service|tos|privacy|privacy-policy|imprint|impressum)(\/|$)/i;
/** The company's own contact and legal pages linked from what was read, not already read: at most three. */
async function addressPages(a: App, pages: Page[], domain?: string): Promise<Page[]> {
  const seen = new Set(pages.map((p) => p.url));
  const own = (u: string) => { try { const h = new URL(u).hostname.replace(/^www\./, ''); return !domain || h === domain || h.endsWith(`.${domain}`); } catch { return false; } };
  const picks = [...new Set(pages.flatMap((p) => p.links))].filter((u) => !seen.has(u) && own(u) && ADDRESS_PAGE.test(new URL(u).pathname)).slice(0, 3);
  return (await Promise.all(picks.map((u) => a.fetchPage(u).catch(() => null)))).filter((p): p is Page => Boolean(p));
}

/** The fact a filing gives. The quote is the filing's own wording of what was sold, which the email is held to. */
export function fundingFact(f: FormD): FundingFact {
  const sold = f.sold && f.sold > 0 ? f.sold : null;
  return {
    kind: 'funding', published_at: f.filed, source_url: docUrl(f.cik, f.adsh, true),
    text: `Raised money privately: a Form D filed ${f.filed}${sold ? `, ${usd(sold)} sold so far` : ''}${f.first_sale ? `, first sale ${f.first_sale}` : ''}`,
    quote: sold ? `Total Amount Sold ${usd(sold)}` : `Form D filed on ${f.filed}`,
  };
}

/**
 * The company's Form D filings of the last FRESH_DAYS, checked as above: at most one fact, the newest. Never fails the
 * research: EDGAR being slow or down gives nothing.
 */
export async function fundingFacts(a: App, name: string | null, pages: Page[], domain?: string): Promise<FundingFact[]> {
  const want = legalName(name);
  if (!want || want.length < 3) return [];
  // The name comes from a model's reading of their pages: it also has to be their domain's ("Acme" at acme.com, acmehq.com).
  if (domain && !domain.split('.')[0]!.replace(/[^a-z0-9]/g, '').includes(want.replace(/ /g, ''))) return [];
  const end = a.now().toISOString().slice(0, 10);
  const start = new Date(+a.now() - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10);
  const q = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${name!.replace(/"/g, '').slice(0, 100)}"`)}&forms=D&dateRange=custom&startdt=${start}&enddt=${end}`;
  const found = (await a.fetchJson(q).catch(() => null)) as { hits?: { hits?: Array<{ _source?: Record<string, any> }> } } | null;
  // Matched by name first, then the newest few: a loose search can list the right issuer 18th.
  const hits = (found?.hits?.hits ?? []).slice(0, 100).map((h) => h._source ?? {})
    .filter((s) => Array.isArray(s.display_names) && legalName(s.display_names[0]) === want && Array.isArray(s.ciks) && typeof s.adsh === 'string' && /^\d{10}-\d{2}-\d{6}$/.test(s.adsh))
    .sort((x, y) => String(y.file_date).localeCompare(String(x.file_date))).slice(0, MAX_DOCS);
  let extra: Page[] | undefined;
  for (const h of hits) {
    const cik = String(h.ciks[0]).replace(/\D/g, '');
    if (!cik) continue;
    const xml = await a.fetchText(docUrl(cik, h.adsh)).catch(() => null);
    const f = xml ? parseFormD(xml, cik, h.adsh, String(h.file_date).slice(0, 10)) : null;
    if (!f || legalName(f.entity) !== want || /pooled investment fund/i.test(f.industry ?? '')) continue;
    // A company prints its address on its contact or legal pages more than on those research reads: read up to three of
    // them, for this check only (no model call), and only once a filing matched by name.
    if (!onTheirSite(f, pages)) {
      extra ??= await addressPages(a, pages, domain);
      if (!onTheirSite(f, [...pages, ...extra])) { logEvent(a.db, a.now(), 'company.form_d_unmatched', { entity: f.entity, adsh: f.adsh }); continue; }
    }
    logEvent(a.db, a.now(), 'company.form_d', { entity: f.entity, adsh: f.adsh, filed: f.filed });
    return [fundingFact(f)];
  }
  return [];
}
