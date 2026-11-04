// Scraped text and replies from strangers are on this page: everything goes in through el(), as text, never as HTML.
import { bars, chartCard, columns, el, funnel, meter, splitBars } from '/charts.js';

const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const extLink = (u, label) => (safeUrl(u) ? el('a', { href: safeUrl(u), target: '_blank', rel: 'noopener noreferrer' }, label ?? u) : (label ?? u));
const when = (s) => (s ? new Date(s).toLocaleString() : '');

const TABS = [['overview', 'Overview'], ['review', 'To review'], ['replies', 'Replies'], ['meetings', 'Meetings'], ['companies', 'Companies'], ['activity', 'Activity'], ['setup', 'Setup']];
let tab = 'overview'; let state = null; let doctor = null; let busy = false; let companyFilter = 'all';
const go = (t) => { tab = t; render(); document.getElementById('main').focus(); };
const tiles = (rows) => el('div', { class: 'stats' }, rows.map(([k, v, note]) => el('div', { class: 'stat' }, el('b', {}, v), el('span', { class: 'small muted' }, k), note)));
const pct = (a, b) => (b ? `${Math.round((a / b) * 100)}%` : '–');
const REPLY_NAMES = { interested: 'Interested', question: 'Asked a question', not_now: 'Not now', unsubscribe: 'Asked to stop', out_of_office: 'Out of office', wrong_person: 'Wrong person', other: 'Other' };
const EVENT_NAMES = { 'email.sent': 'Email sent', 'email.bounced': 'Email bounced', 'reply.received': 'Reply received', 'reply.sent': 'Answer sent', 'meeting.booked': 'Meeting booked', 'meeting.cancelled': 'Meeting cancelled', 'meeting.unproven': 'Booking not trusted', 'sequence.written': 'Emails written', 'sequence.approved': 'Emails approved', 'sequence.rejected': 'Emails rejected', 'company.written': 'Emails written', 'company.researched': 'Company researched', 'company.dropped': 'Company dropped', 'company.restored': 'Company put back', 'companies.discovered': 'Companies found', 'companies.imported': 'Companies imported', 'contacts.imported': 'Contacts imported', 'contacts.found': 'Contacts found', 'contacts.searched': 'Contacts searched', 'emails.rewritten': 'Emails rewritten', 'emails.rewrite_refused': 'Rewrite refused', 'icp.learned': 'Ideal customer worked out', 'product.learned': 'Your site read', 'product.switched': 'Site changed', 'pack.built': 'Pack built', 'sending.stopped': 'Sending stopped', 'sending.resumed': 'Sending resumed', 'send.suppressed': 'Email not sent: address blocked', 'suppression.added': 'Address blocked', 'mail.unmatched': 'Mail matched nobody' };

const toast = (msg) => { const t = document.getElementById('toast'); t.textContent = msg; t.classList.add('on'); setTimeout(() => t.classList.remove('on'), 3500); };

async function post(path, body = {}) {
  const r = await fetch(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error || 'That did not work');
  return j;
}
function act(btn, working, fn) {
  return async () => {
    if (busy) return;
    busy = true; const label = btn().textContent; btn().disabled = true; btn().textContent = working;
    try { const m = await fn(); await load(); if (m) toast(m); }
    catch (e) { toast(e.message); btn().disabled = false; btn().textContent = label; }
    finally { busy = false; render(); }
  };
}
function button(label, cls, working, fn) {
  const b = el('button', { class: `btn ${cls}`, type: 'button' }, label);
  b.addEventListener('click', act(() => b, working, fn));
  return b;
}

function bodyWithClaims(body, claims) {
  const out = el('div', { class: 'body' });
  let rest = body;
  for (const c of claims) {
    const i = rest.indexOf(c.text);
    if (i < 0) continue;
    out.append(rest.slice(0, i), el('mark', {}, c.text));
    rest = rest.slice(i + c.text.length);
  }
  out.append(rest);
  return out;
}

function reviewCard(g) {
  const blocked = g.status === 'blocked';
  return el('article', { class: 'card' },
    el('div', { class: 'row' },
      el('div', {}, el('h3', {}, `${g.name}${g.title ? `, ${g.title}` : ''}`), el('div', { class: 'small muted' }, `${g.company || g.domain} · ${g.email}`)),
      el('span', { class: `pill ${blocked ? 'bad' : g.email_source === 'verified' ? 'good' : ''}` }, blocked ? 'Failed the checks' : g.email_source === 'verified' ? 'Verified address' : g.email_source === 'published' ? 'Address from their site' : 'Address you imported')),
    g.why?.length ? el('p', { class: 'small muted' }, `Why this company: ${g.why.join(' · ')}`) : null,
    g.angle && el('p', { class: 'small muted' }, `Angle: ${g.angle}`),
    g.emails.map((e) => el('section', { class: 'email' },
      el('div', { class: 'small muted' }, e.step === 1 ? 'First email' : `Follow-up ${e.step - 1}, after ${e.delay_days} days`),
      el('div', { class: 'subject' }, e.subject),
      bodyWithClaims(e.body, e.claims),
      e.claims.map((c) => el('span', { class: 'source' }, c.source ? [`"${c.source.quote}" `, extLink(c.source.source_url, 'source'), ` · read ${when(c.source.fetched_at)}`] : `No source found for "${c.text}"`)),
      e.issues.map((x) => el('p', { class: `issue ${x.level}` }, x.message)))),
    el('div', { class: 'actions' },
      !blocked && button(g.emails.length === 1 ? 'Approve this email' : `Approve these ${g.emails.length} emails`, 'go', 'Approving…', async () => { await post('/api/approve', { id: g.contact_id }); return `Approved for ${g.name}`; }),
      button(blocked ? 'Throw away' : 'Reject', '', 'Rejecting…', async () => { await post('/api/reject', { id: g.contact_id }); return 'Rejected'; })));
}

/** An event's details in words, with a company's name and not its number. */
function eventDetail(data) {
  let d; try { d = JSON.parse(data ?? '{}'); } catch { return data ?? ''; }
  return Object.entries(d).flatMap(([k, v]) => {
    if (k === 'company_id') { const c = state.companies.find((x) => x.id === v); return [c ? c.domain : `company ${v}`]; }
    if (k === 'blocked') return v ? ['failed the checks'] : [];
    if (k === 'reused') return v ? ['reused'] : [];
    if (v !== null && typeof v === 'object') return [Object.entries(v).map(([x, n]) => `${x} ${n}`).join(', ')];
    return [`${k.replaceAll('_', ' ')}: ${v}`];
  }).join(' · ');
}

/** The main reason, with the rest a click away: a long list in every row makes the table unreadable. What a company that did not fit lacks comes first. */
function whyCell(why, fit) {
  const said = why.reasons.map((r) => r.text); const lacks = why.missing.map((m) => `Unknown: ${m}`);
  const [main, ...rest] = fit ? [...said, ...lacks] : [...lacks, ...said];
  return [main ?? '', rest.length ? el('details', {}, el('summary', { class: 'muted' }, `${rest.length} more`), el('ul', {}, rest.map((r) => el('li', {}, r)))) : null];
}

/** What a person should do next, in one line. */
function nextStep(s) {
  const f = s.charts.funnel;
  if (s.review.length) return [`${s.review.length} ${s.review.length === 1 ? 'person waits' : 'people wait'} for your approval.`, 'Review them', 'review'];
  if (s.replies.some((r) => r.suggested_status === 'pending')) return ['A reply has an answer waiting for you.', 'See replies', 'replies'];
  if ((doctor ?? []).some((c) => !c.ok && c.blocking)) return ['Sending is off until your setup is finished.', 'See what is needed', 'setup'];
  if (!f[0].n) return ['Nothing here yet. Run: outlevo start https://yourcompany.com'];
  if (!f[3].n) return ['You have companies but nobody to write to. Import contacts, or find them with outlevo contacts find.'];
  return ['Nothing needs you right now.'];
}

const views = {
  overview() {
    const s = state; const c = s.charts; const r = c.rates; const [text, label, to] = nextStep(s);
    return [
      el('h1', {}, 'Overview'),
      el('div', { class: 'card next row' }, el('span', {}, text), to && el('button', { class: 'btn go', type: 'button', onclick: () => go(to) }, label)),
      tiles([
        ['Meetings booked', s.pipeline.meetings, el('span', { class: 'small muted' }, `${pct(r.booked, r.people_written)} of people written to`)],
        ['Replied', r.replied, el('span', { class: 'small muted' }, `${pct(r.replied, r.people_written)} of ${r.people_written} written to`)],
        ['Sent today', `${s.sending.today} / ${s.sending.limit}`, meter(s.sending.today, s.sending.limit, 'Sent today')],
        ['Bounced', r.bounced, el('span', { class: 'small muted' }, `${pct(r.bounced, r.people_written)}. Sending stops at ${Math.round(r.bounce_stop_rate * 100)}%`)],
      ]),
      chartCard('From company to meeting', 'Companies at each step, and what share of the step before got through.', funnel('funnel', c.funnel)),
      el('div', { class: 'two' },
        chartCard('Emails sent', 'Last 14 days', columns('sent', c.sent_by_day, { empty: 'Nothing sent yet.', name: 'Emails' })),
        chartCard('Replies', 'Last 14 days', columns('replies14', c.replies_by_day, { empty: 'No replies yet.', name: 'Replies' }))),
      c.industries.length ? chartCard('Where the companies come from', 'Each industry is searched on its own, so one does not fill the list.', splitBars('industries', c.industries.map((x) => ({ label: x.segment, a: x.fit, b: x.other })), ['Fit', 'Did not fit or not done'])) : null,
    ];
  },
  review() {
    const s = state;
    return [
      el('h1', {}, 'To review'),
      el('p', { class: 'muted' }, 'Nothing goes out until you approve it. Green text is a claim about the company; its source is under the email.'),
      s.review.length ? s.review.map(reviewCard)
        : el('div', { class: 'card' }, el('h3', {}, 'Nothing to review'), el('p', { class: 'muted' }, s.pipeline.qualified && !s.pipeline.contacts ? 'You have qualified companies but nobody to write to. Import contacts, or find verified ones with Outlevo Cloud.' : 'Nothing is waiting for you. New emails appear here as outlevo run writes them.')),
    ];
  },
  replies() {
    if (!state.replies.length) return [el('h1', {}, 'Replies'), el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No replies yet.'))];
    const c = state.charts; const r = c.rates;
    return [el('h1', {}, 'Replies'),
      tiles([['Replies', c.reply_kinds.reduce((t, k) => t + k.n, 0)], ['Reply rate', pct(r.replied, r.people_written), el('span', { class: 'small muted' }, `of ${r.people_written} people written to`)], ['Waiting for your answer', state.replies.filter((x) => x.suggested_status === 'pending').length]]),
      el('div', { class: 'two' },
        chartCard('What they said', null, bars('kinds', c.reply_kinds.map((k) => ({ label: REPLY_NAMES[k.label] ?? k.label.replaceAll('_', ' '), n: k.n })), 'Replies')),
        chartCard('Replies', 'Last 14 days', columns('replies', c.replies_by_day, { empty: 'None in the last 14 days.', name: 'Replies' }))),
      state.replies.map((r) => el('article', { class: 'card' },
      el('div', { class: 'row' },
        el('div', {}, el('h3', {}, r.first_name ? `${r.first_name} ${r.last_name ?? ''}` : r.from_addr), el('div', { class: 'small muted' }, `${r.domain ?? ''} · ${when(r.received_at)}`)),
        el('span', { class: `pill ${r.class === 'interested' ? 'good' : r.class === 'unsubscribe' ? 'bad' : ''}` }, r.class.replaceAll('_', ' '))),
      el('p', { class: 'small muted' }, r.reason),
      el('pre', {}, r.text),
      r.suggested && el('div', { class: 'email' }, el('div', { class: 'small muted' }, r.suggested_status === 'sent' ? 'You sent this answer' : r.suggested_status === 'dismissed' ? 'Dismissed answer' : 'Suggested answer'), el('div', { class: 'body' }, r.suggested)),
      r.suggested_status === 'pending' && el('div', { class: 'actions' },
        button('Send this answer', 'go', 'Sending…', async () => { await post('/api/reply/send', { id: r.id }); return 'Sent'; }),
        button('Dismiss', '', 'Dismissing…', async () => { await post('/api/reply/dismiss', { id: r.id }); return null; }))))];
  },
  meetings() {
    if (!state.meetings.length) return [el('h1', {}, 'Meetings'), el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No meetings yet. They appear here when Calendly, Cal.com or Google Calendar emails you a booking with someone you wrote to.'))];
    const c = state.charts; const r = c.rates;
    return [el('h1', {}, 'Meetings'),
      tiles([['Booked', state.pipeline.meetings], ['Per person written to', pct(r.booked, r.people_written), el('span', { class: 'small muted' }, `of ${r.people_written} people`)], ['Per reply', pct(r.booked, r.replied), el('span', { class: 'small muted' }, `of ${r.replied} who replied`)]]),
      chartCard('Meetings booked', 'Last 14 days', columns('meetings', c.meetings_by_day, { empty: 'None in the last 14 days.', name: 'Meetings' })),
      el('div', { class: 'card table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Who', 'Company', 'Booked', 'Status'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, state.meetings.map((m) => el('tr', {},
        el('td', {}, `${m.first_name} ${m.last_name ?? ''}`, m.job && el('div', { class: 'small muted' }, m.job)),
        el('td', {}, m.company || m.domain),
        el('td', { class: 'small muted' }, when(m.booked_at)),
        el('td', {}, el('span', { class: `pill ${m.status === 'booked' ? 'good' : ''}` }, m.status)))))))];
  },
  companies() {
    const pill = { qualified: 'good', disqualified: '', error: 'bad', new: 'warn', dropped: '' };
    const names = { qualified: 'Fit', disqualified: 'Did not fit', error: 'Could not read', new: 'Not done yet', dropped: 'Dropped' };
    const c = state.charts;
    const counts = new Map(c.status_counts.map((x) => [x.status, x.n]));
    const total = c.status_counts.reduce((t, x) => t + x.n, 0);
    const rows = state.companies.filter((x) => companyFilter === 'all' || x.status === companyFilter);
    const hasSegments = state.companies.some((x) => x.segment);
    return [el('h1', {}, 'Companies'),
      total ? el('div', { class: 'two' },
        chartCard('How well they fit', 'Companies by fit score, out of 100.', columns('scores', c.scores, { empty: 'None scored yet.', name: 'Companies' })),
        c.industries.length ? chartCard('By industry', null, splitBars('industries2', c.industries.map((x) => ({ label: x.segment, a: x.fit, b: x.other })), ['Fit', 'Did not fit or not done'])) : null) : null,
      el('div', { class: 'chips', role: 'group', 'aria-label': 'Show companies' }, [['all', `All ${total}`], ...['qualified', 'disqualified', 'new', 'error', 'dropped'].filter((k) => counts.get(k)).map((k) => [k, `${names[k]} ${counts.get(k)}`])]
        .map(([k, label]) => el('button', { type: 'button', class: 'chip', 'aria-pressed': String(companyFilter === k), onclick: () => { companyFilter = k; render(); } }, label))),
      el('div', { class: 'card table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Company', 'Status', 'Fit', ...(hasSegments ? ['Industry'] : []), 'Why'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, rows.map((x) => {
        const why = x.reasons ? JSON.parse(x.reasons) : null;
        return el('tr', {},
          el('td', {}, extLink(`https://${x.domain}`, x.name || x.domain)),
          el('td', {}, el('span', { class: `pill ${pill[x.status] ?? ''}` }, names[x.status] ?? x.status)),
          el('td', { class: 'fit' }, x.score === null ? '' : [el('b', {}, x.score), meter(x.score, 100, 'Fit')]),
          hasSegments ? el('td', { class: 'small muted' }, x.segment ?? 'Your list') : null,
          el('td', { class: 'small why' }, x.error || (why ? whyCell(why, x.status === 'qualified') : '')));
      })))),
      total > state.companies.length ? el('p', { class: 'small muted' }, `Showing the top ${state.companies.length} by fit.`) : null];
  },
  activity() {
    const c = state.charts;
    return [el('h1', {}, 'Activity'),
      el('div', { class: 'two' },
        chartCard('Model calls', 'Last 14 days. Each one costs money on your key.', columns('calls', c.calls_by_day, { empty: 'None in the last 14 days.', name: 'Calls' })),
        chartCard('Emails sent', 'Last 14 days', columns('sent2', c.sent_by_day, { empty: 'Nothing sent yet.', name: 'Emails' }))),
      el('h2', {}, 'The latest 40 things that happened'),
      el('div', { class: 'card table-wrap' }, el('table', {},
      el('tbody', {}, state.events.map((e) => el('tr', {}, el('td', { class: 'small muted nowrap' }, when(e.at)), el('td', {}, EVENT_NAMES[e.kind] ?? e.kind), el('td', { class: 'small muted' }, eventDetail(e.data)))))))];
  },
  setup() {
    return [el('h1', {}, 'Setup'),
      state.product && el('div', { class: 'card' }, el('h3', {}, 'What you sell'), el('p', {}, state.product.summary)),
      state.icp && el('div', { class: 'card' }, el('h3', {}, 'Who you sell to'), el('p', {}, state.icp.summary), el('p', { class: 'small muted' }, `Buyers: ${state.icp.buyer_titles.join(', ')}. ${state.icp.learned_from}`)),
      el('div', { class: 'card' }, el('h3', {}, 'Ready to send?'), doctor?.length ? [el('p', { class: 'small muted' }, `${doctor.filter((c) => c.ok).length} of ${doctor.length} checks pass`), meter(doctor.filter((c) => c.ok).length, doctor.length, 'Checks that pass')] : null, (doctor ?? []).map((c) => el('p', { class: 'issue' }, el('span', { class: `pill ${c.ok ? 'good' : c.blocking ? 'bad' : 'warn'}` }, c.ok ? 'OK' : c.blocking ? 'Needed' : 'Advice'), ` ${c.name}`, !c.ok && el('span', { class: 'small muted' }, ` · ${c.detail}`)))),
      el('div', { class: 'card upsell' }, el('h3', {}, 'What Outlevo Cloud adds'), el('p', { class: 'muted' }, 'Verified contacts at each company, warmed-up mailboxes, sending while your laptop is closed, and CRM sync. Optional: Community keeps working without it.'), extLink('https://outlevo.com/?utm_source=community&utm_medium=dashboard', 'See Outlevo Cloud'))];
  },
};

function render() {
  if (!state) return;
  document.getElementById('tabs').replaceChildren(...TABS.map(([k, label]) => {
    const n = k === 'review' ? state.review.length : k === 'replies' ? state.replies.filter((r) => r.suggested_status === 'pending').length : 0;
    return el('button', { type: 'button', 'aria-current': tab === k ? 'page' : null, onclick: () => go(k) }, n ? `${label} (${n})` : label);
  }));
  document.getElementById('stop').replaceChildren(state.stopped
    ? button('Resume sending', 'go', 'Resuming…', async () => { await post('/api/resume'); return 'Sending resumed'; })
    : button('Stop all sending', 'danger', 'Stopping…', async () => { await post('/api/stop'); return 'All sending stopped'; }));
  const main = document.getElementById('main');
  const y = window.scrollY;
  main.replaceChildren(...[state.stopped && el('div', { class: 'banner' }, `Sending is stopped. ${state.stopped}`), ...views[tab]()].flat().filter(Boolean));
  window.scrollTo(0, y);
}

async function load() {
  const r = await fetch('/api/state');
  if (!r.ok) throw new Error('Open the link that outlevo dashboard printed');
  state = await r.json();
  doctor = await (await fetch('/api/doctor')).json();
}
const refresh = async () => { if (busy || document.hidden) return; try { await load(); render(); } catch (e) { toast(e.message); } };
load().then(render).catch((e) => { document.getElementById('main').replaceChildren(el('p', {}, e.message)); });
setInterval(refresh, 20_000);
