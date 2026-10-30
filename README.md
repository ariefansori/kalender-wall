# HyprWall Studio

Static calendar wallpapers for **Arch Linux + Hyprland + Caelestia**.

HyprWall composes a base image and freely arranged widgets (text, calendars,
stickers, vector shapes) into one image **at the exact resolution of your
canvas**, applies it to the desktop, and can pick a day/night-appropriate preset
automatically at login.

Five pages, one shared menu:

| page | path | what it does |
| --- | --- | --- |
| **Editor** | `/` | compose a preset: base image, widgets, shapes, layers |
| **Gallery** | `/gallery` | browse presets, filter by theme/ratio, apply or edit |
| **Widgets** | `/widgets` | design reusable widgets (own canvas, own layers) |
| **Test** | `/test` | render any preset for a simulated date/time |
| **Options** | `/options` | canvas size, light/dark schedule, wallpaper backend |

The navigation bar is generated once (`web/js/nav.js`) and mounted on every
page, so no page can be missing an entry and every item carries the same icon.

## Highlights

- **Web editor** (FastAPI + vanilla ES modules): drag, resize, rotate and style
  layers, previewing the exact pixels the compositor produces.
- **Real ratios, not strings** — every preset stores the source image's pixel
  dimensions and the ratio is derived on the fly (see
  [Aspect ratio and resolution](#aspect-ratio-and-resolution)).
- **Image optimisation on save** — the composited `base.jpg` is never larger
  than the canvas, while the untouched upload is kept as `original-image.<ext>`
  for later re-cropping.
- **Options page** — canvas presets, custom width × height, live ratio label, a
  custom light/dark schedule with the currently active theme, and the desktop
  wallpaper backend.
- **SVG shape library** — line, circle, **square**, triangle, pentagon, hexagon,
  octagon, 5- and 8-point stars, heart, shield, starburst badge, speech bubble —
  all on a universal `0 0 100 100` viewBox with fill, stroke and stroke width.
  Multi-select shapes and group them into one `<g>` object.
- **Vector masks** — clip the layers above a shape to its silhouette, or punch a
  live hole through them. Toggle between the two with one switch.
- **Layer tree** — groups and masks nest their children, every layer has its own
  eye and lock switch, z-order moves one step at a time.
- **Reusable widgets** — design a widget once on the Widgets page and drop it
  into any preset as a single layer (KWGT-style, with date tokens and rules).
- **Two resize grips** — *Aspect* (keeps the design ratio) and *Free*
  (width and height independently), switchable in the stage toolbar.
- **No build step, no Node**: plain HTML/CSS/JS on the front end, Python +
  Pillow on the back end.

## Requirements

- Arch Linux with Hyprland and the [Caelestia](https://github.com/caelestia-dots)
  shell (Caelestia draws the wallpaper itself; hyprpaper is not required).
- Python ≥ 3.10 and [`uv`](https://docs.astral.sh/uv/) (`sudo pacman -S uv`), or
  a plain `python -m venv`.
- Optional fallbacks: `hyprpaper`, `swww`.
- `cairo` for SVG stickers and shapes (`sudo pacman -S cairo`); the compositor
  rasterises them with cairosvg, which needs the system library. The browser
  preview needs nothing extra.
- A browser for the editor (Chromium/Firefox).

## Install

```bash
git clone <your-repo> ~/Projects/kalender-wall
cd ~/Projects/kalender-wall

uv sync                      # .venv + fastapi, uvicorn, pillow, cairosvg
.venv/bin/hyprwall doctor    # presets, output path, apply backends
```

`uv sync` installs the `hyprwall` console script into `.venv/bin/`. With pip:

```bash
python -m venv .venv
.venv/bin/pip install -r requirements.txt
.venv/bin/python -m hyprwall doctor
```

## Run the editor

```bash
.venv/bin/hyprwall serve            # http://127.0.0.1:8787
.venv/bin/hyprwall serve --reload   # development
```

Then open <http://127.0.0.1:8787> (editor), `/gallery`, `/widgets`, `/test` or
`/options`.

## Editor workflow

1. **Add a base image** — choose a JPEG/PNG/WebP or drop it on the canvas. The
   image keeps its own aspect ratio while you scale it (it covers the canvas by
   default, cropped from the centre). **Transform** offers a scale slider,
   horizontal/vertical flip and **Reset**; X/Y/W/H and opacity are editable
   numerically.
2. **Add widgets** (unlocked once a base exists):
   - **Text** — content, font, weight, size, colour, alignment, line height,
     letter spacing, uppercase. Supports date tokens.
   - **Calendar** — three styles (grid, strip, minimal) plus two layouts
     (horizontal strip, vertical grid). Cards have their own background colour
     with alpha, optional frosted glass, and a corner radius.
   - **Stickers** — images from `assets/stickers/` (PNG/WebP/JPEG/GIF/SVG),
     transform-only: move, scale, rotate.
   - **SVG shapes** — the built-in library with fill, stroke, stroke width,
     position, scale and rotation.
   - **Reusable widgets** — anything from the Widgets page, as one layer.
3. **Arrange** — drag, resize with the handles, rotate with the round handle
   above the selection (`Shift` snaps to 15°), nudge with arrows (`Shift` =
   10 px). Selection handles live in an unclipped overlay, so they stay usable
   when a layer hangs off the canvas. `Shift`+click (canvas or layer panel) adds
   to the selection; a multi-selection drags as a unit. The left sidebar is an
   accordion — **Base image**, **Base widget**, **Reusable widgets**,
   **Stickers**, **Layers** — with one panel open at a time.
4. **Resize mode** — the **Aspect / Free** switch in the stage toolbar decides
   what the corner handles do:
   - **Aspect** (default) keeps the layer's proportions: one factor is applied
     to both sides, so circles stay round and text boxes keep their shape.
   - **Free** resizes width and height independently (stretched calendars,
     non-proportional image crops).

   The choice persists in `localStorage`, so it survives reloads. The switch
   applies to the base image too — in **Free** mode the base box changes aspect,
   which is exactly how you re-crop a photo to a new ratio. `Shift` while
   dragging a layer locks the move to one axis, and `Shift` while rotating snaps
   to 15°.
5. **Zoom** — `Ctrl/⌘` + wheel, `Ctrl/⌘` + `+`/`-`, the toolbar buttons, or
   `Ctrl/⌘ + 0` to fit. The percentage chip resets to 100 %.
6. **Save preset** — name + theme (`light` / `dark`). Files are written to
   `presets/<slug>/`. **Renaming a preset renames its folder too**: the slug is
   derived from the name, the old URL stops working and the new one is returned
   by the save call. Two presets with the same name get `-2`, `-3`, … suffixes.
7. **Set as wallpaper** from the editor or the gallery. The backend composites
   the preset at the current canvas resolution, writes a fresh
   `~/.cache/current_wallpaper-<timestamp>.jpg`, calls the desktop command and
   deletes the composition it replaced.
8. **Adapt to canvas** — if the open preset has a different ratio from the
   canvas, the editor shows a banner and disables *Set as wallpaper*. *Adapt to
   canvas* fits the base image to the canvas (and scales the widgets with it);
   saving then creates a **new** preset, leaving the original untouched.

Keyboard: `Ctrl/⌘+S` save · `Ctrl/⌘+Z` undo · `Shift+Ctrl/⌘+Z` redo ·
`Ctrl/⌘+D` duplicate · `Ctrl/⌘+G` group · `Shift+Ctrl/⌘+G` ungroup ·
`Ctrl/⌘` + `+`/`-`/`0` zoom · `Delete` remove · `Esc` deselect.

## Aspect ratio and resolution

A preset does **not** store a `"16:9"` string. It stores the real pixel size of
the image it was built from:

```json
{
  "name": "mazda_rx-7",
  "canvas": { "width": 2560, "height": 1440 },
  "sourceWidth": 2560,
  "sourceHeight": 1440
}
```

`sourceWidth` / `sourceHeight` are the dimensions of the cropped source (what
`base.jpg` was made from, before it was downscaled). The ratio is always
computed as `sourceWidth / sourceHeight`; the API additionally returns the
derived fields `ratio`, `ratioLabel`, `canvasRatio`, `canvasRatioLabel` and
`ratioMatch` for the UI.

Ratios are compared numerically with a **1.5 % tolerance**:

```js
function ratiosMatch(a, b, tolerance = 0.015) {
  return Math.abs(a - b) / Math.max(a, b) < tolerance;
}
```

Consequences:

- **Matching presets** (`ratioMatch: true`) can be applied freely, including by
  random selection in the gallery and in `hyprwall apply`.
- **Mismatched presets cannot be applied.** The gallery shows a ratio badge and
  offers *Edit*, the editor refuses *Set as wallpaper* and explains what to do,
  and the CLI refuses a mismatched preset by name (`PresetRatioError`). Random
  selection only considers matching presets, and with none available the CLI
  exits with a message telling you which canvas you are on.
- To use a mismatched preset, open it in the editor, adapt/crop it to the
  canvas and **save it as a new preset**. Nothing is overwritten.
- The **final wallpaper is always generated at the exact current canvas
  resolution and ratio**: the compositor renders the preset scaled into
  `canvas.width × canvas.height`, so `base.jpg`, previews and the desktop all
  share one ratio.

### Image optimisation

Saving a preset with an uploaded image:

1. keeps the untouched upload as `original-image.<ext>` (JPEG, PNG or WebP, EXIF
   orientation baked in) — this is what the base image's **Use original image**
   button brings back into the editor for re-cropping;
2. crops that original to the base box (respecting `fit: "cover"`), then
   downscales it so neither side exceeds the canvas — the result is written to
   `base.jpg`;
3. records the crop's pixel dimensions in `sourceWidth` / `sourceHeight`.

If `base.jpg` already has the right aspect and fits inside the canvas it is kept
byte-for-byte, so repeated saves don't re-compress the image.

## Options page

`/options` edits `~/.config/hyprwall/config.json` through `PUT /api/options`.

**Canvas**

- Common presets: 1920×1080 (Full HD), 2560×1440 (QHD), 3440×1440
  (Ultrawide), 3840×2160 (4K UHD), 2880×1800 (Retina 16:10), 2560×1600
  (WQXGA), 1920×1200 (WUXGA), 1366×768 (Laptop HD) — the list lives in
  `web/js/options.js`.
- Custom width × height, 320–8192 px per side (validated again on the server).
- The aspect ratio is recalculated live and shown with the decimal value, e.g.
  `16:9` / `1.7778` or `2.39:1` / `2.3889` for ultrawide.
- Changing the canvas does not touch existing presets: they keep their own
  `sourceWidth` / `sourceHeight`, and the gallery marks the ones that no longer
  match.
- The canvas size is the resolution every wallpaper is generated at, under the
  `canvas` key.

**Clock theme schedule** — the light and dark modes switch automatically instead
of being a fixed choice:

- **Light starts** / **Dark starts** (`theme.dayStart`, `theme.dayEnd`, `HH:MM`).
  The light window may wrap over midnight (`20:00` → `06:00` is a night owl's
  day); both times must differ.
- The page reads the clock while it is open and shows the mode that is active
  right now, e.g. `Light now · Light 07:00 – 19:00 · Dark 19:00 – 07:00`.
- The schedule drives `Config.theme_for()`, so it decides the theme of
  **new presets** and which preset `hyprwall apply` picks at login. Saved
  presets keep the theme they were designed with.
- `clockTheme` stays in the config as a fallback for clients that expect a
  single value; the editor prefers the scheduled theme from `/api/config`
  (`timeWindow.theme`).

**Desktop wallpaper command** (`wallpaper.backend`):

| value | label | what it runs |
| --- | --- | --- |
| `gnome` | GNOME | `gsettings set org.gnome.desktop.background picture-uri …` |
| `kde` | KDE Plasma | `plasma-apply-wallpaperimage <path>` |
| `hyprland` | Hyprland | `hyprpaper` via `hyprctl`, `swww` as fallback |
| `hyprland-caelestia` | **Hyprland + Caelestia** (default) | `caelestia wallpaper -N -f <path>` |
| `custom` | Custom command | your own command containing `{path}` (or `{file}`) |

The selected backend is tried first; other detected backends stay as fallbacks,
so a temporarily missing `swww` never leaves you without a wallpaper.
`HYPRWALL_APPLY_COMMAND` and `wallpaper.applyCommand` still work as a custom
command for scripts.

## Preset format

```
presets/mazda_rx-7/
├── base.jpg                # cropped + downscaled source (≤ canvas size)
├── original-image.jpg      # untouched high-resolution upload (optional)
└── widget.json             # canvas, base placement, theme, layers
```

`widget.json` (abridged):

```json
{
  "version": 1,
  "name": "mazda_rx-7",
  "theme": "dark",
  "canvas": { "width": 2560, "height": 1440, "background": "#0b0b0e" },
  "sourceWidth": 2560,
  "sourceHeight": 1440,
  "base": {
    "file": "base.jpg",
    "original": "original-image.jpg",
    "x": 0, "y": 0, "width": 2560, "height": 1440,
    "fit": "cover", "opacity": 1, "visible": true
  },
  "widgets": [
    {
      "id": "headline",
      "type": "text",
      "x": 124, "y": 160, "width": 1450, "height": 330,
      "rotation": 0, "opacity": 1,
      "props": {
        "text": "{month}", "font": "bebas", "weight": 400, "size": 290,
        "color": "#f4efe6", "align": "left", "lineHeight": 1,
        "letterSpacing": 3, "uppercase": true
      }
    },
    {
      "id": "strip",
      "type": "calendar",
      "x": 80, "y": 990, "width": 2400, "height": 427,
      "props": {
        "style": "strip", "date": null, "weekStart": 1,
        "font": "barlow-condensed", "bg": "#0b0b0fee", "fg": "#f4efe6",
        "muted": "#8f8a82", "accent": "#e2342b", "accentText": "#fdf6ec",
        "showTitle": true, "showWeekdays": true, "showLines": true, "radius": 18
      }
    }
  ],
  "createdAt": "2026-10-26T00:00:00+01:00",
  "updatedAt": "2026-10-26T00:00:00+01:00"
}
```

Everything is validated and normalised on read/write: missing keys fall back to
defaults, numbers are clamped, colours are checked, sticker names cannot escape
`assets/stickers/`. Documents written before `sourceWidth`/`sourceHeight`
existed get the values measured from their `base.jpg` when they are read.
`date: null` means “use the render date”; set `"2026-12-24"` to pin a calendar.
A preset with no base image has `source*` equal to its canvas, so it always
matches.

Every layer also accepts `hidden` and `locked`. Composite layers keep their
children in `props.layers`, positioned in the composite's own `design` space
(the union box at creation) and scaled into the layer box:

```json
{
  "type": "shape",
  "x": 900, "y": 200, "width": 320, "height": 320, "rotation": 18,
  "props": { "shape": "star5", "fill": "#e2342bff", "stroke": "#00000000", "strokeWidth": 0 }
}
```

```json
{
  "type": "mask",
  "x": 120, "y": 620, "width": 640, "height": 360,
  "props": {
    "invert": true,
    "design": { "width": 640, "height": 360 },
    "layers": [
      { "type": "shape", "x": 40, "y": 20, "width": 300, "height": 300,
        "props": { "shape": "circle", "fill": "#ffffffff" } },
      { "type": "calendar", "x": 0, "y": 0, "width": 640, "height": 360,
        "props": { "style": "grid", "bg": "#000000cc" } }
    ]
  }
}
```

`layers[0]` is always the mask source (the cutting shape); the rest is the
content. A `shapeGroup` has the same `design`/`layers` shape without `invert`,
and only accepts `shape` / `shapeGroup` children.

### Date tokens and rules

Text layers support tokens expanded at render time. The names are snake_case:
`{day}`, `{day_padded}`, `{month}`, `{month_short}`, `{month_upper}`,
`{month_number}`, `{weekday}`, `{weekday_short}`, `{year}`, `{date}`.
Add an offset (`{day+1}`, `{month-1}`, `{year+1}` — the unit follows the token)
and a format (`{day:02}`, `{month:upper}`, `{weekday:short}`, `{year:short}`).
Conditionals are `{if:<name><op><value>?<then>:<else>}` with `=`, `!=`, `>`, `<`,
`>=`, `<=`, e.g. `{if:weekday=Saturday?Weekend:Work day}`. Unknown tokens are
left exactly as written. `web/js/render/text.js` and `hyprwall/widgets/text.py`
implement the same grammar, so the preview matches the composited image.

## Reusable widgets (Widgets page)

Design a widget on its own canvas (any size), exactly like a preset: text,
calendars, shapes and stickers, grouped and masked. Each widget is a folder
`widgets/<slug>/` with `widget.json` (+ `base.jpg` if you used an image), and
appears in the editor's **Reusable widgets** panel. Dropping one in creates a
`group` layer with the widget's design space, so the widget scales as a unit and
can be rotated and faded like everything else. Renaming a widget renames its
folder, just like presets.

## Wallpaper test page

`/test` renders any preset for a date and time you pick — `POST /api/render`
with a `date` — and shows the composed image plus the theme the day/night window
would choose. The desktop is never touched, so it is the safe way to check a
preset before applying it. Presets whose ratio does not match the canvas are
marked with their ratio badge.

## CLI

```bash
hyprwall apply                      # random preset for the current time of day
hyprwall apply --preset mazda_rx-7  # by slug or display name
hyprwall apply --time 21:30         # simulate a time
hyprwall apply --theme light        # force a theme
hyprwall apply --no-apply           # render only
hyprwall apply --dry-run            # say what would happen, change nothing
hyprwall apply --retry 3            # useful at login (compositor not ready yet)
hyprwall list [--theme dark] [--json]
hyprwall doctor
hyprwall serve [--host H] [--port P] [--reload]
```

`apply` only considers presets whose ratio matches the canvas (1.5 % tolerance)
and renders them at `canvas.width × canvas.height`. Naming a mismatched preset
is an error that tells you the preset ratio, the canvas ratio and to adapt it in
the editor; `random` never picks one.

### Apply backends

`hyprwall doctor` lists every backend, whether it is installed, and which one is
selected in the Options page. Applying tries the selected backend first, then
the other detected ones (`hyprland-caelestia` → `hyprland` → `kde` → `gnome` →
`custom`), and reports which one won. `apply_wallpaper()` never raises when no
backend works: it still writes the composed file and prints a hint.

### Hyprland autostart

```conf
# ~/.config/hypr/hyprland.conf
exec-once = sleep 3 && /home/<you>/Projects/kalender-wall/.venv/bin/hyprwall apply --retry 5 --retry-delay 2 --quiet
```

## Configuration

`~/.config/hyprwall/config.json` (all keys optional; the Options page writes
`canvas`, `theme` (the light/dark schedule) and `wallpaper` and leaves
everything else alone):

```json
{
  "presetsDir": "~/Projects/kalender-wall/presets",
  "widgetsDir": "~/Projects/kalender-wall/widgets",
  "cacheDir": "~/.cache/hyprwall",
  "outputPath": "~/.cache/current_wallpaper.jpg",
  "theme": { "dayStart": "07:00", "dayEnd": "19:00" },
  "canvas": { "width": 2560, "height": 1440, "background": "#101014" },
  "clockTheme": "dark",
  "wallpaper": {
    "backend": "hyprland-caelestia",
    "applyCommand": null,
    "caelestiaSmartScheme": false
  }
}
```

Environment overrides: `HYPRWALL_PRESETS_DIR`, `HYPRWALL_WIDGETS_DIR`,
`HYPRWALL_CACHE_DIR`, `HYPRWALL_OUTPUT`, `HYPRWALL_APPLY_COMMAND`,
`HYPRWALL_DAY_START`, `HYPRWALL_DAY_END`, `HYPRWALL_CONFIG`.

`presetsDir` and `widgetsDir` must be writable by the web editor; `cacheDir`
holds uploads, thumbnails and the CLI state.

`outputPath` is a base name: every render inserts `-YYYYmmdd-HHMMSS` before the
suffix (`current_wallpaper.jpg` → `current_wallpaper-20261027-011305.jpg`) and
deletes the files left by earlier renders. Put a `{timestamp}` token in the path
to choose the pattern yourself, e.g.
`"~/.cache/wallpapers/wall-{timestamp}.jpg"`. The timestamp is what makes the
desktop reload the image — keep it if you change the path.

## Stickers and fonts

- Drop PNG/WebP/JPEG/GIF/SVG files into `assets/stickers/`; reload the editor to
  see them. Sticker images are drawn natively in the browser and rasterised with
  cairosvg for the compositor; they are transform-only (position, scale,
  rotation). Only bare filenames from that folder are accepted. Recolourable
  vector artwork comes from the built-in shape library (`circle`, `square`,
  `triangle`, stars, …).
- Fonts are **auto-detected**: drop `.ttf`/`.otf` files into `assets/fonts/`
  (root or a sub folder) and reload — family name and weight are read from the
  metadata, so the picker and both renderers use the same file. A file inside a
  built-in family folder (e.g. `barlow/`) extends that family.
- Bundled fonts (SIL Open Font License, licences in `assets/fonts/*/OFL.txt`):
  **Barlow**, **Barlow Condensed**, **Bebas Neue**, **Archivo Black**,
  **IBM Plex Mono**, plus auto-detected extras such as **Aktura**, **Array**,
  **Styro** and **Zina**.

## How rendering stays in sync

The browser and Pillow implement the same small layout engine:

- text wraps greedily by measured glyph advances, letter spacing is applied per
  glyph, and baselines sit at `0.8 × font size` inside each line box;
- calendars draw a fixed design grid scaled uniformly into the widget box;
- rotation is applied to each layer (CSS `rotate()` in the browser,
  `Image.rotate()` in Pillow) around the box centre.

Layers are composited bottom-to-top in `widgets` order, each with its own
opacity, at the canvas resolution. The server exposes the same pipeline to the
browser via `POST /api/render` (Export PNG and the test page). Presets are
scaled into the current canvas with `scale_document()` before compositing, which
is what makes an adapted preset produce a wallpaper of exactly the configured
size.

Shape geometry is defined once, in `hyprwall/widgets/shapes.py`; the browser
receives the same `d` strings through `/api/config` and fills them with
`Path2D`, while Pillow rasterises them with cairosvg. Masks use canvas alpha
compositing in both engines (`destination-in` / `destination-out` versus
`ImageChops.multiply` on the alpha channel). Frosted glass is the one
approximation: the browser blurs with `backdrop-filter`, Pillow blurs the canvas
region under the card before laying the translucent tint and the crisp contents
on top.

## REST API

| method | path | purpose |
| --- | --- | --- |
| GET | `/api/config` | canvas defaults, fonts, stickers, shapes, calendar styles/layouts, time window, **backends** |
| GET/PUT | `/api/options` | canvas size, `theme` light/dark schedule + active theme, wallpaper backend |
| GET | `/api/presets` | preset list with `sourceWidth`/`sourceHeight`, `ratio`, `ratioLabel`, `ratioMatch` |
| POST | `/api/presets` | create (`unique_slug`) or update with `originalSlug` — **renames the folder** when the name changes |
| GET/PUT/DELETE | `/api/presets/{slug}` | read / update / delete |
| GET | `/api/presets/{slug}/thumbnail` | cached gallery thumbnail |
| GET | `/api/presets/{slug}/asset/{filename}` | `base.jpg` or `original-image.*` |
| POST | `/api/presets/{slug}/original` | copy `original-image` into the upload cache so it can be re-cropped |
| POST | `/api/presets/{slug}/apply` | composite at canvas size + apply, returns backend details; **409** on ratio mismatch |
| POST | `/api/render` | render a draft (or a stored preset via `presetSlug`) to PNG at the canvas size, optional `date` |
| GET | `/api/widgets` | widget library metadata + documents |
| POST | `/api/widgets` | create or update a widget (rename renames its folder) |
| GET/PUT/DELETE | `/api/widgets/{slug}` | read / update / delete |
| GET | `/api/widgets/{slug}/thumbnail` | cached widget thumbnail |
| POST | `/api/widgets/render` | render a widget draft to PNG |
| POST | `/api/uploads` | multipart `file`; stores the full-resolution upload, returns dimensions + URL |
| GET | `/api/uploads/{id}/image` | the stored upload |
| GET | `/api/stickers` | sticker assets |
| GET | `/api/health` | health probe |

A rename is reported to the caller: `POST /api/presets` answers with the saved
document, whose `slug` is the new folder name. Front ends should navigate to
that slug — the previous URL now returns 404, which is the point of the rename.

## Examples included

Eight presets ship in `presets/`, all 2560 × 1440:

- **RedBull**, **Quattro**, **Bird**, **Arctic** (light) and **Aircraft**,
  **Halo**, **Priestess**, **GunnerRed** (dark).
- Each is a designed composition over a photographic base: a calendar in the
  `strip`, `grid` or `minimal` style, plus text, shapes or stickers.
- **Aircraft** and **Priestess** are single `group` layers, so they show how a
  composite scales, rotates and fades as one unit.
- **GunnerRed** is the multi-layer reference: a sticker, an octagon shape and a
  minimal calendar as three separate layers.

Rename, restyle or delete them freely; a preset is just a folder.

## Troubleshooting

| symptom | fix |
| --- | --- |
| *“does not match the canvas ratio”* | The preset's source ratio differs from the canvas. Open it, **Adapt to canvas**, save as a new preset — or change the canvas in **Options**. |
| *“A custom wallpaper command is required”* | Selecting the `custom` backend needs a command containing `{path}`. |
| Wallpaper did not change | Run `hyprwall doctor`; check the backend, then `hyprwall apply --dry-run`. Caelestia caches by path, which is why every render uses a fresh timestamped file. |
| Stickers/shapes are blank in the final image | Install `cairo` (`sudo pacman -S cairo`) — the browser preview does not need it. |
| Upload rejected | JPEG, PNG or WebP, up to 40 MB. |
| A preset was renamed and a bookmark broke | That is intentional: the folder follows the name. Use the new slug from the gallery. |
| Old presets apply at a different ratio | Presets without `sourceWidth`/`sourceHeight` measure them from `base.jpg` on read; open and re-save one to store them explicitly. |

## License

MIT for the code. Bundled fonts ship under the SIL Open Font License; see
`assets/fonts/*/OFL.txt`.
