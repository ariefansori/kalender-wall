/**
 * Shared top navigation.
 *
 * Every page renders the same menu from this one module, so a section can never
 * go missing from a page (the gallery used to lack the Test entry) and each
 * item always carries the same icon.
 */
import { el } from './lib/dom.js';

const SVG = (paths) =>
  `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" ` +
  `stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${paths}</svg>`;

const ICONS = {
  editor: SVG(
    '<path d="M12 20h9"/><path d="M16.5 3.5a2.12 2.12 0 0 1 3 3L7 19l-4 1 1-4Z"/>',
  ),
  gallery: SVG(
    '<rect x="3" y="4" width="18" height="16" rx="2"/><circle cx="8.5" cy="9.5" r="1.5"/>' +
      '<path d="m21 16-5-5L5 20"/>',
  ),
  widgets: SVG(
    '<rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/>' +
      '<rect x="3" y="14" width="7" height="7" rx="1"/><rect x="14" y="14" width="7" height="7" rx="1"/>',
  ),
  test: SVG(
    '<path d="M2 12s3.5-7 10-7 10 7 10 7-3.5 7-10 7S2 12 2 12Z"/><circle cx="12" cy="12" r="3"/>',
  ),
  options: SVG(
    '<circle cx="12" cy="12" r="3"/><path d="M19.4 15a1.7 1.7 0 0 0 .3 1.9l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1' +
      'a1.7 1.7 0 0 0-1.9-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.6 1.7 1.7 0 0 0-1.9.3' +
      'l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.9 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1' +
      'a1.7 1.7 0 0 0 1.6-1.1 1.7 1.7 0 0 0-.3-1.9l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.9.3H9' +
      'a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.9-.3l.1-.1' +
      'a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.9V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1' +
      'a1.7 1.7 0 0 0-1.5 1Z"/>',
  ),
};

export const NAV_ITEMS = [
  { href: '/', label: 'Editor', icon: 'editor' },
  { href: '/gallery', label: 'Gallery', icon: 'gallery' },
  { href: '/widgets', label: 'Widgets', icon: 'widgets' },
  { href: '/test', label: 'Test', icon: 'test' },
  { href: '/options', label: 'Options', icon: 'options' },
];

function currentSection() {
  const path = location.pathname.replace(/\/+$/, '') || '/';
  return path;
}

function mountNav() {
  const nav = document.querySelector('[data-nav]');
  if (!nav) return;
  const current = currentSection();
  nav.replaceChildren(
    ...NAV_ITEMS.map((item) => {
      const active = item.href === current;
      return el(
        'a',
        {
          class: `tab${active ? ' is-active' : ''}`,
          href: item.href,
          title: item.label,
          ...(active ? { 'aria-current': 'page' } : {}),
        },
        el('span', { class: 'tab-icon', html: ICONS[item.icon] }),
        el('span', { class: 'tab-label' }, item.label),
      );
    }),
  );
  // Pages with unsaved work (editor, widget designer) register a guard so an
  // in-app navigation asks before throwing the draft away.
  for (const link of nav.querySelectorAll('a.tab')) {
    link.addEventListener('click', (event) => {
      const guard = window.__hyprwallBeforeLeave;
      if (typeof guard === 'function' && guard(link.href) === false) {
        event.preventDefault();
      }
    });
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', mountNav, { once: true });
} else {
  mountNav();
}
