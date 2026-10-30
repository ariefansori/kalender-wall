/**
 * Layer tree helpers: paths, transforms, grouping and masking.
 *
 * A layer is addressed by its *path*: top-level widgets use their id
 * (`"abc"`), children of a group or mask use `"abc/def"`, and nesting keeps
 * extending.  Everything the editor does — selection, geometry, z-order,
 * grouping — resolves through these helpers so nested layers behave like
 * first-class objects without duplicating data.
 */
import { makeId } from './state.js';

export const COMPOSITE_TYPES = ['shapeGroup', 'mask'];
export const VECTOR_TYPES = ['shape', 'shapeGroup'];
/** Layer types a composite may contain (mirrors `COMPOSITE_CHILDREN`). */
export const COMPOSITE_CHILDREN = {
  shapeGroup: ['shape', 'shapeGroup'],
  mask: ['text', 'calendar', 'sticker', 'shape', 'shapeGroup'],
};

export function isComposite(widget) {
  return Boolean(widget) && COMPOSITE_TYPES.includes(widget.type);
}

export function childLayers(widget) {
  if (!isComposite(widget)) return [];
  return Array.isArray(widget.props?.layers) ? widget.props.layers : [];
}

export function splitPath(path) {
  return String(path || '').split('/').filter(Boolean);
}

export function topPath(path) {
  return splitPath(path)[0] || null;
}

export function parentPath(path) {
  const parts = splitPath(path);
  return parts.length > 1 ? parts.slice(0, -1).join('/') : null;
}

export function joinPath(...parts) {
  return parts.filter(Boolean).join('/');
}

/** Containers are the document's widget list or a composite's `layers`. */
export function docContainer(doc) {
  return doc?.widgets || [];
}

/** Resolve a path into its layer, owning array and index within it. */
export function resolvePath(doc, path) {
  const parts = splitPath(path);
  if (!parts.length) return null;
  let list = docContainer(doc);
  let layer = null;
  for (let index = 0; index < parts.length; index += 1) {
    layer = list.find((item) => item.id === parts[index]) || null;
    if (!layer) return null;
    if (index < parts.length - 1) {
      list = childLayers(layer);
      if (!list.length) return null;
    }
  }
  return {
    layer,
    list,
    index: list.indexOf(layer),
    parent: parts.length > 1 ? resolvePath(doc, parts.slice(0, -1).join('/'))?.layer || null : null,
  };
}

export function findById(doc, id, path = '') {
  for (const widget of docContainer(doc)) {
    const here = path ? `${path}/${widget.id}` : widget.id;
    if (widget.id === id) return { layer: widget, path: here };
    if (isComposite(widget)) {
      const nested = findById({ widgets: childLayers(widget) }, id, here);
      if (nested) return nested;
    }
  }
  return null;
}

/** Every path in the document, parents before children. */
export function allPaths(doc) {
  const paths = [];
  const walk = (layers, prefix) => {
    for (const layer of layers || []) {
      const path = prefix ? `${prefix}/${layer.id}` : layer.id;
      paths.push(path);
      if (isComposite(layer)) walk(childLayers(layer), path);
    }
  };
  walk(docContainer(doc), '');
  return paths;
}

/** Map a composite's design space into its parent space (canvas for top level). */
function boxMapper(widget) {
  const design = widget.props?.design || {};
  const designWidth = Math.max(1, Number(design.width) || Number(widget.width) || 1);
  const designHeight = Math.max(1, Number(design.height) || Number(widget.height) || 1);
  const scaleX = Number(widget.width) / designWidth;
  const scaleY = Number(widget.height) / designHeight;
  const x = Number(widget.x) || 0;
  const y = Number(widget.y) || 0;
  const width = Number(widget.width) || 1;
  const height = Number(widget.height) || 1;
  const centreX = x + width / 2;
  const centreY = y + height / 2;
  const angle = ((Number(widget.rotation) || 0) * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  return {
    scaleX,
    scaleY,
    rotation: Number(widget.rotation) || 0,
    map(px, py) {
      const localX = x + px * scaleX - centreX;
      const localY = y + py * scaleY - centreY;
      return {
        x: centreX + localX * cos - localY * sin,
        y: centreY + localX * sin + localY * cos,
      };
    },
  };
}

/**
 * Compose the transforms of a layer's ancestors: `map` takes a point in the
 * layer's parent design space to canvas coordinates, `scaleX`/`scaleY` say how
 * much the ancestors magnify it and `rotation` is their combined angle.
 */
export function pathTransform(doc, path) {
  const parts = splitPath(path);
  if (!parts.length) return null;
  let list = docContainer(doc);
  let map = (x, y) => ({ x, y });
  let scaleX = 1;
  let scaleY = 1;
  let rotation = 0;
  let layer = null;
  for (let index = 0; index < parts.length; index += 1) {
    layer = list.find((item) => item.id === parts[index]) || null;
    if (!layer) return null;
    if (index < parts.length - 1) {
      const mapper = boxMapper(layer);
      const previous = map;
      map = (x, y) => {
        const point = mapper.map(x, y);
        return previous(point.x, point.y);
      };
      scaleX *= mapper.scaleX;
      scaleY *= mapper.scaleY;
      rotation += mapper.rotation;
      list = childLayers(layer);
    }
  }
  return { map, scaleX, scaleY, rotation, layer };
}

/** Canvas-space rectangle of a layer, including its own and ancestors' rotation. */
export function layerRect(doc, path) {
  const transform = pathTransform(doc, path);
  if (!transform) return null;
  const { layer } = transform;
  const width = Math.max(0, Number(layer.width) || 0) * transform.scaleX;
  const height = Math.max(0, Number(layer.height) || 0) * transform.scaleY;
  const centre = transform.map(
    (Number(layer.x) || 0) + (Number(layer.width) || 0) / 2,
    (Number(layer.y) || 0) + (Number(layer.height) || 0) / 2,
  );
  return {
    cx: centre.x,
    cy: centre.y,
    width,
    height,
    rotation: transform.rotation + (Number(layer.rotation) || 0),
  };
}

export function rectCorners(rect) {
  if (!rect) return [];
  const angle = (rect.rotation * Math.PI) / 180;
  const cos = Math.cos(angle);
  const sin = Math.sin(angle);
  const halfWidth = rect.width / 2;
  const halfHeight = rect.height / 2;
  return [
    [-halfWidth, -halfHeight],
    [halfWidth, -halfHeight],
    [halfWidth, halfHeight],
    [-halfWidth, halfHeight],
  ].map(([x, y]) => ({
    x: rect.cx + x * cos - y * sin,
    y: rect.cy + x * sin + y * cos,
  }));
}

export function bboxOf(points) {
  if (!points.length) return null;
  const xs = points.map((point) => point.x);
  const ys = points.map((point) => point.y);
  const left = Math.min(...xs);
  const top = Math.min(...ys);
  const right = Math.max(...xs);
  const bottom = Math.max(...ys);
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function layerBBox(doc, path) {
  return bboxOf(rectCorners(layerRect(doc, path)));
}

export function unionBBox(rects) {
  const boxes = rects.filter(Boolean);
  if (!boxes.length) return null;
  const left = Math.min(...boxes.map((box) => box.x));
  const top = Math.min(...boxes.map((box) => box.y));
  const right = Math.max(...boxes.map((box) => box.x + box.width));
  const bottom = Math.max(...boxes.map((box) => box.y + box.height));
  return { x: left, y: top, width: right - left, height: bottom - top };
}

export function cloneLayer(widget) {
  const copy = JSON.parse(JSON.stringify(widget));
  const reid = (layer) => {
    layer.id = makeId(layer.type || 'layer');
    if (isComposite(layer)) layer.props.layers.forEach(reid);
  };
  if (isComposite(copy)) copy.props.layers.forEach(reid);
  return copy;
}

function resolveSelection(doc, paths) {
  const unique = [...new Set((paths || []).filter(Boolean))];
  const entries = unique
    .map((path) => ({ path, ...(resolvePath(doc, path) || {}) }))
    .filter((entry) => entry.layer);
  return entries;
}

/**
 * Group vector layers into a `<g>`, or build a mask from the selection.
 *
 * The composite's design space is the union bounding box of the selection, so
 * children keep their relative placement.  For a mask the bottom-most selected
 * layer becomes `layers[0]` — the geometric source the others are clipped by.
 */
export function composeLayers(doc, paths, { type = 'shapeGroup', invert = false } = {}) {
  const entries = resolveSelection(doc, paths);
  const label = type === 'mask' ? 'mask' : 'group';
  if (entries.length < 2) {
    return {
      error: `Select at least 2 layers to make a ${label} — shift-click layers in the panel to add to the selection.`,
    };
  }
  const list = entries[0].list;
  if (entries.some((entry) => entry.list !== list)) {
    return { error: `Layers from the same level must be selected to make a ${label}.` };
  }
  const allowed = COMPOSITE_CHILDREN[type] || [];
  if (entries.some((entry) => !allowed.includes(entry.layer.type))) {
    return {
      error:
        type === 'mask'
          ? 'A mask needs text, calendar, sticker or SVG layers.'
          : 'Only SVG layers (shapes and shape groups) can be grouped this way.',
    };
  }
  const boxes = entries.map((entry) => layerBBox(doc, entry.path));
  const bounds = unionBBox(boxes);
  if (!bounds || bounds.width < 1 || bounds.height < 1) {
    return { error: 'Those layers have no usable bounds.' };
  }

  const ordered = [...entries].sort((a, b) => a.index - b.index);
  const children = ordered.map((entry) => {
    const rect = layerRect(doc, entry.path);
    const copy = cloneLayer(entry.layer);
    copy.x = rect.cx - rect.width / 2 - bounds.x;
    copy.y = rect.cy - rect.height / 2 - bounds.y;
    copy.width = rect.width;
    copy.height = rect.height;
    copy.rotation = rect.rotation;
    return copy;
  });

  const composite = {
    id: makeId(type === 'mask' ? 'mask' : 'grp'),
    type,
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    rotation: 0,
    opacity: 1,
    hidden: false,
    locked: false,
    props:
      type === 'mask'
        ? { invert: Boolean(invert), design: { width: bounds.width, height: bounds.height }, layers: children }
        : { design: { width: bounds.width, height: bounds.height }, layers: children },
  };

  const indexes = ordered.map((entry) => entry.index);
  const insertAt = Math.max(...indexes);
  const below = indexes.filter((index) => index < insertAt).length;
  for (const index of [...indexes].sort((a, b) => b - a)) list.splice(index, 1);
  list.splice(Math.max(0, insertAt - below), 0, composite);
  return { composite, path: pathOfLayer(doc, composite.id) };
}

/** Path of a top-level layer id, used right after inserting it. */
function pathOfLayer(doc, id) {
  const found = findById(doc, id);
  return found ? found.path : id;
}

/** Flatten a group or mask back into its parent, preserving canvas placement. */
export function ungroupLayer(doc, path) {
  const found = resolvePath(doc, path);
  if (!found || !isComposite(found.layer)) {
    return { error: 'Select a group or mask layer to ungroup.' };
  }
  const children = childLayers(found.layer);
  if (!children.length) return { error: 'That layer has no children.' };
  const flattened = children.map((child) => {
    const childPath = `${path}/${child.id}`;
    const transform = pathTransform(doc, childPath);
    const layer = transform?.layer || child;
    const scaleX = transform?.scaleX ?? 1;
    const scaleY = transform?.scaleY ?? 1;
    const width = (Number(layer.width) || 0) * scaleX;
    const height = (Number(layer.height) || 0) * scaleY;
    const centre = transform
      ? transform.map(
          (Number(layer.x) || 0) + (Number(layer.width) || 0) / 2,
          (Number(layer.y) || 0) + (Number(layer.height) || 0) / 2,
        )
      : { x: Number(layer.x) || 0, y: Number(layer.y) || 0 };
    const copy = JSON.parse(JSON.stringify(layer));
    copy.x = centre.x - width / 2;
    copy.y = centre.y - height / 2;
    copy.width = width;
    copy.height = height;
    copy.rotation = (Number(layer.rotation) || 0) + (transform?.rotation || 0);
    return copy;
  });
  found.list.splice(found.index, 1, ...flattened);
  return { layers: flattened };
}

export function moveLayer(doc, path, delta) {
  const found = resolvePath(doc, path);
  if (!found) return false;
  const target = found.index + delta;
  if (target < 0 || target >= found.list.length) return false;
  [found.list[found.index], found.list[target]] = [found.list[target], found.list[found.index]];
  return true;
}

export function toggleLayerFlag(doc, path, flag) {
  const found = resolvePath(doc, path);
  if (!found || !['hidden', 'locked'].includes(flag)) return false;
  found.layer[flag] = !found.layer[flag];
  return true;
}

export function toggleMaskInvert(doc, path) {
  const found = resolvePath(doc, path);
  if (!found || found.layer.type !== 'mask') return false;
  found.layer.props.invert = !found.layer.props.invert;
  return true;
}

/** True when a layer or any of its ancestors is locked. */
export function isLocked(doc, path) {
  const parts = splitPath(path);
  let list = docContainer(doc);
  for (let index = 0; index < parts.length; index += 1) {
    const layer = list.find((item) => item.id === parts[index]);
    if (!layer) return false;
    if (layer.locked) return true;
    list = childLayers(layer);
  }
  return false;
}
