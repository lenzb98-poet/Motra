// Date helpers. All dates are local calendar days stored as "YYYY-MM-DD".

const pad = n => String(n).padStart(2, '0');

export const toKey = d => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

export const fromKey = key => {
  const [y, m, d] = key.split('-').map(Number);
  return new Date(y, m - 1, d);
};

export const todayKey = () => toKey(new Date());

export const addDays = (key, n) => {
  const d = fromKey(key);
  d.setDate(d.getDate() + n);
  return toKey(d);
};

// Whole days from a to b (positive when b is later).
export const diffDays = (a, b) => Math.round((fromKey(b) - fromKey(a)) / 86400000);

export const minKey = (a, b) => (a < b ? a : b);
export const maxKey = (a, b) => (a > b ? a : b);

const fmt = (opts) => new Intl.DateTimeFormat('de-DE', opts);
const fLong = fmt({ weekday: 'long', day: 'numeric', month: 'long' });
const fShort = fmt({ day: 'numeric', month: 'numeric', year: '2-digit' });
const fDayMonth = fmt({ day: 'numeric', month: 'short' });
const fMonth = fmt({ month: 'short' });
const fMonthYear = fmt({ month: 'short', year: '2-digit' });
const fWeekdayShort = fmt({ weekday: 'short' });
const fWeekdayDate = fmt({ weekday: 'short', day: 'numeric', month: 'short' });

export const formatLong = key => fLong.format(fromKey(key));
export const formatShort = key => fShort.format(fromKey(key));
export const formatDayMonth = key => fDayMonth.format(fromKey(key)).replace(/(\p{L})\./u, '$1');
export const formatMonth = key => fMonth.format(fromKey(key)).replace(/(\p{L})\./u, '$1');
export const formatMonthYear = key => fMonthYear.format(fromKey(key)).replace(/(\p{L})\./u, '$1');
export const formatWeekday = key => fWeekdayShort.format(fromKey(key)).replace(/(\p{L})\./u, '$1');
export const formatWeekdayDate = key => fWeekdayDate.format(fromKey(key));

export const relativeDay = key => {
  const d = diffDays(key, todayKey());
  if (d === 0) return 'Heute';
  if (d === 1) return 'Gestern';
  if (d === 2) return 'Vorgestern';
  return formatWeekdayDate(key);
};

// Numbers in German notation, one decimal.
export const num1 = v => (v == null || Number.isNaN(v) ? '–' : v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
export const signed1 = v => (v > 0 ? '+' : v < 0 ? '−' : '±') + num1(Math.abs(v));

export const mean = arr => (arr.length ? arr.reduce((s, v) => s + v, 0) / arr.length : null);

export const uid = () => (crypto.randomUUID ? crypto.randomUUID() : Date.now().toString(36) + Math.random().toString(36).slice(2));

// Tiny DOM builder: h('div', {class: 'x', onclick}, child, 'text')
export function h(tag, attrs, ...children) {
  const el = document.createElement(tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
      else if (k === 'class') el.className = v;
      else if (k === 'style' && typeof v === 'object') {
        for (const [prop, val] of Object.entries(v)) {
          if (val == null) continue;
          if (prop.startsWith('--')) el.style.setProperty(prop, val);
          else el.style[prop] = val;
        }
      }
      else if (k === 'dataset') Object.assign(el.dataset, v);
      else if (v === true) el.setAttribute(k, '');
      else el.setAttribute(k, v);
    }
  }
  appendChildren(el, children);
  return el;
}

const SVG_NS = 'http://www.w3.org/2000/svg';
export function s(tag, attrs, ...children) {
  const el = document.createElementNS(SVG_NS, tag);
  if (attrs) {
    for (const [k, v] of Object.entries(attrs)) {
      if (v == null || v === false) continue;
      el.setAttribute(k, v);
    }
  }
  appendChildren(el, children);
  return el;
}

function appendChildren(el, children) {
  for (const c of children.flat()) {
    if (c == null || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

export const icon = (id, cls = '') => s('svg', { viewBox: '0 0 24 24', class: cls, 'aria-hidden': 'true' }, s('use', { href: `#${id}` }));
