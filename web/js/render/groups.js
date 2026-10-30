/**
 * Registry of reusable widgets ("groups") loaded from /api/widgets.
 *
 * The renderer is synchronous, so widget documents are fetched once at boot and
 * looked up by slug while painting.
 */
const registry = new Map();

export function setGroups(groups) {
  registry.clear();
  for (const [slug, doc] of Object.entries(groups || {})) {
    registry.set(slug, doc);
  }
}

export function getGroup(slug) {
  return registry.get(slug) || null;
}

export function groupName(slug) {
  const doc = registry.get(slug);
  return doc ? doc.name : slug || 'Widget';
}

export function groupDocs() {
  return [...registry.values()];
}
