import { describe, expect, it } from 'vitest';
import { Cloud, CloudError, cloudContacts, cloudFind, cloudHandoff, NeedsConfirm } from '../src/cloud.js';
import { one, run } from '../src/db.js';
import { addCompany, nextToWrite } from '../src/pipeline.js';
import { testApp } from './helpers.js';

const reply = (status: number, body: unknown) => new Response(JSON.stringify(body), { status });
function fake(routes: (m: string, p: string, b: any) => Response) {
  const calls: Array<{ method: string; path: string; headers: Record<string, string> }> = [];
  const doFetch = (async (url: string, init: any) => {
    const path = String(url).replace('https://api.test', '');
    calls.push({ method: init.method, path, headers: init.headers });
    return routes(init.method, path, init.body ? JSON.parse(init.body) : undefined);
  }) as unknown as typeof fetch;
  return { cloud: new Cloud('olv_test_x', 'https://api.test', doFetch, async () => {}), calls };
}

describe('metered calls', () => {
  const routes = (m: string, p: string) => (p.includes('confirm=true') ? reply(202, { job_id: 'j1' }) : reply(200, { credit_estimate: 4, confirm_required: true }));
  it('tells the price and spends nothing without --yes', async () => {
    const { cloud, calls } = fake(routes);
    await expect(cloud.metered('/v1/x', {}, 'It', {})).rejects.toBeInstanceOf(NeedsConfirm);
    expect(calls.some((c) => c.path.includes('confirm'))).toBe(false);
  });
  it('confirms with --yes, with a fresh idempotency key', async () => {
    const { cloud, calls } = fake(routes);
    expect(await cloud.metered('/v1/x', {}, 'It', { yes: true })).toEqual({ job_id: 'j1' });
    expect(calls).toHaveLength(2);
    expect(calls[0]!.headers['idempotency-key']).not.toBe(calls[1]!.headers['idempotency-key']);
    expect(calls[0]!.headers.authorization).toBe('Bearer olv_test_x');
  });
  it('passes on what the API says to do', async () => {
    const { cloud } = fake(() => reply(403, { error: { code: 'SCOPE', message: 'Not allowed', fix: 'Use a key with Acts as me' } }));
    await expect(cloud.call('GET', '/v1/x')).rejects.toThrow('Use a key with Acts as me');
    await expect(cloud.call('GET', '/v1/x')).rejects.toBeInstanceOf(CloudError);
  });
});

describe('cloudContacts', () => {
  const routes = (m: string, p: string) => {
    if (m === 'POST' && p === '/v1/companies') return reply(201, { id: 'c1' });
    if (p === '/v1/companies/c1/contacts/discover') return reply(200, { credit_estimate: 4, confirm_required: true });
    if (p.endsWith('/contacts/discover?confirm=true')) return reply(202, { job_id: 'j1' });
    if (p === '/v1/jobs/j1' || p === '/v1/jobs/j2') return reply(200, { status: 'succeeded', result: {} });
    if (p === '/v1/companies/c1/contacts') return reply(200, { data: [{ id: 'p1', verification_status: 'valid' }, { id: 'p2', verification_status: 'risky' }, { id: 'p3', verification_status: 'unverified' }] });
    if (p === '/v1/contacts/p3/verify') return reply(200, { credit_estimate: 1, confirm_required: true });
    if (p === '/v1/contacts/p3/verify?confirm=true') return reply(202, { job_id: 'j2' });
    if (p === '/v1/contacts/p1') return reply(200, { id: 'p1', first_name: 'Ana', last_name: 'B', title: 'CEO', email: 'ana@n.example', verification_status: 'valid' });
    if (p === '/v1/contacts/p2') return reply(200, { id: 'p2', first_name: 'Bo', last_name: null, title: null, email: 'bo@n.example', verification_status: 'risky' });
    if (p === '/v1/contacts/p3') return reply(200, { id: 'p3', first_name: 'Cy', last_name: null, title: null, email: 'cy@n.example', verification_status: 'valid' });
    return reply(404, { error: { code: 'NOPE', message: p } });
  };
  it('reads each address from the contact page and keeps only valid ones', async () => {
    const a = testApp(); const c = addCompany(a, 'n.example', 'manual');
    const { cloud } = fake(routes);
    expect(await cloudContacts(a, cloud, c.id, { yes: true })).toEqual({ added: 2, unverified: 1 });
    expect(one<any>(a.db, "select email_source, cloud_id from contacts where email = 'ana@n.example'")).toEqual({ email_source: 'verified', cloud_id: 'p1' });
    expect(one(a.db, "select 1 from contacts where email = 'bo@n.example'")).toBeUndefined();
  });
  it('verified contacts at a qualified company are next to be written to', async () => {
    const a = testApp(); const c = addCompany(a, 'n.example', 'manual');
    run(a.db, "update companies set status = 'qualified' where id = ?", c.id);
    await cloudContacts(a, fake(routes).cloud, c.id, { yes: true });
    expect(nextToWrite(a, 5)).toHaveLength(1);
  });
  it('finds the company when it already exists there', async () => {
    const a = testApp(); const c = addCompany(a, 'n.example', 'manual');
    const { cloud } = fake((m, p) => {
      if (m === 'POST' && p === '/v1/companies') return reply(409, { error: { code: 'COMPANY_EXISTS', message: 'Exists' } });
      if (p === '/v1/companies?domain=n.example') return reply(200, { data: [{ id: 'c9' }] });
      if (p === '/v1/companies/c9/contacts/discover') return reply(200, { credit_estimate: 4, confirm_required: true });
      return reply(500, {});
    });
    await expect(cloudContacts(a, cloud, c.id, {})).rejects.toBeInstanceOf(NeedsConfirm);
    expect(one<any>(a.db, 'select cloud_id from companies').cloud_id).toBe('c9');
  });
});

describe('cloudFind and cloudHandoff', () => {
  it('adds what it finds', async () => {
    const a = testApp();
    const { cloud } = fake(() => reply(200, { companies: [{ name: 'A', domain: 'a.example', why: 'x' }, { name: 'Bad', domain: 'not a domain', why: 'x' }] }));
    expect(await cloudFind(a, cloud, { brief: 'x', count: 5 }, {})).toEqual({ added: ['a.example'] });
  });
  it('hands companies over and starts nothing', async () => {
    const a = testApp(); const c = addCompany(a, 'n.example', 'manual');
    let body: any;
    const { cloud, calls } = fake((m, p, b) => {
      if (p === '/v1/companies') return reply(201, { id: 'c1' });
      if (p === '/v1/campaigns') { body = b; return reply(201, { id: 'k1' }); }
      if (p === '/v1/campaigns/k1/companies') return reply(202, { data: [{ domain: 'n.example', added: true }] });
      return reply(500, {});
    });
    const r = await cloudHandoff(a, cloud, [c.id], 'Test');
    expect(r.url).toBe('https://app.outlevo.com/campaigns/k1');
    expect(body.schedule).toEqual({ timezone: 'America/New_York', days: [1, 2, 3, 4, 5], start_hour: '09:00', end_hour: '17:00', min_minutes_between: 4, max_new_leads_per_day: 30 });
    expect(calls.map((x) => x.path)).toEqual(['/v1/companies', '/v1/campaigns', '/v1/campaigns/k1/companies']);
  });
});
