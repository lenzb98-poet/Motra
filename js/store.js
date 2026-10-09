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
export const formatMood = v => (Number.isInteger(v) ? String(v) : v.toLocaleString('de-DE', { minimumFractionDigits: 1, maximumFractionDigits: 1 }));
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
const blank = () => ({ version: 1, entries: [], meds: [], deleted: { entries: {}, meds: {} }, settings: { lastBackup: null } });
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
      updatedAt: typeof m.updatedAt === 'string' ? m.updatedAt : EPOCH,
      ...(m.demo ? { demo: true } : {}),
    });
  }
  entries.sort((a, b) => a.date.localeCompare(b.date) || SLOT_IDS.indexOf(a.slot) - SLOT_IDS.indexOf(b.slot));
  return {
    version: 1,
    entries,
    meds,
    deleted: { entries: cleanStamps(data.deleted?.entries), meds: cleanStamps(data.deleted?.meds) },
    settings: { lastBackup: typeof data.settings?.lastBackup === 'string' ? data.settings.lastBackup : null },
  };
}

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

/* ---------------- medications ---------------- */

export const getMed = id => state.meds.find(m => m.id === id) ?? null;
export const openPhase = med => med.phases.find(p => p.end == null) ?? null;
export const lastPhase = med => med.phases[med.phases.length - 1];
export const activePhase = (med, date) => med.phases.find(p => p.start <= date && (p.end == null || date <= p.end)) ?? null;

function nextColor() {
  const used = new Set(state.meds.map(m => m.color));
  for (let i = 0; i < MED_COLORS; i++) if (!used.has(i)) return i;
  return state.meds.length % MED_COLORS;
}

export function addMed({ name, dose, start }) {
  state.meds.push({ id: uid(), name: name.trim(), color: nextColor(), phases: [{ id: uid(), dose: dose.trim(), start, end: null }], updatedAt: now() });
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

function canonical(src) {
  return {
    version: 1,
    entries: src.entries.filter(e => !e.demo)
      .map(({ id, date, slot, mood, note, updatedAt }) => ({ id, date, slot, mood, note, updatedAt }))
      .sort(byEntryKey),
    meds: src.meds.filter(m => !m.demo)
      .map(({ id, name, color, updatedAt, phases }) => ({
        id, name, color, updatedAt, phases: phases.map(({ id: pid, dose, start, end }) => ({ id: pid, dose, start, end })),
      }))
      .sort(byId),
    deleted: { entries: sortedStamps(src.deleted.entries), meds: sortedStamps(src.deleted.meds) },
  };
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
  const deleted = { entries: mergeStamps(state.deleted.entries, r.deleted.entries), meds: mergeStamps(state.deleted.meds, r.deleted.meds) };

  const entries = new Map(state.entries.map(e => [entryKey(e), e]));
  for (const e of r.entries) {
    const cur = entries.get(entryKey(e));
    if (!cur || cur.demo || e.updatedAt > cur.updatedAt) entries.set(entryKey(e), e);
  }
  const meds = new Map(state.meds.map(m => [m.id, m]));
  for (const m of r.meds) {
    const cur = meds.get(m.id);
    if (!cur || m.updatedAt > cur.updatedAt) meds.set(m.id, m);
  }

  state.entries = [...entries.values()].filter(e => e.demo || !(deleted.entries[entryKey(e)] >= e.updatedAt)).sort(byEntryKey);
  state.meds = [...meds.values()].filter(m => m.demo || !(deleted.meds[m.id] >= m.updatedAt));
  state.deleted = deleted;

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
  return { entries: next.entries.length, meds: next.meds.length };
}

export function exportCSV() {
  const esc = v => {
    const str = String(v ?? '');
    return /[";\n\r]/.test(str) ? `"${str.replace(/"/g, '""')}"` : str;
  };
  const rows = [['Datum', 'Wochentag', 'Tageszeit', 'Stimmung (1-5)', 'Stimmung', 'Notiz', 'Medikamente']];
  for (const e of state.entries) {
    const meds = state.meds
      .map(m => [m, activePhase(m, e.date)])
      .filter(([, p]) => p)
      .map(([m, p]) => (p.dose ? `${m.name} ${p.dose}` : m.name))
      .join(', ');
    rows.push([e.date, formatWeekday(e.date), slotLabel(e.slot), formatMood(e.mood), describeMood(e.mood), e.note, meds]);
  }
  return '﻿' + rows.map(r => r.map(esc).join(';')).join('\r\n');
}

export function wipeAll() {
  try { localStorage.removeItem(LEGACY_KEY); } catch (e) { /* ignore */ }
  state = blank();
  commit();
}

/* ---------------- example data ---------------- */

export const hasDemo = () => state.entries.some(e => e.demo) || state.meds.some(m => m.demo);

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
  ];
  const used = new Set(state.meds.map(m => m.color));
  let color = 0;
  for (const m of meds) {
    while (used.has(color)) color++;
    state.meds.push({ id: uid(), name: m.name, color: color++ % MED_COLORS, demo: true, phases: m.phases.map(p => ({ id: uid(), ...p })) });
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
  commit();
}

export function removeDemo() {
  state.entries = state.entries.filter(e => !e.demo);
  state.meds = state.meds.filter(m => !m.demo);
  commit();
}
