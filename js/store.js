// Data model, persistence (localStorage) and analysis.
import { todayKey, addDays, diffDays, mean, uid, minKey, maxKey, formatWeekday } from './util.js';

const KEY = 'motra.v1';
const LEGACY_KEY = 'sutra.v1'; // storage key from before the app was renamed to Motra
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export const SLOTS = [
  { id: 'morning', label: 'Morgen', offset: 0.2 },
  { id: 'noon', label: 'Mittag', offset: 0.5 },
  { id: 'evening', label: 'Abend', offset: 0.8 },
];
export const SLOT_IDS = SLOTS.map(s => s.id);
export const slotLabel = id => SLOTS.find(s => s.id === id)?.label ?? id;

export const MOODS = [
  { value: 1, label: 'Sehr schlecht' },
  { value: 2, label: 'Schlecht' },
  { value: 3, label: 'Okay' },
  { value: 4, label: 'Gut' },
  { value: 5, label: 'Sehr gut' },
];
// Moods are 1–5. Faces give whole numbers; the fine slider gives steps of 0.1.
export const roundMood = v => Math.round(Math.min(5, Math.max(1, v)) * 10) / 10;
export const moodLevel = v => Math.min(5, Math.max(1, Math.round(v)));
export const moodLabel = v => MOODS.find(m => m.value === moodLevel(v))?.label ?? '';
// Shown as −10 … +10 with 0 = Okay (Sehr schlecht −10, Schlecht −5, Gut +5, Sehr gut +10).
// Stored values stay 1 … 5, so backups, sync and older entries keep working.
export const score = v => Math.round((v - 3) * 50) / 10;
const fmtSigned = (n, zero = '0') => {
  const r = Math.round(n * 10) / 10;
  if (r === 0) return zero;
  const abs = Math.abs(r).toLocaleString('de-DE', { minimumFractionDigits: Number.isInteger(r) ? 0 : 1, maximumFractionDigits: 1 });
  return (r > 0 ? '+' : '−') + abs;
};
// a mood (single value or average) on the −10 … +10 scale
export const formatMood = v => fmtSigned(score(v));
export const formatScore = formatMood;
// a difference between two moods, on the same scale
export const formatScoreDelta = d => fmtSigned(d * 5, '±0');
export const describeMood = v => (Number.isInteger(v) ? moodLabel(v) : `zwischen ${moodLabel(Math.floor(v))} und ${moodLabel(Math.ceil(v))}`);

// CSS color for a mood; values between two levels blend their colors.
export function moodColor(v) {
  const lo = Math.floor(v), hi = Math.ceil(v);
  if (lo === hi) return `var(--m${lo})`;
  return `color-mix(in oklab, var(--m${lo}) ${Math.round((hi - v) * 100)}%, var(--m${hi}))`;
}
export const MED_COLORS = 8;

// Which slot fits the current time of day.
export function currentSlot(date = new Date()) {
  const hr = date.getHours();
  if (hr < 11) return 'morning';
  if (hr < 17) return 'noon';
  return 'evening';
}

/* ---------------- state & persistence ---------------- */

const EPOCH = '1970-01-01T00:00:00.000Z';
const blank = () => ({ version: 1, entries: [], meds: [], moments: [], colors: {}, deleted: { entries: {}, meds: {}, moments: {} }, settings: { lastBackup: null } });
const entryKey = e => `${e.date}|${e.slot}`;
const now = () => new Date().toISOString();
// Every change to a medication bumps its timestamp; sync keeps the newer copy.
const touch = med => { med.updatedAt = now(); };

let state = blank();
let storageAvailable = true;
let rev = 0; // bumps on every change, used to cache derived data
const listeners = new Set();

export function init() {
  try {
    let raw = localStorage.getItem(KEY);
    if (raw == null) {
      // Carry data over from the old name. The legacy copy is only removed once the new one is written.
      const legacy = localStorage.getItem(LEGACY_KEY);
      if (legacy != null) {
        localStorage.setItem(KEY, legacy);
        localStorage.removeItem(LEGACY_KEY);
        raw = legacy;
      }
    }
    state = raw ? normalize(JSON.parse(raw)) : blank();
  } catch (e) {
    storageAvailable = false;
    state = blank();
  }
  rev++;
}

export const isStorageAvailable = () => storageAvailable;
export const subscribe = fn => listeners.add(fn);
export const getState = () => state;
export const settings = () => state.settings;

// `remote` marks changes that came from sync, so they don't trigger another upload.
function commit({ remote = false } = {}) {
  try {
    localStorage.setItem(KEY, JSON.stringify(state));
    storageAvailable = true;
  } catch (e) {
    storageAvailable = false;
  }
  rev++;
  listeners.forEach(fn => fn({ remote }));
}

// Ask the browser to keep our data even under storage pressure.
export async function requestPersistence() {
  try {
    if (navigator.storage?.persist && !(await navigator.storage.persisted())) await navigator.storage.persist();
  } catch (e) { /* not supported */ }
}

// Validates and cleans data coming from storage or an imported backup.
export function normalize(data) {
  if (!data || typeof data !== 'object' || !Array.isArray(data.entries) || !Array.isArray(data.meds)) {
    throw new Error('Das ist keine Motra-Sicherung.');
  }
  const seen = new Set();
  const entries = [];
  for (const e of data.entries) {
    if (!e || !DATE_RE.test(e.date) || !SLOT_IDS.includes(e.slot)) continue;
    const mood = Number(e.mood);
    if (!Number.isFinite(mood) || mood < 1 || mood > 5) continue;
    const k = e.date + '|' + e.slot;
    if (seen.has(k)) continue;
    seen.add(k);
    entries.push({
      id: typeof e.id === 'string' ? e.id : uid(),
      date: e.date, slot: e.slot, mood: roundMood(mood),
      note: typeof e.note === 'string' ? e.note.slice(0, 1000) : '',
      updatedAt: typeof e.updatedAt === 'string' ? e.updatedAt : EPOCH,
      ...(e.demo ? { demo: true } : {}),
    });
  }
  const meds = [];
  for (const m of data.meds) {
    if (!m || typeof m.name !== 'string' || !m.name.trim() || !Array.isArray(m.phases)) continue;
    const phases = m.phases
      .filter(p => p && DATE_RE.test(p.start) && (p.end == null || (DATE_RE.test(p.end) && p.end >= p.start)))
      .map(p => ({ id: typeof p.id === 'string' ? p.id : uid(), dose: String(p.dose ?? '').slice(0, 60), start: p.start, end: p.end ?? null }))
      .sort((a, b) => a.start.localeCompare(b.start));
    if (!phases.length) continue;
    meds.push({
      id: typeof m.id === 'string' ? m.id : uid(),
      name: m.name.trim().slice(0, 60),
      color: Number.isInteger(m.color) ? ((m.color % MED_COLORS) + MED_COLORS) % MED_COLORS : meds.length % MED_COLORS,
      phases,
      kind: m.kind === 'therapy' ? 'therapy' : 'med',
      ...(m.archived ? { archived: true } : {}),
      updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : EPOCH,
      ...(m.demo ? { demo: true } : {}),
    });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || SLOT_IDS.indexOf(a.slot) - SLOT_IDS.indexOf(b.slot));
  const out = {
    version: 1,
    entries,
    meds,
    moments: normalizeMoments(data.moments),
    colors: cleanColors(data.colors),
    deleted: { entries: cleanStamps(data.deleted?.entries), meds: cleanStamps(data.deleted?.meds), moments: cleanStamps(data.deleted?.moments) },
    settings: { lastBackup: typeof data.settings?.lastBackup === 'string' ? data.settings.lastBackup : null },
  };
  fillColors(out);
  return out;
}

/* Activity colors: every name keeps the color it got once (stored and synced), so adding,
   back-dating or deleting other activities never repaints it. A new name takes the color used least. */
const COLOR_COUNT = 8;
function cleanColors(obj) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) if (typeof k === 'string' && k.length <= 80 && Number.isInteger(v) && v >= 0 && v < COLOR_COUNT) out[k] = v;
  }
  return out;
}
function fillColors(data) {
  const map = data.colors ?? (data.colors = {});
  const first = new Map();
  for (const m of data.moments) {
    if (m.sick) continue;
    const k = m.title.toLowerCase();
    if (!first.has(k) || m.date < first.get(k)) first.set(k, m.date);
  }
  // first use decides the order for names without a color (that's how colors were picked before)
  const missing = [...first].filter(([k]) => map[k] == null).sort((a, b) => a[1].localeCompare(b[1]) || (a[0] < b[0] ? -1 : 1));
  for (const [k] of missing) {
    // count every name that ever had a color, so a deleted one that comes back doesn't share it
    const used = Array(COLOR_COUNT).fill(0);
    for (const v of Object.values(map)) used[v]++;
    let best = 0;
    for (let i = 1; i < COLOR_COUNT; i++) if (used[i] < used[best]) best = i;
    map[k] = best;
  }
  return map;
}

// "Anderes": things done or experienced. Either on one day (a routine, a moment that made a
// difference) or over a period like a medication: { span: true, end: date | null } (null = still going).
function normalizeMoments(list) {
  if (!Array.isArray(list)) return [];
  const seen = new Set();
  const out = [];
  for (const m of list) {
    if (!m || !DATE_RE.test(m.date) || typeof m.title !== 'string' || !m.title.trim()) continue;
    const id = typeof m.id === 'string' ? m.id : uid();
    if (seen.has(id)) continue;
    seen.add(id);
    const span = m.span === true;
    out.push({
      id, date: m.date, title: m.title.trim().slice(0, 80),
      ...(span ? { span: true, end: DATE_RE.test(m.end) && m.end >= m.date ? m.end : null } : {}),
      ...(span && m.sick === true ? { sick: true } : {}),
      note: typeof m.note === 'string' ? m.note.slice(0, 500) : '',
      ...(m.archived ? { archived: true } : {}),
      updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : EPOCH,
      ...(m.demo ? { demo: true } : {}),
    });
  }
  return out.sort(byMoment);
}
const byMoment = (a, b) => a.date.localeCompare(b.date) || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);

// Deletion markers: { key: ISO time }. Kept so a deletion also reaches other devices.
function cleanStamps(obj) {
  const out = {};
  if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) if (typeof v === 'string' && k.length < 100) out[k] = v;
  }
  return out;
}

/* ---------------- entries ---------------- */

export const getEntry = (date, slot) => state.entries.find(e => e.date === date && e.slot === slot) ?? null;

export function saveEntry({ date, slot, mood, note }) {
  mood = roundMood(mood);
  const existing = getEntry(date, slot);
  const updatedAt = new Date().toISOString();
  if (existing) {
    Object.assign(existing, { mood, note, updatedAt });
    delete existing.demo;
  } else {
    state.entries.push({ id: uid(), date, slot, mood, note, updatedAt });
    state.entries.sort((a, b) => a.date.localeCompare(b.date) || SLOT_IDS.indexOf(a.slot) - SLOT_IDS.indexOf(b.slot));
  }
  commit();
  return !existing;
}

export function deleteEntry(date, slot) {
  const e = getEntry(date, slot);
  if (e && !e.demo) state.deleted.entries[entryKey(e)] = now();
  state.entries = state.entries.filter(x => x !== e);
  commit();
}

/* ---------------- other things (moments, routines) ---------------- */

// span: false → one day; true → a period from `date` to `end` (null/'' = still going).
// sick: a period of illness. It's always a period and gets a red striped background in every chart.
const spanFields = (date, span, end, sick = false) => (span || sick ? { span: true, end: end && end >= date ? end : null, ...(sick ? { sick: true } : {}) } : {});

export function addMoment({ date, title, note = '', span = false, end = null, sick = false }) {
  state.moments.push({ id: uid(), date, title: title.trim().slice(0, 80), ...spanFields(date, span, end, sick), note: note.trim().slice(0, 500), updatedAt: now() });
  state.moments.sort(byMoment);
  fillColors(state);
  commit();
}

export function updateMoment(id, { date, title, note, span = false, end = null, sick = false }) {
  const m = state.moments.find(x => x.id === id);
  if (!m) return;
  delete m.span; delete m.end; delete m.sick; delete m.demo;
  Object.assign(m, { date, title: title.trim().slice(0, 80), ...spanFields(date, span, end, sick), note: note.trim().slice(0, 500), updatedAt: now() });
  state.moments.sort(byMoment);
  fillColors(state);
  commit();
}

// Archive = out of the lists, but the history stays (charts and evaluations still use it).
export function archiveMoment(id, on = true) {
  const m = state.moments.find(x => x.id === id);
  if (!m) return;
  if (on) m.archived = true; else delete m.archived;
  m.updatedAt = now();
  commit();
}

// End a running period on the given day.
export function endMoment(id, end) {
  const m = state.moments.find(x => x.id === id);
  if (!m?.span) return;
  m.end = end < m.date ? m.date : end;
  m.updatedAt = now();
  delete m.demo;
  commit();
}

// Last day a moment counts for (a running period lasts until today; never before its start).
export const momentLast = m => (!m.span ? m.date : m.end ?? maxKey(m.date, todayKey()));
export const momentCovers = (m, d) => d >= m.date && d <= momentLast(m);
export const momentRunning = m => !!m.span && m.date <= todayKey() && (m.end == null || m.end >= todayKey());
// Periods of illness that touch the range, clipped to it (archived ones are left out).
export const sickIn = (from, to) => state.moments
  .filter(m => m.sick && !m.archived && m.date <= to && momentLast(m) >= from && m.date <= todayKey())
  .map(m => ({ m, from: m.date < from ? from : m.date, to: minKey(minKey(momentLast(m), to), todayKey()) }));
// All illnesses, newest first.
export const illnesses = () => state.moments.filter(m => m.sick).sort((a, b) => b.date.localeCompare(a.date));
export const sickOn = date => state.moments.find(m => m.sick && !m.archived && momentCovers(m, date)) ?? null;
// Moments that touch the range from–to.
export const momentsIn = (from, to) => state.moments.filter(m => m.date <= to && momentLast(m) >= from);

export function deleteMoment(id) {
  const m = state.moments.find(x => x.id === id);
  if (m && !m.demo) state.deleted.moments[id] = now();
  state.moments = state.moments.filter(x => x.id !== id);
  commit();
}

// Every title gets its own color from the medication palette (0..7). The order is the order of
// first use, so the colors are the same on all devices and don't change between ranges.
export function momentColors() {
  return new Map(Object.entries(fillColors(state)));
}

// Titles used so far, most frequent first (for the quick buttons).
export function momentTitles(includeArchived = false) {
  const counts = new Map();
  for (const m of state.moments) {
    if (m.sick || (m.archived && !includeArchived)) continue;
    const key = m.title.toLowerCase();
    const cur = counts.get(key) ?? { title: m.title, n: 0, last: '' };
    cur.n++;
    if (m.date >= cur.last) { cur.last = m.date; cur.title = m.title; }
    counts.set(key, cur);
  }
  return [...counts.values()].sort((a, b) => b.n - a.n || b.last.localeCompare(a.last));
}

// Activities = all entries that share a title. Archived when every one of them is archived.
export function momentActivities() {
  const map = new Map();
  for (const m of state.moments) {
    if (m.sick) continue;
    const key = m.title.toLowerCase();
    const cur = map.get(key) ?? { title: m.title, n: 0, active: 0, last: '' };
    cur.n++;
    if (!m.archived) cur.active++;
    if (m.date >= cur.last) { cur.last = m.date; cur.title = m.title; }
    map.set(key, cur);
  }
  return [...map.values()].map(a => ({ title: a.title, n: a.n, last: a.last, archived: a.active === 0 }))
    .sort((a, b) => Number(a.archived) - Number(b.archived) || b.n - a.n || b.last.localeCompare(a.last));
}

// Archive (or restore) a whole activity: every entry with this title.
export function archiveActivity(title, on = true) {
  const key = title.toLowerCase();
  const stamp = now();
  let any = false;
  for (const m of state.moments) {
    if (m.title.toLowerCase() !== key || !!m.archived === on) continue;
    if (on) m.archived = true; else delete m.archived;
    m.updatedAt = stamp;
    any = true;
  }
  if (any) commit();
}

// Mood on days with this title vs. days without, within a range (days that have mood entries only).
export function momentComparison(title, from, to) {
  const key = title.toLowerCase();
  const list = state.moments.filter(m => m.title.toLowerCase() === key);
  const withV = [], withoutV = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = dayAverage(d);
    if (v == null) continue;
    (list.some(m => momentCovers(m, d)) ? withV : withoutV).push(v);
  }
  return { with: { avg: mean(withV), days: withV.length }, without: { avg: mean(withoutV), days: withoutV.length }, total: list.length };
}

// A period: 4 weeks before it began, the time during it, and (once over) up to 4 weeks after.
export function spanEffect(m) {
  const today = todayKey();
  const last = minKey(momentLast(m), today);
  const ended = m.end != null && m.end < today;
  return {
    started: m.date <= today,
    ended,
    days: m.date <= today ? diffDays(m.date, last) + 1 : 0,
    before: windowAverage(addDays(m.date, -28), addDays(m.date, -1)),
    during: m.date <= today ? windowAverage(m.date, last) : { avg: null, days: 0 },
    after: ended ? windowAverage(addDays(m.end, 1), minKey(addDays(m.end, 28), today)) : { avg: null, days: 0 },
  };
}

// A single moment: mood that day compared with the week before and after.
export function momentWindow(date) {
  return {
    day: dayAverage(date),
    before: windowAverage(addDays(date, -7), addDays(date, -1)),
    after: windowAverage(addDays(date, 1), minKey(addDays(date, 7), todayKey())),
  };
}

/* ---------------- medications ---------------- */

export const getMed = id => state.meds.find(m => m.id === id) ?? null;
export const openPhase = med => med.phases.find(p => p.end == null) ?? null;
export const lastPhase = med => med.phases[med.phases.length - 1];
export const activePhase = (med, date) => med.phases.find(p => p.start <= date && (p.end == null || date <= p.end)) ?? null;
// Therapies can be entered ahead of time: the next phase that hasn't started yet.
export const nextPhase = med => med.phases.find(p => p.start > todayKey()) ?? null;

function nextColor() {
  const used = new Set(state.meds.map(m => m.color));
  for (let i = 0; i < MED_COLORS; i++) if (!used.has(i)) return i;
  return state.meds.length % MED_COLORS;
}

// `kind` is 'med' (medication) or 'therapy'. Both use the same phases: dose holds the dose or the frequency.
export function addMed({ name, dose, start, kind = 'med' }) {
  state.meds.push({
    id: uid(), name: name.trim(), kind: kind === 'therapy' ? 'therapy' : 'med', color: nextColor(),
    phases: [{ id: uid(), dose: dose.trim(), start, end: null }], updatedAt: now(),
  });
  commit();
}

// New dose from `date` on. Ends the running phase the day before.
export function changeDose(id, dose, date) {
  const med = getMed(id);
  if (!med) return;
  const open = openPhase(med);
  if (open && open.start >= date) {
    open.dose = dose.trim();
    open.start = date;
  } else {
    if (open) open.end = addDays(date, -1);
    med.phases.push({ id: uid(), dose: dose.trim(), start: date, end: null });
  }
  med.phases.sort((a, b) => a.start.localeCompare(b.start));
  touch(med);
  commit();
}

// `lastDay` is the last day the medication was taken.
export function stopMed(id, lastDay) {
  const med = getMed(id);
  const open = med && openPhase(med);
  if (!open) return;
  open.end = maxKey(lastDay, open.start);
  touch(med);
  commit();
}

export function updateMed(id, { name, phases }) {
  const med = getMed(id);
  if (!med) return;
  med.name = name.trim();
  med.phases = phases.map(p => ({ id: p.id || uid(), dose: p.dose.trim(), start: p.start, end: p.end || null }))
    .sort((a, b) => a.start.localeCompare(b.start));
  delete med.demo;
  touch(med);
  commit();
}

export function archiveMed(id, on = true) {
  const med = getMed(id);
  if (!med) return;
  if (on) med.archived = true; else delete med.archived;
  touch(med);
  commit();
}

export function deleteMed(id) {
  const med = getMed(id);
  if (med && !med.demo) state.deleted.meds[id] = now();
  state.meds = state.meds.filter(m => m.id !== id);
  commit();
}

// Returns an error message or null.
export function validatePhases(phases) {
  if (!phases.length) return 'Es braucht mindestens einen Zeitraum.';
  const sorted = [...phases].sort((a, b) => a.start.localeCompare(b.start));
  for (let i = 0; i < sorted.length; i++) {
    const p = sorted[i];
    if (!DATE_RE.test(p.start)) return 'Bitte bei jedem Zeitraum ein Startdatum angeben.';
    if (p.end && p.end < p.start) return 'Ein Zeitraum endet vor seinem Beginn.';
    if (!p.end && i < sorted.length - 1) return 'Nur der letzte Zeitraum darf ohne Enddatum sein.';
    if (i > 0 && sorted[i - 1].end >= p.start) return 'Zwei Zeiträume überschneiden sich.';
  }
  return null;
}

/* ---------------- derived data ---------------- */

let cache = { rev: -1 };

function derived() {
  if (cache.rev === rev) return cache;
  const byDate = new Map();
  for (const e of state.entries) {
    if (!byDate.has(e.date)) byDate.set(e.date, {});
    byDate.get(e.date)[e.slot] = e;
  }
  const dayAvg = new Map();
  for (const [date, slots] of byDate) dayAvg.set(date, mean(Object.values(slots).map(e => e.mood)));
  const dates = [...byDate.keys()].sort();
  cache = { rev, byDate, dayAvg, firstDate: dates[0] ?? null };
  return cache;
}

export const dayEntries = date => derived().byDate.get(date) ?? {};
export const dayAverage = date => derived().dayAvg.get(date) ?? null;
export const hasEntries = () => state.entries.length > 0;

export function firstDataDate() {
  let first = derived().firstDate;
  for (const m of state.meds) for (const p of m.phases) first = first ? minKey(first, p.start) : p.start;
  return first;
}

// Mean of daily averages for the days in [from, to] that have entries.
export function windowAverage(from, to) {
  const vals = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = dayAverage(d);
    if (v != null) vals.push(v);
  }
  return { avg: mean(vals), days: vals.length };
}

// Trailing 7-day mean (needs at least 3 days with data inside the window).
export function trend(date, span = 7) {
  const { avg, days } = windowAverage(addDays(date, -(span - 1)), date);
  return days >= Math.min(3, span) ? avg : null;
}

export function rangeStats(from, to) {
  let count = 0;
  const bySlot = Object.fromEntries(SLOT_IDS.map(id => [id, []]));
  const all = [];
  for (const e of state.entries) {
    if (e.date < from || e.date > to) continue;
    count++;
    bySlot[e.slot].push(e.mood);
    all.push(e.mood);
  }
  const { avg, days } = windowAverage(from, to);
  return {
    count, days, avg,
    entryAvg: mean(all),
    slots: SLOTS.map(sl => ({ ...sl, avg: mean(bySlot[sl.id]), n: bySlot[sl.id].length })),
  };
}

// Start, dose change, restart and stop events for one medication.
export function medEvents(med) {
  const ev = [];
  const ph = med.phases;
  ph.forEach((p, i) => {
    const prev = ph[i - 1];
    const continuous = prev && prev.end && addDays(prev.end, 1) === p.start;
    if (continuous) ev.push({ med, type: 'dose', date: p.start, dose: p.dose, prevDose: prev.dose });
    else ev.push({ med, type: i === 0 ? 'start' : 'restart', date: p.start, dose: p.dose });
    const next = ph[i + 1];
    if (p.end && !(next && addDays(p.end, 1) === next.start)) {
      ev.push({ med, type: 'stop', date: addDays(p.end, 1), dose: p.dose });
    }
  });
  return ev;
}

export const BEFORE_DAYS = 28;
export const AFTER_FROM = 14;
export const AFTER_TO = 41;

export function eventComparison(date) {
  const today = todayKey();
  const before = windowAverage(addDays(date, -BEFORE_DAYS), addDays(date, -1));
  const afterStart = addDays(date, AFTER_FROM);
  const afterEnd = addDays(date, AFTER_TO);
  const after = afterStart <= today ? windowAverage(afterStart, minKey(afterEnd, today)) : { avg: null, days: 0 };
  return { before, after, afterStart, complete: afterEnd <= today, started: afterStart <= today };
}

export function medComparison(med, from, to) {
  const withV = [], withoutV = [];
  for (let d = from; d <= to; d = addDays(d, 1)) {
    const v = dayAverage(d);
    if (v == null) continue;
    (activePhase(med, d) ? withV : withoutV).push(v);
  }
  return { with: { avg: mean(withV), days: withV.length }, without: { avg: mean(withoutV), days: withoutV.length } };
}

/* ---------------- sync ---------------- */

const byEntryKey = (a, b) => a.date.localeCompare(b.date) || SLOT_IDS.indexOf(a.slot) - SLOT_IDS.indexOf(b.slot);
const byId = (a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
const sortedStamps = obj => Object.fromEntries(Object.keys(obj).sort().map(k => [k, obj[k]]));

// What gets uploaded: everything except example data, in a fixed order so two copies compare equal.
export const syncPayload = () => canonical(state);

// Canonical form of any data set (this device's, or a copy from the server).
export function canonicalOf(data) {
  try { return canonical(normalize({ ...data, settings: {} })); } catch (e) { return null; }
}

const projectEntry = ({ id, date, slot, mood, note, updatedAt }) => ({ id, date, slot, mood, note, updatedAt });
const projectMoment = ({ id, date, title, span, end, sick, note, archived, updatedAt }) => ({ id, date, title, ...(span ? { span: true, end: end ?? null } : {}), ...(span && sick ? { sick: true } : {}), note, ...(archived ? { archived: true } : {}), updatedAt });
const projectMed = ({ id, name, kind, color, archived, updatedAt, phases }) => ({
  id, name, kind: kind === 'therapy' ? 'therapy' : 'med', color, ...(archived ? { archived: true } : {}), updatedAt,
  phases: phases.map(({ id: pid, dose, start, end }) => ({ id: pid, dose, start, end })),
});

function canonical(src) {
  return {
    version: 1,
    entries: src.entries.filter(e => !e.demo).map(projectEntry).sort(byEntryKey),
    meds: src.meds.filter(m => !m.demo).map(projectMed).sort(byId),
    moments: (src.moments ?? []).filter(m => !m.demo).map(projectMoment).sort(byId),
    colors: syncedColors(src),
    deleted: {
      entries: sortedStamps(src.deleted.entries), meds: sortedStamps(src.deleted.meds), moments: sortedStamps(src.deleted.moments ?? {}),
    },
  };
}

function syncedColors(src) {
  const demoOnly = new Set((src.moments ?? []).filter(m => m.demo).map(m => m.title.toLowerCase()));
  for (const m of src.moments ?? []) if (!m.demo) demoOnly.delete(m.title.toLowerCase());
  return Object.fromEntries(Object.entries(src.colors ?? {}).filter(([k]) => !demoOnly.has(k)).sort((a, b) => (a[0] < b[0] ? -1 : 1)));
}

const TOMBSTONE_DAYS = 400;

// Merges another device's data into this one: per entry/medication the newer copy wins,
// a deletion wins over anything older than it. Returns true if local data changed.
export function mergeRemote(remoteData) {
  if (!remoteData) return false;
  const r = normalize({ ...remoteData, settings: {} });
  const before = JSON.stringify(syncPayload());

  const cutoff = new Date(Date.now() - TOMBSTONE_DAYS * 86400_000).toISOString();
  const mergeStamps = (a, b) => {
    const out = { ...a };
    for (const [k, v] of Object.entries(b)) if (!out[k] || v > out[k]) out[k] = v;
    for (const k of Object.keys(out)) if (out[k] < cutoff) delete out[k];
    return out;
  };
  const deleted = {
    entries: mergeStamps(state.deleted.entries, r.deleted.entries),
    meds: mergeStamps(state.deleted.meds, r.deleted.meds),
    moments: mergeStamps(state.deleted.moments, r.deleted.moments),
  };

  // Newer copy wins. On equal timestamps both devices must still pick the same copy,
  // so the tie is broken by content; otherwise they'd overwrite each other forever.
  const wins = (a, b, project) => a.updatedAt > b.updatedAt
    || (a.updatedAt === b.updatedAt && JSON.stringify(project(a)) > JSON.stringify(project(b)));
  const entries = new Map(state.entries.map(e => [entryKey(e), e]));
  for (const e of r.entries) {
    const cur = entries.get(entryKey(e));
    if (!cur || cur.demo || wins(e, cur, projectEntry)) entries.set(entryKey(e), e);
  }
  const meds = new Map(state.meds.map(m => [m.id, m]));
  for (const m of r.meds) {
    const cur = meds.get(m.id);
    if (!cur || wins(m, cur, projectMed)) meds.set(m.id, m);
  }

  const moments = new Map(state.moments.map(m => [m.id, m]));
  for (const m of r.moments) {
    const cur = moments.get(m.id);
    if (!cur || wins(m, cur, projectMoment)) moments.set(m.id, m);
  }

  state.entries = [...entries.values()].filter(e => e.demo || !(deleted.entries[entryKey(e)] >= e.updatedAt)).sort(byEntryKey);
  state.moments = [...moments.values()].filter(m => m.demo || !(deleted.moments[m.id] >= m.updatedAt)).sort(byMoment);
  state.meds = [...meds.values()].filter(m => m.demo || !(deleted.meds[m.id] >= m.updatedAt));
  state.deleted = deleted;

  // colors: keep ours, take names we didn't know; if two devices picked different colors for the
  // same new name, both settle on the smaller number. Only colors the other device really stored count.
  const theirs = cleanColors(remoteData.colors);
  for (const [k, v] of Object.entries(theirs)) {
    const mine = state.colors[k];
    state.colors[k] = mine == null ? v : Math.min(mine, v);
  }
  fillColors(state);

  const changed = JSON.stringify(syncPayload()) !== before;
  if (changed) commit({ remote: true });
  else rev++;
  return changed;
}

/* ---------------- backup ---------------- */

export function exportJSON() {
  return JSON.stringify({ ...state, app: 'Motra', exportedAt: new Date().toISOString() }, null, 2);
}

export function markBackup() {
  state.settings.lastBackup = new Date().toISOString();
  commit();
}

export function importJSON(text) {
  let parsed;
  try { parsed = JSON.parse(text); } catch (e) { throw new Error('Die Datei konnte nicht gelesen werden. Ist es eine Motra-Sicherung (.json)?'); }
  const next = normalize(parsed);
  next.settings.lastBackup = new Date().toISOString();
  state = next;
  commit();
  return { entries: next.entries.length, meds: next.meds.length, moments: next.moments.length };
}

export function exportCSV() {
  const esc = v => {
    const str = String(v ?? '');
    return /[";\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const rows = [['Datum', 'Wochentag', 'Tageszeit', 'Stimmung (−10 bis +10)', 'Stimmung', 'Notiz', 'Medikamente & Therapien', 'Anderes']];
  for (const e of state.entries) {
    const meds = state.meds
      .map(m => [m, activePhase(m, e.date)])
      .filter(([, p]) => p)
      .map(([m, p]) => (p.dose ? `${m.name} ${p.dose}` : m.name))
      .join(', ');
    const other = state.moments.filter(m => momentCovers(m, e.date)).map(m => m.title).join(', ');
    rows.push([e.date, formatWeekday(e.date), slotLabel(e.slot), formatMood(e.mood), describeMood(e.mood), e.note, meds, other]);
  }
  return '﻿' + rows.map(r => r.map(esc).join(';')).join('\r\n');
}

export function wipeAll() {
  try { localStorage.removeItem(LEGACY_KEY); } catch (e) { /* ignore */ }
  state = blank();
  commit();
}

/* ---------------- example data ---------------- */

export const hasDemo = () => state.entries.some(e => e.demo) || state.meds.some(m => m.demo) || state.moments.some(m => m.demo);

export function loadDemo() {
  const today = todayKey();
  const DAYS = 150;
  const start = addDays(today, -DAYS + 1);
  const d = n => addDays(today, -n);
  // Deterministic pseudo-random numbers so the example looks the same each time.
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  const meds = [
    { name: 'Sertralin', phases: [{ dose: '50 mg', start: d(120), end: d(71) }, { dose: '100 mg', start: d(70), end: null }] },
    { name: 'Quetiapin', phases: [{ dose: '25 mg', start: d(95), end: d(40) }] },
    { name: 'Vitamin D', phases: [{ dose: '1000 IE', start: d(140), end: null }] },
    { name: 'Melatonin', phases: [{ dose: '2 mg', start: d(30), end: null }] },
    { name: 'Psychotherapie', kind: 'therapy', phases: [{ dose: '1× pro Woche', start: d(85), end: d(36) }, { dose: 'alle 2 Wochen', start: d(35), end: null }] },
  ];
  const used = new Set(state.meds.map(m => m.color));
  let color = 0;
  for (const m of meds) {
    while (used.has(color)) color++;
    state.meds.push({ id: uid(), name: m.name, kind: m.kind || 'med', color: color++ % MED_COLORS, demo: true, phases: m.phases.map(p => ({ id: uid(), ...p })) });
  }
  const existing = new Set(state.entries.map(e => e.date + '|' + e.slot));
  for (let i = 0; i < DAYS; i++) {
    const date = addDays(start, i);
    const daysOn = diffDays(d(120), date);
    // Slow improvement a few weeks after the start, plus a dip and a weekly rhythm.
    const lift = daysOn < 18 ? 0 : Math.min(1.3, (daysOn - 18) / 45);
    const dip = Math.exp(-(((i - 98) / 6) ** 2)) * 0.9;
    const weekly = Math.sin(i / 7 * Math.PI * 2) * 0.25;
    const base = 2.2 + lift - dip + weekly;
    for (const sl of SLOTS) {
      if (date === today && sl.id !== 'morning') continue;
      if (rnd() < 0.12) continue;
      if (existing.has(date + '|' + sl.id)) continue;
      const slotBias = sl.id === 'evening' ? -0.25 : sl.id === 'noon' ? 0.2 : 0;
      const mood = Math.max(1, Math.min(5, Math.round(base + slotBias + (rnd() - 0.5) * 1.6)));
      const note = rnd() < 0.08 ? ['Schlecht geschlafen', 'Spaziergang hat gutgetan', 'Viel Stress auf der Arbeit', 'Treffen mit Freunden', 'Müde, aber ruhig'][Math.floor(rnd() * 5)] : '';
      state.entries.push({ id: uid(), date, slot: sl.id, mood, note, updatedAt: new Date().toISOString(), demo: true });
    }
  }
  state.entries.sort((a, b) => a.date.localeCompare(b.date) || SLOT_IDS.indexOf(a.slot) - SLOT_IDS.indexOf(b.slot));
  // Other things: a morning routine on many days, a few single moments.
  const demoMoment = (date, title, note = '') => state.moments.push({ id: uid(), date, title, note, updatedAt: new Date().toISOString(), demo: true });
  for (let n = 70; n >= 0; n--) if (rnd() < 0.45) demoMoment(d(n), 'Morgenroutine');
  for (let n = 60; n >= 0; n -= 4) if (rnd() < 0.6) demoMoment(d(n), 'Spaziergang');
  demoMoment(d(52), 'Gutes Gespräch mit Anna', 'Hat mir gezeigt, dass ich nicht allein bin.');
  demoMoment(d(23), 'Wochenende am See');
  demoMoment(d(9), 'Streit auf der Arbeit');
  state.moments.push({ id: uid(), date: d(48), title: 'Urlaub in Italien', span: true, end: d(36), note: '', updatedAt: new Date().toISOString(), demo: true });
  state.moments.push({ id: uid(), date: d(31), title: 'Grippe', span: true, sick: true, end: d(26), note: 'Fieber, viel geschlafen', updatedAt: new Date().toISOString(), demo: true });
  state.moments.push({ id: uid(), date: d(20), title: 'Yogakurs', span: true, end: null, note: 'Dienstags und donnerstags', updatedAt: new Date().toISOString(), demo: true });
  state.moments.sort(byMoment);
  commit();
}

export function removeDemo() {
  state.entries = state.entries.filter(e => !e.demo);
  state.meds = state.meds.filter(m => !m.demo);
  state.moments = state.moments.filter(m => !m.demo);
  commit();
}
