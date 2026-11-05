import { TLDS } from './tlds.js';

export type Claim = { text: string; fact_id: number };
export type KnownFact = { id: number; text: string; quote: string };
export type LintIssue = { level: 'error' | 'warning'; rule: string; message: string };
export type LintInput = {
  subject: string; body: string; step?: number; claims?: Claim[];
  facts?: KnownFact[]; productFacts?: Array<{ text: string; quote: string }>; allowedLinkDomains?: string[];
  strict?: boolean; // false for `outlevo check` on an email written elsewhere: there are no facts to hold it against
};

const SPAM = ['act now', 'limited time', 'guarantee', '100% free', 'risk-free', 'no obligation', 'click here', 'buy now', 'cash', 'winner', 'double your', 'once in a lifetime', 'urgent'];
const FAKE_HISTORY = /\b(as (we )?(discussed|promised|agreed)\b(?! (in|on) (your|the|their))|following up on our (call|chat|conversation)|per our (call|conversation)|great (talking|speaking|chatting) (to|with) you|nice (to|meeting) you (again|last)|when we (spoke|talked|met)|like we (discussed|agreed)|per my last (email|message)|thanks for getting back to me|great meeting you)\b/i;
const FAKE_FIRST = /\b(following up on (my|our) (last|previous|earlier)|thanks for (the|our) (call|chat|meeting)|as (i|we) mentioned)\b/i;
const MACHINE = /\b(i hope this (email|message) finds you|i came across your (company|profile|website)|hope you('| a)re (doing )?well|in today'?s fast-paced|leverage synerg|unlock (the )?(full )?potential|game-?changer|revolutionize|seamless(ly)? integrat)\b/i;
const NUMBER = /(?<![\w.])[$€£]?\d[\d,]*(?:\.\d+)?\s?(?:%|k\b|m\b|bn?\b)?/gi;

const normalizeNumber = (s: string) => s.toLowerCase().replace(/[\s,$€£]/g, '');
const numbersIn = (s: string) => new Set([...s.matchAll(NUMBER)].map((m) => normalizeNumber(m[0])));
const normText = (s: string) => s.toLowerCase().replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

// The people have to be what the sentence is about: "Outlevo finds firms like that" says nothing about how they behave.
const GENERAL_CLAIM = /^(most |many |those |these |such )?(buyers?|customers?|clients?|founders?|teams?|companies|firms?|people|prospects?|ceos?|owners?)\s+(like\s+(that|this|these|those|you|yours)|(of\s+)?that\s+size)\b/i;

/** Rules, not a model: the same email always gets the same answer, and it works with no key and no network. */
const SCHEME_LINK = /https?:\/\/[^\s)>\]]+/gi;
// Mail programs turn evil.example/login into a link with no scheme.
const BARE_HOST = /(?<![\p{L}\p{N}._-])((?:[\p{L}\p{N}_](?:[\p{L}\p{N}_-]*[\p{L}\p{N}_])?\.)+(?:\p{L}{2,}|xn--[a-z0-9-]+))(?![\p{L}\p{N}_@-])((?:[:/?#][^\s)>\]]+)?)/giu;
const BARE_IP = /(?<![\w.@-])\d{1,3}(?:\.\d{1,3}){3}[:/][^\s)>\]]+/g;
const INVISIBLE = /[­​-‍⁠﻿]/g;
const WIDE_DOT = /(?<=[a-z0-9-])[。．｡](?=[a-z0-9])/gi;
// Written out so a filter misses it. "the dot com era" is English, so a plain "dot" counts only before the commonest endings.
const SPELLED_MARK = /(?<![a-z0-9-])((?:[a-z0-9-]+\s*(?:\[\.\]|\(\.\)|\[dot\]|\(dot\)|\{dot\})\s*)+)([a-z]{2,})\b/gi;
const SPELLED_WORD = /(?<![a-z0-9-])([a-z0-9-]+)\s+dot\s+(com|net|org|io|ai|co|app|dev|xyz|info|biz)\b/gi;
const hostOf = (url: string) => { try { return new URL(url).hostname; } catch { return ''; } };

const unescaped = (s: string) => { let t = s; for (let i = 0; i < 2; i++) { try { t = decodeURIComponent(t); } catch { break; } } return t; };
/** The hosts a link hands on to, in its query or spelled out in its path: a redirect on an allowed site goes wherever it is told. */
export function hostsInside(url: string): string[] {
  let u: URL; try { u = new URL(url); } catch { return []; }
  const inPath = /https?:/i.test(unescaped(u.pathname)) ? unescaped(u.pathname).replace(/^.*?(https?:)/i, '$1') : '';
  return linksIn(`${inPath} ${unescaped(u.search + u.hash).replace(/[?&#=]/g, ' ')}`).map((l) => hostOf(l.url).replace(/^www\./, '')).filter(Boolean);
}

/** Every link in the text. `full` is what reads as a link, against a plain mention of a domain, which still has to be allowed but is not counted as one. */
export function linksIn(raw: string): Array<{ url: string; full: boolean }> {
  const text = raw.replace(INVISIBLE, '').replace(WIDE_DOT, '.');
  const out = [...text.matchAll(SCHEME_LINK)].map((m) => ({ url: m[0], full: true }));
  const rest = text.replace(SCHEME_LINK, ' ');
  for (const m of rest.matchAll(BARE_HOST)) {
    const [, host, path] = m as unknown as [string, string, string];
    if (rest[m.index - 1] === '@' && !path) continue; // An email address.
    const url = `https://${host}${path}`;
    // With nothing after it, only a real domain ending is a link: "Node.js", "schema.sql" and "pricing.We" are words.
    if (!path && (!TLDS.has(hostOf(url).split('.').at(-1)!) || host.toLowerCase() === 'asp.net')) continue;
    out.push({ url, full: Boolean(path) || /^www\./i.test(host) });
  }
  for (const m of rest.matchAll(BARE_IP)) out.push({ url: `https://${m[0]}`, full: true });
  for (const m of rest.matchAll(SPELLED_MARK)) if (TLDS.has(m[2]!.toLowerCase())) out.push({ url: `https://${m[1]!.replace(/\s*(?:\[\.\]|\(\.\)|\[dot\]|\(dot\)|\{dot\})\s*/gi, '.')}${m[2]}`, full: true });
  for (const m of rest.matchAll(SPELLED_WORD)) if (!/^(the|a|an|polka|per|this|that)$/i.test(m[1]!)) out.push({ url: `https://${m[1]}.${m[2]}`, full: true });
  return out;
}

export function lintEmail(i: LintInput): LintIssue[] {
  const strict = i.strict !== false; const step = i.step ?? 1;
  const out: LintIssue[] = [];
  const add = (level: LintIssue['level'], rule: string, message: string) => out.push({ level, rule, message });
  const hard = strict ? 'error' : 'warning';
  const all = `${i.subject}\n${i.body}`;

  if (!i.subject.trim()) add('error', 'subject-empty', strict ? 'The subject is empty' : 'No subject found: start the file with a line like Subject: Your subject');
  if (!i.body.trim()) add('error', 'body-empty', 'The body is empty');
  if (/^\s*(re|fw|fwd|aw|sv|antw|wg)(\[\d+\])?\s*:/i.test(i.subject) && step === 1) add('error', 'fake-thread', 'A first email must not pretend to be a reply or a forward');
  if (FAKE_HISTORY.test(all) || (step === 1 && FAKE_FIRST.test(all))) add('error', 'fake-history', 'It claims a past conversation');
  if (/\{\{.*?\}\}|\[(first ?name|name|company|your [^\]]+|insert[^\]]*)\]|<(first_?name|company)>/i.test(all)) add('error', 'merge-tag', 'A merge tag or placeholder would go out blank');

  const words = i.body.trim().split(/\s+/).filter(Boolean).length;
  const maxWords = step === 1 ? 150 : 110;
  if (words > maxWords) add(hard, 'too-long', `${words} words; keep it under ${maxWords}`);
  if (i.subject.length > 70) add('warning', 'subject-long', 'The subject is over 70 characters');
  if (i.subject.length > 6 && i.subject === i.subject.toUpperCase() && /[A-Z]/.test(i.subject)) add('error', 'subject-caps', 'The subject is in capitals');
  if (/!{2,}|\?{2,}/.test(all)) add('warning', 'punctuation', 'Repeated punctuation reads as spam');
  for (const w of SPAM) if (new RegExp(`\\b${w.replace(/[%-]/g, '\\$&')}(d|s)?\\b`, 'i').test(all)) add('warning', 'spam-word', `Spam-filter phrase: "${w}"`);
  if (MACHINE.test(all)) add('warning', 'machine-writing', 'A stock opener or phrase that reads as machine-written');
  // "Buyers like that delete generic pitches fast": nobody can source it, and it reads as a fact. As a question it is fine.
  for (const s of i.body.split(/(?<=[.!?])\s+/)) if (!s.trim().endsWith('?') && GENERAL_CLAIM.test(s.trim())) add(hard, 'general-claim', `"${s.trim()}" says how people behave, with no source. Ask it, or leave it out`);

  const links = linksIn(i.body);
  const counted = links.filter((l) => l.full).length;
  if (counted > 1) add(hard, 'links', `${counted} links; a cold email carries one at most`);
  if (i.allowedLinkDomains) for (const l of links) {
    let host = ''; try { host = new URL(l.url).hostname.replace(/^www\./, ''); } catch { /* reported below */ }
    const fits = (h: string) => i.allowedLinkDomains!.some((d) => h === d || h.endsWith(`.${d}`));
    if (!fits(host)) add('error', 'link-domain', `A link goes to ${host || l.url}, which is neither your site nor the prospect's`);
    for (const inside of hostsInside(l.url)) if (!fits(inside)) add('error', 'link-domain', `A link hands on to ${inside}, which is neither your site nor the prospect's`);
  }
  if (!strict) {
    // outlevo check knows neither your site nor theirs: it names each link, which a send allows only to those two.
    for (const l of links) add('warning', 'check-link', `A link to ${hostOf(l.url) || l.url}: when Outlevo sends, an email may link only to your site or the prospect's`);
    // With no sources to hold it against, it can only point at the figures most often made up.
    for (const m of all.matchAll(/(?<![\w.])\d[\d,.]*\s?(%|x\b)/gi)) add('warning', 'check-number', `"${m[0].trim()}": is this true for this person? outlevo check has no sources to hold it against`);
    return out;
  }

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
  // From the quote, which code found on the page, never from the model's own wording of it.
  for (const c of claims) { const f = facts.get(c.fact_id); if (f) for (const n of numbersIn(f.quote)) known.add(n); }
  for (const f of i.productFacts ?? []) for (const n of numbersIn(f.quote)) known.add(n);
  for (const m of all.matchAll(NUMBER)) if (!known.has(normalizeNumber(m[0]))) add('error', 'unsourced-number', `"${m[0].trim()}" is not in any fact this email cites`);
  return out;
}

export const hasErrors = (issues: LintIssue[]) => issues.some((x) => x.level === 'error');

/** `Subject: …` on the first line, then the body. */
export function parseEmailFile(text: string): { subject: string; body: string } {
  const m = text.match(/^\s*subject\s*:\s*(.*)\r?\n([\s\S]*)$/i);
  return m ? { subject: m[1]!.trim(), body: m[2]!.trim() } : { subject: '', body: text.trim() };
}
