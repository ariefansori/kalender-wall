/**
 * Wallpaper test page: renders the *final* composed wallpaper for a simulated
 * date and time, on screen only.  Nothing here touches the desktop wallpaper —
 * the backend composites the preset exactly like `hyprwall apply --no-apply`.
 */
import './nav.js';
import { api } from './api.js';
import { $, $$, el, showToast } from './lib/dom.js';
import { ratioLabel } from './ratio.js';

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];

function isoToday() {
  const now = new Date();
  return `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
}

function hhmm(date) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

function parseIso(value) {
  const [year, month, day] = String(value).split('-').map(Number);
  return new Date(year, (month || 1) - 1, day || 1);
}

function shiftDay(iso, days) {
  const date = parseIso(iso);
  date.setDate(date.getDate() + days);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`;
}

function minutesOf(value) {
  const [hours, minutes] = String(value).split(':').map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

const state = {
  config: null,
  presets: [],
  slug: null,
  date: isoToday(),
  time: hhmm(new Date()),
  loading: false,
  objectUrl: null,
  timer: null,
};

const dom = {};

function cacheDom() {
  Object.assign(dom, {
    presetList: $('#presetList'),
    dateInput: $('#dateInput'),
    timeInput: $('#timeInput'),
    frame: $('#previewFrame'),
    image: $('#previewImage'),
    status: $('#testStatus'),
    meta: $('#testMeta'),
    chip: $('#testChip'),
    random: $('#btnRandom'),
    today: $('#btnToday'),
    prevDay: $('#btnPrevDay'),
    nextDay: $('#btnNextDay'),
    randomDay: $('#btnRandomDay'),
    timePresets: $('#timePresets'),
  });
}

/** Which theme the configured day/night window would pick at ``time``. */
function themeFor(time) {
  const dayStart = state.config?.timeWindow?.dayStart || '07:00';
  const dayEnd = state.config?.timeWindow?.dayEnd || '19:00';
  const now = minutesOf(time);
  const start = minutesOf(dayStart);
  const end = minutesOf(dayEnd);
  const isDay = start <= end ? now >= start && now < end : now >= start || now < end;
  return isDay ? 'light' : 'dark';
}

function setStatus(text, { error = false, loading = false } = {}) {
  dom.status.textContent = text;
  dom.status.classList.toggle('is-error', error);
  dom.frame.classList.toggle('is-loading', loading);
}

function renderMeta() {
  const preset = state.presets.find((item) => item.slug === state.slug);
  const date = parseIso(state.date);
  const theme = themeFor(state.time);
  const parts = [
    el('span', {}, 'Date ', el('strong', {}, `${WEEKDAYS[date.getDay()]} ${date.getDate()} ${MONTHS[date.getMonth()]} ${date.getFullYear()}`)),
    el('span', {}, 'Time ', el('strong', {}, state.time)),
    el('span', {}, 'Theme at that time ', el('strong', {}, theme)),
    preset ? el('span', {}, 'Preset ', el('strong', {}, preset.name)) : null,
    preset ? el('span', {}, `${preset.width}×${preset.height} · ${preset.widgetCount} widget${preset.widgetCount === 1 ? '' : 's'}`) : null,
    preset
      ? el(
          'span',
          { class: preset.ratioMatch === false ? 'is-warn' : '' },
          `source ${preset.ratioLabel} · canvas ${ratioLabel(state.config.canvas.width, state.config.canvas.height)}`,
          preset.ratioMatch === false ? ' · mismatch (not applicable)' : '',
        )
      : null,
  ];
  dom.meta.replaceChildren(...parts.filter(Boolean));
  dom.chip.textContent = preset ? `${preset.name} · ${theme}` : 'Wallpaper test';
}

function renderPresetList() {
  dom.presetList.replaceChildren();
  if (!state.presets.length) {
    dom.presetList.append(el('p', { class: 'hint' }, 'No presets yet — save one in the editor.'));
    return;
  }
  for (const preset of state.presets) {
    const button = el(
      'button',
      {
        class: `test-preset${preset.slug === state.slug ? ' is-active' : ''}`,
        type: 'button',
        title: `Preview ${preset.name}`,
      },
      el('img', { src: preset.thumbnailUrl, alt: '', loading: 'lazy', draggable: 'false' }),
      el(
        'span',
        {},
        el('strong', {}, preset.name),
        el(
          'small',
          {},
          `${preset.theme} · ${preset.ratioLabel}`,
          preset.ratioMatch === false ? ' · ratio mismatch' : '',
        ),
      ),
    );
    button.addEventListener('click', () => {
      state.slug = preset.slug;
      renderPresetList();
      schedule(0);
    });
    dom.presetList.append(button);
  }
}

function chooseRandomPreset() {
  if (!state.presets.length) return;
  const usable = state.presets.filter((preset) => preset.ratioMatch !== false);
  if (!usable.length) {
    showToast(
      'No preset matches the canvas ratio — adapt one in the editor first.',
      { type: 'warn', timeout: 9000 },
    );
    return;
  }
  const theme = themeFor(state.time);
  const matching = usable.filter((preset) => preset.theme === theme);
  const pool = matching.length ? matching : usable;
  const candidates = pool.length > 1 ? pool.filter((preset) => preset.slug !== state.slug) : pool;
  const pick = candidates[Math.floor(Math.random() * candidates.length)];
  state.slug = pick.slug;
  renderPresetList();
  schedule(0);
}

async function renderPreview() {
  if (!state.slug) return;
  window.clearTimeout(state.timer);
  state.timer = null;
  setStatus('Rendering…', { loading: true });
  try {
    const data = await api.getPreset(state.slug);
    const blob = await api.renderDraft(data.preset, state.slug, state.date);
    if (state.objectUrl) URL.revokeObjectURL(state.objectUrl);
    state.objectUrl = URL.createObjectURL(blob);
    dom.image.src = state.objectUrl;
    await dom.image.decode?.().catch(() => {});
    setStatus(`Rendered ${data.preset.canvas.width}×${data.preset.canvas.height} · ${state.date}`);
    renderMeta();
  } catch (error) {
    setStatus(error.message, { error: true });
    showToast(error.message, { type: 'error', timeout: 9000 });
  }
}

function schedule(delay = 180) {
  renderMeta();
  window.clearTimeout(state.timer);
  state.timer = window.setTimeout(renderPreview, delay);
}

function setDate(value) {
  state.date = value || isoToday();
  dom.dateInput.value = state.date;
  schedule();
}

function markTimePreset() {
  $$('[data-time]', dom.timePresets).forEach((button) => {
    const active = Math.abs(minutesOf(button.dataset.time) - minutesOf(state.time)) <= 60;
    button.classList.toggle('is-active', active);
  });
}

function setTime(value) {
  state.time = value || '12:00';
  dom.timeInput.value = state.time;
  markTimePreset();
  schedule();
}

async function loadPresets() {
  try {
    const data = await api.listPresets();
    state.presets = data.presets || [];
  } catch (error) {
    showToast(`Could not load presets: ${error.message}`, { type: 'error', timeout: 9000 });
    state.presets = [];
  }
  renderPresetList();
  if (state.presets.length) {
    const theme = themeFor(state.time);
    const usable = state.presets.filter((preset) => preset.ratioMatch !== false);
    const preferred =
      usable.find((preset) => preset.theme === theme) || usable[0] || state.presets[0];
    state.slug = preferred.slug;
    renderPresetList();
    schedule(0);
  } else {
    renderMeta();
    setStatus('No presets', { error: true });
  }
}

function bindUi() {
  dom.dateInput.addEventListener('change', () => setDate(dom.dateInput.value));
  dom.timeInput.addEventListener('change', () => setTime(dom.timeInput.value));
  dom.today.addEventListener('click', () => {
    setTime(hhmm(new Date()));
    setDate(isoToday());
  });
  dom.prevDay.addEventListener('click', () => setDate(shiftDay(state.date, -1)));
  dom.nextDay.addEventListener('click', () => setDate(shiftDay(state.date, 1)));
  dom.randomDay.addEventListener('click', () => {
    const offset = Math.round((Math.random() * 2 - 1) * 120);
    setDate(shiftDay(isoToday(), offset));
  });
  dom.random.addEventListener('click', chooseRandomPreset);
  $$('[data-time]', dom.timePresets).forEach((button) => {
    button.addEventListener('click', () => setTime(button.dataset.time));
  });
  markTimePreset();
}

async function boot() {
  cacheDom();
  try {
    state.config = await api.getConfig();
  } catch (error) {
    showToast(`Could not reach the HyprWall backend: ${error.message}`, { type: 'error', timeout: 0 });
    return;
  }
  dom.dateInput.value = state.date;
  dom.timeInput.value = state.time;
  bindUi();
  await loadPresets();
}

boot();
