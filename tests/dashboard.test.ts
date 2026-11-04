import { request } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import { isStopped } from '../src/compliance.js';
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
  it('answers a bad request with its reason', async () => {
    const { call, cookie } = await start();
    const r = await call('/api/approve', { method: 'POST', headers: { cookie, 'content-type': 'application/json' }, body: '{"id":"x"}' });
    expect(r.status).toBe(400);
    expect(JSON.parse(r.body).error).toMatch(/valid id/);
  });
});
