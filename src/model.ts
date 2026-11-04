import { execFile } from 'node:child_process';
import Anthropic from '@anthropic-ai/sdk';
import type { Config } from './config.js';
import { type Db, logEvent, one, run } from './db.js';

export type JsonRequest = { name: string; system: string; user: string; schema: Record<string, unknown>; effort?: 'low' | 'medium' | 'high' };
export interface Model {
  json<T>(req: JsonRequest): Promise<T>;
  /** Same, but the model may search the web first. Not every provider can. */
  searchJson?<T>(req: JsonRequest & { maxSearches: number }): Promise<T>;
}

export class BudgetExhausted extends Error { constructor(limit: number) { super(`The daily limit of ${limit} model calls is used up`); } }
export class ModelRefused extends Error {}

const WITH_DEFAULT_FALLBACK = new Set(['claude-opus-5-5', 'claude-opus-5', 'claude-fable-5-1', 'claude-sonnet-5-5']);

export const parseJson = <T>(text: string): T => {
  const start = text.search(/[{[]/); const end = Math.max(text.lastIndexOf('}'), text.lastIndexOf(']'));
  if (start < 0 || end < start) throw new Error('The model did not answer in JSON');
  return JSON.parse(text.slice(start, end + 1)) as T;
};

export class AnthropicModel implements Model {
  constructor(private name: string, private client = new Anthropic()) {}

  async json<T>(r: JsonRequest): Promise<T> {
    const res = await this.client.beta.messages.create({
      model: this.name, max_tokens: 16000, system: r.system, messages: [{ role: 'user', content: r.user }],
      output_config: { effort: r.effort ?? 'medium', format: { type: 'json_schema', schema: r.schema } },
      ...(WITH_DEFAULT_FALLBACK.has(this.name) ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const } : {}),
    });
    if (res.stop_reason === 'refusal') throw new ModelRefused(`The model declined ${r.name}`);
    if (res.stop_reason === 'max_tokens') throw new Error(`The answer to ${r.name} was cut off`);
    const text = res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join('');
    return JSON.parse(text) as T;
  }

  async searchJson<T>(r: JsonRequest & { maxSearches: number }): Promise<T> {
    const messages: Anthropic.MessageParam[] = [{ role: 'user', content: `${r.user}\n\nFinish with only a JSON object matching this schema:\n${JSON.stringify(r.schema)}` }];
    for (let turn = 0; turn < 5; turn++) {
      const res = await this.client.messages.create({
        model: this.name, max_tokens: 16000, system: r.system, messages,
        tools: [{ type: 'web_search_20260209', name: 'web_search', max_uses: r.maxSearches }],
      });
      if (res.stop_reason === 'refusal') throw new ModelRefused(`The model declined ${r.name}`);
      if (res.stop_reason === 'pause_turn') { messages.push({ role: 'assistant', content: res.content }); continue; }
      return parseJson<T>(res.content.flatMap((b) => (b.type === 'text' ? [b.text] : [])).join(''));
    }
    throw new Error(`The search for ${r.name} did not finish`);
  }
}

/** Through a local `claude` install. No tools, and no project setup, reach the model. */
export class ClaudeCliModel implements Model {
  constructor(private name: string, private exec: typeof execFile = execFile) {}
  json<T>(r: JsonRequest): Promise<T> {
    const prompt = `${r.user}\n\nAnswer with only a JSON object matching this schema:\n${JSON.stringify(r.schema)}`;
    return new Promise((resolve, reject) => {
      const child = this.exec('claude', ['-p', '--output-format', 'json', '--model', this.name, '--tools', '', '--system-prompt', r.system],
        { maxBuffer: 20_000_000, timeout: 300_000, cwd: process.env.TMPDIR || '/tmp' }, (err, stdout) => {
          if (err) return reject(new Error(`claude failed: ${err.message}`));
          try {
            const outer = JSON.parse(String(stdout)) as { result?: string; is_error?: boolean };
            if (outer.is_error || !outer.result) return reject(new Error(`claude failed: ${outer.result ?? 'no result'}`));
            resolve(parseJson<T>(outer.result));
          } catch (e) { reject(e as Error); }
        });
      child.stdin?.end(prompt);
    });
  }
}

export const dayOf = (d: Date) => d.toISOString().slice(0, 10);
export function bumpUsage(db: Db, kind: string, at: Date) {
  run(db, 'insert into usage (day, kind, count) values (?, ?, 1) on conflict (day, kind) do update set count = count + 1', dayOf(at), kind);
}
export const usageToday = (db: Db, kind: string, at: Date) => one<{ count: number }>(db, 'select count from usage where day = ? and kind = ?', dayOf(at), kind)?.count ?? 0;

/** Counts every call, and stops at the day's limit if you set one (model.max_calls_per_day). */
export function metered(inner: Model, db: Db, limit: number, now: () => Date = () => new Date()): Model {
  const charge = (name: string) => {
    if (limit > 0 && usageToday(db, 'model_call', now()) >= limit) throw new BudgetExhausted(limit);
    bumpUsage(db, 'model_call', now());
    logEvent(db, now(), 'model.call', { name });
  };
  return {
    json: async (r) => { charge(r.name); return inner.json(r); },
    ...(inner.searchJson ? { searchJson: async (r: any) => { charge(r.name); return inner.searchJson!(r); } } : {}),
  } as Model;
}

export function makeModel(c: Config, db: Db): Model {
  const inner = c.model.provider === 'claude-cli' ? new ClaudeCliModel(c.model.name) : new AnthropicModel(c.model.name);
  return metered(inner, db, c.model.max_calls_per_day);
}
