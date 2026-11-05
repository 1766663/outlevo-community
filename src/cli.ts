#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { createInterface } from 'node:readline/promises';
import { parseArgs } from 'node:util';
import { makeApp } from './app.js';
import { CloudError, cloudContacts, cloudFind, cloudHandoff, cloudOf, cloudStatus, NeedsConfirm, SIGNUP_URL } from './cloud.js';
import { homeDir, loadConfig, saveConfig, saveSecret, setPath } from './config.js';
import { isStopped, readiness, ready, resumeSending, stopSending, suppress } from './compliance.js';
import { startDashboard } from './dashboard/server.js';
import { all, one } from './db.js';
import { hasErrors, lintEmail, parseEmailFile } from './lint.js';
import { findContacts } from './contacts.js';
import { cycle, runLoop } from './loop.js';
import { addCompany, approve, discoverCompanies, dropCompany, rewriteEmails, getIcp, importCompanies, importContacts, learnIcp, learnProduct, nextToWrite, reject, researchCompany, reviewQueue, writeSequence } from './pipeline.js';
import { addMeeting, checkReplies, sendSuggestedReply } from './replies.js';
import { sendNext } from './send.js';
import { buildPack } from './pack.js';
import { importSignals } from './brought.js';
import { prepareSite, start } from './start.js';
import { CONTROL } from './fetcher.js';

const HELP = `outlevo: an open-source AI SDR for B2B. Runs on your machine.

Setup
  init [--website URL]             Create .outlevo/ here
  config set <path> <value>        e.g. sender.email, smtp.host, limits.max_per_day
  config show
  doctor                           What must be fixed before anything can send
Start here
  start <your-site> [--count N] [--won a.csv] [--lost b.csv] [--brief "..."] [--out sales-pack]
                                   Your sales pack: who to sell to, companies, emails. Sends nothing
                                   --count is how many companies to reach, as many as you like (20 if not given)
  pack [--out sales-pack]          Build the pack again from what is here
  rewrite <company> "what to change"   Rewrite its emails. They go through every check again, and approved ones need approving again
  drop <company> [--undo]          Take a company out of the pack and the queue. --undo puts it back
  start <another-site> --relearn   Switch this folder to another product
Know your market
  product learn [URL]              Read your website
  icp learn [--won a.csv] [--lost b.csv] [--brief "..."]
  icp show
Companies and people
  companies add <domain>
  companies import <file.csv>      Column: domain
  companies discover [--count 10] [--brief "..."]    Web search through your model
  companies list
  contacts import <file.csv>       Columns: email, first_name, last_name, title, domain
  contacts find [--limit 5]        With your HUNTER_API_KEY, verified addresses only
  signals import <file.csv>        Posts you found: domain, name, text, post_url (title, date, email optional)
  research [--limit 5] [--company ID]
Emails
  write [--limit 5] [--contact ID]
  review                           What waits for you
  approve <contact-id>             All the emails for that person
  reject <contact-id>
  check <file>                     Check any email against the rules. No key, no network
Sending
  send [--dry-run]                 Send the next email that is due, if every guard allows
  replies                          Read new mail, stop sequences, draft answers
  replies list                     What came in, and the answers waiting
  answer <reply-id>                Send a drafted answer
  meetings                         Meetings booked
  meetings add <contact-id>        Record one by hand
  suppress <email-or-domain>
  stop | resume                    The kill switch
Running
  run                              Loop: replies, send, write, research
  run --once
  dashboard [--port 5757]          Local page to review and approve. Without a terminal it only shows and stops
  status
Outlevo Cloud (optional, paid)
  cloud connect                    Reads the key from stdin, or set OUTLEVO_KEY. From app.outlevo.com, Developers
  cloud status
  cloud find [--brief "..."] [--like domain] [--count 10] [--yes]
  cloud contacts <company-id> [--titles "CEO,CTO"] [--yes]
  cloud handoff --name "..." [--company ID ...]

Add --json for machine-readable output.
Exit codes: 0 done, 1 failed, 2 costs Cloud credits and needs --yes, 3 needs a person at a terminal.
run and dashboard keep running until stopped; run --once does one turn.`;

let parsed;
try {
parsed = parseArgs({
  allowPositionals: true, strict: true,
  options: {
    version: { type: 'boolean', short: 'v' }, json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, yes: { type: 'boolean' }, once: { type: 'boolean' }, relearn: { type: 'boolean' }, undo: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    website: { type: 'string' }, won: { type: 'string' }, lost: { type: 'string' }, brief: { type: 'string' }, like: { type: 'string' }, titles: { type: 'string' }, name: { type: 'string' },
    count: { type: 'string' }, limit: { type: 'string' }, port: { type: 'string' }, out: { type: 'string' }, company: { type: 'string', multiple: true }, contact: { type: 'string' },
  },
});
} catch (e) {
  console.error(`${(e as Error).message.split('. ')[0]}. See: outlevo --help`);
  process.exit(1);
}
const { values: flags, positionals: pos } = parsed;
const num = (v: string | undefined, dflt: number) => { const n = Number(v ?? dflt); if (!Number.isInteger(n) || n <= 0) throw new Error(`Not a positive number: ${v}`); return n; };
const idOf = (v: string | undefined, what: string) => { const n = Number(need(v, what)); if (!Number.isInteger(n) || n <= 0) throw new Error(`${what} must be a number, not ${v}. See the list with --json`); return n; };

/** Approving and answering send real mail to real people, so they wait for a person at a real terminal. Scripts can be let through on purpose. */
async function needsPerson(what: string) {
  if (process.env.OUTLEVO_ALLOW_SCRIPTED_APPROVAL === '1') return;
  if (!process.stdin.isTTY) { const e = new Error(`${what} needs a person. Run it, or outlevo dashboard, in your own terminal.`); (e as any).exit = 3; throw e; }
  const rl = createInterface({ input: process.stdin, output: process.stderr });
  const answer = await rl.question(`${what}. Type yes to go ahead: `);
  rl.close();
  if (answer.trim().toLowerCase() !== 'yes') { const e = new Error('Nothing was done.'); (e as any).exit = 3; throw e; }
}
/** The same line for the dashboard. Its link goes to stdout, so a script that captures stdout must not get a page that can approve. */
const atTerminal = () => process.env.OUTLEVO_ALLOW_SCRIPTED_APPROVAL === '1' || (!!process.stdin.isTTY && !!process.stdout.isTTY);
const need = (v: string | undefined, what: string) => { if (!v) throw new Error(`Missing ${what}. See: outlevo --help`); return v; };
const output = (data: unknown, human?: string) => console.log(flags.json || human === undefined ? JSON.stringify(data, null, 2) : human.replace(CONTROL, ''));

async function main() {
  const [cmd, sub, arg] = pos;
  if (flags.version) return console.log((JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string }).version);
  if (!cmd || flags.help) return console.log(HELP);

  if (cmd === 'init') {
    const c = loadConfig();
    if (flags.website) c.website = flags.website;
    saveConfig(c);
    return output({ home: homeDir() }, `Created ${homeDir()}\nNext:\n  outlevo config set website https://yourcompany.com\n  outlevo product learn\n  outlevo icp learn --won won.csv --lost lost.csv\n  outlevo doctor`);
  }
  if (cmd === 'config') {
    if (sub === 'show') return console.log(JSON.stringify(loadConfig(), null, 2));
    if (sub === 'set') { saveConfig(setPath(loadConfig(), need(arg, 'a setting'), need(pos[3], 'a value'))); return output({ set: arg }, `Set ${arg}`); }
    throw new Error('outlevo config show | set <path> <value>');
  }
  if (cmd === 'check') {
    const { subject, body } = parseEmailFile(readFileSync(need(sub, 'a file'), 'utf8'));
    const issues = lintEmail({ subject, body, strict: false });
    output({ issues }, issues.length ? issues.map((i) => `${i.level === 'error' ? 'ERROR' : 'warn '} ${i.message}`).join('\n') : 'No problems found.\nThis checks the rules only. Checking every claim against its source takes research: outlevo write.');
    if (hasErrors(issues)) process.exitCode = 1;
    return;
  }
  if (cmd === 'cloud' && sub === 'connect') {
    // Typed on the command line it would stay in the shell history, so stdin is the usual way in.
    if (arg) throw new Error('A key on the command line stays in your shell history. Run outlevo cloud connect and paste it when asked, or pipe it in.');
    const key = (process.stdin.isTTY ? await (async () => { const rl = createInterface({ input: process.stdin, output: process.stderr }); const k = await rl.question('Outlevo key: '); rl.close(); return k; })() : readFileSync(0, 'utf8').trim());
    saveSecret('outlevo_key', need(key.trim() || undefined, 'a key'));
    return output({ connected: true }, 'Key saved. Try: outlevo cloud status');
  }

  const a = makeApp();
  switch (cmd) {
    case 'start': {
      prepareSite(a, need(sub ?? a.config.website, 'your website: outlevo start https://yourcompany.com'), !!flags.relearn);
      saveConfig(a.config, a.home);
      const r = await start(a, { count: num(flags.count, 20), ...(flags.out ? { out: flags.out } : {}), ...(flags.won ? { won: flags.won } : {}), ...(flags.lost ? { lost: flags.lost } : {}), ...(flags.brief ? { brief: flags.brief } : {}) }, flags.json ? () => {} : (l) => console.log(l));
      if (flags.json) output(r);
      return;
    }
    case 'rewrite': {
      const r = await rewriteEmails(a, need(sub, 'a company: outlevo rewrite northwind.com "shorter, please"'), need(arg, 'what to change: outlevo rewrite northwind.com "shorter, please"'));
      if (!r.rewritten) {
        output(r, `The new emails failed the checks, so the old ones stay:\n${r.issues.map((i) => `  ${i.message}`).join('\n')}`);
        process.exitCode = 1;
        return;
      }
      const p = buildPack(a, flags.out);
      // A request the quotes cannot support (a claim, a promise) is left out, and saying so beats reprinting the same emails as a change.
      const same = r.unchanged ? '\nNothing changed: what you asked for is not something the quotes about them support, or the emails already did it.' : '';
      return output({ ...r, pack: p.index }, [...r.emails.map((e, i) => `${i + 1}. ${e.subject}\n${e.body}`), `${same}\nUpdated: ${p.index}.${r.approval_reset ? ' These had been approved, so they wait for your approval again.' : ''}`].join('\n\n'));
    }
    case 'drop': {
      const r = dropCompany(a, need(sub, 'a company: outlevo drop northwind.com'), !!flags.undo);
      const p = buildPack(a, flags.out);
      return output({ ...r, pack: p.index }, `${r.domain} is ${r.status === 'dropped' ? 'out of your pack and queue' : `back${r.restored ? `, and ${r.restored} ${r.restored === 1 ? 'email waits' : 'emails wait'} for your approval again` : ''}`}. Pack: ${p.companies} companies.`);
    }
    case 'pack': {
      if (!one(a.db, 'select 1 from product') && !one(a.db, 'select 1 from companies')) throw new Error('Nothing to pack yet. Run: outlevo start https://yourcompany.com');
      const r = buildPack(a, flags.out);
      return output(r, [`${r.companies} companies in ${r.index}`, ...(r.failed.length ? [`Left out, their emails failed the checks: ${r.failed.join(', ')}`] : []), ...(r.unfinished.length ? [`Not finished, outlevo start carries on: ${r.unfinished.join(', ')}`] : []), ...(r.unreadable.length ? [`Could not be read: ${r.unreadable.join(', ')}`] : [])].join('\n'));
    }
    case 'meetings': {
      if (sub === 'add') { addMeeting(a, idOf(arg, 'A contact id'), 'manual', null); return output({ added: true }, 'Recorded.'); }
      const rows = all<any>(a.db, `select m.id, m.status, m.source, m.booked_at, p.first_name, p.last_name, p.email, c.domain from meetings m join contacts p on p.id = m.contact_id join companies c on c.id = p.company_id order by m.booked_at desc`);
      return output(rows, rows.map((m) => `${m.booked_at.slice(0, 10)} ${m.status.padEnd(9)} ${m.first_name} ${m.last_name ?? ''} <${m.email}> ${m.domain}`).join('\n') || 'No meetings yet.');
    }
    case 'doctor': {
      const checks = await readiness(a);
      // The one check that talks to your mail server, so it runs here and not before every send.
      if (a.config.smtp.host && a.secrets.smtp_password) {
        const login = await a.mailer().verify().then(() => null, (e: Error) => e.message);
        checks.push({ name: 'Mailbox login', ok: !login, blocking: true, detail: `Your mail server refused it: ${login}. Check smtp.host, smtp.port, smtp.secure, smtp.user and OUTLEVO_SMTP_PASSWORD` });
      }
      output(checks, checks.map((c) => `${c.ok ? 'ok    ' : c.blocking ? 'NEEDED' : 'advice'} ${c.name}${c.ok ? '' : `: ${c.detail}`}`).join('\n') + `\n\n${ready(checks) ? 'Ready to send.' : 'Sending stays off until everything NEEDED is fixed.'}`);
      if (!ready(checks)) process.exitCode = 1;
      return;
    }
    case 'product': { const r = await learnProduct(a, arg ?? (sub === 'learn' ? undefined : sub) ?? a.config.website); return output(r, `${r.summary}\n\n${r.facts} facts kept, ${r.dropped} dropped because their quote was not on the page.`); }
    case 'icp': {
      if (sub === 'show') return output(getIcp(a) ?? { error: 'No ICP yet: outlevo icp learn' });
      return output(await learnIcp(a, { ...(flags.won ? { won: flags.won } : {}), ...(flags.lost ? { lost: flags.lost } : {}), ...(flags.brief ? { brief: flags.brief } : {}) }));
    }
    case 'companies': {
      if (sub === 'add') { const r = addCompany(a, need(arg, 'a domain'), 'manual'); return output(r, r.added ? `Added ${r.domain} (id ${r.id})` : `${r.domain} is already here (id ${r.id})`); }
      if (sub === 'import') { const r = importCompanies(a, need(arg, 'a file')); return output(r, [`Added ${r.added}. Already here ${r.duplicates}. Skipped ${r.skipped.length}.`, ...r.skipped.map((x) => `  ${x.row}: ${x.reason}`)].join('\n')); }
      if (sub === 'discover') { const r = await discoverCompanies(a, num(flags.count, 10), flags.brief); return output(r, `Added: ${r.added.join(', ') || 'none'}`); }
      const rows = all(a.db, 'select id, domain, name, status, score from companies order by id');
      return output(rows, rows.map((r: any) => `${String(r.id).padStart(4)}  ${r.status.padEnd(13)} ${String(r.score ?? '').padEnd(4)} ${r.domain}`).join('\n') || 'No companies yet.');
    }
    case 'signals': {
      if (sub !== 'import') throw new Error('Usage: outlevo signals import <file.csv>');
      const r = importSignals(a, need(arg, 'a file'));
      return output(r, [`Added ${r.added} posts at ${r.companies.length} companies. Already here ${r.duplicates}. Skipped ${r.skipped.length}.`, ...r.skipped.map((x) => `  ${x.row}: ${x.reason}`),
        ...(r.added ? ['Next: outlevo start (or outlevo research, then outlevo write). Their first email and LinkedIn note open on the post.'] : [])].join('\n'));
    }
    case 'contacts': {
      if (sub === 'import') {
        const r = importContacts(a, need(arg, 'a file'));
        return output(r, [`Added ${r.added}. Already here ${r.duplicates}. Skipped ${r.skipped.length}.`, ...r.skipped.map((x) => `  ${x.row}: ${x.reason}`), ...(r.new_companies.length ? [`New companies from this file, not yet researched: ${r.new_companies.join(', ')}`, 'Next: outlevo research, then outlevo write'] : r.added ? ['Next: outlevo write'] : [])].join('\n'));
      }
      if (sub === 'find') { const r = await findContacts(a, { limit: num(flags.limit, 5) }); return output(r, `Looked at ${r.companies} companies, ${r.added} verified contacts added, ${r.not_verified} addresses not verified and left out.${r.no_buyer ? ` ${r.no_buyer} had nobody in your buyer roles (${(getIcp(a)?.buyer_titles ?? []).join(', ') || 'see outlevo icp show'}) or leading the company: add one with outlevo contacts import.` : ''}${r.added ? ' Next: outlevo write' : ''}`); }
      const people = all<any>(a.db, 'select p.id, p.first_name, p.last_name, p.title, p.email, p.email_source, p.status, c.domain from contacts p join companies c on c.id = p.company_id order by p.id');
      return output(people, people.map((p) => `${String(p.id).padStart(4)}  ${p.status.padEnd(8)} ${p.email_source.padEnd(10)} ${p.first_name} ${p.last_name ?? ''} <${p.email}>${p.title ? `, ${p.title}` : ''}`).join('\n') || 'No contacts yet.');
    }
    case 'research': {
      const ids = flags.company?.length ? flags.company.map((v) => idOf(v, 'A company id')) : all<{ id: number }>(a.db, "select id from companies where status = 'new' order by id limit ?", num(flags.limit, 5)).map((r) => r.id);
      const out = [];
      for (const id of ids) { const r = await researchCompany(a, id); out.push(r); if (!flags.json) console.log(`${r.domain}: ${r.status}${'score' in r ? ` (${r.score})` : ''}`); }
      if (flags.json) output(out);
      return;
    }
    case 'write': {
      const ids = flags.contact ? [idOf(flags.contact, 'A contact id')] : nextToWrite(a, num(flags.limit, 5));
      const out = [];
      for (const id of ids) { const r = await writeSequence(a, id); out.push(r); if (!flags.json) console.log(`Contact ${id}: ${r.status}${r.issues.length ? ` (${r.issues.map((i) => i.message).join('; ')})` : ''}`); }
      if (flags.json) output(out); else if (!ids.length) console.log('Nobody to write to yet: you need contacts with usable addresses at qualified companies.');
      return;
    }
    case 'review': {
      const q = reviewQueue(a);
      return output(q, q.map((g) => [`#${g.contact_id} ${g.name} <${g.email}> at ${g.domain} [${g.status}]`, ...(g.why.length ? [`  Why this company: ${g.why.join('; ')}`] : []), ...g.emails.map((e: any) => [`  ${e.step}. ${e.subject}`, ...e.body.split('\n').map((l: string) => `     ${l}`), ...e.claims.map((c: any) => `     source: "${c.source?.quote ?? '?'}" ${c.source?.source_url ?? ''}`), ...e.issues.map((i: any) => `     ${i.level}: ${i.message}`)].join('\n'))].join('\n')).join('\n\n') || 'Nothing to review.');
    }
    case 'approve': {
      const id = idOf(sub, 'A contact id');
      const q = reviewQueue(a).find((g) => g.contact_id === id);
      if (q && !flags.json) console.error(q.emails.map((e: any) => `${e.step}. ${e.subject}\n${e.body}`).join('\n\n'));
      await needsPerson(`Approve ${q ? `${q.emails.length} emails to ${q.email}` : `the emails for contact ${id}`}`);
      const r = approve(a, id, q?.fingerprint ?? undefined); return output(r, `Approved ${r.approved} emails. They send when due, if every guard allows.`); }
    case 'reject': {
      const r = reject(a, idOf(sub, 'A contact id'));
      if (!r.rejected) throw new Error(`Nothing waits for review for contact ${sub}`);
      return output(r, `Rejected ${r.rejected} emails.`); }
    case 'send': { const r = await sendNext(a, { dryRun: !!flags['dry-run'] }); return output(r, r.sent ? `${flags['dry-run'] ? 'Would send' : 'Sent'}: ${r.subject} to ${r.to}` : r.reason); }
    case 'replies': {
      if (sub !== 'list') {
        const r = await checkReplies(a);
        if (!flags.json) console.log(`Read ${r.read} messages, ${r.handled} from people you wrote to.`);
        else return output(r);
      }
      const rows = all<any>(a.db, 'select id, from_addr, class, reason, suggested, suggested_status, verified from replies order by id desc limit 50');
      if (sub === 'list') return output(rows, rows.map((x) => `#${x.id} ${x.class.padEnd(13)} ${x.from_addr}${x.verified === 0 ? '  (sender not verified)' : ''}${x.suggested_status === 'pending' ? `  answer waiting: outlevo answer ${x.id}` : ''}`).join('\n') || 'No replies yet.');
      const waiting = rows.filter((x) => x.suggested_status === 'pending');
      if (waiting.length) console.log(waiting.map((x) => `Answer waiting for ${x.from_addr}: outlevo answer ${x.id}`).join('\n'));
      return;
    }
    case 'answer': {
      const id = idOf(sub, 'A reply id');
      const w = one<{ from_addr: string; suggested: string | null; verified: number | null }>(a.db, 'select from_addr, suggested, verified from replies where id = ?', id);
      if (w?.suggested && !flags.json) console.error(`To ${w.from_addr}${w.verified === 0 ? ' (sender not verified: this could be forged)' : ''}:\n${w.suggested.replace(CONTROL, '')}`);
      await needsPerson(`Send this answer${w ? ` to ${w.from_addr}` : ''}`);
      const r = await sendSuggestedReply(a, id); return output(r, 'Sent.'); }
    case 'suppress': { suppress(a, need(sub, 'an email or a domain'), 'added by hand'); return output({ suppressed: sub }, `Will never write to ${sub}.`); }
    case 'stop': { stopSending(a, 'Stopped by hand'); return output({ stopped: true }, 'All sending stopped.'); }
    case 'resume': { await needsPerson('Resume all sending'); resumeSending(a); return output({ stopped: false }, 'Sending resumed.'); }
    case 'run': {
      const show = (r: unknown) => console.log(flags.json ? JSON.stringify(r) : `${new Date().toISOString()} ${JSON.stringify(r)}`);
      if (flags.once) return show(await cycle(a));
      const ctl = new AbortController();
      process.on('SIGINT', () => ctl.abort()); process.on('SIGTERM', () => ctl.abort());
      console.error(`Running every ${a.config.loop_minutes} minutes. Ctrl-C to stop. Nothing sends without your approval.`);
      return runLoop(a, show, ctl.signal);
    }
    case 'dashboard': {
      const person = atTerminal();
      const d = await startDashboard(a, flags.port ? num(flags.port, 5757) : 5757, { person });
      if (flags.json) console.log(JSON.stringify({ url: d.url, can_approve: person }));
      else console.log(`Open: ${d.url}${person ? '' : '\nView only: started without a terminal, so it cannot approve, answer or resume sending.'}`);
      return;
    }
    case 'status': {
      const count = (sql: string) => one<{ n: number }>(a.db, sql)?.n ?? 0;
      const s = { stopped: isStopped(a), companies: count('select count(*) as n from companies'), qualified: count("select count(*) as n from companies where status = 'qualified'"), contacts: count('select count(*) as n from contacts'), meetings: count("select count(*) as n from meetings where status = 'booked'"), to_review: reviewQueue(a).length, approved: count("select count(*) as n from drafts where status = 'approved'"), sent: count("select count(*) as n from drafts where status = 'sent'"), replies: count('select count(*) as n from replies') };
      return output(s, Object.entries(s).map(([k, v]) => `${k.padEnd(11)} ${v ?? 'no'}`).join('\n'));
    }
    case 'cloud': {
      const c = cloudOf(a);
      if (sub === 'status') { const s = await cloudStatus(c); return output(s, `Plan ${s.plan}, ${s.status}. ${s.credits_available} credits available.`); }
      if (sub === 'find') { const r = await cloudFind(a, c, { ...(flags.brief ? { brief: flags.brief } : {}), ...(flags.like ? { like: flags.like } : {}), count: num(flags.count, 10) }, { yes: !!flags.yes }); return output(r, `Added: ${r.added.join(', ') || 'none'}`); }
      if (sub === 'contacts') { const r = await cloudContacts(a, c, idOf(arg, 'A company id'), { yes: !!flags.yes, ...(flags.titles ? { titles: flags.titles.split(',').map((t) => t.trim()) } : {}) }); return output(r, `Added ${r.added} verified contacts. ${r.unverified} not verified, left out.`); }
      if (sub === 'handoff') {
        const ids = flags.company?.length ? flags.company.map(Number) : all<{ id: number }>(a.db, "select id from companies where status = 'qualified' limit 50").map((r) => r.id);
        if (!ids.length) throw new Error('No qualified companies to hand over');
        const r = await cloudHandoff(a, c, ids, need(flags.name, '--name'));
        const added = r.companies.filter((x) => x.added);
        const left = r.companies.filter((x) => !x.added).map((x) => `  ${x.domain}: ${x.reason ?? 'not added'}`);
        return output(r, [`Campaign created with ${added.length} of ${r.companies.length} companies. Nothing was sent.`, ...left, `Finish it and launch it: ${r.url}`].join('\n'));
      }
      throw new Error('outlevo cloud connect | status | find | contacts | handoff');
    }
    default: throw new Error(`Unknown command: ${cmd}. See: outlevo --help`);
  }
}

main().catch((e) => {
  if (e instanceof NeedsConfirm) { console.error(e.message); process.exitCode = 2; return; }
  if ((e as any).exit) { console.error((e as Error).message); process.exitCode = (e as any).exit; return; }
  if (e instanceof CloudError && e.status === 402) console.error(`${e.message}\nMore credits: ${SIGNUP_URL}`);
  else if (/authentication method/i.test((e as Error).message)) console.error('No model key. Set ANTHROPIC_API_KEY, or use the local command-line tool from Anthropic: outlevo config set model.provider local-cli');
  else console.error((e as Error).message);
  process.exitCode = 1;
});
