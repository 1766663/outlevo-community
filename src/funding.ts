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
const MAX_HITS = 10; const MAX_DOCS = 3;

const LEGAL = /\b(incorporated|inc|corporation|corp|company|co|limited|ltd|llc|l\s?l\s?c|lp|l\s?p|llp|plc|gmbh|ag|sa|sas|bv|nv|pbc)\b\.?/gi;
/** Words a brand drops from its legal name: "Clay" is Clay Labs Inc., "Mercury" is Mercury Technologies, Inc. */
const GENERIC_TAIL = /(\s(technologies|technology|tech|labs|software|systems|platforms|solutions|hq|ai|io|app|group|global|usa|us))+$/;
/** "Northwind, Inc." and "NORTHWIND INC" are one name; "Northwind Capital Fund I" is another. Tickers and CIKs in brackets go. */
export const legalName = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/\([^)]*\)/g, ' ').replace(/&/g, ' and ').replace(LEGAL, ' ')
  .replace(/[^a-z0-9]+/g, ' ').trim().replace(GENERIC_TAIL, '').trim();

export type FormD = { cik: string; adsh: string; filed: string; entity: string; zip: string | null; phone: string | null; industry: string | null; first_sale: string | null; sold: number | null; offered: number | null };

const tag = (xml: string, name: string) => xml.match(new RegExp(`<${name}>\\s*([^<]*)<`, 'i'))?.[1]?.replace(CONTROL, '').trim() || null;
const money = (v: string | null) => (v && /^\d+(\.\d+)?$/.test(v) ? Number(v) : null);

/** The fields a filing gives, from its primary document. */
export function parseFormD(xml: string, cik: string, adsh: string, filed: string): FormD | null {
  const entity = tag(xml, 'entityName');
  if (!entity) return null;
  const sale = xml.match(/<dateOfFirstSale>\s*<value>\s*([^<]*)</i)?.[1]?.trim() ?? null;
  return {
    cik, adsh, filed, entity, zip: tag(xml, 'zipCode')?.slice(0, 5) ?? null, phone: tag(xml, 'issuerPhoneNumber')?.replace(/\D/g, '').slice(-10) ?? null,
    industry: tag(xml, 'industryGroupType'), first_sale: sale && /^\d{4}-\d{2}-\d{2}$/.test(sale) ? sale : null,
    sold: money(xml.match(/<totalAmountSold>\s*([^<]*)</i)?.[1]?.trim() ?? null), offered: money(xml.match(/<totalOfferingAmount>\s*([^<]*)</i)?.[1]?.trim() ?? null),
  };
}

/** Whether the filing is this company: its ZIP code or its phone number is on the company's own pages. */
export function onTheirSite(f: Pick<FormD, 'zip' | 'phone'>, pages: Page[]): boolean {
  const text = pages.map((p) => p.text).join('\n');
  if (f.zip && /^\d{5}$/.test(f.zip) && new RegExp(`(?<!\\d)${f.zip}(?!\\d)`).test(text)) return true;
  return Boolean(f.phone && f.phone.length === 10 && text.replace(/\D/g, '').includes(f.phone));
}

const usd = (n: number) => `$${Math.round(n).toLocaleString('en-US')}`;
const docUrl = (cik: string, adsh: string, view = false) => `https://www.sec.gov/Archives/edgar/data/${Number(cik)}/${adsh.replace(/-/g, '')}/${view ? 'xslFormDX01/' : ''}primary_doc.xml`;

export type FundingFact = { kind: 'funding'; text: string; quote: string; source_url: string; published_at: string | null };

/** The fact a filing gives. The quote is the filing's own wording of what was sold, which the email is held to. */
export function fundingFact(f: FormD): FundingFact {
  const sold = f.sold && f.sold > 0 ? f.sold : null;
  return {
    kind: 'funding', published_at: f.filed, source_url: docUrl(f.cik, f.adsh, true),
    text: `Raised money privately: a Form D filed ${f.filed}${sold ? `, ${usd(sold)} sold so far` : ''}${f.first_sale ? `, first sale ${f.first_sale}` : ''}`,
    quote: sold ? `Total Amount Sold ${usd(sold)}` : `Form D filed by ${f.entity} on ${f.filed}`,
  };
}

/**
 * The company's Form D filings of the last FRESH_DAYS, checked as above: at most one fact, the newest. Never fails the
 * research: EDGAR being slow or down gives nothing.
 */
export async function fundingFacts(a: App, name: string | null, pages: Page[]): Promise<FundingFact[]> {
  const want = legalName(name);
  if (!want || want.length < 3) return [];
  const end = a.now().toISOString().slice(0, 10);
  const start = new Date(+a.now() - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10);
  const q = `https://efts.sec.gov/LATEST/search-index?q=${encodeURIComponent(`"${name!.replace(/"/g, '').slice(0, 100)}"`)}&forms=D&dateRange=custom&startdt=${start}&enddt=${end}`;
  const found = (await a.fetchJson(q).catch(() => null)) as { hits?: { hits?: Array<{ _source?: Record<string, any> }> } } | null;
  const hits = (found?.hits?.hits ?? []).slice(0, MAX_HITS).map((h) => h._source ?? {})
    .filter((s) => Array.isArray(s.display_names) && legalName(s.display_names[0]) === want && Array.isArray(s.ciks) && typeof s.adsh === 'string' && /^\d{10}-\d{2}-\d{6}$/.test(s.adsh))
    .sort((x, y) => String(y.file_date).localeCompare(String(x.file_date))).slice(0, MAX_DOCS);
  for (const h of hits) {
    const cik = String(h.ciks[0]).replace(/\D/g, '');
    if (!cik) continue;
    const xml = await a.fetchText(docUrl(cik, h.adsh)).catch(() => null);
    const f = xml ? parseFormD(xml, cik, h.adsh, String(h.file_date).slice(0, 10)) : null;
    if (!f || legalName(f.entity) !== want || /pooled investment fund/i.test(f.industry ?? '')) continue;
    if (!onTheirSite(f, pages)) { logEvent(a.db, a.now(), 'company.form_d_unmatched', { entity: f.entity, adsh: f.adsh }); continue; }
    logEvent(a.db, a.now(), 'company.form_d', { entity: f.entity, adsh: f.adsh, filed: f.filed });
    return [fundingFact(f)];
  }
  return [];
}
