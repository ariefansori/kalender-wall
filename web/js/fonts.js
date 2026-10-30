const cssNames = new Map();
const byId = new Map();

export function cssNameFor(family) {
  return cssNames.get(family) || cssNames.get('barlow-condensed') || 'sans-serif';
}

export function family(familyId) {
  return byId.get(familyId) || byId.get('barlow-condensed') || null;
}

export function families() {
  return [...byId.values()];
}

/**
 * Register every bundled font with the browser.  Canvas drawing waits for this
 * promise so previews never measure fallback glyphs.
 */
export async function loadFonts(fontFamilies) {
  const pending = [];
  for (const familyInfo of fontFamilies || []) {
    cssNames.set(familyInfo.id, familyInfo.cssName);
    byId.set(familyInfo.id, familyInfo);
    for (const weight of familyInfo.weights) {
      try {
        const face = new FontFace(familyInfo.cssName, `url(${weight.url})`, {
          weight: String(weight.weight),
          style: 'normal',
          display: 'swap',
        });
        pending.push(
          face.load().then((loaded) => {
            document.fonts.add(loaded);
          }),
        );
      } catch (error) {
        console.warn('Could not register font', familyInfo.id, weight.weight, error);
      }
    }
  }
  await Promise.allSettled(pending);
  await document.fonts.ready;
  document.documentElement.classList.add('fonts-ready');
  return { cssNames, byId };
}
