import * as store from './store.js';
import * as sync from './sync.js';
import * as push from './push.js';
import { timelineChart, timelineLegend, eventText } from './charts.js';
import {
  h, s, icon, todayKey, addDays, diffDays, fromKey, formatLong, formatDayMonth, formatShort, formatWeekday,
  relativeDay, num1, signed1,
} from './util.js';

const $ = sel => document.querySelector(sel);

/* ---------------- preferences (per device conveniences) ---------------- */

const PREFS_KEY = 'motra.prefs';
const LEGACY_PREFS_KEY = 'sutra.prefs';
let prefs = { range: '30', layers: { meds: true, moments: false }, kindFilter: 'all', backupHiddenOn: null };
try {
  let saved = localStorage.getItem(PREFS_KEY);
  if (saved == null && (saved = localStorage.getItem(LEGACY_PREFS_KEY)) != null) {
    localStorage.setItem(PREFS_KEY, saved);
    localStorage.removeItem(LEGACY_PREFS_KEY);
  }
  const old = JSON.parse(saved || '{}');
  prefs = { ...prefs, ...old };
  // earlier versions had a range per tab and "Anderes" inside the medication tab
  if (!old.range && old.rangeVerlauf) prefs.range = old.rangeVerlauf;
  if (!['all', 'med', 'therapy'].includes(prefs.kindFilter)) prefs.kindFilter = 'all';
  for (const k of ['rangeVerlauf', 'rangeMedis', 'rangeOther', 'lastKind', 'medListOpen', 'entryTab', 'todayOtherOpen']) delete prefs[k];
} catch (e) { /* ignore */ }
const savePrefs = () => { try { localStorage.setItem(PREFS_KEY, JSON.stringify(prefs)); } catch (e) { /* ignore */ } };

const RANGES = [
  { id: '7', label: '7 T', days: 7 },
  { id: '30', label: '30 T', days: 30 },
  { id: '90', label: '90 T', days: 90 },
  { id: '365', label: '1 J', days: 365 },
  { id: 'all', label: 'Alle' },
];

function rangeBounds(id) {
  const to = todayKey();
  const r = RANGES.find(x => x.id === id) ?? RANGES[1];
  if (r.days) return { from: addDays(to, -(r.days - 1)), to, days: r.days };
  const first = store.firstDataDate() ?? addDays(to, -29);
  const from = diffDays(first, to) < 6 ? addDays(to, -6) : first;
  return { from, to, days: diffDays(from, to) + 1, all: true };
}

/* ---------------- small UI helpers ---------------- */

function face(v) {
  const mouth = {
    1: 'M7.8 16.6 Q12 11.6 16.2 16.6',
    2: 'M8.4 16 Q12 13.6 15.6 16',
    3: 'M8.4 15.2 L15.6 15.2',
    4: 'M8.4 14.4 Q12 17.4 15.6 14.4',
    5: 'M7.6 13.8 Q12 19.4 16.4 13.8',
  }[v];
  return s('svg', { viewBox: '0 0 24 24', 'aria-hidden': 'true' },
    s('circle', { cx: 8.9, cy: 9.6, r: 1.35, fill: 'currentColor' }),
    s('circle', { cx: 15.1, cy: 9.6, r: 1.35, fill: 'currentColor' }),
    s('path', { d: mouth, fill: 'none', stroke: 'currentColor', 'stroke-width': 1.7, 'stroke-linecap': 'round' }),
  );
}

let toastTimer;
function toast(text) {
  const el = $('#toast');
  el.replaceChildren(icon('i-check'), text);
  el.classList.add('show');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.remove('show'), 2600);
}

// Button that needs a second tap to confirm (dialogs like confirm() are avoided).
function armedButton(label, armedLabel, onConfirm, cls = 'btn ghost danger') {
  let timer;
  const btn = h('button', { type: 'button', class: cls }, label);
  btn.addEventListener('click', () => {
    if (btn.classList.contains('armed')) {
      clearTimeout(timer);
      onConfirm();
      return;
    }
    btn.classList.add('armed');
    btn.textContent = armedLabel;
    timer = setTimeout(() => { btn.classList.remove('armed'); btn.textContent = label; }, 4000);
  });
  return btn;
}

function segmented(el, value, onChange) {
  el.replaceChildren(...RANGES.map(r => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(r.id === value),
    onclick: () => onChange(r.id),
  }, r.label)));
}

function deltaEl(delta) {
  const dir = delta > 0.15 ? 'up' : delta < -0.15 ? 'down' : 'flat';
  return h('span', { class: `delta ${dir}` }, icon(dir === 'up' ? 'i-up' : dir === 'down' ? 'i-down' : 'i-flat'), signed1(delta));
}

function openDatePicker(input) {
  try { input.showPicker?.(); } catch (e) { /* falls back to native focus */ }
}

/* ---------------- sheet (dialog) ---------------- */

const sheet = $('#sheet');
function openSheet(title, ...content) {
  $('#sheet-title').textContent = title;
  $('#sheet-body').replaceChildren(h('div', { class: 'sheet-body' }, ...content));
  if (!sheet.open) { lockScroll(); sheet.showModal(); }
  sheet.scrollTop = 0;
  // Start focus on the title, so the close button doesn't light up on open.
  $('#sheet-title').focus({ preventScroll: true });
}
const closeSheet = () => sheet.open && sheet.close();
// While a sheet is open the page behind it must not scroll (iOS ignores overflow:hidden, so pin the body).
let lockedY = null;
function lockScroll() {
  if (lockedY != null) return;
  lockedY = window.scrollY;
  Object.assign(document.body.style, { position: 'fixed', top: `-${lockedY}px`, left: '0', right: '0', width: '100%' });
}
function unlockScroll() {
  if (lockedY == null) return;
  Object.assign(document.body.style, { position: '', top: '', left: '', right: '', width: '' });
  window.scrollTo(0, lockedY);
  lockedY = null;
}
sheet.addEventListener('close', () => { unlockScroll(); sheet.style.transform = ''; sheet.style.transition = ''; });

// Swipe down to close: from the grip or title at any time, from the content when it is scrolled to the top.
let sheetDrag = null;
sheet.addEventListener('touchstart', e => {
  if (e.touches.length !== 1) return;
  const fromHead = !!e.target.closest('.sheet-grip, .sheet-head');
  if (!fromHead && (sheet.scrollTop > 0 || e.target.closest('textarea, .fine-track'))) return;
  sheetDrag = { y0: e.touches[0].clientY, t0: performance.now(), dy: 0, active: false, fromHead };
}, { passive: true });
sheet.addEventListener('touchmove', e => {
  if (!sheetDrag) return;
  const dy = e.touches[0].clientY - sheetDrag.y0;
  if (!sheetDrag.active) {
    if (dy < -4) { sheetDrag = null; return; }          // scrolling up: leave it to the content
    if (dy < 8) return;
    if (!sheetDrag.fromHead && sheet.scrollTop > 0) { sheetDrag = null; return; }
    sheetDrag.active = true;
    sheetDrag.t0 = performance.now();
    sheetDrag.y0 = e.touches[0].clientY;
  }
  e.preventDefault();
  sheetDrag.dy = Math.max(0, e.touches[0].clientY - sheetDrag.y0);
  sheet.style.transition = 'none';
  sheet.style.transform = `translateY(${sheetDrag.dy}px)`;
}, { passive: false });
function endSheetDrag() {
  const d = sheetDrag;
  sheetDrag = null;
  if (!d?.active) return;
  const speed = d.dy / Math.max(1, performance.now() - d.t0);   // px per ms
  sheet.style.transition = 'transform .2s ease';
  if (d.dy > 110 || (d.dy > 40 && speed > 0.5)) {
    sheet.style.transform = 'translateY(110%)';
    setTimeout(closeSheet, 180);
  } else {
    sheet.style.transform = '';
  }
}
sheet.addEventListener('touchend', endSheetDrag);
sheet.addEventListener('touchcancel', endSheetDrag);
$('#sheet-close').addEventListener('click', closeSheet);
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

function field(label, input, extraClass = '') {
  return h('div', { class: `field ${extraClass}` }, h('label', { for: input.id }, label), input);
}

/* ---------------- routing ---------------- */

const VIEWS = ['heute', 'verlauf', 'medis', 'alltag'];
let currentView = 'heute';

function route() {
  const hash = location.hash.replace('#', '');
  currentView = VIEWS.includes(hash) ? hash : 'heute';
  for (const v of VIEWS) $(`#view-${v}`).hidden = v !== currentView;
  document.querySelectorAll('.tab').forEach(t => {
    if (t.dataset.tab === currentView) t.setAttribute('aria-current', 'page');
    else t.removeAttribute('aria-current');
  });
  renderView();
  window.scrollTo(0, 0);
}
window.addEventListener('hashchange', route);

function renderView() {
  if (currentView === 'heute') renderHeute();
  if (currentView === 'verlauf') renderVerlauf();
  if (currentView === 'medis') renderMedis();
  if (currentView === 'alltag') renderAlltag();
  renderBanners();
}

/* ================= HEUTE ================= */

const form = { date: todayKey(), slot: store.currentSlot(), mood: null, note: '', dirty: false, touched: false };

function loadFormEntry() {
  const e = store.getEntry(form.date, form.slot);
  form.mood = e?.mood ?? null;
  fine.hint = false;
  form.note = e?.note ?? '';
  form.dirty = false;
  $('#entry-note').value = form.note;
  showNote(!!form.note.trim());
}

function selectEntry(date, slot) {
  form.date = date;
  form.slot = slot;
  form.touched = true;
  loadFormEntry();
  renderHeute();
}

function greeting() {
  const hr = new Date().getHours();
  if (hr < 5) return 'Gute Nacht';
  if (hr < 11) return 'Guten Morgen';
  if (hr < 17) return 'Hallo';
  if (hr < 22) return 'Guten Abend';
  return 'Gute Nacht';
}

// The note opens on request; an entry that already has one shows it right away. No auto focus:
// the keyboard should only come up when the field itself is tapped.
function showNote(open) {
  $('#note-wrap').hidden = !open;
  $('#btn-note').hidden = open;
  $('#btn-note').setAttribute('aria-expanded', String(open));
}

/* "Was war heute?": activities of the chosen day with one tap, periods running then, illness. */
let dayAddOpen = false;

function renderDay() {
  const date = form.date;
  const today = todayKey();
  const isToday = date === today;
  const day = isToday ? 'heute' : relativeDay(date) === 'Gestern' ? 'gestern' : `am ${formatDayMonth(date)}`;
  $('#h-day').textContent = `Was war ${day}?`;
  const moments = store.getState().moments;
  const colors = store.momentColors();

  // periods (incl. illness) that cover the day: a row each, tap for details
  const covering = moments.filter(m => m.span && !m.archived && store.momentCovers(m, date)).sort((a, b) => Number(!!b.sick) - Number(!!a.sick) || a.date.localeCompare(b.date));
  $('#day-running').replaceChildren(...covering.map(m => endablePeriod(m, colors)));
  $('#day-running').hidden = !covering.length;

  // single activities: titles used before, most frequent first; tap sets or removes it for this day
  const onDay = moments.filter(m => !m.span && !m.archived && m.date === date);
  const counts = new Map();
  for (const m of moments) {
    if (m.span || m.archived || m.sick) continue;
    const k = m.title.toLowerCase();
    const c = counts.get(k) ?? { title: m.title, n: 0, last: '' };
    c.n++;
    if (m.date >= c.last) { c.last = m.date; c.title = m.title; }
    counts.set(k, c);
  }
  for (const m of onDay) if (!counts.has(m.title.toLowerCase())) counts.set(m.title.toLowerCase(), { title: m.title, n: 1, last: m.date });
  const titles = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last.localeCompare(a[1].last)).slice(0, 12);
  const has = key => onDay.some(m => m.title.toLowerCase() === key);
  $('#day-chips').replaceChildren(
    ...titles.map(([key, tt]) => {
      const on = has(key);
      return h('button', { type: 'button', class: `quick-chip${on ? ' on' : ''}`, 'aria-pressed': String(on), onclick: () => toggleDayActivity(tt.title) },
        h('span', { class: 'key-dot', style: { background: momentCss(colors, tt.title) } }), tt.title, on ? h('small', null, '✓') : null);
    }),
    h('button', { type: 'button', class: `quick-chip add${dayAddOpen ? ' on' : ''}`, 'aria-expanded': String(dayAddOpen),
      onclick: () => { dayAddOpen = !dayAddOpen; renderDay(); if (dayAddOpen) $('#day-input').focus(); } }, '＋ Neu'));
  $('#day-add').hidden = !dayAddOpen;
  $('#day-meta').textContent = titles.length
    ? 'Tippe an, was du gemacht oder erlebt hast. Noch mal tippen nimmt es weg.'
    : 'Zum Beispiel eine Morgenroutine, ein Spaziergang oder ein gutes Gespräch. Tippe auf „＋ Neu“.';

  // "Ich bin krank": for today, as long as no illness is running
  $('#btn-im-sick').hidden = !isToday || covering.some(m => m.sick);
}

function toggleDayActivity(title) {
  const key = title.trim().toLowerCase();
  if (!key) return;
  const existing = store.getState().moments.find(m => !m.span && !m.archived && m.date === form.date && m.title.toLowerCase() === key);
  if (existing) store.deleteMoment(existing.id);
  else store.addMoment({ date: form.date, title });
}

function addDayActivity() {
  const input = $('#day-input');
  const title = input.value.trim();
  if (!title) { input.focus(); return; }
  const key = title.toLowerCase();
  // adding what is already there is a no-op, not a toggle
  if (!store.getState().moments.some(m => !m.span && !m.archived && m.date === form.date && m.title.toLowerCase() === key)) store.addMoment({ date: form.date, title });
  input.value = '';
  dayAddOpen = false;
  toast(`${title} eingetragen`);
  renderDay();
}

/* ---------- Krank: its own area ---------- */

const sickRunning = () => store.illnesses().find(m => !m.archived && store.momentRunning(m) && (m.end == null || m.end > todayKey()));

function renderSickStatus() {
  const cur = sickRunning();
  const all = store.illnesses();
  $('#sick-status').textContent = cur
    ? `${cur.title} seit ${formatShort(cur.date)}`
    : all.length ? `Zuletzt: ${all[0].title}, ${momentDateLabel(all[0])}` : 'Krankheitstage nachtragen und ansehen';
  $('#btn-sick').classList.toggle('active', !!cur);
}

function sickSheet() {
  const today = todayKey();
  const cur = sickRunning();
  const past = store.illnesses().filter(m => m !== cur);
  const title = h('input', { id: 'sick-title', type: 'text', maxlength: 80, placeholder: 'z. B. Grippe, Erkältung (leer = „Krank“)', autocomplete: 'off' });
  const from = h('input', { id: 'sick-from', type: 'date', value: today, max: today, required: true });
  const to = h('input', { id: 'sick-to', type: 'date', min: today, max: momentEndMax() });
  const note = h('input', { id: 'sick-note', type: 'text', maxlength: 500, placeholder: 'z. B. Fieber, Antibiotikum', autocomplete: 'off' });
  from.addEventListener('change', () => { to.min = from.value; });
  const err = h('p', { class: 'form-error', hidden: true });
  const row = m => h('button', { type: 'button', class: 'period-row', onclick: () => editMomentSheet(m) },
    h('span', { class: 'key-bar key-sick' }),
    h('span', { class: 'period-main' },
      h('span', { class: 'period-title' }, m.title),
      h('small', null, `${momentDateLabel(m)} · ${store.spanEffect(m).days} ${store.spanEffect(m).days === 1 ? 'Tag' : 'Tage'}`),
      m.note ? h('span', { class: 'period-note' }, m.note) : null));

  openSheet('Krank',
    h('p', { class: 'sheet-text' }, 'Krankheitstage liegen in allen Grafiken als rot gestreiftes Feld. So siehst du, wann ein Tief mit einer Krankheit zusammenfällt.'),
    cur ? h('section', { class: 'sick-now' },
      h('p', { class: 'sick-now-title' }, h('span', { class: 'key-bar key-sick' }), `${cur.title} seit ${formatShort(cur.date)}`),
      cur.note ? h('p', { class: 'sheet-text' }, cur.note) : null,
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn ghost', onclick: () => editMomentSheet(cur) }, 'Bearbeiten'),
        armedButton('Wieder gesund', 'Heute beenden? Nochmal tippen', () => { store.endMoment(cur.id, today); closeSheet(); toast('Krankheit beendet. Schön, dass es dir besser geht.'); }, 'btn primary'))) : null,
    h('form', { class: 'sheet-section sheet-body', onsubmit: e => {
      e.preventDefault();
      const values = { title: withSickTitle(title.value, 'sick'), date: from.value, end: to.value || null, note: note.value, span: true, sick: true };
      const msg = momentError(values);
      if (msg) { err.textContent = msg; err.hidden = false; return; }
      store.addMoment(values);
      closeSheet();
      toast(`${values.title} eingetragen`);
    } },
    h('h3', null, cur ? 'Weitere Krankheit eintragen' : 'Krankheit eintragen'),
    field('Name (optional)', title),
    h('div', { class: 'field-row' }, field('Von', from), field('Bis (leer = noch krank)', to)),
    field('Notiz', note), err,
    h('div', { class: 'sheet-actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Eintragen'))),
    past.length ? h('section', { class: 'sheet-section' }, h('h3', null, 'Frühere'), h('div', { class: 'period-list' }, ...past.map(row))) : null);
}

// A running period as a row (with its note); tapping it opens its details.
function endablePeriod(m, colors) {
  return h('button', { type: 'button', class: 'period-row', 'aria-label': `${m.title}, seit ${formatShort(m.date)}. Tippen für Details.`, onclick: () => periodSheet(m.id) },
    momentMark(colors, m, 'key-bar'),
    h('span', { class: 'period-main' },
      h('span', { class: 'period-title' }, m.title),
      h('small', null, m.end ? `${formatShort(m.date)} – ${formatShort(m.end)}` : `seit ${formatShort(m.date)}`),
      m.note ? h('span', { class: 'period-note' }, m.note) : null));
}

// Details of a period: dates, length, mood, note. From here it can be edited or ended (with confirmation).
function periodSheet(id) {
  const m = store.getState().moments.find(x => x.id === id);
  if (!m) return;
  const today = todayKey();
  const colors = store.momentColors();
  const e = store.spanEffect(m);
  const ongoing = m.end == null || m.end > today;
  const status = m.date > today ? `Beginnt am ${formatLong(m.date)}` : m.end == null ? 'Läuft noch' : m.end > today ? `Läuft noch, geplant bis ${formatShort(m.end)}` : 'Beendet';
  const rows = [
    ['Beginn', formatLong(m.date)],
    ['Ende', m.end == null ? 'offen' : formatLong(m.end)],
    ['Dauer', e.started ? `${e.days} ${e.days === 1 ? 'Tag' : 'Tage'}${ongoing ? ' bisher' : ''}` : '–'],
    ['Ø Stimmung', e.during.avg != null ? `${num1(e.during.avg)} · ${e.during.days} ${e.during.days === 1 ? 'Tag' : 'Tage'} mit Eintrag` : 'noch keine Einträge'],
    ['Davor (4 Wochen)', e.before.avg != null ? `Ø ${num1(e.before.avg)}${e.during.avg != null ? ` · ${signed1(e.during.avg - e.before.avg)} währenddessen` : ''}` : '–'],
    ...(e.ended && e.after.avg != null ? [['Danach (4 Wochen)', `Ø ${num1(e.after.avg)}`]] : []),
  ];
  openSheet(m.title,
    h('p', { class: 'sheet-text period-status' }, momentMark(colors, m, 'key-bar'), m.sick ? `Krank · ${status}` : status),
    h('dl', { class: 'info-list' }, ...rows.flatMap(([k, v]) => [h('dt', null, k), h('dd', null, v)])),
    m.note ? h('section', { class: 'sheet-section' }, h('h3', null, 'Notiz'), h('p', { class: 'sheet-text period-note-full' }, m.note)) : null,
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => editMomentSheet(m) }, 'Bearbeiten'),
      ongoing ? armedButton(m.sick ? 'Wieder gesund' : 'Heute beenden', m.sick ? 'Heute beenden? Nochmal tippen' : 'Wirklich beenden? Nochmal tippen', () => {
        store.endMoment(m.id, today);
        closeSheet();
        toast(m.sick ? 'Krankheit beendet. Schön, dass es dir besser geht.' : `${m.title} beendet`);
      }, m.sick ? 'btn primary' : 'btn danger') : null));
}

function renderHeute() {
  const today = todayKey();
  $('#today-date').textContent = formatLong(today);
  $('#h-heute').textContent = greeting();

  // slots
  const dayEntries = store.dayEntries(form.date);
  $('#slot-group').replaceChildren(...store.SLOTS.map(sl => {
    const e = dayEntries[sl.id];
    return h('button', {
      type: 'button', class: 'slot', role: 'radio', 'aria-checked': String(sl.id === form.slot),
      'aria-label': `${sl.label}${e ? ` – eingetragen: ${store.describeMood(e.mood)}` : ' – noch offen'}`,
      onclick: () => { form.slot = sl.id; form.touched = true; loadFormEntry(); renderHeute(); },
    }, h('span', { class: `slot-dot${e ? ' filled' : ''}`, style: e ? { background: store.moodColor(e.mood) } : null }), sl.label);
  }));

  // date
  const dateInput = $('#entry-date');
  dateInput.max = today;
  dateInput.value = form.date;
  $('#entry-date-label').textContent = relativeDay(form.date);
  dateInput.closest('.date-pill').classList.toggle('past', form.date !== today);

  // moods
  const existing = store.getEntry(form.date, form.slot);
  const slotName = store.slotLabel(form.slot);
  const isNow = form.date === today && form.slot === store.currentSlot();
  const adverb = { morning: 'morgens', noon: 'mittags', evening: 'abends' }[form.slot];
  const when = form.date === today ? `heute ${slotName}`
    : form.date === addDays(today, -1) ? `gestern ${slotName}`
    : `am ${formatDayMonth(form.date)} ${adverb}`;
  $('#mood-question').textContent = isNow ? 'Wie geht es dir gerade?' : `Wie ging es dir ${when}?`;
  $('#mood-group').replaceChildren(...store.MOODS.map(m => h('button', {
    type: 'button', class: 'mood', role: 'radio', dataset: { value: m.value },
    onclick: () => { if (performance.now() > fine.suppressClickUntil) { fine.hint = true; setMood(m.value); } },
  }, h('span', { class: 'mood-face' }, face(m.value)), m.label)));
  updateMoodUI();
  $('#btn-delete-entry').hidden = !existing;
  resetDeleteButton();
  renderDay();

  renderWeek();
}

function renderWeek() {
  const today = todayKey();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const grid = [h('div')];
  for (const d of days) {
    const sick = store.sickOn(d);
    grid.push(h('div', { class: `week-col-head${d === today ? ' today' : ''}${sick ? ' sick' : ''}`, title: sick ? `Krank · ${sick.title}` : null }, h('strong', null, formatWeekday(d)), new Date(d + 'T12:00').getDate() + '.'));
  }
  for (const sl of store.SLOTS) {
    grid.push(h('div', { class: 'week-row-label' }, sl.label));
    for (const d of days) {
      const e = store.dayEntries(d)[sl.id];
      const selected = d === form.date && sl.id === form.slot;
      grid.push(h('button', {
        type: 'button',
        class: `week-cell${e ? ' filled' : ''}${selected ? ' selected' : ''}`,
        style: e ? { background: store.moodColor(e.mood) } : null,
        'aria-label': `${formatWeekday(d)} ${formatDayMonth(d)}, ${sl.label}: ${e ? store.describeMood(e.mood) : 'kein Eintrag'}`,
        onclick: () => { selectEntry(d, sl.id); window.scrollTo({ top: 0, behavior: 'smooth' }); },
      }));
    }
  }
  grid.push(h('div', { class: 'week-row-label' }, 'Ø'));
  for (const d of days) {
    const v = store.dayAverage(d);
    grid.push(h('div', { class: `week-avg${v == null ? ' empty' : ''}` }, v == null ? '–' : num1(v)));
  }
  $('#week-grid').replaceChildren(...grid);

  const cur = store.windowAverage(days[0], today);
  const prev = store.windowAverage(addDays(days[0], -7), addDays(today, -7));
  const meta = $('#week-meta');
  if (cur.avg == null) meta.textContent = 'Deine Einträge der letzten 7 Tage erscheinen hier.';
  else meta.replaceChildren(`Ø ${num1(cur.avg)}`, prev.avg != null ? ` · Woche davor Ø ${num1(prev.avg)}` : '');

  $('#week-legend').replaceChildren(...store.MOODS.map(m => h('span', null, h('i', { style: { background: `var(--m${m.value})` } }), `${m.value} ${m.label}`)));
}

/* ---------- mood value: faces + fine slider ---------- */

const fine = { suppressClickUntil: 0, dragging: false, hint: false };

function setMood(v) {
  const next = store.roundMood(v);
  if (form.mood != null && Math.floor(next) !== Math.floor(form.mood)) {
    try { navigator.vibrate?.(6); } catch (e) { /* no haptics */ }
  }
  form.mood = next;
  form.dirty = true;
  updateMoodUI();
}

// Light update without rebuilding the buttons, so dragging stays smooth.
function updateMoodUI() {
  const v = form.mood;
  const level = v == null ? null : store.moodLevel(v);
  for (const btn of $('#mood-group').children) {
    const value = Number(btn.dataset.value);
    btn.setAttribute('aria-checked', String(value === level));
    btn.style.setProperty('--mc', value === level ? store.moodColor(v) : `var(--m${value})`);
  }

  const wrap = $('#mood-fine');
  // The slider only shows while dragging from a face, or when a value between two faces is set.
  const open = v != null && (fine.dragging || !Number.isInteger(v));
  wrap.classList.toggle('open', open);
  wrap.inert = !open;
  if (open) {
    wrap.style.setProperty('--v', v);
    wrap.style.setProperty('--tc', store.moodColor(v));
    $('#mood-thumb-value').textContent = store.formatMood(v);
    const slider = $('#mood-slider');
    slider.setAttribute('aria-valuenow', v);
    slider.setAttribute('aria-valuetext', `${store.formatMood(v)} von 5, ${store.describeMood(v)}`);
  }

  const existing = store.getEntry(form.date, form.slot);
  const caption = $('#mood-caption');
  if (v == null) caption.replaceChildren('Tippe auf ein Gesicht.');
  else {
    const text = existing && !form.dirty
      ? `Eingetragen: ${Number.isInteger(v) ? '' : store.formatMood(v) + ' · '}${store.describeMood(v)}`
      : `${store.formatMood(v)} von 5 · ${store.describeMood(v)}`;
    caption.replaceChildren(text);
    // Only right after a face tap: that is when someone may not know the slider yet.
    if (fine.hint && form.dirty) caption.append(h('span', { class: 'hint' }, 'Für Zwischenwerte: Gesicht gedrückt halten und zur Seite ziehen'));
  }
  updateSaveButton();
}

function updateSaveButton() {
  const existing = store.getEntry(form.date, form.slot);
  const save = $('#btn-save');
  save.disabled = form.mood == null || (existing && !form.dirty);
  save.textContent = existing ? (form.dirty ? 'Änderung speichern' : 'Gespeichert') : `${store.slotLabel(form.slot)} speichern`;
}

// Value under a screen x position, measured from the first to the last face centre.
function moodAtX(clientX) {
  const faces = $('#mood-group').querySelectorAll('.mood-face');
  const a = faces[0].getBoundingClientRect();
  const b = faces[faces.length - 1].getBoundingClientRect();
  const x1 = a.left + a.width / 2, x5 = b.left + b.width / 2;
  return 1 + ((clientX - x1) / (x5 - x1)) * 4;
}

function initFineSlider() {
  const group = $('#mood-group');
  const wrap = $('#mood-fine');
  const slider = $('#mood-slider');
  const thumb = $('#mood-thumb');

  // A gesture only becomes a drag after a clearly sideways move, so scrolling and taps keep working.
  // If the browser takes the gesture over for scrolling (pointercancel), the previous value comes back.
  let g = null;

  const finish = cancelled => {
    if (!g) return;
    if (g.active) {
      if (cancelled) { form.mood = g.mood; form.dirty = g.dirty; fine.hint = g.hint; updateMoodUI(); }
      else fine.suppressClickUntil = performance.now() + 400; // swallow the click that follows a drag
    }
    g = null;
    fine.dragging = false;
    wrap.classList.remove('dragging');
    group.classList.remove('dragging');
    updateMoodUI();
    window.removeEventListener('pointerup', onUp, true);
    window.removeEventListener('pointercancel', onCancel, true);
  };
  const onUp = e => { if (g && e.pointerId === g.id) finish(false); };
  const onCancel = e => { if (g && e.pointerId === g.id) finish(true); };

  const onDown = e => {
    if (g || (e.pointerType === 'mouse' && e.button !== 0)) return;
    const onThumb = !!e.target.closest?.('#mood-thumb');
    g = {
      el: e.currentTarget, id: e.pointerId, x: e.clientX, y: e.clientY,
      mood: form.mood, dirty: form.dirty, hint: fine.hint, active: false,
      // Grabbing the thumb off-centre must not make it jump to the finger.
      offset: onThumb && form.mood != null ? form.mood - moodAtX(e.clientX) : 0,
    };
    window.addEventListener('pointerup', onUp, true);
    window.addEventListener('pointercancel', onCancel, true);
  };

  const onMove = e => {
    if (!g || e.pointerId !== g.id) return;
    if (e.pointerType === 'mouse' && !e.buttons) return finish(false); // released outside the window
    if (!g.active) {
      const dx = Math.abs(e.clientX - g.x), dy = Math.abs(e.clientY - g.y);
      if (dx < 10 || dx < 2 * dy) return;
      g.active = true;
      fine.dragging = true;
      fine.hint = false;
      g.el.setPointerCapture?.(e.pointerId);
      wrap.classList.add('dragging');
      group.classList.add('dragging');
      updateMoodUI();
    }
    e.preventDefault();
    setMood(moodAtX(e.clientX) + g.offset);
  };

  for (const el of [group, slider]) {
    el.addEventListener('pointerdown', onDown);
    el.addEventListener('pointermove', onMove);
  }

  // Tapping the rail jumps there. Using click (not pointerup) means a touch that only stops
  // a coasting scroll, or turns into a scroll, does nothing: browsers don't send a click then.
  slider.addEventListener('click', e => {
    if (performance.now() <= fine.suppressClickUntil || thumb.contains(e.target) || e.detail === 0) return;
    fine.hint = false;
    setMood(moodAtX(e.clientX));
  });

  slider.addEventListener('keydown', e => {
    if (form.mood == null) return;
    const steps = { ArrowLeft: -0.1, ArrowDown: -0.1, ArrowRight: 0.1, ArrowUp: 0.1, PageDown: -1, PageUp: 1 };
    let next;
    if (e.key in steps) next = form.mood + steps[e.key];
    else if (e.key === 'Home') next = 1;
    else if (e.key === 'End') next = 5;
    else return;
    e.preventDefault();
    fine.hint = false;
    setMood(next);
  });
}

let deleteArmTimer;
function resetDeleteButton() {
  const btn = $('#btn-delete-entry');
  clearTimeout(deleteArmTimer);
  btn.classList.remove('armed');
  btn.textContent = 'Eintrag löschen';
}

function initHeute() {
  $('#entry-note').addEventListener('input', e => {
    form.note = e.target.value;
    form.dirty = true;
    updateSaveButton();
  });

  initFineSlider();

  const dateInput = $('#entry-date');
  dateInput.addEventListener('click', () => openDatePicker(dateInput));
  dateInput.addEventListener('change', () => {
    if (!dateInput.value) return;
    form.date = dateInput.value > todayKey() ? todayKey() : dateInput.value;
    form.touched = true;
    loadFormEntry();
    renderHeute();
  });

  $('#entry-form').addEventListener('submit', e => {
    e.preventDefault();
    if (!form.mood) return;
    const created = store.saveEntry({ date: form.date, slot: form.slot, mood: form.mood, note: form.note.trim() });
    form.dirty = false;
    store.requestPersistence();
    toast(created ? `${store.slotLabel(form.slot)} gespeichert` : 'Änderung gespeichert');
    renderHeute();
  });

  $('#btn-delete-entry').addEventListener('click', e => {
    const btn = e.currentTarget;
    if (!btn.classList.contains('armed')) {
      btn.classList.add('armed');
      btn.textContent = 'Wirklich löschen?';
      deleteArmTimer = setTimeout(resetDeleteButton, 4000);
      return;
    }
    store.deleteEntry(form.date, form.slot);
    loadFormEntry();
    toast('Eintrag gelöscht');
    renderHeute();
  });
}

/* ================= VERLAUF ================= */

let listDays = 7;
// A range picked by zooming the chart (two fingers / trackpad). While set, the whole page follows it.
let zoom = null;

function renderVerlauf() {
  segmented($('#range'), zoom ? null : prefs.range, id => { zoom = null; prefs.range = id; savePrefs(); renderVerlauf(); });
  const { from, to, days, all } = zoom ? { ...zoom, days: diffDays(zoom.from, zoom.to) + 1, all: false } : rangeBounds(prefs.range);
  $('#zoom-info').hidden = !zoom;
  if (zoom) $('#zoom-label').textContent = `${formatDayMonth(from)} – ${formatDayMonth(to)}${fromKey(from).getFullYear() !== fromKey(to).getFullYear() || fromKey(to).getFullYear() !== fromKey(todayKey()).getFullYear() ? ` ${fromKey(to).getFullYear()}` : ''} · ${days} Tage`;
  const st = store.rangeStats(from, to);

  // stat tiles
  const prev = all ? null : store.windowAverage(addDays(from, -days), addDays(from, -1));
  const first = store.firstDataDate();
  const possibleDays = first ? Math.min(days, diffDays(first > from ? first : from, to) + 1) : 0;
  const stat = (label, value, sub, cls = '') => h('div', { class: 'stat' },
    h('p', { class: 'stat-label' }, label), h('div', { class: `stat-value ${cls}` }, value), h('p', { class: 'stat-sub' }, sub));
  const delta = prev?.avg != null && st.avg != null ? st.avg - prev.avg : null;
  const dir = delta == null ? '' : delta > 0.15 ? 'up' : delta < -0.15 ? 'down' : 'flat';
  $('#stats').replaceChildren(
    stat('Durchschnitt', st.avg == null ? '–' : num1(st.avg), st.avg == null ? 'noch keine Daten' : `von 5 · ${store.moodLabel(Math.round(st.avg))}`),
    stat('Veränderung',
      delta == null ? '–' : [icon(dir === 'up' ? 'i-up' : dir === 'down' ? 'i-down' : 'i-flat'), signed1(delta)],
      delta == null ? (all ? 'bei „Alle“ kein Vergleich' : 'kein Vergleichszeitraum') : `gegenüber den ${days} Tagen davor`, dir),
    stat('Einträge', String(st.count), possibleDays ? `von ${possibleDays * 3} möglichen` : 'bisher'),
  );

  // one chart for everything; medications and activities can be shown as extra lanes
  const state = store.getState();
  const hasMeds = state.meds.length > 0;
  const hasActs = state.moments.some(m => !m.sick);
  const layer = (key, label) => h('button', {
    type: 'button', class: `layer-chip${prefs.layers[key] ? ' on' : ''}`, 'aria-pressed': String(!!prefs.layers[key]),
    onclick: () => { prefs.layers = { ...prefs.layers, [key]: !prefs.layers[key] }; savePrefs(); renderVerlauf(); },
  }, h('span', { class: 'layer-check', 'aria-hidden': 'true' }), label);
  $('#layers').replaceChildren(...[hasMeds && layer('meds', 'Medikamente'), hasActs && layer('moments', 'Aktivitäten')].filter(Boolean));
  timelineLegend($('#timeline-legend'), { from, to });
  $('#band-legend').replaceChildren(
    ...store.MOODS.map(m => h('span', null, h('i', { style: { background: `var(--m${m.value})` } }), `${m.value} ${m.label}`)),
    h('span', null, h('i', { class: 'none' }), 'kein Eintrag'));
  const allRange = rangeBounds('all');
  timelineChart($('#timeline'), {
    from, to, meds: hasMeds && prefs.layers.meds, moments: hasActs && prefs.layers.moments,
    bounds: { min: allRange.from < from ? allRange.from : from, max: todayKey() },
    onZoom: r => { zoom = r; renderVerlauf(); },
  });

  renderInsights(from, to);

  // per time of day
  $('#slot-bars').replaceChildren(
    ...st.slots.map(sl => h('div', { class: 'hbar' },
      h('span', { class: 'hbar-label' }, sl.label),
      h('div', { class: 'hbar-track' }, sl.avg != null ? h('div', { class: 'hbar-fill', style: { width: `${((sl.avg - 1) / 4) * 100}%` } }) : null),
      h('span', { class: 'hbar-value' }, sl.avg == null ? '–' : num1(sl.avg), h('small', null, `${sl.n}×`)))),
    h('p', { class: 'scale-note' }, 'Skala 1 bis 5. Ein voller Balken heißt „Sehr gut“.'),
  );

  renderEntryList();
}

// "Was auffällt": medications/therapies and activities, mood on days with vs. without, biggest difference first.
function renderInsights(from, to) {
  const el = $('#insights');
  const colors = store.momentColors();
  const items = [];
  for (const m of store.getState().meds) {
    if (m.archived) continue;   // archived: out of the chart and out of this list
    const c = store.medComparison(m, from, to);
    if (c.with.days >= 5 && c.without.days >= 5) {
      items.push({ name: m.name, c, open: () => medSheet(m.id), mark: h('span', { class: 'med-swatch', style: { background: `var(--c${m.color + 1})` } }) });
    }
  }
  for (const a of store.momentActivities()) {
    if (a.archived) continue;
    const c = store.momentComparison(a.title, from, to);
    if (c.with.days >= 3 && c.without.days >= 5) {
      items.push({ name: a.title, c, open: () => activitySheet(a.title), mark: h('span', { class: 'key-dot', style: { background: momentCss(colors, a.title) } }) });
    }
  }
  items.sort((a, b) => Math.abs(b.c.with.avg - b.c.without.avg) - Math.abs(a.c.with.avg - a.c.without.avg));
  if (!items.length) {
    el.replaceChildren(h('p', { class: 'empty-text' }, 'Sobald es im Zeitraum genug Tage mit und ohne ein Medikament oder eine Aktivität gibt, steht hier, was auffällt.'));
    return;
  }
  el.replaceChildren(...items.slice(0, 8).map(it => h('button', { type: 'button', class: 'insight', onclick: it.open },
    it.mark,
    h('span', { class: 'insight-main' },
      h('span', { class: 'insight-name' }, it.name),
      h('span', { class: 'insight-sub' }, `Ø ${num1(it.c.with.avg)} mit · Ø ${num1(it.c.without.avg)} ohne · ${it.c.with.days} + ${it.c.without.days} Tage`)),
    deltaEl(it.c.with.avg - it.c.without.avg))));
}

function renderEntryList() {
  const entries = store.getState().entries;
  const list = $('#entry-list');
  if (!entries.length) {
    list.replaceChildren(h('p', { class: 'empty-text' }, 'Noch keine Einträge.'));
    $('#btn-more-entries').hidden = true;
    return;
  }
  const dates = [...new Set(entries.map(e => e.date))].sort().reverse();
  const shown = dates.slice(0, listDays);
  list.replaceChildren(...shown.map(date => {
    const day = store.dayEntries(date);
    return h('div', { class: 'day-group' },
      h('div', { class: 'day-group-head' }, h('h3', null, relativeDay(date)), h('span', null, `Ø ${num1(store.dayAverage(date))}`)),
      ...store.SLOTS.filter(sl => day[sl.id]).map(sl => {
        const e = day[sl.id];
        return h('button', {
          type: 'button', class: 'entry-row',
          onclick: () => { selectEntry(date, sl.id); location.hash = '#heute'; },
        },
        h('span', { class: 'entry-face', style: { background: store.moodColor(e.mood) } }, face(store.moodLevel(e.mood))),
        h('span', { class: 'entry-main' },
          h('span', { class: 'entry-title' },
            Number.isInteger(e.mood) ? store.moodLabel(e.mood) : `${store.formatMood(e.mood)} · ${store.describeMood(e.mood)}`,
            h('span', null, ` · ${sl.label}`)),
          e.note ? h('p', { class: 'entry-note' }, e.note) : null));
      }));
  }));
  const more = $('#btn-more-entries');
  more.hidden = dates.length <= listDays;
}

/* ================= MEDIKAMENTE & THERAPIEN ================= */

// Wording per kind: medications have a dose, therapies a frequency or type.
const TERMS = {
  med: {
    kind: 'Medikament', group: 'Medikamente', dose: 'Dosis', newDose: 'Neue Dosis', noDose: 'Ohne Dosis',
    change: 'Dosis ändern', stop: 'Absetzen', stopped: 'Abgesetzt', active: 'Nehme ich', restart: 'Wieder einnehmen',
    since: 'Nehme ich seit', lastDay: 'Letzter Einnahmetag', last: 'zuletzt genommen am', periods: 'Einnahme-Zeiträume',
    stillHint: 'Lass „Bis“ leer, solange du das Medikament noch nimmst.', namePh: 'z. B. Sertralin', dosePh: 'z. B. 50 mg',
    newDosePh: 'z. B. 100 mg', del: 'Medikament löschen', doseToast: 'Neue Dosis gespeichert', stoppedHistory: 'Abgesetzt ab',
    stopToast: n => `${n} als abgesetzt gespeichert`, stopTitle: n => `${n} absetzen`, doseTitle: n => `Dosis von ${n}`,
    restartTitle: n => `${n} wieder einnehmen`, restartToast: n => `${n} wieder aufgenommen`,
    stopText: 'Das Medikament bleibt mit seinem Verlauf erhalten. Du kannst es später wieder aufnehmen.',
    startHint: 'Wenn du das Medikament schon länger nimmst, wähle das ungefähre Startdatum. So passt der Verlauf.',
    withDays: 'an Tagen mit Einnahme', mostly: 'Im Zeitraum fast durchgehend eingenommen', rarely: 'Im Zeitraum kaum eingenommen.',
  },
  therapy: {
    kind: 'Therapie', group: 'Therapien', dose: 'Häufigkeit / Art', newDose: 'Neue Häufigkeit / Art', noDose: 'Ohne Angabe',
    change: 'Häufigkeit ändern', stop: 'Beenden', stopped: 'Beendet', active: 'Läuft', restart: 'Wieder aufnehmen',
    since: 'Beginn', lastDay: 'Letzte Sitzung', last: 'zuletzt am', periods: 'Therapie-Zeiträume',
    stillHint: 'Lass „Bis“ leer, solange die Therapie noch läuft.', namePh: 'z. B. Psychotherapie', dosePh: 'z. B. 1× pro Woche',
    newDosePh: 'z. B. alle 2 Wochen', del: 'Therapie löschen', doseToast: 'Änderung gespeichert', stoppedHistory: 'Beendet ab',
    stopToast: n => `${n} als beendet gespeichert`, stopTitle: n => `${n} beenden`, doseTitle: n => `${n} ändern`,
    restartTitle: n => `${n} wieder aufnehmen`, restartToast: n => `${n} wieder aufgenommen`,
    stopText: 'Die Therapie bleibt mit ihrem Verlauf erhalten. Du kannst sie später wieder aufnehmen.',
    startHint: 'Läuft die Therapie schon länger, wähle das ungefähre Startdatum. Fängt sie erst an, trag den geplanten Beginn ein: Bis dahin steht sie als „Geplant“ da und zählt in der Auswertung erst ab diesem Tag.',
    withDays: 'an Tagen mit laufender Therapie', mostly: 'Im Zeitraum fast durchgehend in Therapie', rarely: 'Im Zeitraum kaum in Therapie.',
  },
};
const T = med => TERMS[med?.kind === 'therapy' ? 'therapy' : 'med'];
const byKind = meds => [...meds].sort((a, b) => (a.kind === 'therapy') - (b.kind === 'therapy'));

// Today's state: running, planned (starts later) or stopped, plus an upcoming change if one is entered.
function medStatus(med) {
  const today = todayKey();
  const cur = store.activePhase(med, today);
  const next = store.nextPhase(med);
  if (cur) {
    let text = `seit ${formatDayMonth(cur.start)}`;
    let upcoming = null;
    if (cur.end && next && next.start === addDays(cur.end, 1)) upcoming = `Ab ${formatDayMonth(next.start)}: ${next.dose || T(med).noDose}`;
    else if (cur.end) text += `, bis ${formatDayMonth(cur.end)}`;
    return { state: 'active', dose: cur.dose, text, upcoming };
  }
  if (next) return { state: 'planned', dose: next.dose, text: `beginnt am ${formatDayMonth(next.start)}` };
  const last = store.lastPhase(med);
  return { state: 'stopped', dose: last.dose, text: `${T(med).last} ${formatDayMonth(last.end)}` };
}

function medHistory(med) {
  const today = todayKey();
  return store.medEvents(med).map(ev => {
    const d = formatShort(ev.date);
    const future = ev.date > today;
    if (ev.type === 'start') return `${future ? 'Beginnt' : 'Begonnen'} ${d}${ev.dose ? ` mit ${ev.dose}` : ''}`;
    if (ev.type === 'restart') return `${future ? 'Beginnt wieder' : 'Wieder begonnen'} ${d}${ev.dose ? ` mit ${ev.dose}` : ''}`;
    if (ev.type === 'dose') return `${future ? 'Ab ' : ''}${d}: ${ev.prevDose || '–'} → ${ev.dose || '–'}`;
    return future ? `Endet ${formatShort(addDays(ev.date, -1))}` : `${T(med).stoppedHistory} ${d}`;
  }).join(' · ');
}

// Furthest date a form accepts: therapies may be planned ahead, medications are logged up to today.
const maxDateFor = kind => (kind === 'therapy' ? addDays(todayKey(), 730) : todayKey());

function medCard(m) {
  const st = medStatus(m);
  const t = T(m);
  const chip = { active: [t.active, ' active'], planned: ['Geplant', ' planned'], stopped: [t.stopped, ''] }[st.state];
  return h('button', { type: 'button', class: 'card med-row', onclick: () => medSheet(m.id) },
    h('span', { class: 'med-swatch', style: { background: `var(--c${m.color + 1})` } }),
    h('span', { class: 'med-row-main' },
      h('span', { class: 'med-row-name' }, m.name),
      h('span', { class: 'med-row-sub' }, `${st.dose || t.noDose} · ${st.text}`),
      st.upcoming ? h('span', { class: 'med-upcoming' }, st.upcoming) : null),
    h('span', { class: `chip${chip[1]}` }, chip[0]));
}

// A folded "Archiv" section; whether it's open survives re-rendering.
const archiveOpen = {};
function archiveSection(key, count, children) {
  if (!count) return null;
  const d = h('details', { class: 'archive' },
    h('summary', null, h('span', null, `Archiv · ${count}`), s('svg', { viewBox: '0 0 24 24', class: 'chevron', 'aria-hidden': 'true' }, s('path', { d: 'M6 9l6 6 6-6', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' }))),
    h('div', { class: 'archive-body' }, ...children));
  d.open = !!archiveOpen[key];
  d.addEventListener('toggle', () => { archiveOpen[key] = d.open; });
  return d;
}

const KIND_FILTERS = [
  { id: 'all', label: 'Alle' },
  { id: 'med', label: 'Medikamente' },
  { id: 'therapy', label: 'Therapien' },
];
const kindOf = m => (m.kind === 'therapy' ? 'therapy' : 'med');

function renderMedis() {
  const meds = store.getState().meds;
  // the filter only makes sense once there are both kinds
  const both = meds.some(m => kindOf(m) === 'med') && meds.some(m => kindOf(m) === 'therapy');
  const filter = both ? prefs.kindFilter : 'all';
  $('#kind-filter').hidden = !both;
  if (both) {
    $('#kind-filter').replaceChildren(...KIND_FILTERS.map(f => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(f.id === filter),
      onclick: () => { prefs.kindFilter = f.id; savePrefs(); renderMedis(); },
    }, f.label)));
  }
  const shown = meds.filter(m => filter === 'all' || kindOf(m) === filter);
  const active = shown.filter(m => !m.archived);
  const archived = shown.filter(m => m.archived);
  const groups = ['med', 'therapy'].map(kind => ({ kind, items: active.filter(m => kindOf(m) === kind) })).filter(g => g.items.length);
  $('#med-list').replaceChildren(...(active.length
    ? groups.flatMap(g => [groups.length > 1 ? h('h3', { class: 'med-group' }, TERMS[g.kind].group) : null, ...g.items.map(medCard)].filter(Boolean))
    : [h('p', { class: 'empty-text card-empty' }, archived.length ? 'Alles ist archiviert.' : 'Trag deine Medikamente und Therapien mit Startdatum ein. Im Verlauf siehst du dann, wie deine Stimmung dazu verlaufen ist.')]));
  const archive = archiveSection('med', archived.length, byKind(archived).map(medCard));
  $('#med-archive').replaceChildren(...(archive ? [archive] : []));
}

// Everything about one medication or therapy: state, history, mood with/without, each change, actions.
function medSheet(id) {
  const m = store.getMed(id);
  if (!m) return;
  const t = T(m);
  const st = medStatus(m);
  const today = todayKey();
  const open = store.openPhase(m);
  const chip = { active: [t.active, ' active'], planned: ['Geplant', ' planned'], stopped: [t.stopped, ''] }[st.state];

  // mood on days with vs. without, over all data
  const c = store.medComparison(m, store.firstDataDate() ?? today, today);
  const row = (label, data, cls) => h('div', { class: 'hbar' },
    h('span', { class: 'hbar-label' }, label),
    h('div', { class: 'hbar-track' }, data.avg != null ? h('div', { class: `hbar-fill ${cls}`, style: { width: `${((data.avg - 1) / 4) * 100}%`, background: cls === 'with' ? `var(--c${m.color + 1})` : null } }) : null),
    h('span', { class: 'hbar-value' }, data.avg == null ? '–' : num1(data.avg), h('small', null, `${data.days} Tage`)));
  let hint;
  if (c.with.days < 5 && c.without.days < 5) hint = 'Noch zu wenige Tage mit Stimmungseintrag.';
  else if (c.without.days < 5) hint = 'Fast durchgehend, deshalb gibt es kaum Vergleichstage.';
  else if (c.with.days < 5) hint = t.rarely;
  else hint = h('span', null, 'Unterschied ', deltaEl(c.with.avg - c.without.avg), ` ${t.withDays}.`);

  // each start, change and end: 4 weeks before vs. weeks 3–6 after
  const events = store.medEvents(m).filter(e => e.date <= today).sort((a, b) => b.date.localeCompare(a.date));
  const eventRow = ev => {
    const ec = store.eventComparison(ev.date);
    let body;
    if (!ec.started) body = [`Vorher Ø ${num1(ec.before.avg)}`, h('span', { class: 'vals' }, ` · Vergleich ab ${formatDayMonth(ec.afterStart)} möglich`)];
    else if (ec.before.avg == null || ec.after.avg == null) body = [ec.before.avg == null ? 'Keine Einträge in den 4 Wochen davor.' : 'Noch keine Einträge in Woche 3 bis 6.'];
    else body = [h('span', { class: 'vals' }, `Ø ${num1(ec.before.avg)} → ${ec.complete ? '' : 'bisher '}Ø ${num1(ec.after.avg)}`), deltaEl(ec.after.avg - ec.before.avg)];
    return h('div', { class: 'event' },
      h('div', { class: 'event-date' }, formatShort(ev.date)),
      h('div', null, h('div', { class: 'event-title' }, eventText(ev)), h('p', { class: 'event-body' }, ...body)));
  };

  const actions = [];
  if (!m.archived && st.state === 'active' && open && open.start <= today) {
    actions.push(h('button', { type: 'button', class: 'btn', onclick: () => doseSheet(m) }, t.change),
      h('button', { type: 'button', class: 'btn', onclick: () => stopSheet(m) }, t.stop));
  } else if (!m.archived && st.state === 'stopped') {
    actions.push(h('button', { type: 'button', class: 'btn', onclick: () => doseSheet(m, true) }, t.restart));
  }

  openSheet(m.name,
    h('div', { class: 'med-sheet-head' },
      h('span', { class: 'med-swatch', style: { background: `var(--c${m.color + 1})` } }),
      h('span', { class: 'med-dose' }, h('strong', null, st.dose || t.noDose), h('span', null, st.text)),
      h('span', { class: `chip${chip[1]}` }, m.archived ? 'Archiviert' : chip[0])),
    st.upcoming ? h('p', { class: 'med-upcoming' }, st.upcoming) : null,
    actions.length ? h('div', { class: 'sheet-actions start' }, ...actions) : null,
    h('section', { class: 'sheet-section' },
      h('h3', null, 'Stimmung mit und ohne'),
      h('div', { class: 'compare-rows' }, row('Mit', c.with, 'with'), row('Ohne', c.without, 'without')),
      h('p', { class: 'compare-hint' }, hint)),
    events.length ? h('section', { class: 'sheet-section' },
      h('h3', null, 'Veränderungen'),
      h('p', { class: 'sheet-text' }, '4 Wochen vorher im Vergleich zu Woche 3 bis 6 danach. Viele Medikamente wirken erst nach einigen Wochen.'),
      h('div', { class: 'events' }, ...events.slice(0, 12).map(eventRow))) : null,
    h('section', { class: 'sheet-section' }, h('h3', null, 'Verlauf'), h('p', { class: 'sheet-text' }, medHistory(m))),
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => {
        store.archiveMed(m.id, !m.archived);
        closeSheet();
        toast(m.archived ? `${m.name} aus dem Archiv geholt` : `${m.name} archiviert`);
      } }, m.archived ? 'Wiederherstellen' : 'Archivieren'),
      h('button', { type: 'button', class: 'btn', onclick: () => editSheet(m) }, 'Bearbeiten')));
}

/* ================= ALLTAG ================= */

const MOMENT_MODES = [{ id: false, label: 'Ein Tag' }, { id: true, label: 'Zeitspanne' }];
// Fill in a name for an illness if none was typed.
const withSickTitle = (title, mode) => (mode === 'sick' && !title.trim() ? 'Krank' : title);
const momentEndMax = () => addDays(todayKey(), 365);   // a period may have a planned end (holiday until Friday)

// Validation shared by all activity forms. Returns an error text or ''.
function momentError({ title, date, span, end }) {
  if (!title.trim()) return 'Bitte gib der Aktivität einen Namen.';
  if (!date || date > todayKey()) return span ? 'Bitte wähle einen Beginn bis heute.' : 'Bitte wähle einen Tag bis heute.';
  if (span && end && end < date) return 'Das Ende kann nicht vor dem Beginn liegen.';
  if (span && end && end > momentEndMax()) return 'Das Ende darf höchstens ein Jahr in der Zukunft liegen.';
  return '';
}

// "12. Aug – 3. Sept", "seit 3.9.26" …
function momentDateLabel(m) {
  if (!m.span) return relativeDay(m.date);
  if (m.end == null) return `seit ${formatShort(m.date)}`;
  if (m.end === m.date) return formatShort(m.date);
  return `${formatDayMonth(m.date)} – ${formatDayMonth(m.end)}`;
}

// Switch between "Ein Tag" and "Zeitspanne" in the edit form.
function momentModeSwitch(el, span, onChange) {
  el.replaceChildren(...MOMENT_MODES.map(mode => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(mode.id === span),
    onclick: () => { if (mode.id !== span) onChange(mode.id); },
  }, mode.label)));
}

const momentCss = (colors, title) => `var(--c${(colors.get(title.toLowerCase()) ?? 0) + 1})`;
// Color mark for an entry: illness gets the red stripes, everything else its own color.
const momentMark = (colors, m, cls = m.span ? 'key-bar' : 'key-dot') => (m.sick
  ? h('span', { class: `${cls} key-sick` })
  : h('span', { class: cls, style: { background: momentCss(colors, m.title) } }));

const hbarRow = (label, data, cls, color) => h('div', { class: 'hbar' },
  h('span', { class: 'hbar-label' }, label),
  h('div', { class: 'hbar-track' }, data.avg != null ? h('div', { class: `hbar-fill ${cls}`, style: { width: `${((data.avg - 1) / 4) * 100}%`, ...(color ? { background: color } : {}) } }) : null),
  h('span', { class: 'hbar-value' }, data.avg == null ? '–' : num1(data.avg), h('small', null, `${data.days} Tage`)));

function renderAlltag() {
  const moments = store.getState().moments;
  const colors = store.momentColors();

  // periods running now (incl. illness)
  const running = moments.filter(m => m.span && !m.archived && store.momentRunning(m)).sort((a, b) => Number(!!b.sick) - Number(!!a.sick) || a.date.localeCompare(b.date));
  $('#alltag-running-card').hidden = !running.length;
  $('#alltag-running').replaceChildren(...running.map(m => endablePeriod(m, colors)));

  // activities: one row per name
  const acts = store.momentActivities();
  const row = a => {
    const key = a.title.toLowerCase();
    const list = moments.filter(m => !m.sick && m.title.toLowerCase() === key);
    const span = list.some(m => m.span);
    const run = list.find(m => m.span && !m.archived && store.momentRunning(m));
    return h('button', { type: 'button', class: 'activity-row', onclick: () => activitySheet(a.title) },
      h('span', { class: span ? 'key-bar' : 'key-dot', style: { background: momentCss(colors, a.title) } }),
      h('span', { class: 'activity-main' },
        h('span', { class: 'activity-name' }, a.title),
        h('small', null, run ? `läuft seit ${formatShort(run.date)}` : span && a.n === 1 ? `Zeitspanne · ${momentDateLabel(list[0])}` : `${a.n}× · zuletzt ${relativeDay(a.last)}`)),
      s('svg', { viewBox: '0 0 24 24', class: 'chevron-right', 'aria-hidden': 'true' }, s('path', { d: 'M9 6l6 6-6 6', fill: 'none', stroke: 'currentColor', 'stroke-width': '2', 'stroke-linecap': 'round', 'stroke-linejoin': 'round' })));
  };
  const active = acts.filter(a => !a.archived), archived = acts.filter(a => a.archived);
  $('#activity-list').replaceChildren(...(active.length ? active.map(row)
    : [h('p', { class: 'empty-text' }, archived.length ? 'Alles ist archiviert.' : 'Noch keine Aktivitäten. Tippe sie auf „Heute“ an oder lege unten eine Zeitspanne an.')]));
  const archive = archiveSection('acts', archived.length, archived.map(row));
  $('#activity-archive').replaceChildren(...(archive ? [archive] : []));

  renderSickStatus();
}

// Everything about one activity: mood with/without, all its entries, add for a day, archive.
function activitySheet(title) {
  const key = title.toLowerCase();
  const today = todayKey();
  const colors = store.momentColors();
  const color = momentCss(colors, title);
  const list = store.getState().moments.filter(m => !m.sick && m.title.toLowerCase() === key)
    .sort((a, b) => store.momentLast(b).localeCompare(store.momentLast(a)));
  if (!list.length) { closeSheet(); return; }
  const archived = list.every(m => m.archived);
  const c = store.momentComparison(title, store.firstDataDate() ?? today, today);
  let hint;
  if (c.with.days < 3) hint = 'Noch zu wenige Tage mit Stimmungseintrag.';
  else if (c.without.days < 3) hint = 'Kaum Vergleichstage ohne.';
  else hint = h('span', null, 'Unterschied ', deltaEl(c.with.avg - c.without.avg), ' an Tagen damit.');

  const date = h('input', { id: 'act-date', type: 'date', value: today, max: today, required: true });
  // Periods: once the last one has ended, a new one can be started right here.
  const spans = list.filter(m => m.span);
  const runningSpan = spans.find(m => !m.archived && store.momentRunning(m));
  const onlySpans = spans.length === list.length;
  const restart = spans.length && !runningSpan ? (() => {
    const from = h('input', { id: 'act-span-from', type: 'date', value: today, max: today, required: true });
    const to = h('input', { id: 'act-span-to', type: 'date', min: today, max: momentEndMax() });
    const note = h('input', { id: 'act-span-note', type: 'text', maxlength: 500, autocomplete: 'off', placeholder: 'optional' });
    from.addEventListener('change', () => { to.min = from.value; });
    const err = h('p', { class: 'form-error', hidden: true });
    return h('form', { class: 'sheet-section', onsubmit: e => {
      e.preventDefault();
      const values = { title, date: from.value, end: to.value || null, note: note.value, span: true };
      const msg = momentError(values);
      if (msg) { err.textContent = msg; err.hidden = false; return; }
      store.addMoment(values);
      toast(`${title}: neue Zeitspanne ab ${formatDayMonth(from.value)}`);
      activitySheet(title);
    } },
    h('h3', null, 'Neue Zeitspanne starten'),
    h('p', { class: 'sheet-text' }, `Die letzte ging ${momentDateLabel(spans[0])}.`),
    h('div', { class: 'field-row' }, field('Von', from), field('Bis (leer = läuft noch)', to)),
    field('Notiz', note), err,
    h('div', { class: 'sheet-actions start' }, h('button', { type: 'submit', class: 'btn primary' }, 'Starten')));
  })() : null;
  const entryRow = m => {
    const mood = momentMood(m);
    return h('button', { type: 'button', class: 'other-row', onclick: () => editMomentSheet(m) },
      h('span', { class: 'other-date' }, momentDateLabel(m)),
      h('span', { class: 'other-main' },
        h('span', { class: 'other-title' }, m.span ? 'Zeitspanne' : 'Tag', !m.archived && store.momentRunning(m) ? h('span', { class: 'chip running' }, 'läuft') : null),
        m.note ? h('span', { class: 'other-note' }, m.note) : null),
      mood != null ? h('span', { class: 'other-mood', style: { background: store.moodColor(Math.round(mood * 10) / 10) } }, num1(mood)) : null);
  };

  // Periods: 4 weeks before, during (so far) and up to 4 weeks after, for each period (newest first).
  const spanBlock = m => {
    const e = store.spanEffect(m);
    const rows = [hbarRow('Davor', e.before, 'without'), hbarRow(e.ended ? 'Während' : 'Bisher', e.during, 'with moment', color)];
    if (e.ended) rows.push(hbarRow('Danach', e.after, 'without'));
    let note;
    if (!e.started) note = `Beginnt am ${formatDayMonth(m.date)}.`;
    else if (e.before.days < 3) note = 'Zu wenige Einträge in den 4 Wochen davor für einen Vergleich.';
    else if (e.during.days < 3) note = 'Noch zu wenige Tage mit Stimmungseintrag in dieser Zeit.';
    else note = h('span', null, e.ended ? 'Währenddessen ' : 'Bisher ', deltaEl(e.during.avg - e.before.avg), ' im Vergleich zu den 4 Wochen davor.');
    return h('section', { class: 'compare-block' },
      h('h3', null, h('span', { class: 'med-swatch moment span', style: { background: color } }), momentDateLabel(m), store.momentRunning(m) && !m.archived ? h('span', { class: 'chip running' }, 'läuft') : null),
      h('div', { class: 'compare-rows' }, ...rows),
      h('p', { class: 'compare-hint' }, note));
  };
  const hasDays = list.some(m => !m.span);

  openSheet(title,
    ...list.filter(m => m.span).slice(0, 3).map(spanBlock),
    hasDays ? h('section', { class: 'compare-block' },
      h('div', { class: 'compare-rows' }, hbarRow('Mit', c.with, 'with moment', color), hbarRow('Ohne', c.without, 'without')),
      h('p', { class: 'compare-hint' }, hint)) : null,
    runningSpan ? h('p', { class: 'sheet-text act-running' }, h('span', { class: 'chip running' }, 'läuft'), ` seit ${formatShort(runningSpan.date)}. Beenden kannst du sie unter „Läuft gerade“ oder in der Liste unten.`) : null,
    restart,
    onlySpans ? null : h('form', { class: 'sheet-section act-add', onsubmit: e => {
      e.preventDefault();
      if (!date.value || date.value > today) return;
      if (list.some(m => !m.span && !m.archived && m.date === date.value)) { toast('An diesem Tag schon eingetragen'); return; }
      store.addMoment({ date: date.value, title });
      toast(`${title} am ${formatDayMonth(date.value)} eingetragen`);
      activitySheet(title);
    } },
    h('h3', null, 'Für einen Tag nachtragen'),
    h('div', { class: 'day-add' }, date, h('button', { type: 'submit', class: 'btn' }, 'Eintragen'))),
    h('section', { class: 'sheet-section' },
      h('h3', null, `Einträge · ${list.length}`),
      h('div', { class: 'other-list' }, ...list.slice(0, 60).map(entryRow))),
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: () => {
        store.archiveActivity(title, !archived);
        closeSheet();
        toast(archived ? `${title} aus dem Archiv geholt` : `${title} archiviert`);
      } }, archived ? 'Wiederherstellen' : 'Archivieren')));
}

// A period such as a holiday or a course: name, from, to (empty = still going), note.
function newSpanSheet() {
  const today = todayKey();
  const names = store.momentActivities().filter(a => !a.archived).map(a => a.title);
  const title = h('input', { id: 'span-title', type: 'text', maxlength: 80, placeholder: 'z. B. Urlaub, Yogakurs, neuer Job', list: 'span-names', required: true, autocomplete: 'off' });
  const from = h('input', { id: 'span-from', type: 'date', value: today, max: today, required: true });
  const to = h('input', { id: 'span-to', type: 'date', min: today, max: momentEndMax() });
  const note = h('input', { id: 'span-note', type: 'text', maxlength: 500, autocomplete: 'off' });
  from.addEventListener('change', () => { to.min = from.value; });
  const err = h('p', { class: 'form-error', hidden: true });
  openSheet('Zeitspanne anlegen', h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    const values = { title: title.value, date: from.value, end: to.value || null, note: note.value, span: true };
    const msg = momentError(values);
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    store.addMoment(values);
    closeSheet();
    toast(`${values.title.trim()} angelegt`);
  } },
  h('p', { class: 'sheet-text' }, 'Für etwas über mehrere Tage, z. B. einen Urlaub oder einen Kurs. Ohne Ende läuft die Zeitspanne weiter, bis du sie beendest.'),
  field('Name', title),
  h('datalist', { id: 'span-names' }, ...names.map(n => h('option', { value: n }))),
  h('div', { class: 'field-row' }, field('Von', from), field('Bis (leer = läuft noch)', to)),
  field('Notiz (optional)', note), err,
  h('div', { class: 'sheet-actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Anlegen'))));
}

// Mood shown next to an entry: the day's average, or the average over a period so far.
function momentMood(m) {
  if (!m.span) return store.dayAverage(m.date);
  if (m.date > todayKey()) return null;
  const last = store.momentLast(m) < todayKey() ? store.momentLast(m) : todayKey();
  return store.windowAverage(m.date, last).avg;
}

function editMomentSheet(m, span = m.sick ? 'sick' : !!m.span) {
  const title = h('input', { id: 'edit-other-title', type: 'text', value: m.title, maxlength: 80, required: true, autocomplete: 'off' });
  const date = h('input', { id: 'edit-other-date', type: 'date', value: m.date, max: todayKey(), required: true });
  const end = h('input', { id: 'edit-other-end', type: 'date', value: m.span ? m.end ?? '' : '', min: m.date, max: momentEndMax() });
  const note = h('input', { id: 'edit-other-note', type: 'text', value: m.note, maxlength: 500, autocomplete: 'off' });
  date.addEventListener('change', () => { end.min = date.value; });
  const err = h('p', { class: 'form-error', hidden: true });
  // Switching keeps what was typed.
  const modeSwitch = h('div', { class: 'segmented kind-switch', role: 'radiogroup', 'aria-label': 'Dauer' });
  if (span === 'sick') { title.required = false; title.placeholder = 'z. B. Grippe (leer = „Krank“)'; }
  else momentModeSwitch(modeSwitch, span, next => editMomentSheet({ ...m, title: title.value, date: date.value, note: note.value, span: !!next, end: end.value || null }, next));
  const running = span && m.id && store.momentRunning(store.getState().moments.find(x => x.id === m.id) ?? {});
  openSheet(span === 'sick' ? 'Krankheit bearbeiten' : 'Eintrag bearbeiten', h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    const values = { title: withSickTitle(title.value, span), date: date.value, note: note.value, span: !!span, sick: span === 'sick', end: span ? end.value || null : null };
    const msg = momentError(values);
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    store.updateMoment(m.id, values);
    closeSheet();
    toast('Änderung gespeichert');
  } },
  span === 'sick' ? null : modeSwitch,
  field(span === 'sick' ? 'Name (optional)' : 'Eintrag', title),
  span ? h('div', { class: 'field-row' }, field('Von', date), field('Bis (leer = läuft noch)', end)) : field('Tag', date),
  field('Notiz', note), err,
  running ? h('button', { type: 'button', class: 'btn', onclick: () => { store.endMoment(m.id, todayKey()); closeSheet(); toast(`${m.title} heute beendet`); } }, 'Heute beenden') : null,
  h('div', { class: 'sheet-actions' },
    armedButton('Löschen', 'Wirklich löschen? Nochmal tippen', () => { store.deleteMoment(m.id); closeSheet(); toast('Eintrag gelöscht'); }),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => {
      store.archiveMoment(m.id, !m.archived);
      closeSheet();
      toast(m.archived ? 'Aus dem Archiv geholt' : 'Archiviert');
    } }, m.archived ? 'Wiederherstellen' : 'Archivieren'),
    h('button', { type: 'submit', class: 'btn primary' }, 'Speichern'))));
}

/* ---------- medication sheets ---------- */

function dateInputEl(id, value, { min, max } = {}) {
  const el = h('input', { type: 'date', id, value, min, max: max ?? todayKey(), required: true });
  return el;
}

function addMedSheet(kind = 'med') {
  const t = TERMS[kind];
  const name = h('input', { id: 'med-name', type: 'text', placeholder: t.namePh, maxlength: 60, required: true, autocomplete: 'off' });
  const dose = h('input', { id: 'med-dose', type: 'text', placeholder: t.dosePh, maxlength: 60, autocomplete: 'off' });
  const start = dateInputEl('med-start', todayKey(), { max: maxDateFor(kind) });
  const err = h('p', { class: 'form-error', hidden: true });
  // Switching the kind keeps what was typed and only changes labels and hints.
  const kindSwitch = h('div', { class: 'segmented kind-switch', role: 'radiogroup', 'aria-label': 'Art' },
    ...Object.entries(TERMS).map(([k, v]) => h('button', {
      type: 'button', role: 'radio', 'aria-checked': String(k === kind),
      onclick: () => {
        if (k === kind) return;
        const keep = { name: name.value, dose: dose.value, start: start.value };
        addMedSheet(k);
        $('#med-name').value = keep.name; $('#med-dose').value = keep.dose;
        // A planned (future) start isn't possible for medications: fall back to today.
        $('#med-start').value = keep.start > maxDateFor(k) ? todayKey() : keep.start;
      },
    }, v.kind)));
  const f = h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) { err.textContent = 'Bitte gib einen Namen ein.'; err.hidden = false; return; }
    if (!start.value) { err.textContent = 'Bitte wähle ein Startdatum.'; err.hidden = false; return; }
    if (start.value > maxDateFor(kind)) {
      err.textContent = kind === 'therapy' ? 'Der Beginn darf höchstens zwei Jahre in der Zukunft liegen.' : 'Bei Medikamenten geht das Startdatum nur bis heute.';
      err.hidden = false; return;
    }
    store.addMed({ name: name.value, dose: dose.value, start: start.value, kind });
    closeSheet();
    toast(`${name.value.trim()} hinzugefügt`);
  } },
  kindSwitch,
  field('Name', name),
  h('div', { class: 'field-row' }, field(t.dose, dose), field(t.since, start)),
  h('p', { class: 'sheet-text' }, t.startHint),
  err,
  h('div', { class: 'sheet-actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Hinzufügen')));
  openSheet(`${t.kind} hinzufügen`, f);
  setTimeout(() => name.focus(), 50);
}

function doseSheet(med, restart = false) {
  const open = store.openPhase(med);
  const last = store.lastPhase(med);
  const min = restart ? addDays(last.end, 1) : open.start;
  const t = T(med);
  const dose = h('input', { id: 'dose-new', type: 'text', value: restart ? last.dose : '', placeholder: t.newDosePh, maxlength: 60, autocomplete: 'off' });
  const date = dateInputEl('dose-date', todayKey() < min ? min : todayKey(), { min, max: maxDateFor(med.kind) });
  const f = h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    if (!date.value || date.value < min || date.value > maxDateFor(med.kind)) return;
    store.changeDose(med.id, dose.value, date.value);
    closeSheet();
    toast(restart ? t.restartToast(med.name) : t.doseToast);
  } },
  restart ? null : h('p', { class: 'sheet-text' }, `Aktuell: ${open.dose || t.noDose.toLowerCase()} seit ${formatShort(open.start)}.`),
  h('div', { class: 'field-row' }, field(restart ? t.dose : t.newDose, dose), field(restart ? 'Wieder ab' : 'Gilt ab', date)),
  h('div', { class: 'sheet-actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
  openSheet(restart ? t.restartTitle(med.name) : t.doseTitle(med.name), f);
  setTimeout(() => dose.focus(), 50);
}

function stopSheet(med) {
  const open = store.openPhase(med);
  const date = dateInputEl('stop-date', todayKey(), { min: open.start, max: maxDateFor(med.kind) });
  const f = h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    if (!date.value) return;
    store.stopMed(med.id, date.value);
    closeSheet();
    toast(date.value > todayKey() ? `${med.name} endet am ${formatDayMonth(date.value)}` : T(med).stopToast(med.name));
  } },
  field(T(med).lastDay, date),
  h('p', { class: 'sheet-text' }, T(med).stopText),
  h('div', { class: 'sheet-actions' }, h('button', { type: 'submit', class: 'btn primary' }, T(med).stop)));
  openSheet(T(med).stopTitle(med.name), f);
}

function editSheet(med) {
  const name = h('input', { id: 'edit-name', type: 'text', value: med.name, maxlength: 60, required: true, autocomplete: 'off' });
  const phases = med.phases.map(p => ({ ...p }));
  const list = h('div', { class: 'phase-list' });
  const err = h('p', { class: 'form-error', hidden: true });

  const renderPhases = () => {
    list.replaceChildren(...phases.map((p, i) => {
      const dose = h('input', { type: 'text', id: `ph-dose-${i}`, value: p.dose, maxlength: 60, placeholder: T(med).dose, oninput: e => { p.dose = e.target.value; } });
      const start = h('input', { type: 'date', id: `ph-start-${i}`, value: p.start, max: maxDateFor(med.kind), oninput: e => { p.start = e.target.value; } });
      const end = h('input', { type: 'date', id: `ph-end-${i}`, value: p.end ?? '', max: maxDateFor(med.kind), oninput: e => { p.end = e.target.value || null; } });
      return h('div', { class: 'phase' },
        field(T(med).dose, dose, 'dose'),
        field('Von', start),
        field('Bis', end),
        phases.length > 1 ? h('button', { type: 'button', class: 'btn small ghost danger remove', onclick: () => { phases.splice(i, 1); renderPhases(); } }, 'Zeitraum entfernen') : null);
    }));
  };
  renderPhases();

  const f = h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) { err.textContent = 'Bitte gib einen Namen ein.'; err.hidden = false; return; }
    const msg = store.validatePhases(phases)
      ?? (phases.some(p => p.start > maxDateFor(med.kind) || (p.end && p.end > maxDateFor(med.kind)))
        ? (med.kind === 'therapy' ? 'Daten dürfen höchstens zwei Jahre in der Zukunft liegen.' : 'Bei Medikamenten gehen die Daten nur bis heute.')
        : null);
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    store.updateMed(med.id, { name: name.value, phases });
    closeSheet();
    toast('Änderungen gespeichert');
  } },
  field('Name', name),
  h('div', { class: 'field' }, h('span', { class: 'label' }, T(med).periods), list,
    h('p', { class: 'sheet-text' }, T(med).stillHint)),
  h('button', { type: 'button', class: 'btn dashed', onclick: () => {
    const lastP = phases[phases.length - 1];
    const startNew = lastP?.end ? addDays(lastP.end, 1) : todayKey();
    if (lastP && !lastP.end) lastP.end = addDays(todayKey(), -1) < lastP.start ? lastP.start : addDays(todayKey(), -1);
    phases.push({ dose: lastP?.dose ?? '', start: startNew > todayKey() ? todayKey() : startNew, end: null });
    renderPhases();
  } }, icon('i-plus'), 'Zeitraum hinzufügen'),
  err,
  h('div', { class: 'sheet-actions' },
    armedButton(T(med).del, 'Wirklich löschen? Nochmal tippen', () => { store.deleteMed(med.id); closeSheet(); toast(`${med.name} gelöscht`); }),
    h('button', { type: 'button', class: 'btn ghost', onclick: () => {
      store.archiveMed(med.id, !med.archived);
      closeSheet();
      toast(med.archived ? `${med.name} aus dem Archiv geholt` : `${med.name} archiviert`);
    } }, med.archived ? 'Wiederherstellen' : 'Archivieren'),
    h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
  openSheet(`${med.name} bearbeiten`, f);
}

/* ================= SETTINGS / DATA ================= */

async function deliverFile(filename, text, mime) {
  const blob = new Blob([text], { type: mime });
  const file = typeof File === 'function' ? new File([blob], filename, { type: mime }) : null;
  // On phones, the share sheet lets you save to Files, iCloud or send it to yourself.
  if (file && navigator.canShare?.({ files: [file] }) && matchMedia('(pointer: coarse)').matches) {
    try {
      await navigator.share({ files: [file], title: filename });
      return true;
    } catch (e) {
      if (e.name === 'AbortError') return false;
    }
  }
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: filename });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 2000);
  return true;
}

let installPrompt = null;
window.addEventListener('beforeinstallprompt', e => { e.preventDefault(); installPrompt = e; });

function settingsSheet() {
  const st = store.getState();
  const last = st.settings.lastBackup;
  const fileInput = h('input', { type: 'file', id: 'import-file', accept: 'application/json,.json', hidden: true });
  fileInput.addEventListener('change', async () => {
    const file = fileInput.files?.[0];
    if (!file) return;
    const text = await file.text();
    confirmImport(text);
  });

  const stamp = todayKey();
  openSheet('Deine Daten',
    h('p', { class: 'sheet-text' }, sync.isEnabled()
      ? 'Deine Einträge liegen auf diesem Gerät und werden mit deinem Konto abgeglichen. Auf dem Server sind sie verschlüsselt gespeichert.'
      : 'Alles, was du einträgst, bleibt nur in diesem Browser auf diesem Gerät. Es wird nichts an einen Server geschickt.'),
    h('dl', { class: 'info-list' },
      h('dt', null, 'Einträge'), h('dd', null, String(st.entries.length)),
      h('dt', null, 'Medikamente & Therapien'), h('dd', null, String(st.meds.length)),
      h('dt', null, 'Aktivitäten'), h('dd', null, String(st.moments.length)),
      h('dt', null, 'Letzte Sicherung'), h('dd', null, last ? formatShort(last.slice(0, 10)) : 'noch nie')),

    remindersSection(),
    syncSection(),

    h('section', { class: 'sheet-section' },
      h('h3', null, 'Sichern'),
      h('p', { class: 'sheet-text' }, 'Wenn Browserdaten gelöscht werden, sind auch deine Einträge weg. Lade ab und zu eine Sicherung herunter, zum Beispiel in iCloud oder Dateien.'),
      h('button', { type: 'button', class: 'btn', onclick: async () => {
        const ok = await deliverFile(`motra-sicherung-${stamp}.json`, store.exportJSON(), 'application/json');
        if (ok) { store.markBackup(); toast('Sicherung erstellt'); settingsSheet(); }
      } }, 'Sicherung herunterladen'),
      h('button', { type: 'button', class: 'btn', onclick: () => fileInput.click() }, 'Sicherung wiederherstellen'),
      fileInput),

    h('section', { class: 'sheet-section' },
      h('h3', null, 'Für den Arzttermin'),
      h('p', { class: 'sheet-text' }, 'Eine Tabelle mit allen Einträgen und den Medikamenten und Therapien des jeweiligen Tages. Sie öffnet sich in Excel, Numbers oder Google Tabellen.'),
      h('button', { type: 'button', class: 'btn', onclick: async () => {
        if (await deliverFile(`motra-tabelle-${stamp}.csv`, store.exportCSV(), 'text/csv')) toast('Tabelle erstellt');
      } }, 'Als Tabelle exportieren (CSV)')),

    h('section', { class: 'sheet-section' },
      h('h3', null, 'Aufs Handy legen'),
      installPrompt
        ? h('button', { type: 'button', class: 'btn', onclick: async () => { installPrompt.prompt(); installPrompt = null; closeSheet(); } }, 'App installieren')
        : h('ul', { class: 'howto' },
          h('li', null, 'iPhone: in Safari auf Teilen tippen, dann „Zum Home-Bildschirm“.'),
          h('li', null, 'Android: im Chrome-Menü „App installieren“ wählen.')),
      h('p', { class: 'sheet-text' }, 'Als App vom Home-Bildschirm startet Motra schneller, funktioniert offline und der Browser behält deine Daten zuverlässiger.')),

    h('section', { class: 'sheet-section' },
      h('h3', null, 'Ausprobieren'),
      store.hasDemo()
        ? h('button', { type: 'button', class: 'btn', onclick: () => { store.removeDemo(); closeSheet(); toast('Beispieldaten entfernt'); } }, 'Beispieldaten entfernen')
        : h('button', { type: 'button', class: 'btn', onclick: () => { store.loadDemo(); closeSheet(); toast('Beispieldaten geladen'); } }, 'Beispieldaten laden'),
      h('p', { class: 'sheet-text' }, 'Beispieldaten zeigen, wie die Grafiken nach ein paar Monaten aussehen. Deine eigenen Einträge bleiben dabei erhalten und werden beim Entfernen nicht gelöscht.')),

    h('section', { class: 'sheet-section' },
      h('h3', null, 'Alles löschen'),
      sync.isEnabled()
        ? h('p', { class: 'sheet-text' }, 'Löscht die Daten auf diesem Gerät und beendet hier die Synchronisierung. Auf dem Server und deinen anderen Geräten bleiben sie erhalten.')
        : null,
      armedButton('Alle Daten löschen', 'Wirklich alles löschen? Nochmal tippen', async () => {
        if (sync.isEnabled()) await sync.disable();
        store.wipeAll(); closeSheet(); toast('Alle Daten gelöscht');
      }, 'btn danger')),
  );
}

function confirmImport(text) {
  let preview;
  try { preview = store.normalize(JSON.parse(text)); } catch (e) {
    openSheet('Sicherung wiederherstellen',
      h('p', { class: 'form-error' }, 'Die Datei konnte nicht gelesen werden. Wähle eine Sicherung, die du in Motra oder früher in Sutra heruntergeladen hast (.json).'),
      h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: settingsSheet }, 'Zurück')));
    return;
  }
  const cur = store.getState();
  openSheet('Sicherung wiederherstellen',
    h('p', { class: 'sheet-text' }, `Die Sicherung enthält ${preview.entries.length} Einträge und ${preview.meds.length} Medikamente oder Therapien.`),
    cur.entries.length || cur.meds.length
      ? h('p', { class: 'sheet-text' }, `Sie ersetzt deine aktuellen Daten (${cur.entries.length} Einträge, ${cur.meds.length} Medikamente oder Therapien).`)
      : null,
    h('div', { class: 'sheet-actions' },
      h('button', { type: 'button', class: 'btn ghost', onclick: settingsSheet }, 'Abbrechen'),
      h('button', { type: 'button', class: 'btn primary', onclick: () => {
        try {
          const r = store.importJSON(text);
          closeSheet();
          form.date = todayKey();
          loadFormEntry();
          toast(`${r.entries} Einträge wiederhergestellt`);
        } catch (e) { toast(e.message); }
      } }, 'Wiederherstellen')));
}

$('#btn-settings').addEventListener('click', settingsSheet);
$('#btn-add-med').addEventListener('click', () => addMedSheet(prefs.kindFilter === 'therapy' ? 'therapy' : 'med'));
$('#btn-new-span').addEventListener('click', newSpanSheet);
$('#zoom-reset').addEventListener('click', () => { zoom = null; renderVerlauf(); });
$('#btn-sick').addEventListener('click', sickSheet);
$('#btn-im-sick').addEventListener('click', () => {
  store.addMoment({ date: todayKey(), title: 'Krank', span: true, sick: true });
  toast('Krank seit heute eingetragen. Gute Besserung!');
});
$('#btn-note').addEventListener('click', () => showNote(true));
$('#day-add-btn').addEventListener('click', addDayActivity);
$('#day-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addDayActivity(); } });
$('#btn-more-entries').addEventListener('click', () => { listDays += 14; renderEntryList(); });

/* ---------------- reminders ---------------- */

const SLOT_NAMES = { morning: 'Morgen', noon: 'Mittag', evening: 'Abend' };

// The "Erinnerungen" part of the settings sheet.
function remindersSection() {
  const box = h('section', { class: 'sheet-section', id: 'reminders-section' }, h('h3', null, 'Erinnerungen'));
  const state = push.support();
  if (state === 'install') {
    box.append(h('p', { class: 'sheet-text' }, 'Auf dem iPhone und iPad gibt es Erinnerungen nur, wenn Motra auf dem Home-Bildschirm liegt: in Safari auf Teilen tippen, „Zum Home-Bildschirm“ wählen und Motra dann von dort öffnen.'));
    return box;
  }
  if (state === 'unsupported') {
    box.append(h('p', { class: 'sheet-text' }, 'Dieser Browser kann keine Mitteilungen anzeigen.'));
    return box;
  }
  if (state === 'denied') {
    box.append(h('p', { class: 'sheet-text' }, 'Mitteilungen sind für Motra blockiert. Erlaube sie in den Einstellungen deines Geräts (iPhone: Einstellungen → Mitteilungen → Motra) und öffne Motra danach neu.'));
    return box;
  }

  const conf = push.settings();
  const rows = Object.keys(SLOT_NAMES).map(slot => {
    const check = h('input', { type: 'checkbox', id: `rem-on-${slot}`, checked: !conf.off.includes(slot) });
    const time = h('input', { type: 'time', id: `rem-time-${slot}`, value: conf.times[slot] || push.DEFAULT_TIMES[slot], step: 300 });
    return { slot, check, time, el: h('div', { class: 'reminder-row' },
      h('label', { class: 'reminder-toggle', for: check.id }, check, h('span', null, SLOT_NAMES[slot])), time) };
  });
  const collect = () => ({
    times: Object.fromEntries(rows.map(r => [r.slot, r.time.value || push.DEFAULT_TIMES[r.slot]])),
    off: rows.filter(r => !r.check.checked).map(r => r.slot),
  });
  const err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
  const showError = msg => { err.textContent = msg; err.hidden = false; };
  let saveTimer;
  for (const r of rows) {
    const changed = () => {
      r.time.disabled = !r.check.checked;
      clearTimeout(saveTimer);
      saveTimer = setTimeout(async () => {
        err.hidden = true;
        const { times, off } = collect();
        try { await push.setTimes(times, off); if (push.isEnabled()) toast('Erinnerungen gespeichert'); } catch (e) { showError('Speichern hat nicht geklappt. Bist du online?'); }
      }, 500);
    };
    r.check.addEventListener('change', changed);
    r.time.addEventListener('change', changed);
    r.time.disabled = !r.check.checked;
  }

  const text = h('p', { class: 'sheet-text' }, push.isEnabled()
    ? 'Aktiv auf diesem Gerät. Hast du eine Tageszeit schon eingetragen, kommt dafür keine Erinnerung.'
    : 'Motra erinnert dich zu deinen Zeiten an den Eintrag, auch wenn die App geschlossen ist. Hast du schon eingetragen, kommt keine Erinnerung.');
  box.append(text, h('div', { class: 'reminder-rows' }, ...rows.map(r => r.el)), err);

  const busy = async (btn, label, fn) => {
    btn.disabled = true; const old = btn.textContent; btn.textContent = label;
    try { await fn(); } finally { if (btn.isConnected) { btn.disabled = false; btn.textContent = old; } }
  };
  if (push.isEnabled()) {
    const testBtn = h('button', { type: 'button', class: 'btn' }, 'Test-Mitteilung senden');
    testBtn.addEventListener('click', () => busy(testBtn, 'Sendet …', async () => {
      err.hidden = true;
      try { await push.sendTest(); toast('Test-Mitteilung gesendet'); } catch (e) {
        showError(e.status === 429 ? 'Genug getestet für den Moment. Versuch es in ein paar Minuten wieder.' : 'Die Test-Mitteilung konnte nicht gesendet werden.');
      }
    }));
    box.append(testBtn, h('button', { type: 'button', class: 'btn ghost danger', onclick: async () => {
      await push.disable(); toast('Erinnerungen ausgeschaltet'); settingsSheet();
    } }, 'Erinnerungen ausschalten'));
  } else {
    const onBtn = h('button', { type: 'button', class: 'btn', disabled: true }, 'Erinnerungen einschalten');
    // Check for the server now, so the tap can go straight to the permission prompt.
    push.serverAvailable().then(ok => {
      if (ok) onBtn.disabled = false;
      else showError('An dieser Adresse gibt es keinen Motra-Server. Öffne Motra über deine Cloudflare-Adresse.');
    });
    onBtn.addEventListener('click', () => busy(onBtn, 'Einen Moment …', async () => {
      err.hidden = true;
      const { times, off } = collect();
      push.setTimes(times, off); // only stores locally while reminders are off
      try {
        await push.enable();
        toast('Erinnerungen sind an');
        settingsSheet();
      } catch (e) {
        if (e.code === 'denied') settingsSheet();
        else if (e.code === 'default') showError('Ohne deine Erlaubnis kann Motra keine Mitteilungen zeigen.');
        else showError('Das Einschalten hat nicht geklappt. Bist du online?');
      }
    }));
    box.append(onBtn);
  }
  return box;
}

// Opening Motra from a reminder: jump to that day and time of day.
function openFromReminder(slot, date) {
  if (!store.SLOT_IDS.includes(slot)) return;
  const day = /^\d{4}-\d{2}-\d{2}$/.test(date || '') && date <= todayKey() ? date : todayKey();
  if (form.dirty) return;
  form.date = day;
  form.slot = slot;
  form.touched = true;
  loadFormEntry();
  if (location.hash !== '#heute') location.hash = '#heute'; else renderView();
}

/* ---------------- sync settings & login ---------------- */

function relativeTime(iso) {
  if (!iso) return 'noch nie';
  const min = Math.round((Date.now() - new Date(iso)) / 60000);
  if (min < 1) return 'gerade eben';
  if (min < 60) return `vor ${min} Min.`;
  if (min < 24 * 60) return `vor ${Math.round(min / 60)} Std.`;
  return formatShort(iso.slice(0, 10));
}

const SYNC_STATUS = {
  idle: 'Aktiv',
  syncing: 'Gleicht ab …',
  offline: 'Offline, gleicht ab, sobald Internet da ist',
  error: 'Fehler beim Abgleich, versucht es später erneut',
  loggedout: 'Abgemeldet, bitte neu anmelden',
};

// The "Synchronisierung" part of the settings sheet. Fills in once the server answered.
function syncSection() {
  const box = h('section', { class: 'sheet-section', id: 'sync-section' }, h('h3', null, 'Synchronisierung'));
  const info = sync.info();
  if (info.enabled) {
    const statusEl = h('dd', { id: 'sync-status' }, SYNC_STATUS[info.status] ?? '');
    const lastEl = h('dd', { id: 'sync-last' }, relativeTime(info.lastSync));
    box.append(
      h('dl', { class: 'info-list' },
        h('dt', null, 'Konto'), h('dd', null, info.email),
        h('dt', null, 'Status'), statusEl,
        h('dt', null, 'Zuletzt abgeglichen'), lastEl),
      info.status === 'loggedout'
        ? h('button', { type: 'button', class: 'btn', onclick: () => syncLoginSheet(info.email) }, 'Erneut anmelden')
        : h('button', { type: 'button', class: 'btn', onclick: async () => { await sync.syncNow(); if (sync.info().status === 'idle') toast('Abgeglichen'); } }, 'Jetzt abgleichen'),
      armedButton('Auf diesem Gerät abmelden', 'Wirklich abmelden? Nochmal tippen', async () => {
        await sync.disable();
        toast('Abgemeldet. Deine Daten bleiben auf diesem Gerät.');
        settingsSheet();
      }, 'btn ghost danger'),
    );
    return box;
  }
  const text = h('p', { class: 'sheet-text' }, 'Prüfe die Verbindung …');
  box.append(text);
  sync.serverStatus().then(s => {
    if (s.configured) {
      text.textContent = 'Gleiche deine Einträge zwischen deinen Geräten ab, zum Beispiel iPhone und iPad. Anmeldung mit Passwort und Code aus einer Authenticator-App.';
      box.append(h('button', { type: 'button', class: 'btn', onclick: () => syncLoginSheet() }, 'Synchronisierung einrichten'));
    } else if (s.configured === false) {
      text.textContent = 'Der Sync-Server ist noch nicht fertig eingerichtet. '
        + (s.missing?.length ? `In Cloudflare fehlt: ${s.missing.join(', ')}.` : 'Es fehlen Einstellungen in Cloudflare.');
    } else if (s.offline) {
      text.textContent = 'Keine Verbindung. Zum Einrichten der Synchronisierung brauchst du Internet.';
    } else {
      text.textContent = 'An dieser Adresse gibt es keinen Sync-Server. Öffne Motra über deine Cloudflare-Adresse, um die Synchronisierung zu nutzen.';
    }
  });
  return box;
}

const AUTH_ERRORS = {
  credentials: 'E-Mail oder Passwort stimmt nicht.',
  setup_code: 'Der Einrichtungscode stimmt nicht, oder diese Adresse ist nicht freigeschaltet.',
  '2fa_active': 'Zwei-Faktor ist für dieses Konto schon eingerichtet. Bitte melde dich neu an.',
  code: 'Der Code stimmt nicht. Nimm den aktuellen Code aus der App und prüfe, ob die Uhrzeit deines Geräts stimmt.',
  exists: 'Für diese Adresse gibt es schon ein Passwort. Melde dich damit an.',
  invalid: 'Diese E-Mail-Adresse ist nicht freigeschaltet.',
  session: 'Die Anmeldung ist abgelaufen. Bitte fang noch einmal an.',
  stage: 'Die Anmeldung ist abgelaufen. Bitte fang noch einmal an.',
  offline: 'Keine Verbindung zum Server. Prüfe dein Internet.',
  not_configured: 'Der Sync-Server ist noch nicht fertig eingerichtet.',
};
function authError(e) {
  if (e?.body?.error === 'locked') {
    const min = Math.max(1, Math.ceil((e.body.retryAfter || 60) / 60));
    return `Zu viele Versuche. Bitte warte ${min} ${min === 1 ? 'Minute' : 'Minuten'}.`;
  }
  return AUTH_ERRORS[e?.body?.error] ?? 'Das hat nicht geklappt. Bitte versuche es noch einmal.';
}

// A small form inside the sheet with one primary button, a busy state and an error line.
function authForm({ fields, submitLabel, onSubmit, extra = [] }) {
  const err = h('p', { class: 'form-error', hidden: true, role: 'alert' });
  const btn = h('button', { type: 'submit', class: 'btn primary' }, submitLabel);
  const f = h('form', { class: 'sheet-body', onsubmit: async e => {
    e.preventDefault();
    err.hidden = true;
    btn.disabled = true;
    btn.textContent = 'Einen Moment …';
    try {
      await onSubmit(msg => { err.textContent = msg; err.hidden = false; });
    } catch (ex) {
      err.textContent = authError(ex);
      err.hidden = false;
    } finally {
      if (btn.isConnected) { btn.disabled = false; btn.textContent = submitLabel; }
    }
  } }, ...fields, ...extra, err, h('div', { class: 'sheet-actions' }, btn));
  return f;
}

function syncLoginSheet(prefillEmail = '') {
  const title = 'Synchronisierung einrichten';
  let email = prefillEmail;

  const stepEmail = () => {
    const input = h('input', { id: 'sync-email', type: 'email', value: email, autocomplete: 'username', inputmode: 'email', autocapitalize: 'off', required: true });
    openSheet(title, authForm({
      fields: [h('p', { class: 'sheet-text' }, 'Melde dich mit deiner E-Mail-Adresse an. Beim ersten Mal legst du dein Passwort fest.'), field('E-Mail', input)],
      submitLabel: 'Weiter',
      onSubmit: async () => {
        email = input.value.trim().toLowerCase();
        const res = await sync.api('POST', 'start', { email });
        if (res.status === 'new') stepRegister(); else stepPassword();
      },
    }));
    setTimeout(() => input.focus(), 50);
  };

  const stepPassword = () => {
    const pw = h('input', { id: 'sync-password', type: 'password', autocomplete: 'current-password', required: true });
    openSheet(title, authForm({
      fields: [hiddenUser(), h('p', { class: 'sheet-text' }, email), field('Passwort', pw)],
      submitLabel: 'Anmelden',
      onSubmit: async () => {
        const res = await sync.api('POST', 'login', { email, key: await sync.loginKey(email, pw.value) });
        if (res.next === 'totp') stepTotpVerify(); else stepTotpSetup();
      },
      extra: [h('button', { type: 'button', class: 'btn ghost small', onclick: stepEmail }, 'Andere E-Mail-Adresse')],
    }));
    setTimeout(() => pw.focus(), 50);
  };

  const stepRegister = () => {
    const pw = h('input', { id: 'sync-new-password', type: 'password', autocomplete: 'new-password', minlength: 10, required: true });
    const pw2 = h('input', { id: 'sync-new-password2', type: 'password', autocomplete: 'new-password', required: true });
    const code = h('input', { id: 'sync-setup-code', type: 'text', autocomplete: 'off', autocapitalize: 'off', required: true });
    openSheet('Passwort festlegen', authForm({
      fields: [
        hiddenUser(),
        h('p', { class: 'sheet-text' }, `Du richtest das Konto ${email} ein. Wähle ein Passwort mit mindestens 10 Zeichen.`),
        field('Neues Passwort', pw),
        field('Passwort wiederholen', pw2),
        field('Einrichtungscode', code),
        h('p', { class: 'sheet-text' }, 'Den Einrichtungscode hast du in Cloudflare als SETUP_CODE festgelegt. Er wird nur dieses eine Mal gebraucht.'),
      ],
      submitLabel: 'Passwort speichern',
      onSubmit: async showError => {
        if (pw.value.length < 10) return showError('Das Passwort braucht mindestens 10 Zeichen.');
        if (pw.value !== pw2.value) return showError('Die beiden Passwörter sind nicht gleich.');
        try {
          await sync.api('POST', 'register', { email, key: await sync.loginKey(email, pw.value), setupCode: code.value.trim() });
        } catch (e) {
          if (e.body?.error === 'exists') return stepPassword();
          throw e;
        }
        stepTotpSetup();
      },
    }));
    setTimeout(() => pw.focus(), 50);
  };

  const stepTotpSetup = async () => {
    openSheet('Zwei-Faktor einrichten', h('p', { class: 'sheet-text' }, 'Einen Moment …'));
    let setup;
    try {
      setup = await sync.api('POST', '2fa/setup');
    } catch (e) {
      openSheet('Zwei-Faktor einrichten', h('p', { class: 'form-error' }, authError(e)),
        h('div', { class: 'sheet-actions' }, h('button', { type: 'button', class: 'btn', onclick: stepEmail }, 'Neu beginnen')));
      return;
    }
    const code = codeInput('sync-totp-setup');
    const keyText = setup.secret.replace(/(.{4})/g, '$1 ').trim();
    const qrBox = h('div', { class: 'qr-box' });
    renderQr(qrBox, setup.uri);
    openSheet('Zwei-Faktor einrichten', authForm({
      fields: [
        h('p', { class: 'sheet-text' }, 'Füge Motra in deiner Authenticator-App hinzu, zum Beispiel Apple Passwörter, Google Authenticator oder Authy.'),
        h('a', { class: 'btn', href: setup.uri }, 'In Authenticator-App öffnen'),
        h('p', { class: 'sheet-text' }, 'Oder scanne den Code mit einem anderen Gerät:'),
        qrBox,
        h('div', { class: 'secret-row' },
          h('code', { class: 'secret' }, keyText),
          h('button', { type: 'button', class: 'btn small', onclick: () => copyText(setup.secret, 'Schlüssel kopiert') }, 'Kopieren')),
        field('6-stelliger Code aus der App', code),
      ],
      submitLabel: 'Bestätigen',
      onSubmit: async () => {
        const res = await sync.api('POST', '2fa/confirm', { code: code.value });
        stepRecovery(res.recoveryCodes || []);
      },
    }));
  };

  const stepRecovery = codes => {
    const text = codes.join('\n');
    openSheet('Wiederherstellungscodes',
      h('p', { class: 'sheet-text' }, 'Falls du dein Handy mit der Authenticator-App verlierst, kannst du dich mit einem dieser Codes anmelden. Jeder Code funktioniert einmal. Speichere sie zum Beispiel in deinem Passwortmanager.'),
      h('ul', { class: 'recovery' }, ...codes.map(c => h('li', null, h('code', null, c)))),
      h('div', { class: 'sheet-actions' },
        h('button', { type: 'button', class: 'btn', onclick: () => copyText(text, 'Codes kopiert') }, 'Codes kopieren'),
        h('button', { type: 'button', class: 'btn primary', onclick: finish }, 'Ich habe sie gesichert')));
  };

  const stepTotpVerify = () => {
    const code = h('input', { id: 'sync-totp', type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', required: true, maxlength: 24 });
    openSheet('Code eingeben', authForm({
      fields: [
        h('p', { class: 'sheet-text' }, 'Gib den 6-stelligen Code aus deiner Authenticator-App ein. Hast du keinen Zugriff darauf, geht auch ein Wiederherstellungscode.'),
        field('Code', code),
      ],
      submitLabel: 'Anmelden',
      onSubmit: async () => {
        await sync.api('POST', '2fa/verify', { code: code.value.trim() });
        finish();
      },
    }));
    setTimeout(() => code.focus(), 50);
  };

  const finish = async () => {
    openSheet(title, h('p', { class: 'sheet-text' }, 'Angemeldet. Deine Daten werden abgeglichen …'));
    await sync.enable(email);
    const s = sync.info();
    if (s.status === 'idle') toast('Synchronisierung ist aktiv');
    settingsSheet();
  };

  // Lets password managers save the e-mail address together with the password.
  const hiddenUser = () => h('input', { type: 'email', name: 'username', autocomplete: 'username', value: email, hidden: true, readonly: true, tabindex: '-1' });

  stepEmail();
}

function codeInput(id) {
  return h('input', { id, type: 'text', inputmode: 'numeric', autocomplete: 'one-time-code', pattern: '[0-9 ]*', maxlength: 7, required: true });
}

async function copyText(text, done) {
  try { await navigator.clipboard.writeText(text); toast(done); } catch (e) { toast('Kopieren nicht möglich. Bitte markiere den Text.'); }
}

let qrLoading = null;
function renderQr(box, text) {
  qrLoading ??= new Promise((resolve, reject) => {
    if (window.qrcode) return resolve();
    const tag = document.createElement('script');
    tag.src = 'js/vendor/qrcode.js';
    tag.onload = resolve;
    tag.onerror = () => { qrLoading = null; reject(); };
    document.head.append(tag);
  });
  qrLoading.then(() => {
    const qr = window.qrcode(0, 'M');
    qr.addData(text);
    qr.make();
    const n = qr.getModuleCount();
    const pad = 4;
    const svg = s('svg', { viewBox: `0 0 ${n + pad * 2} ${n + pad * 2}`, role: 'img', 'aria-label': 'QR-Code für die Authenticator-App', 'shape-rendering': 'crispEdges' },
      s('rect', { width: n + pad * 2, height: n + pad * 2, fill: '#ffffff' }));
    let d = '';
    for (let r = 0; r < n; r++) for (let c = 0; c < n; c++) if (qr.isDark(r, c)) d += `M${c + pad},${r + pad}h1v1h-1z`;
    svg.append(s('path', { d, fill: '#000000' }));
    box.replaceChildren(svg);
  }).catch(() => box.replaceChildren(h('p', { class: 'sheet-text' }, 'Der QR-Code konnte nicht geladen werden. Nutze den Button oder den Schlüssel.')));
}

/* ---------------- banners ---------------- */

function renderBanners() {
  const el = $('#banners');
  const items = [];
  if (!store.isStorageAvailable()) {
    items.push(h('div', { class: 'banner warn' }, h('span', null, h('strong', null, 'Speichern nicht möglich. '), 'Dein Browser blockiert den Speicher (z. B. im privaten Modus). Einträge gehen beim Schließen verloren.')));
  }
  if (sync.info().status === 'loggedout') {
    items.push(h('div', { class: 'banner warn' },
      h('span', null, h('strong', null, 'Synchronisierung pausiert. '), 'Bitte melde dich neu an.'),
      h('button', { type: 'button', class: 'btn small', onclick: () => syncLoginSheet(sync.info().email) }, 'Anmelden')));
  }
  if (store.hasDemo()) {
    items.push(h('div', { class: 'banner' },
      h('span', null, h('strong', null, 'Beispieldaten aktiv. '), 'Das sind nicht deine Einträge.'),
      h('button', { type: 'button', class: 'btn small', onclick: () => { store.removeDemo(); toast('Beispieldaten entfernt'); } }, 'Entfernen')));
  }
  const st = store.getState();
  const realEntries = st.entries.filter(e => !e.demo).length;
  const last = st.settings.lastBackup;
  const daysSince = last ? diffDays(last.slice(0, 10), todayKey()) : null;
  // Closed with the x: stays away for 14 days, then asks again (if there's still no backup).
  const hidden = prefs.backupHiddenOn != null && diffDays(prefs.backupHiddenOn, todayKey()) < 14;
  if (realEntries >= 21 && (daysSince == null || daysSince >= 14) && currentView === 'heute' && !hidden) {
    items.push(h('div', { class: 'banner dismissible' },
      h('span', null, last ? `Letzte Sicherung vor ${daysSince} Tagen.` : 'Du hast noch keine Sicherung deiner Einträge.'),
      h('button', { type: 'button', class: 'btn small', onclick: settingsSheet }, 'Jetzt sichern'),
      h('button', {
        type: 'button', class: 'banner-close', 'aria-label': 'Hinweis schließen',
        onclick: () => { prefs.backupHiddenOn = todayKey(); savePrefs(); renderBanners(); },
      }, icon('i-close'))));
  }
  el.replaceChildren(...items);
}

/* ---------------- boot ---------------- */

store.init();
store.subscribe(({ remote } = {}) => {
  // Changes from another device: show them in the form too, unless you're in the middle of editing.
  if (remote && !form.dirty) loadFormEntry();
  renderView();
});
sync.onChange(() => {
  renderBanners();
  const status = $('#sync-status');
  if (status) {
    status.textContent = SYNC_STATUS[sync.info().status] ?? '';
    $('#sync-last').textContent = relativeTime(sync.info().lastSync);
  }
});
sync.start();
push.start();

// Reminder taps: either the app starts with ?slot=…, or it was open and gets a message.
{
  const params = new URLSearchParams(location.search);
  if (params.has('slot')) {
    openFromReminder(params.get('slot'), params.get('date'));
    history.replaceState(null, '', location.pathname + location.hash);
  }
  navigator.serviceWorker?.addEventListener('message', e => {
    if (e.data?.type === 'motra-open') openFromReminder(e.data.slot, e.data.date);
  });
}
initHeute();
loadFormEntry();
route();

// Redraw charts when their width changes.
let lastWidth = 0;
new ResizeObserver(entries => {
  const w = Math.round(entries[0].contentRect.width);
  if (w !== lastWidth) { lastWidth = w; if (currentView !== 'heute') renderView(); }
}).observe($('#main'));

// Coming back to the app later: roll over to a new day or slot.
let lastDay = todayKey();
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState !== 'visible') return;
  const today = todayKey();
  if (today !== lastDay || (!form.touched && !form.dirty)) {
    if (today !== lastDay) { lastDay = today; form.touched = false; }
    if (!form.dirty) {
      form.date = today;
      form.slot = store.currentSlot();
      loadFormEntry();
    }
  }
  renderView();
});

if ('serviceWorker' in navigator && location.protocol !== 'file:') {
  navigator.serviceWorker.register('sw.js').catch(() => { /* offline support is optional */ });
}
