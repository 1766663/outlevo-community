import { existsSync, mkdtempSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { simpleParser } from 'mailparser';
import { describe, expect, it } from 'vitest';
import { isSuppressed, unsubscribeHeader } from '../src/compliance.js';
import { DEFAULTS } from '../src/config.js';
import { all, one, openDb, openPath, run } from '../src/db.js';
import { extractLinks, htmlToText, makeFetcher, quoteIsOn, robotsAllows, robotsRuleMatches } from '../src/fetcher.js';
import { lintEmail, linksIn } from '../src/lint.js';
import { smtpOptions } from '../src/mailer.js';
import { LocalCliModel } from '../src/model.js';
import { buildPack, packData } from '../src/pack.js';
import { importContacts, reviewQueue, withoutDeals } from '../src/pipeline.js';
import { authServers, checkReplies, sendSuggestedReply, senderProven } from '../src/replies.js';
import { testApp } from './helpers.js';

const fast = (fn: () => unknown, ms = 1500) => { const t = Date.now(); fn(); expect(Date.now() - t).toBeLessThan(ms); };
const inbox = (...messages: any[]) => ({ fetchNew: async () => ({ messages: messages.map((m, i) => ({ uid: i + 1, messageId: `<m${i}@x>`, subject: '', text: '', authenticated: false, references: [], autoSubmitted: false, receivedAt: new Date('2026-11-03'), ...m })), lastUid: messages.length, validity: '1' }) });
function person(a: any, email = 'dana@northwind.com') {
  const domain = email.split('@')[1]!;
  const c = run(a.db, "insert into companies (domain, source, status, created_at) values (?, 'csv', 'qualified', '2026-11-01')", domain).lastInsertRowid;
  const id = Number(run(a.db, "insert into contacts (company_id, first_name, email, email_source, created_at) values (?, 'D', ?, 'imported', '2026-11-01')", c, email).lastInsertRowid);
  run(a.db, "insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at, sent_at, message_id) values (?, 1, 's', 'b', '[]', '[]', 'sent', '2026-11-01', '2026-11-01', ?)", id, `<sent${id}@acme.com>`);
  return id;
}

describe('a hostile page cannot freeze the process', () => {
  it('robots rules with many stars', () => {
    fast(() => expect(robotsAllows(`User-agent: *\nDisallow: /${'a*'.repeat(40)}b`, `/${'a'.repeat(5000)}`)).toBe(true));
  });
  it('unclosed tags, however many', () => {
    for (const html of ['<!--'.repeat(300_000), '<br'.repeat(400_000), '<a '.repeat(400_000), '<script>'.repeat(150_000), '<title'.repeat(200_000), ' '.repeat(1_000_000)]) {
      fast(() => { htmlToText(html); extractLinks(html, 'https://x.example/'); });
    }
  });
  it('still matches robots rules as written', () => {
    expect(robotsRuleMatches('/a*/c', '/a/b/c')).toBe(true);
    expect(robotsRuleMatches('/a*/c', '/a/b/d')).toBe(false);
    expect(robotsRuleMatches('/*.pdf$', '/x/y.pdf')).toBe(true);
    expect(robotsRuleMatches('/*.pdf$', '/x/y.pdf?a=1')).toBe(false);
    expect(robotsRuleMatches('/x$', '/x')).toBe(true);
    expect(robotsRuleMatches('/x$', '/xy')).toBe(false);
    expect(robotsAllows('User-agent: *\nDisallow: /private', '/%70rivate/x')).toBe(false);
  });
  it('still reads ordinary pages the same way', () => {
    expect(htmlToText('<p>One</p><!-- no --><script>bad()</script><div>Two<br>Three</div> 1 &lt; 2')).toBe('One\nTwo\nThree\n1 < 2');
    expect(htmlToText('a < b and no closing')).toBe('a < b and no closing');
    expect(extractLinks('<A class="x" HREF="/p#top">x</A><a href=\'https://y.example/\'>', 'https://x.example/')).toEqual(['https://x.example/p', 'https://y.example/']);
  });
  it('drops control and direction characters, so a quote cannot rewrite the terminal', () => {
    const t = htmlToText('<p>We hire&#27;[2K in &#x202e;Austin\u0007 today</p>');
    expect(t).toBe('We hire[2K in Austin today');
    expect(quoteIsOn('We hire\u001b[2K in Austin today', t)).toBe(false);
  });
  it('takes a robots.txt that cannot answer as a no, and asks again; a 404 as no rules', async () => {
    let status = 503; let pages = 0;
    const doFetch = (async (u: string) => { if (String(u).endsWith('/robots.txt')) return new Response('', { status }); pages++; return new Response('<p>hi</p>', { headers: { 'content-type': 'text/html' } }); }) as typeof fetch;
    const f = makeFetcher(doFetch);
    expect(await f('https://example.com/')).toBeNull();
    expect(pages).toBe(0);
    status = 404;
    expect(await f('https://example.com/')).not.toBeNull();
  });
});

describe('forged mail', () => {
  it('a bounce naming thousands of addresses does not jam the inbox', async () => {
    const a = testApp(); person(a);
    const text = Array.from({ length: 40_000 }, (_, i) => `u${i}@x.example`).join(' ');
    await expect(checkReplies(a, inbox({ from: 'mailer-daemon@attacker.test', text }) as any)).resolves.toBeDefined();
  });
  it('a long run of letters does not freeze the address search', async () => {
    const a = testApp(); person(a);
    const t = Date.now();
    await checkReplies(a, inbox({ from: 'mailer-daemon@attacker.test', text: 'a'.repeat(3_000_000) }) as any);
    expect(Date.now() - t).toBeLessThan(1500);
  });
  it('a From with two @ is no booking tool, even with a passing signature', async () => {
    const a = testApp(); person(a);
    await checkReplies(a, inbox({ from: 'x@attacker.example@cal.com', authenticated: true, subject: 'New event: booked', text: 'dana@northwind.com' }) as any);
    expect(one<any>(a.db, 'select count(*) as n from meetings').n).toBe(0);
  });
  it('proves nothing against an empty domain', () => {
    expect(senderProven('mx; dkim=pass header.d=', '')).toBe(false);
  });
  it('someone we wrote to at postmaster@ who asks to stop is heard', async () => {
    const a = testApp(); person(a, 'postmaster@northwind.com');
    await checkReplies(a, inbox({ from: 'postmaster@northwind.com', text: 'Please remove me' }) as any);
    expect(one<any>(a.db, "select count(*) as n from suppression where value = 'postmaster@northwind.com'").n).toBe(1);
  });
});

describe('answers', () => {
  it('may link to your booking page, not to someone else on the same booking host', async () => {
    const a = testApp({ config: { booking_url: 'https://calendly.com/sam' } as any });
    const id = person(a);
    const answer = (text: string) => Number(run(a.db, "insert into replies (contact_id, from_addr, subject, class, suggested, suggested_status, received_at) values (?, 'dana@northwind.com', 's', 'interested', ?, 'pending', '2026-11-03')", id, text).lastInsertRowid);
    const go = (r: number) => sendSuggestedReply(a, r, { checks: () => Promise.resolve([]) } as any);
    await expect(go(answer('Pick one: https://calendly.com/attacker'))).rejects.toThrow(/not your booking page/);
    await expect(go(answer('Pick one: calendly.com/samuel/x'))).rejects.toThrow(/not your booking page/);
    await expect(go(answer('Pick one: https://calendly.com/sam/30min'))).resolves.toBeDefined();
  });
});

describe('links', () => {
  const allowed = { subject: 'x', strict: false as const, allowedLinkDomains: ['acme.com'] };
  const refused = (body: string) => lintEmail({ ...allowed, body }).some((i) => i.rule === 'link-domain');
  it('catches underscores, wide dots and invisible characters', () => {
    for (const b of ['evil_x.attacker.example/login', 'evil。com/login', 'evil​.com/login', 'evil．com']) expect(refused(b), b).toBe(true);
  });
  it('leaves words alone that only look like hosts', () => {
    for (const b of ['schema.sql', 'main.go', 'config.xml', 'test.exe', 'pricing.We help', 'Mr.Smith', 'St.Louis', 'Node.js', 'snake_case.method']) expect(refused(b), b).toBe(false);
  });
  it('still refuses real endings, whatever they also look like', () => {
    for (const b of ['evil.zip', 'evil.md', 'Evil.Com', 'Amazon.com']) expect(refused(b), b).toBe(true);
    expect(linksIn('acme.com').length).toBe(1);
  });
});

describe('fake threads and history', () => {
  const rules = (subject: string, body = 'Hello there') => lintEmail({ subject, body, strict: false }).map((i) => i.rule);
  it('knows replies in other languages', () => { for (const s of ['AW: x', 'SV: x', 'Re[2]: x']) expect(rules(s), s).toContain('fake-thread'); });
  it('knows more ways of claiming a past', () => { for (const b of ['Per my last email', 'Like we discussed', 'Thanks for getting back to me', 'Great meeting you at SaaStr']) expect(rules('Hi', b), b).toContain('fake-history'); });
});

describe('the pack and imports', () => {
  it('a contact row may not attach an address to another domain', () => {
    const a = testApp(); const f = join(mkdtempSync(join(tmpdir(), 'imp-')), 'p.csv');
    writeFileSync(f, 'email,first_name,domain\nvictim@bank.example,Pat,evil-offers.example\nann@eu.acme.com,Ann,acme.com\nbo@acme.com,Bo,www.acme.com\n');
    const r = importContacts(a, f);
    expect(r.added).toBe(2);
    expect(r.skipped[0]!.reason).toMatch(/not at evil-offers\.example/);
  });
  it('the Markdown holds no tag or dressed-up link from a page', () => {
    const a = testApp({ config: {} as any });
    const c = run(a.db, "insert into companies (domain, source, status, reasons, created_at) values ('n.com', 'csv', 'qualified', '{}', '2026-11-01')").lastInsertRowid;
    run(a.db, "insert into company_emails (company_id, step, subject, body, claims, lint, delay_days, blocked, to_title, created_at) values (?, 1, 'S', ?, '[]', '[]', 0, 0, 'Head', '2026-11-01')", c, '<img src="https://evil.example/p.gif?id=a@b"> [Claim your audit](https://evil.example/a)');
    const dir = join(mkdtempSync(join(tmpdir(), 'pk-')), 'p');
    buildPack(a, dir);
    const md = readFileSync(join(dir, 'emails', 'n.com.md'), 'utf8');
    expect(md).not.toContain('<img');
    expect(md).not.toContain('](https');
  });
});

describe('secrets', () => {
  it('sends the SMTP password only inside TLS over the network', () => {
    const c = structuredClone(DEFAULTS) as any;
    c.smtp = { host: 'smtp.example.com', port: 587, secure: false, user: 'u' };
    expect(smtpOptions(c, 'p').requireTLS).toBe(true);
    c.smtp.secure = true; expect(smtpOptions(c, 'p').requireTLS).toBe(false);
    c.smtp = { host: '127.0.0.1', port: 25, secure: false, user: 'u' }; expect(smtpOptions(c, 'p').requireTLS).toBe(false);
  });
  it('the data folder keeps itself out of git', () => {
    const home = join(mkdtempSync(join(tmpdir(), 'home-')), '.outlevo');
    openDb(home);
    expect(existsSync(join(home, '.gitignore'))).toBe(true);
    expect(readFileSync(join(home, '.gitignore'), 'utf8')).toBe('*\n');
  });
});

describe('opting out from another address', () => {
  it('a signed unsubscribe counts for the person it names, whatever address it comes from', async () => {
    const a = testApp(); const id = person(a, 'ann@oldcorp.com');
    run(a.db, "insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at) values (?, 2, 's', 'b', '[]', '[]', 'approved', '2026-11-01')", id);
    const subject = unsubscribeHeader(a, id)['List-Unsubscribe'].match(/subject=([^>]+)/)![1]!;
    await checkReplies(a, inbox({ from: 'ann.personal@elsewhere.example', subject }) as any);
    expect(isSuppressed(a, 'ann@oldcorp.com')).toBeTruthy();
    expect(isSuppressed(a, 'ann.personal@elsewhere.example')).toBeTruthy();
    expect(one<any>(a.db, 'select status from drafts where step = 2').status).toBe('cancelled');
    expect(one<any>(a.db, 'select class, verified from replies')).toMatchObject({ class: 'unsubscribe', verified: 1 });
  });
  it('a made-up token opts out nobody', async () => {
    const a = testApp(); const id = person(a, 'ann@oldcorp.com');
    await checkReplies(a, inbox({ from: 'x@elsewhere.example', subject: `unsubscribe-u${id}-0123456789abcdef` }) as any);
    expect(isSuppressed(a, 'ann@oldcorp.com')).toBeFalsy();
  });
});

describe('unverified replies', () => {
  it('still stop the sequence, and are marked', async () => {
    const a = testApp({ answers: { classify_reply: { class: 'interested', reason: 'r', suggested_reply: 'Sure' } } }); const id = person(a);
    await checkReplies(a, inbox({ from: 'dana@northwind.com', text: 'Tell me more' }) as any);
    expect(one<any>(a.db, 'select verified from replies').verified).toBe(0);
    await checkReplies(a, inbox({ messageId: '<other@x>', from: 'dana@northwind.com', text: 'Tell me more', authenticated: true }) as any);
    expect(one<any>(a.db, "select verified from replies where message_id = '<other@x>'").verified).toBe(1);
    expect(id).toBeGreaterThan(0);
  });
  it('an older database gets the column', () => {
    const f = join(mkdtempSync(join(tmpdir(), 'old-')), 'o.db');
    const old = new DatabaseSync(f); old.exec('create table replies (id integer primary key, from_addr text)'); old.close();
    const db = openPath(f);
    expect(all<any>(db, 'pragma table_info(replies)').some((c) => c.name === 'verified')).toBe(true);
  });
});

describe('whose verdict counts', () => {
  const pass = (by: string) => `${by}; dkim=pass header.d=cal.com`;
  it('only your provider\'s server', () => {
    const gmail = authServers({ host: 'imap.gmail.com' });
    expect(senderProven(pass('mx.google.com'), 'cal.com', gmail)).toBe(true);
    expect(senderProven(pass('attacker'), 'cal.com', gmail)).toBe(false);
    expect(senderProven(pass('mx.google.com.evil.example'), 'cal.com', gmail)).toBe(false);
    expect(senderProven(pass('mail.acme.com'), 'cal.com', authServers({ host: 'imap.acme.com' }))).toBe(true);
    expect(senderProven(pass('mx.evil.co.uk'), 'cal.com', authServers({ host: 'imap.acme.co.uk' }))).toBe(false);
  });
  it('yours, if you say so', () => {
    expect(senderProven(pass('mx.other.net'), 'cal.com', authServers({ host: 'imap.acme.com', auth_server: 'mx.other.net' }))).toBe(true);
    expect(authServers({ host: 'imap.acme.com', auth_server: 'any' })).toBeUndefined();
  });
  it('a bounce quoting our own email still counts with none of this', async () => {
    const a = testApp(); const id = person(a);
    await checkReplies(a, inbox({ from: 'mailer-daemon@somewhere.example', text: `failed <sent${id}@acme.com>` }) as any);
    expect(one<any>(a.db, 'select status from contacts').status).toBe('bounced');
  });
});

describe('links dressed up', () => {
  const allowed = { subject: 'x', strict: false as const, allowedLinkDomains: ['acme.com'] };
  const refused = (body: string) => lintEmail({ ...allowed, body }).some((i) => i.rule === 'link-domain');
  it('spelled out', () => { for (const b of ['evil dot com', 'evil[.]com', 'evil (dot) com/x', 'evil [dot] co [dot] uk', 'evil{dot}zip']) expect(refused(b), b).toBe(true); });
  it('handed on by an allowed site', () => { for (const b of ['acme.com/r?u=evil.com', 'https://acme.com/r?to=https%3A%2F%2Fevil.com', 'https://acme.com/go/https://evil.com/x', 'acme.com/r#evil.com', 'https://acme.com/r?u=https%253A%252F%252Fevil.com']) expect(refused(b), b).toBe(true); });
  it('leaves the ordinary alone', () => { for (const b of ['the dot com era', 'polka dot com', 'acme.com/p?month=2026-11&id=3', 'https://acme.com/r?u=https://www.acme.com/x', 'acme.com/blog/how.to', 'acme.com/a?email=sam@evil.example', 'acme dot com']) expect(refused(b), b).toBe(false); });
});

describe('what you review is what they get', () => {
  it('a follow-up shows the subject it goes out under', () => {
    const a = testApp(); const c = run(a.db, "insert into companies (domain, source, status, reasons, created_at) values ('n.com', 'csv', 'qualified', '{}', '2026-11-01')").lastInsertRowid;
    const p = run(a.db, "insert into contacts (company_id, first_name, email, email_source, created_at) values (?, 'D', 'd@n.com', 'imported', '2026-11-01')", c).lastInsertRowid;
    for (const [step, s] of [[1, 'First'], [2, 'Second']] as const) run(a.db, "insert into drafts (contact_id, step, subject, body, claims, lint, status, created_at) values (?, ?, ?, 'b', '[]', '[]', 'pending', '2026-11-01')", p, step, s);
    expect(reviewQueue(a)[0].emails.map((e: any) => e.subject)).toEqual(['First', 'Re: First']);
    expect(packData(a)[0]!.emails.map((e) => e.subject)).toEqual(['First', 'Re: First']);
  });
});

describe('deals stay out of the search', () => {
  it('names only in learned_from', () => {
    const icp = { summary: 'Firms like Acme Corp and northwind.com', industries: ['software', 'northwind.com'], company_size: '50', markets: ['US'], buyer_titles: ['Head of Sales'], must_have: ['Like acme-corp'], rule_out: ['Anything like NORTHWIND'], learned_from: 'northwind.com, acme-corp.com' };
    const out = withoutDeals(icp, ['northwind.com', 'acme-corp.com']);
    expect(JSON.stringify({ ...out, learned_from: '' })).not.toMatch(/northwind|acme/i);
    expect(out.learned_from).toBe(icp.learned_from);
    expect(out.industries[0]).toBe('software');
  });
});

describe('the local-cli provider', () => {
  it('runs in an empty private folder of its own, and removes it', async () => {
    let cwd = ''; let during = false;
    const exec = ((_c: string, _a: string[], o: any, cb: any) => { cwd = o.cwd; during = readdirSync(cwd).length === 0 && (statSync(cwd).mode & 0o077) === 0; setImmediate(() => cb(null, JSON.stringify({ result: '{"ok":true}' }))); return { stdin: { end() {} } }; }) as any;
    expect(await new LocalCliModel('m', exec).json({ name: 'x', system: 's', user: 'u', schema: {} })).toEqual({ ok: true });
    expect(during).toBe(true);
    expect(cwd.startsWith('/tmp/') && !cwd.includes('outlevo-model-')).toBe(false);
    expect(existsSync(cwd)).toBe(false);
  });
});

describe('real parsed headers', () => {
  it('reads the top verdict of a real message, and a forged one below it does not help', async () => {
    const raw = (top: string) => `${top}Authentication-Results: attacker; dkim=pass header.d=cal.com\r\nFrom: x@cal.com\r\nSubject: s\r\n\r\nb\r\n`;
    const got = async (top: string) => (await simpleParser(raw(top))).headers.get('authentication-results');
    const gmail = authServers({ host: 'imap.gmail.com' });
    expect(senderProven(await got(''), 'cal.com', gmail)).toBe(false);
    expect(senderProven(await got('Authentication-Results: mx.google.com;\r\n dkim=pass header.i=@cal.com;\r\n dmarc=pass header.from=cal.com\r\n'), 'cal.com', gmail)).toBe(true);
    expect(senderProven(await got('Authentication-Results: mx.google.com; dkim=fail header.i=@cal.com\r\n'), 'cal.com', gmail)).toBe(false);
  });
  it('a long run of letters does not stall the link check', () => { fast(() => linksIn('a'.repeat(1_000_000))); });
});
