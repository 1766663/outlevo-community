import { mkdtempSync, readFileSync, existsSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DEFAULTS } from '../src/config.js';
import { one, openDb, run } from '../src/db.js';
import { extractLinks, htmlToText, makeFetcher, quoteIsOn, robotsAllows, robotsRuleMatches } from '../src/fetcher.js';
import { lintEmail, linksIn } from '../src/lint.js';
import { smtpOptions } from '../src/mailer.js';
import { buildPack } from '../src/pack.js';
import { importContacts } from '../src/pipeline.js';
import { checkReplies, sendSuggestedReply, senderProven } from '../src/replies.js';
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
