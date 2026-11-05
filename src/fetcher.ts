import { lookup as dnsLookup } from 'node:dns';
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';

export const USER_AGENT = 'OutlevoCommunityBot/0.1 (+https://outlevo.com)';
const MAX_BYTES = 1_500_000;
const TIMEOUT_MS = 12_000;
/** A job board lists every posting with its full description: a big company's is several megabytes. */
const MAX_JSON_BYTES = 10_000_000;

export type Page = { url: string; text: string; links: string[]; title: string | null };
export type PageFetcher = (url: string) => Promise<Page | null>;
/** Parsed JSON from a public API (a job board), or null. Untrusted like any page: read it, never follow it. */
export type JsonFetcher = (url: string) => Promise<unknown | null>;

const privateV4 = (p: number[]) => {
  const [a = 0, b = 0] = p;
  return a === 0 || a === 10 || a === 127 || a >= 224 || (a === 100 && b >= 64 && b <= 127) || (a === 169 && b === 254)
    || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 192 && b === 0) || (a === 198 && (b === 18 || b === 19));
};
/** The eight 16-bit groups of any spelling of an IPv6 address. */
function groups(ip: string): number[] | null {
  let v = ip.toLowerCase().split('%')[0]!;
  const dotted = v.match(/^(.*:)(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (dotted) v = `${dotted[1]}${((Number(dotted[2]) << 8) | Number(dotted[3])).toString(16)}:${((Number(dotted[4]) << 8) | Number(dotted[5])).toString(16)}`;
  const [head = '', tail] = v.split('::');
  const left = head ? head.split(':') : []; const right = tail ? tail.split(':') : [];
  const fill = tail === undefined ? 0 : 8 - left.length - right.length;
  if (fill < 0) return null;
  const all = [...left, ...Array<string>(fill).fill('0'), ...right].map((x) => parseInt(x, 16));
  return all.length === 8 && all.every((n) => Number.isInteger(n) && n >= 0 && n <= 0xffff) ? all : null;
}
const v4From = (hi: number, lo: number) => [hi >> 8, hi & 255, lo >> 8, lo & 255];

export function isPrivateAddress(ip: string): boolean {
  if (isIP(ip) === 4) return privateV4(ip.split('.').map(Number));
  const g = groups(ip);
  if (!g) return true; // what cannot be read is not fetched
  const [g0 = 0, g1 = 0, g2 = 0, g3 = 0, g4 = 0, g5 = 0, g6 = 0, g7 = 0] = g;
  if (g.every((x) => x === 0) || (g.slice(0, 7).every((x) => x === 0) && g7 === 1)) return true; // :: and ::1
  if ((g0 & 0xfe00) === 0xfc00 || (g0 & 0xffc0) === 0xfe80 || (g0 & 0xffc0) === 0xfec0 || (g0 & 0xff00) === 0xff00) return true; // unique local, link local, site local, multicast
  if (g0 === 0x2001 && g1 === 0x0db8) return true; // documentation
  // IPv4 inside IPv6: mapped, compatible, NAT64, 6to4, Teredo. Each can lead back to a private IPv4 address.
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0 && (g5 === 0xffff || g5 === 0)) return privateV4(v4From(g6, g7));
  if (g0 === 0 && g1 === 0 && g2 === 0 && g3 === 0 && g4 === 0xffff && g5 === 0) return privateV4(v4From(g6, g7));
  if (g0 === 0x64 && g1 === 0xff9b) return privateV4(v4From(g6, g7));
  if (g0 === 0x2002) return privateV4(v4From(g1, g2));
  if (g0 === 0x2001 && g1 === 0) return true;
  return false;
}

// Checked again at the moment of connecting, so a name that resolved to a public address a moment ago cannot switch to a private one.
const pinned = new Agent({ connect: { lookup: (host: string, options: any, cb: any) => {
  dnsLookup(host, { all: true }, (err, addrs) => {
    if (err) return cb(err);
    if (!addrs.length || addrs.some((x) => isPrivateAddress(x.address))) return cb(new Error(`Refused a private address for ${host}`));
    if (options?.all) return cb(null, addrs);
    return cb(null, addrs[0]!.address, addrs[0]!.family);
  });
} } });
const pinnedFetch = ((url: string, init: any) => undiciFetch(url, { ...init, dispatcher: pinned })) as unknown as typeof fetch;

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

const SKIPPED = new Set(['script', 'style', 'noscript', 'svg', 'template', 'iframe']);
const LINE_BREAK = /^(br|\/p|\/div|\/li|\/h[1-6]|\/tr|\/section|\/article)$/;
// Control and direction characters could rewrite a terminal or disguise a quote. Pages have no business sending them.
export const CONTROL = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f-\u009f‪-‮⁦-⁩]/g;
const asciiLower = (s: string) => s.replace(/[A-Z]+/g, (x) => x.toLowerCase());

/** Walks the tags once, in one pass: a page is hostile input, and a regex over unclosed tags takes minutes on a small one. */
function walkTags(html: string, onText: (t: string) => void, onTag: (name: string, tag: string) => void) {
  const lower = asciiLower(html); const noCloser = new Set<string>();
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt < 0) break;
    onText(html.slice(i, lt));
    if (html.startsWith('<!--', lt)) { const end = html.indexOf('-->', lt + 4); i = end < 0 ? html.length : end + 3; onText(' '); continue; }
    const gt = html.indexOf('>', lt + 1);
    if (gt < 0 || gt === lt + 1) { onText(html.slice(lt, gt < 0 ? undefined : gt + 1)); i = gt < 0 ? html.length : gt + 1; continue; }
    const name = lower.slice(lt + 1, Math.min(gt, lt + 40)).match(/^\/?[a-z0-9]*/)![0];
    onTag(name, html.slice(lt, gt + 1));
    i = gt + 1;
    if (SKIPPED.has(name) && !noCloser.has(name)) {
      const close = lower.indexOf(`</${name}`, i);
      const end = close < 0 ? -1 : html.indexOf('>', close);
      if (end < 0) noCloser.add(name); else i = end + 1;
    }
  }
  if (i < html.length && html.indexOf('<', i) < 0) onText(html.slice(i));
}

export function htmlToText(html: string): string {
  const out: string[] = [];
  walkTags(html, (t) => out.push(t), (name) => out.push(LINE_BREAK.test(name) ? '\n' : ' '));
  return decode(out.join('')).replace(CONTROL, '').replace(/[^\S\n]+/g, ' ').replace(/\s*\n\s*/g, '\n').trim();
}

export function extractLinks(html: string, base: string): string[] {
  const out = new Set<string>();
  walkTags(html, () => {}, (name, tag) => {
    if (name !== 'a') return;
    const href = tag.match(/\bhref\s*=\s*["']([^"'#]+)/i)?.[1];
    if (!href) return;
    try { const u = new URL(decode(href), base); if (u.protocol === 'http:' || u.protocol === 'https:') { u.hash = ''; out.add(u.href); } } catch { /* not a link */ }
  });
  return [...out];
}

function titleOf(html: string): string | null {
  const lower = asciiLower(html); const start = lower.indexOf('<title');
  const open = start < 0 ? -1 : html.indexOf('>', start);
  const close = open < 0 ? -1 : lower.indexOf('</title>', open);
  return close < 0 ? null : html.slice(open + 1, close);
}

const MAX_ROBOTS_RULES = 2000; const MAX_RULE_LENGTH = 500;
/** A robots.txt pattern, where `*` is anything and a final `$` is the end. Written out, because as a regex a short rule can hang the process. */
export function robotsRuleMatches(rule: string, path: string): boolean {
  const anchored = rule.endsWith('$');
  const parts = (anchored ? rule.slice(0, -1) : rule).split('*');
  if (!path.startsWith(parts[0]!)) return false;
  let at = parts[0]!.length;
  for (let i = 1; i < parts.length; i++) { const f = path.indexOf(parts[i]!, at); if (f < 0) return false; at = f + parts[i]!.length; }
  if (!anchored) return true;
  const last = parts.at(-1)!;
  return parts.length === 1 ? path === parts[0] : path.endsWith(last) && path.length - last.length >= at - last.length;
}
const decodedPath = (s: string) => { try { return decodeURI(s); } catch { return s; } };

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
  const seen = decodedPath(path);
  for (const r of use.flatMap((g) => g.rules).slice(0, MAX_ROBOTS_RULES)) {
    if (r[1].length > MAX_RULE_LENGTH) continue;
    if (robotsRuleMatches(decodedPath(r[1]), seen) && (!best || r[1].length > best[1].length || (r[1].length === best[1].length && r[0]))) best = r;
  }
  return best ? best[0] : true;
}

async function get(raw: string, doFetch: typeof fetch, accept: string, allowed: (url: string) => Promise<boolean> = async () => true): Promise<{ res: Response; url: string } | null> {
  let url = raw;
  for (let hop = 0; hop < 5; hop++) {
    await assertPublicUrl(url);
    if (!(await allowed(url))) return null;
    const res = await doFetch(url, { redirect: 'manual', signal: AbortSignal.timeout(TIMEOUT_MS), headers: { 'user-agent': USER_AGENT, accept } });
    if (res.status >= 300 && res.status < 400 && res.headers.get('location')) { url = new URL(res.headers.get('location')!, url).href; continue; }
    return { res, url };
  }
  return null;
}

async function readCapped(res: Response, max = MAX_BYTES): Promise<string> {
  const reader = res.body?.getReader();
  if (!reader) return '';
  const chunks: Uint8Array[] = []; let size = 0;
  while (size < max) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value); size += value.length;
  }
  await reader.cancel().catch(() => {});
  return Buffer.concat(chunks).toString('utf8');
}

/** Whether robots.txt lets us read a URL, remembered per origin. */
function robotsChecker(doFetch: typeof fetch) {
  const robots = new Map<string, string>();
  // Asked at every hop: a redirect to another host answers to that host's rules.
  return async (raw: string) => {
    const u = new URL(raw);
    if (!robots.has(u.origin)) {
      const r = await get(`${u.origin}/robots.txt`, doFetch, 'text/plain').catch(() => null);
      // A server that cannot answer may be saying no (RFC 9309), and asked again next time. A 404 and the like mean there are no rules.
      if (!r || r.res.status >= 500) return false;
      robots.set(u.origin, r.res.ok ? await readCapped(r.res) : '');
    }
    return robotsAllows(robots.get(u.origin)!, u.pathname + u.search);
  };
}

/** One page, or null when robots.txt says no, it is not HTML, or it is not there. */
export function makeFetcher(doFetch: typeof fetch = pinnedFetch): PageFetcher {
  const robotsSay = robotsChecker(doFetch);
  return async (raw) => {
    const r = await get(raw, doFetch, 'text/html,application/xhtml+xml', robotsSay);
    if (!r?.res.ok || !/html|text\/plain/i.test(r.res.headers.get('content-type') ?? '')) return null;
    const html = await readCapped(r.res);
    const title = titleOf(html);
    return { url: r.url, text: htmlToText(html), links: extractLinks(html, r.url), title: title ? decode(title).replace(CONTROL, '').trim() : null };
  };
}

const norm = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/[“”]/g, '"').replace(/\s+/g, ' ').trim();
/** A model may only state what the page says: its quote has to be on the page, word for word. */
export const quoteIsOn = (quote: string, pageText: string) => quote.trim().length >= 12 && norm(pageText).includes(norm(quote));

/** A public JSON API, with the same guards as a page: public addresses only, robots.txt, a size and time cap. */
export function makeJsonFetcher(doFetch: typeof fetch = pinnedFetch): JsonFetcher {
  const robotsSay = robotsChecker(doFetch);
  return async (raw) => {
    const r = await get(raw, doFetch, 'application/json', robotsSay);
    if (!r?.res.ok || !/json/i.test(r.res.headers.get('content-type') ?? '')) return null;
    try { return JSON.parse(await readCapped(r.res, MAX_JSON_BYTES)); } catch { return null; }
  };
}
