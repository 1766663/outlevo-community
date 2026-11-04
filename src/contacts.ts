import type { App } from './app.js';
import { all, logEvent, one } from './db.js';
import { bumpUsage, usageToday } from './model.js';
import { addContact, getIcp, titleFit } from './pipeline.js';

export class HunterRefused extends Error {}
type HunterEmail = { value?: string; type?: string; confidence?: number; first_name?: string | null; last_name?: string | null; position?: string | null };
const BASE = 'https://api.hunter.io/v2';

async function hunter<T>(path: string, params: Record<string, string>, key: string, doFetch: typeof fetch): Promise<T> {
  // The key goes in the query string by Hunter's design, so the URL never goes in a message.
  const res = await doFetch(`${BASE}${path}?${new URLSearchParams({ ...params, api_key: key })}`, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(30_000) });
  if (res.status === 401 || res.status === 403) throw new HunterRefused(`Hunter refused the key (${res.status})`);
  if (res.status === 402 || res.status === 429) throw new HunterRefused(`Hunter says the plan is used up or too busy (${res.status})`);
  if (!res.ok) throw new Error(`Hunter ${path} answered ${res.status}`);
  return (await res.json()) as T;
}

/** The best-fitting person at each qualified company with nobody to write to. Only an address Hunter calls valid is kept, and a guess never is. */
export async function findContacts(a: App, opts: { limit: number; doFetch?: typeof fetch }) {
  const key = a.secrets.hunter_key;
  if (!key) throw new Error('Set HUNTER_API_KEY to find contacts with your own Hunter account, import a CSV, or use outlevo cloud contacts.');
  const doFetch = opts.doFetch ?? fetch;
  const buyers = getIcp(a)?.buyer_titles ?? [];
  const limit = a.config.contacts.max_lookups_per_day;
  const spend = () => {
    if (usageToday(a.db, 'hunter_call', a.now()) >= limit) return false;
    bumpUsage(a.db, 'hunter_call', a.now());
    return true;
  };
  const companies = all<{ id: number; domain: string }>(a.db, `select c.id, c.domain from companies c where c.status = 'qualified'
    and not exists (select 1 from contacts p where p.company_id = c.id and p.status = 'active' and p.email_source in ('imported','published','verified'))
    and not exists (select 1 from events e where e.kind = 'contacts.searched' and e.data = json_object('company_id', c.id))
    order by coalesce(c.score, 0) desc limit ?`, opts.limit);
  let added = 0; let notVerified = 0; let looked = 0;
  for (const c of companies) {
    if (!spend()) break;
    looked++;
    const found = await hunter<{ data?: { emails?: HunterEmail[] } }>('/domain-search', { domain: c.domain, type: 'personal', limit: '10' }, key, doFetch);
    logEvent(a.db, a.now(), 'contacts.searched', { company_id: c.id });
    const people = (found.data?.emails ?? []).filter((e) => e.value && e.first_name)
      .sort((x, y) => titleFit(y.position ?? null, buyers) - titleFit(x.position ?? null, buyers) || (y.confidence ?? 0) - (x.confidence ?? 0)).slice(0, 3);
    for (const p of people) {
      if (!spend()) break;
      const v = await hunter<{ data?: { status?: string } }>('/email-verifier', { email: p.value! }, key, doFetch);
      if (v.data?.status !== 'valid') { notVerified++; continue; }
      if (addContact(a, { company_id: c.id, first_name: p.first_name!, last_name: p.last_name ?? null, title: p.position ?? null, email: p.value!, email_source: 'verified' })) added++;
      break; // one good address a company is enough, and each check costs a credit
    }
  }
  logEvent(a.db, a.now(), 'contacts.found', { companies: looked, added, not_verified: notVerified });
  return { companies: looked, added, not_verified: notVerified, waiting: Math.max(0, (one<{ n: number }>(a.db, "select count(*) as n from companies where status = 'qualified'")?.n ?? 0) - added) };
}
