import { api } from './api.js';
import { $, $$, el, clamp, setBusy, showToast } from './lib/dom.js';
import { ratioLabel } from './ratio.js';
import './nav.js';

const SIZE_PRESETS = [
  { width: 1920, height: 1080, label: 'Full HD' },
  { width: 2560, height: 1440, label: 'QHD' },
  { width: 3440, height: 1440, label: 'Ultrawide' },
  { width: 3840, height: 2160, label: '4K UHD' },
  { width: 2880, height: 1800, label: 'Retina 16:10' },
  { width: 2560, height: 1600, label: 'WQXGA' },
  { width: 1920, height: 1200, label: 'WUXGA' },
  { width: 1366, height: 768, label: 'Laptop HD' },
];

const state = {
  options: null,
  saving: false,
};

const dom = {};

function cacheDom() {
  Object.assign(dom, {
    width: $('#canvasWidth'),
    height: $('#canvasHeight'),
    ratioValue: $('#ratioValue'),
    ratioDetail: $('#ratioDetail'),
    sizePresets: $('#sizePresets'),
    lightStart: $('#lightStart'),
    darkStart: $('#darkStart'),
    activeTheme: $('#activeTheme'),
    scheduleSummary: $('#scheduleSummary'),
    backendList: $('#backendList'),
    customField: $('#customCommandField'),
    customCommand: $('#customCommand'),
    outputHint: $('#outputHint'),
    configChip: $('#configChip'),
    save: $('#btnSaveOptions'),
    saveBottom: $('#btnSaveOptionsBottom'),
  });
}

function values() {
  return {
    width: clamp(Math.round(Number(dom.width.value) || 0), 320, 8192),
    height: clamp(Math.round(Number(dom.height.value) || 0), 320, 8192),
    dayStart: dom.lightStart.value,
    dayEnd: dom.darkStart.value,
    backend: dom.backendList.querySelector('input[name="backend"]:checked')?.value || '',
    applyCommand: dom.customCommand.value.trim(),
  };
}

function hhmm(date = new Date()) {
  return `${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`;
}

/** Mirrors ``Config.theme_for``: the day window may wrap over midnight. */
function activeTheme(dayStart, dayEnd) {
  if (!dayStart || !dayEnd || dayStart === dayEnd) return null;
  const now = hhmm();
  const light = dayStart < dayEnd
    ? now >= dayStart && now < dayEnd
    : now >= dayStart || now < dayEnd;
  return light ? 'light' : 'dark';
}

function renderSchedule() {
  const { dayStart, dayEnd } = values();
  const active = activeTheme(dayStart, dayEnd);
  dom.activeTheme.textContent = active
    ? `${active === 'light' ? 'Light' : 'Dark'} now`
    : 'Set both times';
  dom.activeTheme.classList.toggle('is-light', active === 'light');
  dom.activeTheme.classList.toggle('is-dark', active !== 'light');
  dom.scheduleSummary.textContent = active
    ? `Light ${dayStart} – ${dayEnd} · Dark ${dayEnd} – ${dayStart}`
    : 'Light and dark need different start times.';
}

function renderRatio() {
  const width = Math.max(1, Number(dom.width.value) || 0);
  const height = Math.max(1, Number(dom.height.value) || 0);
  dom.ratioValue.textContent = ratioLabel(width, height);
  dom.ratioDetail.textContent = `${width} × ${height} · ${(width / height).toFixed(4)}`;
}

function renderSizePresets() {
  const { width, height } = values();
  dom.sizePresets.replaceChildren(
    ...SIZE_PRESETS.map((preset) => {
      const active = preset.width === width && preset.height === height;
      const button = el(
        'button',
        {
          class: `size-chip${active ? ' is-active' : ''}`,
          type: 'button',
          title: `${preset.label} · ${ratioLabel(preset.width, preset.height)}`,
        },
        el('strong', {}, `${preset.width} × ${preset.height}`),
        el('small', {}, `${preset.label} · ${ratioLabel(preset.width, preset.height)}`),
      );
      button.addEventListener('click', () => {
        dom.width.value = String(preset.width);
        dom.height.value = String(preset.height);
        renderRatio();
        renderSizePresets();
      });
      return button;
    }),
  );
}

function renderCustomField() {
  const { backend } = values();
  dom.customField.hidden = backend !== 'custom';
}

function renderBackends() {
  const backends = state.options?.wallpaper?.backends || [];
  const current = state.options?.wallpaper?.backend || 'hyprland-caelestia';
  dom.backendList.replaceChildren(
    ...backends.map((backend) => {
      const input = el('input', {
        type: 'radio',
        name: 'backend',
        value: backend.id,
        checked: backend.id === current,
      });
      input.addEventListener('change', renderCustomField);
      const badge = backend.id === 'custom'
        ? (state.options?.wallpaper?.applyCommand ? 'configured' : 'no command yet')
        : backend.available
          ? 'detected'
          : 'not installed';
      return el(
        'label',
        { class: `backend-option${backend.id === current ? ' is-active' : ''}` },
        input,
        el(
          'span',
          { class: 'backend-text' },
          el('strong', {}, backend.label),
          el('small', {}, backend.detail),
        ),
        el(
          'span',
          {
            class: `backend-badge${backend.available || backend.id === 'custom' ? '' : ' is-off'}`,
          },
          badge,
        ),
      );
    }),
  );
  renderCustomField();
}

function fill(options) {
  state.options = options;
  dom.width.value = String(options.canvas.width);
  dom.height.value = String(options.canvas.height);
  dom.lightStart.value = options.theme?.dayStart || '07:00';
  dom.darkStart.value = options.theme?.dayEnd || '19:00';
  dom.customCommand.value = options.wallpaper.applyCommand || '';
  dom.configChip.textContent = `${options.canvas.width} × ${options.canvas.height}`;
  dom.outputHint.textContent = `Wallpapers are written to ${options.wallpaper.outputPath}`;
  renderRatio();
  renderSizePresets();
  renderSchedule();
  renderBackends();
}

async function save() {
  if (state.saving) return;
  const current = values();
  if (current.backend === 'custom' && !current.applyCommand) {
    showToast('Type the custom wallpaper command first.', { type: 'error' });
    dom.customCommand.focus();
    return;
  }
  if (!current.dayStart || !current.dayEnd) {
    showToast('Set both the light and the dark start time.', { type: 'error' });
    return;
  }
  if (current.dayStart === current.dayEnd) {
    showToast('Light and dark need different start times.', { type: 'error' });
    dom.darkStart.focus();
    return;
  }
  state.saving = true;
  [dom.save, dom.saveBottom].forEach((button) => setBusy(button, true, 'Saving…'));
  try {
    const result = await api.saveOptions({
      canvas: { width: current.width, height: current.height },
      theme: { dayStart: current.dayStart, dayEnd: current.dayEnd },
      wallpaper: { backend: current.backend, applyCommand: current.applyCommand },
    });
    fill(result.options);
    const where = result.options.configFile || '~/.config/hyprwall/config.json';
    showToast(`Options saved to ${where}`, { type: 'success', timeout: 9000 });
  } catch (error) {
    showToast(error.message, { type: 'error', timeout: 10000 });
  } finally {
    state.saving = false;
    [dom.save, dom.saveBottom].forEach((button) => setBusy(button, false));
  }
}

function bindUi() {
  [dom.width, dom.height].forEach((input) => {
    input.addEventListener('input', () => {
      renderRatio();
      renderSizePresets();
    });
  });
  [dom.lightStart, dom.darkStart].forEach((input) => {
    input.addEventListener('input', renderSchedule);
    input.addEventListener('change', renderSchedule);
  });
  // The "active now" badge follows the clock while the page stays open.
  setInterval(renderSchedule, 60_000);
  dom.save.addEventListener('click', save);
  dom.saveBottom.addEventListener('click', save);
  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest('input, textarea, select');
    if (!typing && (event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      save();
    }
  });
}

async function boot() {
  cacheDom();
  try {
    fill(await api.getOptions());
  } catch (error) {
    showToast(`Could not load options: ${error.message}`, { type: 'error', timeout: 0 });
    return;
  }
  bindUi();
}

boot();
