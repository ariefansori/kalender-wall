import { calendarDesign, paintCalendar } from './calendar.js';
import { getGroup } from './groups.js';
import { paintShape } from './shapes.js';
import { paintSticker, whenReady } from './sticker.js';
import { paintText } from './text.js';

const MAX_BACKING_PIXELS = 6_000_000;

/** Paint one layer of a design-space composite (group or mask) at its own box. */
function paintLayer(ctx, layer, onReady) {
  if (!layer || !layer.type || layer.hidden) return;
  const width = Math.max(1, Number(layer.width) || 1);
  const height = Math.max(1, Number(layer.height) || 1);
  const opacity = layer.opacity == null ? 1 : Number(layer.opacity);
  if (opacity <= 0) return;

  const layerCanvas = document.createElement('canvas');
  paintWidget(layerCanvas, layer, { onReady });
  ctx.save();
  ctx.globalAlpha = Math.min(1, Math.max(0, opacity));
  const centreX = Number(layer.x || 0) + width / 2;
  const centreY = Number(layer.y || 0) + height / 2;
  ctx.translate(centreX, centreY);
  ctx.rotate(((Number(layer.rotation) || 0) * Math.PI) / 180);
  ctx.drawImage(layerCanvas, -width / 2, -height / 2, width, height);
  ctx.restore();
}

function paintGroup(ctx, width, height, props, onReady, widget) {
  const doc = getGroup(props.slug);
  if (!doc || !doc.size) return;
  const designWidth = Math.max(1, Number(doc.size.width) || 1);
  const designHeight = Math.max(1, Number(doc.size.height) || 1);
  const scale = Math.min(width / designWidth, height / designHeight);
  ctx.save();
  ctx.translate((width - designWidth * scale) / 2, (height - designHeight * scale) / 2);
  ctx.scale(scale, scale);
  for (const layer of doc.widgets || []) {
    paintLayer(ctx, layer, () => onReady?.(widget));
  }
  ctx.restore();
}

/** Rasterise composite children into their own design-space canvas. */
function paintDesignCanvas(layers, width, height, onReady) {
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(width));
  canvas.height = Math.max(1, Math.round(height));
  const ctx = canvas.getContext('2d');
  for (const layer of layers) paintLayer(ctx, layer, onReady);
  return canvas;
}

/**
 * A `shapeGroup` is a `<g>` of vector layers drawn as a unit.  A `mask` keeps
 * `props.layers[0]` as the geometric mask source: its alpha clips the layers
 * above it (`destination-in`) or punches a hole through them
 * (`destination-out`), which lets whatever sits below the mask show through.
 * Because the source is re-rasterised on every paint, moving or rotating it
 * updates the clip in real time.
 */
function paintComposite(ctx, width, height, widget, onReady) {
  const props = widget.props || {};
  const design = props.design || {};
  const designWidth = Math.max(1, Number(design.width) || 1);
  const designHeight = Math.max(1, Number(design.height) || 1);
  const layers = (props.layers || []).filter((layer) => layer && !layer.hidden);
  const scale = Math.min(width / designWidth, height / designHeight);
  const drawWidth = designWidth * scale;
  const drawHeight = designHeight * scale;
  const offsetX = (width - drawWidth) / 2;
  const offsetY = (height - drawHeight) / 2;

  if (widget.type === 'shapeGroup' || layers.length < 2) {
    const group = paintDesignCanvas(layers, designWidth, designHeight, onReady);
    ctx.drawImage(group, offsetX, offsetY, drawWidth, drawHeight);
    return;
  }

  const base = paintDesignCanvas([layers[0]], designWidth, designHeight, onReady);
  const content = paintDesignCanvas(layers.slice(1), designWidth, designHeight, onReady);
  const contentCtx = content.getContext('2d');
  contentCtx.save();
  contentCtx.globalCompositeOperation = props.invert ? 'destination-out' : 'destination-in';
  contentCtx.drawImage(base, 0, 0);
  contentCtx.restore();

  if (!props.invert) ctx.drawImage(base, offsetX, offsetY, drawWidth, drawHeight);
  ctx.drawImage(content, offsetX, offsetY, drawWidth, drawHeight);
}

/**
 * Frosted-glass backplate request for a calendar card.  The stage turns this
 * into a CSS `backdrop-filter`, which blurs the base image and lower layers
 * behind the translucent card; the Pillow compositor blurs the canvas under
 * the same box.  Rotated cards fall back to a plain translucent card.
 */
export function glassFor(widget) {
  if (!widget || widget.type !== 'calendar') return null;
  const props = widget.props || {};
  if (!props.glass) return null;
  if (Math.abs(Number(widget.rotation) || 0) > 0.5) return null;
  const [designWidth, designHeight] = calendarDesign(props);
  return {
    blur: Math.max(0, Math.min(80, Number(props.glassBlur) || 0)),
    designWidth,
    designHeight,
  };
}

/**
 * Paint a widget into its canvas at (up to) the wallpaper's native resolution.
 * Returns the canvas so callers can pass it to a compositor if needed.
 */
export function paintWidget(canvas, widget, { onReady } = {}) {
  const width = Math.max(1, Math.round(Number(widget.width) || 1));
  const height = Math.max(1, Math.round(Number(widget.height) || 1));
  const pixelBudget = Math.min(1, Math.sqrt(MAX_BACKING_PIXELS / (width * height)));
  const backingWidth = Math.max(1, Math.round(width * pixelBudget));
  const backingHeight = Math.max(1, Math.round(height * pixelBudget));

  if (canvas.width !== backingWidth || canvas.height !== backingHeight) {
    canvas.width = backingWidth;
    canvas.height = backingHeight;
  }
  const ctx = canvas.getContext('2d');
  ctx.setTransform(1, 0, 0, 1, 0, 0);
  ctx.clearRect(0, 0, backingWidth, backingHeight);
  if (widget.hidden) return canvas;
  ctx.save();
  ctx.scale(backingWidth / width, backingHeight / height);

  const props = widget.props || {};
  if (widget.type === 'text') {
    paintText(ctx, width, height, props);
  } else if (widget.type === 'calendar') {
    paintCalendar(ctx, width, height, props);
  } else if (widget.type === 'sticker') {
    paintSticker(ctx, width, height, props.src);
    if (props.src) whenReady(props.src, () => onReady?.(widget));
  } else if (widget.type === 'shape') {
    paintShape(ctx, width, height, props);
  } else if (widget.type === 'shapeGroup' || widget.type === 'mask') {
    paintComposite(ctx, width, height, widget, onReady);
  } else if (widget.type === 'group') {
    paintGroup(ctx, width, height, props, onReady, widget);
  }
  ctx.restore();
  return canvas;
}
