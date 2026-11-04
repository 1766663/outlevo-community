import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';

export const USER_AGENT = 'OutlevoCommunityBot/0.1 (+https://outlevo.com)';
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 12_000;

export type Page = { url: string; text: string; links: string[]; title: string | null };
export type PageFetcher = (url: string) => Promise<Page | null>;

export function isPrivateAddress(ip: string): boolean {
  const v = ip.toLowerCase();
  if (isIP(v) === 6) {
    if (v === '::1' || v === '::' || /^f[cd]/.test(v) || /^fe[89ab]/.test(v)) return true;
    const mapped = v.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    return mapped ? isPrivateAddress(mapped[1]!) : false;
  }
  const p = v.split('.').map(Number);
  const [a = 0, b = 0] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
}

// A prospect's website is untrusted: it must not be able to point this machine at its own network.
export async function assertPublicUrl(raw: string, resolve = lookup): Promise<URL> {
  const url = new URL(raw);
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error(`Refused ${url.protocol} URL`);
  if (url.username || url.password) throw new Error('Refused a URL with credentials');
  if (url.port && url.port !== '80' && url.port !== '443') throw new Error('Refused an unusual port');
  const host = url.hostname.replace(/^\[|\]$/g, '');
  const addrs = isIP(host) ? [{ address: host }] : await resolve(host, { all: true });
  if (!addrs.length || addrs.some((a) => isPrivateAddress(a.address))) throw new Error(`Refused a private address for ${host}`);
  return url;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ', rsquo: '’', lsquo: '‘', rdquo: '”', ldquo: '“', ndash: '–', mdash: '—', hellip: '…' };
const decode = (s: string) => s.replace(/&(#x?[0-9a-f]+|[a-z]+);/gi, (m, e: string) => {
  if (e[0] === '#') { const n = e[1]?.toLowerCase() === 'x' ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return n > 0 && n <= 0x10ffff ? String.fromCodePoint(n) : ' '; }
  return ENTITIES[e.toLowerCase()] ?? m;
});

export function htmlToText(html: string): string {
  return decode(html
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<(script|style|noscript|svg|template|iframe)\b[\s\S]*?<\/\1\s*>/gi, ' ')
    .replace(/<(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)\b[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, ' '))
    .replace(/[ \t\f\v]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  for (const m of html.matchAll(/<a\b[^>]*\bhref\s*=\s*["']([^"'#]+)/gi)) {
    try { const u = new URL(decode(m[1]!), base); if (u.protocol === 'http:' || u.protocol === 'https:') { u.hash = ''; out.add(u.href); } } catch { /* not a link */ }
  }
  return [...out];
}

/** The rules for `*` and for our own agent; the longest matching rule wins, Allow on a tie. */
export function robotsAllows(robots: string, path: string, agent = 'outlevocommunitybot'): boolean {
  const groups: Array<{ agents: string[]; rules: Array<[boolean, string]> }> = [];
  let cur: (typeof groups)[number] | null = null; let inRules = false;
  for (const line of robots.split(/\r?\n/)) {
    const m = line.replace(/#.*/, '').trim().match(/^([a-z-]+)\s*:\s*(.*)$/i);
    if (!m) continue;
    const key = m[1]!.toLowerCase(); const val = m[2]!.trim();
    if (key === 'user-agent') {
      if (!cur || inRules) { cur = { agents: [], rules: [] }; groups.push(cur); inRules = false; }
      cur.agents.push(val.toLowerCase());
    } else if ((key === 'allow' || key === 'disallow') && cur) { inRules = true; if (val) cur.rules.push([key === 'allow', val]); }
  }
  const mine = groups.filter((g) => g.agents.includes(agent));
  const use = mine.length ? mine : groups.filter((g) => g.agents.includes('*'));
  let best: [boolean, string] | null = null;
  for (const r of use.flatMap((g) => g.rules)) {
    const re = new RegExp('^' + r[1].split('*').map((s) => s.replace(/[.+?^${}()|[\]\\]/g, '\\$&')).join('.*').replace(/\\\$$/, '$'));
    if (re.test(path) && (!best || r[1].length > best[1].length || (r[1].length === best[1].length && r[0]))) best = r;
  }
  return best ? best[0] : true;
}

async function get(raw: string, doFetch: typeof fetch, accept: string): Promise<{ res: Response; url: string } | null> {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(url);
    const res = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': USER_AGENT, accept } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location')!, url).href; continue; }
    return { res, url };
  }
  return null;
}

async function readCapped(res: Response): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  while (size < MAX_BYTES) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

/** One page, or null when robots.txt says no, it is not HTML, or it is not there. */
export function makeFetcher(doFetch: typeof fetch = fetch): PageFetcher {
  const robots = new Map<string, string>();
  return async (raw) => {
    const u = new URL(raw);
    if (!robots.has(u.origin)) {
      const r = await get(`${u.origin}/robots.txt`, doFetch, 'text/plain').catch(() => null);
      robots.set(u.origin, r?.res.ok ? await readCapped(r.res) : '');
    }
    if (!robotsAllows(robots.get(u.origin)!, u.pathname + u.search)) return null;
    const r = await get(raw, doFetch, 'text/html,application/xhtml+xml');
    if (!r?.res.ok || !/html|text\/plain/i.test(r.res.headers.get('content-type') ?? '')) return null;
    const html = await readCapped(r.res);
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1];
    return { url: r.url, text: htmlToText(html), links: extractLinks(html, r.url), title: title ? decode(title).trim() : null };
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
/** A model may only state what the page says: its quote has to be on the page, word for word. */
export const quoteIsOn = (quote: string, pageText: string) => quote.trim().length >= 12 && norm(pageText).includes(norm(quote));
