export type Claim = { text: string; fact_id: number };
export type KnownFact = { id: number; text: string; quote: string };
export type LintIssue = { level: 'error' | 'warning'; rule: string; message: string };
export type LintInput = {
  subject: string; body: string; step?: number; claims?: Claim[];
  facts?: KnownFact[]; productFacts?: Array<{ text: string; quote: string }>; allowedLinkDomains?: string[];
  strict?: boolean; // false for `outlevo check` on an email written elsewhere: there are no facts to hold it against
};

const SPAM = ['act now', 'limited time', 'guarantee', '100% free', 'risk-free', 'no obligation', 'click here', 'buy now', 'cash', 'winner', 'double your', 'once in a lifetime', 'urgent'];
const FAKE_HISTORY = /\b(as (we )?(discussed|promised|agreed)|following up on our (call|chat|conversation)|per our (call|conversation)|great (talking|speaking|chatting) (to|with) you|nice (to|meeting) you (again|last)|when we (spoke|talked|met))\b/i;
const MACHINE = /\b(i hope this (email|message) finds you|i came across your (company|profile|website)|hope you('| a)re (doing )?well|in today'?s fast-paced|leverage synerg|unlock (the )?(full )?potential|game-?changer|revolutionize|seamless(ly)? integrat)\b/i;
const NUMBER = /(?<![\w.])[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:%|k\b|m\b|bn?\b)?/gi;

const normalizeNumber = (s: string) => s.toLowerCase().replace(/[\s,$€£]/g, '');
const numbersIn = (s: string) => new Set([...s.matchAll(NUMBER)].map((m) => normalizeNumber(m[0])));
const normText = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

/** Rules, not a model: the same email always gets the same answer, and it works with no key and no network. */
export function lintEmail(i: LintInput): LintIssue[] {
  const strict = i.strict !== false; const step = i.step ?? 1;
  const out: LintIssue[] = [];
  const add = (level: LintIssue['level'], rule: string, message: string) => out.push({ level, rule, message });
  const hard = strict ? 'error' : 'warning';
  const all = `${i.subject}\n${i.body}`;

  if (!i.subject.trim()) add('error', 'subject-empty', 'The subject is empty');
  if (!i.body.trim()) add('error', 'body-empty', 'The body is empty');
  if (/^\s*(re|fw|fwd)\s*:/i.test(i.subject) && step === 1) add('error', 'fake-thread', 'A first email must not pretend to be a reply or a forward');
  if (FAKE_HISTORY.test(all)) add('error', 'fake-history', 'It claims a past conversation');
  if (/\{\{.*?\}\}|\[(first ?name|name|company|your [^\]]+|insert[^\]]*)\]|<(first_?name|company)>/i.test(all)) add('error', 'merge-tag', 'A merge tag or placeholder would go out blank');

  const words = i.body.trim().split(/\s+/).filter(Boolean).length;
  const maxWords = step === 1 ? 150 : 110;
  if (words > maxWords) add(hard, 'too-long', `${words} words; keep it under ${maxWords}`);
  if (i.subject.length > 70) add('warning', 'subject-long', 'The subject is over 70 characters');
  if (i.subject.length > 6 && i.subject === i.subject.toUpperCase() && /[A-Z]/.test(i.subject)) add('error', 'subject-caps', 'The subject is in capitals');
  if (/!{2,}|\?{2,}/.test(all)) add('warning', 'punctuation', 'Repeated punctuation reads as spam');
  for (const w of SPAM) if (new RegExp(`\\b${w.replace(/[%-]/g, '\\$&')}`, 'i').test(all)) add('warning', 'spam-word', `Spam-filter phrase: "${w}"`);
  if (MACHINE.test(all)) add('warning', 'machine-writing', 'A stock opener or phrase that reads as machine-written');

  const links = [...i.body.matchAll(/https?:\/\/[^\s)>\]]+/gi)].map((m) => m[0]);
  if (links.length > 1) add(hard, 'links', `${links.length} links; a cold email carries one at most`);
  if (i.allowedLinkDomains) for (const l of links) {
    let host = ''; try { host = new URL(l).hostname.replace(/^www\./, ''); } catch { /* reported below */ }
    if (!i.allowedLinkDomains.some((d) => host === d || host.endsWith(`.${d}`))) add('error', 'link-domain', `A link goes to ${host || l}, which is neither your site nor the prospect's`);
  }
  if (!strict) return out;

  // Every claim names a fact we read on a page, and the words really are in the email.
  const facts = new Map((i.facts ?? []).map((f) => [f.id, f]));
  const claims = i.claims ?? [];
  if (step === 1 && !claims.length) add('error', 'no-claim', 'A first email must say something true about this company, with its source');
  const body = normText(i.body);
  for (const c of claims) {
    if (!facts.has(c.fact_id)) add('error', 'unknown-fact', `"${c.text}" cites fact ${c.fact_id}, which does not exist`);
    if (!body.includes(normText(c.text))) add('error', 'claim-not-in-email', `"${c.text}" is not in the email`);
  }

  // A number nobody can trace is the commonest invention: it has to be in a cited fact or in a fact about the product.
  const known = new Set<string>();
  for (const c of claims) { const f = facts.get(c.fact_id); if (f) for (const n of numbersIn(`${f.text} ${f.quote}`)) known.add(n); }
  for (const f of i.productFacts ?? []) for (const n of numbersIn(`${f.text} ${f.quote}`)) known.add(n);
  for (const m of all.matchAll(NUMBER)) if (!known.has(normalizeNumber(m[0]))) add('error', 'unsourced-number', `"${m[0].trim()}" is not in any fact this email cites`);
  return out;
}

export const hasErrors = (issues: LintIssue[]) => issues.some((x) => x.level === 'error');

/** `Subject: …` on the first line, then the body. */
export function parseEmailFile(text: string): { subject: string; body: string } {
  const m = text.match(/^\s*subject\s*:\s*(.*)\r?\n([\s\S]*)$/i);
  return m ? { subject: m[1]!.trim(), body: m[2]!.trim() } : { subject: '', body: text.trim() };
}
