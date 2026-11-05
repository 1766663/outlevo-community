import type { App } from './app.js';
import { logEvent } from './db.js';
import { CONTROL, type Page } from './fetcher.js';

// Hiring signals from public job boards. A company that is hiring for a role is often buying for it, and a posting is a
// dated, quotable fact. Greenhouse, Lever and Ashby publish every board as public JSON. A board counts only when the
// company's own website links to it, so a posting is never pinned on the wrong company. No model call and no key.
//
//   Greenhouse  boards.greenhouse.io/<token>, job-boards.greenhouse.io/<token>  →  boards-api.greenhouse.io/v1/boards/<token>/jobs
//               {jobs: [{title, absolute_url, location: {name}, updated_at, first_published?}]}
//   Lever       jobs.lever.co/<slug>  →  api.lever.co/v0/postings/<slug>?mode=json&limit=100   [{text, hostedUrl, createdAt (ms), categories: {location}}]
//   Ashby       jobs.ashbyhq.com/<name>  →  api.ashbyhq.com/posting-api/job-board/<name>   {jobs: [{title, jobUrl, location, publishedAt}]}

export type Board = { kind: 'greenhouse' | 'lever' | 'ashby'; token: string; eu?: boolean };
export type Posting = { title: string; url: string; location: string | null; posted_at: string | null };

/** A posting counts this long after its date; one with no date counts while it is listed. */
export const FRESH_DAYS = 60;
/** At most this many postings become facts: the newest. */
export const MAX_POSTINGS = 5;

const PATTERNS: Array<[Board['kind'], RegExp]> = [
  ['greenhouse', /^https?:\/\/(?:boards|job-boards)(?:\.eu)?\.greenhouse\.io\/(?:embed\/job_board(?:\/js)?\?for=)?([a-z0-9](?:[a-z0-9_-]{0,78}[a-z0-9])?)(?:[/?#&]|$)/i],
  ['lever', /^https?:\/\/jobs\.lever\.co\/([a-z0-9](?:[a-z0-9_.-]{0,78}[a-z0-9])?)(?:[/?#]|$)/i],
  ['ashby', /^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9](?:[a-z0-9_.%-]{0,78}[a-z0-9])?)(?:[/?#]|$)/i],
];
const HOSTS: Record<Board['kind'], RegExp> = {
  greenhouse: /(^|\.)greenhouse\.io$/i, lever: /(^|\.)lever\.co$/i, ashby: /(^|\.)ashbyhq\.com$/i,
};

/** The job boards the company's own pages link to, at most two. */
export function boardsIn(pages: Page[]): Board[] {
  const out = new Map<string, Board>();
  for (const link of pages.flatMap((p) => p.links)) {
    for (const [kind, re] of PATTERNS) {
      const m = re.exec(link);
      if (m && !['embed', 'jobs', 'api'].includes(m[1]!.toLowerCase())) out.set(`${kind}:${m[1]!.toLowerCase()}`, { kind, token: m[1]!.toLowerCase(), ...(kind === 'greenhouse' && /\.eu\.greenhouse\.io/i.test(link) ? { eu: true } : {}) });
    }
  }
  return [...out.values()].slice(0, 2);
}

const alnum = (s: string | null | undefined) => String(s ?? '').toLowerCase().replace(/[^a-z0-9]/g, '');
/**
 * Whether a board is this company's: its token is the company's domain label or name ("northwind", "northwind-hq",
 * "northwindinc"). A site also links to its investors', customers' and partners' boards, and those are not its jobs.
 */
export function boardIsTheirs(b: Board, domain: string, name: string | null): boolean {
  const token = alnum(b.token);
  return [domain.split('.')[0], name].map(alnum).filter((x) => x.length >= 3).some((x) => token === x || (x.length >= 4 && (token.startsWith(x) || x.startsWith(token)) && Math.abs(token.length - x.length) <= 6));
}

export const boardApi = (b: Board) => b.kind === 'greenhouse' ? `https://boards-api.${b.eu ? 'eu.' : ''}greenhouse.io/v1/boards/${encodeURIComponent(b.token)}/jobs`
  : b.kind === 'lever' ? `https://api.lever.co/v0/postings/${encodeURIComponent(b.token)}?mode=json&limit=100` : `https://api.ashbyhq.com/posting-api/job-board/${encodeURIComponent(b.token)}`;
const boardPage = (b: Board) => b.kind === 'greenhouse' ? `https://boards.greenhouse.io/${b.token}` : b.kind === 'lever' ? `https://jobs.lever.co/${b.token}` : `https://jobs.ashbyhq.com/${b.token}`;

const text = (v: unknown, max: number) => (typeof v === 'string' ? v.replace(CONTROL, '').replace(/\s+/g, ' ').trim().slice(0, max) : '') || null;
const when = (v: unknown) => {
  const d = typeof v === 'number' ? new Date(v) : typeof v === 'string' ? new Date(v) : null;
  return d && !Number.isNaN(+d) ? d.toISOString().slice(0, 10) : null;
};
/** A posting links to the board's own host or to the company's site; anything else is the board's page. Text from a board is untrusted. */
function safeUrl(raw: unknown, b: Board, domain: string) {
  try {
    const u = new URL(String(raw));
    const host = u.hostname.toLowerCase().replace(/^www\./, '');
    if (u.protocol === 'https:' && (HOSTS[b.kind].test(host) || host === domain || host.endsWith(`.${domain}`))) return u.href;
  } catch { /* not a URL */ }
  return boardPage(b);
}

/** The board's postings, as the API gives them, in one shape. Anything unreadable is left out. */
export function parseBoard(b: Board, body: unknown, domain: string, now = new Date()): Posting[] {
  const list = (b.kind === 'lever' ? body : (body as { jobs?: unknown } | null)?.jobs) as unknown;
  if (!Array.isArray(list)) return [];
  const out: Posting[] = [];
  const today = now.toISOString().slice(0, 10);
  for (const raw of list.slice(0, 500)) {
    if (!raw || typeof raw !== 'object') continue;
    const j = raw as Record<string, any>;
    const title = text(b.kind === 'lever' ? j.text : j.title, 160);
    if (!title) continue;
    const location = text(b.kind === 'greenhouse' ? j.location?.name : b.kind === 'lever' ? j.categories?.location : (j.location ?? j.locationName), 120);
    // Greenhouse's updated_at moves on any edit, so an old role would look new: only the first publication counts. A date in the future is no date.
    const date = when(b.kind === 'greenhouse' ? j.first_published : b.kind === 'lever' ? j.createdAt : j.publishedAt);
    const posted = date && date <= today ? date : null;
    out.push({ title, location, posted_at: posted, url: safeUrl(b.kind === 'greenhouse' ? j.absolute_url : b.kind === 'lever' ? j.hostedUrl : j.jobUrl, b, domain) });
  }
  return out;
}

/** The newest dated postings still fresh, at most MAX_POSTINGS. An undated one says nothing about now. */
export function freshPostings(postings: Posting[], now: Date): Posting[] {
  const cutoff = new Date(+now - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10);
  return postings.filter((p) => p.posted_at && p.posted_at >= cutoff)
    .sort((x, y) => (y.posted_at ?? '').localeCompare(x.posted_at ?? '')).slice(0, MAX_POSTINGS);
}

export type HiringFact = { kind: 'hiring'; text: string; quote: string; source_url: string; published_at: string | null };

/**
 * Hiring facts for a company from the job boards its own pages link to. The quote is the job title as the board lists
 * it, and the source is the posting. Never fails the research: a board that cannot be read gives nothing.
 */
export async function hiringFacts(a: App, domain: string, pages: Page[], name: string | null = null): Promise<HiringFact[]> {
  const facts: HiringFact[] = [];
  for (const b of boardsIn(pages)) {
    if (!boardIsTheirs(b, domain, name)) { logEvent(a.db, a.now(), 'company.job_board_skipped', { domain, board: b.kind, token: b.token, reason: 'not their name' }); continue; }
    const body = await a.fetchJson(boardApi(b)).catch(() => null);
    if (body === null) { logEvent(a.db, a.now(), 'company.job_board_unread', { domain, board: b.kind }); continue; }
    // Greenhouse names the company on each posting: it has to be this one too
    const first = (b.kind === 'greenhouse' ? (body as { jobs?: Array<{ company_name?: unknown }> }).jobs?.[0]?.company_name : null);
    if (typeof first === 'string' && !boardIsTheirs({ ...b, token: first }, domain, name)) { logEvent(a.db, a.now(), 'company.job_board_skipped', { domain, board: b.kind, token: b.token, reason: 'another company name' }); continue; }
    const fresh = freshPostings(parseBoard(b, body, domain, a.now()), a.now());
    for (const p of fresh) facts.push({ kind: 'hiring', text: `Hiring: ${p.title}${p.location ? ` (${p.location})` : ''}`, quote: p.title, source_url: p.url, published_at: p.posted_at });
    logEvent(a.db, a.now(), 'company.job_board', { domain, board: b.kind, postings: fresh.length });
  }
  return facts.slice(0, MAX_POSTINGS);
}
