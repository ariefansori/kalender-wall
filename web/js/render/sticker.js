const cache = new Map();

export function stickerUrl(src) {
  return `/assets/stickers/${encodeURIComponent(src)}`;
}

export function getSticker(src) {
  if (!src) return null;
  let entry = cache.get(src);
  if (!entry) {
    const image = new Image();
    entry = { image, state: 'loading', listeners: new Set() };
    image.addEventListener('load', () => {
      entry.state = 'ready';
      entry.listeners.forEach((listener) => listener());
      entry.listeners.clear();
    });
    image.addEventListener('error', () => {
      entry.state = 'error';
      entry.listeners.clear();
    });
    image.src = stickerUrl(src);
    cache.set(src, entry);
  }
  return entry;
}

export function whenReady(src, listener) {
  const entry = getSticker(src);
  // Only queue while loading: calling back synchronously for an already loaded
  // image would make the repaint path call itself forever.
  if (entry?.state === 'loading') entry.listeners.add(listener);
}

/**
 * Sticker images are transform-only: position, scale and rotation.
 *
 * The image fills its layer box.  With the aspect-locked handles the box keeps
 * the image ratio, so nothing distorts; in free transform mode the box — and
 * therefore the sticker — stretches on each axis independently.
 */
export function paintSticker(ctx, width, height, src) {
  const entry = getSticker(src);
  if (!entry || entry.state !== 'ready') return;
  const { image } = entry;
  if (!image.naturalWidth || !image.naturalHeight) return;
  ctx.drawImage(image, 0, 0, Math.max(1, width), Math.max(1, height));
}
