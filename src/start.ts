import type { App } from './app.js';
import { findContacts, HunterRefused } from './contacts.js';
import { type Check, ready, readiness } from './compliance.js';
import { normalizeDomain } from './csv.js';
import { all, logEvent, one, run } from './db.js';
import { BudgetExhausted } from './model.js';
import { discoverCompanies, getIcp, learnIcp, learnProduct, nextToWrite, researchCompany, reviewQueue, writeSequence } from './pipeline.js';

export type StartOptions = { count: number; won?: string; lost?: string; brief?: string };

/** This folder belongs to one product. Pointing it at another site must be a choice: its ICP and research would not fit. */
export function prepareSite(a: App, site: string, relearn: boolean) {
  const next = normalizeDomain(site);
  if (!next) throw new Error(`Not a website: ${site}`);
  const was = one<{ url: string }>(a.db, 'select url from product');
  const old = was ? normalizeDomain(was.url) : null;
  if (old && old !== next) {
    if (!relearn) throw new Error(`This folder is set up for ${old}. Use a new folder for ${next}, or add --relearn to read the new site and research every company again.`);
    run(a.db, 'delete from product'); run(a.db, 'delete from product_facts'); run(a.db, 'delete from icp');
    run(a.db, "update companies set status = 'new', score = null, reasons = null where status in ('qualified', 'disqualified')");
    run(a.db, "delete from drafts where status in ('pending', 'blocked', 'rejected')");
    logEvent(a.db, a.now(), 'product.switched', { from: old, to: next });
  }
  a.config.website = site;
}

/** From a website to emails waiting for review. Safe to run again: it picks up where it stopped, and it sends nothing. */
export async function start(a: App, o: StartOptions, say: (line: string) => void, deps: { checks?: () => Promise<Check[]> } = {}) {
  const stopped = (e: unknown) => { if (e instanceof BudgetExhausted) throw e; return (e as Error).message; };
  let stoppedEarly: string | null = null;

  try {
    if (!one(a.db, 'select 1 from product')) {
      say('Reading your website…');
      const p = await learnProduct(a);
      say(`  ${p.summary}`);
    }
    if (!getIcp(a)) {
      say(o.won || o.lost ? 'Learning who buys from your won and lost deals…' : 'Working out who buys. Give --won and --lost CSV files for a far better answer…');
      const icp = await learnIcp(a, { ...(o.won ? { won: o.won } : {}), ...(o.lost ? { lost: o.lost } : {}), ...(o.brief ? { brief: o.brief } : {}) });
      say(`  ${icp.summary}\n  Buyers: ${icp.buyer_titles.join(', ')}`);
    }
    const have = one<{ n: number }>(a.db, 'select count(*) as n from companies')?.n ?? 0;
    if (have < o.count) {
      say(`Looking for ${o.count - have} companies that fit…`);
      try { say(`  Found ${(await discoverCompanies(a, o.count - have, o.brief)).added.length}.`); } catch (e) { say(`  ${stopped(e)}`); }
    }
    const fresh = all<{ id: number; domain: string }>(a.db, "select id, domain from companies where status = 'new' order by id limit ?", o.count);
    if (fresh.length) say(`Researching ${fresh.length} companies from their own sites…`);
    for (const c of fresh) {
      try { const r = await researchCompany(a, c.id); say(`  ${c.domain}: ${r.status}`); } catch (e) { say(`  ${c.domain}: ${stopped(e)}`); }
    }
    if (a.secrets.hunter_key) {
      say('Finding the right person at each company with your Hunter key…');
      try { const r = await findContacts(a, { limit: o.count }); say(`  ${r.added} verified, ${r.not_verified} not verified and left out.`); }
      catch (e) { if (!(e instanceof HunterRefused)) stopped(e); say(`  ${(e as Error).message}`); }
    }
    const people = nextToWrite(a, o.count);
    if (people.length) say(`Writing emails for ${people.length} people…`);
    for (const id of people) {
      try { const r = await writeSequence(a, id); say(`  Contact ${id}: ${r.status === 'blocked' ? 'failed the checks' : 'ready for review'}`); } catch (e) { say(`  Contact ${id}: ${stopped(e)}`); }
    }
  } catch (e) {
    // What is done is saved, so the day's limit is a pause: still say where things stand.
    if (!(e instanceof BudgetExhausted)) throw e;
    stoppedEarly = e.message;
  }

  const qualified = one<{ n: number }>(a.db, "select count(*) as n from companies where status = 'qualified'")?.n ?? 0;
  const noPerson = one<{ n: number }>(a.db, `select count(*) as n from companies c where c.status = 'qualified'
    and not exists (select 1 from contacts p where p.company_id = c.id and p.status = 'active' and p.email_source in ('imported','published','verified'))`)?.n ?? 0;
  const toReview = reviewQueue(a).length;
  const checks = await (deps.checks ? deps.checks() : readiness(a));
  const missing = checks.filter((c) => !c.ok && c.blocking).map((c) => c.name);

  const next: string[] = [];
  if (stoppedEarly) next.push(`${stoppedEarly}. Run this again tomorrow, or raise model.max_calls_per_day, and it carries on from here.`);
  if (noPerson) next.push(`${noPerson} qualified companies have nobody to write to. Set HUNTER_API_KEY and run outlevo contacts find, import a CSV with outlevo contacts import, or use outlevo cloud contacts.`);
  if (toReview) next.push(`Review ${toReview} ${toReview === 1 ? 'sequence' : 'sequences'}: outlevo dashboard`);
  if (!ready(checks)) next.push(`Before anything can send, fix: ${missing.join(', ')}. See outlevo doctor.`);
  if (!a.config.booking_url.trim()) next.push('Add your calendar so an interested reply can book a meeting: outlevo config set booking_url https://cal.com/you');
  next.push('Then keep it running: outlevo run');
  say(`\n${stoppedEarly ? 'Stopped early' : 'Done'}. ${qualified} qualified, ${toReview} ready for review. Nothing was sent.\n\nNext:\n${next.map((n) => `  - ${n}`).join('\n')}`);
  return { qualified, no_person: noPerson, to_review: toReview, ready_to_send: ready(checks), stopped_early: stoppedEarly, next };
}
