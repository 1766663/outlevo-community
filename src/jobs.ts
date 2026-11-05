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

export type Board = { kind: 'greenhouse' | 'lever' | 'ashby'; token: string };
export type Posting = { title: string; url: string; location: string | null; posted_at: string | null };

/** A posting counts this long after its date; one with no date counts while it is listed. */
export const FRESH_DAYS = 60;
/** At most this many postings become facts: the newest. */
export const MAX_POSTINGS = 5;

const PATTERNS: Array<[Board['kind'], RegExp]> = [
  ['greenhouse', /^https?:\/\/(?:boards|job-boards)\.greenhouse\.io\/(?:embed\/job_board\?for=)?([a-z0-9_-]{2,80})(?:[/?#]|$)/i],
  ['lever', /^https?:\/\/jobs\.lever\.co\/([a-z0-9_.-]{2,80})(?:[/?#]|$)/i],
  ['ashby', /^https?:\/\/jobs\.ashbyhq\.com\/([a-z0-9_.-]{2,80})(?:[/?#]|$)/i],
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
      if (m && !['embed', 'jobs', 'api'].includes(m[1]!.toLowerCase())) out.set(`${kind}:${m[1]!.toLowerCase()}`, { kind, token: m[1]!.toLowerCase() });
    }
  }
  return [...out.values()].slice(0, 2);
}

export const boardApi = (b: Board) => b.kind === 'greenhouse' ? `https://boards-api.greenhouse.io/v1/boards/${encodeURIComponent(b.token)}/jobs`
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
export function parseBoard(b: Board, body: unknown, domain: string): Posting[] {
  const list = (b.kind === 'lever' ? body : (body as { jobs?: unknown } | null)?.jobs) as unknown;
  if (!Array.isArray(list)) return [];
  const out: Posting[] = [];
  for (const raw of list.slice(0, 500)) {
    const j = raw as Record<string, any>;
    const title = text(b.kind === 'lever' ? j.text : j.title, 160);
    if (!title) continue;
    const location = text(b.kind === 'greenhouse' ? j.location?.name : b.kind === 'lever' ? j.categories?.location : (j.location ?? j.locationName), 120);
    const posted = when(b.kind === 'greenhouse' ? (j.first_published ?? j.updated_at) : b.kind === 'lever' ? j.createdAt : j.publishedAt);
    out.push({ title, location, posted_at: posted, url: safeUrl(b.kind === 'greenhouse' ? j.absolute_url : b.kind === 'lever' ? j.hostedUrl : j.jobUrl, b, domain) });
  }
  return out;
}

/** The newest postings still fresh, at most MAX_POSTINGS. */
export function freshPostings(postings: Posting[], now: Date): Posting[] {
  const cutoff = new Date(+now - FRESH_DAYS * 86_400_000).toISOString().slice(0, 10);
  return postings.filter((p) => !p.posted_at || p.posted_at >= cutoff)
    .sort((x, y) => (y.posted_at ?? '').localeCompare(x.posted_at ?? '')).slice(0, MAX_POSTINGS);
}

export type HiringFact = { kind: 'hiring'; text: string; quote: string; source_url: string; published_at: string | null };

/**
 * Hiring facts for a company from the job boards its own pages link to. The quote is the job title as the board lists
 * it, and the source is the posting. Never fails the research: a board that cannot be read gives nothing.
 */
export async function hiringFacts(a: App, domain: string, pages: Page[]): Promise<HiringFact[]> {
  const facts: HiringFact[] = [];
  for (const b of boardsIn(pages)) {
    const body = await a.fetchJson(boardApi(b)).catch(() => null);
    const fresh = freshPostings(parseBoard(b, body, domain), a.now());
    for (const p of fresh) facts.push({ kind: 'hiring', text: `Hiring: ${p.title}${p.location ? ` (${p.location})` : ''}`, quote: p.title, source_url: p.url, published_at: p.posted_at });
    logEvent(a.db, a.now(), 'company.job_board', { domain, board: b.kind, postings: fresh.length });
  }
  return facts.slice(0, MAX_POSTINGS);
}
