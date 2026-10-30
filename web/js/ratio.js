/**
 * Aspect-ratio helpers shared by the gallery, editor, test and options pages.
 *
 * Presets record real source dimensions (``sourceWidth`` / ``sourceHeight``);
 * the ratio is derived on the fly and compared numerically with a small
 * tolerance, so no hardcoded ``"16:9"`` string is ever trusted.
 */

export const RATIO_TOLERANCE = 0.015;

export function ratioOf(width, height) {
  const w = Number(width);
  const h = Number(height);
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return 0;
  return w / h;
}

export function ratiosMatch(a, b, tolerance = RATIO_TOLERANCE) {
  if (!a || !b) return true;
  return Math.abs(a - b) / Math.max(a, b) < tolerance;
}

function gcd(a, b) {
  let x = Math.abs(Math.round(a));
  let y = Math.abs(Math.round(b));
  while (y) [x, y] = [y, x % y];
  return x || 1;
}

/** ``2560, 1440`` -> ``"16:9"``; unusual pairs fall back to ``"1.71:1"``. */
export function ratioLabel(width, height) {
  const w = Math.round(Number(width));
  const h = Math.round(Number(height));
  if (!Number.isFinite(w) || !Number.isFinite(h) || w <= 0 || h <= 0) return '?';
  const divisor = gcd(w, h);
  const rw = w / divisor;
  const rh = h / divisor;
  if (rw <= 32 && rh <= 32) return `${rw}:${rh}`;
  return `${(w / h).toFixed(2)}:1`;
}

/** Ratio of a preset item (falls back to its canvas when unknown). */
export function presetRatio(preset) {
  const ratio = ratioOf(preset?.sourceWidth, preset?.sourceHeight);
  return ratio || ratioOf(preset?.width, preset?.height);
}

export function presetRatioLabel(preset) {
  return ratioOf(preset?.sourceWidth, preset?.sourceHeight)
    ? ratioLabel(preset.sourceWidth, preset.sourceHeight)
    : ratioLabel(preset?.width, preset?.height);
}
