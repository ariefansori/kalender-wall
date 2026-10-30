/**
 * Shape registry: the built-in SVG shape library.
 *
 * The geometry lives on the server (`hyprwall/widgets/shapes.py`) in a single
 * universal `0 0 100 100` viewBox and arrives through `/api/config`, so the
 * editor, the widget page and the Pillow compositor draw the exact same path.
 * A shape always fills its layer box, scaling X and Y independently: with the
 * aspect-locked handles the box keeps its ratio (so the shape looks identical),
 * and in free transform mode stretching the box stretches the shape — a square
 * becomes a rectangle.
 */
const shapes = new Map();
const pathCache = new Map();

export function setShapeLibrary(items) {
  shapes.clear();
  pathCache.clear();
  for (const item of items || []) {
    if (item && item.id) shapes.set(item.id, item);
  }
}

export function shapeList() {
  return [...shapes.values()];
}

export function shapeById(id) {
  return shapes.get(id) || null;
}

export function shapeLabel(id) {
  return shapes.get(id)?.label || 'Shape';
}

function pathFor(d) {
  if (!pathCache.has(d)) pathCache.set(d, new Path2D(d));
  return pathCache.get(d);
}

/** Paint one shape into a `width` x `height` layer. */
export function paintShape(ctx, width, height, props = {}) {
  const shape = shapeById(props.shape);
  if (!shape) return;
  // Map the 0–100 viewBox onto the whole box, independently per axis.
  ctx.save();
  ctx.scale(width / 100, height / 100);
  const path = pathFor(shape.d);
  const fill = props.fill;
  if (fill && fill !== '#00000000') {
    ctx.fillStyle = fill;
    ctx.fill(path);
  }
  const strokeWidth = Math.max(0, Math.min(40, Number(props.strokeWidth) || 0));
  const stroke = props.stroke;
  if (stroke && stroke !== '#00000000' && strokeWidth > 0) {
    ctx.strokeStyle = stroke;
    ctx.lineWidth = strokeWidth;
    ctx.lineJoin = 'round';
    ctx.lineCap = 'round';
    ctx.stroke(path);
  }
  ctx.restore();
}

/** Small inline SVG used by the shape picker tiles. */
export function shapePreviewMarkup(shape, color = '#f4efe6') {
  if (!shape) return '';
  const stroke = shape.fill ? 'none' : color;
  const width = shape.fill ? 0 : 6;
  return (
    `<svg viewBox="0 0 100 100" aria-hidden="true" preserveAspectRatio="xMidYMid meet">` +
    `<path d="${shape.d}" fill="${shape.fill ? color : 'none'}" stroke="${stroke}" ` +
    `stroke-width="${width}" stroke-linejoin="round" stroke-linecap="round"/></svg>`
  );
}
