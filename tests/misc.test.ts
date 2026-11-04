import { mkdtempSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import Anthropic from '@anthropic-ai/sdk';
import { describe, expect, it } from 'vitest';
import { DEFAULTS, loadConfig, loadSecrets, saveConfig, saveSecret, setPath } from '../src/config.js';
import { normalizeDomain, parseCsv } from '../src/csv.js';
import { one } from '../src/db.js';
import { cycle } from '../src/loop.js';
import { AnthropicModel, BudgetExhausted, ClaudeCliModel, metered, ModelRefused, parseJson } from '../src/model.js';
import { addCompany } from '../src/pipeline.js';
import { testApp } from './helpers.js';

describe('csv', () => {
  it('reads quotes, commas, CRLF and a BOM', () => {
    expect(parseCsv('﻿Name,Domain\r\n"Acme, Inc","a""b.com"\r\n\r\nX,y.com')).toEqual([{ name: 'Acme, Inc', domain: 'a"b.com' }, { name: 'X', domain: 'y.com' }]);
  });
  it('normalizes domains and refuses what is not one', () => {
    expect(normalizeDomain('https://www.Acme.com/about?x=1')).toBe('acme.com');
    expect(normalizeDomain('not a domain')).toBeNull();
    expect(normalizeDomain('localhost')).toBeNull();
  });
});

describe('config', () => {
  const home = () => mkdtempSync(join(tmpdir(), 'outlevo-cfg-'));
  it('keeps types and refuses unknown settings', () => {
    const c = structuredClone(DEFAULTS);
    setPath(c, 'limits.max_per_day', '20'); setPath(c, 'smtp.secure', 'false'); setPath(c, 'do_not_contact', '["a.com"]');
    expect([c.limits.max_per_day, c.smtp.secure, c.do_not_contact]).toEqual([20, false, ['a.com']]);
    expect(() => setPath(c, 'limits.nope', '1')).toThrow(/Unknown/);
    expect(() => setPath(c, 'nope.x', '1')).toThrow(/Unknown/);
  });
  it('refuses a date that does not exist', () => {
    const c = structuredClone(DEFAULTS);
    expect(() => setPath(c, 'warmup_start', '2026-02-31')).toThrow(/warmup_start/);
    expect(() => setPath(c, 'warmup_start', '2026-1101')).toThrow(/warmup_start/);
    expect(setPath(c, 'warmup_start', '2026-11-01').warmup_start).toBe('2026-11-01');
  });
  it('fills new defaults into an older file', () => {
    const h = home(); saveConfig({ ...structuredClone(DEFAULTS), website: 'https://x.com' }, h);
    expect(loadConfig(h).website).toBe('https://x.com');
    expect(loadConfig(h).limits.send_hours).toEqual([9, 17]);
  });
  it('stores secrets in a private file, and the environment wins', () => {
    const h = home(); saveSecret('outlevo_key', 'file-key', h);
    expect(statSync(join(h, 'secrets.json')).mode & 0o777).toBe(0o600);
    expect(loadSecrets(h, {}).outlevo_key).toBe('file-key');
    expect(loadSecrets(h, { OUTLEVO_KEY: 'env-key' }).outlevo_key).toBe('env-key');
  });
});

describe('model', () => {
  it('stops at the daily limit and logs each call', async () => {
    const a = testApp(); let calls = 0;
    const m = metered({ json: async <T,>() => { calls++; return {} as T; } }, a.db, 2, a.now);
    const r = { name: 'x', system: '', user: '', schema: {} };
    await m.json(r); await m.json(r);
    await expect(m.json(r)).rejects.toBeInstanceOf(BudgetExhausted);
    expect(calls).toBe(2);
    expect(one<any>(a.db, "select count(*) as n from events where kind = 'model.call'").n).toBe(2);
  });
  it('resets the limit the next day', async () => {
    const a = testApp();
    const m = metered({ json: async <T,>() => ({} as T) }, a.db, 1, a.now);
    const r = { name: 'x', system: '', user: '', schema: {} };
    await m.json(r);
    a.clock.now = new Date(a.clock.now.getTime() + 86_400_000);
    await expect(m.json(r)).resolves.toEqual({});
  });
  it('finds JSON in text around it', () => { expect(parseJson('Here you go:\n{"a":1}\nDone')).toEqual({ a: 1 }); expect(() => parseJson('no')).toThrow(); });
  it('runs claude with no tools and no prompt on the command line', async () => {
    let args: string[] = []; let stdin = '';
    const exec = ((_c: string, a: string[], _o: unknown, cb: (e: null, out: string) => void) => {
      args = a; setImmediate(() => cb(null, JSON.stringify({ result: '{"ok":true}' })));
      return { stdin: { end: (s: string) => { stdin = s; } } };
    }) as any;
    expect(await new ClaudeCliModel('m', exec).json({ name: 'x', system: 'sys', user: 'secret question', schema: {} })).toEqual({ ok: true });
    expect(args.slice(args.indexOf('--tools'), args.indexOf('--tools') + 2)).toEqual(['--tools', '']);
    expect(args.join(' ')).not.toContain('secret question');
    expect(stdin).toContain('secret question');
  });
});

describe('AnthropicModel', () => {
  const r = { name: 'x', system: 'sys', user: 'hello', schema: { type: 'object' } };
  const client = (answer: any, seen: any[]) => new Anthropic({ apiKey: 'k', maxRetries: 0, fetch: (async (_u: string, init: any) => { seen.push({ body: JSON.parse(init.body), headers: new Headers(init.headers) }); return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'm', usage: {}, content: [], ...answer }), { headers: { 'content-type': 'application/json' } }); }) as any });
  it('asks for structured output, with the safety fallback on, and reads the answer', async () => {
    const seen: any[] = [];
    const m = new AnthropicModel('claude-opus-5-5', client({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{"a":1}' }] }, seen));
    expect(await m.json(r)).toEqual({ a: 1 });
    const { body, headers } = seen[0];
    expect(body.output_config).toEqual({ effort: 'medium', format: { type: 'json_schema', schema: r.schema } });
    expect(body.fallbacks).toBe('default');
    expect(headers.get('anthropic-beta')).toContain('server-side-fallback-2026-07-01');
    expect(body.temperature).toBeUndefined();
    expect(body.thinking).toBeUndefined();
  });
  it('leaves the fallback off for another model', async () => {
    const seen: any[] = [];
    await new AnthropicModel('claude-haiku-5-5', client({ stop_reason: 'end_turn', content: [{ type: 'text', text: '{}' }] }, seen)).json(r);
    expect(seen[0].body.fallbacks).toBeUndefined();
  });
  it('reports a refusal and a cut-off answer instead of parsing them', async () => {
    await expect(new AnthropicModel('m', client({ stop_reason: 'refusal', content: [] }, [])).json(r)).rejects.toBeInstanceOf(ModelRefused);
    await expect(new AnthropicModel('m', client({ stop_reason: 'max_tokens', content: [{ type: 'text', text: '{"a"' }] }, [])).json(r)).rejects.toThrow(/cut off/);
  });
  it('keeps going through a paused search, then reads the JSON', async () => {
    const seen: any[] = []; const answers = [{ stop_reason: 'pause_turn', content: [{ type: 'text', text: 'searching' }] }, { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Found: {"companies":[]}' }] }];
    const c = new Anthropic({ apiKey: 'k', maxRetries: 0, fetch: (async (_u: string, init: any) => { seen.push(JSON.parse(init.body)); return new Response(JSON.stringify({ id: 'm', type: 'message', role: 'assistant', model: 'm', usage: {}, ...answers.shift() }), { headers: { 'content-type': 'application/json' } }); }) as any });
    expect(await new AnthropicModel('claude-opus-5-5', c).searchJson({ ...r, maxSearches: 3 })).toEqual({ companies: [] });
    expect(seen).toHaveLength(2);
    expect(seen[0].tools[0].type).toBe('web_search_20260209');
    expect(seen[1].messages[1].role).toBe('assistant');
  });
});

describe('cycle', () => {
  it('does not stop at one failure, and reports it', async () => {
    const a = testApp();
    addCompany(a, 'n.example', 'manual');
    const r = await cycle(a, { send: async () => { throw new Error('smtp down'); } });
    expect(r.errors.join()).toMatch(/smtp down/);
    expect(r.errors.join()).toMatch(/research: Define your ICP/);
  });
});
