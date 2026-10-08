import * as store from './store.js';
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
      'aria-label': `${sl.label}${e ? ` – eingetragen: ${store.moodLabel(e.mood)}` : ' – noch offen'}`,
      onclick: () => { form.slot = sl.id; form.touched = true; loadFormEntry(); renderHeute(); },
    }, h('span', { class: `slot-dot${e ? ' filled' : ''}`, style: e ? { background: `var(--m${e.mood})` } : null }), sl.label);
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
    type: 'button', class: 'mood', role: 'radio', 'aria-checked': String(form.mood === m.value),
    style: { '--mc': `var(--m${m.value})` },
    onclick: () => { form.mood = m.value; form.dirty = true; renderHeute(); },
  }, h('span', { class: 'mood-face' }, face(m.value)), m.label)));
  $('#mood-caption').textContent = form.mood
    ? (existing && !form.dirty ? `Eingetragen: ${store.moodLabel(form.mood)}` : `${form.mood} von 5 · ${store.moodLabel(form.mood)}`)
    : 'Tippe auf ein Gesicht.';

  const save = $('#btn-save');
  save.disabled = !form.mood || (existing && !form.dirty);
  save.textContent = existing ? (form.dirty ? 'Änderung speichern' : 'Gespeichert') : `${slotName} speichern`;
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
        style: e ? { background: `var(--m${e.mood})` } : null,
        'aria-label': `${formatWeekday(d)} ${formatDayMonth(d)}, ${sl.label}: ${e ? store.moodLabel(e.mood) : 'kein Eintrag'}`,
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
    const existing = store.getEntry(form.date, form.slot);
    const save = $('#btn-save');
    save.disabled = !form.mood;
    if (existing) save.textContent = 'Änderung speichern';
  });

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
        h('span', { class: 'entry-face', style: { background: `var(--m${e.mood})` } }, face(e.mood)),
        h('span', { class: 'entry-main' },
          h('span', { class: 'entry-title' }, store.moodLabel(e.mood), h('span', null, ` · ${sl.label}`)),
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
    h('p', { class: 'sheet-text' }, 'Alles, was du einträgst, bleibt nur in diesem Browser auf diesem Gerät. Es wird nichts an einen Server geschickt.'),
    h('dl', { class: 'info-list' },
      h('dt', null, 'Einträge'), h('dd', null, String(st.entries.length)),
      h('dt', null, 'Medikamente'), h('dd', null, String(st.meds.length)),
      h('dt', null, 'Letzte Sicherung'), h('dd', null, last ? formatShort(last.slice(0, 10)) : 'noch nie')),

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
      armedButton('Alle Daten löschen', 'Wirklich alles löschen? Nochmal tippen', () => { store.wipeAll(); closeSheet(); toast('Alle Daten gelöscht'); }, 'btn danger')),
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

/* ---------------- banners ---------------- */

function renderBanners() {
  const el = $('#banners');
  const items = [];
  if (!store.isStorageAvailable()) {
    items.push(h('div', { class: 'banner warn' }, h('span', null, h('strong', null, 'Speichern nicht möglich. '), 'Dein Browser blockiert den Speicher (z. B. im privaten Modus). Einträge gehen beim Schließen verloren.')));
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
store.subscribe(() => renderView());
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
