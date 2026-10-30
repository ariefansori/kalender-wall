import './nav.js';
import { api } from './api.js';
import { loadFonts } from './fonts.js';
import { $, $$, el, showToast, downloadBlob, setBusy } from './lib/dom.js';
import { initAccordion } from './lib/accordion.js';
import { Stage } from './stage.js';
import { Inspector } from './inspector.js';
import {
  blankWidgetDoc,
  makeId,
  newCalendarWidget,
  newShapeWidget,
  newStickerWidget,
  newTextWidget,
  widgetDocFrom,
  widgetPayload,
} from './state.js';
import {
  cloneLayer,
  composeLayers,
  findById,
  isComposite,
  moveLayer,
  resolvePath,
  toggleLayerFlag,
  toggleMaskInvert,
  ungroupLayer,
} from './layers.js';
import { renderLayerTree } from './layerpanel.js';
import { calendarDesign } from './render/calendar.js';
import { setGroups } from './render/groups.js';
import { setShapeLibrary, shapeById, shapePreviewMarkup } from './render/shapes.js';
import { measureTextHeight } from './render/text.js';

const params = new URLSearchParams(location.search);
const RESIZE_KEY = 'hyprwall.resizeMode';

const state = {
  config: null,
  doc: null,
  selection: [],
  slug: null,
  dirty: false,
  saving: false,
  history: [],
  future: [],
  savedSnapshot: null,
  library: [],
  groups: {},
  resizeMode: localStorage.getItem(RESIZE_KEY) === 'free' ? 'free' : 'aspect',
};

let stage = null;
let inspector = null;
let lastNudge = 0;

const dom = {};

function cacheDom() {
  Object.assign(dom, {
    stage: $('#stage'),
    widgetLayer: $('#widgetLayer'),
    inspectorHost: $('#inspectorBody'),
    inspectorEmpty: $('#inspectorEmpty'),
    layerList: $('#layerList'),
    layerWarning: $('#layerWarning'),
    stickerGrid: $('#stickerGrid'),
    shapeGrid: $('#shapeGrid'),
    widgetLibrary: $('#widgetLibrary'),
    libraryCount: $('#libraryCount'),
    widgetChip: $('#widgetChip'),
    widgetName: $('#widgetName'),
    widgetWidth: $('#widgetWidth'),
    widgetHeight: $('#widgetHeight'),
    dirtyState: $('#dirtyState'),
    canvasMeta: $('#canvasMeta'),
    selectionMeta: $('#selectionMeta'),
    btnSave: $('#btnSaveWidget'),
    btnNew: $('#btnNewWidget'),
    btnDelete: $('#btnDeleteWidget'),
    btnExport: $('#btnExportWidget'),
    btnGroup: $('#btnGroup'),
    btnMask: $('#btnMask'),
    btnMaskInvert: $('#btnMaskInvert'),
    btnUngroup: $('#btnUngroup'),
  });
}

// -- history --------------------------------------------------------------
function snapshot() {
  return JSON.stringify({ doc: state.doc, selection: state.selection });
}

function pushHistory() {
  if (!state.doc) return;
  const current = snapshot();
  if (state.history[state.history.length - 1] === current) return;
  state.history.push(current);
  if (state.history.length > 60) state.history.shift();
  state.future = [];
}

function restore(snap) {
  const data = JSON.parse(snap);
  state.doc = data.doc;
  state.selection = Array.isArray(data.selection) ? data.selection : data.selection ? [data.selection] : [];
  state.dirty = snapshot() !== state.savedSnapshot;
  renderAll();
  syncSizeInputs();
}

function undo() {
  if (!state.history.length) return;
  state.future.push(snapshot());
  restore(state.history.pop());
}

function redo() {
  if (!state.future.length) return;
  state.history.push(snapshot());
  restore(state.future.pop());
}

function markDirty() {
  state.dirty = true;
}

function primaryPath() {
  return state.selection[state.selection.length - 1] || null;
}

function selectedWidget() {
  const path = primaryPath();
  if (!path) return null;
  return resolvePath(state.doc, path)?.layer || null;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function pruneSelection() {
  if (!state.doc) return;
  state.selection = state.selection.filter((path) => Boolean(resolvePath(state.doc, path)));
}

function setLayerWarning(message) {
  if (!dom.layerWarning) return;
  dom.layerWarning.textContent = message || '';
  dom.layerWarning.hidden = !message;
}

// -- rendering ------------------------------------------------------------
function renderAll() {
  if (!state.doc) return;
  pruneSelection();
  stage.sync(state.doc, state.selection, null);
  inspector.render(state);
  renderLayers();
  updateChrome();
}

function renderLayers() {
  renderLayerTree({
    list: dom.layerList,
    doc: state.doc,
    selection: state.selection,
    baseSrc: null,
    handlers: {
      onSelect: (path) => selectPaths([path]),
      onToggle: (path) => togglePath(path),
      onFlag: (path, flag) => toggleFlag(path, flag),
      onMove: (path, delta) => moveLayerAction(path, delta),
      onInvert: (path) => invertMask(path),
      onFocus: (path) => {
        selectPaths([path]);
        const found = resolvePath(state.doc, path);
        if (found?.layer?.type === 'text') inspector.focusText();
      },
    },
  });
}

function updateChrome() {
  if (!state.doc) return;
  const doc = state.doc;
  document.title = `${doc.name} · Kalender-Wall widgets`;
  dom.widgetChip.textContent = doc.name;
  dom.dirtyState.textContent = state.dirty ? 'Unsaved changes' : state.slug ? 'Saved' : 'Not saved';
  dom.dirtyState.classList.toggle('is-dirty', state.dirty);
  dom.canvasMeta.textContent = `${doc.canvas.width} × ${doc.canvas.height} · ${doc.widgets.length} layer${doc.widgets.length === 1 ? '' : 's'}`;
  if (dom.selectionMeta) {
    dom.selectionMeta.textContent = state.selection.length ? `${state.selection.length} selected` : 'Nothing selected';
  }
  dom.btnDelete.disabled = !state.slug;
  if (document.activeElement !== dom.widgetName) dom.widgetName.value = doc.name;
  dom.widgetLibrary
    ?.querySelectorAll('[data-slug]')
    .forEach((row) => row.classList.toggle('is-active', row.dataset.slug === state.slug));

  // Clicking with too few layers shows an explicit warning instead of the
  // buttons going dead, so the panel can explain what a mask needs.
  const composite = selectedWidget();
  const canUngroup = Boolean(composite) && isComposite(composite);
  dom.btnUngroup?.classList.toggle('is-off', !canUngroup);
  const tooFew = state.selection.length < 2;
  [dom.btnGroup, dom.btnMask, dom.btnMaskInvert].forEach((button) => {
    button?.classList.toggle('is-off', tooFew);
  });
}

function syncSizeInputs() {
  if (!state.doc) return;
  if (document.activeElement !== dom.widgetWidth) dom.widgetWidth.value = String(state.doc.canvas.width);
  if (document.activeElement !== dom.widgetHeight) dom.widgetHeight.value = String(state.doc.canvas.height);
}

// -- selection ------------------------------------------------------------
function selectPaths(paths) {
  const next = [...new Set(paths.filter(Boolean))];
  if (state.selection.length === next.length && next.every((path, index) => path === state.selection[index])) {
    return;
  }
  state.selection = next;
  setLayerWarning('');
  stage.sync(state.doc, state.selection, null);
  inspector.render(state);
  renderLayers();
  updateChrome();
}

function togglePath(path) {
  const index = state.selection.indexOf(path);
  const next = index >= 0 ? state.selection.filter((item) => item !== path) : [...state.selection, path];
  selectPaths(next);
}

// -- geometry -------------------------------------------------------------
function boxPatchFrom(box) {
  return {
    x: round1(box.x),
    y: round1(box.y),
    width: Math.max(4, round1(box.width)),
    height: Math.max(4, round1(box.height)),
    ...(box.rotation == null ? {} : { rotation: round1(box.rotation) }),
  };
}

function applyBoxChange(path, box, { live = false } = {}) {
  if (!state.doc) return;
  const found = resolvePath(state.doc, path);
  if (!found?.layer) return;
  Object.assign(found.layer, boxPatchFrom(box));
  markDirty();
  if (live) {
    stage.updateGeometry(path);
    inspector.refreshGeometry(state);
  } else {
    renderAll();
  }
}

function applyMoveMany(updates, { live = false } = {}) {
  if (!state.doc) return;
  for (const update of updates) {
    const found = resolvePath(state.doc, update.path);
    if (!found?.layer) continue;
    found.layer.x = round1(update.x);
    found.layer.y = round1(update.y);
    markDirty();
    if (live) stage.updateGeometry(update.path);
  }
  if (!live) renderAll();
  else inspector.refreshGeometry(state);
}

function updateSelectedBox(patch) {
  const model = selectedWidget();
  if (!model) return;
  Object.assign(model, {
    ...patch,
    ...(patch.width == null ? {} : { width: Math.max(4, patch.width) }),
    ...(patch.height == null ? {} : { height: Math.max(4, patch.height) }),
  });
  markDirty();
  renderAll();
}

function updateSelectedProps(patch, { rebuild = false } = {}) {
  const model = selectedWidget();
  if (!model) return;
  Object.assign(model.props, patch);
  const resizes =
    Object.prototype.hasOwnProperty.call(patch, 'style')
    || Object.prototype.hasOwnProperty.call(patch, 'layout');
  if (model.type === 'calendar' && resizes) {
    const [designW, designH] = calendarDesign(model.props);
    const centreX = model.x + model.width / 2;
    const centreY = model.y + model.height / 2;
    model.height = (model.width * designH) / designW;
    model.x = centreX - model.width / 2;
    model.y = centreY - model.height / 2;
  }
  markDirty();
  renderAll();
  if (rebuild) inspector.render(state);
}

// -- layers ---------------------------------------------------------------
function moveLayerAction(path, direction) {
  if (!state.doc) return;
  pushHistory();
  if (moveLayer(state.doc, path, direction)) {
    markDirty();
    renderAll();
  }
}

function toggleFlag(path, flag) {
  if (!state.doc) return;
  pushHistory();
  if (toggleLayerFlag(state.doc, path, flag)) {
    markDirty();
    renderAll();
  }
}

function invertMask(path) {
  if (!state.doc) return;
  pushHistory();
  if (toggleMaskInvert(state.doc, path)) {
    markDirty();
    renderAll();
  }
}

function duplicateSelection() {
  if (!state.doc || !state.selection.length) return;
  pushHistory();
  const created = [];
  for (const path of state.selection) {
    const found = resolvePath(state.doc, path);
    if (!found?.layer) continue;
    const copy = cloneLayer(found.layer);
    copy.id = makeId(found.layer.type);
    copy.x += 24;
    copy.y += 24;
    found.list.splice(found.index + 1, 0, copy);
    created.push(findById(state.doc, copy.id)?.path || copy.id);
  }
  state.selection = created;
  markDirty();
  renderAll();
}

function deleteSelection() {
  if (!state.doc || !state.selection.length) return;
  pushHistory();
  const entries = state.selection
    .map((path) => resolvePath(state.doc, path))
    .filter(Boolean)
    .sort((a, b) => b.index - a.index);
  for (const entry of entries) entry.list.splice(entry.index, 1);
  state.selection = [];
  markDirty();
  renderAll();
}

function groupSelection() {
  if (!state.doc) return;
  if (state.selection.length < 2) {
    setLayerWarning('Select at least 2 SVG layers to group them.');
    showToast('Grouping needs 2 or more SVG layers selected.', { type: 'warn' });
    return;
  }
  const result = composeLayers(state.doc, state.selection, { type: 'shapeGroup' });
  if (result.error) {
    setLayerWarning(result.error);
    showToast(result.error, { type: 'warn', timeout: 7000 });
    return;
  }
  pushHistory();
  setLayerWarning('');
  state.selection = [findById(state.doc, result.composite.id)?.path || result.path];
  markDirty();
  renderAll();
}

function maskSelection(invert) {
  if (!state.doc) return;
  if (state.selection.length < 2) {
    const message =
      'A mask needs at least 2 selected layers: one cutting shape on the bottom and one layer to mask above it.';
    setLayerWarning(message);
    showToast(message, { type: 'warn', timeout: 8000 });
    return;
  }
  const result = composeLayers(state.doc, state.selection, { type: 'mask', invert });
  if (result.error) {
    setLayerWarning(result.error);
    showToast(result.error, { type: 'warn', timeout: 7000 });
    return;
  }
  pushHistory();
  setLayerWarning('');
  state.selection = [findById(state.doc, result.composite.id)?.path || result.path];
  markDirty();
  renderAll();
}

function ungroupSelection() {
  if (!state.doc) return;
  const widget = selectedWidget();
  if (!widget || !isComposite(widget)) {
    setLayerWarning('Select a group or mask to ungroup.');
    showToast('Select a group or mask layer to ungroup.', { type: 'warn' });
    return;
  }
  pushHistory();
  const result = ungroupLayer(state.doc, primaryPath());
  if (result.error) {
    setLayerWarning(result.error);
    showToast(result.error, { type: 'warn' });
    return;
  }
  setLayerWarning('');
  state.selection = result.layers.map((layer) => findById(state.doc, layer.id)?.path).filter(Boolean);
  markDirty();
  renderAll();
}

// -- adding layers --------------------------------------------------------
function addText() {
  pushHistory();
  const widget = newTextWidget(state.config, state.doc);
  state.doc.widgets.push(widget);
  state.selection = [widget.id];
  markDirty();
  renderAll();
  inspector.focusText();
}

function addCalendar(kind) {
  pushHistory();
  const widget = ['horizontal', 'vertical'].includes(kind)
    ? newCalendarWidget(state.config, state.doc, 'grid', kind)
    : newCalendarWidget(state.config, state.doc, kind);
  state.doc.widgets.push(widget);
  state.selection = [widget.id];
  markDirty();
  renderAll();
}

function addSticker(sticker) {
  pushHistory();
  const widget = newStickerWidget(state.config, state.doc, sticker);
  state.doc.widgets.push(widget);
  state.selection = [widget.id];
  markDirty();
  renderAll();
}

function addShape(shape) {
  pushHistory();
  const widget = newShapeWidget(state.config, state.doc, shape);
  state.doc.widgets.push(widget);
  state.selection = [widget.id];
  markDirty();
  renderAll();
}

// -- actions --------------------------------------------------------------
function runAction(action) {
  switch (action) {
    case 'delete':
      deleteSelection();
      break;
    case 'duplicate':
      duplicateSelection();
      break;
    case 'forward':
    case 'back':
      if (primaryPath()) moveLayerAction(primaryPath(), action === 'forward' ? 1 : -1);
      break;
    case 'group':
      groupSelection();
      break;
    case 'mask':
      maskSelection(false);
      break;
    case 'maskInvert':
      maskSelection(true);
      break;
    case 'ungroup':
      ungroupSelection();
      break;
    case 'fitHeight': {
      const widget = selectedWidget();
      if (!widget || widget.type !== 'text') break;
      pushHistory();
      widget.height = measureTextHeight(widget.props, widget.width);
      markDirty();
      renderAll();
      break;
    }
    case 'reloadWidgets':
      refreshLibrary();
      break;
    default:
      break;
  }
}

// -- canvas size ----------------------------------------------------------
function applyCanvasSize(width, height) {
  const nextWidth = Math.max(80, Math.min(4096, Math.round(width)));
  const nextHeight = Math.max(80, Math.min(4096, Math.round(height)));
  if (!state.doc) return;
  if (nextWidth === state.doc.canvas.width && nextHeight === state.doc.canvas.height) return;
  pushHistory();
  state.doc.size = { width: nextWidth, height: nextHeight };
  state.doc.canvas.width = nextWidth;
  state.doc.canvas.height = nextHeight;
  state.doc.base.width = nextWidth;
  state.doc.base.height = nextHeight;
  markDirty();
  renderAll();
  syncSizeInputs();
}

// -- library --------------------------------------------------------------
function renderLibrary() {
  const list = dom.widgetLibrary;
  if (!list) return;
  dom.libraryCount.textContent = `${state.library.length} widget${state.library.length === 1 ? '' : 's'}`;
  list.replaceChildren();
  if (!state.library.length) {
    list.append(el('li', { class: 'layer-empty' }, 'Nothing saved yet — start with a size above.'));
    return;
  }
  state.library.forEach((item) => {
    const active = item.slug === state.slug;
    const row = el('li', { class: `library-row${active ? ' is-active' : ''}`, dataset: { slug: item.slug } });
    const button = el('button', { class: 'library-main', type: 'button' });
    button.append(
      el('img', { src: item.thumbnailUrl, alt: '', loading: 'lazy', draggable: 'false' }),
      el(
        'span',
        { class: 'library-text' },
        el('strong', {}, item.name),
        el('small', {}, `${item.width}×${item.height} · ${item.layerCount} layer${item.layerCount === 1 ? '' : 's'}`),
      ),
    );
    button.addEventListener('click', () => loadWidget(item.slug));
    row.append(button);
    list.append(row);
  });
}

async function refreshLibrary() {
  try {
    const data = await api.listWidgets();
    state.library = data.widgets || [];
    state.groups = data.groups || {};
    setGroups(state.groups);
  } catch (error) {
    showToast(`Could not load the widget library: ${error.message}`, { type: 'error', timeout: 9000 });
    return;
  }
  renderLibrary();
  if (state.doc) renderAll();
}

async function loadWidget(slug) {
  if (state.dirty && !window.confirm('Discard unsaved changes and open another widget?')) return;
  let doc = state.groups[slug];
  if (!doc) {
    try {
      const data = await api.getWidget(slug);
      doc = data.widget;
    } catch (error) {
      showToast(error.message, { type: 'error' });
      return;
    }
  }
  state.doc = widgetDocFrom(doc);
  state.slug = doc.slug || slug;
  state.selection = [];
  state.dirty = false;
  state.history = [];
  state.future = [];
  state.savedSnapshot = snapshot();
  updateUrl(state.slug);
  renderAll();
  syncSizeInputs();
}

function newWidget(width, height, { confirm = true } = {}) {
  if (confirm && state.dirty && !window.confirm('Discard unsaved changes and start a new widget?')) return;
  state.doc = blankWidgetDoc(width, height);
  state.slug = null;
  state.selection = [];
  state.dirty = false;
  state.history = [];
  state.future = [];
  state.savedSnapshot = snapshot();
  updateUrl(null);
  renderAll();
  syncSizeInputs();
}

function updateUrl(slug) {
  const url = slug ? `/widgets?widget=${encodeURIComponent(slug)}` : '/widgets';
  history.replaceState({}, '', url);
}

// -- save / export / delete ----------------------------------------------
async function saveWidget() {
  if (!state.doc) return false;
  state.doc.name = (dom.widgetName.value || '').trim() || state.doc.name || 'Untitled widget';
  state.saving = true;
  setBusy(dom.btnSave, true, 'Saving…');
  try {
    const result = await api.saveWidget(widgetPayload(state.doc), state.slug);
    const saved = result.widget;
    state.doc = widgetDocFrom(saved);
    state.slug = saved.slug;
    state.selection = [];
    state.dirty = false;
    state.savedSnapshot = snapshot();
    updateUrl(saved.slug);
    await refreshLibrary();
    renderAll();
    syncSizeInputs();
    showToast(`Saved “${saved.name}” → widgets/${saved.slug}/`, { type: 'success' });
    return true;
  } catch (error) {
    showToast(error.message, { type: 'error', timeout: 10000 });
    return false;
  } finally {
    state.saving = false;
    setBusy(dom.btnSave, false);
    updateChrome();
  }
}

async function exportPng() {
  if (!state.doc) return;
  setBusy(dom.btnExport, true, 'Rendering…');
  try {
    const payload = widgetPayload({ ...state.doc, name: dom.widgetName.value.trim() || state.doc.name });
    const blob = await api.renderWidget(payload);
    const name = (state.doc.name || 'widget').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadBlob(blob, `${name || 'widget'}.png`);
    showToast('PNG exported at design resolution.', { type: 'success' });
  } catch (error) {
    showToast(error.message, { type: 'error', timeout: 9000 });
  } finally {
    setBusy(dom.btnExport, false);
  }
}

async function deleteWidget() {
  if (!state.slug) return;
  if (!window.confirm(`Delete “${state.doc.name}”?\n\nWallpapers that place this widget will render without it.`)) return;
  setBusy(dom.btnDelete, true, 'Deleting…');
  try {
    await api.deleteWidget(state.slug);
    showToast(`Deleted “${state.doc.name}”`, { type: 'success' });
    await refreshLibrary();
    if (state.library.length) await loadWidget(state.library[0].slug);
    else newWidget(720, 280, { confirm: false });
  } catch (error) {
    showToast(error.message, { type: 'error' });
  } finally {
    setBusy(dom.btnDelete, false);
    updateChrome();
  }
}

// -- static UI -----------------------------------------------------------
function buildStickerGrid() {
  const grid = dom.stickerGrid;
  if (!grid) return;
  grid.replaceChildren();
  const stickers = state.config.stickers || [];
  if (!stickers.length) {
    grid.append(el('p', { class: 'hint' }, 'No stickers yet — drop PNGs in assets/stickers/.'));
    return;
  }
  stickers.forEach((sticker) => {
    const button = el(
      'button',
      { class: 'sticker-tile', type: 'button', title: `Add ${sticker.name}` },
      el('img', { src: sticker.url, alt: sticker.name, loading: 'lazy' }),
      el('span', {}, sticker.name.replace(/\.[^.]+$/, '')),
    );
    button.addEventListener('click', () => addSticker(sticker));
    grid.append(button);
  });
}

function buildShapeGrid() {
  const grid = dom.shapeGrid;
  if (!grid) return;
  grid.replaceChildren();
  const shapes = state.config.shapes || [];
  if (!shapes.length) {
    grid.append(el('p', { class: 'hint' }, 'The shape library could not be loaded.'));
    return;
  }
  shapes.forEach((shape) => {
    const button = el(
      'button',
      { class: 'shape-tile', type: 'button', title: `Add ${shape.label} (SVG · viewBox 0 0 100 100)` },
      el('span', { class: 'shape-preview', html: shapePreviewMarkup(shape) }),
      el('span', {}, shape.label),
    );
    button.addEventListener('click', () => addShape(shapeById(shape.id) || shape));
    grid.append(button);
  });
}

function setResizeMode(mode) {
  const next = mode === 'free' ? 'free' : 'aspect';
  if (state.resizeMode === next) return;
  state.resizeMode = next;
  try {
    localStorage.setItem(RESIZE_KEY, next);
  } catch {
    /* private mode: keep it in memory only */
  }
  $$('[data-resize]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.resize === next);
  });
}

function bindUi() {
  $$('[data-resize]').forEach((button) => {
    button.addEventListener('click', () => setResizeMode(button.dataset.resize));
  });

  $$('[data-new-size]').forEach((button) => {
    button.addEventListener('click', () => {
      const [width, height] = button.dataset.newSize.split('x').map(Number);
      newWidget(width, height);
    });
  });

  $$('[data-add]').forEach((button) => {
    button.addEventListener('click', () => {
      const target = button.dataset.add;
      if (target === 'text') addText();
      else if (target.startsWith('calendar-')) addCalendar(target.replace('calendar-', ''));
    });
  });

  $$('.panel-toggle').forEach((button) => {
    button.addEventListener('click', () => {
      const panel = document.getElementById(button.dataset.panel);
      if (!panel) return;
      const opening = !panel.classList.contains('is-open');
      if (opening) {
        $$('.panel.is-open').forEach((other) => {
          if (other !== panel) other.classList.remove('is-open');
        });
      }
      panel.classList.toggle('is-open', opening);
    });
  });

  dom.btnGroup?.addEventListener('click', groupSelection);
  dom.btnMask?.addEventListener('click', () => maskSelection(false));
  dom.btnMaskInvert?.addEventListener('click', () => maskSelection(true));
  dom.btnUngroup?.addEventListener('click', ungroupSelection);

  dom.widgetName.addEventListener('focus', () => pushHistory());
  dom.widgetName.addEventListener('input', () => {
    state.doc.name = dom.widgetName.value;
    markDirty();
    dom.widgetChip.textContent = dom.widgetName.value || 'Untitled widget';
  });

  dom.widgetWidth.addEventListener('change', () => {
    applyCanvasSize(Number(dom.widgetWidth.value), state.doc.canvas.height);
  });
  dom.widgetHeight.addEventListener('change', () => {
    applyCanvasSize(state.doc.canvas.width, Number(dom.widgetHeight.value));
  });

  dom.btnSave.addEventListener('click', saveWidget);
  dom.btnExport.addEventListener('click', exportPng);
  dom.btnDelete.addEventListener('click', deleteWidget);
  dom.btnNew.addEventListener('click', () => {
    const width = state.doc?.canvas.width || 720;
    const height = state.doc?.canvas.height || 280;
    newWidget(width, height);
  });
  window.__hyprwallBeforeLeave = () =>
    !state.dirty || window.confirm('You have unsaved changes. Leave the widget page?');
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest('input, textarea, select, [contenteditable="true"]');
    if (typing) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;

    if (mod && key.toLowerCase() === 's') {
      event.preventDefault();
      saveWidget();
    } else if (mod && key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && key.toLowerCase() === 'g') {
      event.preventDefault();
      if (event.shiftKey) ungroupSelection();
      else groupSelection();
    } else if (mod && key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelection();
    } else if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      deleteSelection();
    } else if (key === 'Escape') {
      selectPaths([]);
    } else if (key.startsWith('Arrow') && state.selection.length) {
      event.preventDefault();
      const now = Date.now();
      if (now - lastNudge > 400) pushHistory();
      lastNudge = now;
      const step = event.shiftKey ? 10 : 1;
      for (const path of state.selection) {
        const found = resolvePath(state.doc, path);
        if (!found?.layer) continue;
        if (key === 'ArrowLeft') found.layer.x -= step;
        if (key === 'ArrowRight') found.layer.x += step;
        if (key === 'ArrowUp') found.layer.y -= step;
        if (key === 'ArrowDown') found.layer.y += step;
      }
      markDirty();
      stage.sync(state.doc, state.selection, null);
      inspector.refreshGeometry(state);
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

// -- boot -----------------------------------------------------------------
async function boot() {
  cacheDom();
  try {
    state.config = await api.getConfig();
    await loadFonts(state.config.fonts);
  } catch (error) {
    showToast(`Could not start the widget page: ${error.message}`, { type: 'error', timeout: 0 });
    return;
  }
  setShapeLibrary(state.config.shapes);

  stage = new Stage({
    stage: dom.stage,
    layer: dom.widgetLayer,
    baseBox: document.createElement('div'),
    baseImage: document.createElement('img'),
    empty: document.createElement('div'),
    baseEnabled: false,
    handlers: {
      getDoc: () => state.doc,
      getZoom: () => 1,
      getSelection: () => state.selection,
      getResizeMode: () => state.resizeMode,
      onSelect: (paths) => selectPaths(paths),
      onToggle: (path) => togglePath(path),
      onGestureStart: () => pushHistory(),
      onGestureEnd: (path, moved) => {
        if (!moved) {
          if (state.history[state.history.length - 1] === snapshot()) state.history.pop();
          inspector.render(state);
          return;
        }
        markDirty();
        renderAll();
      },
      onBoxChange: (path, box, options) => applyBoxChange(path, box, options),
      onMoveMany: (updates, options) => applyMoveMany(updates, options),
      onOpenText: (id) => {
        selectPaths([id]);
        inspector.focusText();
      },
      onDropImage: () => showToast('A widget has no background image — add layers instead.', { type: 'info' }),
    },
  });

  inspector = new Inspector({
    host: dom.inspectorHost,
    empty: dom.inspectorEmpty,
    handlers: {
      history: () => pushHistory(),
      box: (patch) => updateSelectedBox(patch),
      props: (patch, options) => updateSelectedProps(patch, options),
      action: (action) => runAction(action),
      flag: (flag) => {
        const path = primaryPath();
        if (path) toggleFlag(path, flag);
      },
      rebuild: () => {
        inspector.render(state);
        renderLayers();
        updateChrome();
      },
    },
  });

  buildStickerGrid();
  buildShapeGrid();
  initAccordion(document);
  bindUi();
  bindKeyboard();
  $$('[data-resize]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.resize === state.resizeMode);
  });
  await refreshLibrary();

  const requested = params.get('widget');
  if (requested) {
    await loadWidget(requested);
  } else if (state.library.length) {
    await loadWidget(state.library[0].slug);
  } else {
    newWidget(720, 280, { confirm: false });
  }
}

boot();
