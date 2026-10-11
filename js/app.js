import * as store from './store.js';
import * as sync from './sync.js';
import * as push from './push.js';
import { moodChart, moodLegend, medChart, medLegend, eventText, momentsChart, momentsLegend } from './charts.js';
import {
  h, s, icon, todayKey, addDays, diffDays, fromKey, formatLong, formatDayMonth, formatShort, formatWeekday,
  formatMonth, relativeDay, num1, signed1,
} from './util.js';

const $ = sel => document.querySelector(sel);

/* ---------------- preferences (per device conveniences) ---------------- */

const PREFS_KEY = 'motra.prefs';
const LEGACY_PREFS_KEY = 'sutra.prefs';
let prefs = { rangeVerlauf: '30', rangeMedis: '90', rangeOther: '90', kindFilter: 'all', lastKind: 'all', medListOpen: null, backupHiddenOn: null };
try {
  let saved = localStorage.getItem(PREFS_KEY);
  if (saved == null && (saved = localStorage.getItem(LEGACY_PREFS_KEY)) != null) {
    localStorage.setItem(PREFS_KEY, saved);
    localStorage.removeItem(LEGACY_PREFS_KEY);
  }
  prefs = { ...prefs, ...JSON.parse(saved || '{}') };
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
  if (!sheet.open) sheet.showModal();
  sheet.scrollTop = 0;
  // Start focus on the title, so the close button doesn't light up on open.
  $('#sheet-title').focus({ preventScroll: true });
}
const closeSheet = () => sheet.open && sheet.close();
$('#sheet-close').addEventListener('click', closeSheet);
sheet.addEventListener('click', e => { if (e.target === sheet) closeSheet(); });

function field(label, input, extraClass = '') {
  return h('div', { class: `field ${extraClass}` }, h('label', { for: input.id }, label), input);
}

/* ---------------- routing ---------------- */

const VIEWS = ['heute', 'verlauf', 'medis'];
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
  $('#tab-note-dot').hidden = !form.note.trim();
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

/* Single things for the day of the form: tap a chip to set or remove it. */
function renderTodayOther() {
  const date = form.date;
  const isToday = date === todayKey();
  const day = isToday ? 'heute' : relativeDay(date) === 'Gestern' ? 'gestern' : `am ${formatDayMonth(date)}`;
  const moments = store.getState().moments;
  const colors = store.momentColors();
  const onDay = moments.filter(m => !m.span && !m.archived && m.date === date);          // single entries I can toggle
  const running = moments.filter(m => m.span && !m.archived && store.momentCovers(m, date)); // periods covering that day
  const has = key => onDay.find(m => m.title.toLowerCase() === key);
  const count = onDay.length + running.length;
  const badge = $('#tab-other-count');
  badge.hidden = !count;
  badge.textContent = String(count);
  $('#today-other-hint').textContent = `Was hast du ${day === 'heute' ? 'heute ' : day === 'gestern' ? 'gestern ' : `${day} `}gemacht oder erlebt? Tippe an, noch mal tippen nimmt es weg.`;
  const run = $('#today-other-running');
  run.hidden = !running.length;
  run.textContent = running.length ? `Läuft in dieser Zeit: ${running.map(m => m.title).join(', ')}` : '';

  // Titles that were used for single days before, most frequent first.
  const counts = new Map();
  for (const m of moments) {
    if (m.span || m.archived) continue;
    const k = m.title.toLowerCase();
    const c = counts.get(k) ?? { title: m.title, n: 0, last: '' };
    c.n++;
    if (m.date >= c.last) { c.last = m.date; c.title = m.title; }
    counts.set(k, c);
  }
  for (const m of onDay) if (!counts.has(m.title.toLowerCase())) counts.set(m.title.toLowerCase(), { title: m.title, n: 1, last: m.date });
  const titles = [...counts.entries()].sort((a, b) => b[1].n - a[1].n || b[1].last.localeCompare(a[1].last)).slice(0, 12);
  $('#today-other-chips').replaceChildren(...titles.map(([key, tt]) => {
    const on = !!has(key);
    return h('button', {
      type: 'button', class: `quick-chip${on ? ' on' : ''}`, 'aria-pressed': String(on),
      onclick: () => toggleTodayOther(tt.title),
    }, h('span', { class: 'key-dot', style: { background: momentCss(colors, tt.title) } }), tt.title, on ? h('small', null, '✓') : null);
  }));
  $('#today-other-chips').hidden = !titles.length;
  $('#today-other-manage').hidden = !moments.length;
}

/* Whole activities (all entries with one title): archive them out of the quick choices, or bring them back. */
function activitiesSheet() {
  const acts = store.momentActivities();
  const colors = store.momentColors();
  const row = a => h('div', { class: `activity${a.archived ? ' archived' : ''}` },
    h('span', { class: 'key-dot', style: { background: momentCss(colors, a.title) } }),
    h('span', { class: 'activity-name' }, a.title, h('small', null, `${a.n} ${a.n === 1 ? 'Eintrag' : 'Einträge'}`)),
    h('button', {
      type: 'button', class: 'btn small',
      onclick: () => {
        store.archiveActivity(a.title, !a.archived);
        toast(a.archived ? `${a.title} aus dem Archiv geholt` : `${a.title} archiviert`);
        activitiesSheet();
      },
    }, a.archived ? 'Wiederherstellen' : 'Archivieren'));
  const active = acts.filter(a => !a.archived), done = acts.filter(a => a.archived);
  openSheet('Aktivitäten',
    h('p', { class: 'sheet-text' }, 'Archivierte Aktivitäten verschwinden aus der Schnellauswahl und den Listen. Ihre Einträge bleiben in Grafik und Auswertung erhalten.'),
    active.length ? h('div', { class: 'activity-list' }, ...active.map(row)) : h('p', { class: 'empty-text' }, 'Alles ist archiviert.'),
    done.length ? h('section', { class: 'sheet-section' }, h('h3', null, 'Archiviert'), h('div', { class: 'activity-list' }, ...done.map(row))) : null);
}

function toggleTodayOther(title) {
  const key = title.trim().toLowerCase();
  if (!key) return;
  const existing = store.getState().moments.find(m => !m.span && !m.archived && m.date === form.date && m.title.toLowerCase() === key);
  if (existing) store.deleteMoment(existing.id);
  else store.addMoment({ date: form.date, title });
}

function addTodayOther() {
  const input = $('#today-other-input');
  const title = input.value.trim();
  if (!title) { input.focus(); return; }
  const key = title.toLowerCase();
  // adding what is already there is a no-op, not a toggle
  if (!store.getState().moments.some(m => !m.span && m.date === form.date && m.title.toLowerCase() === key)) store.addMoment({ date: form.date, title });
  input.value = '';
  toast(`${title} eingetragen`);
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
  renderTodayOther();

  renderWeek();
}

function renderWeek() {
  const today = todayKey();
  const days = Array.from({ length: 7 }, (_, i) => addDays(today, i - 6));
  const grid = [h('div')];
  for (const d of days) {
    grid.push(h('div', { class: `week-col-head${d === today ? ' today' : ''}` }, h('strong', null, formatWeekday(d)), new Date(d + 'T12:00').getDate() + '.'));
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
    $('#tab-note-dot').hidden = !form.note.trim();
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

function renderVerlauf() {
  segmented($('#range-verlauf'), prefs.rangeVerlauf, id => { prefs.rangeVerlauf = id; savePrefs(); renderVerlauf(); });
  const { from, to, days, all } = rangeBounds(prefs.rangeVerlauf);
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

  renderHeat(from, to, days, all);

  // chart
  moodLegend($('#mood-chart-legend'));
  moodChart($('#mood-chart'), { from, to });

  // per slot
  $('#slot-bars').replaceChildren(
    ...st.slots.map(sl => h('div', { class: 'hbar' },
      h('span', { class: 'hbar-label' }, sl.label),
      h('div', { class: 'hbar-track' }, sl.avg != null ? h('div', { class: 'hbar-fill', style: { width: `${((sl.avg - 1) / 4) * 100}%` } }) : null),
      h('span', { class: 'hbar-value' }, sl.avg == null ? '–' : num1(sl.avg), h('small', null, `${sl.n}×`)))),
    h('p', { class: 'scale-note' }, 'Skala 1 bis 5. Ein voller Balken heißt „Sehr gut“.'),
  );

  renderEntryList();
}

/* ---------- "Auf einen Blick": the week grid, scaled to the chosen range ----------
   Always time of day (Morgen, Mittag, Abend) stacked, one column per day.
   7 and 30 days: separate boxes. 90 days, 1 year and "Alle": the boxes run into one continuous colored surface. */

const heat = { date: null, slot: null };
const mondayIndex = key => (fromKey(key).getDay() + 6) % 7;     // Mo = 0
const HEAT_ROW = 24, HEAT_GAP = 3;                              // surface: row height and space between the three rows

function renderHeat(from, to, days, all) {
  const today = todayKey();
  const el = $('#heat');
  const dates = Array.from({ length: diffDays(from, to) + 1 }, (_, i) => addDays(from, i));
  const surface = all || days > 31;
  if (heat.date && (heat.date < from || heat.date > to)) heat.date = heat.slot = null;
  const hasData = store.rangeStats(from, to).count > 0;

  const rerender = () => renderHeat(from, to, days, all);
  const select = (date, slot = null, toggle = true) => {
    const same = heat.date === date && heat.slot === slot;
    Object.assign(heat, same && toggle ? { date: null, slot: null } : { date, slot });
    if (surface) { markHeat(dates); renderHeatCaption(); } else rerender();
  };

  if (!hasData) {
    el.replaceChildren(h('p', { class: 'empty-text' }, 'In diesem Zeitraum gibt es noch keine Einträge.'));
    $('#heat-meta').textContent = '';
  } else if (!surface) {
    // separate boxes
    const week = dates.length <= 7;
    const cells = [h('div')];
    for (const d of dates) {
      cells.push(week
        ? h('div', { class: `heat-head${d === today ? ' today' : ''}` }, h('strong', null, formatWeekday(d)), fromKey(d).getDate() + '.')
        : h('div', { class: `heat-head tick${d === today ? ' today' : ''}` }, mondayIndex(d) === 0 || (d === from && 7 - mondayIndex(d) >= 3) ? h('span', null, fromKey(d).getDate() + '.') : null));
    }
    for (const sl of store.SLOTS) {
      cells.push(h('div', { class: 'heat-label' }, sl.label));
      for (const d of dates) {
        const e = store.dayEntries(d)[sl.id];
        cells.push(h('button', {
          type: 'button',
          class: `heat-cell${e ? ' filled' : ''}${heat.date === d && heat.slot === sl.id ? ' selected' : ''}`,
          style: e ? { background: store.moodColor(e.mood) } : null,
          title: `${formatWeekday(d)} ${formatDayMonth(d)}, ${sl.label}: ${e ? num1(e.mood) : 'kein Eintrag'}`,
          'aria-label': `${formatWeekday(d)} ${formatDayMonth(d)}, ${sl.label}: ${e ? store.describeMood(e.mood) : 'kein Eintrag'}`,
          onclick: () => select(d, sl.id),
        }));
      }
    }
    if (week) {
      cells.push(h('div', { class: 'heat-label' }, 'Ø'));
      for (const d of dates) { const v = store.dayAverage(d); cells.push(h('div', { class: `week-avg${v == null ? ' empty' : ''}` }, v == null ? '–' : num1(v))); }
    }
    el.replaceChildren(h('div', { class: `heat-grid ${week ? 'week' : 'slots'}`, style: { '--cols': dates.length } }, ...cells));
    $('#heat-meta').textContent = week ? 'Jedes Feld ist eine Tageszeit.' : 'Jede Spalte ist ein Tag. Tippe auf ein Feld.';
  } else {
    // one continuous surface: a column per day, the three times of day stacked
    const N = dates.length;
    const W = el.clientWidth || 300;
    const H = store.SLOTS.length * HEAT_ROW + (store.SLOTS.length - 1) * HEAT_GAP;
    const svg = s('svg', {
      viewBox: `0 0 ${N} ${H}`, preserveAspectRatio: 'none', class: 'heat-surface-svg', height: H,
      role: 'img', tabindex: '0',
      'aria-label': `Stimmung von ${formatShort(from)} bis ${formatShort(to)}, nach Tageszeit. Pfeiltasten wählen einen Tag.`,
      ...(N <= W ? { 'shape-rendering': 'crispEdges' } : {}),   // thinner than a pixel: let the browser blend neighbours
    });
    store.SLOTS.forEach((sl, r) => {
      dates.forEach((d, i) => {
        const e = store.dayEntries(d)[sl.id];
        if (!e) return;
        svg.append(s('rect', { x: i, y: r * (HEAT_ROW + HEAT_GAP), width: 1, height: HEAT_ROW, fill: store.moodColor(e.mood) }));
      });
    });
    svg.append(s('rect', { class: 'heat-sel', x: 0, y: -1, width: 1, height: H + 2, visibility: 'hidden' }));

    // month (or year) labels along the bottom
    const labels = [];
    const long = N > 430;
    let lastPos = -1;
    const addLabel = (i, text) => { const pos = i / N; if (pos - lastPos >= (long ? 0.09 : 0.12)) { labels.push(h('span', { style: { left: `${pos * 100}%` } }, text)); lastPos = pos; } };
    dates.forEach((d, i) => {
      const dt = fromKey(d);
      if (long ? dt.getMonth() === 0 && dt.getDate() === 1 : dt.getDate() === 1) addLabel(i, long ? String(dt.getFullYear()) : formatMonth(d));
    });
    if (!labels.length || (labels[0] && parseFloat(labels[0].style.left) > 18)) {
      // the range starts in the middle of a month/year: name where it starts
      labels.unshift(h('span', { style: { left: '0%' } }, long ? String(fromKey(from).getFullYear()) : formatMonth(from)));
    }

    const rowLabels = h('div', { class: 'heat-rowlabels', style: { height: `${H}px` } }, ...store.SLOTS.map(sl => h('span', { style: { height: `${HEAT_ROW}px` } }, sl.label)));
    const surfaceEl = h('div', { class: 'heat-surface' }, rowLabels, h('div', { class: 'heat-surface-main' }, svg, h('div', { class: 'heat-axis' }, ...labels)));
    el.replaceChildren(surfaceEl);

    // pick a day by tapping, dragging across, hovering or with the arrow keys
    const indexAt = ev => {
      const box = svg.getBoundingClientRect();
      return Math.max(0, Math.min(N - 1, Math.floor(((ev.clientX - box.left) / box.width) * N)));
    };
    let pressed = false;
    svg.addEventListener('pointerdown', ev => { pressed = true; const d = dates[indexAt(ev)]; select(d, null, ev.pointerType !== 'mouse' || heat.date === d); });
    svg.addEventListener('pointermove', ev => {
      if (!pressed && ev.pointerType !== 'mouse') return;
      const d = dates[indexAt(ev)];
      if (heat.date !== d || heat.slot) select(d, null, false);
    });
    for (const type of ['pointerup', 'pointercancel']) svg.addEventListener(type, () => { pressed = false; });
    svg.addEventListener('keydown', ev => {
      const step = { ArrowLeft: -1, ArrowRight: 1 }[ev.key];
      if (!step) return;
      ev.preventDefault();
      const cur = heat.date ? dates.indexOf(heat.date) : N;
      select(dates[Math.max(0, Math.min(N - 1, cur + step))], null, false);
    });
    $('#heat-meta').textContent = 'Jede Spalte ist ein Tag, oben Morgen, darunter Mittag und Abend. Tippe oder fahre mit dem Finger darüber.';
    markHeat(dates);
  }
  renderHeatCaption();
  $('#heat-legend').replaceChildren(
    ...store.MOODS.map(m => h('span', null, h('i', { style: { background: `var(--m${m.value})` } }), `${m.value} ${m.label}`)),
    h('span', null, h('i', { class: 'none' }), 'kein Eintrag'));
}

// Outline the chosen day on the surface.
function markHeat(dates) {
  const sel = document.querySelector('#heat .heat-sel');
  if (!sel) return;
  const i = heat.date ? dates.indexOf(heat.date) : -1;
  sel.setAttribute('visibility', i < 0 ? 'hidden' : 'visible');
  if (i >= 0) sel.setAttribute('x', String(i));
  // keep the outline at least ~3px wide however many days are shown
  const svg = sel.ownerSVGElement;
  const w = Math.max(1, (dates.length / (svg.getBoundingClientRect().width || 300)) * 3);
  sel.setAttribute('width', String(w));
  if (i >= 0 && w > 1) sel.setAttribute('x', String(Math.min(i - (w - 1) / 2, dates.length - w)));
}

// Detail line for the chosen day (or time of day).
function renderHeatCaption() {
  const cap = $('#heat-caption');
  if (!heat.date) { cap.replaceChildren(); cap.hidden = true; return; }
  const d = heat.date;
  const entries = store.dayEntries(d);
  const avg = store.dayAverage(d);
  const open = heat.slot ?? store.SLOTS.find(sl => entries[sl.id])?.id ?? store.currentSlot();
  cap.hidden = false;
  cap.replaceChildren(
    h('strong', null, `${formatWeekday(d)}, ${formatDayMonth(d)}`),
    ` · Ø ${avg == null ? '–' : num1(avg)} · `,
    store.SLOTS.map(sl => `${sl.label} ${entries[sl.id] ? num1(entries[sl.id].mood) : '–'}`).join(' · '),
    h('button', { type: 'button', class: 'link-btn', onclick: () => { selectEntry(d, open); location.hash = '#heute'; } }, 'Eintrag öffnen'));
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
  // Change/stop need a running phase without a set end; anything else is changed via "Bearbeiten".
  const open = store.openPhase(m);
  const actions = [];
  if (m.archived) {
    actions.push(h('button', { type: 'button', class: 'btn small', onclick: () => { store.archiveMed(m.id, false); toast(`${m.name} aus dem Archiv geholt`); } }, 'Wiederherstellen'));
  } else if (st.state === 'active' && open && open.start <= todayKey()) {
    actions.push(h('button', { type: 'button', class: 'btn small', onclick: () => doseSheet(m) }, t.change),
      h('button', { type: 'button', class: 'btn small', onclick: () => stopSheet(m) }, t.stop));
  } else if (st.state === 'stopped') {
    actions.push(h('button', { type: 'button', class: 'btn small', onclick: () => doseSheet(m, true) }, t.restart));
  }
  actions.push(h('button', { type: 'button', class: 'btn small ghost', onclick: () => editSheet(m) }, 'Bearbeiten'));
  const chip = { active: [t.active, ' active'], planned: ['Geplant', ' planned'], stopped: [t.stopped, ''] }[st.state];
  return h('article', { class: 'card med-card' },
    h('div', { class: 'med-head' },
      h('span', { class: 'med-swatch', style: { background: `var(--c${m.color + 1})` } }),
      h('h3', { class: 'med-name' }, m.name),
      h('span', { class: `chip${chip[1]}` }, chip[0])),
    h('div', { class: 'med-dose' }, h('strong', null, st.dose || t.noDose), h('span', null, st.text)),
    st.upcoming ? h('p', { class: 'med-upcoming' }, st.upcoming) : null,
    h('p', { class: 'med-history' }, medHistory(m)),
    h('div', { class: 'med-actions' }, ...actions));
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

let autoToggle = false; // set while the app itself opens/closes the list, so that isn't saved as a choice
const KIND_FILTERS = [
  { id: 'all', label: 'Alle', title: 'Deine Medikamente & Therapien' },
  { id: 'med', label: 'Medikamente', title: 'Deine Medikamente' },
  { id: 'therapy', label: 'Therapien', title: 'Deine Therapien' },
];
const kindOf = m => (m.kind === 'therapy' ? 'therapy' : 'med');
// Medications and therapies the "Anzeigen" switch lets through.
const shownMeds = () => store.getState().meds.filter(m => prefs.kindFilter === 'all' || kindOf(m) === prefs.kindFilter);

function renderMedis() {
  // "Anderes" is its own area next to the switch, not part of "Alle".
  const other = prefs.kindFilter === 'other';
  $('#medis-main').hidden = other;
  $('#other-main').hidden = !other;
  $('#h-medis').textContent = other ? 'Anderes' : 'Medikamente & Therapien';
  const toggle = $('#other-toggle');
  toggle.setAttribute('aria-pressed', String(other));
  toggle.classList.toggle('active', other);

  const filter = KIND_FILTERS.find(f => f.id === prefs.kindFilter) ?? KIND_FILTERS[0];
  $('#kind-filter').replaceChildren(...KIND_FILTERS.map(f => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(!other && f.id === filter.id),
    onclick: () => { prefs.kindFilter = f.id; prefs.lastKind = f.id; savePrefs(); renderMedis(); },
  }, f.label)));
  if (other) { renderOther(); return; }

  const all = shownMeds();
  const meds = all.filter(m => !m.archived);          // lists and counts: what's still in use
  const archived = all.filter(m => m.archived);
  const groups = ['med', 'therapy'].map(kind => ({ kind, items: meds.filter(m => kindOf(m) === kind) })).filter(g => g.items.length);
  const archive = archiveSection('med', archived.length, byKind(archived).map(medCard));
  $('#med-list').replaceChildren(...groups.flatMap(g => [
    groups.length > 1 ? h('h3', { class: 'med-group' }, TERMS[g.kind].group) : null,
    ...g.items.map(medCard),
  ].filter(Boolean)), ...(archive ? [archive] : []));
  if (!meds.length) {
    const none = archived.length ? 'Alles ist archiviert.' : { all: 'Trag deine Medikamente und Therapien mit Startdatum ein. Danach siehst du unten, wie deine Stimmung dazu verlaufen ist.',
      med: 'Noch keine Medikamente eingetragen.', therapy: 'Noch keine Therapien eingetragen.' }[filter.id];
    $('#med-list').replaceChildren(h('p', { class: 'empty-text' }, none), ...(archive ? [archive] : []));
  }

  // Folded summary: title, count and what's running or planned.
  $('#h-med-list').textContent = filter.title;
  const states = meds.map(m => medStatus(m).state);
  const count = n => states.filter(s => s === n).length;
  const parts = [count('active') && `${count('active')} ${count('active') === 1 ? 'läuft' : 'laufen'}`,
    count('planned') && `${count('planned')} geplant`, count('stopped') && `${count('stopped')} beendet`].filter(Boolean);
  $('#med-summary-meta').textContent = meds.length ? `${meds.length} · ${parts.join(', ')}` : archived.length ? `${archived.length} im Archiv` : 'Noch nichts eingetragen';
  const details = $('#med-details');
  // Open by default only while the list is empty; afterwards remember the reader's choice.
  const shouldOpen = prefs.medListOpen ?? store.getState().meds.length === 0;
  if (details.open !== shouldOpen) { autoToggle = true; details.open = shouldOpen; }

  segmented($('#range-medis'), prefs.rangeMedis, id => { prefs.rangeMedis = id; savePrefs(); renderMedis(); });
  const { from, to } = rangeBounds(prefs.rangeMedis);
  medLegend($('#med-chart-legend'), filter.id);
  medChart($('#med-chart'), { from, to, show: filter.id });
  renderCompare(from, to);
  renderEvents();
}

function renderCompare(from, to) {
  const meds = byKind(shownMeds());
  const el = $('#compare');
  if (!meds.length) { el.replaceChildren(h('p', { class: 'empty-text' }, 'Hier ist noch nichts eingetragen.')); return; }
  const MIN = 5;
  el.replaceChildren(...meds.map(m => {
    const t = T(m);
    const c = store.medComparison(m, from, to);
    const row = (label, data, cls) => h('div', { class: 'hbar' },
      h('span', { class: 'hbar-label' }, label),
      h('div', { class: 'hbar-track' }, data.avg != null ? h('div', { class: `hbar-fill ${cls}`, style: { width: `${((data.avg - 1) / 4) * 100}%`, background: cls === 'with' ? `var(--c${m.color + 1})` : null } }) : null),
      h('span', { class: 'hbar-value' }, data.avg == null ? '–' : num1(data.avg), h('small', null, `${data.days} Tage`)));
    let hint = null;
    if (c.with.days < MIN && c.without.days < MIN) hint = 'Zu wenige Tage mit Einträgen im Zeitraum.';
    else if (c.without.days < MIN) hint = `${t.mostly}, deshalb gibt es kaum Vergleichstage. Wähle einen längeren Zeitraum.`;
    else if (c.with.days < MIN) hint = t.rarely;
    else {
      const d = c.with.avg - c.without.avg;
      hint = h('span', null, 'Unterschied ', deltaEl(d), ` ${t.withDays}.`);
    }
    return h('div', { class: 'compare-block' },
      h('h3', null, h('span', { class: 'med-swatch', style: { background: `var(--c${m.color + 1})` } }), m.name,
        m.kind === 'therapy' ? h('span', { class: 'kind-tag' }, 'Therapie') : null),
      h('div', { class: 'compare-rows' }, row('Mit', c.with, 'with'), row('Ohne', c.without, 'without')),
      h('p', { class: 'compare-hint' }, hint));
  }));
}

function renderEvents() {
  const el = $('#events');
  const events = shownMeds().flatMap(m => store.medEvents(m)).filter(e => e.date <= todayKey())
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!events.length) { el.replaceChildren(h('p', { class: 'empty-text' }, 'Hier erscheint jeder Beginn, jede Änderung von Dosis oder Häufigkeit und jedes Ende mit dem Stimmungsvergleich davor und danach.')); return; }
  el.replaceChildren(...events.slice(0, 20).map(ev => {
    const c = store.eventComparison(ev.date);
    let body;
    if (!c.started) {
      body = [`Vorher Ø ${num1(c.before.avg)}`, h('span', { class: 'vals' }, `Vergleich ab ${formatDayMonth(c.afterStart)} möglich`)];
    } else if (c.before.avg == null || c.after.avg == null) {
      body = [h('span', null, c.before.avg == null ? 'Keine Einträge in den 4 Wochen davor.' : 'Noch keine Einträge in Woche 3 bis 6.')];
    } else {
      body = [
        h('span', { class: 'vals' }, `Ø ${num1(c.before.avg)} → ${c.complete ? '' : 'bisher '}Ø ${num1(c.after.avg)}`),
        deltaEl(c.after.avg - c.before.avg),
        h('span', { class: 'vals', style: { color: 'var(--muted)' } }, `${c.before.days} + ${c.after.days} Tage`),
      ];
    }
    return h('div', { class: 'event' },
      h('div', { class: 'event-date' }, formatShort(ev.date)),
      h('div', null,
        h('div', { class: 'event-title' }, h('span', { class: 'med-swatch', style: { background: `var(--c${ev.med.color + 1})` } }), eventText(ev)),
        h('p', { class: 'event-body' }, ...body)));
  }));
}

/* ================= ANDERES ================= */

let otherShown = 20;
let otherSpan = false;   // form mode: one day or a period
const MOMENT_MODES = [{ id: false, label: 'Ein Tag' }, { id: true, label: 'Zeitraum' }];
const momentEndMax = () => addDays(todayKey(), 365);   // a period may have a planned end (holiday until Friday)

// Validation shared by the form and the edit sheet. Returns an error text or ''.
function momentError({ title, date, span, end }) {
  if (!title.trim()) return 'Bitte beschreibe kurz, was du gemacht oder erlebt hast.';
  if (!date || date > todayKey()) return span ? 'Bitte wähle einen Beginn bis heute.' : 'Bitte wähle einen Tag bis heute.';
  if (span && end && end < date) return 'Das Ende kann nicht vor dem Beginn liegen.';
  if (span && end && end > momentEndMax()) return 'Das Ende darf höchstens ein Jahr in der Zukunft liegen.';
  return '';
}

// "12. Aug – 3. Sept", "seit 3.9.26", "ab 3.9.26 bis 20. Okt" …
function momentDateLabel(m) {
  if (!m.span) return relativeDay(m.date);
  if (m.end == null) return `seit ${formatShort(m.date)}`;
  if (m.end === m.date) return formatShort(m.date);
  return `${formatDayMonth(m.date)} – ${formatDayMonth(m.end)}`;
}

// Switch between "Ein Tag" and "Zeitraum" in a form: labels and the end field follow.
function momentModeSwitch(el, span, onChange) {
  el.replaceChildren(...MOMENT_MODES.map(mode => h('button', {
    type: 'button', role: 'radio', 'aria-checked': String(mode.id === span),
    onclick: () => { if (mode.id !== span) onChange(mode.id); },
  }, mode.label)));
}

function applyOtherMode() {
  momentModeSwitch($('#other-mode'), otherSpan, span => { otherSpan = span; applyOtherMode(); });
  $('#other-date-label').textContent = otherSpan ? 'Von' : 'Tag';
  $('#other-end-field').hidden = !otherSpan;
  const end = $('#other-end');
  end.min = $('#other-date').value || '';
  end.max = momentEndMax();
}

function renderOther() {
  const today = todayKey();
  const dateInput = $('#other-date');
  dateInput.max = today;
  if (!dateInput.value || dateInput.value > today) dateInput.value = today;
  applyOtherMode();

  // Quick buttons: what you've entered before, most frequent first.
  // Picking one also picks "Zeitraum" when it was last entered as a period.
  const titles = store.momentTitles();
  const colors = store.momentColors();
  const title = $('#other-title');
  const lastOf = key => [...store.getState().moments].reverse().find(m => m.title.toLowerCase() === key);
  $('#other-quick').replaceChildren(...titles.slice(0, 8).map(tt => h('button', {
    type: 'button', class: `quick-chip${title.value.trim().toLowerCase() === tt.title.toLowerCase() ? ' on' : ''}`,
    onclick: () => { title.value = tt.title; otherSpan = !!lastOf(tt.title.toLowerCase())?.span; renderOther(); $('#other-note').focus(); },
  }, h('span', { class: 'key-dot', style: { background: momentCss(colors, tt.title) } }), tt.title, tt.n > 1 ? h('small', null, `${tt.n}×`) : null)));
  $('#other-quick').hidden = !titles.length;
  $('#other-manage').hidden = !store.getState().moments.length;

  segmented($('#range-other'), prefs.rangeOther, id => { prefs.rangeOther = id; savePrefs(); renderOther(); });
  const { from, to } = rangeBounds(prefs.rangeOther);
  momentsLegend($('#other-chart-legend'), { from, to });
  momentsChart($('#other-chart'), { from, to });
  renderOtherEffect(from, to, store.momentTitles(true));
  renderOtherList();
}

const momentCss = (colors, title) => `var(--c${(colors.get(title.toLowerCase()) ?? 0) + 1})`;

const hbarRow = (label, data, cls, color) => h('div', { class: 'hbar' },
  h('span', { class: 'hbar-label' }, label),
  h('div', { class: 'hbar-track' }, data.avg != null ? h('div', { class: `hbar-fill ${cls}`, style: { width: `${((data.avg - 1) / 4) * 100}%`, ...(color ? { background: color } : {}) } }) : null),
  h('span', { class: 'hbar-value' }, data.avg == null ? '–' : num1(data.avg), h('small', null, `${data.days} Tage`)));

function renderOtherEffect(from, to, titles) {
  const el = $('#other-effect');
  const moments = store.getState().moments;
  if (!moments.length) { el.replaceChildren(h('p', { class: 'empty-text' }, 'Trag ein, was du gemacht oder erlebt hast. Hier siehst du dann, wie deine Stimmung an diesen Tagen war.')); return; }
  const blocks = [];
  const colors = store.momentColors();
  const count = m => titles.find(x => x.title.toLowerCase() === m.title.toLowerCase())?.n ?? 0;
  // Recurring things (entered at least twice): days with vs. without, within the range.
  for (const tt of titles.filter(x => x.n >= 2)) {
    const c = store.momentComparison(tt.title, from, to);
    if (!c.with.days && !c.without.days) continue;
    let hint;
    if (c.with.days < 3) hint = 'Zu wenige Tage mit Stimmungseintrag im Zeitraum.';
    else if (c.without.days < 3) hint = 'Kaum Vergleichstage ohne diesen Eintrag im Zeitraum.';
    else hint = h('span', null, 'Unterschied ', deltaEl(c.with.avg - c.without.avg), ' an Tagen damit.');
    blocks.push(h('div', { class: 'compare-block' },
      h('h3', null, h('span', { class: 'med-swatch moment', style: { background: momentCss(colors, tt.title) } }), tt.title, h('span', { class: 'kind-tag' }, `${tt.n}×`)),
      h('div', { class: 'compare-rows' }, hbarRow('Mit', c.with, 'with moment', momentCss(colors, tt.title)), hbarRow('Ohne', c.without, 'without')),
      h('p', { class: 'compare-hint' }, hint)));
  }
  // Single periods: 4 weeks before, during, and up to 4 weeks after (like a medication).
  for (const m of store.momentsIn(from, to).filter(m => m.span && count(m) < 2).sort((a, b) => b.date.localeCompare(a.date))) {
    const e = store.spanEffect(m);
    const rows = [hbarRow('Davor', e.before, 'without'), hbarRow(e.ended ? 'Während' : 'Bisher', e.during, 'with moment', momentCss(colors, m.title))];
    if (e.ended) rows.push(hbarRow('Danach', e.after, 'without'));
    let hint;
    if (e.before.days < 3) hint = 'Zu wenige Einträge in den 4 Wochen davor für einen Vergleich.';
    else if (e.during.days < 3) hint = 'Noch zu wenige Tage mit Stimmungseintrag in diesem Zeitraum.';
    else hint = h('span', null, e.ended ? 'Währenddessen ' : 'Bisher ', deltaEl(e.during.avg - e.before.avg), ' im Vergleich zu den 4 Wochen davor.');
    blocks.push(h('div', { class: 'compare-block' },
      h('h3', null, h('span', { class: 'med-swatch moment span', style: { background: momentCss(colors, m.title) } }), m.title, h('span', { class: 'kind-tag' }, momentDateLabel(m))),
      h('div', { class: 'compare-rows' }, ...rows),
      h('p', { class: 'compare-hint' }, hint)));
  }
  // Single days in the range: the day against the week before and after.
  for (const m of moments.filter(m => !m.span && m.date >= from && m.date <= to && count(m) < 2).sort((a, b) => b.date.localeCompare(a.date))) {
    const w = store.momentWindow(m.date);
    const body = w.day == null
      ? [h('span', null, 'Kein Stimmungseintrag an diesem Tag.')]
      : [h('span', { class: 'vals' }, [w.before.avg != null ? `Woche davor Ø ${num1(w.before.avg)}` : null, `an dem Tag Ø ${num1(w.day)}`, w.after.avg != null ? `Woche danach Ø ${num1(w.after.avg)}` : null].filter(Boolean).join(' · ')),
        w.before.avg != null && w.after.avg != null ? deltaEl(w.after.avg - w.before.avg) : null];
    blocks.push(h('div', { class: 'event' },
      h('div', { class: 'event-date' }, formatShort(m.date)),
      h('div', null, h('div', { class: 'event-title' }, h('span', { class: 'med-swatch moment', style: { background: momentCss(colors, m.title) } }), m.title),
        h('p', { class: 'event-body' }, ...body.filter(Boolean)))));
  }
  el.replaceChildren(...(blocks.length ? blocks : [h('p', { class: 'empty-text' }, 'Im gewählten Zeitraum gibt es noch nichts auszuwerten.')]));
}

// Mood shown next to an entry: the day's average, or the average over a period so far.
function momentMood(m) {
  if (!m.span) return store.dayAverage(m.date);
  if (m.date > todayKey()) return null;
  const last = store.momentLast(m) < todayKey() ? store.momentLast(m) : todayKey();
  return store.windowAverage(m.date, last).avg;
}

function renderOtherList() {
  // Running periods first, then everything by (end) date, newest first.
  const sortKey = m => store.momentLast(m);
  const colors = store.momentColors();
  const sorted = [...store.getState().moments].sort((a, b) =>
    Number(store.momentRunning(b)) - Number(store.momentRunning(a)) || sortKey(b).localeCompare(sortKey(a)) || b.updatedAt.localeCompare(a.updatedAt));
  const moments = sorted.filter(m => !m.archived);
  const archived = sorted.filter(m => m.archived);
  const row = m => {
    const mood = momentMood(m);
    return h('button', { type: 'button', class: `other-row${m.span ? ' span' : ''}`, onclick: () => editMomentSheet(m) },
      h('span', { class: 'other-date' }, momentDateLabel(m)),
      h('span', { class: 'other-main' },
        h('span', { class: 'other-title' }, h('span', { class: m.span ? 'key-bar' : 'key-dot', style: { background: momentCss(colors, m.title) } }), m.title, !m.archived && store.momentRunning(m) ? h('span', { class: 'chip running' }, 'läuft') : null),
        m.note ? h('span', { class: 'other-note' }, m.note) : null),
      mood != null ? h('span', { class: 'other-mood', title: m.span ? 'Ø Stimmung in diesem Zeitraum' : 'Ø Stimmung an diesem Tag', style: { background: store.moodColor(Math.round(mood * 10) / 10) } }, num1(mood)) : null);
  };
  const el = $('#other-list');
  el.replaceChildren(...(moments.length
    ? moments.slice(0, otherShown).map(row)
    : [h('p', { class: 'empty-text' }, archived.length ? 'Alles ist archiviert.' : 'Noch nichts eingetragen.')]));
  $('#btn-more-other').hidden = moments.length <= otherShown;
  const archive = archiveSection('other', archived.length, archived.map(row));
  $('#other-archive').replaceChildren(...(archive ? [archive] : []));
}

function editMomentSheet(m, span = !!m.span) {
  const title = h('input', { id: 'edit-other-title', type: 'text', value: m.title, maxlength: 80, required: true, autocomplete: 'off' });
  const date = h('input', { id: 'edit-other-date', type: 'date', value: m.date, max: todayKey(), required: true });
  const end = h('input', { id: 'edit-other-end', type: 'date', value: m.span ? m.end ?? '' : '', min: m.date, max: momentEndMax() });
  const note = h('input', { id: 'edit-other-note', type: 'text', value: m.note, maxlength: 500, autocomplete: 'off' });
  date.addEventListener('change', () => { end.min = date.value; });
  const err = h('p', { class: 'form-error', hidden: true });
  // Switching keeps what was typed.
  const modeSwitch = h('div', { class: 'segmented kind-switch', role: 'radiogroup', 'aria-label': 'Dauer' });
  momentModeSwitch(modeSwitch, span, next => editMomentSheet({ ...m, title: title.value, date: date.value, note: note.value, span: next, end: end.value || null }, next));
  const running = span && m.id && store.momentRunning(store.getState().moments.find(x => x.id === m.id) ?? {});
  openSheet('Eintrag bearbeiten', h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    const values = { title: title.value, date: date.value, note: note.value, span, end: span ? end.value || null : null };
    const msg = momentError(values);
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    store.updateMoment(m.id, values);
    closeSheet();
    toast('Änderung gespeichert');
  } },
  modeSwitch,
  field('Eintrag', title),
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
      h('dt', null, 'Anderes'), h('dd', null, String(st.moments.length)),
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
$('#other-toggle').addEventListener('click', () => {
  prefs.kindFilter = prefs.kindFilter === 'other' ? (prefs.lastKind || 'all') : 'other';
  savePrefs();
  renderMedis();
});
$('#other-form').addEventListener('submit', e => {
  e.preventDefault();
  const title = $('#other-title'), date = $('#other-date'), end = $('#other-end'), note = $('#other-note'), err = $('#other-error');
  err.hidden = true;
  const entry = { date: date.value, title: title.value, note: note.value, span: otherSpan, end: otherSpan ? end.value || null : null };
  const msg = momentError(entry);
  if (msg) { err.textContent = msg; err.hidden = false; return; }
  title.value = ''; note.value = ''; end.value = '';
  store.addMoment(entry);
  toast(`${entry.title.trim()} eingetragen`);
});
$('#other-title').addEventListener('input', () => {
  const v = $('#other-title').value.trim().toLowerCase();
  document.querySelectorAll('#other-quick .quick-chip').forEach(b => b.classList.toggle('on', b.firstChild.textContent.toLowerCase() === v));
});
$('#other-date').addEventListener('change', () => { $('#other-end').min = $('#other-date').value; });
// "Einträge" is open by default, "Notiz" folded. A tap opens one, another tap on it closes it.
function showEntryTab(tab) {
  for (const name of ['other', 'note']) {
    const open = tab === name;
    $(`#tab-${name}`).setAttribute('aria-expanded', String(open));
    $(`#tab-${name}`).classList.toggle('open', open);
    $(`#panel-${name}`).hidden = !open;
  }
}
let entryTab = 'other';   // "Einträge" starts open, "Notiz" folded
for (const name of ['other', 'note']) {
  $(`#tab-${name}`).addEventListener('click', () => { entryTab = entryTab === name ? null : name; showEntryTab(entryTab); });
}
showEntryTab(entryTab);
$('#today-other-add').addEventListener('click', addTodayOther);
$('#today-other-manage').addEventListener('click', activitiesSheet);
$('#other-manage').addEventListener('click', activitiesSheet);
$('#today-other-input').addEventListener('keydown', e => { if (e.key === 'Enter') { e.preventDefault(); addTodayOther(); } });
$('#btn-more-other').addEventListener('click', () => { otherShown += 30; renderOtherList(); });
$('#med-details').addEventListener('toggle', e => {
  if (autoToggle) { autoToggle = false; return; }
  if (prefs.medListOpen !== e.target.open) { prefs.medListOpen = e.target.open; savePrefs(); }
});
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
