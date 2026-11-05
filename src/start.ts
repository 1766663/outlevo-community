import type { App } from './app.js';
import { findContacts, HunterRefused } from './contacts.js';
import { type Check, ready, readiness } from './compliance.js';
import { normalizeDomain } from './csv.js';
import { all, logEvent, one, run } from './db.js';
import { BudgetExhausted } from './model.js';
import { buildPack, checkPackFolder } from './pack.js';
import { companiesToWrite, discoverCompanies, getIcp, learnIcp, learnProduct, nextToWrite, researchCompany, reviewQueue, writeForCompany, writeSequence } from './pipeline.js';

export type StartOptions = { count: number; won?: string; lost?: string; brief?: string; out?: string };

const WORKERS = 4;
const UNLIMITED = 1_000_000;
const SEARCH_PASSES = 3;
/** A first run is many slow model calls. A few at a time turns an hour into minutes. */
async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let next = 0; let failed: unknown;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length && failed === undefined) { const item = items[next++]!; try { await fn(item); } catch (e) { failed = e; } }
  }));
  if (failed !== undefined) throw failed;
}

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
    run(a.db, 'delete from company_emails'); run(a.db, 'delete from linkedin_notes');
    logEvent(a.db, a.now(), 'product.switched', { from: old, to: next });
  }
  a.config.website = site;
}

/** From a website to emails waiting for review. Safe to run again: it picks up where it stopped, and it sends nothing. */
export async function start(a: App, o: StartOptions, say: (line: string) => void, deps: { checks?: () => Promise<Check[]> } = {}) {
  const stopped = (e: unknown) => { if (e instanceof BudgetExhausted) throw e; return (e as Error).message; };
  let stoppedEarly: string | null = null;
  checkPackFolder(o.out);
  // New ones, and those whose site could not be read last time: a failed read costs no model call.
  const research = async (where: string) => {
    const fresh = all<{ id: number; domain: string }>(a.db, `select id, domain from companies where ${where} order by id`);
    if (fresh.length) say(`Researching ${fresh.length} companies from their own sites…`);
    await pool(fresh, WORKERS, async (c) => {
      try { const r = await researchCompany(a, c.id); say(`  ${c.domain}: ${r.status}`); } catch (e) { say(`  ${c.domain}: ${stopped(e)}`); }
    });
  };

  try {
    if (!one(a.db, 'select 1 from product')) {
      say('Reading your website…');
      const p = await learnProduct(a);
      say(`  ${p.summary}`);
    }
    if (!getIcp(a)) {
      say(o.won || o.lost ? 'Learning who buys from your won and lost deals…' : 'Working out who buys. Give --won and --lost CSV files for a far better answer…');
      const icp = await learnIcp(a, { ...(o.won ? { won: o.won } : {}), ...(o.lost ? { lost: o.lost } : {}), ...(o.brief ? { brief: o.brief } : {}) });
      if (o.won || o.lost) {
        say(`  Read ${icp.deals_read.won.length} won (${icp.deals_read.won.join(', ') || 'none'}) and ${icp.deals_read.lost.length} lost (${icp.deals_read.lost.join(', ') || 'none'}).`);
        for (const x of icp.deals_read.skipped) say(`  Left out ${x.row}: ${x.reason}.`);
      }
      say(`  ${icp.summary}\n  Buyers: ${icp.buyer_titles.join(', ')}`);
    }
    await research("status in ('new', 'error')");
    // The count is what you get, so a company that did not fit, could not be read or was dropped is searched for again. A few passes, then the summary says what is short.
    for (let pass = 0; pass < SEARCH_PASSES; pass++) {
      const short = o.count - (one<{ n: number }>(a.db, "select count(*) as n from companies where status in ('new', 'qualified')")?.n ?? 0);
      if (short <= 0) break;
      say(`Looking for ${short} ${short === 1 ? 'company' : 'companies'} that fit…`);
      let added: string[] = []; let failed = false;
      try { added = (await discoverCompanies(a, short, o.brief)).added; say(`  Found ${added.length}${added.length ? `: ${added.join(', ')}` : ''}.`); } catch (e) { say(`  ${stopped(e)}`); failed = true; }
      // A search that failed can still have saved what the others found.
      await research("status = 'new'");
      if (failed || !added.length) break;
    }
    if (a.secrets.hunter_key) {
      say('Finding the right person at each company with your Hunter key…');
      try { const r = await findContacts(a, { limit: UNLIMITED }); say(`  ${r.added} verified, ${r.not_verified} not verified and left out.`); }
      catch (e) { if (!(e instanceof HunterRefused)) stopped(e); say(`  ${(e as Error).message}`); }
    }
    const people = nextToWrite(a, UNLIMITED); const nobody = companiesToWrite(a, UNLIMITED);
    if (people.length + nobody.length) say(`Writing emails for ${people.length + nobody.length} companies…`);
    await pool(people, WORKERS, async (id) => {
      try { const r = await writeSequence(a, id); say(`  ${r.domain}: ${r.status === 'blocked' ? 'failed the checks' : 'ready'}`); } catch (e) { say(`  Contact ${id}: ${stopped(e)}`); }
    });
    await pool(nobody, WORKERS, async (id) => {
      try { const r = await writeForCompany(a, id); say(`  ${r.domain}: ${r.status === 'blocked' ? 'failed the checks' : 'ready'}`); } catch (e) { say(`  Company ${id}: ${stopped(e)}`); }
    });
  } catch (e) {
    // What is done is saved, so the day's limit is a pause: still say where things stand.
    if (!(e instanceof BudgetExhausted)) throw e;
    stoppedEarly = e.message;
  }

  const pack = buildPack(a, o.out);
  const mix = all<{ segment: string; n: number }>(a.db, "select s.segment, count(*) as n from company_segments s join companies c on c.id = s.company_id where c.status = 'qualified' group by s.segment order by n desc");
  if (mix.length) say(`\nBy industry: ${mix.map((m) => `${m.segment} ${m.n}`).join(', ')}.`);
  const qualified = one<{ n: number }>(a.db, "select count(*) as n from companies where status = 'qualified'")?.n ?? 0;
  const noPerson = one<{ n: number }>(a.db, `select count(*) as n from companies c where c.status = 'qualified'
    and not exists (select 1 from contacts p where p.company_id = c.id and p.status = 'active' and p.email_source in ('imported','published','verified'))`)?.n ?? 0;
  const toReview = reviewQueue(a).length;
  const checks = await (deps.checks ? deps.checks() : readiness(a));
  const missing = checks.filter((c) => !c.ok && c.blocking).map((c) => c.name);

  const next: string[] = [];
  if (stoppedEarly) next.push(`${stoppedEarly}. Run this again tomorrow, or raise model.max_calls_per_day, and it carries on from here.`);
  if (pack.companies < o.count) {
    const outOf = (status: string) => one<{ n: number }>(a.db, 'select count(*) as n from companies where status = ?', status)?.n ?? 0;
    next.push(`You asked for ${o.count} and have ${pack.companies}. Did not fit: ${outOf('disqualified')}. Dropped by you: ${outOf('dropped')}.${outOf('new') + outOf('qualified') < o.count ? ' Run this again to search for more.' : ''}`);
  }
  if (pack.failed.length) next.push(`Emails failed the checks, so these are left out: ${pack.failed.join(', ')}. Try: outlevo rewrite ${pack.failed[0]} "what to change"`);
  if (pack.unfinished.length) next.push(`Not finished: ${pack.unfinished.join(', ')}. Run this again to carry on.`);
  if (pack.unreadable.length) next.push(`Could not read: ${pack.unreadable.join(', ')}. Run this again to try once more.`);
  next.push(`Open your pack: ${pack.index}`);
  if (noPerson) next.push(`To send: ${noPerson} ${noPerson === 1 ? 'company needs' : 'companies need'} a person. Set HUNTER_API_KEY and run outlevo contacts find, import a list with outlevo contacts import, or use outlevo cloud contacts.`);
  if (toReview) next.push(`Approve what goes out: outlevo review, or outlevo dashboard for a page in your browser.`);
  if (!ready(checks)) next.push(`To send from your own mailbox, fix: ${missing.join(', ')}. See outlevo doctor.`);
  say(`\n${stoppedEarly ? 'Stopped early' : 'Your sales pack is ready'}: ${pack.companies} companies with emails, ${pack.dir}. Nothing was sent.\n\nNext:\n${next.map((n) => `  - ${n}`).join('\n')}`);
  return { pack, qualified, no_person: noPerson, to_review: toReview, ready_to_send: ready(checks), missing, review_ids: reviewQueue(a).map((g) => g.contact_id), stopped_early: stoppedEarly, by_industry: mix, next };
}
