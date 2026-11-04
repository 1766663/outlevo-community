import type { App } from './app.js';
import { findContacts } from './contacts.js';
import { all } from './db.js';
import { BudgetExhausted } from './model.js';
import { nextToWrite, researchCompany, writeSequence } from './pipeline.js';
import { checkReplies } from './replies.js';
import { sendNext } from './send.js';

export type CycleReport = { replies?: unknown; send?: unknown; wrote?: number; contacts?: number; researched?: number; errors: string[] };

/** One turn, in order of what matters most. Rules choose what to do; the model is called only when there is work for it. */
export async function cycle(a: App, deps: { replies?: () => Promise<unknown>; send?: () => Promise<unknown> } = {}): Promise<CycleReport> {
  const r: CycleReport = { errors: [] };
  const attempt = async (name: string, fn: () => Promise<void>) => {
    try { await fn(); } catch (e) {
      if (e instanceof BudgetExhausted) r.errors.push((e as Error).message);
      else r.errors.push(`${name}: ${(e as Error).message}`);
    }
  };
  if (a.config.imap.host) await attempt('replies', async () => { r.replies = await (deps.replies ? deps.replies() : checkReplies(a)); });
  await attempt('send', async () => { r.send = await (deps.send ? deps.send() : sendNext(a)); });
  r.contacts = 0;
  if (a.secrets.hunter_key) await attempt('contacts', async () => { r.contacts = (await findContacts(a, { limit: 3 })).added; });
  r.wrote = 0;
  await attempt('write', async () => { for (const id of nextToWrite(a, 3)) { await writeSequence(a, id); r.wrote!++; } });
  r.researched = 0;
  await attempt('research', async () => {
    for (const c of all<{ id: number }>(a.db, "select id from companies where status = 'new' order by id limit 3")) { await researchCompany(a, c.id); r.researched!++; }
  });
  return r;
}

export async function runLoop(a: App, onCycle: (r: CycleReport) => void, signal?: AbortSignal) {
  while (!signal?.aborted) {
    onCycle(await cycle(a));
    await new Promise<void>((res) => { const t = setTimeout(res, a.config.loop_minutes * 60_000); signal?.addEventListener('abort', () => { clearTimeout(t); res(); }, { once: true }); });
  }
}
