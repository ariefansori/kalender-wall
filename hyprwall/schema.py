"""Preset document shape: defaults, validation and normalisation.

``widget.json`` files are normalised through this module on every read and
write, so a hand edited file with missing keys still renders and the API can
never persist nonsense.
"""

from __future__ import annotations

import math
import re
import unicodedata
import uuid
from datetime import datetime
from math import gcd
from typing import Any

from .fonts import normalise_family, normalise_weight
from .widgets.calendar import CALENDAR_DESIGNS, CALENDAR_LAYOUTS
from .widgets.shapes import DEFAULT_FILL, DEFAULT_STROKE, is_shape
from .widgets.sticker import ALLOWED_EXTENSIONS

PRESET_VERSION = 1
WIDGET_VERSION = 1
ALLOWED_THEMES = ("light", "dark")
#: ``shapeGroup`` is a ``<g>`` of SVG shapes, ``mask`` a vector clip/hole
#: composite.  ``group`` places a reusable widget document.
COMPOSITE_TYPES = ("shapeGroup", "mask")
ALLOWED_TYPES = ("text", "calendar", "sticker", "shape", "shapeGroup", "mask", "group")
#: Widget documents are built from plain layers; nesting widgets in widgets is
#: intentionally impossible so the library stays acyclic.
LAYER_TYPES = ("text", "calendar", "sticker", "shape", "shapeGroup", "mask")
#: Which layer types a composite may contain.  Masks never nest in masks, and
#: only vector layers can be grouped into a ``<g>``.
COMPOSITE_CHILDREN: dict[str, tuple[str, ...]] = {
    "shapeGroup": ("shape", "shapeGroup"),
    "mask": ("text", "calendar", "sticker", "shape", "shapeGroup"),
}
#: Guards against pathological nesting in hand-edited files.
MAX_COMPOSITE_DEPTH = 3

TEXT_DEFAULTS: dict[str, Any] = {
    "text": "Your text here",
    "font": "barlow-condensed",
    "weight": 600,
    "size": 72,
    "color": "#f4efe6",
    "align": "left",
    "lineHeight": 1.15,
    "letterSpacing": 0,
    "uppercase": False,
}

CALENDAR_DEFAULTS: dict[str, Any] = {
    "style": "grid",
    "layout": "auto",
    "date": None,
    "weekStart": 1,
    "font": "barlow-condensed",
    "bg": "#00000000",
    "fg": "#f4efe6",
    "muted": "#8b8b8b",
    "accent": "#e2342b",
    "accentText": "#fdf6ec",
    "showTitle": True,
    "showWeekdays": True,
    "showLines": True,
    #: Vertical layouts only: how far the weekday column is pulled towards the
    #: day numbers (the numbers stay pinned to the outer screen edge).
    "gap": 0,
    "radius": 28,
    "glass": False,
    "glassBlur": 18,
}

#: Sticker images are transform-only: position, scale and rotation.  Colours
#: belong to the vector ``shape`` layer instead.
STICKER_DEFAULTS: dict[str, Any] = {"src": ""}

SHAPE_DEFAULTS: dict[str, Any] = {
    "shape": "square",
    "fill": DEFAULT_FILL,
    "stroke": DEFAULT_STROKE,
    "strokeWidth": 0,
}

GROUP_DEFAULTS: dict[str, Any] = {"slug": ""}

#: ``design`` is the composite's own coordinate space: children are positioned
#: inside it and the whole thing is scaled into the widget box, so resizing a
#: group (or its mask source) never distorts it.
_EMPTY_COMPOSITE: dict[str, Any] = {
    "design": {"width": 400, "height": 400},
    "layers": [],
}

SHAPE_GROUP_DEFAULTS: dict[str, Any] = {**_EMPTY_COMPOSITE}

#: Vector mask.  ``layers[0]`` is the mask source (the geometric shape); the
#: remaining layers are clipped by it, or — with ``invert`` — punched through.
MASK_DEFAULTS: dict[str, Any] = {
    **_EMPTY_COMPOSITE,
    "invert": False,
}

WIDGET_DEFAULTS: dict[str, dict[str, Any]] = {
    "text": TEXT_DEFAULTS,
    "calendar": CALENDAR_DEFAULTS,
    "sticker": STICKER_DEFAULTS,
    "shape": SHAPE_DEFAULTS,
    "shapeGroup": SHAPE_GROUP_DEFAULTS,
    "mask": MASK_DEFAULTS,
    "group": GROUP_DEFAULTS,
}

WIDGET_BOX_DEFAULTS: dict[str, dict[str, float]] = {
    "text": {"width": 900, "height": 180},
    "calendar": {"width": 880, "height": 620},
    "sticker": {"width": 320, "height": 320},
    "shape": {"width": 320, "height": 320},
    "shapeGroup": {"width": 400, "height": 400},
    "mask": {"width": 400, "height": 400},
    "group": {"width": 600, "height": 300},
}

SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,63}$")
ID_RE = re.compile(r"^[A-Za-z0-9_-]{1,64}$")
UPLOAD_RE = re.compile(r"^upload:([0-9a-f]{32})$")
ORIGINAL_RE = re.compile(r"^original-image\.[A-Za-z0-9]{2,5}$")

#: Two aspect ratios count as the same when they differ by less than this
#: fraction of the larger one (≈ 1.5 %).
RATIO_TOLERANCE = 0.015
COLOR_RE = re.compile(r"^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$")
ISO_DATE_RE = re.compile(r"^\d{4}-\d{2}-\d{2}$")


class PresetValidationError(ValueError):
    """Raised for documents that cannot be normalised safely."""


def _clamp(value: Any, low: float, high: float, fallback: float) -> float:
    try:
        number = float(value)
    except (TypeError, ValueError):
        return fallback
    if math.isnan(number):
        return fallback
    return max(low, min(high, number))


def _integer(value: Any, low: int, high: int, fallback: int) -> int:
    return int(round(_clamp(value, low, high, fallback)))


def _clean_text(value: Any, limit: int, fallback: str = "") -> str:
    if not isinstance(value, str):
        return fallback
    cleaned = "".join(ch for ch in value if ch in ("\n", "\t") or ord(ch) >= 32)
    return cleaned[:limit]


def _color(value: Any, fallback: str) -> str:
    if isinstance(value, str) and value.strip().lower() == "transparent":
        return "#00000000"
    if isinstance(value, str) and COLOR_RE.match(value.strip()):
        return value.strip()
    return fallback


def slugify(name: str) -> str:
    """``"Crimson Noir!"`` -> ``"crimson-noir"``."""
    ascii_name = (
        unicodedata.normalize("NFKD", name or "").encode("ascii", "ignore").decode("ascii")
    )
    slug = re.sub(r"[^a-zA-Z0-9]+", "-", ascii_name).strip("-").lower()
    slug = slug[:48].strip("-")
    if not slug or slug in (".", ".."):
        slug = "preset-" + uuid.uuid4().hex[:8]
    if not slug[0].isalnum():
        slug = "p-" + slug
    return slug


def unique_slug(base: str, taken: set[str]) -> str:
    if base not in taken:
        return base
    index = 2
    while f"{base}-{index}" in taken:
        index += 1
    return f"{base}-{index}"


def normalize_name(value: Any) -> str:
    name = _clean_text(value, 80).strip()
    return name or "Untitled preset"


def normalize_base(raw: Any, *, default_width: int, default_height: int) -> dict[str, Any]:
    data = raw if isinstance(raw, dict) else {}
    file_token = data.get("file")
    if not isinstance(file_token, str):
        file_token = ""
    file_token = file_token.strip()
    if file_token and file_token != "base.jpg" and not UPLOAD_RE.match(file_token):
        file_token = ""
    original = data.get("original")
    original = original.strip() if isinstance(original, str) else ""
    if not ORIGINAL_RE.match(original):
        original = ""
    return {
        "file": file_token,
        "original": original,
        "x": _clamp(data.get("x"), -100_000, 100_000, 0),
        "y": _clamp(data.get("y"), -100_000, 100_000, 0),
        "width": _clamp(data.get("width"), 1, 20_000, default_width),
        "height": _clamp(data.get("height"), 1, 20_000, default_height),
        "fit": "contain" if str(data.get("fit")) == "contain" else "cover",
        "opacity": _clamp(data.get("opacity", 1), 0, 1, 1),
        "visible": bool(data.get("visible", True)),
        "flipX": bool(data.get("flipX", False)),
        "flipY": bool(data.get("flipY", False)),
    }


def _normalize_text_props(props: dict[str, Any]) -> dict[str, Any]:
    family = normalise_family(props.get("font"), "barlow")
    return {
        "text": _clean_text(props.get("text"), 5000, TEXT_DEFAULTS["text"]),
        "font": family,
        "weight": normalise_weight(family, props.get("weight", TEXT_DEFAULTS["weight"])),
        "size": _clamp(props.get("size", TEXT_DEFAULTS["size"]), 4, 2000, 72),
        "color": _color(props.get("color"), TEXT_DEFAULTS["color"]),
        "align": props.get("align") if props.get("align") in ("left", "center", "right") else "left",
        "lineHeight": _clamp(props.get("lineHeight", 1.15), 0.6, 4, 1.15),
        "letterSpacing": _clamp(props.get("letterSpacing", 0), -200, 500, 0),
        "uppercase": bool(props.get("uppercase", False)),
    }


def _normalize_calendar_props(props: dict[str, Any]) -> dict[str, Any]:
    style = str(props.get("style") or "grid")
    if style not in CALENDAR_DESIGNS:
        style = "grid"
    layout = str(props.get("layout") or "auto")
    if layout not in CALENDAR_LAYOUTS:
        layout = "auto"
    date_value = props.get("date")
    date_text = date_value.strip() if isinstance(date_value, str) else ""
    if not ISO_DATE_RE.match(date_text):
        date_text = ""
    family = normalise_family(props.get("font"), "barlow-condensed")
    return {
        "style": style,
        "layout": layout,
        "date": date_text or None,
        "weekStart": 1 if str(props.get("weekStart", 1)) not in ("0", "sun", "sunday") else 0,
        "font": family,
        "bg": _color(props.get("bg", "#00000000"), "#00000000"),
        "fg": _color(props.get("fg"), CALENDAR_DEFAULTS["fg"]),
        "muted": _color(props.get("muted"), CALENDAR_DEFAULTS["muted"]),
        "accent": _color(props.get("accent"), CALENDAR_DEFAULTS["accent"]),
        "accentText": _color(props.get("accentText"), CALENDAR_DEFAULTS["accentText"]),
        "showTitle": bool(props.get("showTitle", True)),
        "showWeekdays": bool(props.get("showWeekdays", True)),
        "showLines": bool(props.get("showLines", True)),
        "gap": _clamp(props.get("gap", 0), 0, 260, 0),
        "radius": _clamp(props.get("radius", 28), 0, 300, 28),
        "glass": bool(props.get("glass", False)),
        "glassBlur": _clamp(props.get("glassBlur", 18), 0, 80, 18),
    }


def _normalize_group_props(props: dict[str, Any]) -> dict[str, Any]:
    raw_slug = props.get("slug")
    slug = raw_slug.strip() if isinstance(raw_slug, str) else ""
    return {"slug": slug if SLUG_RE.match(slug) else ""}


def _normalize_shape_props(props: dict[str, Any]) -> dict[str, Any]:
    shape_id = props.get("shape")
    if not is_shape(shape_id):
        shape_id = SHAPE_DEFAULTS["shape"]
    return {
        "shape": shape_id,
        "fill": _color(props.get("fill"), DEFAULT_FILL),
        "stroke": _color(props.get("stroke"), DEFAULT_STROKE),
        "strokeWidth": _clamp(props.get("strokeWidth", 0), 0, 40, 0),
    }


def _normalize_composite_props(props: dict[str, Any], kind: str, depth: int) -> dict[str, Any]:
    design_raw = props.get("design") if isinstance(props.get("design"), dict) else {}
    design = {
        "width": _integer(design_raw.get("width"), 4, 20_000, 400),
        "height": _integer(design_raw.get("height"), 4, 20_000, 400),
    }
    allowed = COMPOSITE_CHILDREN[kind]
    layers: list[dict[str, Any]] = []
    incoming = props.get("layers")
    if isinstance(incoming, list):
        for item in incoming[:60]:
            if not isinstance(item, dict) or item.get("type") not in allowed:
                continue
            child = normalize_widget(item, depth=depth + 1)
            if child is not None:
                layers.append(child)
    result: dict[str, Any] = {"design": design, "layers": layers}
    if kind == "mask":
        result["invert"] = bool(props.get("invert", False))
    return result


def _normalize_sticker_props(props: dict[str, Any]) -> dict[str, Any]:
    raw_src = props.get("src")
    src = ""
    if isinstance(raw_src, str) and raw_src.strip():
        candidate = raw_src.strip().replace("\\", "/").split("/")[-1]
        if not candidate.startswith(".") and candidate.rsplit(".", 1)[-1].lower() in {
            ext.lstrip(".") for ext in ALLOWED_EXTENSIONS
        }:
            src = candidate
    return {"src": src}


def normalize_widget(raw: Any, *, depth: int = 0) -> dict[str, Any] | None:
    if not isinstance(raw, dict):
        return None
    kind = raw.get("type")
    if kind not in ALLOWED_TYPES or depth > MAX_COMPOSITE_DEPTH:
        return None

    box = WIDGET_BOX_DEFAULTS[kind]
    defaults = WIDGET_DEFAULTS[kind]
    incoming_props = raw.get("props")
    props = {**defaults, **(incoming_props if isinstance(incoming_props, dict) else {})}
    if kind == "text":
        props = _normalize_text_props(props)
    elif kind == "calendar":
        props = _normalize_calendar_props(props)
    elif kind == "group":
        props = _normalize_group_props(props)
    elif kind == "shape":
        props = _normalize_shape_props(props)
    elif kind in COMPOSITE_TYPES:
        props = _normalize_composite_props(props, kind, depth)
    else:
        props = _normalize_sticker_props(props)

    widget_id = raw.get("id")
    if not isinstance(widget_id, str) or not ID_RE.match(widget_id):
        widget_id = uuid.uuid4().hex[:12]

    return {
        "id": widget_id,
        "type": kind,
        "x": _clamp(raw.get("x"), -100_000, 100_000, 0),
        "y": _clamp(raw.get("y"), -100_000, 100_000, 0),
        "width": _clamp(raw.get("width"), 4, 20_000, box["width"]),
        "height": _clamp(raw.get("height"), 4, 20_000, box["height"]),
        "rotation": _clamp(raw.get("rotation", 0), -3600, 3600, 0),
        "opacity": _clamp(raw.get("opacity", 1), 0, 1, 1),
        "hidden": bool(raw.get("hidden", False)),
        "locked": bool(raw.get("locked", False)),
        "props": props,
    }


def ratio_of(width: Any, height: Any) -> float:
    """Aspect ratio as a float; ``0.0`` when either dimension is unknown."""
    try:
        w = float(width)
        h = float(height)
    except (TypeError, ValueError):
        return 0.0
    if w <= 0 or h <= 0 or math.isnan(w) or math.isnan(h):
        return 0.0
    return w / h


def ratios_match(a: float, b: float, tolerance: float = RATIO_TOLERANCE) -> bool:
    """Compare two ratios numerically, tolerating a small difference.

    An unknown ratio (``0``) never blocks a preset, so documents saved before
    the dimensions were recorded keep working.
    """
    if not a or not b:
        return True
    return abs(a - b) / max(a, b) < tolerance


def ratio_label(width: Any, height: Any) -> str:
    """``2560×1440`` -> ``"16:9"``; unusual ratios fall back to ``"1.71:1"``."""
    try:
        w = int(round(float(width)))
        h = int(round(float(height)))
    except (TypeError, ValueError):
        return "?"
    if w <= 0 or h <= 0:
        return "?"
    divisor = gcd(w, h)
    rw, rh = w // divisor, h // divisor
    if rw <= 32 and rh <= 32:
        return f"{rw}:{rh}"
    return f"{w / h:.2f}:1"


def normalize_preset(raw: Any, *, default_name: str = "Untitled preset") -> dict[str, Any]:
    if not isinstance(raw, dict):
        raise PresetValidationError("preset must be a JSON object")

    canvas_raw = raw.get("canvas") if isinstance(raw.get("canvas"), dict) else {}
    width = _integer(canvas_raw.get("width"), 320, 8192, 2560)
    height = _integer(canvas_raw.get("height"), 320, 8192, 1440)
    theme = raw.get("theme")
    if theme not in ALLOWED_THEMES:
        theme = "dark"

    widgets_raw = raw.get("widgets")
    widgets = []
    if isinstance(widgets_raw, list):
        for item in widgets_raw[:100]:
            widget = normalize_widget(item)
            if widget is not None:
                widgets.append(widget)

    now = datetime.now().astimezone().isoformat(timespec="seconds")
    created = raw.get("createdAt") if isinstance(raw.get("createdAt"), str) else now
    # Keep the real last-saved stamp so the gallery list can sort by it; the
    # store refreshes updatedAt whenever a document is actually written.
    updated = raw.get("updatedAt") if isinstance(raw.get("updatedAt"), str) else now

    #: Real pixel dimensions of the image the preset was built from.  ``0``
    #: means "not recorded yet"; the store fills it in from the base image.
    source_width = _integer(raw.get("sourceWidth"), 0, 200_000, 0)
    source_height = _integer(raw.get("sourceHeight"), 0, 200_000, 0)

    return {
        "version": PRESET_VERSION,
        "name": normalize_name(raw.get("name") or default_name),
        "theme": theme,
        "sourceWidth": source_width,
        "sourceHeight": source_height,
        "canvas": {
            "width": width,
            "height": height,
            "background": _color(canvas_raw.get("background"), "#101014"),
        },
        "base": normalize_base(
            raw.get("base"), default_width=width, default_height=height
        ),
        "widgets": widgets,
        "createdAt": created,
        "updatedAt": updated,
    }


def normalize_widget_doc(raw: Any, *, default_name: str = "Untitled widget") -> dict[str, Any]:
    """Normalise a reusable widget from ``widgets/<slug>/widget.json``.

    A widget is a transparent design canvas plus plain layers; presets place it
    as a single ``group`` layer, so editing the widget updates every preset that
    uses it.
    """
    if not isinstance(raw, dict):
        raise PresetValidationError("widget must be a JSON object")

    size_raw = raw.get("size") if isinstance(raw.get("size"), dict) else {}
    width = _integer(size_raw.get("width"), 80, 4096, 600)
    height = _integer(size_raw.get("height"), 80, 4096, 300)

    widgets_raw = raw.get("widgets")
    widgets: list[dict[str, Any]] = []
    if isinstance(widgets_raw, list):
        for item in widgets_raw[:60]:
            widget = normalize_widget(item)
            if widget is not None and widget["type"] in LAYER_TYPES:
                widgets.append(widget)

    now = datetime.now().astimezone().isoformat(timespec="seconds")
    created = raw.get("createdAt") if isinstance(raw.get("createdAt"), str) else now
    updated = raw.get("updatedAt") if isinstance(raw.get("updatedAt"), str) else now

    return {
        "version": WIDGET_VERSION,
        "name": normalize_name(raw.get("name") or default_name),
        "size": {"width": width, "height": height},
        "widgets": widgets,
        "createdAt": created,
        "updatedAt": updated,
    }


def calendar_defaults(style: str) -> dict[str, Any]:
    """Defaults for a freshly created calendar widget of ``style``."""
    style = style if style in CALENDAR_DESIGNS else "grid"
    return {**CALENDAR_DEFAULTS, "style": style}


def theme_palette(theme: str) -> dict[str, str]:
    """Colours used when creating widgets from the editor."""
    if theme == "light":
        return {
            "fg": "#17130f",
            "muted": "#6d655c",
            "bg": "#00000000",
            "accent": "#d92b1f",
            "accentText": "#fff6ec",
        }
    return {
        "fg": "#f4efe6",
        "muted": "#8b8b8b",
        "bg": "#00000000",
        "accent": "#e2342b",
        "accentText": "#fdf6ec",
    }


__all__ = [
    "CALENDAR_DEFAULTS",
    "COMPOSITE_TYPES",
    "GROUP_DEFAULTS",
    "LAYER_TYPES",
    "MASK_DEFAULTS",
    "ORIGINAL_RE",
    "PresetValidationError",
    "RATIO_TOLERANCE",
    "SHAPE_DEFAULTS",
    "SHAPE_GROUP_DEFAULTS",
    "STICKER_DEFAULTS",
    "TEXT_DEFAULTS",
    "calendar_defaults",
    "normalize_preset",
    "normalize_widget",
    "normalize_widget_doc",
    "ratio_label",
    "ratio_of",
    "ratios_match",
    "slugify",
    "theme_palette",
    "unique_slug",
]

