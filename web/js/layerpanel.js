/**
 * Shared layer tree renderer.
 *
 * Groups and masks are drawn as parents with their children indented beneath
 * them, so the hierarchy is visible at a glance.  Every row carries its own
 * hide (eye) and lock switches, and mask rows get a quick clipping/hole toggle.
 */
import { el } from './lib/dom.js';
import { childLayers, isComposite } from './layers.js';
import { displayNameFor } from './state.js';

const EYE_ON_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.8 12 5.8 21.5 12 21.5 12 18 18.2 12 18.2 2.5 12 2.5 12Z" fill="none" stroke="currentColor" stroke-width="1.8"/><circle cx="12" cy="12" r="2.9" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const EYE_OFF_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><path d="M2.5 12S6 5.8 12 5.8c1.9 0 3.5.6 4.9 1.4M21.5 12S18 18.2 12 18.2c-1.9 0-3.5-.6-4.9-1.4" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/><path d="M4 4l16 16" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round"/></svg>';
const LOCK_ON_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 7 0v2.5" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';
const LOCK_OFF_ICON =
  '<svg viewBox="0 0 24 24" aria-hidden="true"><rect x="5" y="10.5" width="14" height="9.5" rx="2" fill="none" stroke="currentColor" stroke-width="1.8"/><path d="M8.5 10.5V8a3.5 3.5 0 0 1 6.6-1.6" fill="none" stroke="currentColor" stroke-width="1.8"/></svg>';

export function glyphFor(widget) {
  if (!widget) return '✦';
  if (widget.type === 'text') return 'T';
  if (widget.type === 'calendar') return '▦';
  if (widget.type === 'group') return '❖';
  if (widget.type === 'shape') return '◆';
  if (widget.type === 'shapeGroup') return '❏';
  if (widget.type === 'mask') return widget.props?.invert ? '◌' : '◑';
  return '✦';
}

function iconButton({ className = 'icon-btn', title, html, onClick, disabled = false, pressed = null }) {
  const button = el('button', {
    class: className,
    type: 'button',
    title,
    'aria-label': title,
    ...(pressed == null ? {} : { 'aria-pressed': String(pressed) }),
  });
  button.innerHTML = html;
  button.disabled = Boolean(disabled);
  button.addEventListener('click', (event) => {
    event.stopPropagation();
    event.preventDefault();
    onClick(event);
  });
  return button;
}

function buildRow({ layer, path, depth, index, count, source, selection, handlers }) {
  const active = selection.includes(path);
  const row = el('li', {
    class: [
      'layer',
      `depth-${Math.min(depth, 4)}`,
      active ? 'is-active' : '',
      layer.hidden ? 'is-hidden' : '',
      layer.locked ? 'is-locked' : '',
      isComposite(layer) ? 'is-composite' : '',
    ]
      .filter(Boolean)
      .join(' '),
    dataset: { path },
  });

  const vis = iconButton({
    className: `layer-flag layer-vis${layer.hidden ? ' is-off' : ''}`,
    title: layer.hidden ? 'Show layer' : 'Hide layer',
    html: layer.hidden ? EYE_OFF_ICON : EYE_ON_ICON,
    pressed: !layer.hidden,
    onClick: () => handlers.onFlag(path, 'hidden'),
  });

  const main = el(
    'button',
    { class: 'layer-main', type: 'button' },
    el('span', { class: `layer-icon layer-icon-${layer.type}` }, glyphFor(layer)),
    el('span', { class: 'layer-name' }, displayNameFor(layer)),
    source ? el('span', { class: 'layer-tag' }, 'mask') : null,
  );
  main.addEventListener('click', (event) => {
    if (event.shiftKey || event.metaKey || event.ctrlKey) {
      event.preventDefault();
      handlers.onToggle(path);
      return;
    }
    handlers.onSelect(path);
  });
  main.addEventListener('dblclick', () => handlers.onFocus(path));

  const tools = el('span', { class: 'layer-tools' });
  tools.append(
    iconButton({
      title: 'Bring forward',
      html: '↑',
      disabled: index >= count - 1,
      onClick: () => handlers.onMove(path, 1),
    }),
    iconButton({
      title: 'Send backward',
      html: '↓',
      disabled: index <= 0,
      onClick: () => handlers.onMove(path, -1),
    }),
    iconButton({
      className: `layer-flag layer-lock${layer.locked ? ' is-on' : ''}`,
      title: layer.locked ? 'Unlock layer' : 'Lock layer',
      html: layer.locked ? LOCK_ON_ICON : LOCK_OFF_ICON,
      pressed: Boolean(layer.locked),
      onClick: () => handlers.onFlag(path, 'locked'),
    }),
  );
  if (layer.type === 'mask') {
    tools.append(
      iconButton({
        className: `layer-flag layer-invert${layer.props?.invert ? ' is-on' : ''}`,
        title: layer.props?.invert ? 'Switch to clipping mask' : 'Switch to hole-punch mask',
        html: layer.props?.invert ? '◌' : '◑',
        pressed: Boolean(layer.props?.invert),
        onClick: () => handlers.onInvert(path),
      }),
    );
  }

  row.append(vis, main, tools);
  return row;
}

function renderContainer(options) {
  const { node, layers, depth, prefix } = options;
  for (let index = layers.length - 1; index >= 0; index -= 1) {
    const layer = layers[index];
    const path = prefix ? `${prefix}/${layer.id}` : layer.id;
    node.append(
      buildRow({
        ...options,
        layer,
        path,
        depth,
        index,
        count: layers.length,
        source: false,
      }),
    );
    if (isComposite(layer)) {
      const children = childLayers(layer);
      const sourceIndex = layer.type === 'mask' ? 0 : -1;
      for (let childIndex = children.length - 1; childIndex >= 0; childIndex -= 1) {
        const child = children[childIndex];
        const childPath = `${path}/${child.id}`;
        node.append(
          buildRow({
            ...options,
            layer: child,
            path: childPath,
            depth: depth + 1,
            index: childIndex,
            count: children.length,
            source: childIndex === sourceIndex,
          }),
        );
        if (isComposite(child)) {
          renderContainer({ ...options, node, layers: childLayers(child), depth: depth + 2, prefix: childPath });
        }
      }
    }
  }
}

export function renderLayerTree({ list, doc, selection, handlers, baseSrc }) {
  if (!list) return;
  list.replaceChildren();
  if (!doc) return;
  renderContainer({ node: list, layers: doc.widgets, depth: 0, prefix: '', selection, handlers });

  if (baseSrc) {
    const row = el('li', {
      class: `layer layer-base${selection.includes('base') ? ' is-active' : ''}`,
      dataset: { path: 'base' },
    });
    const main = el(
      'button',
      { class: 'layer-main', type: 'button' },
      el('span', { class: 'layer-icon layer-icon-base' }, '▣'),
      el('span', { class: 'layer-name' }, 'Base image'),
    );
    main.addEventListener('click', () => handlers.onSelect('base'));
    row.append(main);
    list.append(row);
  }

  if (!list.children.length) {
    list.append(el('li', { class: 'layer-empty' }, 'No layers yet — add a widget or a shape.'));
  }
}
