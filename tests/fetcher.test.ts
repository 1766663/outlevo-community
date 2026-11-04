import { describe, expect, it } from 'vitest';
import { assertPublicUrl, extractLinks, htmlToText, isPrivateAddress, makeFetcher, quoteIsOn, robotsAllows } from '../src/fetcher.js';

describe('isPrivateAddress', () => {
  it.each(['127.0.0.1', '10.1.2.3', '192.168.0.1', '172.16.0.1', '169.254.169.254', '100.64.0.1', '0.0.0.0', '::1', 'fd00::1', 'fe80::1', '::ffff:10.0.0.1', '::ffff:7f00:1', '::ffff:a9fe:a9fe', '64:ff9b::7f00:1', '::127.0.0.1', '2002:7f00:1::', 'fec0::1', 'ff02::1', 'not an address'])('refuses %s', (ip) => { expect(isPrivateAddress(ip)).toBe(true); });
  it.each(['8.8.8.8', '172.32.0.1', '2606:4700::1111'])('allows %s', (ip) => { expect(isPrivateAddress(ip)).toBe(false); });
});

describe('assertPublicUrl', () => {
  const resolve = (async (host: string) => [{ address: host === 'inside.example' ? '10.0.0.5' : '93.184.216.34', family: 4 }]) as any;
  it('refuses other schemes, credentials, ports and private addresses', async () => {
    await expect(assertPublicUrl('file:///etc/passwd', resolve)).rejects.toThrow();
    await expect(assertPublicUrl('https://a:b@ok.example/', resolve)).rejects.toThrow();
    await expect(assertPublicUrl('https://ok.example:8443/', resolve)).rejects.toThrow();
    await expect(assertPublicUrl('https://inside.example/', resolve)).rejects.toThrow();
    await expect(assertPublicUrl('http://169.254.169.254/latest/meta-data/', resolve)).rejects.toThrow();
  });
  it('allows a public site', async () => { await expect(assertPublicUrl('https://ok.example/a', resolve)).resolves.toBeInstanceOf(URL); });
});

describe('makeFetcher', () => {
  it('refuses a redirect that points inward', async () => {
    const doFetch = (async (u: string) => (String(u).endsWith('/robots.txt') ? new Response('', { status: 404 }) : new Response(null, { status: 302, headers: { location: 'http://127.0.0.1/admin' } }))) as typeof fetch;
    await expect(makeFetcher(doFetch)('https://example.com/')).rejects.toThrow(/private/);
  });
  it('honours robots.txt without asking for the page', async () => {
    const seen: string[] = [];
    const doFetch = (async (u: string) => { seen.push(String(u)); return new Response('User-agent: *\nDisallow: /', { status: 200 }); }) as typeof fetch;
    expect(await makeFetcher(doFetch)('https://example.com/about')).toBeNull();
    expect(seen).toEqual(['https://example.com/robots.txt']);
  });
});

describe('robotsAllows', () => {
  it('lets the longest rule win', () => { expect(robotsAllows('User-agent: *\nDisallow: /a\nAllow: /a/b', '/a/b/c')).toBe(true); expect(robotsAllows('User-agent: *\nDisallow: /a', '/a/c')).toBe(false); });
  it('prefers rules for our own agent', () => { expect(robotsAllows('User-agent: *\nAllow: /\n\nUser-agent: OutlevoCommunityBot\nDisallow: /', '/x')).toBe(false); });
  it('allows when there are no rules', () => { expect(robotsAllows('', '/x')).toBe(true); });
});

describe('page text', () => {
  it('drops scripts and decodes entities', () => { expect(htmlToText('<p>A &amp; B</p><script>evil()</script><style>x{}</style>')).toBe('A & B'); });
  it('resolves links and keeps only the web', () => { expect(extractLinks('<a href="/about">x</a><a href="javascript:evil()">y</a>', 'https://a.example/')).toEqual(['https://a.example/about']); });
  it('finds a quote through spacing and curly quotes', () => { expect(quoteIsOn("we’re hiring   four reps now", "Today: We're hiring four reps now!")).toBe(true); });
  it('refuses a quote that is not on the page, or is too short to mean anything', () => { expect(quoteIsOn('we raised a Series B round', 'We are hiring.')).toBe(false); expect(quoteIsOn('hiring', 'hiring')).toBe(false); });
});
