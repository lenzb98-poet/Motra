import * as store from './store.js';
import * as sync from './sync.js';
import { moodChart, moodLegend, medChart, medLegend, eventText } from './charts.js';
import {
  h, s, icon, todayKey, addDays, diffDays, formatLong, formatDayMonth, formatShort, formatWeekday,
  relativeDay, num1, signed1,
} from './util.js';

const $ = sel => document.querySelector(sel);

/* ---------------- preferences (per device conveniences) ---------------- */

const PREFS_KEY = 'motra.prefs';
const LEGACY_PREFS_KEY = 'sutra.prefs';
let prefs = { rangeVerlauf: '30', rangeMedis: '90' };
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

/* ================= MEDIKAMENTE ================= */

function medStatus(med) {
  const open = store.openPhase(med);
  const last = store.lastPhase(med);
  return open
    ? { active: true, dose: open.dose, text: `seit ${formatDayMonth(open.start)}` }
    : { active: false, dose: last.dose, text: `zuletzt genommen am ${formatDayMonth(last.end)}` };
}

function medHistory(med) {
  return store.medEvents(med).map(ev => {
    const d = formatShort(ev.date);
    if (ev.type === 'start') return `Begonnen ${d}${ev.dose ? ` mit ${ev.dose}` : ''}`;
    if (ev.type === 'restart') return `Wieder begonnen ${d}${ev.dose ? ` mit ${ev.dose}` : ''}`;
    if (ev.type === 'dose') return `${d}: ${ev.prevDose || '–'} → ${ev.dose || '–'}`;
    return `Abgesetzt ab ${d}`;
  }).join(' · ');
}

function renderMedis() {
  const meds = store.getState().meds;
  $('#med-list').replaceChildren(...meds.map(m => {
    const st = medStatus(m);
    return h('article', { class: 'card med-card' },
      h('div', { class: 'med-head' },
        h('span', { class: 'med-swatch', style: { background: `var(--c${m.color + 1})` } }),
        h('h3', { class: 'med-name' }, m.name),
        h('span', { class: `chip${st.active ? ' active' : ''}` }, st.active ? 'Nehme ich' : 'Abgesetzt')),
      h('div', { class: 'med-dose' }, h('strong', null, st.dose || 'Ohne Dosis'), h('span', null, st.text)),
      h('p', { class: 'med-history' }, medHistory(m)),
      h('div', { class: 'med-actions' },
        st.active
          ? [h('button', { type: 'button', class: 'btn small', onclick: () => doseSheet(m) }, 'Dosis ändern'),
            h('button', { type: 'button', class: 'btn small', onclick: () => stopSheet(m) }, 'Absetzen')]
          : h('button', { type: 'button', class: 'btn small', onclick: () => doseSheet(m, true) }, 'Wieder einnehmen'),
        h('button', { type: 'button', class: 'btn small ghost', onclick: () => editSheet(m) }, 'Bearbeiten')));
  }));
  if (!meds.length) {
    $('#med-list').replaceChildren(h('p', { class: 'empty-text' }, 'Trag deine Medikamente mit Dosis und Startdatum ein. Danach siehst du unten, wie deine Stimmung dazu verlaufen ist.'));
  }

  segmented($('#range-medis'), prefs.rangeMedis, id => { prefs.rangeMedis = id; savePrefs(); renderMedis(); });
  const { from, to } = rangeBounds(prefs.rangeMedis);
  medLegend($('#med-chart-legend'));
  medChart($('#med-chart'), { from, to });
  renderCompare(from, to);
  renderEvents();
}

function renderCompare(from, to) {
  const meds = store.getState().meds;
  const el = $('#compare');
  if (!meds.length) { el.replaceChildren(h('p', { class: 'empty-text' }, 'Noch keine Medikamente eingetragen.')); return; }
  const MIN = 5;
  el.replaceChildren(...meds.map(m => {
    const c = store.medComparison(m, from, to);
    const row = (label, data, cls) => h('div', { class: 'hbar' },
      h('span', { class: 'hbar-label' }, label),
      h('div', { class: 'hbar-track' }, data.avg != null ? h('div', { class: `hbar-fill ${cls}`, style: { width: `${((data.avg - 1) / 4) * 100}%`, background: cls === 'with' ? `var(--c${m.color + 1})` : null } }) : null),
      h('span', { class: 'hbar-value' }, data.avg == null ? '–' : num1(data.avg), h('small', null, `${data.days} Tage`)));
    let hint = null;
    if (c.with.days < MIN && c.without.days < MIN) hint = 'Zu wenige Tage mit Einträgen im Zeitraum.';
    else if (c.without.days < MIN) hint = 'Im Zeitraum fast durchgehend eingenommen, deshalb gibt es kaum Vergleichstage. Wähle einen längeren Zeitraum.';
    else if (c.with.days < MIN) hint = 'Im Zeitraum kaum eingenommen.';
    else {
      const d = c.with.avg - c.without.avg;
      hint = h('span', null, 'Unterschied ', deltaEl(d), ' an Tagen mit Einnahme.');
    }
    return h('div', { class: 'compare-block' },
      h('h3', null, h('span', { class: 'med-swatch', style: { background: `var(--c${m.color + 1})` } }), m.name),
      h('div', { class: 'compare-rows' }, row('Mit', c.with, 'with'), row('Ohne', c.without, 'without')),
      h('p', { class: 'compare-hint' }, hint));
  }));
}

function renderEvents() {
  const el = $('#events');
  const events = store.getState().meds.flatMap(m => store.medEvents(m)).filter(e => e.date <= todayKey())
    .sort((a, b) => b.date.localeCompare(a.date));
  if (!events.length) { el.replaceChildren(h('p', { class: 'empty-text' }, 'Hier erscheint jeder Beginn, jede Dosisänderung und jedes Absetzen mit dem Stimmungsvergleich davor und danach.')); return; }
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

/* ---------- medication sheets ---------- */

function dateInputEl(id, value, { min, max } = {}) {
  const el = h('input', { type: 'date', id, value, min, max: max ?? todayKey(), required: true });
  return el;
}

function addMedSheet() {
  const name = h('input', { id: 'med-name', type: 'text', placeholder: 'z. B. Sertralin', maxlength: 60, required: true, autocomplete: 'off' });
  const dose = h('input', { id: 'med-dose', type: 'text', placeholder: 'z. B. 50 mg', maxlength: 60, autocomplete: 'off' });
  const start = dateInputEl('med-start', todayKey());
  const err = h('p', { class: 'form-error', hidden: true });
  const f = h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) { err.textContent = 'Bitte gib einen Namen ein.'; err.hidden = false; return; }
    if (!start.value) { err.textContent = 'Bitte wähle ein Startdatum.'; err.hidden = false; return; }
    store.addMed({ name: name.value, dose: dose.value, start: start.value });
    closeSheet();
    toast(`${name.value.trim()} hinzugefügt`);
  } },
  field('Name', name),
  h('div', { class: 'field-row' }, field('Dosis', dose), field('Nehme ich seit', start)),
  h('p', { class: 'sheet-text' }, 'Wenn du das Medikament schon länger nimmst, wähle das ungefähre Startdatum. So passt der Verlauf.'),
  err,
  h('div', { class: 'sheet-actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Hinzufügen')));
  openSheet('Medikament hinzufügen', f);
  setTimeout(() => name.focus(), 50);
}

function doseSheet(med, restart = false) {
  const open = store.openPhase(med);
  const last = store.lastPhase(med);
  const min = restart ? addDays(last.end, 1) : open.start;
  const dose = h('input', { id: 'dose-new', type: 'text', value: restart ? last.dose : '', placeholder: 'z. B. 100 mg', maxlength: 60, autocomplete: 'off' });
  const date = dateInputEl('dose-date', todayKey() < min ? min : todayKey(), { min });
  const f = h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    if (!date.value || date.value < min) return;
    store.changeDose(med.id, dose.value, date.value);
    closeSheet();
    toast(restart ? `${med.name} wieder aufgenommen` : 'Neue Dosis gespeichert');
  } },
  restart ? null : h('p', { class: 'sheet-text' }, `Aktuell: ${open.dose || 'ohne Dosis'} seit ${formatShort(open.start)}.`),
  h('div', { class: 'field-row' }, field(restart ? 'Dosis' : 'Neue Dosis', dose), field(restart ? 'Wieder ab' : 'Gilt ab', date)),
  h('div', { class: 'sheet-actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Speichern')));
  openSheet(restart ? `${med.name} wieder einnehmen` : `Dosis von ${med.name}`, f);
  setTimeout(() => dose.focus(), 50);
}

function stopSheet(med) {
  const open = store.openPhase(med);
  const date = dateInputEl('stop-date', todayKey(), { min: open.start, max: todayKey() });
  const f = h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    if (!date.value) return;
    store.stopMed(med.id, date.value);
    closeSheet();
    toast(`${med.name} als abgesetzt gespeichert`);
  } },
  field('Letzter Einnahmetag', date),
  h('p', { class: 'sheet-text' }, 'Das Medikament bleibt mit seinem Verlauf erhalten. Du kannst es später wieder aufnehmen.'),
  h('div', { class: 'sheet-actions' }, h('button', { type: 'submit', class: 'btn primary' }, 'Absetzen')));
  openSheet(`${med.name} absetzen`, f);
}

function editSheet(med) {
  const name = h('input', { id: 'edit-name', type: 'text', value: med.name, maxlength: 60, required: true, autocomplete: 'off' });
  const phases = med.phases.map(p => ({ ...p }));
  const list = h('div', { class: 'phase-list' });
  const err = h('p', { class: 'form-error', hidden: true });

  const renderPhases = () => {
    list.replaceChildren(...phases.map((p, i) => {
      const dose = h('input', { type: 'text', id: `ph-dose-${i}`, value: p.dose, maxlength: 60, placeholder: 'Dosis', oninput: e => { p.dose = e.target.value; } });
      const start = h('input', { type: 'date', id: `ph-start-${i}`, value: p.start, max: todayKey(), oninput: e => { p.start = e.target.value; } });
      const end = h('input', { type: 'date', id: `ph-end-${i}`, value: p.end ?? '', max: todayKey(), oninput: e => { p.end = e.target.value || null; } });
      return h('div', { class: 'phase' },
        field('Dosis', dose, 'dose'),
        field('Von', start),
        field('Bis', end),
        phases.length > 1 ? h('button', { type: 'button', class: 'btn small ghost danger remove', onclick: () => { phases.splice(i, 1); renderPhases(); } }, 'Zeitraum entfernen') : null);
    }));
  };
  renderPhases();

  const f = h('form', { class: 'sheet-body', onsubmit: e => {
    e.preventDefault();
    if (!name.value.trim()) { err.textContent = 'Bitte gib einen Namen ein.'; err.hidden = false; return; }
    const msg = store.validatePhases(phases);
    if (msg) { err.textContent = msg; err.hidden = false; return; }
    store.updateMed(med.id, { name: name.value, phases });
    closeSheet();
    toast('Änderungen gespeichert');
  } },
  field('Name', name),
  h('div', { class: 'field' }, h('span', { class: 'label' }, 'Einnahme-Zeiträume'), list,
    h('p', { class: 'sheet-text' }, 'Lass „Bis“ leer, solange du das Medikament noch nimmst.')),
  h('button', { type: 'button', class: 'btn dashed', onclick: () => {
    const lastP = phases[phases.length - 1];
    const startNew = lastP?.end ? addDays(lastP.end, 1) : todayKey();
    if (lastP && !lastP.end) lastP.end = addDays(todayKey(), -1) < lastP.start ? lastP.start : addDays(todayKey(), -1);
    phases.push({ dose: lastP?.dose ?? '', start: startNew > todayKey() ? todayKey() : startNew, end: null });
    renderPhases();
  } }, icon('i-plus'), 'Zeitraum hinzufügen'),
  err,
  h('div', { class: 'sheet-actions' },
    armedButton('Medikament löschen', 'Wirklich löschen? Nochmal tippen', () => { store.deleteMed(med.id); closeSheet(); toast(`${med.name} gelöscht`); }),
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
      h('dt', null, 'Medikamente'), h('dd', null, String(st.meds.length)),
      h('dt', null, 'Letzte Sicherung'), h('dd', null, last ? formatShort(last.slice(0, 10)) : 'noch nie')),

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
      h('p', { class: 'sheet-text' }, 'Eine Tabelle mit allen Einträgen und den Medikamenten des jeweiligen Tages. Sie öffnet sich in Excel, Numbers oder Google Tabellen.'),
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
    h('p', { class: 'sheet-text' }, `Die Sicherung enthält ${preview.entries.length} Einträge und ${preview.meds.length} Medikamente.`),
    cur.entries.length || cur.meds.length
      ? h('p', { class: 'sheet-text' }, `Sie ersetzt deine aktuellen Daten (${cur.entries.length} Einträge, ${cur.meds.length} Medikamente).`)
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
$('#btn-add-med').addEventListener('click', addMedSheet);
$('#btn-more-entries').addEventListener('click', () => { listDays += 14; renderEntryList(); });

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
  if (realEntries >= 21 && (daysSince == null || daysSince >= 14) && currentView === 'heute') {
    items.push(h('div', { class: 'banner' },
      h('span', null, last ? `Letzte Sicherung vor ${daysSince} Tagen.` : 'Du hast noch keine Sicherung deiner Einträge.'),
      h('button', { type: 'button', class: 'btn small', onclick: settingsSheet }, 'Jetzt sichern')));
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
