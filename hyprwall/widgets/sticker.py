"""Sticker widget: draws an image from ``assets/stickers`` inside the box.

Raster images are opened with Pillow; SVG files are rasterised on the fly with
cairosvg (needs the system ``libcairo``) so the composited wallpaper matches
what the browser draws.  Stickers are transform-only: position, scale and
rotation, and they fill their layer box on both axes so free transform can
stretch them.  Recolourable vector artwork lives in the shape library instead.
"""

from __future__ import annotations

import io
import re
from functools import lru_cache
from pathlib import Path
from typing import Any

from PIL import Image

from ..config import STICKERS_DIR

ALLOWED_EXTENSIONS = {".png", ".webp", ".jpg", ".jpeg", ".gif", ".svg"}

#: Longest edge cairosvg is asked to render; larger boxes upscale from this.
SVG_RASTER_LIMIT = 4096

_SIZE_ATTR_RE = re.compile(r"\b(width|height)\s*=\s*[\"']\s*([\d.]+)\s*(?:px)?[\"']")
_VIEWBOX_RE = re.compile(r"\bviewBox\s*=\s*[\"']\s*[-\d.]+[,\s]+[-\d.]+[,\s]+([\d.]+)[,\s]+([\d.]+)[\"']")


def sanitize_sticker_name(value: object) -> str | None:
    """Only bare filenames inside the sticker folder are allowed."""
    if not isinstance(value, str) or not value.strip():
        return None
    name = Path(value.strip()).name
    if name != value.strip() or name.startswith("."):
        return None
    if Path(name).suffix.lower() not in ALLOWED_EXTENSIONS:
        return None
    if not (STICKERS_DIR / name).is_file():
        return None
    return name


def sticker_path(value: object) -> Path | None:
    name = sanitize_sticker_name(value)
    return STICKERS_DIR / name if name else None


def _svg_size(path: Path) -> tuple[int, int]:
    """Intrinsic size of an SVG: ``width``/``height`` attributes, else viewBox."""
    try:
        head = path.read_text(encoding="utf-8", errors="replace")[:8192]
    except OSError:
        return (512, 512)
    attrs: dict[str, float] = {}
    for match in _SIZE_ATTR_RE.finditer(head):
        try:
            attrs[match.group(1)] = float(match.group(2))
        except ValueError:
            continue
    if attrs.get("width", 0) > 0 and attrs.get("height", 0) > 0:
        return (max(1, round(attrs["width"])), max(1, round(attrs["height"])))
    viewbox = _VIEWBOX_RE.search(head)
    if viewbox:
        try:
            width, height = float(viewbox.group(1)), float(viewbox.group(2))
            if width > 0 and height > 0:
                return (max(1, round(width)), max(1, round(height)))
        except ValueError:
            pass
    return (512, 512)


@lru_cache(maxsize=8)
def _svg_size_cached(path_str: str, mtime: float) -> tuple[int, int]:
    return _svg_size(Path(path_str))


def _open_size(path: Path) -> tuple[int, int]:
    if path.suffix.lower() == ".svg":
        try:
            return _svg_size_cached(str(path), path.stat().st_mtime_ns)
        except OSError:
            return (512, 512)
    with Image.open(path) as image:
        return image.size


def list_stickers() -> list[dict[str, Any]]:
    if not STICKERS_DIR.is_dir():
        return []
    items = []
    for path in sorted(STICKERS_DIR.iterdir()):
        if not path.is_file() or path.suffix.lower() not in ALLOWED_EXTENSIONS:
            continue
        try:
            width, height = _open_size(path)
        except (OSError, ValueError):
            continue
        items.append(
            {
                "name": path.name,
                "url": f"/assets/stickers/{path.name}",
                "width": width,
                "height": height,
            }
        )
    return items


@lru_cache(maxsize=64)
def _load(path: str, mtime: float) -> Image.Image:
    with Image.open(path) as image:
        return image.convert("RGBA").copy()


@lru_cache(maxsize=32)
def _load_svg(path: str, mtime: float, target_width: int, target_height: int) -> Image.Image:
    import cairosvg  # lazy: needs the system cairo library

    width = max(1, min(SVG_RASTER_LIMIT, int(target_width)))
    height = max(1, min(SVG_RASTER_LIMIT, int(target_height)))
    png = cairosvg.svg2png(url=path, output_width=width, output_height=height)
    with Image.open(io.BytesIO(png)) as image:
        return image.convert("RGBA").copy()


def render_sticker(widget: dict[str, Any]) -> Image.Image:
    """Render a sticker filling an RGBA layer sized to the widget box.

    The box is the truth: the image is stretched to it, exactly like the browser
    preview.  Aspect-locked resizing keeps the box proportional, so nothing
    distorts until free transform is used on purpose.
    """
    width = max(1, int(round(float(widget.get("width", 1)))))
    height = max(1, int(round(float(widget.get("height", 1)))))
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))

    props = widget.get("props") or {}
    path = sticker_path(props.get("src"))
    if not path:
        return layer

    try:
        if path.suffix.lower() == ".svg":
            sticker = _load_svg(str(path), path.stat().st_mtime_ns, width, height)
        else:
            sticker = _load(str(path), path.stat().st_mtime_ns)
    except Exception:  # noqa: BLE001 - a broken SVG must not break the render
        return layer

    target = (width, height)
    if target != sticker.size:
        sticker = sticker.resize(target, Image.Resampling.LANCZOS)
    layer.alpha_composite(sticker, dest=(0, 0))
    return layer
