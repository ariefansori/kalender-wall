import './nav.js';
import { api } from './api.js';
import { loadFonts } from './fonts.js';
import { $, $$, el, clamp, showToast, downloadBlob, setBusy } from './lib/dom.js';
import { initAccordion } from './lib/accordion.js';
import { Stage } from './stage.js';
import { Inspector } from './inspector.js';
import {
  baseSizing,
  blankDoc,
  makeId,
  newCalendarWidget,
  newGroupWidget,
  newShapeWidget,
  newStickerWidget,
  newTextWidget,
} from './state.js';
import {
  cloneLayer,
  composeLayers,
  findById,
  isComposite,
  isLocked,
  moveLayer,
  resolvePath,
  toggleLayerFlag,
  toggleMaskInvert,
  ungroupLayer,
} from './layers.js';
import { renderLayerTree } from './layerpanel.js';
import { ratioLabel, ratioOf, ratiosMatch } from './ratio.js';
import { calendarDesign } from './render/calendar.js';
import { setGroups } from './render/groups.js';
import { setShapeLibrary, shapeById, shapePreviewMarkup } from './render/shapes.js';
import { measureTextHeight } from './render/text.js';

const params = new URLSearchParams(location.search);

const ZOOM_MIN = 0.25;
const ZOOM_MAX = 4;
const RESIZE_KEY = 'hyprwall.resizeMode';

const state = {
  config: null,
  doc: null,
  selection: [],
  slug: null,
  /** Preset the base image came from — used by "save as new preset". */
  baseSourceSlug: null,
  baseSrc: null,
  dirty: false,
  saving: false,
  history: [],
  future: [],
  savedSnapshot: null,
  widgetLibrary: [],
  zoom: 1,
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
    baseBox: $('#baseBox'),
    baseImage: $('#baseImage'),
    stageEmpty: $('#stageEmpty'),
    inspectorHost: $('#inspectorBody'),
    inspectorEmpty: $('#inspectorEmpty'),
    layerList: $('#layerList'),
    layerWarning: $('#layerWarning'),
    stickerGrid: $('#stickerGrid'),
    shapeGrid: $('#shapeGrid'),
    widgetGrid: $('#widgetGrid'),
    baseInput: $('#baseInput'),
    baseDrop: $('#baseDrop'),
    baseHint: $('#baseHint'),
    presetChip: $('#presetChip'),
    dirtyState: $('#dirtyState'),
    canvasMeta: $('#canvasMeta'),
    selectionMeta: $('#selectionMeta'),
    zoomLevel: $('#btnZoomLevel'),
    btnZoomIn: $('#btnZoomIn'),
    btnZoomOut: $('#btnZoomOut'),
    btnSave: $('#btnSave'),
    btnNew: $('#btnNew'),
    btnApply: $('#btnApply'),
    btnExport: $('#btnExport'),
    btnGroup: $('#btnGroup'),
    btnMask: $('#btnMask'),
    btnMaskInvert: $('#btnMaskInvert'),
    btnUngroup: $('#btnUngroup'),
    saveDialog: $('#saveDialog'),
    saveForm: $('#saveForm'),
    presetName: $('#presetName'),
    confirmSave: $('#confirmSave'),
    cancelSave: $('#cancelSave'),
    ratioBanner: $('#ratioBanner'),
    ratioBannerText: $('#ratioBannerText'),
    btnAdapt: $('#btnAdapt'),
    resizeMode: $('#resizeMode'),
  });
}

// -- aspect ratio ---------------------------------------------------------
/**
 * The ratio the preset will have once saved.
 *
 * Saving bakes the base box crop into base.jpg, so the box aspect (free
 * transform) is what decides the ratio; with ``contain`` the whole image is
 * kept and its own aspect wins.
 */
function draftSourceSize() {
  const doc = state.doc;
  if (!doc) return { width: 0, height: 0 };
  if (!state.baseSrc) return { width: doc.canvas.width, height: doc.canvas.height };
  if (doc.base.fit === 'contain') {
    const natural = {
      width: Number(dom.baseImage?.naturalWidth) || 0,
      height: Number(dom.baseImage?.naturalHeight) || 0,
    };
    if (natural.width && natural.height) return natural;
    if (doc.sourceWidth && doc.sourceHeight) {
      return { width: doc.sourceWidth, height: doc.sourceHeight };
    }
  }
  return { width: doc.base.width, height: doc.base.height };
}

function draftRatio() {
  const size = draftSourceSize();
  return ratioOf(size.width, size.height);
}

function canvasRatio() {
  return ratioOf(state.config?.canvas?.width, state.config?.canvas?.height);
}

function ratioMismatch() {
  if (!state.doc || !state.baseSrc) return false;
  return !ratiosMatch(draftRatio(), canvasRatio());
}

function renderRatioBanner() {
  if (!dom.ratioBanner || !state.doc) return;
  const mismatch = ratioMismatch();
  dom.ratioBanner.hidden = !mismatch;
  if (!mismatch) return;
  const canvas = state.config.canvas;
  const source = draftSourceSize();
  dom.ratioBannerText.textContent =
    `This image is ${ratioLabel(source.width, source.height)} but the canvas is` +
    ` ${ratioLabel(canvas.width, canvas.height)} (${canvas.width} × ${canvas.height}).` +
    ' Only matching-ratio presets can be applied — adapt it and save it as a new preset.';
}

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
  // Undoing back to exactly what is on disk counts as saved again.
  state.dirty = snapshot() !== state.savedSnapshot;
  renderAll();
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

function selectedModel() {
  const path = primaryPath();
  if (!path || !state.doc) return null;
  if (path === 'base') return state.doc.base;
  return resolvePath(state.doc, path)?.layer || null;
}

function selectedWidget() {
  const path = primaryPath();
  if (!path || path === 'base') return null;
  return resolvePath(state.doc, path)?.layer || null;
}

function round1(value) {
  return Math.round(Number(value) * 10) / 10;
}

function requireBase() {
  if (!state.baseSrc) {
    showToast('Choose a base image before adding widgets.', { type: 'error' });
    return false;
  }
  return true;
}

function pruneSelection() {
  if (!state.doc) return;
  state.selection = state.selection.filter((path) => {
    if (path === 'base') return Boolean(state.baseSrc);
    return Boolean(resolvePath(state.doc, path));
  });
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
  stage.sync(state.doc, state.selection, state.baseSrc);
  inspector.render(state);
  renderLayers();
  updateChrome();
}

function renderLayers() {
  renderLayerTree({
    list: dom.layerList,
    doc: state.doc,
    selection: state.selection,
    baseSrc: state.baseSrc,
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
  const doc = state.doc;
  document.title = `${doc.name} · Kalender-Wall`;
  renderRatioBanner();
  dom.presetChip.textContent = doc.name;
  dom.dirtyState.textContent = state.dirty ? 'Unsaved changes' : state.slug ? 'Saved' : 'Not saved';
  dom.dirtyState.classList.toggle('is-dirty', state.dirty);
  dom.canvasMeta.textContent = `${doc.canvas.width} × ${doc.canvas.height} · ${doc.theme}`;
  if (dom.selectionMeta) {
    dom.selectionMeta.textContent = state.selection.length
      ? `${state.selection.length} selected`
      : 'Nothing selected';
  }
  if (dom.zoomLevel) dom.zoomLevel.textContent = `${Math.round(state.zoom * 100)}%`;
  dom.btnSave.disabled = !state.baseSrc || state.saving;
  $$('.add-card').forEach((button) => {
    button.disabled = !state.baseSrc;
  });
  $$('.sticker-tile, .shape-tile').forEach((button) => {
    button.disabled = !state.baseSrc;
  });
  $$('.widget-tile').forEach((button) => {
    button.disabled = !state.baseSrc;
  });
  dom.baseHint.hidden = Boolean(state.baseSrc);
  dom.btnApply.title = ratioMismatch()
    ? 'This preset does not match the canvas ratio — adapt it first'
    : 'Compose at canvas resolution and apply it to the desktop';
  dom.stickerGrid?.classList.toggle('is-locked', !state.baseSrc);
  dom.shapeGrid?.classList.toggle('is-locked', !state.baseSrc);
  dom.widgetGrid?.classList.toggle('is-locked', !state.baseSrc);

  // Group/mask buttons stay clickable so the panel can explain the problem
  // instead of silently refusing: an attempt with fewer than two layers shows
  // a warning right under the toolbar.
  const composite = selectedWidget();
  const canUngroup = Boolean(composite) && isComposite(composite);
  dom.btnUngroup?.classList.toggle('is-off', !canUngroup);
  const tooFew = state.selection.length < 2;
  [dom.btnGroup, dom.btnMask, dom.btnMaskInvert].forEach((button) => {
    button?.classList.toggle('is-off', tooFew);
  });
}

// -- resize mode ----------------------------------------------------------
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
  showToast(
    next === 'free'
      ? 'Free transform: handles change width and height independently (base shown as crop).'
      : 'Keep aspect ratio: handles scale the layer proportionally.',
    { type: 'info', timeout: 3500 },
  );
}

function syncResizeModeButtons() {
  $$('[data-resize]').forEach((button) => {
    button.classList.toggle('is-active', button.dataset.resize === state.resizeMode);
  });
}

// -- adapt to canvas ------------------------------------------------------
/** Scale the layout to the configured canvas and crop the base to fill it. */
function adaptToCanvas({ announce = true } = {}) {
  if (!state.doc) return;
  const canvas = state.config.canvas;
  const old = state.doc.canvas;
  const width = Math.max(1, Math.round(Number(canvas.width) || old.width));
  const height = Math.max(1, Math.round(Number(canvas.height) || old.height));
  pushHistory();
  const scaleX = width / old.width;
  const scaleY = height / old.height;
  const textScale = (scaleX + scaleY) / 2;
  const scaleLayer = (layer) => {
    for (const [key, factor] of [
      ['x', scaleX],
      ['y', scaleY],
      ['width', scaleX],
      ['height', scaleY],
    ]) {
      if (typeof layer[key] === 'number') layer[key] *= factor;
    }
    if (layer.type === 'text' && layer.props) {
      if (typeof layer.props.size === 'number') layer.props.size *= textScale;
      if (typeof layer.props.letterSpacing === 'number') {
        layer.props.letterSpacing *= textScale;
      }
    }
  };
  if (old.width !== width || old.height !== height) {
    state.doc.widgets.forEach(scaleLayer);
    scaleLayer(state.doc.base);
    state.doc.canvas.width = width;
    state.doc.canvas.height = height;
  }
  // Crop the image to the canvas: the box defines the baked crop on save.
  Object.assign(state.doc.base, {
    x: 0,
    y: 0,
    width,
    height,
    fit: 'cover',
  });
  // A mismatched preset has to become a new preset, never an in-place edit.
  state.slug = null;
  markDirty();
  updateUrl(null);
  renderAll();
  if (announce) {
    showToast(
      `Adapted to ${width} × ${height} (${ratioLabel(width, height)}). Save it as a new preset.`,
      { type: 'success', timeout: 9000 },
    );
  }
}

async function useOriginalImage() {
  const original = state.doc?.base?.original;
  if (!state.slug || !original) {
    showToast('This draft has no stored original image yet — it is written on save.', {
      type: 'info',
    });
    return;
  }
  try {
    const result = await api.restoreOriginal(state.slug);
    const upload = result.upload;
    pushHistory();
    Object.assign(state.doc.base, {
      file: `upload:${upload.id}`,
      ...baseSizing(state.doc.canvas, upload.width, upload.height),
      fit: 'cover',
    });
    state.baseSrc = `${upload.url}?v=${Date.now()}`;
    markDirty();
    renderAll();
    showToast(
      `Original image restored · ${upload.width}×${upload.height}. Crop it and save.`,
      { type: 'success', timeout: 8000 },
    );
  } catch (error) {
    showToast(error.message, { type: 'error', timeout: 9000 });
  }
}

// -- zoom -----------------------------------------------------------------
/** Zoom the stage, keeping the canvas point under ``anchor`` (if any) put. */
function setZoom(next, anchor = null) {
  const clamped = clamp(next, ZOOM_MIN, ZOOM_MAX);
  if (Math.abs(clamped - state.zoom) < 0.001) return;
  const frame = dom.stage.parentElement;
  const before = dom.stage.getBoundingClientRect();
  const point = anchor && before.width > 0
    ? {
        x: (anchor.clientX - before.left) / before.width,
        y: (anchor.clientY - before.top) / before.height,
      }
    : null;
  state.zoom = clamped;
  stage.fit();
  const after = dom.stage.getBoundingClientRect();
  if (point) {
    // Scroll so the canvas point under the cursor stays under the cursor.
    frame.scrollLeft += after.left - (anchor.clientX - point.x * after.width);
    frame.scrollTop += after.top - (anchor.clientY - point.y * after.height);
  } else {
    frame.scrollLeft = (frame.scrollWidth - frame.clientWidth) / 2;
    frame.scrollTop = (frame.scrollHeight - frame.clientHeight) / 2;
  }
  updateChrome();
}

// -- selection ------------------------------------------------------------
function selectPaths(paths) {
  const next = [...new Set(paths.filter(Boolean))];
  if (state.selection.length === next.length && next.every((path, index) => path === state.selection[index])) {
    return;
  }
  state.selection = next;
  setLayerWarning('');
  stage.sync(state.doc, state.selection, state.baseSrc);
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
  const found = path === 'base' ? { layer: state.doc.base } : resolvePath(state.doc, path);
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
  const model = selectedModel();
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
  const model = selectedModel();
  if (!model) return;
  if (primaryPath() === 'base') {
    Object.assign(model, patch);
  } else {
    Object.assign(model.props, patch);
    const resizes = Object.prototype.hasOwnProperty.call(patch, 'style')
      || Object.prototype.hasOwnProperty.call(patch, 'layout');
    if (model.type === 'calendar' && resizes) {
      const [designW, designH] = calendarDesign(model.props);
      const centreX = model.x + model.width / 2;
      const centreY = model.y + model.height / 2;
      model.height = (model.width * designH) / designW;
      model.x = centreX - model.width / 2;
      model.y = centreY - model.height / 2;
    }
  }
  markDirty();
  // Repaint the stage without rebuilding the inspector: a slider or colour
  // picker that is being dragged must keep its own element alive.
  stage.sync(state.doc, state.selection, state.baseSrc);
  renderLayers();
  updateChrome();
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
    showToast(
      resolvePath(state.doc, path)?.layer?.props.invert
        ? 'Mask inverted — the shape now punches a hole.'
        : 'Mask restored to a clipping mask.',
      { type: 'info', timeout: 3500 },
    );
  }
}

function duplicateSelection() {
  if (!state.doc) return;
  const paths = state.selection.filter((path) => path !== 'base');
  if (!paths.length) return;
  pushHistory();
  const created = [];
  for (const path of paths) {
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
  if (!state.doc) return;
  if (state.selection.includes('base')) {
    removeBase();
    return;
  }
  const paths = state.selection.filter((path) => resolvePath(state.doc, path));
  if (!paths.length) return;
  pushHistory();
  // Delete deepest/last first so indexes stay valid.
  const entries = paths
    .map((path) => ({ path, ...resolvePath(state.doc, path) }))
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
  showToast('Grouped as an SVG <g> — move, scale and rotate as one object.', { type: 'success' });
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
  showToast(
    invert
      ? 'Hole mask created — the cutting shape is now a live transparent hole.'
      : 'Clipping mask created — the top layers follow the bottom shape.',
    { type: 'success' },
  );
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
  state.selection = result.layers
    .map((layer) => findById(state.doc, layer.id)?.path)
    .filter(Boolean);
  markDirty();
  renderAll();
}

// -- widget creation ------------------------------------------------------
function addText() {
  if (!requireBase()) return;
  pushHistory();
  const widget = newTextWidget(state.config, state.doc);
  state.doc.widgets.push(widget);
  state.selection = [widget.id];
  markDirty();
  renderAll();
  inspector.focusText();
}

function addCalendar(kind) {
  if (!requireBase()) return;
  pushHistory();
  const widget = ['horizontal', 'vertical', 'vertical-right'].includes(kind)
    ? newCalendarWidget(state.config, state.doc, 'grid', kind)
    : newCalendarWidget(state.config, state.doc, kind);
  state.doc.widgets.push(widget);
  state.selection = [widget.id];
  markDirty();
  renderAll();
}

function addSticker(sticker) {
  if (!requireBase()) return;
  pushHistory();
  const widget = newStickerWidget(state.config, state.doc, sticker);
  state.doc.widgets.push(widget);
  state.selection = [widget.id];
  markDirty();
  renderAll();
}

function addShape(shape) {
  if (!requireBase()) return;
  pushHistory();
  const widget = newShapeWidget(state.config, state.doc, shape);
  state.doc.widgets.push(widget);
  state.selection = [widget.id];
  markDirty();
  renderAll();
}

function addGroup(group) {
  if (!requireBase()) return;
  pushHistory();
  const widget = newGroupWidget(state.config, state.doc, group);
  state.doc.widgets.push(widget);
  state.selection = [widget.id];
  markDirty();
  renderAll();
}

// -- base image -----------------------------------------------------------
async function uploadBase(file) {
  if (!file) return;
  if (!file.type.startsWith('image/')) {
    showToast('That file is not an image.', { type: 'error' });
    return;
  }
  dom.baseDrop.classList.add('is-busy');
  try {
    const upload = await api.upload(file);
    pushHistory();
    const sizing = baseSizing(state.doc.canvas, upload.width, upload.height);
    state.doc.base = {
      file: `upload:${upload.id}`,
      ...sizing,
      fit: 'cover',
      opacity: 1,
      visible: true,
      flipX: false,
      flipY: false,
    };
    state.baseSrc = upload.url;
    state.baseSourceSlug = null;
    state.selection = ['base'];
    markDirty();
    renderAll();
    showToast(`Base image set · ${upload.width}×${upload.height}`, { type: 'success' });
  } catch (error) {
    showToast(error.message, { type: 'error', timeout: 9000 });
  } finally {
    dom.baseDrop.classList.remove('is-busy');
    dom.baseInput.value = '';
  }
}

function removeBase() {
  if (!state.baseSrc) return;
  pushHistory();
  state.doc.base.file = '';
  state.baseSrc = null;
  state.selection = state.selection.filter((path) => path !== 'base');
  markDirty();
  renderAll();
  showToast('Base image removed. Widgets are kept.', { type: 'info' });
}

function fitBaseToCanvas() {
  if (!state.baseSrc) return;
  pushHistory();
  const sizing = baseSizing(
    state.doc.canvas,
    dom.baseImage.naturalWidth || state.doc.base.width,
    dom.baseImage.naturalHeight || state.doc.base.height,
  );
  Object.assign(state.doc.base, sizing);
  markDirty();
  renderAll();
}

function centerBase() {
  const base = state.doc.base;
  pushHistory();
  base.x = (state.doc.canvas.width - base.width) / 2;
  base.y = (state.doc.canvas.height - base.height) / 2;
  markDirty();
  renderAll();
}

/** Restore the base image to its default state: cover, centred, unflipped. */
function resetBase() {
  if (!state.baseSrc) return;
  pushHistory();
  const sizing = baseSizing(
    state.doc.canvas,
    dom.baseImage.naturalWidth || state.doc.base.width,
    dom.baseImage.naturalHeight || state.doc.base.height,
  );
  Object.assign(state.doc.base, sizing, {
    fit: 'cover',
    opacity: 1,
    flipX: false,
    flipY: false,
    visible: true,
  });
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
      if (primaryPath() && primaryPath() !== 'base') {
        moveLayerAction(primaryPath(), action === 'forward' ? 1 : -1);
      }
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
      const height = measureTextHeight(widget.props, widget.width);
      pushHistory();
      widget.height = height;
      markDirty();
      renderAll();
      break;
    }
    case 'fitCanvas':
      fitBaseToCanvas();
      break;
    case 'centerBase':
      centerBase();
      break;
    case 'resetBase':
      resetBase();
      break;
    case 'replaceBase':
      dom.baseInput.click();
      break;
    case 'removeBase':
      removeBase();
      break;
    case 'fillBaseCanvas': {
      if (!state.baseSrc) break;
      pushHistory();
      Object.assign(state.doc.base, {
        x: 0,
        y: 0,
        width: state.doc.canvas.width,
        height: state.doc.canvas.height,
        fit: 'cover',
      });
      markDirty();
      renderAll();
      showToast('Base image cropped to fill the canvas.', { type: 'success' });
      break;
    }
    case 'adapt':
      adaptToCanvas();
      break;
    case 'useOriginal':
      useOriginalImage();
      break;
    case 'reloadWidgets':
      refreshWidgetLibrary();
      break;
    default:
      break;
  }
}

// -- history snapshots from inspector focus -------------------------------
function nudge(key, shift) {
  if (!state.doc || !state.selection.length) return;
  const now = Date.now();
  if (now - lastNudge > 400) pushHistory();
  lastNudge = now;
  const step = shift ? 10 : 1;
  for (const path of state.selection) {
    const found = path === 'base' ? { layer: state.doc.base } : resolvePath(state.doc, path);
    if (!found?.layer || isLocked(state.doc, path)) continue;
    if (key === 'ArrowLeft') found.layer.x -= step;
    if (key === 'ArrowRight') found.layer.x += step;
    if (key === 'ArrowUp') found.layer.y -= step;
    if (key === 'ArrowDown') found.layer.y += step;
  }
  markDirty();
  stage.sync(state.doc, state.selection, state.baseSrc);
  inspector.refreshGeometry(state);
}

// -- presets --------------------------------------------------------------
async function loadPreset(slug) {
  const data = await api.getPreset(slug);
  state.doc = data.preset;
  state.slug = data.preset.slug;
  state.baseSourceSlug = data.preset.slug;
  state.baseSrc = data.preset.baseUrl ? `${data.preset.baseUrl}?v=${Date.now()}` : null;
  state.selection = [];
  state.dirty = false;
  state.history = [];
  state.future = [];
  state.savedSnapshot = snapshot();
  renderAll();
}

function resetToBlank() {
  state.doc = blankDoc(state.config);
  state.slug = null;
  state.baseSourceSlug = null;
  state.selection = [];
  state.baseSrc = null;
  state.dirty = false;
  state.history = [];
  state.future = [];
  state.savedSnapshot = snapshot();
  updateUrl(null);
  renderAll();
}

function updateUrl(slug) {
  const url = slug ? `/?preset=${encodeURIComponent(slug)}` : '/';
  history.replaceState({}, '', url);
}

async function savePreset() {
  if (!state.doc.base.file) {
    showToast('Add a base image before saving.', { type: 'error' });
    return false;
  }
  state.saving = true;
  setBusy(dom.btnSave, true, 'Saving…');
  updateChrome();
  try {
    const result = await api.savePreset(state.doc, state.slug, state.baseSourceSlug);
    const preset = result.preset;
    state.doc = preset;
    state.slug = preset.slug;
    state.baseSourceSlug = preset.slug;
    state.baseSrc = preset.baseUrl || state.baseSrc;
    state.dirty = false;
    state.savedSnapshot = snapshot();
    updateUrl(preset.slug);
    renderAll();
    showToast(`Saved “${preset.name}” → presets/${preset.slug}/`, { type: 'success' });
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

function openSaveDialog() {
  if (!state.doc.base.file) {
    showToast('Add a base image before saving.', { type: 'error' });
    return Promise.resolve(false);
  }
  return new Promise((resolve) => {
    const dialog = dom.saveDialog;
    dom.presetName.value = state.doc.name === 'Untitled preset' ? '' : state.doc.name;
    dom.presetName.placeholder = 'Crimson calendar';
    const radio = dialog.querySelector(`input[name="theme"][value="${state.doc.theme}"]`);
    if (radio) radio.checked = true;
    let settled = false;
    const finish = (value) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    dialog.addEventListener('close', () => finish(false), { once: true });
    dom.cancelSave.onclick = () => dialog.close();
    dom.saveForm.onsubmit = async (event) => {
      event.preventDefault();
      const name = dom.presetName.value.trim();
      if (!name) {
        dom.presetName.focus();
        return;
      }
      state.doc.name = name;
      const chosen = dialog.querySelector('input[name="theme"]:checked');
      state.doc.theme = chosen ? chosen.value : state.doc.theme;
      dialog.close();
      const ok = await savePreset();
      finish(ok);
    };
    dialog.showModal();
    requestAnimationFrame(() => {
      dom.presetName.focus();
      dom.presetName.select();
    });
  });
}

async function applyWallpaper() {
  if (!state.doc.base.file) {
    showToast('Add a base image first.', { type: 'error' });
    return;
  }
  if (ratioMismatch()) {
    const canvas = state.config.canvas;
    showToast(
      `This preset does not match the ${canvas.width} × ${canvas.height} canvas. Use “Adapt to canvas”, then save it as a new preset.`,
      { type: 'warn', timeout: 12000 },
    );
    dom.ratioBanner?.scrollIntoView({ block: 'nearest', behavior: 'smooth' });
    return;
  }
  if (!state.slug) {
    const saved = await openSaveDialog();
    if (!saved) return;
  } else if (state.dirty) {
    const saved = await savePreset();
    if (!saved) return;
  }
  setBusy(dom.btnApply, true, 'Applying…');
  try {
    const result = await api.applyPreset(state.slug);
    if (result.apply.applied) {
      showToast(`Wallpaper set via ${result.apply.backend}. Saved to ${result.output}`, {
        type: 'success',
        timeout: 9000,
      });
    } else {
      showToast(`Rendered ${result.output} but could not apply it: ${result.apply.message}`, {
        type: 'warn',
        timeout: 14000,
      });
    }
  } catch (error) {
    showToast(error.message, { type: 'error', timeout: 10000 });
  } finally {
    setBusy(dom.btnApply, false);
  }
}

async function exportPng() {
  if (!state.doc.base.file) {
    showToast('Add a base image first.', { type: 'error' });
    return;
  }
  setBusy(dom.btnExport, true, 'Rendering…');
  try {
    const blob = await api.renderDraft(state.doc, state.slug);
    const name = (state.doc.name || 'hyprwall').toLowerCase().replace(/[^a-z0-9]+/g, '-');
    downloadBlob(blob, `${name || 'hyprwall'}.png`);
    showToast('PNG exported at full canvas resolution.', { type: 'success' });
  } catch (error) {
    showToast(error.message, { type: 'error', timeout: 9000 });
  } finally {
    setBusy(dom.btnExport, false);
  }
}

// -- static UI ------------------------------------------------------------
async function refreshWidgetLibrary() {
  try {
    const data = await api.listWidgets();
    state.widgetLibrary = data.widgets || [];
    setGroups(data.groups);
  } catch (error) {
    showToast(`Could not load the widget library: ${error.message}`, { type: 'error' });
    return;
  }
  buildWidgetGrid();
  if (state.doc) renderAll();
}

function buildWidgetGrid() {
  const grid = dom.widgetGrid;
  if (!grid) return;
  grid.replaceChildren();
  if (!state.widgetLibrary.length) {
    grid.append(el('p', { class: 'hint' }, 'No reusable widgets yet — build one on the widget page.'));
    return;
  }
  state.widgetLibrary.forEach((group) => {
    const button = el(
      'button',
      {
        class: 'widget-tile',
        type: 'button',
        title: `Add ${group.name}`,
        disabled: !state.baseSrc,
      },
      el('img', { src: group.thumbnailUrl, alt: group.name, loading: 'lazy', draggable: 'false' }),
      el('span', {}, group.name),
    );
    button.addEventListener('click', () => addGroup(group));
    grid.append(button);
  });
}

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
      {
        class: 'sticker-tile',
        type: 'button',
        title: `Add ${sticker.name}`,
        disabled: !state.baseSrc,
      },
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
      {
        class: 'shape-tile',
        type: 'button',
        title: `Add ${shape.label} (SVG · viewBox 0 0 100 100)`,
        disabled: !state.baseSrc,
      },
      el('span', { class: 'shape-preview', html: shapePreviewMarkup(shape) }),
      el('span', {}, shape.label),
    );
    button.addEventListener('click', () => addShape(shapeById(shape.id) || shape));
    grid.append(button);
  });
}

function bindUi() {
  dom.baseInput.addEventListener('change', () => uploadBase(dom.baseInput.files?.[0]));
  $('#emptyPick')?.addEventListener('click', () => dom.baseInput.click());
  dom.baseDrop.addEventListener('click', (event) => {
    if (event.target.closest('button')) return;
    dom.baseInput.click();
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
        // Never stack both drawers over a small stage: close the other one.
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

  dom.btnSave.addEventListener('click', () => openSaveDialog());
  dom.btnApply.addEventListener('click', applyWallpaper);
  dom.btnExport.addEventListener('click', exportPng);
  dom.btnNew.addEventListener('click', () => {
    if (state.dirty && !window.confirm('Discard unsaved changes and start a new preset?')) return;
    resetToBlank();
  });
  $('#btnReplaceBase').addEventListener('click', () => dom.baseInput.click());
  $('#btnRemoveBase').addEventListener('click', removeBase);

  $$('[data-resize]').forEach((button) => {
    button.addEventListener('click', () => setResizeMode(button.dataset.resize));
  });
  dom.btnAdapt?.addEventListener('click', () => adaptToCanvas());

  dom.btnZoomIn?.addEventListener('click', () => setZoom(state.zoom * 1.25));
  dom.btnZoomOut?.addEventListener('click', () => setZoom(state.zoom / 1.25));
  dom.zoomLevel?.addEventListener('click', () => setZoom(1));
  dom.stage.parentElement.addEventListener(
    'wheel',
    (event) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      setZoom(state.zoom * Math.pow(1.0016, -event.deltaY), {
        clientX: event.clientX,
        clientY: event.clientY,
      });
    },
    { passive: false },
  );
  window.__hyprwallBeforeLeave = () =>
    !state.dirty || window.confirm('You have unsaved changes. Leave the editor?');
}

function bindKeyboard() {
  document.addEventListener('keydown', (event) => {
    const typing = event.target.closest('input, textarea, select, [contenteditable="true"]');
    if (typing || dom.saveDialog.open) return;
    const mod = event.metaKey || event.ctrlKey;
    const key = event.key;

    if (mod && key.toLowerCase() === 's') {
      event.preventDefault();
      openSaveDialog();
    } else if (mod && key.toLowerCase() === 'z') {
      event.preventDefault();
      if (event.shiftKey) redo();
      else undo();
    } else if (mod && key.toLowerCase() === 'g') {
      event.preventDefault();
      if (event.shiftKey) ungroupSelection();
      else groupSelection();
    } else if (mod && (key === '=' || key === '+')) {
      event.preventDefault();
      setZoom(state.zoom * 1.25);
    } else if (mod && (key === '-' || key === '_')) {
      event.preventDefault();
      setZoom(state.zoom / 1.25);
    } else if (mod && key === '0') {
      event.preventDefault();
      setZoom(1);
    } else if (mod && key.toLowerCase() === 'd') {
      event.preventDefault();
      duplicateSelection();
    } else if (key === 'Delete' || key === 'Backspace') {
      event.preventDefault();
      deleteSelection();
    } else if (key === 'Escape') {
      selectPaths([]);
    } else if (key.startsWith('Arrow')) {
      event.preventDefault();
      nudge(key, event.shiftKey);
    }
  });

  window.addEventListener('beforeunload', (event) => {
    if (!state.dirty) return;
    event.preventDefault();
    event.returnValue = '';
  });
}

// -- boot ------------------------------------------------------------------
async function boot() {
  cacheDom();
  try {
    state.config = await api.getConfig();
    await loadFonts(state.config.fonts);
  } catch (error) {
    showToast(`Could not start Kalender-Wall: ${error.message}`, { type: 'error', timeout: 0 });
    return;
  }
  setShapeLibrary(state.config.shapes);

  stage = new Stage({
    stage: dom.stage,
    layer: dom.widgetLayer,
    baseBox: dom.baseBox,
    baseImage: dom.baseImage,
    empty: dom.stageEmpty,
    handlers: {
      getDoc: () => state.doc,
      getZoom: () => state.zoom,
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
      onDropImage: (file) => uploadBase(file),
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
        if (path && path !== 'base') toggleFlag(path, flag);
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
  syncResizeModeButtons();
  await refreshWidgetLibrary();

  const slug = params.get('preset');
  const adapt = params.get('adapt');
  if ((slug || adapt) && !params.get('new')) {
    try {
      await loadPreset(slug || adapt);
      if (adapt) adaptToCanvas({ announce: true });
      else if (ratioMismatch()) {
        showToast(
          'This preset no longer matches the canvas ratio. Adapt it and save it as a new preset to apply it.',
          { type: 'warn', timeout: 12000 },
        );
      }
    } catch (error) {
      console.error(error);
      showToast(error.message, { type: 'error', timeout: 10000 });
      resetToBlank();
    }
  } else {
    resetToBlank();
  }
}

boot();
