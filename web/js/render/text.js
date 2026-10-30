import { cssNameFor } from '../fonts.js';

export const BASELINE_RATIO = 0.8;

const MONTHS = [
  'January', 'February', 'March', 'April', 'May', 'June',
  'July', 'August', 'September', 'October', 'November', 'December',
];
const WEEKDAYS = ['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'];

const VALUE_RE = /^([a-z_]+)([+-]\d{1,4})?(?::([a-z0-9]{1,10}))?$/;
const COND_RE = /^([a-z_]+)([+-]\d{1,4})?\s*(!=|>=|<=|=|>|<)\s*(.+)$/;
const NUMERIC_RE = /^-?\d+(?:\.\d+)?$/;
const pad = (value) => String(value).padStart(2, '0');

function shiftDays(day, days) {
  const next = new Date(day.getTime());
  next.setDate(next.getDate() + days);
  return next;
}

function shiftMonths(day, months) {
  const total = day.getFullYear() * 12 + day.getMonth() + months;
  const year = Math.floor(total / 12);
  const month = ((total % 12) + 12) % 12;
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day.getDate(), lastDay));
}

function shiftYears(day, years) {
  const year = day.getFullYear() + years;
  const month = day.getMonth();
  const lastDay = new Date(year, month + 1, 0).getDate();
  return new Date(year, month, Math.min(day.getDate(), lastDay));
}

function shiftedDay(name, offset, day) {
  if (!offset) return day;
  if (name.startsWith('month')) return shiftMonths(day, offset);
  if (name === 'year') return shiftYears(day, offset);
  return shiftDays(day, offset);
}

function rawValue(name, day) {
  const month = MONTHS[day.getMonth()];
  const weekday = WEEKDAYS[(day.getDay() + 6) % 7];
  if (name === 'day') return String(day.getDate());
  if (name === 'day_padded') return pad(day.getDate());
  if (name === 'month_number') return pad(day.getMonth() + 1);
  if (name === 'month') return month;
  if (name === 'month_short') return month.slice(0, 3);
  if (name === 'month_upper') return month.toUpperCase();
  if (name === 'weekday') return weekday;
  if (name === 'weekday_short') return weekday.slice(0, 3).toUpperCase();
  if (name === 'year') return String(day.getFullYear());
  if (name === 'date') return `${day.getFullYear()}-${pad(day.getMonth() + 1)}-${pad(day.getDate())}`;
  return null;
}

function formatValue(name, value, fmt) {
  if (!fmt) return value;
  if (fmt === 'upper') return value.toUpperCase();
  if (fmt === 'lower') return value.toLowerCase();
  if (fmt === 'short') {
    if (name.startsWith('month') || name.startsWith('weekday')) return value.slice(0, 3);
    if (name === 'year') return value.slice(-2);
    return value;
  }
  if (fmt === 'pad' || fmt === '02' || fmt === '2digit') {
    return /^\d+$/.test(value) ? value.padStart(2, '0') : value;
  }
  return value;
}

function valueToken(body, day) {
  const match = VALUE_RE.exec(body.trim());
  if (!match) return null;
  const [, name, offsetText, fmt] = match;
  const value = rawValue(name, shiftedDay(name, Number(offsetText || 0), day));
  if (value == null) return null;
  return formatValue(name, value, fmt);
}

/** Split on `separator` outside nested `{...}` tokens. */
function splitTopLevel(text, separator) {
  let depth = 0;
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '{') depth += 1;
    else if (char === '}') depth = Math.max(0, depth - 1);
    else if (char === separator && depth === 0) {
      return [text.slice(0, index), text.slice(index + 1)];
    }
  }
  return null;
}

function equals(left, right) {
  const a = left.trim().toLowerCase();
  const b = right.trim().toLowerCase();
  if (a === b) return true;
  return b.length === 3 && a.startsWith(b);
}

function compare(left, op, right) {
  if (op === '=' || op === '!=') {
    const equal = equals(left, right);
    return op === '=' ? equal : !equal;
  }
  const numeric = NUMERIC_RE.test(left.trim()) && NUMERIC_RE.test(right.trim());
  const first = numeric ? Number(left) : left.trim().toLowerCase();
  const second = numeric ? Number(right) : right.trim().toLowerCase();
  if (op === '>') return first > second;
  if (op === '<') return first < second;
  if (op === '>=') return first >= second;
  return first <= second;
}

function expandConditional(body, day) {
  const question = splitTopLevel(body, '?');
  if (!question) return null;
  const [condition, branches] = question;
  const match = COND_RE.exec(condition.trim());
  if (!match) return null;
  const [, name, offsetText, op, value] = match;
  const left = rawValue(name, shiftedDay(name, Number(offsetText || 0), day));
  if (left == null) return null;
  const split = splitTopLevel(branches, ':');
  const [thenText, elseText] = split || [branches, ''];
  const chosen = compare(left, op, value) ? thenText : elseText;
  return expandTokens(chosen, day);
}

function expandToken(body, day) {
  if (body.startsWith('if:')) {
    const expanded = expandConditional(body.slice(3), day);
    return expanded == null ? `{${body}}` : expanded;
  }
  const value = valueToken(body, day);
  return value == null ? `{${body}}` : value;
}

/** Mirrors ``hyprwall.widgets.text.expand_tokens``. */
export function expandTokens(text, day = new Date()) {
  const source = String(text ?? '');
  let out = '';
  let index = 0;
  while (index < source.length) {
    if (source[index] !== '{') {
      out += source[index];
      index += 1;
      continue;
    }
    let depth = 0;
    let end = -1;
    for (let cursor = index; cursor < source.length; cursor += 1) {
      if (source[cursor] === '{') depth += 1;
      else if (source[cursor] === '}') {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    if (end < 0) {
      out += source.slice(index);
      break;
    }
    out += expandToken(source.slice(index + 1, end), day);
    index = end + 1;
  }
  return out;
}

function fontSpec(props, size) {
  return `${Math.round(props.weight || 600)} ${Math.round(size)}px "${cssNameFor(props.font)}"`;
}

export function measureLine(ctx, text, letterSpacing = 0) {
  if (!text) return 0;
  const chars = [...text];
  let width = 0;
  for (const char of chars) width += ctx.measureText(char).width;
  return width + letterSpacing * Math.max(0, chars.length - 1);
}

export function layoutLines(ctx, text, maxWidth, letterSpacing) {
  const widthOf = (value) => measureLine(ctx, value, letterSpacing);
  const lines = [];
  for (const paragraph of text.split('\n')) {
    if (!paragraph) {
      lines.push('');
      continue;
    }
    let current = '';
    for (const word of paragraph.split(' ')) {
      const trial = current ? `${current} ${word}` : word;
      if (widthOf(trial) <= maxWidth || !current) {
        current = trial;
        continue;
      }
      lines.push(current);
      let remaining = word;
      while (widthOf(remaining) > maxWidth && [...remaining].length > 1) {
        const chars = [...remaining];
        let cut = chars.length;
        while (cut > 1 && widthOf(chars.slice(0, cut).join('')) > maxWidth) cut -= 1;
        lines.push(chars.slice(0, cut).join(''));
        remaining = chars.slice(cut).join('');
      }
      current = remaining;
    }
    lines.push(current);
  }
  return lines;
}

export function paintText(ctx, width, height, props, day = new Date()) {
  const size = Math.max(4, Number(props.size) || 72);
  const letterSpacing = Number(props.letterSpacing) || 0;
  const lineHeight = Math.min(4, Math.max(0.6, Number(props.lineHeight) || 1.15));
  const expanded = expandTokens(props.text, day);
  const text = props.uppercase ? expanded.toUpperCase() : expanded;
  if (!text.trim()) return;

  ctx.font = fontSpec(props, size);
  ctx.textBaseline = 'alphabetic';
  ctx.fillStyle = props.color || '#f4efe6';

  const lines = layoutLines(ctx, text, width, letterSpacing);
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line) continue;
    const lineWidth = measureLine(ctx, line, letterSpacing);
    let x = 0;
    if (props.align === 'center') x = Math.max(0, (width - lineWidth) / 2);
    else if (props.align === 'right') x = Math.max(0, width - lineWidth);
    const baseline = size * BASELINE_RATIO + index * size * lineHeight;
    if (baseline - size > height) break;
    let cursor = x;
    for (const char of line) {
      ctx.fillText(char, cursor, baseline);
      cursor += ctx.measureText(char).width + letterSpacing;
    }
  }
}

export function textBlockHeight(props, lineCount) {
  const size = Math.max(4, Number(props.size) || 72);
  const lineHeight = Math.min(4, Math.max(0.6, Number(props.lineHeight) || 1.15));
  return Math.max(1, lineCount) * size * lineHeight;
}

/** Measured height of the wrapped text block, used by "Fit height to text". */
export function measureTextHeight(props, width) {
  const size = Math.max(4, Number(props.size) || 72);
  const letterSpacing = Number(props.letterSpacing) || 0;
  const lineHeight = Math.min(4, Math.max(0.6, Number(props.lineHeight) || 1.15));
  const expanded = expandTokens(props.text);
  const text = props.uppercase ? expanded.toUpperCase() : expanded;
  const ctx = document.createElement('canvas').getContext('2d');
  ctx.font = fontSpec(props, size);
  const lines = layoutLines(ctx, text, width, letterSpacing);
  return Math.ceil(lines.length * size * lineHeight + size * 0.2);
}
