// Hand-built SVG charts: mood over time, and mood together with medications.
import { s, h, addDays, diffDays, fromKey, formatDayMonth, formatMonth, formatMonthYear, formatWeekday, formatWeekdayDate, num1 } from './util.js';
import * as store from './store.js';

const tooltip = () => document.getElementById('tooltip');

/* ---------------- shared helpers ---------------- */

function scaleX(from, to, left, width) {
  const total = diffDays(from, to) + 1;
  return (date, offset = 0.5) => left + ((diffDays(from, date) + offset) / total) * width;
}

function scaleY(top, height) {
  return v => top + ((5 - v) / 4) * height;
}

// Date ticks thinned to a minimum pixel distance.
function dateTicks(from, to, x, minGap = 54) {
  const total = diffDays(from, to) + 1;
  let candidates = [];
  if (total <= 10) {
    for (let d = from; d <= to; d = addDays(d, 1)) candidates.push({ date: d, label: formatWeekday(d), sub: fromKey(d).getDate() + '.' });
  } else if (total <= 60) {
    for (let d = from; d <= to; d = addDays(d, 1)) if (fromKey(d).getDay() === 1) candidates.push({ date: d, label: formatDayMonth(d) });
  } else {
    const long = total > 400;
    for (let d = from; d <= to; d = addDays(d, 1)) {
      if (fromKey(d).getDate() === 1) candidates.push({ date: d, label: long ? formatMonthYear(d) : formatMonth(d), offset: 0 });
    }
  }
  const out = [];
  let lastX = -Infinity;
  for (const c of candidates) {
    const px = x(c.date, c.offset ?? 0.5);
    if (px - lastX >= minGap) { out.push({ ...c, x: px }); lastX = px; }
  }
  return out;
}

// Splits a list of {date, value} into runs, breaking where the gap exceeds maxGap days.
function runs(points, maxGap) {
  const out = [];
  let cur = [];
  for (const p of points) {
    if (cur.length && diffDays(cur[cur.length - 1].date, p.date) > maxGap) { out.push(cur); cur = []; }
    cur.push(p);
  }
  if (cur.length) out.push(cur);
  return out;
}

// Smooth path through points (monotone cubic, keeps the curve from overshooting).
function smoothPath(pts) {
  if (pts.length === 1) return `M${pts[0][0]},${pts[0][1]}`;
  const n = pts.length;
  const dx = [], dy = [], m = [];
  for (let i = 0; i < n - 1; i++) {
    dx[i] = pts[i + 1][0] - pts[i][0];
    dy[i] = pts[i + 1][1] - pts[i][1];
    m[i] = dy[i] / dx[i];
  }
  const t = [m[0]];
  for (let i = 1; i < n - 1; i++) t[i] = m[i - 1] * m[i] <= 0 ? 0 : (m[i - 1] + m[i]) / 2;
  t[n - 1] = m[n - 2];
  for (let i = 0; i < n - 1; i++) {
    if (m[i] === 0) { t[i] = 0; t[i + 1] = 0; continue; }
    const a = t[i] / m[i], b = t[i + 1] / m[i], sq = a * a + b * b;
    if (sq > 9) { const k = 3 / Math.sqrt(sq); t[i] = k * a * m[i]; t[i + 1] = k * b * m[i]; }
  }
  let d = `M${pts[0][0]},${pts[0][1]}`;
  for (let i = 0; i < n - 1; i++) {
    const c = dx[i] / 3;
    d += ` C${pts[i][0] + c},${pts[i][1] + t[i] * c} ${pts[i + 1][0] - c},${pts[i + 1][1] - t[i + 1] * c} ${pts[i + 1][0]},${pts[i + 1][1]}`;
  }
  return d;
}

const linePath = pts => pts.map((p, i) => `${i ? 'L' : 'M'}${p[0]},${p[1]}`).join(' ');

function yAxis(svg, y, left, right) {
  const g = s('g', { class: 'axis' });
  for (let v = 1; v <= 5; v++) {
    g.append(s('line', { x1: left, x2: right, y1: y(v), y2: y(v), class: v === 1 ? 'baseline' : 'grid' }));
    g.append(s('circle', { cx: 8, cy: y(v), r: 3.5, style: `fill:var(--m${v})` }));
    g.append(s('text', { x: 16, y: y(v), class: 'tick', 'dominant-baseline': 'central' }, v));
  }
  svg.append(g);
}

function xAxis(svg, ticks, yPos) {
  const g = s('g', { class: 'axis' });
  for (const t of ticks) {
    g.append(s('text', { x: t.x, y: yPos, class: 'tick', 'text-anchor': 'middle' }, t.label));
    if (t.sub) g.append(s('text', { x: t.x, y: yPos + 13, class: 'tick muted', 'text-anchor': 'middle' }, t.sub));
  }
  svg.append(g);
}

// Crosshair + tooltip. `describe(date)` returns tooltip content or null.
function attachHover(svg, { from, to, left, width, top, bottom, x, describe, label }) {
  const total = diffDays(from, to) + 1;
  const cross = s('line', { class: 'crosshair', y1: top, y2: bottom, x1: -10, x2: -10, visibility: 'hidden' });
  const hit = s('rect', { x: left, y: top, width, height: bottom - top, class: 'hit', tabindex: '0', role: 'img', 'aria-label': label });
  svg.append(cross, hit);
  let current = null;

  const show = (date, clientX, clientY) => {
    current = date;
    const content = describe(date);
    const px = x(date);
    cross.setAttribute('x1', px); cross.setAttribute('x2', px);
    cross.setAttribute('visibility', 'visible');
    const tip = tooltip();
    tip.replaceChildren(content);
    tip.hidden = false;
    const r = tip.getBoundingClientRect();
    const vw = document.documentElement.clientWidth;
    let lx = clientX + 14;
    if (lx + r.width > vw - 8) lx = clientX - r.width - 14;
    lx = Math.max(8, lx);
    let ly = clientY - r.height - 12;
    if (ly < 8) ly = clientY + 18;
    tip.style.transform = `translate(${Math.round(lx)}px, ${Math.round(ly)}px)`;
  };
  const hide = () => {
    current = null;
    cross.setAttribute('visibility', 'hidden');
    tooltip().hidden = true;
  };
  const dateAt = clientX => {
    const box = svg.getBoundingClientRect();
    const px = clientX - box.left;
    const idx = Math.max(0, Math.min(total - 1, Math.floor(((px - left) / width) * total)));
    return addDays(from, idx);
  };
  hit.addEventListener('pointermove', e => show(dateAt(e.clientX), e.clientX, e.clientY));
  hit.addEventListener('pointerdown', e => show(dateAt(e.clientX), e.clientX, e.clientY));
  hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  hit.addEventListener('blur', hide);
  hit.addEventListener('keydown', e => {
    if (!['ArrowLeft', 'ArrowRight', 'Home', 'End', 'Escape'].includes(e.key)) return;
    e.preventDefault();
    if (e.key === 'Escape') return hide();
    let d = current ?? to;
    if (e.key === 'ArrowLeft') d = addDays(d, -1);
    if (e.key === 'ArrowRight') d = addDays(d, 1);
    if (e.key === 'Home') d = from;
    if (e.key === 'End') d = to;
    if (d < from) d = from;
    if (d > to) d = to;
    const box = svg.getBoundingClientRect();
    show(d, box.left + x(d), box.top + top + 20);
  });
  return hide;
}

// Hide any open tooltip when tapping elsewhere (touch has no pointerleave).
document.addEventListener('pointerdown', e => {
  if (!e.target.closest?.('.hit')) {
    const tip = tooltip();
    if (tip) tip.hidden = true;
    document.querySelectorAll('.crosshair').forEach(c => c.setAttribute('visibility', 'hidden'));
  }
});

function tipHead(date) {
  return h('div', { class: 'tip-head' }, formatWeekdayDate(date));
}

function tipRow(key, value, label) {
  return h('div', { class: 'tip-row' }, key, h('strong', null, value), h('span', null, label));
}

const keyLine = cls => h('span', { class: `key-line ${cls}` });
const keyDot = v => h('span', { class: 'key-dot', style: { background: store.moodColor(v) } });

function emptyState(container, text) {
  container.replaceChildren(h('div', { class: 'chart-empty' }, text));
}

/* ---------------- mood chart ---------------- */

export function moodChart(container, { from, to }) {
  const width = Math.max(280, container.clientWidth);
  const total = diffDays(from, to) + 1;
  const stats = store.rangeStats(from, to);
  if (!stats.count) return emptyState(container, 'Noch keine Einträge in diesem Zeitraum. Trag auf „Heute“ deine Stimmung ein, dann erscheint sie hier.');

  const M = { top: 12, right: 14, bottom: total <= 10 ? 38 : 26, left: 30 };
  const plotH = 200;
  const H = M.top + plotH + M.bottom;
  const left = M.left, right = width - M.right, plotW = right - left;
  const x = scaleX(from, to, left, plotW);
  const y = scaleY(M.top, plotH);
  const svg = s('svg', { viewBox: `0 0 ${width} ${H}`, width, height: H, class: 'chart-svg' });

  yAxis(svg, y, left, right);
  xAxis(svg, dateTicks(from, to, x), M.top + plotH + 18);

  // single entries
  const dense = total > 120;
  const dots = s('g', { class: 'entries' });
  for (const e of store.getState().entries) {
    if (e.date < from || e.date > to) continue;
    const off = store.SLOTS.find(sl => sl.id === e.slot).offset;
    dots.append(s('circle', { cx: x(e.date, off), cy: y(e.mood), r: dense ? 2.2 : total > 45 ? 2.8 : 4, style: `fill:${store.moodColor(e.mood)}`, class: 'entry-dot' }));
  }
  svg.append(dots);

  // daily average line
  const dayPts = [];
  const trendPts = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = store.dayAverage(d);
    if (v != null) dayPts.push({ date: d, value: v });
    const t = store.trend(d);
    if (t != null) trendPts.push({ date: d, value: t });
  }
  for (const run of runs(dayPts, 2)) {
    const pts = run.map(p => [x(p.date), y(p.value)]);
    svg.append(s('path', { d: linePath(pts), class: `line-day${dense ? ' faint' : ''}` }));
    if (run.length === 1) svg.append(s('circle', { cx: pts[0][0], cy: pts[0][1], r: 2, class: 'day-dot' }));
  }
  // 7-day trend
  let lastTrend = null;
  for (const run of runs(trendPts, 1)) {
    const pts = run.map(p => [x(p.date), y(p.value)]);
    svg.append(s('path', { d: smoothPath(pts), class: 'line-trend' }));
    lastTrend = { ...run[run.length - 1], px: pts[pts.length - 1] };
  }
  if (lastTrend) {
    svg.append(s('circle', { cx: lastTrend.px[0], cy: lastTrend.px[1], r: 5, class: 'end-dot' }));
  }

  attachHover(svg, {
    from, to, left, width: plotW, top: M.top, bottom: M.top + plotH, x,
    label: `Stimmungsverlauf vom ${formatWeekdayDate(from)} bis ${formatWeekdayDate(to)}. Pfeiltasten wählen einen Tag.`,
    describe: date => {
      const entries = store.dayEntries(date);
      const avg = store.dayAverage(date);
      const t = store.trend(date);
      const box = h('div', null, tipHead(date));
      if (avg == null) box.append(h('div', { class: 'tip-empty' }, 'Kein Eintrag'));
      else box.append(tipRow(keyLine('day'), num1(avg), 'Tagesdurchschnitt'));
      if (t != null) box.append(tipRow(keyLine('trend'), num1(t), '7-Tage-Schnitt'));
      for (const sl of store.SLOTS) {
        const e = entries[sl.id];
        if (e) box.append(tipRow(keyDot(e.mood), store.formatMood(e.mood), `${sl.label} · ${store.moodLabel(e.mood)}`));
      }
      const notes = store.SLOTS.map(sl => entries[sl.id]?.note).filter(Boolean);
      if (notes.length) box.append(h('div', { class: 'tip-note' }, notes.join(' · ')));
      return box;
    },
  });

  container.replaceChildren(svg);
}

export function moodLegend(el) {
  el.replaceChildren(
    h('span', { class: 'legend-item' }, keyLine('trend'), '7-Tage-Schnitt'),
    h('span', { class: 'legend-item' }, keyLine('day'), 'Tagesdurchschnitt'),
    h('span', { class: 'legend-item' }, h('span', { class: 'key-dots' }, [1, 3, 5].map(keyDot)), 'Einzelne Einträge'),
  );
}

/* ---------------- mood + medication chart ---------------- */

export function medChart(container, { from, to }) {
  const meds = store.getState().meds;
  const width = Math.max(280, container.clientWidth);
  const total = diffDays(from, to) + 1;
  const hasMood = store.rangeStats(from, to).count > 0;
  if (!meds.length && !hasMood) return emptyState(container, 'Sobald du Medikamente und ein paar Stimmungseinträge hast, siehst du hier beides übereinander.');

  const M = { top: 12, right: 14, left: 30 };
  const plotH = 150;
  const laneH = 44;
  const lanesTop = M.top + plotH + 18;
  const axisY = lanesTop + meds.length * laneH + 16;
  const H = axisY + (total <= 10 ? 22 : 8);
  const left = M.left, right = width - M.right, plotW = right - left;
  const x = scaleX(from, to, left, plotW);
  const y = scaleY(M.top, plotH);
  const svg = s('svg', { viewBox: `0 0 ${width} ${H}`, width, height: H, class: 'chart-svg' });

  yAxis(svg, y, left, right);

  // event markers across the mood plot
  const markers = s('g', { class: 'markers' });
  for (const m of meds) {
    for (const ev of store.medEvents(m)) {
      if (ev.date < from || ev.date > to) continue;
      const px = x(ev.date, 0);
      markers.append(s('line', { x1: px, x2: px, y1: M.top, y2: lanesTop + meds.indexOf(m) * laneH + 16, class: 'marker', style: `stroke:var(--c${m.color + 1})` }));
    }
  }
  svg.append(markers);

  // mood: daily average dots + trend
  const trendPts = [];
  const dotG = s('g');
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = store.dayAverage(d);
    if (v != null) dotG.append(s('circle', { cx: x(d), cy: y(v), r: total > 120 ? 2 : 2.8, class: 'avg-dot' }));
    const t = store.trend(d);
    if (t != null) trendPts.push({ date: d, value: t });
  }
  svg.append(dotG);
  for (const run of runs(trendPts, 1)) {
    svg.append(s('path', { d: smoothPath(run.map(p => [x(p.date), y(p.value)])), class: 'line-trend' }));
  }
  if (!hasMood) {
    svg.append(s('text', { x: left + plotW / 2, y: M.top + plotH / 2, class: 'tick', 'text-anchor': 'middle' }, 'Keine Stimmungseinträge in diesem Zeitraum'));
  }

  // medication lanes
  const lanes = s('g', { class: 'lanes' });
  meds.forEach((m, i) => {
    const ly = lanesTop + i * laneH;
    lanes.append(s('text', { x: left, y: ly + 10, class: 'lane-name' }, m.name));
    lanes.append(s('line', { x1: left, x2: right, y1: ly + 21, y2: ly + 21, class: 'lane-track' }));
    let any = false;
    let lastLabelEnd = -Infinity;
    m.phases.forEach((p, pi) => {
      const ps = p.start < from ? from : p.start;
      const pe = p.end == null || p.end > to ? to : p.end;
      if (ps > to || pe < from) return;
      any = true;
      const x1 = x(ps, 0);
      const prevTouching = pi > 0 && m.phases[pi - 1].end && addDays(m.phases[pi - 1].end, 1) === p.start && p.start > from;
      const xs = x1 + (prevTouching ? 2 : 0); // 2px surface gap between consecutive doses
      const x2 = x(pe, 1);
      const w = Math.max(3, x2 - xs);
      const open = p.end == null || p.end > to;
      lanes.append(s('path', { d: barPath(xs, ly + 16, w, 10, p.start >= from, !open), style: `fill:var(--c${m.color + 1})`, class: 'lane-bar' }));
      const label = p.dose || '';
      const tx = Math.max(xs, left);
      const estW = label.length * 6.2;
      if (label && tx >= lastLabelEnd + 6 && tx + estW <= right) {
        lanes.append(s('text', { x: tx, y: ly + 39, class: 'lane-dose' }, label));
        lastLabelEnd = tx + estW;
      }
    });
    if (!any) lanes.append(s('text', { x: right, y: ly + 10, class: 'lane-none', 'text-anchor': 'end' }, 'nicht im Zeitraum'));
  });
  svg.append(lanes);

  xAxis(svg, dateTicks(from, to, x), axisY);

  attachHover(svg, {
    from, to, left, width: plotW, top: M.top, bottom: lanesTop + meds.length * laneH, x,
    label: `Stimmung und Medikamente vom ${formatWeekdayDate(from)} bis ${formatWeekdayDate(to)}. Pfeiltasten wählen einen Tag.`,
    describe: date => {
      const box = h('div', null, tipHead(date));
      const avg = store.dayAverage(date);
      const t = store.trend(date);
      if (avg == null) box.append(h('div', { class: 'tip-empty' }, 'Kein Stimmungseintrag'));
      else box.append(tipRow(h('span', { class: 'key-dot neutral' }), num1(avg), 'Tagesdurchschnitt'));
      if (t != null) box.append(tipRow(keyLine('trend'), num1(t), '7-Tage-Schnitt'));
      const active = meds.map(m => [m, store.activePhase(m, date)]).filter(([, p]) => p);
      if (active.length) {
        box.append(h('div', { class: 'tip-sep' }));
        for (const [m, p] of active) {
          box.append(tipRow(h('span', { class: 'key-bar', style: { background: `var(--c${m.color + 1})` } }), p.dose || '–', m.name));
        }
      } else if (meds.length) {
        box.append(h('div', { class: 'tip-empty' }, 'Keine Medikamente'));
      }
      for (const m of meds) {
        for (const ev of store.medEvents(m)) {
          if (ev.date === date) box.append(h('div', { class: 'tip-note' }, eventText(ev)));
        }
      }
      return box;
    },
  });

  container.replaceChildren(svg);
}

// Bar with 4px rounded ends where the phase really starts/ends inside the range.
function barPath(x, y, w, hgt, roundStart, roundEnd) {
  const r = Math.min(4, w / 2, hgt / 2);
  const rs = roundStart ? r : 0, re = roundEnd ? r : 0;
  return `M${x + rs},${y} H${x + w - re} ${re ? `Q${x + w},${y} ${x + w},${y + re}` : ''} V${y + hgt - re} ${re ? `Q${x + w},${y + hgt} ${x + w - re},${y + hgt}` : ''} H${x + rs} ${rs ? `Q${x},${y + hgt} ${x},${y + hgt - rs}` : ''} V${y + rs} ${rs ? `Q${x},${y} ${x + rs},${y}` : ''} Z`;
}

export function eventText(ev) {
  const n = ev.med.name;
  if (ev.type === 'start') return `${n} begonnen${ev.dose ? ` (${ev.dose})` : ''}`;
  if (ev.type === 'restart') return `${n} wieder begonnen${ev.dose ? ` (${ev.dose})` : ''}`;
  if (ev.type === 'dose') return `${n}: ${ev.prevDose || '–'} → ${ev.dose || '–'}`;
  return `${n} abgesetzt`;
}

export function medLegend(el) {
  const meds = store.getState().meds;
  el.replaceChildren(
    h('span', { class: 'legend-item' }, keyLine('trend'), '7-Tage-Schnitt'),
    h('span', { class: 'legend-item' }, h('span', { class: 'key-dot neutral' }), 'Tagesdurchschnitt'),
    ...meds.map(m => h('span', { class: 'legend-item' }, h('span', { class: 'key-bar', style: { background: `var(--c${m.color + 1})` } }), m.name)),
  );
}

