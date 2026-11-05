import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { App } from '../src/app.js';
import { type Config, DEFAULTS } from '../src/config.js';
import { openPath } from '../src/db.js';
import type { Page } from '../src/fetcher.js';
import type { Mailer, OutMail } from '../src/mailer.js';
import type { JsonRequest, Model } from '../src/model.js';

export const TUESDAY_NOON = new Date('2026-11-03T17:00:00Z'); // 12:00 in New York

export type TestApp = App & { sent: OutMail[]; calls: JsonRequest[]; clock: { now: Date } };

export function testApp(opts: { pages?: Record<string, Page>; json?: Record<string, unknown>; answers?: Record<string, any | ((r: JsonRequest) => any)>; config?: Partial<Config> } = {}): TestApp {
  const home = mkdtempSync(join(tmpdir(), 'outlevo-'));
  const sent: OutMail[] = []; const calls: JsonRequest[] = []; const clock = { now: TUESDAY_NOON };
  const model: Model = {
    json: async <T,>(r: JsonRequest) => {
      calls.push(r);
      const ans = opts.answers?.[r.name] ?? (r.name === 'verify_email' ? { unsupported: [] } : undefined);
      if (ans === undefined) throw new Error(`No answer for ${r.name}`);
      return (typeof ans === 'function' ? ans(r) : ans) as T;
    },
  };
  const mailer: Mailer = { send: async (m) => { sent.push(m); return { messageId: `<m${sent.length}@test>` }; }, verify: async () => true };
  return {
    db: openPath(join(home, 'test.db')), home, sent, calls, clock, now: () => clock.now, secrets: {},
    config: { ...structuredClone(DEFAULTS), website: 'https://acme-tools.com', sender: { name: 'Sam Lee', company: 'Acme Tools', email: 'sam@getacme.com', postal_address: '1 Main St, Springfield, IL 62701' }, ...opts.config },
    model: () => model, mailer: () => mailer,
    fetchPage: async (url) => { const p = opts.pages?.[url]; if (!p) return null; return p; },
    fetchJson: async (url) => opts.json?.[url] ?? null,
  };
}

export const OK_CHECKS = async () => [{ name: 'all', ok: true, blocking: true, detail: '' }];
