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
  // no info while two fingers zoom the chart
  hit.addEventListener('pointermove', e => { if (!svg.dataset.zooming) show(dateAt(e.clientX), e.clientX, e.clientY); });
  hit.addEventListener('pointerdown', e => { if (!svg.dataset.zooming) show(dateAt(e.clientX), e.clientX, e.clientY); });
  hit.addEventListener('pointerleave', e => { if (e.pointerType === 'mouse') hide(); });
  // Touch: the info shows while the finger is on the chart and goes away when it is lifted.
  for (const type of ['pointerup', 'pointercancel']) hit.addEventListener(type, e => { if (e.pointerType !== 'mouse') hide(); });
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
  const sick = store.sickOn(date);
  return h('div', { class: 'tip-head' }, formatWeekdayDate(date), sick ? h('span', { class: 'tip-sick' }, `Krank · ${sick.title}`) : null);
}

// Periods of illness: a red striped background across the plot, in every chart.
let sickSeq = 0;
function sickLayer(svg, { from, to, x, top, height }) {
  const id = `sick-${++sickSeq}`;
  svg.append(s('defs', null,
    s('pattern', { id: `${id}-bg`, width: 8, height: 8, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      s('rect', { width: 3, height: 8, class: 'sick-stripe' })),
    s('pattern', { id: `${id}-bar`, width: 6, height: 6, patternUnits: 'userSpaceOnUse', patternTransform: 'rotate(45)' },
      s('rect', { width: 6, height: 6, class: 'sick-bar-bg' }), s('rect', { width: 3, height: 6, class: 'sick-bar-stripe' }))));
  const g = s('g', { class: 'sick-layer' });
  for (const r of store.sickIn(from, to)) {
    const a = x(r.from, 0), w = Math.max(2, x(r.to, 1) - a);
    g.append(s('rect', { x: a, y: top, width: w, height, class: 'sick-tint' }));
    g.append(s('rect', { x: a, y: top, width: w, height, style: `fill:url(#${id}-bg)` }));
  }
  svg.append(g);
  return `url(#${id}-bar)`;
}

// Legend entry, only when an illness falls into the range.
const sickLegend = (from, to) => (from && store.sickIn(from, to).length
  ? h('span', { class: 'legend-item' }, h('span', { class: 'key-sick' }), 'Krank') : null);

function tipRow(key, value, label) {
  return h('div', { class: 'tip-row' }, key, h('strong', null, value), h('span', null, label));
}

const keyLine = cls => h('span', { class: `key-line ${cls}` });
const keyDot = v => h('span', { class: 'key-dot', style: { background: store.moodColor(v) } });

function emptyState(container, text) {
  container.replaceChildren(h('div', { class: 'chart-empty' }, text));
}

/* ---------------- mood chart ---------------- */

/* ---------------- the timeline: one chart for everything ----------------
   Top: mood (single entries, daily average, 7-day trend), illness as red stripes behind it.
   Middle: the shared date axis.
   Below: a color band (Morgen / Mittag / Abend), then optional lanes for medications & therapies
   and for activities. The lanes are labelled directly, so the legend stays short. */

const kindOf = m => (m.kind === 'therapy' ? 'therapy' : 'med');

export function timelineChart(container, { from, to, meds: withMeds = true, moments: withMoments = false, onZoom = null, bounds = null }) {
  const width = Math.max(280, container.clientWidth);
  const total = diffDays(from, to) + 1;
  const stats = store.rangeStats(from, to);

  // which lanes to draw
  // archived things stay out of the chart (their data is kept and comes back when restored)
  const medLanes = !withMeds ? [] : [...store.getState().meds]
    .filter(m => !m.archived && m.phases.some(p => p.start <= to && (p.end == null || p.end >= from)))
    .sort((a, b) => (kindOf(a) === 'therapy') - (kindOf(b) === 'therapy'));
  const colors = store.momentColors();
  const momentList = withMoments ? store.momentsIn(from, to).filter(m => !m.sick && !m.archived) : [];
  const groups = new Map();
  for (const m of momentList) {
    const key = m.title.toLowerCase();
    const g = groups.get(key) ?? { key, name: m.title, items: [], span: false, first: m.date };
    g.items.push(m); g.name = m.title;
    if (m.span) g.span = true;
    if (m.date < g.first) g.first = m.date;
    groups.set(key, g);
  }
  const actLanes = [...groups.values()].sort((a, b) => Number(b.span) - Number(a.span) || a.first.localeCompare(b.first) || (a.key < b.key ? -1 : 1));
  const colorOf = m => `var(--c${(colors.get(m.title.toLowerCase()) ?? 0) + 1})`;

  if (!stats.count && !medLanes.length && !actLanes.length) {
    return emptyState(container, 'Noch keine Einträge in diesem Zeitraum. Trag auf „Heute“ deine Stimmung ein, dann erscheint sie hier.');
  }

  // layout
  const M = { top: 12, right: 14, left: 30 };
  const plotH = 190;
  // Order below the plot: date axis, then the lanes (so their start/end lines run straight up
  // into the plot), then the color band at the very bottom.
  const plotBottom = M.top + plotH;
  const axisSpace = total <= 10 ? 44 : 30;
  const boxes = total <= 31;
  const ROW = boxes ? 15 : 12, GAP = boxes ? 3 : 2;
  const bandH = store.SLOTS.length * ROW + (store.SLOTS.length - 1) * GAP;
  const LANE = 30, GROUP = 26;
  const laneRows = [];
  const laneY = new Map();            // med id / activity key → y of its lane
  let yy = plotBottom + axisSpace - GROUP + 18;   // first group label sits clear of the date labels
  const addGroup = (label, lanes, kind) => {
    if (!lanes.length) return;
    yy += GROUP;
    laneRows.push({ label, y: yy - 9 });
    for (const l of lanes) { laneRows.push({ kind, lane: l, y: yy }); laneY.set(kind === 'med' ? l.id : l.key, yy); yy += LANE; }
  };
  addGroup('MEDIKAMENTE & THERAPIEN', medLanes, 'med');
  addGroup('AKTIVITÄTEN', actLanes, 'act');
  const bandTop = laneRows.length ? yy + 12 : plotBottom + axisSpace;
  const H = bandTop + bandH + 6;

  const left = M.left, right = width - M.right, plotW = right - left;
  const x = scaleX(from, to, left, plotW);
  const y = scaleY(M.top, plotH);
  const svg = s('svg', { viewBox: `0 0 ${width} ${H}`, width, height: H, class: 'chart-svg' });

  yAxis(svg, y, left, right);
  const sickFill = sickLayer(svg, { from, to, x, top: M.top, height: plotH });
  xAxis(svg, dateTicks(from, to, x, total <= 10 ? 28 : 54), plotBottom + 18);

  // vertical lines from the top of the plot down to the own lane: each start, change and end of a
  // medication, each single-day activity, start and end of a period (plus a faint band behind it)
  const marks = s('g', { class: 'markers' });
  for (const m of medLanes) {
    const ly = laneY.get(m.id) + 14;
    for (const ev of store.medEvents(m)) {
      if (ev.date < from || ev.date > to) continue;
      const px = x(ev.date, 0);
      marks.append(s('line', { x1: px, x2: px, y1: M.top, y2: ly, class: 'marker', style: `stroke:var(--c${m.color + 1})` }));
    }
  }
  const fade = momentList.length > 40 ? .2 : .45;
  for (const m of momentList) {
    const ly = laneY.get(m.title.toLowerCase()) + 19;
    const line = px => marks.append(s('line', { x1: px, x2: px, y1: M.top, y2: ly, class: 'marker', style: `stroke:${colorOf(m)};opacity:${fade}` }));
    if (m.span) {
      const last = store.momentLast(m);
      const a = x(m.date < from ? from : m.date, 0), b = x(last > to ? to : last, 1);
      marks.append(s('rect', { x: a, y: M.top, width: Math.max(2, b - a), height: plotH, class: 'moment-band', style: `fill:${colorOf(m)}` }));
      if (m.date >= from) line(a);
      if (m.end != null && m.end <= to) line(b);
    } else {
      line(x(m.date, 0.5));
    }
  }
  svg.append(marks);

  // mood: single entries, daily average, 7-day trend
  const dense = total > 120;
  const dots = s('g', { class: 'entries' });
  for (const e of store.getState().entries) {
    if (e.date < from || e.date > to) continue;
    const off = store.SLOTS.find(sl => sl.id === e.slot).offset;
    dots.append(s('circle', { cx: x(e.date, off), cy: y(e.mood), r: dense ? 2.2 : total > 45 ? 2.8 : 4, style: `fill:${store.moodColor(e.mood)}`, class: 'entry-dot' }));
  }
  svg.append(dots);
  const dayPts = [], trendPts = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = store.dayAverage(d);
    if (v != null) dayPts.push({ date: d, value: v });
    const t = store.trend(d);
    if (t != null) trendPts.push({ date: d, value: t });
  }
  for (const run of runs(dayPts, 2)) {
    const pts = run.map(p => [x(p.date), y(p.value)]);
    svg.append(s('path', { d: linePath(pts), class: `line-day${dense ? ' faint' : ''}` }));
  }
  let lastTrend = null;
  for (const run of runs(trendPts, 1)) {
    const pts = run.map(p => [x(p.date), y(p.value)]);
    svg.append(s('path', { d: smoothPath(pts), class: 'line-trend' }));
    lastTrend = pts[pts.length - 1];
  }
  if (lastTrend) svg.append(s('circle', { cx: lastTrend[0], cy: lastTrend[1], r: 5, class: 'end-dot' }));
  if (!stats.count) svg.append(s('text', { x: left + plotW / 2, y: M.top + plotH / 2, class: 'tick', 'text-anchor': 'middle' }, 'Keine Stimmungseinträge in diesem Zeitraum'));

  // color band: one row per time of day
  const clipId = `band-clip-${Math.random().toString(36).slice(2, 8)}`;
  if (!boxes) {
    svg.append(s('defs', null, s('clipPath', { id: clipId }, ...store.SLOTS.map((sl, r) =>
      s('rect', { x: left, y: bandTop + r * (ROW + GAP), width: plotW, height: ROW, rx: 4 })))));
  }
  const band = s('g', { class: 'mood-band', ...(boxes ? {} : { 'clip-path': `url(#${clipId})` }), ...(boxes || plotW / total < 1 ? {} : { 'shape-rendering': 'crispEdges' }) });
  store.SLOTS.forEach((sl, r) => {
    const ry = bandTop + r * (ROW + GAP);
    if (!boxes) band.append(s('rect', { x: left, y: ry, width: plotW, height: ROW, class: 'band-row' }));
    for (let d = from; d <= to; d = addDays(d, 1)) {
      const e = store.dayEntries(d)[sl.id];
      const x0 = x(d, 0), x1 = x(d, 1);
      if (boxes) {
        const inset = Math.min(1.5, (x1 - x0) * 0.12);
        band.append(s('rect', { x: x0 + inset, y: ry, width: Math.max(1, x1 - x0 - 2 * inset), height: ROW, rx: 3,
          class: e ? 'band-cell' : 'band-cell empty', ...(e ? { style: `fill:${store.moodColor(e.mood)}` } : {}) }));
      } else if (e) {
        band.append(s('rect', { x: x0, y: ry, width: Math.max(0.6, x1 - x0), height: ROW, style: `fill:${store.moodColor(e.mood)}` }));
      }
    }
  });
  svg.append(band);

  // lanes
  const lanesG = s('g', { class: 'lanes' });
  for (const row of laneRows) {
    if (row.label) { lanesG.append(s('text', { x: left, y: row.y, class: 'lane-group' }, row.label)); continue; }
    const ly = row.y;
    lanesG.append(s('line', { x1: left, x2: right, y1: ly + 19, y2: ly + 19, class: 'lane-track' }));
    if (row.kind === 'med') {
      const m = row.lane;
      lanesG.append(s('text', { x: left, y: ly + 8, class: 'lane-name' }, m.name));
      m.phases.forEach((p, pi) => {
        const ps = p.start < from ? from : p.start;
        const pe = p.end == null || p.end > to ? to : p.end;
        if (ps > to || pe < from) return;
        const prevTouching = pi > 0 && m.phases[pi - 1].end && addDays(m.phases[pi - 1].end, 1) === p.start && p.start > from;
        const xs = x(ps, 0) + (prevTouching ? 2 : 0);
        const open = p.end == null || p.end > to;
        lanesG.append(s('path', { d: barPath(xs, ly + 14, Math.max(3, x(pe, 1) - xs), 10, p.start >= from, !open), style: `fill:var(--c${m.color + 1})`, class: 'lane-bar' }));
      });
    } else {
      const l = row.lane;
      lanesG.append(s('text', { x: left, y: ly + 8, class: 'lane-name' }, l.name));
      for (const m of l.items) {
        if (m.span) {
          const last = store.momentLast(m);
          const xs = x(m.date < from ? from : m.date, 0), xe = x(last > to ? to : last, 1);
          const open = m.end == null || m.end > to;
          lanesG.append(s('path', { d: barPath(xs, ly + 14, Math.max(3, xe - xs), 10, m.date >= from, !open), style: `fill:${colorOf(m)}`, class: 'lane-bar' }));
        } else {
          lanesG.append(s('circle', { cx: x(m.date, 0.5), cy: ly + 19, r: total > 120 ? 3 : 4.2, style: `fill:${colorOf(m)}`, class: 'moment-dot' }));
        }
      }
    }
  }
  svg.append(lanesG);
  void sickFill;

  attachHover(svg, {
    from, to, left, width: plotW, top: M.top, bottom: H - 6, x,
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
        if (e) box.append(tipRow(keyDot(e.mood), store.formatMood(e.mood), `${sl.label} · ${store.describeMood(e.mood)}`));
      }
      const notes = store.SLOTS.map(sl => entries[sl.id]?.note).filter(Boolean);
      if (notes.length) box.append(h('div', { class: 'tip-note' }, notes.join(' · ')));
      const active = medLanes.map(m => [m, store.activePhase(m, date)]).filter(([, p]) => p);
      const acts = momentList.filter(m => store.momentCovers(m, date));
      if (active.length || acts.length) box.append(h('div', { class: 'tip-sep' }));
      for (const [m, p] of active) box.append(tipRow(h('span', { class: 'key-bar', style: { background: `var(--c${m.color + 1})` } }), p.dose || '–', m.name));
      for (const m of acts) box.append(tipRow(h('span', { class: m.span ? 'key-bar' : 'key-dot', style: { background: colorOf(m) } }), '', m.title));
      for (const m of medLanes) for (const ev of store.medEvents(m)) if (ev.date === date) box.append(h('div', { class: 'tip-note' }, eventText(ev)));
      return box;
    },
  });

  container.replaceChildren(svg);
  if (onZoom && bounds) attachZoom(svg, { from, to, left, width: plotW, onZoom, bounds });
}

/* Two-finger zoom and pan (and pinch on a trackpad). While the fingers move, the drawing is only
   stretched and shifted (smooth); when they lift, the chosen range is handed to onZoom, which redraws
   the whole page for it. A double tap resets. */
const MIN_DAYS = 5;
function attachZoom(svg, { from, to, left, width, onZoom, bounds }) {
  const N0 = diffDays(from, to) + 1;
  const maxDays = diffDays(bounds.min, bounds.max) + 1;
  let g = null;           // running gesture
  let lastTap = 0;

  // range for a zoom factor around an anchor day, with the anchor ending up at fraction f of the width
  const rangeFor = (anchorDay, f, days) => {
    days = Math.max(MIN_DAYS, Math.min(maxDays, Math.round(days)));
    let start = Math.round(anchorDay - f * days);
    const minStart = diffDays(from, bounds.min), maxStart = diffDays(from, bounds.max) - days + 1;
    start = Math.max(minStart, Math.min(maxStart, start));
    const a = addDays(from, start);
    return { from: a, to: addDays(a, days - 1), days, start };
  };
  const frac = (clientX, box) => Math.max(0, Math.min(1, (clientX - box.left - left * box.width / svg.viewBox.baseVal.width) / (width * box.width / svg.viewBox.baseVal.width)));
  const preview = r => {
    // stretch/shift the current drawing so the new range fills the plot width
    const s = N0 / r.days;
    const tx = left - left * s - (r.start / N0) * width * s;
    svg.style.transformOrigin = '0 0';
    svg.style.transform = `translateX(${tx}px) scaleX(${s})`;
  };
  const finish = r => {
    svg.style.transform = '';
    if (r && (r.from !== from || r.to !== to)) onZoom({ from: r.from, to: r.to });
  };
  const hideTip = () => { const tip = tooltip(); if (tip) tip.hidden = true; svg.querySelector('.crosshair')?.setAttribute('visibility', 'hidden'); };

  svg.addEventListener('touchstart', e => {
    if (e.touches.length === 2) {
      e.preventDefault();
      hideTip();
      const box = svg.getBoundingClientRect();
      const [p, q] = e.touches;
      const d0 = Math.max(10, Math.abs(p.clientX - q.clientX));
      const f0 = frac((p.clientX + q.clientX) / 2, box);
      g = { box, d0, anchor: f0 * N0, r: null };
      svg.dataset.zooming = '1';
    } else if (e.touches.length === 1 && g == null) {
      const now = performance.now();
      if (now - lastTap < 300) { lastTap = 0; e.preventDefault(); onZoom(null); return; }
      lastTap = now;
    }
  }, { passive: false });
  svg.addEventListener('touchmove', e => {
    if (!g || e.touches.length < 2) return;
    e.preventDefault();
    const [p, q] = e.touches;
    const d = Math.max(10, Math.abs(p.clientX - q.clientX));
    const f = frac((p.clientX + q.clientX) / 2, g.box);
    g.r = rangeFor(g.anchor, f, N0 * g.d0 / d);
    preview(g.r);
  }, { passive: false });
  const end = e => {
    if (!g || e.touches.length >= 2) return;
    const r = g.r;
    g = null;
    lastTap = 0;
    delete svg.dataset.zooming;
    hideTip();
    finish(r);
  };
  svg.addEventListener('touchend', end);
  svg.addEventListener('touchcancel', end);

  // trackpad pinch (browsers report it as wheel + ctrlKey) and ctrl + mouse wheel
  let wheelTimer = null, wheelR = null, wheelDays = N0, wheelAnchor = null;
  svg.addEventListener('wheel', e => {
    if (!e.ctrlKey) return;
    e.preventDefault();
    hideTip();
    const box = svg.getBoundingClientRect();
    const f = frac(e.clientX, box);
    if (wheelAnchor == null) wheelAnchor = f * N0;
    wheelDays = wheelDays * Math.exp(e.deltaY * 0.01);
    wheelR = rangeFor(wheelAnchor, f, wheelDays);
    preview(wheelR);
    clearTimeout(wheelTimer);
    wheelTimer = setTimeout(() => { const r = wheelR; wheelR = null; wheelAnchor = null; finish(r); }, 220);
  }, { passive: false });
  svg.addEventListener('dblclick', () => onZoom(null));
}

export function timelineLegend(el, { from, to }) {
  el.replaceChildren(...[
    h('span', { class: 'legend-item' }, keyLine('trend'), '7-Tage-Schnitt'),
    h('span', { class: 'legend-item' }, keyLine('day'), 'Tagesdurchschnitt'),
    h('span', { class: 'legend-item' }, h('span', { class: 'key-dots' }, [1, 3, 5].map(keyDot)), 'Einzelne Einträge'),
    sickLegend(from, to),
  ].filter(Boolean));
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
  return ev.med.kind === 'therapy' ? `${n} beendet` : `${n} abgesetzt`;
}
