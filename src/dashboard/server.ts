import { randomBytes, timingSafeEqual } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { App } from '../app.js';
import { dailyLimit, isStopped, readiness, resumeSending, sentToday, stopSending, suppress } from '../compliance.js';
import { all, one, run } from '../db.js';
import { approve, getIcp, reject, reviewQueue } from '../pipeline.js';
import { sendSuggestedReply } from '../replies.js';

const PUBLIC = join(dirname(fileURLToPath(import.meta.url)), 'public');
const ASSETS: Record<string, [string, string]> = { '/app.js': ['app.js', 'text/javascript'], '/style.css': ['style.css', 'text/css'] };
// Scraped pages and strangers' replies end up on this page, so it runs nothing but its own script.
const SECURITY = {
  'content-security-policy': "default-src 'none'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self'; base-uri 'none'; form-action 'none'; frame-ancestors 'none'",
  'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'cache-control': 'no-store',
};

export function dashboardState(a: App) {
  const count = (status: string) => one<{ n: number }>(a.db, 'select count(*) as n from companies where status = ?', status)?.n ?? 0;
  const replies = all<any>(a.db, `select r.id, r.from_addr, r.subject, r.text, r.class, r.reason, r.received_at, r.suggested, r.suggested_status, p.first_name, p.last_name, c.domain
    from replies r left join contacts p on p.id = r.contact_id left join companies c on c.id = p.company_id order by r.received_at desc limit 50`);
  return {
    product: one(a.db, 'select url, summary, updated_at from product') ?? null, icp: getIcp(a),
    stopped: isStopped(a),
    sending: { today: sentToday(a), limit: dailyLimit(a.config, a.now()), from: a.config.sender.email },
    pipeline: { new: count('new'), qualified: count('qualified'), disqualified: count('disqualified'), error: count('error'),
      contacts: one<{ n: number }>(a.db, "select count(*) as n from contacts where status = 'active'")?.n ?? 0,
      approved: one<{ n: number }>(a.db, "select count(*) as n from drafts where status = 'approved'")?.n ?? 0,
      sent: one<{ n: number }>(a.db, "select count(*) as n from drafts where status = 'sent'")?.n ?? 0 },
    review: reviewQueue(a), replies,
    companies: all<any>(a.db, 'select id, domain, name, status, score, reasons, error, researched_at from companies order by coalesce(researched_at, created_at) desc limit 100'),
    events: all<any>(a.db, 'select at, kind, data from events order by id desc limit 40'),
  };
}

export function startDashboard(a: App, port = 5757): Promise<{ server: Server; url: string; token: string }> {
  const token = randomBytes(24).toString('base64url');
  const tokenOk = (given: string | undefined) => {
    if (!given) return false;
    const x = Buffer.from(given); const y = Buffer.from(token);
    return x.length === y.length && timingSafeEqual(x, y);
  };
  const cookieOf = (req: IncomingMessage) => req.headers.cookie?.match(/(?:^|;\s*)ol_session=([^;]+)/)?.[1];

  const json = (res: ServerResponse, status: number, body: unknown) => { res.writeHead(status, { ...SECURITY, 'content-type': 'application/json' }); res.end(JSON.stringify(body)); };
  const readBody = async (req: IncomingMessage) => {
    const parts: Buffer[] = []; let size = 0;
    for await (const c of req) { size += (c as Buffer).length; if (size > 100_000) throw new Error('Too large'); parts.push(c as Buffer); }
    return parts.length ? JSON.parse(Buffer.concat(parts).toString('utf8')) : {};
  };
  const idOf = (b: any) => { const n = Number(b.id); if (!Number.isInteger(n) || n <= 0) throw new Error('A valid id is needed'); return n; };

  const actions: Record<string, (b: any) => unknown> = {
    '/api/approve': (b) => approve(a, idOf(b)),
    '/api/reject': (b) => reject(a, idOf(b)),
    '/api/stop': () => { stopSending(a, 'Stopped from the dashboard'); return { stopped: true }; },
    '/api/resume': () => { resumeSending(a); return { stopped: false }; },
    '/api/reply/send': (b) => sendSuggestedReply(a, idOf(b)),
    '/api/reply/dismiss': (b) => { run(a.db, "update replies set suggested_status = 'dismissed' where id = ? and suggested_status = 'pending'", idOf(b)); return { dismissed: true }; },
    '/api/suppress': (b) => { const v = String(b.value ?? '').trim(); if (!v.includes('.')) throw new Error('An email or a domain is needed'); suppress(a, v, 'added by hand'); return { suppressed: v }; },
  };

  const server = createServer(async (req, res) => {
    try {
      const addr = server.address() as AddressInfo;
      // Bound to loopback, and a page on another site cannot reach it by renaming itself (DNS rebinding).
      if (req.headers.host !== `127.0.0.1:${addr.port}` && req.headers.host !== `localhost:${addr.port}`) return json(res, 403, { error: 'Wrong host' });
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`);

      if (req.method === 'GET' && url.pathname === '/') {
        if (tokenOk(url.searchParams.get('token') ?? undefined)) {
          res.writeHead(303, { ...SECURITY, location: '/', 'set-cookie': `ol_session=${token}; HttpOnly; SameSite=Strict; Path=/` });
          return res.end();
        }
        if (!tokenOk(cookieOf(req))) { res.writeHead(401, { ...SECURITY, 'content-type': 'text/plain' }); return res.end('Open the link that outlevo dashboard printed.'); }
        res.writeHead(200, { ...SECURITY, 'content-type': 'text/html; charset=utf-8' });
        return res.end(readFileSync(join(PUBLIC, 'index.html')));
      }
      if (url.pathname === '/favicon.ico') { res.writeHead(204, SECURITY); return res.end(); }
      const asset = ASSETS[url.pathname];
      if (req.method === 'GET' && asset) { res.writeHead(200, { ...SECURITY, 'content-type': `${asset[1]}; charset=utf-8` }); return res.end(readFileSync(join(PUBLIC, asset[0]))); }
      if (!tokenOk(cookieOf(req))) return json(res, 401, { error: 'Open the link that outlevo dashboard printed' });

      if (req.method === 'GET' && url.pathname === '/api/state') return json(res, 200, dashboardState(a));
      if (req.method === 'GET' && url.pathname === '/api/doctor') return json(res, 200, await readiness(a));
      const action = actions[url.pathname];
      if (req.method === 'POST' && action) {
        // SameSite covers browsers; this covers anything that ignores it.
        if (req.headers['content-type'] !== 'application/json') return json(res, 415, { error: 'JSON only' });
        return json(res, 200, await action(await readBody(req)));
      }
      return json(res, 404, { error: 'Not found' });
    } catch (e) { return json(res, 400, { error: (e as Error).message }); }
  });
  return new Promise((resolve, reject2) => {
    server.once('error', reject2);
    server.listen(port, '127.0.0.1', () => {
      const p = (server.address() as AddressInfo).port;
      resolve({ server, url: `http://127.0.0.1:${p}/?token=${token}`, token });
    });
  });
}
