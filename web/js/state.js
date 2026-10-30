import { calendarDesign } from './render/calendar.js';
import { groupName } from './render/groups.js';
import { shapeById, shapeLabel } from './render/shapes.js';
import { expandTokens } from './render/text.js';

export function makeId(prefix = 'w') {
  return `${prefix}-${Math.random().toString(36).slice(2, 8)}${Date.now().toString(36).slice(-3)}`;
}

export function blankDoc(config) {
  const canvas = { ...config.canvas };
  return {
    version: 1,
    name: 'Untitled preset',
    // New presets start with whatever the light/dark schedule says right now;
    // the stored clockTheme is only a fallback for configs without a schedule.
    theme: config.timeWindow?.theme === 'light' ? 'light'
      : config.timeWindow?.theme === 'dark' ? 'dark'
        : config.clockTheme === 'light' ? 'light' : 'dark',
    sourceWidth: canvas.width,
    sourceHeight: canvas.height,
    canvas,
    base: {
      file: '',
      x: 0,
      y: 0,
      width: canvas.width,
      height: canvas.height,
      fit: 'cover',
      opacity: 1,
      visible: true,
      flipX: false,
      flipY: false,
    },
    widgets: [],
  };
}

/** Contain the image inside the canvas while preserving its aspect ratio. */
export function baseSizing(canvas, imageWidth, imageHeight) {
  const scale = Math.min(canvas.width / imageWidth, canvas.height / imageHeight);
  const width = imageWidth * scale;
  const height = imageHeight * scale;
  return {
    x: (canvas.width - width) / 2,
    y: (canvas.height - height) / 2,
    width,
    height,
  };
}

function centred(canvas, width, height, vertical = 0.5) {
  return {
    x: (canvas.width - width) / 2,
    y: (canvas.height - height) * vertical,
    width,
    height,
  };
}

export function newTextWidget(config, doc) {
  const palette = config.palette[doc.theme] || config.palette.dark;
  const width = Math.min(1200, doc.canvas.width * 0.55);
  const height = 180;
  return {
    id: makeId('text'),
    type: 'text',
    ...centred(doc.canvas, width, height, 0.32),
    rotation: 0,
    opacity: 1,
    hidden: false,
    locked: false,
    props: {
      ...config.defaults.text,
      font: 'barlow-condensed',
      weight: 700,
      size: Math.max(40, Math.round(doc.canvas.width * 0.055)),
      color: palette.fg,
      text: 'Type something',
    },
  };
}

export function newCalendarWidget(config, doc, style = 'grid', layout = 'auto') {
  const [designW, designH] = calendarDesign({ style, layout });
  const palette = config.palette[doc.theme] || config.palette.dark;
  const maxWidth = doc.canvas.width * 0.8;
  const maxHeight = doc.canvas.height * 0.8;
  const fit = Math.min(maxWidth / designW, maxHeight / designH, 1);
  const width = Math.max(80, designW * fit);
  const height = (width * designH) / designW;
  return {
    id: makeId('cal'),
    type: 'calendar',
    ...centred(doc.canvas, width, height, 0.55),
    rotation: 0,
    opacity: 1,
    hidden: false,
    locked: false,
    props: {
      ...config.defaults.calendar,
      style,
      layout,
      font: 'barlow-condensed',
      fg: palette.fg,
      muted: palette.muted,
      accent: palette.accent,
      accentText: palette.accentText,
      bg: doc.theme === 'light' ? '#f7f2e9f0' : '#101014e6',
    },
  };
}

export function newShapeWidget(config, doc, shape) {
  const palette = config.palette[doc.theme] || config.palette.dark;
  const meta = shapeById(shape.id) || shape;
  const size = Math.min(360, doc.canvas.width * 0.28, doc.canvas.height * 0.4);
  const filled = meta?.fill !== false;
  return {
    id: makeId('shape'),
    type: 'shape',
    ...centred(doc.canvas, size, size, 0.4),
    rotation: 0,
    opacity: 1,
    hidden: false,
    locked: false,
    props: {
      shape: meta?.id || 'square',
      fill: filled ? palette.fg : '#00000000',
      stroke: filled ? '#00000000' : palette.accent,
      strokeWidth: Number(meta?.strokeWidth) || 0,
    },
  };
}

export function newStickerWidget(config, doc, sticker) {
  const aspect = sticker.width / sticker.height || 1;
  const height = Math.min(420, doc.canvas.height * 0.32);
  const width = height * aspect;
  return {
    id: makeId('sticker'),
    type: 'sticker',
    ...centred(doc.canvas, width, height, 0.4),
    rotation: 0,
    opacity: 1,
    hidden: false,
    locked: false,
    props: { ...config.defaults.sticker, src: sticker.name },
  };
}

export function newGroupWidget(config, doc, group) {
  const aspect = group.width > 0 && group.height > 0 ? group.height / group.width : 0.5;
  const width = Math.min(group.width || 600, doc.canvas.width * 0.62);
  const height = width * aspect;
  return {
    id: makeId('group'),
    type: 'group',
    ...centred(doc.canvas, width, height, 0.5),
    rotation: 0,
    opacity: 1,
    hidden: false,
    locked: false,
    props: { slug: group.slug },
  };
}

export function cloneWidget(widget) {
  return JSON.parse(JSON.stringify(widget));
}

export function displayNameFor(widget) {
  if (!widget) return '';
  if (widget.type === 'text') {
    const text = expandTokens(widget.props.text || '').trim().replace(/\s+/g, ' ');
    return text ? text.slice(0, 34) : 'Empty text';
  }
  if (widget.type === 'calendar') {
    const layout = widget.props.layout && widget.props.layout !== 'auto' ? ` · ${widget.props.layout}` : '';
    return `Calendar · ${widget.props.style || 'grid'}${layout}`;
  }
  if (widget.type === 'sticker') return widget.props.src || 'Sticker';
  if (widget.type === 'shape') return `Shape · ${shapeLabel(widget.props.shape)}`;
  if (widget.type === 'shapeGroup') {
    const count = (widget.props.layers || []).length;
    return `Group · ${count} vector layer${count === 1 ? '' : 's'}`;
  }
  if (widget.type === 'mask') {
    const count = Math.max(0, (widget.props.layers || []).length - 1);
    return `${widget.props.invert ? 'Hole mask' : 'Clip mask'} · ${count} layer${count === 1 ? '' : 's'}`;
  }
  if (widget.type === 'group') return `Widget · ${groupName(widget.props.slug)}`;
  return widget.type;
}

// -- reusable widget documents -------------------------------------------

/** Editor-friendly document for the widget page (canvas + layers). */
export function blankWidgetDoc(width = 720, height = 280, name = 'Untitled widget') {
  const size = { width: Math.max(80, Math.round(width)), height: Math.max(80, Math.round(height)) };
  return {
    version: 1,
    name,
    theme: 'dark',
    size,
    canvas: { width: size.width, height: size.height, background: '#26262c' },
    base: {
      file: '',
      x: 0,
      y: 0,
      width: size.width,
      height: size.height,
      fit: 'cover',
      opacity: 1,
      visible: true,
    },
    widgets: [],
  };
}

export function widgetDocFrom(widget) {
  const size = {
    width: Math.max(80, Math.round(Number(widget.size?.width) || 600)),
    height: Math.max(80, Math.round(Number(widget.size?.height) || 300)),
  };
  return {
    ...blankWidgetDoc(size.width, size.height, widget.name || 'Untitled widget'),
    createdAt: widget.createdAt,
    updatedAt: widget.updatedAt,
    widgets: cloneWidget(widget.widgets || []),
  };
}

export function widgetPayload(doc) {
  return {
    version: 1,
    name: doc.name,
    size: {
      width: Math.max(80, Math.round(Number(doc.size?.width) || 600)),
      height: Math.max(80, Math.round(Number(doc.size?.height) || 300)),
    },
    widgets: doc.widgets,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}
