"""Bundled font registry.

The web editor and the Pillow compositor must draw the exact same glyphs, so
every font used by a wallpaper ships in ``assets/fonts`` and both renderers
resolve families through this module.  The API exposes :func:`font_catalogue`
so the browser can generate matching ``@font-face`` rules.

Besides the curated families below, any ``.ttf``/``.otf`` file found in
``assets/fonts`` (at the root or in a sub folder) is detected automatically:
the family name and weight are read from the font metadata, so dropping a file
into the folder is enough to make it appear in the editor.
"""

from __future__ import annotations

import re
from functools import lru_cache
from pathlib import Path

from PIL import ImageFont

from .config import FONTS_DIR

# family id -> {label, weight -> relative font file}
FONT_FAMILIES: dict[str, dict] = {
    "barlow-condensed": {
        "label": "Barlow Condensed",
        "weights": {
            400: "barlow-condensed/BarlowCondensed-Regular.ttf",
            500: "barlow-condensed/BarlowCondensed-Medium.ttf",
            600: "barlow-condensed/BarlowCondensed-SemiBold.ttf",
            700: "barlow-condensed/BarlowCondensed-Bold.ttf",
            800: "barlow-condensed/BarlowCondensed-ExtraBold.ttf",
        },
    },
    "barlow": {
        "label": "Barlow",
        "weights": {
            400: "barlow/Barlow-Regular.ttf",
            500: "barlow/Barlow-Medium.ttf",
            600: "barlow/Barlow-SemiBold.ttf",
            700: "barlow/Barlow-Bold.ttf",
        },
    },
    "bebas": {
        "label": "Bebas Neue",
        "weights": {400: "bebas/BebasNeue-Regular.ttf"},
    },
    "archivo-black": {
        "label": "Archivo Black",
        "weights": {400: "archivo-black/ArchivoBlack-Regular.ttf"},
    },
    "plex-mono": {
        "label": "IBM Plex Mono",
        "weights": {
            400: "plex-mono/IBMPlexMono-Regular.ttf",
            500: "plex-mono/IBMPlexMono-Medium.ttf",
            600: "plex-mono/IBMPlexMono-SemiBold.ttf",
        },
    },
}

DEFAULT_FONT = "barlow-condensed"
DEFAULT_TEXT_FONT = "barlow"

_FONT_FILE_RE = re.compile(r"\.(ttf|otf)$", re.IGNORECASE)
#: Style name (lower-cased, non letters stripped) -> CSS weight.  Longest and
#: most specific forms are matched first so "SemiBold" does not become 700.
_STYLE_WEIGHT_RULES: tuple[tuple[str, int], ...] = (
    ("extralight", 200),
    ("ultralight", 200),
    ("semibold", 600),
    ("demibold", 600),
    ("extrabold", 800),
    ("ultrabold", 800),
    ("light", 300),
    ("medium", 500),
    ("black", 900),
    ("heavy", 900),
    ("bold", 700),
    ("thin", 100),
    ("regular", 400),
    ("normal", 400),
    ("book", 400),
)


def _weight_from_style(style: str) -> int:
    normalised = re.sub(r"[^a-z]", "", (style or "").lower())
    for fragment, weight in _STYLE_WEIGHT_RULES:
        if fragment in normalised:
            return weight
    return 400


def _slug(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").lower()).strip("-")
    return slug[:48].strip("-") or "font"


def _font_signature() -> tuple[tuple[str, int], ...]:
    """``(relative path, mtime)`` for every font file — cheap cache key."""
    if not FONTS_DIR.is_dir():
        return ()
    entries: list[tuple[str, int]] = []
    for path in sorted(FONTS_DIR.rglob("*")):
        if path.is_file() and _FONT_FILE_RE.search(path.name):
            try:
                entries.append((str(path.relative_to(FONTS_DIR)), path.stat().st_mtime_ns))
            except OSError:
                continue
    return tuple(entries)


@lru_cache(maxsize=8)
def _registry(signature: tuple[tuple[str, int], ...]) -> dict[str, dict]:
    """Built-in families plus every font file found in ``assets/fonts``."""
    families: dict[str, dict] = {}
    for family_id, meta in FONT_FAMILIES.items():
        families[family_id] = {"label": meta["label"], "weights": dict(meta["weights"])}

    taken_paths = {
        relative for meta in families.values() for relative in meta["weights"].values()
    }
    # A file inside a built-in's folder extends that family (barlow/...),
    # whatever the file is called.
    directory_ids = {
        relative.split("/", 1)[0]: family_id
        for family_id, meta in families.items()
        for relative in meta["weights"].values()
        if "/" in relative
    }

    extras: dict[str, dict] = {}
    for relative, _mtime in signature:
        if relative in taken_paths:
            continue
        path = FONTS_DIR / relative
        try:
            family_name, style_name = ImageFont.truetype(str(path), 12).getname()
        except (OSError, ValueError):
            continue
        parent = relative.rsplit("/", 1)[0] if "/" in relative else ""
        if parent in directory_ids:
            family_id = directory_ids[parent]
        else:
            family_id = _slug(family_name)
        group = extras.setdefault(
            family_id, {"label": family_name.strip() or family_id, "weights": {}}
        )
        weight = _weight_from_style(style_name)
        # A plain (non-italic) cut wins if two files claim the same weight.
        existing = group["weights"].get(weight)
        if existing is None:
            group["weights"][weight] = relative
        elif "italic" in existing.lower() and "italic" not in relative.lower():
            group["weights"][weight] = relative

    for family_id, group in sorted(extras.items()):
        if family_id in families:
            # Same family as a built-in (or another file): merge extra weights.
            for weight, relative in group["weights"].items():
                families[family_id]["weights"].setdefault(weight, relative)
        else:
            families[family_id] = group

    # Unique CSS family names — the browser keys FontFace on them.
    used: dict[str, str] = {}
    for family_id, meta in families.items():
        css_name = f"HyprWall {meta['label']}"
        if css_name in used and used[css_name] != family_id:
            css_name = f"HyprWall {meta['label']} ({family_id})"
        used[css_name] = family_id
        meta["cssName"] = css_name
    return families


def _families() -> dict[str, dict]:
    return _registry(_font_signature())


def font_css_name(family: str) -> str:
    """CSS family name used by both ``@font-face`` and canvas ``ctx.font``."""
    registry = _families()
    meta = registry.get(family) or registry.get(DEFAULT_FONT)
    if meta is None:  # pragma: no cover - built-in always present
        return f"HyprWall {FONT_FAMILIES[DEFAULT_FONT]['label']}"
    return meta["cssName"]


def normalise_family(family: object, fallback: str = DEFAULT_FONT) -> str:
    registry = _families()
    if isinstance(family, str) and family in registry:
        return family
    return fallback if fallback in registry else DEFAULT_FONT


def normalise_weight(family: str, weight: object) -> int:
    """Snap a weight to the closest weight bundled with the family."""
    available = sorted(_families()[normalise_family(family)]["weights"])
    try:
        requested = int(weight)  # type: ignore[arg-type]
    except (TypeError, ValueError):
        requested = 400
    return min(available, key=lambda candidate: abs(candidate - requested))


def font_path(family: str, weight: int) -> Path:
    family = normalise_family(family)
    weight = normalise_weight(family, weight)
    relative = _families()[family]["weights"][weight]
    return FONTS_DIR / relative


@lru_cache(maxsize=256)
def load_font(family: str, weight: int, size: int) -> ImageFont.FreeTypeFont:
    path = font_path(family, weight)
    return ImageFont.truetype(str(path), max(1, int(size)))


def font_catalogue() -> list[dict]:
    """Data for ``/api/config`` so the browser can build ``@font-face`` rules."""
    families = []
    for family_id, meta in _families().items():
        families.append(
            {
                "id": family_id,
                "label": meta["label"],
                "cssName": meta["cssName"],
                "weights": [
                    {
                        "weight": weight,
                        "url": f"/assets/fonts/{relative}",
                    }
                    for weight, relative in sorted(meta["weights"].items())
                ],
            }
        )
    return families
