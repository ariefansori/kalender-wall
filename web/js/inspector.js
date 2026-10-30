import { el, clamp } from './lib/dom.js';
import { CALENDAR_DESIGNS, CALENDAR_LAYOUTS, calendarDesign } from './render/calendar.js';
import { getGroup } from './render/groups.js';
import { shapeLabel, shapeList } from './render/shapes.js';
import { displayNameFor } from './state.js';
import { ratioLabel } from './ratio.js';
import { childLayers, isComposite, resolvePath } from './layers.js';

const TYPE_LABELS = {
  text: 'Text widget',
  calendar: 'Calendar widget',
  sticker: 'Sticker',
  shape: 'SVG shape',
  shapeGroup: 'SVG group',
  mask: 'Vector mask',
  group: 'Widget',
  base: 'Base image',
};

function colorValue(value, fallback = '#000000') {
  const match = /^#([0-9a-fA-F]{6})([0-9a-fA-F]{2})?$/.exec(value || '');
  return match ? `#${match[1]}` : fallback;
}

function alphaValue(value, fallback = 255) {
  if (typeof value !== 'string') return fallback;
  if (value.trim().toLowerCase() === 'transparent') return 0;
  const eight = /^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})$/.exec(value.trim());
  if (eight) return parseInt(eight[1], 16);
  return /^#[0-9a-fA-F]{6}$/.test(value.trim()) ? 255 : fallback;
}

function hexAlpha(alpha) {
  return Math.max(0, Math.min(255, Math.round(alpha)))
    .toString(16)
    .padStart(2, '0');
}

export class Inspector {
  constructor({ host, empty, handlers }) {
    this.host = host;
    this.empty = empty;
    this.handlers = handlers;
    this.geometry = [];
    this._path = null;
  }

  render(state) {
    const doc = state.doc;
    const selection = Array.isArray(state.selection) ? state.selection : [];
    this.geometry = [];
    this.host.replaceChildren();
    this._state = state;

    if (!doc || !selection.length) {
      this._emptyState();
      return;
    }
    if (selection.length > 1) {
      this.host.hidden = false;
      this.empty.hidden = true;
      this._renderMulti(state, selection);
      return;
    }

    const path = selection[0];
    if (path === 'base') {
      this.host.hidden = false;
      this.empty.hidden = true;
      this._path = 'base';
      this._model = doc.base;
      this._renderBase(state, doc.base);
      return;
    }
    const found = resolvePath(doc, path);
    if (!found) {
      this._emptyState();
      return;
    }
    this.host.hidden = false;
    this.empty.hidden = true;
    this._path = path;
    this._model = found.layer;
    this._renderWidget(state, found.layer, path);
  }

  _emptyState() {
    this.host.hidden = true;
    this.host.replaceChildren();
    this.empty.hidden = false;
  }

  refreshGeometry(state) {
    const selection = Array.isArray(state.selection) ? state.selection : [];
    const path = selection[selection.length - 1];
    const model =
      path === 'base' ? state.doc.base : path ? resolvePath(state.doc, path)?.layer : null;
    if (!model) return;
    for (const entry of this.geometry) {
      if (document.activeElement === entry.input) continue;
      const value = entry.get ? entry.get(model) : model[entry.key];
      if (typeof value !== 'number') continue;
      entry.input.value = String(Math.round(value * 10) / 10);
      if (entry.output) {
        entry.output.textContent = entry.format
          ? entry.format(Number(value))
          : String(Math.round(value * 10) / 10);
      }
    }
  }

  focusText() {
    const textarea = this.host.querySelector('[data-autofocus="text"]');
    if (textarea) {
      textarea.focus();
      textarea.select();
    }
  }

  // -- building blocks ---------------------------------------------------
  _section(title, children, { hint = null } = {}) {
    return el(
      'section',
      { class: 'insp-section' },
      el('h3', { class: 'insp-title' }, title),
      hint ? el('p', { class: 'insp-hint' }, hint) : null,
      ...children.filter(Boolean),
    );
  }

  _field(label, control, hint) {
    return el(
      'div',
      { class: 'field' },
      el('span', { class: 'field-label' }, label),
      control,
      hint ? el('span', { class: 'field-hint' }, hint) : null,
    );
  }

  _number(label, value, { step = 1, min = -100000, max = 100000, onInput, key = null } = {}) {
    const input = el('input', {
      type: 'number',
      value: String(Math.round(Number(value) * 10) / 10),
      step: String(step),
      min: String(min),
      max: String(max),
      inputmode: 'decimal',
    });
    input.addEventListener('focus', () => this.handlers.history());
    input.addEventListener('input', () => {
      const parsed = Number.parseFloat(input.value);
      if (Number.isFinite(parsed)) onInput?.(parsed);
    });
    if (key) this.geometry.push({ input, key });
    return this._field(label, input);
  }

  _range(label, value, { min = 0, max = 1, step = 0.01, format, onInput, get = null }) {
    const input = el('input', { type: 'range', min: String(min), max: String(max), step: String(step), value: String(value) });
    const output = el('span', { class: 'range-value' }, format ? format(Number(value)) : String(value));
    input.addEventListener('focus', () => this.handlers.history());
    input.addEventListener('input', () => {
      const parsed = Number.parseFloat(input.value);
      output.textContent = format ? format(parsed) : String(parsed);
      onInput?.(parsed);
    });
    if (get) this.geometry.push({ input, output, get, format });
    return el(
      'div',
      { class: 'field field-range' },
      el('span', { class: 'field-label' }, label),
      el('div', { class: 'range-row' }, input, output),
    );
  }

  _select(options, value, onChange) {
    const select = el('select', {});
    for (const option of options) {
      select.append(
        el('option', { value: String(option.value), selected: String(option.value) === String(value) }, option.label),
      );
    }
    select.addEventListener('change', () => onChange(select.value));
    return select;
  }

  _color(label, value, onChange, { fallback = '#000000' } = {}) {
    const input = el('input', { type: 'color', value: colorValue(value, fallback) });
    const hex = el('span', { class: 'color-value' }, String(value || '').toUpperCase());
    input.addEventListener('focus', () => this.handlers.history());
    input.addEventListener('input', () => {
      hex.textContent = input.value.toUpperCase();
      onChange(input.value);
    });
    return this._field(label, el('div', { class: 'color-row' }, input, hex));
  }

  /** Colour picker with an explicit transparency slider (alpha channel). */
  _colorAlpha(label, value, onChange, { fallback = '#000000', hint = null } = {}) {
    const base = colorValue(value, fallback);
    const initial = alphaValue(value, 255);
    const input = el('input', { type: 'color', value: base });
    const hex = el('span', { class: 'color-value' }, `${base.toUpperCase()} · ${Math.round((initial / 255) * 100)}%`);
    const alpha = el('input', {
      type: 'range',
      min: '0',
      max: '100',
      step: '1',
      value: String(Math.round((initial / 255) * 100)),
      class: 'alpha-range',
    });
    const emit = () => {
      const percent = Number(alpha.value);
      hex.textContent = `${base.toUpperCase()} · ${percent}%`;
      onChange(`${base}${hexAlpha((percent / 100) * 255)}`);
    };
    input.addEventListener('focus', () => this.handlers.history());
    alpha.addEventListener('focus', () => this.handlers.history());
    input.addEventListener('input', () => {
      const percent = Number(alpha.value);
      hex.textContent = `${input.value.toUpperCase()} · ${percent}%`;
      onChange(`${input.value}${hexAlpha((percent / 100) * 255)}`);
    });
    alpha.addEventListener('input', emit);
    return el(
      'div',
      { class: 'field' },
      el('span', { class: 'field-label' }, label),
      el('div', { class: 'color-row' }, input, hex),
      el('div', { class: 'range-row alpha-row' }, el('span', { class: 'alpha-label' }, 'Alpha'), alpha),
      hint ? el('span', { class: 'field-hint' }, hint) : null,
    );
  }

  _checkbox(label, checked, onChange) {
    const input = el('input', { type: 'checkbox', checked: Boolean(checked) });
    input.addEventListener('change', () => {
      this.handlers.history();
      onChange(input.checked);
    });
    return el('label', { class: 'check' }, input, el('span', {}, label));
  }

  _toggle(label, checked, onChange, hint) {
    const input = el('input', { type: 'checkbox', checked: Boolean(checked) });
    input.addEventListener('change', () => {
      this.handlers.history();
      onChange(input.checked);
    });
    return el(
      'label',
      { class: 'switch' },
      input,
      el('span', { class: 'switch-track', 'aria-hidden': 'true' }, el('span', { class: 'switch-knob' })),
      el('span', { class: 'switch-text' }, label, hint ? el('small', {}, hint) : null),
    );
  }

  _button(label, action, { variant = 'ghost', title } = {}) {
    const button = el('button', { class: `btn btn-${variant} btn-small`, type: 'button', title: title || label }, label);
    button.addEventListener('click', () => this.handlers.action(action));
    return button;
  }

  // -- panels ------------------------------------------------------------
  _header({ eyebrow, title, sub, actions }) {
    return el(
      'header',
      { class: 'insp-head' },
      el(
        'div',
        {},
        el('p', { class: 'eyebrow' }, eyebrow),
        el('h2', { class: 'insp-name' }, title),
        el('p', { class: 'insp-sub' }, sub),
      ),
      el('div', { class: 'insp-actions' }, ...actions),
    );
  }

  _boxSection(model, { isBase = false, isChild = false } = {}) {
    return this._section(
      isChild ? 'Box (inside group)' : 'Box',
      [
        el(
          'div',
          { class: 'grid-4' },
          this._number('X', model.x, { onInput: (value) => this.handlers.box({ x: value }), key: 'x' }),
          this._number('Y', model.y, { onInput: (value) => this.handlers.box({ y: value }), key: 'y' }),
          this._number('W', model.width, {
            min: 4,
            onInput: (value) => this.handlers.box({ width: Math.max(4, value) }),
            key: 'width',
          }),
          this._number('H', model.height, {
            min: 4,
            onInput: (value) => this.handlers.box({ height: Math.max(4, value) }),
            key: 'height',
          }),
        ),
        !isBase
          ? this._number('Rotation', model.rotation || 0, {
              step: 0.5,
              min: -3600,
              max: 3600,
              onInput: (value) => this.handlers.box({ rotation: value }),
              key: 'rotation',
            })
          : null,
        !isBase
          ? this._range('Angle', clamp(Number(model.rotation) || 0, 0, 360), {
              min: 0,
              max: 360,
              step: 1,
              format: (value) => `${Math.round(value)}°`,
              onInput: (value) => this.handlers.box({ rotation: value }),
              get: (item) => clamp(Number(item.rotation) || 0, 0, 360),
            })
          : null,
        this._range('Opacity', model.opacity ?? 1, {
          min: 0,
          max: 1,
          step: 0.01,
          format: (value) => `${Math.round(value * 100)}%`,
          onInput: (value) => this.handlers.box({ opacity: value }),
          get: (item) => item.opacity ?? 1,
        }),
        isChild
          ? el(
              'p',
              { class: 'field-hint' },
              'Nested layers use the group’s own coordinates — drag them on the canvas to keep the mask live.',
            )
          : null,
      ],
    );
  }

  _flagsSection(model) {
    return this._section('Layer', [
      el(
        'div',
        { class: 'check-row' },
        this._checkbox('Locked', Boolean(model.locked), () => this.handlers.flag('locked')),
        this._checkbox('Hidden', Boolean(model.hidden), () => this.handlers.flag('hidden')),
      ),
      el('p', { class: 'field-hint' }, 'Locked layers cannot be dragged or resized. Hidden layers are not rendered.'),
    ]);
  }

  _renderBase(state, base) {
    const canvas = state.doc.canvas;
    this.host.append(
      this._header({
        eyebrow: 'Selected',
        title: 'Base image',
        sub: 'background layer',
        actions: [this._button('Replace', 'replaceBase'), this._button('Remove', 'removeBase', { variant: 'danger' })],
      }),
      this._boxSection(base, { isBase: true }),
      this._section('Transform', [
        this._range('Scale', (base.width / canvas.width) * 100, {
          min: 5,
          max: 400,
          step: 0.5,
          format: (value) => `${Math.round(value)}%`,
          onInput: (value) => {
            const factor = ((value / 100) * canvas.width) / Math.max(1, base.width);
            const width = Math.max(4, base.width * factor);
            const height = Math.max(4, base.height * factor);
            this.handlers.box({
              width,
              height,
              x: base.x + base.width / 2 - width / 2,
              y: base.y + base.height / 2 - height / 2,
            });
          },
          get: (model) => (model.width / canvas.width) * 100,
        }),
        el(
          'div',
          { class: 'check-row' },
          this._checkbox('Flip horizontal', Boolean(base.flipX), (value) => this.handlers.props({ flipX: value })),
          this._checkbox('Flip vertical', Boolean(base.flipY), (value) => this.handlers.props({ flipY: value })),
        ),
        el('div', { class: 'button-row' }, this._button('Reset', 'resetBase')),
      ]),
      this._section('Image', [
        el(
          'div',
          { class: 'button-row' },
          this._button('Fit inside canvas', 'fitCanvas'),
          this._button('Fill canvas (crop)', 'fillBaseCanvas', {
            title: 'Cover the whole canvas with the image — this is the crop that gets saved',
          }),
          this._button('Center', 'centerBase'),
        ),
        this._field(
          'Fit',
          this._select(
            [
              { value: 'cover', label: 'Cover (crop to fill)' },
              { value: 'contain', label: 'Contain (show whole image)' },
            ],
            base.fit || 'cover',
            (value) => {
              this.handlers.history();
              this.handlers.props({ fit: value });
            },
          ),
        ),
        el('p', { class: 'field-hint' }, base.file === 'base.jpg' ? 'Saved as presets/…/base.jpg' : 'New upload — saved with the preset'),
        el(
          'p',
          { class: 'field-hint' },
          'Free resize mode lets you change the box aspect: that crop is baked into base.jpg on save.',
        ),
      ]),
      this._renderSource(state, base),
    );
  }

  _renderSource(state, base) {
    const doc = state.doc;
    const width = Number(doc.sourceWidth) || 0;
    const height = Number(doc.sourceHeight) || 0;
    const original = Boolean(doc.originalUrl);
    const canvas = state.config?.canvas || doc.canvas;
    const matches =
      !width ||
      !height ||
      Math.abs(width / height - canvas.width / canvas.height) /
        Math.max(width / height, canvas.width / canvas.height) <
        0.015;
    this.host.append(
      this._section(
        'Source',
        [
          el(
            'p',
            { class: 'field-hint' },
            width && height
              ? `Stored source ${width} × ${height} · ${ratioLabel(width, height)}`
              : 'The source dimensions are recorded the first time the preset is saved.',
          ),
          el(
            'p',
            { class: 'field-hint' },
            `Canvas ${canvas.width} × ${canvas.height} · ${ratioLabel(canvas.width, canvas.height)}`,
          ),
          !matches && width && height
            ? el(
                'p',
                { class: 'warning-box' },
                'This source ratio differs from the canvas ratio, so the preset cannot be applied directly. Use “Adapt to canvas” in the toolbar, or fill the canvas with the image, then save it as a new preset.',
              )
            : null,
          original
            ? el(
                'p',
                { class: 'field-hint' },
                el(
                  'a',
                  { href: doc.originalUrl, target: '_blank', rel: 'noopener' },
                  `Open the original (${base.original})`,
                ),
              )
            : el(
                'p',
                { class: 'field-hint' },
                'The untouched high-resolution upload is kept as original-image so it can be re-cropped later.',
              ),
          original
            ? el(
                'div',
                { class: 'button-row' },
                this._button('Use original image', 'useOriginal', {
                  title: 'Reload the stored original so you can crop it again',
                }),
              )
            : null,
        ],
        { hint: 'The final wallpaper is always composed at the canvas resolution and ratio.' },
      ),
    );
  }

  _renderMulti(state, selection) {
    const layers = selection
      .map((path) => (path === 'base' ? { layer: state.doc.base } : resolvePath(state.doc, path)))
      .filter(Boolean)
      .map((entry) => entry.layer);
    this.host.append(
      this._header({
        eyebrow: 'Multi-selection',
        title: `${selection.length} layers`,
        sub: layers.map((layer) => displayNameFor(layer)).join(' · '),
        actions: [this._button('Delete', 'delete', { variant: 'danger' })],
      }),
      this._section('Vector operations', [
        el(
          'div',
          { class: 'button-row' },
          this._button('Group as <g>', 'group'),
          this._button('Clip mask', 'mask'),
          this._button('Hole mask', 'maskInvert'),
        ),
        el(
          'p',
          { class: 'field-hint' },
          'A clip mask keeps the top layers inside the shape of the bottom layer. A hole mask punches that shape out of the layers above it, so the wallpaper below shows through.',
        ),
        el(
          'p',
          { class: 'field-hint' },
          'Shift-click layers on the canvas or in the panel to add them to the selection.',
        ),
      ]),
    );
  }

  _renderWidget(state, widget, path) {
    const isChild = path.includes('/');
    const actions = [
      this._button('↑', 'forward', { title: 'Bring forward' }),
      this._button('↓', 'back', { title: 'Send backward' }),
      this._button('Duplicate', 'duplicate'),
      this._button('Delete', 'delete', { variant: 'danger' }),
    ];
    if (isComposite(widget)) actions.splice(2, 0, this._button('Ungroup', 'ungroup'));

    this.host.append(
      this._header({
        eyebrow: isChild ? 'Nested layer' : 'Selected',
        title: TYPE_LABELS[widget.type] || 'Widget',
        sub: displayNameFor(widget),
        actions,
      }),
      this._boxSection(widget, { isChild }),
    );
    if (widget.type === 'text') this._renderText(state, widget);
    if (widget.type === 'calendar') this._renderCalendar(state, widget);
    if (widget.type === 'sticker') this._renderSticker(state, widget);
    if (widget.type === 'shape') this._renderShape(state, widget);
    if (widget.type === 'shapeGroup') this._renderShapeGroup(state, widget);
    if (widget.type === 'mask') this._renderMask(state, widget);
    if (widget.type === 'group') this._renderGroup(state, widget);
    this.host.append(this._flagsSection(widget));
  }

  _renderGroup(state, widget) {
    const slug = widget.props.slug || '';
    const group = slug ? getGroup(slug) : null;
    const detail = group
      ? `${group.size.width}×${group.size.height} design · ${group.widgets.length} layer${group.widgets.length === 1 ? '' : 's'}`
      : 'This reusable widget is missing — pick another or recreate it.';
    const editLink = `./widgets.html?widget=${encodeURIComponent(slug)}#designer`;
    this.host.append(
      this._section('Reusable widget', [
        el('p', { class: 'field-hint' }, detail),
        el(
          'div',
          { class: 'button-row' },
          el('a', { class: 'btn btn-ghost btn-small', href: editLink }, 'Edit widget'),
          this._button('Reload library', 'reloadWidgets'),
        ),
        el('p', { class: 'field-hint' }, 'Changes made on the widget page show up here after a reload.'),
      ]),
    );
  }

  _fontControls(state, widget, { sizing = false } = {}) {
    const families = state.config.fonts;
    const current = families.find((family) => family.id === widget.props.font) || families[0];
    const familySelect = this._select(
      families.map((family) => ({ value: family.id, label: family.label })),
      current?.id,
      (value) => {
        this.handlers.history();
        const nextFamily = families.find((family) => family.id === value);
        const weights = nextFamily?.weights?.map((entry) => entry.weight) || [400];
        const weight = weights.includes(widget.props.weight) ? widget.props.weight : weights[0];
        this.handlers.props({ font: value, weight }, { rebuild: true });
      },
    );
    const fields = [this._field('Font', familySelect)];
    if (sizing) {
      const weights = current?.weights?.map((entry) => entry.weight) || [400];
      const weightSelect = this._select(
        weights.map((weight) => ({ value: weight, label: String(weight) })),
        widget.props.weight,
        (value) => {
          this.handlers.history();
          this.handlers.props({ weight: Number(value) });
        },
      );
      fields.push(
        el(
          'div',
          { class: 'grid-2' },
          this._field('Weight', weightSelect),
          this._number('Size', widget.props.size, {
            min: 4,
            step: 1,
            onInput: (value) => this.handlers.props({ size: Math.max(4, value) }),
          }),
        ),
      );
    }
    return this._section('Typography', fields);
  }

  _renderText(state, widget) {
    const props = widget.props;
    const textarea = el('textarea', { class: 'textarea', rows: '3', 'data-autofocus': 'text' });
    textarea.value = props.text || '';
    textarea.addEventListener('focus', () => this.handlers.history());
    textarea.addEventListener('input', () => this.handlers.props({ text: textarea.value }));

    const align = el('div', { class: 'seg' });
    for (const option of ['left', 'center', 'right']) {
      const button = el(
        'button',
        { class: `seg-btn${props.align === option ? ' is-active' : ''}`, type: 'button' },
        option === 'left' ? 'Left' : option === 'center' ? 'Center' : 'Right',
      );
      button.addEventListener('click', () => {
        this.handlers.history();
        this.handlers.props({ align: option });
        this.handlers.rebuild();
      });
      align.append(button);
    }

    this.host.append(
      this._section('Text', [
        this._field('Content', textarea),
        align,
        el(
          'div',
          { class: 'grid-2' },
          this._number('Line height', props.lineHeight, {
            step: 0.05,
            min: 0.6,
            max: 4,
            onInput: (value) => this.handlers.props({ lineHeight: clamp(value, 0.6, 4) }),
          }),
          this._number('Letter spacing', props.letterSpacing, {
            step: 0.5,
            min: -200,
            max: 500,
            onInput: (value) => this.handlers.props({ letterSpacing: value }),
          }),
        ),
        this._color('Colour', props.color, (value) => this.handlers.props({ color: value })),
        el('div', { class: 'check-row' }, this._checkbox('Uppercase', props.uppercase, (value) => this.handlers.props({ uppercase: value }))),
        el('div', { class: 'button-row' }, this._button('Fit height to text', 'fitHeight')),
      ]),
      this._fontControls(state, widget, { sizing: true }),
    );
  }

  _renderCalendar(state, widget) {
    const props = widget.props;
    const dateInput = el('input', { type: 'date', value: props.date || '' });
    dateInput.addEventListener('focus', () => this.handlers.history());
    dateInput.addEventListener('change', () => this.handlers.props({ date: dateInput.value || null }));

    const todayButton = el('button', { class: 'btn btn-ghost btn-small', type: 'button' }, 'Today');
    todayButton.addEventListener('click', () => {
      this.handlers.history();
      this.handlers.props({ date: null });
      this.handlers.rebuild();
    });

    const styles = Object.entries(CALENDAR_DESIGNS).map(([id, size]) => ({
      value: id,
      label: `${id[0].toUpperCase()}${id.slice(1)} · ${size.join('×')}`,
    }));
    const layouts = [
      { value: 'auto', label: 'Auto (follow the style)' },
      { value: 'horizontal', label: `Horizontal strip · 1 row (${CALENDAR_LAYOUTS.horizontal.join('×')})` },
      { value: 'vertical', label: `Vertical grid · left position · 1 column (${CALENDAR_LAYOUTS.vertical.join('×')})` },
      {
        value: 'vertical-right',
        label: `Vertical grid · right position · 1 column (${CALENDAR_LAYOUTS['vertical-right'].join('×')})`,
      },
    ];
    const verticalLayout = props.layout === 'vertical' || props.layout === 'vertical-right';

    this.host.append(
      this._section('Calendar', [
        this._field(
          'Style',
          this._select(styles, props.style, (value) => {
            this.handlers.history();
            this.handlers.props({ style: value });
            this.handlers.rebuild();
          }),
        ),
        this._field(
          'Layout',
          this._select(layouts, props.layout || 'auto', (value) => {
            this.handlers.history();
            this.handlers.props({ layout: value });
            this.handlers.rebuild();
          }),
          'Horizontal strip lays the month out in one row. Vertical grid stacks the month in one column: the left position keeps the day numbers on the outer edge, the right position mirrors it for the right screen edge.',
        ),
        verticalLayout
          ? this._range('Number ↔ day gap', Number(props.gap) || 0, {
              min: 0,
              max: 260,
              step: 1,
              format: (value) => `${Math.round(value)}`,
              onInput: (value) => this.handlers.props({ gap: value }),
            })
          : null,
        verticalLayout
          ? el(
              'p',
              { class: 'field-hint' },
              'Spacing between the day numbers and the weekday labels: 0 keeps the labels on the inner edge, higher values pull them towards the numbers.',
            )
          : null,
        this._field('Date', el('div', { class: 'inline-row' }, dateInput, todayButton), 'Empty = today at render time'),
        this._field(
          'Week starts',
          this._select(
            [
              { value: 1, label: 'Monday' },
              { value: 0, label: 'Sunday' },
            ],
            props.weekStart,
            (value) => {
              this.handlers.history();
              this.handlers.props({ weekStart: Number(value) });
            },
          ),
        ),
        el('p', { class: 'field-hint' }, `Design space: ${calendarDesign(props).join('×')}`),
      ]),
      this._fontControls(state, widget),
      this._section('Colours', [
        this._color('Text', props.fg, (value) => this.handlers.props({ fg: value })),
        this._color('Muted', props.muted, (value) => this.handlers.props({ muted: value })),
        this._color('Accent', props.accent, (value) => this.handlers.props({ accent: value })),
        this._color('Accent text', props.accentText, (value) => this.handlers.props({ accentText: value })),
      ]),
      this._section(
        'Card',
        [
          this._colorAlpha(
            'Background',
            props.bg,
            (value) => this.handlers.props({ bg: value }),
            { fallback: '#101014', hint: 'Alpha 0 % removes the card entirely.' },
          ),
          this._toggle(
            'Frosted glass',
            Boolean(props.glass),
            (value) => {
              this.handlers.props({ glass: value });
              this.handlers.rebuild();
            },
            'Blurs the wallpaper behind the card',
          ),
          props.glass
            ? this._range('Blur', Number(props.glassBlur) || 0, {
                min: 0,
                max: 80,
                step: 1,
                format: (value) => `${Math.round(value)}px`,
                onInput: (value) => this.handlers.props({ glassBlur: value }),
              })
            : null,
          this._range('Corner radius', Number(props.radius) || 0, {
            min: 0,
            max: 160,
            step: 1,
            format: (value) => `${Math.round(value)}px`,
            onInput: (value) => this.handlers.props({ radius: value }),
          }),
        ],
        {
          hint: props.glass
            ? 'Frosted glass uses CSS backdrop-filter in the editor and a blurred canvas backplate in the compositor.'
            : null,
        },
      ),
      this._section('Details', [
        this._checkbox('Month title', props.showTitle, (value) => this.handlers.props({ showTitle: value })),
        this._checkbox('Weekday labels', props.showWeekdays, (value) => this.handlers.props({ showWeekdays: value })),
        this._checkbox('Separator lines', props.showLines, (value) => this.handlers.props({ showLines: value })),
      ]),
    );
  }

  _renderSticker(state, widget) {
    const stickers = state.config.stickers || [];
    const options = stickers.map((sticker) => ({ value: sticker.name, label: sticker.name }));
    if (widget.props.src && !options.some((option) => option.value === widget.props.src)) {
      options.unshift({ value: widget.props.src, label: `${widget.props.src} (missing)` });
    }
    if (!options.length) options.push({ value: '', label: 'No stickers in assets/stickers' });
    const meta = stickers.find((sticker) => sticker.name === widget.props.src);

    this.host.append(
      this._section(
        'Sticker image',
        [
          this._field(
            'Image',
            this._select(options, widget.props.src, (value) => {
              this.handlers.history();
              this.handlers.props({ src: value });
            }),
          ),
          meta
            ? el('p', { class: 'field-hint' }, `Source ${meta.width}×${meta.height} px · ${meta.name.split('.').pop().toUpperCase()}`)
            : null,
          el(
            'p',
            { class: 'field-hint' },
            'Image stickers are transform-only: move, scale and rotate them on the canvas. Use the SVG shapes panel for recolourable artwork.',
          ),
        ],
        { hint: 'PNG · WebP · JPG · GIF · SVG files from assets/stickers/' },
      ),
    );
  }

  _renderShape(state, widget) {
    const props = widget.props;
    const shapes = shapeList();
    const options = shapes.map((shape) => ({ value: shape.id, label: shape.label }));
    if (!options.some((option) => option.value === props.shape)) {
      options.unshift({ value: props.shape, label: `${shapeLabel(props.shape)} (missing)` });
    }
    this.host.append(
      this._section(
        'Shape',
        [
          this._field(
            'Library',
            this._select(options, props.shape, (value) => {
              this.handlers.history();
              this.handlers.props({ shape: value });
            }),
          ),
          this._colorAlpha('Fill', props.fill, (value) => this.handlers.props({ fill: value }), {
            fallback: '#f4efe6',
          }),
          this._colorAlpha('Stroke', props.stroke, (value) => this.handlers.props({ stroke: value }), {
            fallback: '#000000',
          }),
          this._range('Stroke width', Number(props.strokeWidth) || 0, {
            min: 0,
            max: 40,
            step: 0.5,
            format: (value) => `${value}`,
            onInput: (value) => this.handlers.props({ strokeWidth: value }),
          }),
        ],
        { hint: 'Every shape uses the universal 0 0 100 100 viewBox, so stroke width scales with the box.' },
      ),
    );
  }

  _renderShapeGroup(state, widget) {
    const layers = childLayers(widget);
    const design = widget.props.design || { width: 0, height: 0 };
    this.host.append(
      this._section(
        'SVG group',
        [
          el(
            'p',
            { class: 'field-hint' },
            `${layers.length} vector layer${layers.length === 1 ? '' : 's'} in a ${Math.round(design.width)}×${Math.round(design.height)} design space. Move, scale and rotate the group as one object; select a child in the layer panel to style it.`,
          ),
          el(
            'ul',
            { class: 'child-list' },
            ...layers.map((layer) =>
              el(
                'li',
                {},
                el('span', { class: 'child-icon' }, '◆'),
                el('span', {}, displayNameFor(layer)),
              ),
            ),
          ),
          el('div', { class: 'button-row' }, this._button('Ungroup', 'ungroup', { variant: 'danger' })),
        ],
        { hint: 'Grouped layers stay editable through the layer tree.' },
      ),
    );
  }

  _renderMask(state, widget) {
    const layers = childLayers(widget);
    const source = layers[0];
    const content = layers.slice(1);
    const invert = Boolean(widget.props.invert);
    this.host.append(
      this._section(
        'Vector mask',
        [
          this._toggle(
            invert ? 'Inverted mask (hole punch)' : 'Clipping mask',
            invert,
            (value) => {
              this.handlers.props({ invert: value });
              this.handlers.rebuild();
            },
            invert ? 'Cutting shape punches a live hole' : 'Content follows the bottom shape',
          ),
          el(
            'p',
            { class: 'field-hint' },
            invert
              ? 'The cutting shape removes pixels from the layers above it, so objects and the wallpaper underneath show through the hole. Move or rotate the cutting object to update the hole live.'
              : 'The layers above the bottom shape are clipped to its silhouette. Move or rotate the bottom shape to update the clip live.',
          ),
          el(
            'div',
            { class: 'mask-info' },
            el('span', { class: 'mask-badge' }, 'Mask shape'),
            el('strong', {}, source ? displayNameFor(source) : 'Missing'),
          ),
          el(
            'div',
            { class: 'mask-info' },
            el('span', { class: 'mask-badge' }, 'Content'),
            el('strong', {}, `${content.length} layer${content.length === 1 ? '' : 's'}`),
          ),
          layers.length < 2
            ? el(
                'p',
                { class: 'warning-box' },
                'This mask has fewer than 2 layers: add a cutting shape and at least one layer to mask.',
              )
            : null,
          el(
            'ul',
            { class: 'child-list' },
            ...layers.map((layer, index) =>
              el(
                'li',
                { class: index === 0 ? 'is-source' : '' },
                el('span', { class: 'child-icon' }, index === 0 ? '◑' : '◆'),
                el('span', {}, displayNameFor(layer)),
                index === 0 ? el('span', { class: 'layer-tag' }, 'mask') : null,
              ),
            ),
          ),
          el('div', { class: 'button-row' }, this._button('Ungroup', 'ungroup', { variant: 'danger' })),
        ],
      ),
    );
  }
}
