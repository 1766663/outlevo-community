import { randomUUID } from 'node:crypto';
import type { App } from './app.js';
import { logEvent, one, run } from './db.js';
import { addCompany, addContact, addressFits } from './pipeline.js';

// Outlevo Cloud is optional. Community never calls it until you connect a key and ask for something.
export const SIGNUP_URL = 'https://app.outlevo.com/?utm_source=community&utm_medium=cli';

export class CloudError extends Error {
  constructor(public status: number, public code: string, message: string, public fix?: string) { super(fix ? `${message} (${fix})` : message); }
}
export type CloudOpts = { yes?: boolean };
export class NeedsConfirm extends Error { constructor(public credits: number, what: string) { super(`${what} costs ${credits} Outlevo credits. Run it again with --yes to go ahead.`); } }

export class Cloud {
  constructor(private key: string, private base: string, private doFetch: typeof fetch = fetch, private wait = (ms: number) => new Promise((r) => setTimeout(r, ms))) {}

  async call<T = any>(method: string, path: string, body?: unknown): Promise<T> {
    const res = await this.doFetch(`${this.base}${path}`, {
      method, signal: AbortSignal.timeout(60_000),
      headers: { authorization: `Bearer ${this.key}`, 'content-type': 'application/json', 'user-agent': 'outlevo-community/0.1', ...(method === 'GET' ? {} : { 'idempotency-key': randomUUID() }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    const text = await res.text();
    const json = text ? JSON.parse(text) : null;
    if (!res.ok) throw new CloudError(res.status, json?.error?.code ?? 'ERROR', json?.error?.message ?? `HTTP ${res.status}`, json?.error?.fix);
    return json as T;
  }

  /** A metered call: ask for the price first, spend only when told to. */
  async metered<T = any>(path: string, body: unknown, what: string, o: CloudOpts): Promise<T> {
    const quote = await this.call<any>('POST', path, body);
    if (!quote?.confirm_required) return quote;
    if (!o.yes) throw new NeedsConfirm(quote.credit_estimate, what);
    return this.call<T>('POST', `${path}${path.includes('?') ? '&' : '?'}confirm=true`, body);
  }

  async job(id: string, tries = 60) {
    for (let i = 0; i < tries; i++) {
      const j = await this.call<{ status: string; result: any; error: any }>('GET', `/v1/jobs/${encodeURIComponent(id)}`);
      if (j.status === 'succeeded') return j.result;
      if (j.status === 'failed' || j.status === 'dead' || j.status === 'blocked') throw new Error(`Outlevo job ${id} ${j.status}: ${JSON.stringify(j.error)}`);
      await this.wait(3000);
    }
    throw new Error(`Outlevo job ${id} is still running; try again shortly`);
  }
}

/** Your key goes wherever this points. Plain http only to this machine, for development. */
export const cloudUrlOk = (raw: string) => {
  try { const u = new URL(raw); return (u.protocol === 'https:' && (u.hostname === 'outlevo.com' || u.hostname.endsWith('.outlevo.com'))) || (u.protocol === 'http:' && ['127.0.0.1', 'localhost'].includes(u.hostname)); } catch { return false; }
};

export function cloudOf(a: App, doFetch?: typeof fetch): Cloud {
  if (!a.secrets.outlevo_key) throw new Error(`Connect Outlevo Cloud first: create a key at ${SIGNUP_URL} (Developers), then: outlevo cloud connect`);
  if (!cloudUrlOk(a.config.cloud_url)) throw new Error(`cloud_url must be https on outlevo.com, and your key is not sent to ${a.config.cloud_url}`);
  return new Cloud(a.secrets.outlevo_key, a.config.cloud_url, doFetch);
}

export async function cloudStatus(c: Cloud) {
  const u = await c.call<{ plan: string; status: string; available: number }>('GET', '/v1/usage');
  return { plan: u.plan, status: u.status, credits_available: u.available };
}

export async function cloudFind(a: App, c: Cloud, o: { brief?: string; like?: string; count: number }, opt: CloudOpts) {
  const r = await c.metered<{ companies: Array<{ name: string; domain: string; why: string }> }>('/v1/companies/find', { ...(o.brief ? { brief: o.brief } : {}), ...(o.like ? { like: o.like } : {}), count: o.count }, 'Finding companies', opt);
  const added: string[] = [];
  for (const x of r.companies ?? []) { try { const n = addCompany(a, x.domain, 'cloud', x.name); if (n.added) added.push(n.domain); } catch { /* not a domain */ } }
  logEvent(a.db, a.now(), 'cloud.find', { added: added.length });
  return { added };
}

async function ensureCloudCompany(a: App, c: Cloud, id: number): Promise<string> {
  const row = one<{ domain: string; name: string | null; cloud_id: string | null }>(a.db, 'select domain, name, cloud_id from companies where id = ?', id);
  if (!row) throw new Error(`No company ${id}`);
  if (row.cloud_id) return row.cloud_id;
  let cloudId: string;
  try {
    cloudId = (await c.call<{ id: string }>('POST', '/v1/companies', { domain: row.domain, ...(row.name ? { name: row.name } : {}) })).id;
  } catch (e) {
    if (e instanceof CloudError && e.code === 'COMPANY_EXISTS') {
      const list = await c.call<{ data: Array<{ id: string }> }>('GET', `/v1/companies?domain=${encodeURIComponent(row.domain)}`);
      if (!list.data[0]) throw e;
      cloudId = list.data[0].id;
    } else throw e;
  }
  run(a.db, 'update companies set cloud_id = ? where id = ?', cloudId, id);
  return cloudId;
}

type CloudContact = { id: string; first_name: string | null; last_name: string | null; title: string | null; email?: string | null; verification_status: string };

/** Decision makers with verified addresses: what a machine at home cannot find. Only `valid` addresses come back as sendable. */
export async function cloudContacts(a: App, c: Cloud, companyId: number, opt: CloudOpts & { titles?: string[] }) {
  const cloudId = await ensureCloudCompany(a, c, companyId);
  const companyDomain = one<{ domain: string }>(a.db, 'select domain from companies where id = ?', companyId)!.domain;
  const started = await c.metered<{ job_id?: string }>(`/v1/companies/${encodeURIComponent(cloudId)}/contacts/discover`, opt.titles?.length ? { titles: opt.titles } : {}, 'Finding contacts', opt);
  if (started?.job_id) await c.job(started.job_id);
  // The list leaves addresses out; each contact's own page carries one.
  const list = await c.call<{ data: CloudContact[] }>('GET', `/v1/companies/${encodeURIComponent(cloudId)}/contacts`);
  let added = 0; let unverified = 0;
  for (const row of list.data) {
    if (row.verification_status === 'unverified') {
      const job = await c.metered<{ job_id?: string }>(`/v1/contacts/${encodeURIComponent(row.id)}/verify`, {}, 'Verifying an address', opt);
      if (job?.job_id) await c.job(job.job_id);
    }
    const p = await c.call<CloudContact>('GET', `/v1/contacts/${encodeURIComponent(row.id)}`);
    if (!p.email || !p.first_name) continue;
    if (p.verification_status !== 'valid') { unverified++; continue; }
    if (!addressFits(a, p.email, companyDomain)) continue;
    if (addContact(a, { company_id: companyId, first_name: p.first_name, last_name: p.last_name, title: p.title, email: p.email, email_source: 'verified', cloud_id: p.id })) added++;
  }
  logEvent(a.db, a.now(), 'cloud.contacts', { company_id: companyId, added, unverified });
  return { added, unverified };
}

/** Hands qualified companies to Cloud, which sends from warmed mailboxes. Cloud asks a person before anything goes out. */
export async function cloudHandoff(a: App, c: Cloud, companyIds: number[], name: string) {
  const ids: string[] = [];
  for (const id of companyIds) ids.push(await ensureCloudCompany(a, c, id));
  const { timezone, weekdays, send_hours: [from, to], min_gap_minutes, max_per_day } = a.config.limits;
  const pad = (h: number) => `${String(h).padStart(2, '0')}:00`;
  const camp = await c.call<{ id: string }>('POST', '/v1/campaigns', {
    name, schedule: { timezone, days: weekdays.map((d) => d || 7), start_hour: pad(from), end_hour: pad(to), min_minutes_between: min_gap_minutes, max_new_leads_per_day: max_per_day },
  });
  const res = await c.call<{ data: Array<{ domain: string; added: boolean; reason?: string }> }>('POST', `/v1/campaigns/${encodeURIComponent(camp.id)}/companies`, { company_ids: ids.slice(0, 50), reason: 'From Outlevo Community' });
  logEvent(a.db, a.now(), 'cloud.handoff', { campaign_id: camp.id, companies: ids.length });
  return { campaign_id: camp.id, url: `https://app.outlevo.com/campaigns/${encodeURIComponent(camp.id)}`, companies: res.data };
}
