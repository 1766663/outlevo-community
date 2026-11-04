// The charts of the dashboard. No library: the page's rules allow only its own script, and nothing here needs one.
// Sizes go through element.style, which those rules allow, and everything shown goes in as text.
export const el = (tag, props = {}, ...kids) => {
  const n = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === 'class') n.className = v;
    else if (k === 'onclick') n.addEventListener('click', v);
    else if (v !== null && v !== undefined && v !== false) n.setAttribute(k, v);
  }
  for (const c of kids.flat()) if (c !== null && c !== undefined && c !== false) n.append(c.nodeType ? c : document.createTextNode(String(c)));
  return n;
};
const fmt = (n) => Number(n).toLocaleString();
const dayName = (d) => new Date(`${d}T12:00:00Z`).toLocaleDateString(undefined, { month: 'short', day: 'numeric', timeZone: 'UTC' });

const tip = () => document.getElementById('tip');
function showTip(mark, text) {
  const t = tip(); t.textContent = text; t.classList.add('on');
  const r = mark.getBoundingClientRect();
  t.style.left = `${Math.max(8, Math.min(window.innerWidth - t.offsetWidth - 8, r.left + r.width / 2 - t.offsetWidth / 2))}px`;
  t.style.top = `${Math.max(8, r.top - t.offsetHeight - 8)}px`;
}
const hideTip = () => tip().classList.remove('on');
/** A mark says its value on hover, on focus and on touch. */
function hoverable(n, text) {
  n.tabIndex = 0;
  n.setAttribute('aria-label', text);
  n.addEventListener('pointerenter', () => showTip(n, text));
  n.addEventListener('pointerleave', hideTip);
  n.addEventListener('focus', () => showTip(n, text));
  n.addEventListener('blur', hideTip);
  return n;
}
const sized = (n, prop, pct) => { n.style[prop] = `${pct}%`; return n; };

// What a person opened stays open when the page refreshes itself.
const opened = new Set();
function asTable(id, head, rows) {
  const d = el('details', { class: 'as-table' }, el('summary', {}, 'See as a table'),
    el('div', { class: 'table-wrap' }, el('table', {}, el('thead', {}, el('tr', {}, head.map((h) => el('th', { scope: 'col' }, h)))),
      el('tbody', {}, rows.map((r) => el('tr', {}, r.map((c) => el('td', {}, c))))))));
  d.open = opened.has(id);
  d.addEventListener('toggle', () => { if (d.open) opened.add(id); else opened.delete(id); });
  return d;
}

export const chartCard = (title, note, ...body) => el('section', { class: 'card chart' }, el('h3', {}, title), note && el('p', { class: 'small muted' }, note), ...body);

/** Ranked or ordered amounts, each named beside its bar. */
export function bars(id, rows, name = 'Count') {
  const max = Math.max(1, ...rows.map((r) => r.n));
  return [el('div', { class: 'bars' }, rows.map((r) => {
    const fill = sized(el('i', { class: 'fill' }), 'width', r.n ? Math.max(1, (r.n / max) * 100) : 0);
    return hoverable(el('div', { class: 'bar' }, el('span', { class: 'bar-label' }, r.label), el('span', { class: 'track' }, fill), el('b', {}, fmt(r.n))), `${r.label}: ${fmt(r.n)}`);
  })), asTable(id, ['', name], rows.map((r) => [r.label, fmt(r.n)]))];
}

/** A funnel: bars, and what share of the step before got through. */
export function funnel(id, steps) {
  const max = Math.max(1, ...steps.map((s) => s.n));
  const share = (s, i) => (i && steps[i - 1].n ? `${Math.round((s.n / steps[i - 1].n) * 100)}%` : '');
  return [el('div', { class: 'bars funnel' }, steps.map((s, i) => {
    const fill = sized(el('i', { class: 'fill' }), 'width', s.n ? Math.max(1, (s.n / max) * 100) : 0);
    return hoverable(el('div', { class: 'bar' }, el('span', { class: 'bar-label' }, s.label), el('span', { class: 'track' }, fill), el('b', {}, fmt(s.n)), el('span', { class: 'share small muted' }, share(s, i))), `${s.label}: ${fmt(s.n)}${share(s, i) ? `, ${share(s, i)} of the step before` : ''}`);
  })), asTable(id, ['Step', 'Companies', 'Of the step before'], steps.map((s, i) => [s.label, fmt(s.n), share(s, i)]))];
}

/** Columns over time or over ordered bands. An empty chart says so in words instead. */
export function columns(id, rows, { empty, name = 'Count' }) {
  if (!rows.some((r) => r.n)) return [el('p', { class: 'small muted empty' }, empty)];
  const max = Math.max(...rows.map((r) => r.n));
  const labelOf = (r) => r.label ?? dayName(r.day);
  return [el('div', { class: 'plot' },
    el('span', { class: 'y-max small muted' }, fmt(max)),
    el('div', { class: 'cols' }, rows.map((r) => hoverable(el('div', { class: 'col' }, r.n ? sized(el('i', { class: 'fill' }), 'height', Math.max(2, (r.n / max) * 100)) : null), `${labelOf(r)}: ${fmt(r.n)}`))),
    el('div', { class: 'x small muted' }, rows[0].day
      ? [el('span', {}, labelOf(rows[0])), el('span', {}, labelOf(rows[rows.length - 1]))]
      : rows.map((r) => el('span', {}, labelOf(r))))),
  asTable(id, [rows[0].day ? 'Day' : 'Band', name], rows.map((r) => [labelOf(r), fmt(r.n)]))];
}

/** Two parts of each row, with a legend, for how each industry went. */
export function splitBars(id, rows, [first, second]) {
  const max = Math.max(1, ...rows.map((r) => r.a + r.b));
  const part = (cls, amount) => { const n = el('i', { class: cls }); n.style.flexGrow = String(amount); return amount ? n : null; };
  return [el('div', { class: 'legend small' }, el('span', {}, el('i', { class: 'key' }), first), el('span', {}, el('i', { class: 'key s2' }), second)),
    el('div', { class: 'bars' }, rows.map((r) => hoverable(el('div', { class: 'bar' }, el('span', { class: 'bar-label' }, r.label),
      el('span', { class: 'track split' }, part('fill', r.a), part('fill s2', r.b), part('rest', max - r.a - r.b)),
      el('b', {}, `${fmt(r.a)} / ${fmt(r.a + r.b)}`)), `${r.label}: ${fmt(r.a)} ${first.toLowerCase()}, ${fmt(r.b)} ${second.toLowerCase()}`))),
    asTable(id, ['', first, second], rows.map((r) => [r.label, fmt(r.a), fmt(r.b)]))];
}

/** One amount against its ceiling. */
export function meter(value, of, label) {
  return el('div', { class: 'meter', role: 'img', 'aria-label': `${label}: ${fmt(value)} of ${fmt(of)}` }, sized(el('i', { class: 'fill' }), 'width', of ? Math.min(100, (value / of) * 100) : 0));
}
