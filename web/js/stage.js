import { el, clamp } from './lib/dom.js';
import { paintWidget, glassFor } from './render/index.js';
import { isLocked, layerRect, layerBBox, pathTransform, resolvePath, topPath, unionBBox } from './layers.js';

const ALL_HANDLES = ['nw', 'n', 'ne', 'e', 'se', 's', 'sw', 'w'];
const DIRECTIONS = {
  nw: [-1, -1],
  n: [0, -1],
  ne: [1, -1],
  e: [1, 0],
  se: [1, 1],
  s: [0, 1],
  sw: [-1, 1],
  w: [-1, 0],
};

const MIN_SIZE = 24;
const MAX_SIZE = 20000;

/**
 * Resize a box from one of its eight handles.
 *
 * ``aspectLocked`` keeps the box's aspect ratio and anchors the opposite
 * edge/corner (the classic image resize); the free mode changes width and
 * height independently in both directions.
 */
function resizeBox(base, handle, dx, dy, aspectLocked) {
  const [dirX, dirY] = DIRECTIONS[handle] || [0, 0];
  const right = base.x + base.width;
  const bottom = base.y + base.height;
  const box = { x: base.x, y: base.y, width: base.width, height: base.height };

  if (aspectLocked) {
    const aspect = base.width / base.height;
    let width = base.width;
    if (dirX !== 0 && dirY !== 0) {
      const deltaWidth = dirX * dx;
      const deltaHeight = dirY * dy;
      width = base.width + deltaWidth;
      if (Math.abs(deltaHeight * aspect) > Math.abs(deltaWidth)) {
        width = (base.height + deltaHeight) * aspect;
      }
    } else if (dirX !== 0) {
      width = base.width + dirX * dx;
    } else {
      width = (base.height + dirY * dy) * aspect;
    }
    width = clamp(width, MIN_SIZE, MAX_SIZE);
    box.width = width;
    box.height = width / aspect;
    if (dirX < 0) box.x = right - box.width;
    else if (dirX === 0) box.x = base.x + base.width / 2 - box.width / 2;
    if (dirY < 0) box.y = bottom - box.height;
    else if (dirY === 0) box.y = base.y + base.height / 2 - box.height / 2;
    return box;
  }

  if (dirX === -1) {
    box.x = Math.min(right - MIN_SIZE, base.x + dx);
    box.width = right - box.x;
  } else if (dirX === 1) {
    box.width = clamp(base.width + dx, MIN_SIZE, MAX_SIZE);
  }
  if (dirY === -1) {
    box.y = Math.min(bottom - MIN_SIZE, base.y + dy);
    box.height = bottom - box.y;
  } else if (dirY === 1) {
    box.height = clamp(base.height + dy, MIN_SIZE, MAX_SIZE);
  }
  return box;
}

export class Stage {
  constructor({ stage, layer, baseBox, baseImage, empty, handlers, baseEnabled = true }) {
    this.stage = stage;
    this.layer = layer;
    this.baseBox = baseBox;
    this.baseImage = baseImage;
    this.empty = empty;
    this.handlers = handlers;
    this.baseEnabled = baseEnabled;
    this.elements = new Map();
    this.signatures = new Map();
    this.drag = null;
    this.gizmo = null;
    this.selection = [];
    this.doc = null;

    // Content lives in a clipped wrapper so widgets never paint outside the
    // canvas; the gizmo sits above it, unclipped, so selection handles stay
    // visible even when a widget hangs off the edge.
    let content = this.stage.querySelector(':scope > .stage-content');
    if (!content) {
      content = el('div', { class: 'stage-content' });
      [...this.stage.childNodes].forEach((node) => content.append(node));
      this.stage.append(content);
    }
    this.content = content;
    this.gizmoLayer = el('div', { class: 'gizmo-layer' });
    this.stage.append(this.gizmoLayer);

    this._fit = this.fit.bind(this);
    window.addEventListener('resize', this._fit);
    if (typeof ResizeObserver === 'function') {
      new ResizeObserver(this._fit).observe(stage.parentElement);
    }

    this.stage.addEventListener('pointerdown', (event) => this._pointerDown(event));
    window.addEventListener('pointermove', (event) => this._pointerMove(event));
    window.addEventListener('pointerup', () => this._pointerUp());
    window.addEventListener('pointercancel', () => this._pointerUp());
    this.stage.addEventListener('dblclick', (event) => {
      const node = event.target.closest('[data-widget-id]');
      if (!node) return;
      const doc = this.handlers.getDoc();
      const widget = doc.widgets.find((item) => item.id === node.dataset.widgetId);
      if (!widget) return;
      if (widget.type === 'text') {
        this.handlers.onOpenText(widget.id);
        return;
      }
      // Double-click drills into a group or mask, selecting the child under the
      // cursor so the cutting shape of a mask can be dragged on the canvas.
      const path = this._childAt(doc, widget.id, event);
      if (path) this.handlers.onSelect([path]);
    });

    this.stage.addEventListener('dragover', (event) => {
      event.preventDefault();
      this.stage.classList.add('is-dropping');
    });
    this.stage.addEventListener('dragleave', () => this.stage.classList.remove('is-dropping'));
    this.stage.addEventListener('drop', (event) => {
      event.preventDefault();
      this.stage.classList.remove('is-dropping');
      const file = event.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) this.handlers.onDropImage(file);
    });
  }

  /** Deepest child of a composite whose box contains the pointer. */
  _childAt(doc, path, event) {
    const found = resolvePath(doc, path);
    if (!found || !found.layer || !['shapeGroup', 'mask'].includes(found.layer.type)) return null;
    const stageRect = this.stage.getBoundingClientRect();
    const point = {
      x: ((event.clientX - stageRect.left) / stageRect.width) * doc.canvas.width,
      y: ((event.clientY - stageRect.top) / stageRect.height) * doc.canvas.height,
    };
    const children = found.layer.props?.layers || [];
    for (let index = children.length - 1; index >= 0; index -= 1) {
      const childPath = `${path}/${children[index].id}`;
      const box = layerBBox(doc, childPath);
      if (!box) continue;
      if (point.x < box.x || point.y < box.y || point.x > box.x + box.width || point.y > box.y + box.height) {
        continue;
      }
      return this._childAt(doc, childPath, event) || childPath;
    }
    return null;
  }

  fit() {
    const doc = this.handlers.getDoc();
    if (!doc) return;
    const frame = this.stage.parentElement;
    // Leave a couple of pixels of slack against the frame's padding: a stage
    // that matches the content box exactly can overflow by a sub-pixel and
    // make a scrollbar appear, which shrinks the box, which removes it again —
    // a resize-observer loop that never settles.
    const availableWidth = Math.max(280, frame.clientWidth - 46);
    const availableHeight = Math.max(180, frame.clientHeight - 38);
    const aspect = doc.canvas.width / doc.canvas.height;
    let width = availableWidth;
    let height = width / aspect;
    if (height > availableHeight) {
      height = availableHeight;
      width = height * aspect;
    }
    const zoom = Number(this.handlers.getZoom?.() ?? 1) || 1;
    const targetWidth = `${Math.max(1, Math.round(width * zoom))}px`;
    const targetHeight = `${Math.max(1, Math.round(height * zoom))}px`;
    if (this.stage.style.width !== targetWidth) this.stage.style.width = targetWidth;
    if (this.stage.style.height !== targetHeight) this.stage.style.height = targetHeight;
    this._refreshGlass();
  }

  /** Glass blur is expressed in design pixels, so it must follow the zoom. */
  _refreshGlass() {
    if (!this.doc) return;
    for (const widget of this.doc.widgets) {
      const node = this.elements.get(widget.id);
      if (node) this._applyGlass(node, widget);
    }
  }

  _applyGlass(node, widget) {
    const glass = glassFor(widget);
    if (!glass) {
      node.style.backdropFilter = '';
      node.style.webkitBackdropFilter = '';
      node.classList.remove('has-glass');
      return;
    }
    const canvasScale = (this.stage.clientWidth || 1) / (Math.max(1, this.doc?.canvas.width) || 1);
    const nodeWidth = (Number(widget.width) || 1) * canvasScale;
    const blur = glass.blur * (nodeWidth / glass.designWidth);
    node.style.backdropFilter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : '';
    node.style.webkitBackdropFilter = blur > 0.05 ? `blur(${blur.toFixed(2)}px)` : '';
    node.classList.toggle('has-glass', blur > 0.05);
  }

  sync(doc, selection, baseSrc) {
    this.doc = doc;
    this.selection = Array.isArray(selection) ? selection.filter(Boolean) : selection ? [selection] : [];
    this.stage.style.background = doc.canvas.background || '#101014';
    this.fit();

    if (!this.baseEnabled) {
      this.stage.dataset.empty = 'false';
      this.empty.hidden = true;
      this.baseBox.hidden = true;
    } else {
      this.stage.dataset.empty = baseSrc ? 'false' : 'true';
      this.empty.hidden = Boolean(baseSrc);
      this._syncBase(doc, this.selection, baseSrc);
    }

    const seen = new Set();
    doc.widgets.forEach((widget, index) => {
      seen.add(widget.id);
      let node = this.elements.get(widget.id);
      if (!node) {
        node = this._createWidget(widget);
        this.elements.set(widget.id, node);
      }
      this.layer.append(node);
      this._applyBox(node, widget, doc.canvas);
      node.style.transform = `rotate(${Number(widget.rotation) || 0}deg)`;
      node.style.opacity = String(clamp(Number(widget.opacity ?? 1), 0, 1));
      node.style.zIndex = String(index + 1);
      node.hidden = Boolean(widget.hidden);
      node.classList.toggle('is-selected', this.selection.includes(widget.id));
      node.classList.toggle('is-locked', Boolean(widget.locked));
      node.dataset.path = widget.id;
      this._applyGlass(node, widget);
      this._paint(widget);
    });

    for (const [id, node] of this.elements) {
      if (!seen.has(id)) {
        node.remove();
        this.elements.delete(id);
        this.signatures.delete(id);
      }
    }

    this._syncGizmo(doc, this.selection);
  }

  _placeGizmo(gizmo, doc, path) {
    const rect = layerRect(doc, path);
    if (!rect) {
      gizmo.remove();
      this.gizmo = null;
      return null;
    }
    const canvas = doc.canvas;
    gizmo.style.left = `${((rect.cx - rect.width / 2) / canvas.width) * 100}%`;
    gizmo.style.top = `${((rect.cy - rect.height / 2) / canvas.height) * 100}%`;
    gizmo.style.width = `${(Math.max(1, rect.width) / canvas.width) * 100}%`;
    gizmo.style.height = `${(Math.max(1, rect.height) / canvas.height) * 100}%`;
    gizmo.style.transform = `rotate(${rect.rotation}deg)`;
    return rect;
  }

  /** Keep exactly one selection gizmo (outline + handles) for the selection. */
  _syncGizmo(doc, selection) {
    const paths = selection.filter((path) => path !== 'base');
    if (selection.includes('base') && this.baseEnabled) {
      let gizmo = this.gizmo;
      if (!gizmo || gizmo.dataset.mode !== 'base') {
        this.gizmo?.remove();
        gizmo = el('div', { class: 'gizmo gizmo-base', dataset: { path: 'base', mode: 'base' } });
        this._addHandles(gizmo, 'base');
        this.gizmoLayer.append(gizmo);
        this.gizmo = gizmo;
      }
      this._applyBox(gizmo, doc.base, doc.canvas);
      gizmo.style.transform = 'rotate(0deg)';
      return;
    }
    if (!paths.length) {
      this.gizmo?.remove();
      this.gizmo = null;
      return;
    }

    const multi = paths.length > 1;
    const mode = multi ? 'multi' : paths[0];
    const found = resolvePath(doc, paths[0]);
    let gizmo = this.gizmo;
    if (!gizmo || gizmo.dataset.mode !== mode) {
      this.gizmo?.remove();
      const kind = multi ? 'multi' : found?.layer?.type || 'widget';
      gizmo = el('div', {
        class: `gizmo${multi ? ' gizmo-multi' : ''}`,
        dataset: { mode, path: paths[0], kind },
      });
      gizmo.append(el('span', { class: 'gizmo-tag' }));
      if (!multi) this._addHandles(gizmo, kind);
      this.gizmoLayer.append(gizmo);
      this.gizmo = gizmo;
    }
    gizmo.dataset.path = paths[0];
    if (multi) {
      const union = unionBBox(paths.map((path) => layerBBox(doc, path)));
      if (!union) {
        gizmo.remove();
        this.gizmo = null;
        return;
      }
      const canvas = doc.canvas;
      gizmo.style.left = `${(union.x / canvas.width) * 100}%`;
      gizmo.style.top = `${(union.y / canvas.height) * 100}%`;
      gizmo.style.width = `${(union.width / canvas.width) * 100}%`;
      gizmo.style.height = `${(union.height / canvas.height) * 100}%`;
      gizmo.style.transform = 'rotate(0deg)';
      const tag = gizmo.querySelector('.gizmo-tag');
      if (tag) tag.textContent = `${paths.length} layers`;
    } else {
      this._placeGizmo(gizmo, doc, paths[0]);
    }
  }

  _syncBase(doc, selection, baseSrc) {
    this.baseBox.hidden = !baseSrc;
    this.baseBox.classList.toggle('is-selected', selection.includes('base'));
    if (baseSrc) {
      if (this.baseImage.getAttribute('src') !== baseSrc) this.baseImage.src = baseSrc;
      this.baseImage.style.objectFit = doc.base.fit === 'contain' ? 'contain' : 'cover';
      const flips = [
        doc.base.flipX ? 'scaleX(-1)' : '',
        doc.base.flipY ? 'scaleY(-1)' : '',
      ]
        .filter(Boolean)
        .join(' ');
      this.baseImage.style.transform = flips || 'none';
      this._applyBox(this.baseBox, doc.base, doc.canvas);
      this.baseBox.style.opacity = String(clamp(Number(doc.base.opacity) || 0, 0, 1));
    } else {
      this.baseImage.removeAttribute('src');
    }
  }

  _createWidget(widget) {
    const node = el('div', { class: 'w', dataset: { widgetId: widget.id } });
    node.append(el('canvas', { class: 'w-canvas' }));
    return node;
  }

  _addHandles(node, type) {
    // Both resize modes get all eight handles: the mode decides whether the
    // box keeps its aspect ratio, not how many grips are shown.
    for (const name of ALL_HANDLES) {
      node.append(el('span', { class: `handle handle-${name}`, dataset: { handle: name } }));
    }
    if (type !== 'base') {
      node.append(
        el('span', {
          class: 'handle handle-rotate',
          dataset: { handle: 'rotate' },
          title: 'Rotate (hold Shift to snap)',
          html: '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M20 11a8 8 0 1 0-2.3 6.3" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"/><path d="M20 4v7h-7" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"/></svg>',
        }),
      );
    }
  }

  _applyBox(node, box, canvas) {
    node.style.left = `${(Number(box.x) / canvas.width) * 100}%`;
    node.style.top = `${(Number(box.y) / canvas.height) * 100}%`;
    node.style.width = `${(Number(box.width) / canvas.width) * 100}%`;
    node.style.height = `${(Number(box.height) / canvas.height) * 100}%`;
  }

  _paint(widget) {
    const node = this.elements.get(widget.id);
    if (!node) return;
    const canvas = node.querySelector('canvas');
    const signature = JSON.stringify([widget.width, widget.height, widget.hidden, widget.props]);
    if (this.signatures.get(widget.id) === signature) return;
    this.signatures.set(widget.id, signature);
    paintWidget(canvas, widget, {
      onReady: () => {
        this.signatures.delete(widget.id);
        const current = this.handlers.getDoc().widgets.find((item) => item.id === widget.id);
        if (current) this._paint(current);
      },
    });
  }

  /** Repaint the top-level widget that owns `path` (child edits repaint the whole unit). */
  repaint(path) {
    const id = topPath(path);
    const widget = this.handlers.getDoc().widgets.find((item) => item.id === id);
    if (!widget) return;
    this.signatures.delete(id);
    this._paint(widget);
  }

  updateGeometry(path) {
    const doc = this.handlers.getDoc();
    if (path === 'base') {
      this._applyBox(this.baseBox, doc.base, doc.canvas);
      this.baseBox.style.opacity = String(clamp(Number(doc.base.opacity) || 0, 0, 1));
      if (this.selection.includes('base')) this._syncGizmo(doc, this.selection);
      return;
    }
    const id = topPath(path);
    const node = this.elements.get(id);
    const widget = doc.widgets.find((item) => item.id === id);
    if (!node || !widget) return;
    this._applyBox(node, widget, doc.canvas);
    node.style.transform = `rotate(${Number(widget.rotation) || 0}deg)`;
    node.style.opacity = String(clamp(Number(widget.opacity ?? 1), 0, 1));
    node.hidden = Boolean(widget.hidden);
    this._applyGlass(node, widget);
    if (path !== id) this.repaint(path);
    if (this.selection.includes(path) || this.selection.length > 1) this._syncGizmo(doc, this.selection);
  }

  /** Convert a canvas-space drag delta into a layer's own (parent) space. */
  _toLocal(dx, dy, transform) {
    const angle = ((transform?.rotation || 0) * Math.PI) / 180;
    const cos = Math.cos(angle);
    const sin = Math.sin(angle);
    return {
      x: (dx * cos + dy * sin) / (transform?.scaleX || 1),
      y: (-dx * sin + dy * cos) / (transform?.scaleY || 1),
    };
  }

  _pointerDown(event) {
    if (event.button !== 0) return;
    const doc = this.handlers.getDoc();
    if (!doc) return;
    const handleEl = event.target.closest('[data-handle]');
    const host = event.target.closest('[data-path]') || event.target.closest('[data-widget-id]');
    const path = host?.dataset.path || host?.dataset.widgetId || null;
    if (!path) {
      this.handlers.onSelect([]);
      return;
    }

    if (path === 'base') {
      const model = doc.base;
      event.preventDefault();
      this.handlers.onSelect(['base']);
      const rect = this.stage.getBoundingClientRect();
      const scale = rect.width / doc.canvas.width;
      this.drag = {
        path: 'base',
        handle: handleEl?.dataset.handle || 'move',
        model: JSON.parse(JSON.stringify(model)),
        transform: { scaleX: 1, scaleY: 1, rotation: 0 },
        startX: event.clientX,
        startY: event.clientY,
        rect,
        scale,
        canvasScale: scale,
        moved: false,
        multi: false,
        models: [],
        anchor: {
          right: model.x + model.width,
          bottom: model.y + model.height,
          centreX: rect.left + ((model.x + model.width / 2) / doc.canvas.width) * rect.width,
          centreY: rect.top + ((model.y + model.height / 2) / doc.canvas.height) * rect.height,
          angle: Math.atan2(
            event.clientY - (rect.top + ((model.y + model.height / 2) / doc.canvas.height) * rect.height),
            event.clientX - (rect.left + ((model.x + model.width / 2) / doc.canvas.width) * rect.width),
          ),
        },
      };
      this.handlers.onGestureStart();
      return;
    }

    const selection = this.handlers.getSelection();
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      this.handlers.onToggle(path);
      return;
    }
    const found = resolvePath(doc, path);
    if (!found) return;
    if (isLocked(doc, path)) {
      this.handlers.onSelect([path]);
      return;
    }
    event.preventDefault();
    const handle = handleEl?.dataset.handle || 'move';
    const multi = selection.length > 1 && selection.includes(path) && handle === 'move';
    if (!multi) this.handlers.onSelect([path]);

    const rect = layerRect(doc, path);
    const stageRect = this.stage.getBoundingClientRect();
    const canvasScale = stageRect.width / doc.canvas.width;
    const screenCentre = rect
      ? {
          x: stageRect.left + (rect.cx / doc.canvas.width) * stageRect.width,
          y: stageRect.top + (rect.cy / doc.canvas.height) * stageRect.height,
        }
      : { x: event.clientX, y: event.clientY };
    const transform = pathTransform(doc, path) || { scaleX: 1, scaleY: 1, rotation: 0 };
    const model = found.layer;

    this.drag = {
      path,
      handle,
      multi,
      model: JSON.parse(JSON.stringify(model)),
      transform,
      models: (multi ? selection : [path])
        .map((item) => {
          const entry = resolvePath(doc, item);
          if (!entry) return null;
          return {
            path: item,
            x: Number(entry.layer.x) || 0,
            y: Number(entry.layer.y) || 0,
            transform: pathTransform(doc, item) || { scaleX: 1, scaleY: 1, rotation: 0 },
          };
        })
        .filter(Boolean),
      startX: event.clientX,
      startY: event.clientY,
      rect: stageRect,
      scale: canvasScale,
      canvasScale,
      moved: false,
      anchor: {
        right: model.x + model.width,
        bottom: model.y + model.height,
        centreX: screenCentre.x,
        centreY: screenCentre.y,
        angle: Math.atan2(event.clientY - screenCentre.y, event.clientX - screenCentre.x),
      },
    };
    this.handlers.onGestureStart();
  }

  _pointerMove(event) {
    if (!this.drag) return;
    const drag = this.drag;
    const canvasDx = (event.clientX - drag.startX) / drag.canvasScale;
    const canvasDy = (event.clientY - drag.startY) / drag.canvasScale;
    const local = this._toLocal(canvasDx, canvasDy, drag.transform);
    if (Math.abs(local.x) > 0.5 || Math.abs(local.y) > 0.5) drag.moved = true;

    if (drag.path === 'base') {
      const base = drag.model;
      const box = {
        x: base.x,
        y: base.y,
        width: base.width,
        height: base.height,
        rotation: 0,
      };
      if (drag.handle === 'move') {
        box.x = base.x + canvasDx;
        box.y = base.y + canvasDy;
        if (event.shiftKey) {
          if (Math.abs(canvasDx) > Math.abs(canvasDy)) box.y = base.y;
          else box.x = base.x;
        }
      } else {
        // The base image follows the same resize mode: free mode changes the
        // box aspect, which is what crops the photo to a new ratio.
        const free = this.handlers.getResizeMode?.() === 'free';
        Object.assign(box, resizeBox(base, drag.handle, canvasDx, canvasDy, !free));
        box.rotation = 0;
      }
      this.handlers.onBoxChange('base', box, { live: true, moved: drag.moved });
      return;
    }

    if (drag.multi) {
      const updates = drag.models.map((entry) => {
        const delta = this._toLocal(canvasDx, canvasDy, entry.transform);
        return { path: entry.path, x: entry.x + delta.x, y: entry.y + delta.y };
      });
      this.handlers.onMoveMany(updates, { live: true });
      return;
    }

    const base = drag.model;
    const dx = local.x;
    const dy = local.y;
    let box = {
      x: base.x,
      y: base.y,
      width: base.width,
      height: base.height,
      rotation: Number(base.rotation) || 0,
    };

    if (drag.handle === 'move') {
      box.x = base.x + dx;
      box.y = base.y + dy;
      if (event.shiftKey) {
        if (Math.abs(dx) > Math.abs(dy)) box.y = base.y;
        else box.x = base.x;
      }
    } else if (drag.handle === 'rotate') {
      const angle = Math.atan2(event.clientY - drag.anchor.centreY, event.clientX - drag.anchor.centreX);
      let degrees = Number(base.rotation) || 0;
      degrees += ((angle - drag.anchor.angle) * 180) / Math.PI;
      degrees = (((degrees + 180) % 360) + 360) % 360 - 180;
      if (event.shiftKey) degrees = Math.round(degrees / 15) * 15;
      box.rotation = Math.round(degrees * 10) / 10;
    } else {
      const aspectLocked = this.handlers.getResizeMode?.() !== 'free';
      Object.assign(box, resizeBox(base, drag.handle, dx, dy, aspectLocked));
      box.rotation = Number(base.rotation) || 0;
    }

    this.handlers.onBoxChange(drag.path, box, { live: true, moved: drag.moved });
  }

  _pointerUp() {
    if (!this.drag) return;
    const drag = this.drag;
    this.drag = null;
    this.handlers.onGestureEnd(drag.path, drag.moved);
  }
}
