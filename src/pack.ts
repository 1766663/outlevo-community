import { existsSync, mkdirSync, renameSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import type { App } from './app.js';
import { all, logEvent, one } from './db.js';
import { getIcp } from './pipeline.js';

export const CLOUD_URL = 'https://outlevo.com/?utm_source=community&utm_medium=pack';
/** Outlevo's team runs it: Managed, or pay per booked meeting by application. */
export const DONE_FOR_YOU_URL = 'https://outlevo.com/done-for-you/?utm_source=community&utm_medium=pack';

const esc = (s: unknown) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);
const webUrl = (u: string) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; } };
// A spreadsheet would run a cell that starts like a formula, and these cells hold text from strangers' websites.
const csvCell = (v: unknown) => { const s = /^\s*[=+\-@]/.test(String(v ?? '')) ? `'${v}` : String(v ?? ''); return /[",\n\r]/.test(s) ? `"${s.replaceAll('"', '""')}"` : s; };

// Scraped text ends up in these files, and a Markdown viewer would load an image, run a tag or dress up a link in it. Only a plain <address> stays.
const inertMd = (md: string) => md.replace(/!\[/g, '!\\[').replace(/\]\(/g, ']\\(').replace(/<(?![^\s<>@]+@[^\s<>@]+>)/g, '&lt;');

type Email = { step: number; sent: boolean; subject: string; body: string; delay_days: number; claims: Array<{ text: string; source: { quote: string; source_url: string } | null }> };
type Linkedin = { note: string; message: string; sources: Array<{ text: string; source: { quote: string; source_url: string } | null }> };
export type PackCompany = { id: number; domain: string; name: string | null; score: number | null; why: string[]; to: string; person: string | null; email: string | null; emails: Email[]; blocked: boolean; linkedin: Linkedin | null };

export function packData(a: App): PackCompany[] {
  const companies = all<{ id: number; domain: string; name: string | null; score: number | null; reasons: string | null }>(a.db, "select id, domain, name, score, reasons from companies where status = 'qualified' order by coalesce(score, 0) desc, id");
  const withSources = (claims: string) => (JSON.parse(claims) as Array<{ text: string; fact_id: number }>).map((c) => ({ text: c.text, source: one<{ quote: string; source_url: string }>(a.db, 'select quote, source_url from facts where id = ?', c.fact_id) ?? null }));
  return companies.map((c) => {
    const person = one<{ id: number; first_name: string; last_name: string | null; title: string | null; email: string }>(a.db, `select p.id, p.first_name, p.last_name, p.title, p.email from contacts p join drafts d on d.contact_id = p.id where p.company_id = ? and d.status in ('pending','approved','blocked','sent') order by p.id limit 1`, c.id);
    const drafts = person ? all<any>(a.db, "select step, subject, body, claims, delay_days, status from drafts where contact_id = ? and status in ('pending','approved','blocked','sent') order by step", person.id) : [];
    const own = all<any>(a.db, 'select step, subject, body, claims, delay_days, blocked, to_title from company_emails where company_id = ? order by step', c.id);
    const rows = drafts.length ? drafts : own;
    const li = one<{ note: string; message: string; claims: string }>(a.db, 'select note, message, claims from linkedin_notes where company_id = ?', c.id);
    return {
      linkedin: li ? { note: li.note, message: li.message, sources: withSources(li.claims) } : null,
      id: c.id, domain: c.domain, name: c.name, score: c.score, why: (JSON.parse(c.reasons ?? '{}').reasons ?? []).map((r: { text: string }) => r.text),
      to: person ? `${person.first_name} ${person.last_name ?? ''}`.trim() + (person.title ? `, ${person.title}` : '') : own[0]?.to_title ?? '',
      person: person ? `${person.first_name} ${person.last_name ?? ''}`.trim() : null, email: person?.email ?? null,
      blocked: rows.some((r) => r.status === 'blocked' || r.blocked === 1),
      emails: rows.map((r) => ({ step: r.step, sent: r.status === 'sent', subject: r.step > 1 && rows[0]?.step === 1 ? `Re: ${rows[0].subject}` : r.subject, body: r.body, delay_days: r.delay_days, claims: withSources(r.claims) })),
    };
  });
}

function emailMd(c: PackCompany) {
  const head = [`# ${c.name ?? c.domain}`, '', `Website: https://${c.domain}`, `Write to: ${c.to || 'the person who owns this problem'}${c.email ? ` <${c.email}>` : ''}`, ...(c.why.length ? ['', `Why this company: ${c.why.join('; ')}`] : [])];
  const mails = c.emails.map((e) => [`## ${e.step === 1 ? 'First email' : `Follow-up ${e.step - 1}, after ${e.delay_days} days`}${e.sent ? ' (already sent)' : ''}`, '', `Subject: ${e.subject}`, '', e.body, ...(e.claims.length ? ['', 'Sources:', ...e.claims.map((x) => `- "${x.source?.quote ?? x.text}" ${x.source?.source_url ?? ''}`)] : [])].join('\n'));
  return [...head, '', ...mails.flatMap((m) => [m, ''])].join('\n');
}

/** The notes to send by hand from your own LinkedIn: nothing here touches LinkedIn. */
function linkedinMd(ready: PackCompany[]) {
  const with_ = ready.filter((c) => c.linkedin);
  return [
    '# LinkedIn, by hand', '',
    'A connection note and one follow-up for each company, from the same quotes as the emails. Send them yourself from your own LinkedIn: this tool never touches LinkedIn.', '',
    'Two ways to use them:', '',
    '- **LinkedIn first.** Send the note today. If they accept, send the follow-up; if they do not reply within a few days, send the first email.',
    '- **Email first.** Send the first email, then the note a few days later, saying nothing about the email.', '',
    'A note can be up to 300 characters on a paid LinkedIn account, 200 on a free one. Find the person by the title under "Write to".', '',
    ...with_.flatMap((c) => [`## ${c.name ?? c.domain}`, '', `Write to: ${c.to || 'the person who owns this problem'}`, '', '**Connection note**', '', c.linkedin!.note, '', '**After they accept**', '', c.linkedin!.message, '',
      ...(c.linkedin!.sources.length ? ['Sources:', ...c.linkedin!.sources.map((x) => `- "${x.source?.quote ?? x.text}" ${x.source?.source_url ?? ''}`), ''] : [])]),
    ...(with_.length ? [] : ['No LinkedIn notes passed the checks this time. The emails are in emails/.', '']),
  ].join('\n');
}

type Left = { failed: string[]; unfinished: string[]; unreadable: string[] };
const domainsWhere = (a: App, where: string) => all<{ domain: string }>(a.db, `select domain from companies c where ${where} order by id`).map((c) => c.domain);

function page(a: App, ready: PackCompany[], left: Left) {
  const icp = getIcp(a); const product = one<{ summary: string; url: string }>(a.db, 'select summary, url from product');
  const sentCount = ready.flatMap((c) => c.emails).filter((e) => e.sent).length;
  const cards = ready.map((c) => {
    const first = c.emails[0];
    const src = (e: Email) => e.claims.map((x) => { const u = x.source ? webUrl(x.source.source_url) : null; return `<p class="src">“${esc(x.source?.quote ?? x.text)}”${u ? ` <a href="${esc(u)}" rel="noopener noreferrer">source</a>` : ''}</p>`; }).join('');
    const sent = (e: Email) => e.sent ? ' <span class="sent">already sent</span>' : '';
    const later = c.emails.slice(1).map((e) => `<details><summary>Follow-up ${e.step - 1}, after ${esc(e.delay_days)} days${sent(e)}</summary><p class="subj">${esc(e.subject)}</p><p class="body">${esc(e.body)}</p>${src(e)}</details>`).join('')
      + (c.linkedin ? `<details><summary>LinkedIn, to send by hand</summary><p class="subj">Connection note</p><p class="body">${esc(c.linkedin.note)}</p><p class="subj">After they accept</p><p class="body">${esc(c.linkedin.message)}</p>${src({ claims: c.linkedin.sources } as Email)}</details>` : '');
    return `<article><h3>${esc(c.name ?? c.domain)} <span class="to">write to ${esc(c.to || 'the person who owns this')}${c.email ? ` · ${esc(c.email)}` : ''}</span></h3>${c.why.length ? `<p class="why">${esc(c.why.join(' · '))}</p>` : ''}${first ? `<p class="subj">${esc(first.subject)}${sent(first)}</p><p class="body">${esc(first.body)}</p>${src(first)}` : ''}${later}</article>`;
  }).join('\n');
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; base-uri 'none'; form-action 'none'"><title>Your sales pack</title><style>
:root{--bg:#f3f6fd;--card:#fff;--ink:#0b0d12;--text:#1c2230;--muted:#4b5262;--line:#e3e8f1;--link:#1463d6;--go:#e3f4e9;color-scheme:light dark}
@media(prefers-color-scheme:dark){:root{--bg:#0d1017;--card:#161a23;--ink:#f4f6fb;--text:#dfe4ee;--muted:#a2abbd;--line:#2a303d;--link:#7fb0ff;--go:#123322}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--text);font:15px/1.55 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif}main{max-width:800px;margin:0 auto;padding:32px 16px 64px}
h1{color:var(--ink);font-size:30px;letter-spacing:-.03em;margin:0 0 6px}h2{color:var(--ink);font-size:18px;margin:32px 0 10px}h3{color:var(--ink);font-size:16px;margin:0 0 6px}.to{display:block;color:var(--muted);font-size:13px;font-weight:400}
a{color:var(--link)}article,.box{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:16px 18px;margin:0 0 12px}.muted,.why{color:var(--muted)}.why{font-size:13.5px}.subj{font-weight:600;color:var(--ink);margin:12px 0 2px}.body{white-space:pre-wrap;overflow-wrap:anywhere;margin:0}
.sent{background:var(--go);color:var(--ink);border-radius:5px;padding:1px 6px;font-size:12px;font-weight:400}.src{border-left:3px solid var(--line);padding-left:10px;font-size:13px;color:var(--muted);overflow-wrap:anywhere;margin:8px 0}details{border-top:1px solid var(--line);margin-top:10px;padding-top:8px}summary{cursor:pointer;color:var(--muted);font-size:14px;min-height:28px}ol{padding-left:20px;margin:0}li{margin:6px 0}code{background:var(--bg);padding:1px 5px;border-radius:5px;font-size:13px;overflow-wrap:anywhere}
</style></head><body><main>
<h1>Your sales pack</h1><p class="muted">${ready.length} companies, each with a reason and emails. ${sentCount ? `${sentCount} ${sentCount === 1 ? 'email has' : 'emails have'} been sent, and each is marked.` : 'Nothing has been sent.'}</p>
<div class="box"><h3>What you sell</h3><p>${esc(product?.summary)}</p><h3>Who to sell to</h3><p>${esc(icp?.summary)}</p><p class="muted">Buyers: ${esc(icp?.buyer_titles.join(', '))}. ${esc(icp?.learned_from)}</p></div>
<h2>Send them</h2><div class="box"><ol>
<li><strong>Yourself, free.</strong> Copy from <code>emails/</code>, or load <code>companies.csv</code> into your own tool. For LinkedIn, send the notes in <code>linkedin.md</code> from your own account: this tool never touches LinkedIn.</li>
<li><strong>From your own mailbox with this tool.</strong> Run <code>outlevo doctor</code> to see what it needs, add people with <code>outlevo contacts find</code> or <code>outlevo contacts import</code>, then <code>outlevo run</code>. You approve every email.</li>
<li><strong>With Outlevo Cloud.</strong> Verified contacts and warmed-up mailboxes, ready to go, running while your laptop is closed. <a href="${CLOUD_URL}" rel="noopener noreferrer">See Outlevo Cloud</a>, or <code>outlevo cloud handoff --name "My first campaign"</code>.</li>
<li><strong>Have Outlevo's team run it.</strong> Managed from $999 a month, or pay per booked meeting by application. <a href="${DONE_FOR_YOU_URL}" rel="noopener noreferrer">See done for you</a>.</li>
</ol></div>
<h2>Companies</h2>${cards || '<p class="muted">No company qualified yet.</p>'}
${left.failed.length ? `<p class="muted">Left out, because their emails failed the checks: ${esc(left.failed.join(', '))}. Try <code>outlevo rewrite ${esc(left.failed[0])} "what to change"</code>.</p>` : ''}
${left.unfinished.length ? `<p class="muted">Not finished yet: ${esc(left.unfinished.join(', '))}. Run <code>outlevo start</code> again to carry on.</p>` : ''}
${left.unreadable.length ? `<p class="muted">Could not be read: ${esc(left.unreadable.join(', '))}. <code>outlevo start</code> tries them again.</p>` : ''}
<p class="muted">Every quote above was found on the page it links to. Read each email before you send it: a model wrote them.</p>
</main></body></html>`;
}

const MADE = '.outlevo-pack';
const PACK_FILES = ['emails', 'index.html', 'ideal-customer.md', 'companies.csv', 'linkedin.md'];
/** A pack replaces its own files. Files of the same names that it did not make are the person's, so it stops before a paid run, not after. */
export function checkPackFolder(out = 'sales-pack') {
  const dir = resolve(out);
  const taken = existsSync(join(dir, MADE)) ? [] : PACK_FILES.filter((f) => existsSync(join(dir, f)));
  if (taken.length) throw new Error(`${dir} already has ${taken.join(', ')}, and they would be replaced. Choose another folder with --out`);
}

/** The folder a person gets at the end. Rebuilt whole each time, so edit a copy if you want to keep changes. */
export function buildPack(a: App, out = 'sales-pack') {
  checkPackFolder(out);
  const all_ = packData(a);
  const ready = all_.filter((c) => c.emails.length && !c.blocked);
  const dir = resolve(out);
  // Built to the side and moved in at the end, so a stop halfway leaves the last whole pack.
  const building = join(dir, '.pack-building');
  const mails = join(building, 'emails');
  rmSync(building, { recursive: true, force: true });
  mkdirSync(building, { recursive: true, mode: 0o700 }); // It holds people's addresses.
  mkdirSync(mails);
  const left: Left = {
    failed: all_.filter((c) => c.blocked).map((c) => c.domain),
    unfinished: [...domainsWhere(a, "status = 'new'"), ...all_.filter((c) => !c.emails.length).map((c) => c.domain)],
    unreadable: domainsWhere(a, "status = 'error'"),
  };
  for (const c of ready) writeFileSync(join(mails, `${c.domain}.md`), inertMd(emailMd(c))); // a domain is checked before it is stored, so it is a safe file name
  const icp = getIcp(a); const product = one<{ summary: string }>(a.db, 'select summary from product');
  writeFileSync(join(building, 'ideal-customer.md'), inertMd([`# Who to sell to`, '', product?.summary ?? '', '', icp?.summary ?? '', '', `Industries: ${icp?.industries.join(', ') ?? ''}`, `Company size: ${icp?.company_size ?? ''}`, `Markets: ${icp?.markets.join(', ') ?? ''}`, `Buyers: ${icp?.buyer_titles.join(', ') ?? ''}`, `Must have: ${icp?.must_have.join('; ') ?? ''}`, `Rule out: ${icp?.rule_out.join('; ') ?? ''}`, '', `Learned from: ${icp?.learned_from ?? ''}`, ''].join('\n')));
  const head = ['company', 'website', 'score', 'why', 'write_to', 'name', 'email', 'quote', 'source', 'subject_1', 'email_1', 'subject_2', 'email_2', 'subject_3', 'email_3', 'linkedin_note', 'linkedin_message'];
  const rows = ready.map((c) => { const q = c.emails[0]?.claims[0]?.source; return [c.name ?? c.domain, `https://${c.domain}`, c.score, c.why.join('; '), c.to, c.person, c.email, q?.quote, q?.source_url, ...[0, 1, 2].flatMap((i) => [c.emails[i]?.subject, c.emails[i]?.body]), c.linkedin?.note, c.linkedin?.message].map(csvCell).join(','); });
  writeFileSync(join(building, 'companies.csv'), [head.join(','), ...rows].join('\n') + '\n');
  writeFileSync(join(building, 'linkedin.md'), inertMd(linkedinMd(ready)));
  writeFileSync(join(building, 'index.html'), page(a, ready, left));
  writeFileSync(join(dir, MADE), '');
  rmSync(join(dir, 'emails'), { recursive: true, force: true });
  for (const f of PACK_FILES) renameSync(join(building, f), join(dir, f));
  rmSync(building, { recursive: true, force: true });
  logEvent(a.db, a.now(), 'pack.built', { companies: ready.length });
  return { dir, index: join(dir, 'index.html'), companies: ready.length, linkedin: ready.filter((c) => c.linkedin).length, blocked: left.failed.length, ...left };
}
