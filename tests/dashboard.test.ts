import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { isStopped } from '../src/compliance.js';
import { logEvent, run } from '../src/db.js';
import { startDashboard } from '../src/dashboard/server.js';
import { testApp } from './helpers.js';

let close: (() => void) | undefined;
afterEach(() => close?.());

async function start() {
  const a = testApp();
  const d = await startDashboard(a, 0);
  close = () => d.server.close();
  const u = new URL(d.url);
  const call = (path: string, o: { method?: string; headers?: Record<string, string>; body?: string } = {}) =>
    new Promise<{ status: number; headers: any; body: string }>((res, rej) => {
      const r = request({ host: '127.0.0.1', port: u.port, path, method: o.method ?? 'GET', headers: o.headers }, (m) => {
        let body = ''; m.on('data', (c) => (body += c)); m.on('end', () => res({ status: m.statusCode!, headers: m.headers, body }));
      });
      r.on('error', rej); r.end(o.body);
    });
  const login = await call(`/?token=${d.token}`);
  const cookie = String(login.headers['set-cookie'][0]).split(';')[0]!;
  return { a, d, call, cookie, u };
}

describe('dashboard', () => {
  it('listens only on loopback', async () => { const { d } = await start(); expect((d.server.address() as any).address).toBe('127.0.0.1'); });
  it('turns the link into an HttpOnly, SameSite cookie', async () => {
    const { d, call } = await start();
    const r = await call(`/?token=${d.token}`);
    expect(r.status).toBe(303);
    expect(r.headers['set-cookie'][0]).toMatch(/HttpOnly; SameSite=Strict/);
  });
  it('refuses the page and the API without the token', async () => {
    const { call } = await start();
    expect((await call('/')).status).toBe(401);
    expect((await call('/api/state')).status).toBe(401);
    expect((await call('/?token=wrong')).status).toBe(401);
    expect((await call('/api/stop', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })).status).toBe(401);
  });
  it('refuses another Host header, so DNS rebinding gets nothing', async () => {
    const { call, cookie } = await start();
    expect((await call('/api/state', { headers: { host: 'evil.example', cookie } })).status).toBe(403);
  });
  it('accepts only JSON posts, which a plain cross-site form cannot send', async () => {
    const { a, call, cookie } = await start();
    const r = await call('/api/stop', { method: 'POST', headers: { cookie, 'content-type': 'application/x-www-form-urlencoded' }, body: 'x=1' });
    expect(r.status).toBe(415);
    expect(isStopped(a)).toBeNull();
  });
  it('the page allows only its own script', async () => {
    const { call, cookie } = await start();
    const r = await call('/', { headers: { cookie } });
    expect(r.status).toBe(200);
    expect(r.headers['content-security-policy']).toMatch(/script-src 'self'/);
    expect(r.body).not.toMatch(/<script>/);
  });
  it('stops sending from the button, and reports state', async () => {
    const { a, call, cookie } = await start();
    const r = await call('/api/stop', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{}' });
    expect(r.status).toBe(200);
    expect(isStopped(a)).toMatch(/dashboard/);
    expect(JSON.parse((await call('/api/state', { headers: { cookie } })).body).stopped).toMatch(/dashboard/);
  });
  it('counts the charts over everything, not only the rows it lists', async () => {
    const { a, call, cookie } = await start();
    const now = a.now().toISOString(); const old = '2020-01-01T10:00:00.000Z';
    for (let i = 0; i < 250; i++) run(a.db, "insert into companies (domain, source, status, score, created_at) values (?, 'csv', 'qualified', 70, ?)", `c${i}.com`, now);
    run(a.db, "insert into company_segments (company_id, segment) select id, 'software' from companies where id <= 2");
    run(a.db, "update companies set status = 'disqualified', score = 10 where id = 2");
    run(a.db, "insert into contacts (company_id, first_name, email, email_source, created_at) values (1, 'D', 'd@c0.com', 'imported', ?)", now);
    for (const [step, at] of [[1, now], [2, old]] as const) run(a.db, "insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at, sent_at) values (1, ?, 's', 'b', '[]', '[]', 'sent', ?, ?)", step, now, at);
    run(a.db, "insert into replies (contact_id, from_addr, class, received_at) values (1, 'd@c0.com', 'interested', ?)", now);
    run(a.db, "insert into meetings (contact_id, source, booked_at) values (1, 'manual', ?)", now);
    const s = JSON.parse((await call('/api/state', { headers: { cookie } })).body);
    const c = s.charts; const step = (l: string) => c.funnel.find((x: any) => x.label === l).n;
    expect(s.companies).toHaveLength(200);
    expect(step('Companies looked at')).toBe(250);
    expect(step('Fit who you sell to')).toBe(249);
    expect([step('Written to'), step('Replied'), step('Meetings booked')]).toEqual([1, 1, 1]);
    expect(c.scores.find((b: any) => b.label === '60–79').n).toBe(249);
    expect(c.scores.find((b: any) => b.label === '0–19').n).toBe(1);
    expect(c.sent_by_day).toHaveLength(14);
    expect(c.sent_by_day.at(-1).n).toBe(1); // the old send is outside the 14 days
    expect(c.rates).toMatchObject({ people_written: 1, replied: 1, booked: 1, bounced: 0 });
    expect(c.industries).toEqual([{ segment: 'software', fit: 1, other: 1 }]);
    expect(c.reply_kinds).toEqual([{ label: 'interested', n: 1 }]);
  });
  it('serves the charts, and they set no style attribute the page rules would refuse', async () => {
    const { call, cookie } = await start();
    const js = await call('/charts.js', { headers: { cookie } });
    expect(js.status).toBe(200);
    expect(js.body).not.toMatch(/setAttribute\('style'|innerHTML/);
    expect((await call('/app.js', { headers: { cookie } })).body).not.toMatch(/innerHTML/);
  });
  it('leaves model calls out of the activity list', async () => {
    const { a, call, cookie } = await start();
    logEvent(a.db, a.now(), 'model.call', { name: 'write' }); logEvent(a.db, a.now(), 'email.sent', { contact_id: 1 });
    expect(JSON.parse((await call('/api/state', { headers: { cookie } })).body).events.map((e: any) => e.kind)).toEqual(['email.sent']);
  });
  it('answers a bad request with its reason', async () => {
    const { call, cookie } = await start();
    const r = await call('/api/approve', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"id":"x"}' });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/valid id/);
  });
});
