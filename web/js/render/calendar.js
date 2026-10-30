import { cssNameFor } from '../fonts.js';
import { measureLine } from './text.js';

export const CALENDAR_DESIGNS = {
  grid: [880, 620],
  strip: [1800, 320],
  minimal: [520, 640],
};

/** Layout overrides: one row of days, or one column of days. */
export const CALENDAR_LAYOUTS = {
  horizontal: [1800, 280],
  vertical: [420, 1240],
};

export function calendarDesign(props = {}) {
  const layout = CALENDAR_LAYOUTS[props.layout] ? props.layout : null;
  if (layout) return CALENDAR_LAYOUTS[layout];
  return CALENDAR_DESIGNS[props.style] || CALENDAR_DESIGNS.grid;
}

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAY_HEADERS = {
  0: ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'],
  1: ['MO', 'TU', 'WE', 'TH', 'FR', 'SA', 'SU'],
};
const WEEKDAY_INITIALS = {
  0: ['S', 'M', 'T', 'W', 'T', 'F', 'S'],
  1: ['M', 'T', 'W', 'T', 'F', 'S', 'S'],
};
const DAY_NAMES = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];

export function parseIsoDate(value) {
  if (typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const [year, month, day] = value.split('-').map(Number);
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() === year && parsed.getMonth() === month - 1 && parsed.getDate() === day) {
      return parsed;
    }
  }
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate());
}

export function resolveStyle(props) {
  const style = CALENDAR_DESIGNS[props.style] ? props.style : 'grid';
  const layout = CALENDAR_LAYOUTS[props.layout] ? props.layout : 'auto';
  return {
    style,
    layout,
    date: parseIsoDate(props.date),
    weekStart: Number(props.weekStart) === 0 ? 0 : 1,
    font: props.font || 'barlow-condensed',
    bg: props.bg || '#00000000',
    fg: props.fg || '#f4efe6',
    muted: props.muted || '#8b8b8b',
    accent: props.accent || '#e2342b',
    accentText: props.accentText || '#fdf6ec',
    showTitle: props.showTitle !== false,
    showWeekdays: props.showWeekdays !== false,
    showLines: props.showLines !== false,
    radius: Math.max(0, Number(props.radius) || 0),
    glass: Boolean(props.glass),
    glassBlur: Math.max(0, Math.min(80, Number(props.glassBlur) || 0)),
    card: props.card !== false,
  };
}

function monthWeeks(year, monthIndex, weekStart) {
  const first = new Date(year, monthIndex, 1);
  const daysInMonth = new Date(year, monthIndex + 1, 0).getDate();
  const offset = weekStart === 1 ? (first.getDay() + 6) % 7 : first.getDay();
  const cells = Array.from({ length: offset }, () => 0);
  for (let day = 1; day <= daysInMonth; day += 1) cells.push(day);
  while (cells.length % 7 !== 0) cells.push(0);
  const weeks = [];
  for (let index = 0; index < cells.length; index += 7) {
    weeks.push(cells.slice(index, index + 7));
  }
  return weeks.filter((week) => week.some((value) => value));
}

function verticalBaseline(size, centre) {
  return centre + size * 0.36;
}

class Pen {
  constructor(ctx, scale, offsetX, offsetY, family) {
    this.ctx = ctx;
    this.scale = scale;
    this.ox = offsetX;
    this.oy = offsetY;
    this.family = cssNameFor(family);
    this.ctx.textBaseline = 'alphabetic';
  }

  _font(size, weight) {
    const px = Math.max(1, Math.round(size * this.scale));
    return `${Math.round(weight)} ${px}px "${this.family}"`;
  }

  width(size, weight, text, spacing = 0) {
    this.ctx.font = this._font(size, weight);
    return measureLine(this.ctx, text, spacing * this.scale) / this.scale;
  }

  text(x, baseline, text, size, weight = 500, color = '#ffffff', spacing = 0, anchor = 'left') {
    if (!text) return;
    this.ctx.font = this._font(size, weight);
    this.ctx.fillStyle = color;
    const gap = spacing * this.scale;
    const width = measureLine(this.ctx, text, gap);
    let px = this.ox + x * this.scale;
    const py = this.oy + baseline * this.scale;
    if (anchor === 'center') px -= width / 2;
    else if (anchor === 'right') px -= width;
    let cursor = px;
    for (const char of [...text]) {
      this.ctx.fillText(char, cursor, py);
      cursor += this.ctx.measureText(char).width + gap;
    }
  }

  rect([x0, y0, x1, y1], fill, radius = 0) {
    if (!fill || fill === '#00000000') return;
    const left = this.ox + x0 * this.scale;
    const top = this.oy + y0 * this.scale;
    const width = (x1 - x0) * this.scale;
    const height = (y1 - y0) * this.scale;
    if (width <= 0 || height <= 0) return;
    const limit = Math.min(width, height) / 2;
    const corner = Math.min(radius * this.scale, limit);
    const ctx = this.ctx;
    ctx.fillStyle = fill;
    ctx.beginPath();
    if (corner <= 0.2) {
      ctx.rect(left, top, width, height);
    } else if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(left, top, width, height, corner);
    } else {
      ctx.moveTo(left + corner, top);
      ctx.arcTo(left + width, top, left + width, top + height, corner);
      ctx.arcTo(left + width, top + height, left, top + height, corner);
      ctx.arcTo(left, top + height, left, top, corner);
      ctx.arcTo(left, top, left + width, top, corner);
      ctx.closePath();
    }
    ctx.fill();
  }

  rule(x0, y0, x1, y1, stroke, width = 1) {
    if (!stroke || stroke === '#00000000') return;
    const ctx = this.ctx;
    ctx.beginPath();
    ctx.strokeStyle = stroke;
    ctx.lineWidth = Math.max(1, width * this.scale);
    ctx.moveTo(this.ox + x0 * this.scale, this.oy + y0 * this.scale);
    ctx.lineTo(this.ox + x1 * this.scale, this.oy + y1 * this.scale);
    ctx.stroke();
  }
}

function alpha(color, value) {
  const match = /^#([0-9a-f]{6})([0-9a-f]{2})?$/i.exec(color || '');
  if (!match) return color;
  const base = match[1];
  const existing = match[2] ? parseInt(match[2], 16) / 255 : 1;
  const next = Math.round(Math.min(1, existing * value) * 255)
    .toString(16)
    .padStart(2, '0');
  return `#${base}${next}`;
}

function drawGrid(pen, style) {
  const [designW, designH] = CALENDAR_DESIGNS.grid;
  const pad = 46;
  if (style.card) pen.rect([0, 0, designW, designH], style.bg, style.radius);

  const year = style.date.getFullYear();
  const month = style.date.getMonth();
  const today = style.date.getDate();
  const weeks = monthWeeks(year, month, style.weekStart);

  let headerBottom = pad;
  if (style.showTitle) {
    pen.text(pad, pad + 52, MONTHS[month].toUpperCase(), 62, 700, style.fg, 2);
    pen.text(designW - pad, pad + 50, String(year), 24, 500, style.muted, 1.5, 'right');
    pen.rule(pad, pad + 84, designW - pad, pad + 84, alpha(style.fg, 0.18));
    headerBottom = pad + 104;
  }

  const cellWidth = (designW - pad * 2) / 7;
  if (style.showWeekdays) {
    const labels = WEEKDAY_HEADERS[style.weekStart];
    labels.forEach((label, index) => {
      const centre = pad + cellWidth * (index + 0.5);
      pen.text(centre, headerBottom + 18, label, 18, 500, style.muted, 1.2, 'center');
    });
  }

  const top = headerBottom + (style.showWeekdays ? 34 : 10);
  const bottom = designH - pad;
  const cellHeight = (bottom - top) / weeks.length;
  const numberSize = Math.min(cellHeight * 0.46, 32);

  if (style.showLines) {
    for (let row = 1; row < weeks.length; row += 1) {
      const y = top + cellHeight * row;
      pen.rule(pad, y, designW - pad, y, alpha(style.fg, 0.1));
    }
  }

  weeks.forEach((week, row) => {
    const centreY = top + cellHeight * (row + 0.5);
    week.forEach((day, column) => {
      if (!day) return;
      const centreX = pad + cellWidth * (column + 0.5);
      const isToday = day === today;
      if (isToday) {
        const pill = Math.min(cellHeight * 0.72, 54);
        const half = pill / 2;
        pen.rect(
          [centreX - half, centreY - half, centreX + half, centreY + half],
          style.accent,
          pill * 0.3,
        );
      }
      pen.text(
        centreX,
        verticalBaseline(numberSize, centreY),
        String(day),
        numberSize,
        600,
        isToday ? style.accentText : style.fg,
        0,
        'center',
      );
    });
  });
}

function drawStrip(pen, style) {
  const [designW, designH] = CALENDAR_DESIGNS.strip;
  const pad = 40;
  if (style.card) pen.rect([0, 0, designW, designH], style.bg, style.radius);

  const year = style.date.getFullYear();
  const month = style.date.getMonth();
  const today = style.date.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let daysLeft = pad;
  if (style.showTitle) {
    pen.text(pad, 62, `CALENDAR · ${year}`, 20, 500, style.muted, 3.4);
    pen.text(pad - 4, 244, MONTHS[month].slice(0, 3).toUpperCase(), 190, 800, style.fg, -1);
    pen.rect([pad, 264, pad + 116, 269], style.accent, 1);
    daysLeft = 470;
    pen.rule(440, 28, 440, designH - 28, alpha(style.fg, 0.22));
  }

  const top = 26;
  const bottom = designH - 26;
  const rows = 2;
  const columns = Math.ceil(daysInMonth / rows);
  const cellWidth = (designW - pad - daysLeft) / columns;
  const rowHeight = (bottom - top) / rows;
  const initials = WEEKDAY_INITIALS[style.weekStart];

  if (style.showLines) {
    pen.rule(daysLeft, top + rowHeight, designW - pad, top + rowHeight, alpha(style.fg, 0.14));
  }

  for (let index = 0; index < daysInMonth; index += 1) {
    const day = index + 1;
    const row = Math.floor(index / columns);
    const column = index % columns;
    const centreX = daysLeft + cellWidth * (column + 0.5);
    const rowTop = top + rowHeight * row;
    const isToday = day === today;

    if (style.showWeekdays) {
      const weekday = (new Date(year, month, day).getDay() + 7 - style.weekStart) % 7;
      pen.text(centreX, rowTop + 34, initials[weekday], 17, 500, style.muted, 1.2, 'center');
    }

    const numberBaseline = rowTop + 96;
    if (isToday) {
      const centreY = numberBaseline - 13;
      pen.rect([centreX - 24, centreY - 25, centreX + 24, centreY + 25], style.accent, 8);
    }
    pen.text(
      centreX,
      numberBaseline,
      String(day),
      38,
      600,
      isToday ? style.accentText : style.fg,
      0,
      'center',
    );
  }
}

function drawMinimal(pen, style) {
  const [designW, designH] = CALENDAR_DESIGNS.minimal;
  const pad = 44;
  if (style.card) pen.rect([0, 0, designW, designH], style.bg, style.radius);

  const day = style.date;
  pen.text(pad, 78, DAY_NAMES[day.getDay()].toUpperCase(), 20, 500, style.muted, 3.4);
  pen.text(pad - 6, 344, String(day.getDate()), 290, 800, style.fg, -2);
  if (style.showTitle) {
    pen.text(pad, 414, MONTHS[day.getMonth()].toUpperCase(), 38, 600, style.fg, 2.6);
    pen.rect([pad, 440, pad + 74, 444], style.accent, 1);
    pen.text(
      pad,
      498,
      `${day.getFullYear()} · MONTH ${String(day.getMonth() + 1).padStart(2, '0')}`,
      22,
      500,
      style.muted,
      2,
    );
  }
}

function drawHorizontal(pen, style) {
  const [designW, designH] = CALENDAR_LAYOUTS.horizontal;
  const pad = 22;
  if (style.card) pen.rect([0, 0, designW, designH], style.bg, style.radius);

  const year = style.date.getFullYear();
  const month = style.date.getMonth();
  const today = style.date.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let left = pad;
  if (style.showTitle) {
    pen.text(pad, 118, MONTHS[month].slice(0, 3).toUpperCase(), 78, 800, style.fg, -1);
    pen.text(pad, 152, String(year), 20, 500, style.muted, 2.6);
    pen.rule(206, 24, 206, designH - 24, alpha(style.fg, 0.2));
    left = 224;
  }

  const cellWidth = (designW - pad - left) / daysInMonth;
  const centreY = designH / 2;
  const initials = WEEKDAY_INITIALS[style.weekStart];

  for (let index = 0; index < daysInMonth; index += 1) {
    const day = index + 1;
    const centreX = left + cellWidth * (index + 0.5);
    const isToday = day === today;
    if (style.showWeekdays) {
      const weekday = (new Date(year, month, day).getDay() + 7 - style.weekStart) % 7;
      pen.text(centreX, centreY - 26, initials[weekday], 16, 500, style.muted, 1, 'center');
    }
    if (isToday) {
      const half = Math.min(cellWidth * 0.42, 26);
      pen.rect([centreX - half, centreY - 14, centreX + half, centreY + 40], style.accent, 9);
    }
    pen.text(
      centreX,
      centreY + 30,
      String(day),
      30,
      600,
      isToday ? style.accentText : style.fg,
      0,
      'center',
    );
  }
}

function drawVertical(pen, style) {
  const [designW, designH] = CALENDAR_LAYOUTS.vertical;
  const pad = 22;
  if (style.card) pen.rect([0, 0, designW, designH], style.bg, style.radius);

  const year = style.date.getFullYear();
  const month = style.date.getMonth();
  const today = style.date.getDate();
  const daysInMonth = new Date(year, month + 1, 0).getDate();

  let top = pad;
  if (style.showTitle) {
    pen.text(pad, 62, MONTHS[month].toUpperCase(), 30, 700, style.fg, 2.4);
    pen.text(designW - pad, 58, String(year), 18, 500, style.muted, 2, 'right');
    pen.rule(pad, 82, designW - pad, 82, alpha(style.fg, 0.18));
    top = 100;
  }

  const bottom = designH - pad;
  const rowHeight = (bottom - top) / daysInMonth;
  const numberSize = Math.min(rowHeight * 0.56, 26);

  for (let index = 0; index < daysInMonth; index += 1) {
    const day = index + 1;
    const centreY = top + rowHeight * (index + 0.5);
    if (style.showLines && index) {
      pen.rule(pad, top + rowHeight * index, designW - pad, top + rowHeight * index, alpha(style.fg, 0.1));
    }
    const isToday = day === today;
    if (isToday) {
      pen.rect(
        [pad - 6, centreY - rowHeight * 0.5 + 2, designW - pad + 6, centreY + rowHeight * 0.5 - 2],
        style.accent,
        6,
      );
    }
    pen.text(
      pad + 4,
      verticalBaseline(numberSize, centreY),
      String(day),
      numberSize,
      600,
      isToday ? style.accentText : style.fg,
      0,
    );
    if (style.showWeekdays) {
      const weekday = new Date(year, month, day).getDay();
      pen.text(
        designW - pad - 4,
        verticalBaseline(14, centreY),
        DAY_NAMES[weekday].slice(0, 3).toUpperCase(),
        14,
        500,
        isToday ? style.accentText : style.muted,
        1.4,
        'right',
      );
    }
  }
}

const DRAWERS = { grid: drawGrid, strip: drawStrip, minimal: drawMinimal };
const LAYOUT_DRAWERS = { horizontal: drawHorizontal, vertical: drawVertical };

export function paintCalendar(ctx, width, height, props, { card = true } = {}) {
  const style = resolveStyle({ ...props, card });
  const useLayout = LAYOUT_DRAWERS[style.layout];
  const [designW, designH] = useLayout ? CALENDAR_LAYOUTS[style.layout] : CALENDAR_DESIGNS[style.style];
  const scale = Math.min(width / designW, height / designH);
  const offsetX = (width - designW * scale) / 2;
  const offsetY = (height - designH * scale) / 2;
  const pen = new Pen(ctx, scale, offsetX, offsetY, style.font);
  (useLayout || DRAWERS[style.style])(pen, style);
}
