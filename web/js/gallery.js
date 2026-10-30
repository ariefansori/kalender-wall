import './nav.js';
import { api } from './api.js';
import { loadFonts } from './fonts.js';
import { $, el, formatDate, setBusy, showToast } from './lib/dom.js';
import { ratioLabel } from './ratio.js';

const state = {
  config: null,
  presets: [],
  stats: { total: 0, light: 0, dark: 0 },
  filter: 'all',
};

const dom = {
  grid: $('#galleryGrid'),
  empty: $('#galleryEmpty'),
  stats: $('#galleryStats'),
  filters: $('#galleryFilters'),
  bar: $('#galleryBar'),
};

function renderStats() {
  const { total, light, dark, matching } = state.stats;
  const canvas = state.config.canvas;
  dom.stats.replaceChildren(
    el('span', {}, el('strong', {}, String(total)), ' presets'),
    el('span', {}, el('strong', {}, String(light)), ' light'),
    el('span', {}, el('strong', {}, String(dark)), ' dark'),
    el(
      'span',
      { title: 'Presets whose source ratio matches the canvas ratio' },
      el('strong', {}, `${matching ?? total}/${total}`),
      ' usable',
    ),
    el(
      'span',
      { title: 'Configure the canvas on the Options page' },
      'canvas ',
      el('strong', {}, `${canvas.width}×${canvas.height} · ${ratioLabel(canvas.width, canvas.height)}`),
    ),
    el('span', {}, 'window ', el('strong', {}, state.config.timeWindow.dayStart), '–', el('strong', {}, state.config.timeWindow.dayEnd)),
  );
  dom.stats.title = `Presets live in ${state.config.presetsDir}`;
}

function renderFilters() {
  const filters = [
    ['all', 'All', state.presets.length],
    ['light', 'Light', state.stats.light],
    ['dark', 'Dark', state.stats.dark],
  ];
  dom.filters.replaceChildren(
    ...filters.map(([value, label, count]) => {
      const button = el(
        'button',
        {
          class: `filter${state.filter === value ? ' is-active' : ''}`,
          type: 'button',
        },
        label,
        el('span', {}, String(count)),
      );
      button.addEventListener('click', () => {
        state.filter = value;
        render();
      });
      return button;
    }),
  );
}

function visiblePresets() {
  if (state.filter === 'all') return state.presets;
  return state.presets.filter((preset) => preset.theme === state.filter);
}

function renderSkeleton() {
  dom.empty.hidden = true;
  dom.grid.replaceChildren(
    ...Array.from({ length: 3 }, () =>
      el('div', { class: 'gallery-skeleton' }, el('div', { class: 'skeleton-thumb' })),
    ),
  );
}

function renderEmpty(message) {
  dom.grid.replaceChildren();
  dom.empty.hidden = false;
  const heading = dom.empty.querySelector('h2');
  if (heading) heading.textContent = message || 'No presets yet';
}

function applyButton(preset) {
  const mismatch = preset.ratioMatch === false;
  const button = el(
    'button',
    {
      class: 'btn btn-accent',
      type: 'button',
      disabled: mismatch,
      title: mismatch
        ? `Source is ${preset.ratioLabel} but the canvas is ${state.config.canvas.width}×${state.config.canvas.height} — adapt it first`
        : 'Compose at canvas resolution and apply it',
    },
    'Set as Wallpaper',
  );
  button.addEventListener('click', () => applyPreset(preset, button));
  return button;
}

async function applyPreset(preset, button) {
  if (preset.ratioMatch === false) {
    showToast(
      `“${preset.name}” is ${preset.ratioLabel}, but the canvas is ${ratioLabel(state.config.canvas.width, state.config.canvas.height)}. Adapt it in the editor first.`,
      { type: 'warn', timeout: 10000 },
    );
    return;
  }
  setBusy(button, true, 'Composing…');
  try {
    const result = await api.applyPreset(preset.slug);
    if (result.apply.applied) {
      showToast(
        `“${preset.name}” is now the wallpaper · ${result.apply.backend} · ${result.output}`,
        { type: 'success', timeout: 9000 },
      );
    } else {
      showToast(
        `Composed ${result.output}, but applying failed: ${result.apply.message}`,
        { type: 'warn', timeout: 14000 },
      );
    }
  } catch (error) {
    showToast(error.message, { type: 'error', timeout: 10000 });
  } finally {
    setBusy(button, false);
  }
}

async function deletePreset(preset, button) {
  const confirmed = window.confirm(
    `Delete “${preset.name}”?\n\nThis removes presets/${preset.slug}/ including its base image.`,
  );
  if (!confirmed) return;
  setBusy(button, true, 'Deleting…');
  try {
    await api.deletePreset(preset.slug);
    showToast(`Deleted “${preset.name}”`, { type: 'success' });
    await refresh();
  } catch (error) {
    showToast(error.message, { type: 'error' });
    setBusy(button, false);
  }
}

function card(preset) {
  const editLink = `/?preset=${encodeURIComponent(preset.slug)}`;
  const adaptLink = `/?adapt=${encodeURIComponent(preset.slug)}`;
  const mismatch = preset.ratioMatch === false;
  const edit = el('a', { class: 'btn btn-ghost', href: editLink }, 'Edit');
  const adapt = el(
    'a',
    { class: 'btn btn-accent', href: adaptLink, title: 'Open the editor, crop the image to the canvas and save a new preset' },
    'Adapt in editor',
  );
  const remove = el('button', { class: 'btn btn-ghost btn-danger', type: 'button' }, 'Delete');
  remove.addEventListener('click', () => deletePreset(preset, remove));

  const thumb = el(
    'a',
    { class: 'preset-thumb', href: editLink, 'aria-label': `Edit ${preset.name}` },
    el('img', {
      src: preset.thumbnailUrl,
      alt: `${preset.name} wallpaper preview`,
      loading: 'lazy',
      width: '720',
      height: '405',
    }),
  );

  return el(
    'article',
    { class: 'preset-card' },
    thumb,
    el(
      'div',
      { class: 'preset-card-body' },
      el(
        'div',
        {},
        el('h3', {}, preset.name),
        el(
          'p',
          { class: 'preset-card-meta' },
          `${preset.width}×${preset.height} · ${preset.widgetCount} widget${preset.widgetCount === 1 ? '' : 's'} · ${formatDate(preset.updatedAt)}`,
        ),
        el(
          'p',
          { class: 'preset-card-source' },
          preset.sourceWidth
            ? `Source ${preset.sourceWidth}×${preset.sourceHeight} · ${preset.ratioLabel}`
            : `Canvas ratio ${preset.ratioLabel}`,
        ),
      ),
      el(
        'span',
        { class: `theme-badge theme-badge-${preset.theme}` },
        preset.theme,
      ),
    ),
    mismatch
      ? el(
          'p',
          { class: 'preset-warning' },
          `Source ratio ${preset.ratioLabel} ≠ canvas ${ratioLabel(state.config.canvas.width, state.config.canvas.height)}. ` +
            'Adapt it in the editor and save it as a new preset to use it as wallpaper.',
        )
      : null,
    el(
      'div',
      { class: 'preset-card-actions' },
      mismatch ? adapt : applyButton(preset),
      el('span', { class: 'spacer' }),
      edit,
      remove,
    ),
  );
}

function render() {
  renderStats();
  renderFilters();
  const presets = visiblePresets();
  const total = state.presets.length;
  dom.bar.hidden = total === 0;
  if (!total) {
    renderEmpty('No presets yet');
    return;
  }
  dom.empty.hidden = true;
  if (!presets.length) {
    dom.grid.replaceChildren(
      el(
        'p',
        { class: 'hint' },
        `No ${state.filter} presets — save one with the ${state.filter} theme in the editor.`,
      ),
    );
    return;
  }
  dom.grid.replaceChildren(...presets.map(card));
}

async function refresh() {
  renderSkeleton();
  try {
    const data = await api.listPresets();
    state.presets = data.presets;
    state.stats = data.stats;
    render();
  } catch (error) {
    showToast(`Could not load presets: ${error.message}`, { type: 'error', timeout: 10000 });
    renderEmpty('Could not load presets');
  }
}

async function boot() {
  try {
    state.config = await api.getConfig();
    await loadFonts(state.config.fonts);
  } catch (error) {
    showToast(`Could not reach the HyprWall backend: ${error.message}`, { type: 'error', timeout: 0 });
    return;
  }
  $('#refreshBtn').addEventListener('click', async (event) => {
    setBusy(event.currentTarget, true, 'Refreshing…');
    await refresh();
    setBusy(event.currentTarget, false);
  });
  await refresh();
}

boot();
