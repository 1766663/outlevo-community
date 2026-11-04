// Scraped text and replies from strangers are on this page: everything goes in through el(), as text, never as HTML.
const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const safeUrl = (u) => { try { const x = new URL(u); return x.protocol === 'http:' || x.protocol === 'https:' ? x.href : null; } catch { return null; } };
const extLink = (u, label) => (safeUrl(u) ? el('a', { href: safeUrl(u), target: '_blank', rel: 'noopener noreferrer' }, label ?? u) : (label ?? u));
const when = (s) => (s ? new Date(s).toLocaleString() : '');

const TABS = [['review', 'To review'], ['replies', 'Replies'], ['meetings', 'Meetings'], ['companies', 'Companies'], ['activity', 'Activity'], ['setup', 'Setup']];
let tab = 'review'; let state = null; let doctor = null; let busy = false;

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

const views = {
  review() {
    const s = state;
    return [
      el('h1', {}, 'To review'),
      el('p', { class: 'muted' }, 'Nothing goes out until you approve it. Green text is a claim about the company; its source is under the email.'),
      el('div', { class: 'stats' },
        [['Meetings booked', s.pipeline.meetings], ['Companies waiting', s.pipeline.new], ['Qualified', s.pipeline.qualified], ['Contacts', s.pipeline.contacts], ['Approved, waiting to send', s.pipeline.approved], ['Sent today', `${s.sending.today} / ${s.sending.limit}`]]
          .map(([k, v]) => el('div', { class: 'stat' }, el('b', {}, v), el('span', { class: 'small muted' }, k)))),
      s.review.length ? s.review.map(reviewCard)
        : el('div', { class: 'card' }, el('h3', {}, 'Nothing to review'), el('p', { class: 'muted' }, s.pipeline.qualified && !s.pipeline.contacts ? 'You have qualified companies but nobody to write to. Import contacts, or find verified ones with Outlevo Cloud.' : 'Add companies with outlevo companies import, then run outlevo run.')),
    ];
  },
  replies() {
    if (!state.replies.length) return [el('h1', {}, 'Replies'), el('div', { class: 'card' }, el('p', { class: 'muted' }, 'No replies yet.'))];
    return [el('h1', {}, 'Replies'), state.replies.map((r) => el('article', { class: 'card' },
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
    return [el('h1', {}, 'Meetings'), el('div', { class: 'card table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Who', 'Company', 'Booked', 'Status'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, state.meetings.map((m) => el('tr', {},
        el('td', {}, `${m.first_name} ${m.last_name ?? ''}`, m.job && el('div', { class: 'small muted' }, m.job)),
        el('td', {}, m.company || m.domain),
        el('td', { class: 'small muted' }, when(m.booked_at)),
        el('td', {}, el('span', { class: `pill ${m.status === 'booked' ? 'good' : ''}` }, m.status)))))))];
  },
  companies() {
    const pill = { qualified: 'good', disqualified: '', error: 'bad', new: 'warn' };
    return [el('h1', {}, 'Companies'), el('div', { class: 'card table-wrap' }, el('table', {},
      el('thead', {}, el('tr', {}, ['Company', 'Status', 'Fit', 'Why'].map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, state.companies.map((c) => {
        const why = c.reasons ? JSON.parse(c.reasons) : null;
        return el('tr', {},
          el('td', {}, extLink(`https://${c.domain}`, c.name || c.domain)),
          el('td', {}, el('span', { class: `pill ${pill[c.status] ?? ''}` }, c.status)),
          el('td', {}, c.score ?? ''),
          el('td', { class: 'small' }, c.error || (why ? [...why.reasons.map((r) => r.text), ...why.missing.map((m) => `Unknown: ${m}`)].join(' · ') : '')));
      }))))];
  },
  activity() {
    return [el('h1', {}, 'Activity'), el('p', { class: 'muted' }, 'Everything that sent mail or spent money.'), el('div', { class: 'card table-wrap' }, el('table', {},
      el('tbody', {}, state.events.map((e) => el('tr', {}, el('td', { class: 'small muted' }, when(e.at)), el('td', {}, e.kind), el('td', { class: 'small muted' }, e.data ?? ''))))))];
  },
  setup() {
    return [el('h1', {}, 'Setup'),
      state.product && el('div', { class: 'card' }, el('h3', {}, 'What you sell'), el('p', {}, state.product.summary)),
      state.icp && el('div', { class: 'card' }, el('h3', {}, 'Who you sell to'), el('p', {}, state.icp.summary), el('p', { class: 'small muted' }, `Buyers: ${state.icp.buyer_titles.join(', ')}. ${state.icp.learned_from}`)),
      el('div', { class: 'card' }, el('h3', {}, 'Ready to send?'), (doctor ?? []).map((c) => el('p', { class: 'issue' }, el('span', { class: `pill ${c.ok ? 'good' : c.blocking ? 'bad' : 'warn'}` }, c.ok ? 'OK' : c.blocking ? 'Needed' : 'Advice'), ` ${c.name}`, !c.ok && el('span', { class: 'small muted' }, ` · ${c.detail}`)))),
      el('div', { class: 'card upsell' }, el('h3', {}, 'What Outlevo Cloud adds'), el('p', { class: 'muted' }, 'Verified contacts at each company, warmed-up mailboxes, sending while your laptop is closed, and CRM sync. Optional: Community keeps working without it.'), extLink('https://outlevo.com/?utm_source=community&utm_medium=dashboard', 'See Outlevo Cloud'))];
  },
};

function render() {
  if (!state) return;
  document.getElementById('tabs').replaceChildren(...TABS.map(([k, label]) => {
    const n = k === 'review' ? state.review.length : k === 'replies' ? state.replies.filter((r) => r.suggested_status === 'pending').length : 0;
    return el('button', { type: 'button', 'aria-current': tab === k ? 'page' : null, onclick: () => { tab = k; render(); document.getElementById('main').focus(); } }, n ? `${label} (${n})` : label);
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
