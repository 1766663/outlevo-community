#!/usr/bin/env node
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { makeApp } from './app.js';
import { CloudError, cloudContacts, cloudFind, cloudHandoff, cloudOf, cloudStatus, NeedsConfirm, SIGNUP_URL } from './cloud.js';
import { homeDir, loadConfig, saveConfig, saveSecret, setPath } from './config.js';
import { isStopped, readiness, ready, resumeSending, stopSending, suppress } from './compliance.js';
import { startDashboard } from './dashboard/server.js';
import { all, one } from './db.js';
import { hasErrors, lintEmail, parseEmailFile } from './lint.js';
import { cycle, runLoop } from './loop.js';
import { addCompany, approve, discoverCompanies, getIcp, importCompanies, importContacts, learnIcp, learnProduct, nextToWrite, reject, researchCompany, reviewQueue, writeSequence } from './pipeline.js';
import { checkReplies, sendSuggestedReply } from './replies.js';
import { sendNext } from './send.js';

const HELP = `outlevo: an open-source AI SDR for B2B. Runs on your machine.

Setup
  init [--website URL]             Create .outlevo/ here
  config set <path> <value>        e.g. sender.email, smtp.host, limits.max_per_day
  config show
  doctor                           What must be fixed before anything can send
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
  answer <reply-id>                Send a drafted answer
  suppress <email-or-domain>
  stop | resume                    The kill switch
Running
  run                              Loop: replies, send, write, research
  run --once
  dashboard [--port 5757]          Local page to review and approve
  status
Outlevo Cloud (optional, paid)
  cloud connect <key>              Key from app.outlevo.com, Developers
  cloud status
  cloud find [--brief "..."] [--like domain] [--count 10] [--yes]
  cloud contacts <company-id> [--titles "CEO,CTO"] [--yes]
  cloud handoff --name "..." [--company ID ...]

Add --json for machine-readable output.`;

const { values: flags, positionals: pos } = parseArgs({
  allowPositionals: true, strict: true,
  options: {
    json: { type: 'boolean' }, help: { type: 'boolean', short: 'h' }, yes: { type: 'boolean' }, once: { type: 'boolean' }, 'dry-run': { type: 'boolean' },
    website: { type: 'string' }, won: { type: 'string' }, lost: { type: 'string' }, brief: { type: 'string' }, like: { type: 'string' }, titles: { type: 'string' }, name: { type: 'string' },
    count: { type: 'string' }, limit: { type: 'string' }, port: { type: 'string' }, company: { type: 'string', multiple: true }, contact: { type: 'string' },
  },
});
const num = (v: string | undefined, dflt: number) => { const n = Number(v ?? dflt); if (!Number.isInteger(n) || n <= 0) throw new Error(`Not a positive number: ${v}`); return n; };
const need = (v: string | undefined, what: string) => { if (!v) throw new Error(`Missing ${what}. See: outlevo --help`); return v; };
const output = (data: unknown, human?: string) => console.log(flags.json || human === undefined ? JSON.stringify(data, null, 2) : human);

async function main() {
  const [cmd, sub, arg] = pos;
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
    saveSecret('outlevo_key', need(arg, 'a key'));
    return output({ connected: true }, 'Key saved. Try: outlevo cloud status');
  }

  const a = makeApp();
  switch (cmd) {
    case 'doctor': {
      const checks = await readiness(a);
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
      if (sub === 'import') { const r = importCompanies(a, need(arg, 'a file')); return output(r, `Added ${r.added}. Skipped ${r.skipped.length}.`); }
      if (sub === 'discover') { const r = await discoverCompanies(a, num(flags.count, 10), flags.brief); return output(r, `Added: ${r.added.join(', ') || 'none'}`); }
      const rows = all(a.db, 'select id, domain, name, status, score from companies order by id');
      return output(rows, rows.map((r: any) => `${String(r.id).padStart(4)}  ${r.status.padEnd(13)} ${String(r.score ?? '').padEnd(4)} ${r.domain}`).join('\n') || 'No companies yet.');
    }
    case 'contacts': {
      if (sub === 'import') { const r = importContacts(a, need(arg, 'a file')); return output(r, `Added ${r.added}. Skipped ${r.skipped.length}.`); }
      return output(all(a.db, 'select p.id, p.first_name, p.last_name, p.title, p.email, p.email_source, p.status, c.domain from contacts p join companies c on c.id = p.company_id'));
    }
    case 'research': {
      const ids = flags.company?.length ? flags.company.map(Number) : all<{ id: number }>(a.db, "select id from companies where status = 'new' order by id limit ?", num(flags.limit, 5)).map((r) => r.id);
      const out = [];
      for (const id of ids) { const r = await researchCompany(a, id); out.push(r); if (!flags.json) console.log(`${r.domain}: ${r.status}${'score' in r ? ` (${r.score})` : ''}`); }
      if (flags.json) output(out);
      return;
    }
    case 'write': {
      const ids = flags.contact ? [Number(flags.contact)] : nextToWrite(a, num(flags.limit, 5));
      const out = [];
      for (const id of ids) { const r = await writeSequence(a, id); out.push(r); if (!flags.json) console.log(`Contact ${id}: ${r.status}${r.issues.length ? ` (${r.issues.map((i) => i.message).join('; ')})` : ''}`); }
      if (flags.json) output(out); else if (!ids.length) console.log('Nobody to write to yet: you need contacts with usable addresses at qualified companies.');
      return;
    }
    case 'review': {
      const q = reviewQueue(a);
      return output(q, q.map((g) => [`#${g.contact_id} ${g.name} <${g.email}> at ${g.domain} [${g.status}]`, ...g.emails.map((e: any) => [`  ${e.step}. ${e.subject}`, ...e.body.split('\n').map((l: string) => `     ${l}`), ...e.claims.map((c: any) => `     source: "${c.source?.quote ?? '?'}" ${c.source?.source_url ?? ''}`), ...e.issues.map((i: any) => `     ${i.level}: ${i.message}`)].join('\n'))].join('\n')).join('\n\n') || 'Nothing to review.');
    }
    case 'approve': { const r = approve(a, Number(need(sub, 'a contact id'))); return output(r, `Approved ${r.approved} emails. They send when due, if every guard allows.`); }
    case 'reject': { const r = reject(a, Number(need(sub, 'a contact id'))); return output(r, `Rejected ${r.rejected} emails.`); }
    case 'send': { const r = await sendNext(a, { dryRun: !!flags['dry-run'] }); return output(r, r.sent ? `${flags['dry-run'] ? 'Would send' : 'Sent'}: ${r.subject} to ${r.to}` : r.reason); }
    case 'replies': { const r = await checkReplies(a); return output(r, `Read ${r.read} messages, ${r.handled} from people you wrote to.`); }
    case 'answer': { const r = await sendSuggestedReply(a, Number(need(sub, 'a reply id'))); return output(r, 'Sent.'); }
    case 'suppress': { suppress(a, need(sub, 'an email or a domain'), 'added by hand'); return output({ suppressed: sub }, `Will never write to ${sub}.`); }
    case 'stop': { stopSending(a, 'Stopped by hand'); return output({ stopped: true }, 'All sending stopped.'); }
    case 'resume': { resumeSending(a); return output({ stopped: false }, 'Sending resumed.'); }
    case 'run': {
      const show = (r: unknown) => console.log(`${new Date().toISOString()} ${JSON.stringify(r)}`);
      if (flags.once) return show(await cycle(a));
      const ctl = new AbortController();
      process.on('SIGINT', () => ctl.abort()); process.on('SIGTERM', () => ctl.abort());
      console.log(`Running every ${a.config.loop_minutes} minutes. Ctrl-C to stop. Nothing sends without your approval.`);
      return runLoop(a, show, ctl.signal);
    }
    case 'dashboard': { const d = await startDashboard(a, flags.port ? num(flags.port, 5757) : 5757); console.log(`Open: ${d.url}`); return; }
    case 'status': {
      const count = (sql: string) => one<{ n: number }>(a.db, sql)?.n ?? 0;
      const s = { stopped: isStopped(a), companies: count('select count(*) as n from companies'), qualified: count("select count(*) as n from companies where status = 'qualified'"), contacts: count('select count(*) as n from contacts'), to_review: reviewQueue(a).length, approved: count("select count(*) as n from drafts where status = 'approved'"), sent: count("select count(*) as n from drafts where status = 'sent'"), replies: count('select count(*) as n from replies') };
      return output(s, Object.entries(s).map(([k, v]) => `${k.padEnd(11)} ${v ?? 'no'}`).join('\n'));
    }
    case 'cloud': {
      const c = cloudOf(a);
      if (sub === 'status') { const s = await cloudStatus(c); return output(s, `Plan ${s.plan}, ${s.status}. ${s.credits_available} credits available.`); }
      if (sub === 'find') { const r = await cloudFind(a, c, { ...(flags.brief ? { brief: flags.brief } : {}), ...(flags.like ? { like: flags.like } : {}), count: num(flags.count, 10) }, { yes: !!flags.yes }); return output(r, `Added: ${r.added.join(', ') || 'none'}`); }
      if (sub === 'contacts') { const r = await cloudContacts(a, c, Number(need(arg, 'a company id')), { yes: !!flags.yes, ...(flags.titles ? { titles: flags.titles.split(',').map((t) => t.trim()) } : {}) }); return output(r, `Added ${r.added} verified contacts. ${r.unverified} not verified, left out.`); }
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
  if (e instanceof CloudError && e.status === 402) console.error(`${e.message}\nMore credits: ${SIGNUP_URL}`);
  else if (/authentication method/i.test((e as Error).message)) console.error('No model key. Set ANTHROPIC_API_KEY, or use a local Claude Code: outlevo config set model.provider claude-cli');
  else console.error((e as Error).message);
  process.exitCode = 1;
});
