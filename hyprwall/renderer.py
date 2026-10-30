"""The compositor: base image + widgets -> one static wallpaper.

Layer types
-----------
``text`` / ``calendar`` / ``sticker``
    Plain widgets, drawn into a layer the size of their box.
``shape``
    One path from the built-in SVG shape library, rasterised with cairosvg.
``shapeGroup``
    A ``<g>``: vector layers positioned in the group's own design space, then
    scaled into the widget box as a unit.
``mask``
    A vector mask composite: ``layers[0]`` is the mask source (the geometric
    shape), the remaining layers are clipped by it or, with ``invert``,
    punched through so whatever sits below shows in the hole.
``group``
    A placed reusable widget document.
"""

from __future__ import annotations

from collections.abc import Callable
from datetime import date
from pathlib import Path
from typing import Any

from PIL import Image, ImageChops, ImageDraw, ImageFilter

from .colors import parse_color
from .config import DEFAULT_BACKGROUND
from .widgets import render_calendar, render_shape, render_sticker, render_text

Image.MAX_IMAGE_PIXELS = 80_000_000


def open_base_image(base: dict[str, Any], base_path: Path | None) -> Image.Image | None:
    if not base_path or not base_path.is_file():
        return None
    try:
        with Image.open(base_path) as image:
            return image.convert("RGBA")
    except (OSError, ValueError):
        return None


def _cover(image: Image.Image, width: int, height: int) -> Image.Image:
    """Scale and crop ``image`` to exactly fill ``width`` x ``height``."""
    scale = max(width / image.width, height / image.height)
    target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    resized = image.resize(target, Image.Resampling.LANCZOS)
    left = (resized.width - width) // 2
    top = (resized.height - height) // 2
    return resized.crop((left, top, left + width, top + height))


def _contain(image: Image.Image, width: int, height: int) -> Image.Image:
    scale = min(width / image.width, height / image.height)
    target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    resized = image.resize(target, Image.Resampling.LANCZOS)
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    canvas.alpha_composite(
        resized, dest=((width - resized.width) // 2, (height - resized.height) // 2)
    )
    return canvas


def _apply_opacity(layer: Image.Image, opacity: float) -> Image.Image:
    if opacity >= 0.999:
        return layer
    alpha = layer.getchannel("A").point(lambda value: int(round(value * opacity)))
    layer.putalpha(alpha)
    return layer


def _paste(canvas: Image.Image, layer: Image.Image, left: int, top: int) -> None:
    """Alpha-composite ``layer`` at ``left, top`` clipped to the canvas."""
    x0 = max(0, left)
    y0 = max(0, top)
    x1 = min(canvas.width, left + layer.width)
    y1 = min(canvas.height, top + layer.height)
    if x1 <= x0 or y1 <= y0:
        return
    crop = layer.crop((x0 - left, y0 - top, x1 - left, y1 - top))
    canvas.alpha_composite(crop, dest=(x0, y0))


def group_resolver(widgets_dir: Path | None) -> Callable[[str], dict[str, Any] | None]:
    """Return a ``slug -> widget document`` lookup for ``group`` layers."""
    from .widgetstore import WidgetError, WidgetStore

    store = WidgetStore(widgets_dir) if widgets_dir else None

    def resolve(slug: str) -> dict[str, Any] | None:
        if store is None:
            return None
        try:
            return store.load(slug)
        except (WidgetError, OSError, ValueError):  # missing widget: render nothing
            return None

    return resolve


def render_widget_document(doc: dict[str, Any], *, today: date | None = None) -> Image.Image:
    """Composite a reusable widget document onto a transparent canvas."""
    size = doc.get("size") or {}
    width = max(1, int(size.get("width") or 600))
    height = max(1, int(size.get("height") or 300))
    canvas = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    for widget in doc.get("widgets") or []:
        if isinstance(widget, dict):
            _composite_widget(canvas, widget, today)
    return canvas


def _group_layer(
    widget: dict[str, Any],
    today: date | None,
    resolve_widget: Callable[[str], dict[str, Any] | None] | None,
) -> Image.Image | None:
    """Render a placed library widget, scaled into its box without distortion."""
    if resolve_widget is None:
        return None
    slug = str((widget.get("props") or {}).get("slug") or "")
    if not slug:
        return None
    doc = resolve_widget(slug)
    if not doc:
        return None
    image = render_widget_document(doc, today=today)
    box_width = max(1, float(widget.get("width") or image.width))
    box_height = max(1, float(widget.get("height") or image.height))
    scale = min(box_width / image.width, box_height / image.height)
    if abs(scale - 1) > 0.002:
        target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
        image = image.resize(target, Image.Resampling.LANCZOS)
    return image


def _design_size(props: dict[str, Any]) -> tuple[int, int]:
    design = props.get("design") if isinstance(props.get("design"), dict) else {}
    width = max(1, int(round(float(design.get("width") or 400))))
    height = max(1, int(round(float(design.get("height") or 400))))
    return width, height


def _fit_design(image: Image.Image, widget: dict[str, Any]) -> Image.Image:
    """Scale a design-space composite into the widget box, letterboxed."""
    box_width = max(1, int(round(float(widget.get("width") or image.width))))
    box_height = max(1, int(round(float(widget.get("height") or image.height))))
    scale = min(box_width / image.width, box_height / image.height)
    if abs(scale - 1) < 0.002:
        return image
    target = (max(1, round(image.width * scale)), max(1, round(image.height * scale)))
    return image.resize(target, Image.Resampling.LANCZOS)


def _composite_children(
    layers: list[dict[str, Any]],
    size: tuple[int, int],
    today: date | None,
    resolve_widget: Callable[[str], dict[str, Any] | None] | None,
) -> Image.Image:
    canvas = Image.new("RGBA", size, (0, 0, 0, 0))
    for child in layers:
        if isinstance(child, dict):
            _composite_widget(canvas, child, today, resolve_widget)
    return canvas


def _composite_layer(
    widget: dict[str, Any],
    today: date | None,
    resolve_widget: Callable[[str], dict[str, Any] | None] | None,
) -> Image.Image | None:
    """Render a ``shapeGroup`` (``<g>``) or a ``mask`` into box-sized pixels."""
    kind = widget.get("type")
    props = widget.get("props") if isinstance(widget.get("props"), dict) else {}
    layers = [item for item in (props.get("layers") or []) if isinstance(item, dict)]
    children = [item for item in layers if not item.get("hidden")]
    design = _design_size(props)

    if kind == "shapeGroup":
        group = _composite_children(children, design, today, resolve_widget)
        return _fit_design(group, widget)

    if len(children) < 2:
        # A mask needs a source plus content; fall back to plain layers.
        return _fit_design(_composite_children(children, design, today, resolve_widget), widget)

    base = Image.new("RGBA", design, (0, 0, 0, 0))
    _composite_widget(base, children[0], today, resolve_widget)
    content = _composite_children(children[1:], design, today, resolve_widget)
    base_alpha = base.getchannel("A")

    if props.get("invert"):
        # Hole punch: the cutting shape removes pixels from the content layer,
        # so the canvas below the mask shows through, live.
        inverse = base_alpha.point(lambda value: 255 - value)
        content.putalpha(ImageChops.multiply(content.getchannel("A"), inverse))
        return _fit_design(content, widget)

    content.putalpha(ImageChops.multiply(content.getchannel("A"), base_alpha))
    combined = Image.new("RGBA", design, (0, 0, 0, 0))
    combined.alpha_composite(base)
    combined.alpha_composite(content)
    return _fit_design(combined, widget)


def _glass_backplate(
    canvas: Image.Image,
    widget: dict[str, Any],
    opacity: float,
) -> None:
    """Blur whatever is already on the canvas under a calendar card.

    The browser twin is a CSS ``backdrop-filter`` on the widget node; both only
    run while the card is unrotated, because the blurred region is sampled from
    the canvas in the card's own (axis-aligned) box.
    """
    props = widget.get("props") if isinstance(widget.get("props"), dict) else {}
    width = max(1, int(round(float(widget.get("width") or 1))))
    height = max(1, int(round(float(widget.get("height") or 1))))
    left = round(float(widget.get("x", 0)))
    top = round(float(widget.get("y", 0)))
    from .widgets.calendar import calendar_design

    design = calendar_design(props)
    scale = min(width / design[0], height / design[1])
    card_width = max(1, round(design[0] * scale))
    card_height = max(1, round(design[1] * scale))
    offset_x = (width - card_width) // 2
    offset_y = (height - card_height) // 2

    crop = canvas.crop((left, top, left + width, top + height))
    try:
        blur = max(0.0, float(props.get("glassBlur") or 0)) * scale
    except (TypeError, ValueError):
        blur = 0.0
    blurred = crop.filter(ImageFilter.GaussianBlur(blur)) if blur > 0.35 else crop

    tint = parse_color(props.get("bg"), (0, 0, 0, 0))
    plate = blurred.copy()
    if tint[3] > 0:
        overlay = Image.new("RGBA", plate.size, (0, 0, 0, 0))
        radius = max(0.0, float(props.get("radius") or 0)) * scale
        ImageDraw.Draw(overlay).rounded_rectangle(
            (offset_x, offset_y, offset_x + card_width - 1, offset_y + card_height - 1),
            radius=min(radius, min(card_width, card_height) / 2),
            fill=tint,
        )
        plate.alpha_composite(overlay)

    mask = Image.new("L", plate.size, 0)
    ImageDraw.Draw(mask).rounded_rectangle(
        (offset_x, offset_y, offset_x + card_width - 1, offset_y + card_height - 1),
        radius=min(
            max(0.0, float(props.get("radius") or 0)) * scale,
            min(card_width, card_height) / 2,
        ),
        fill=255,
    )
    plate.putalpha(ImageChops.multiply(plate.getchannel("A"), mask))
    _apply_opacity(plate, opacity)
    _paste(canvas, plate, left, top)


def _composite_widget(
    canvas: Image.Image,
    widget: dict[str, Any],
    today: date | None,
    resolve_widget: Callable[[str], dict[str, Any] | None] | None = None,
) -> None:
    if widget.get("hidden"):
        return
    kind = widget.get("type")
    props = widget.get("props") if isinstance(widget.get("props"), dict) else {}
    opacity = max(0.0, min(1.0, float(widget.get("opacity", 1))))
    if opacity <= 0:
        return
    rotation = float(widget.get("rotation", 0) or 0) % 360

    glass = kind == "calendar" and bool(props.get("glass")) and rotation < 0.5
    if glass:
        # Paint the frosted plate onto the canvas first, then lay the crisp
        # contents over it; renders below this layer show through the tint.
        _glass_backplate(canvas, widget, opacity)
        layer = render_calendar(widget, today=today, card=False)
    elif kind == "text":
        layer = render_text(widget, today=today)
    elif kind == "calendar":
        layer = render_calendar(widget, today=today)
    elif kind == "sticker":
        layer = render_sticker(widget)
    elif kind == "shape":
        layer = render_shape(widget)
    elif kind in ("shapeGroup", "mask"):
        rendered = _composite_layer(widget, today, resolve_widget)
        if rendered is None:
            return
        layer = rendered
    elif kind == "group":
        layer = _group_layer(widget, today, resolve_widget)
        if layer is None:
            return
    else:
        return

    width = float(widget.get("width", 1))
    height = float(widget.get("height", 1))
    if rotation:
        # Pillow rotates counter-clockwise, CSS rotates clockwise.
        layer = layer.rotate(-rotation, resample=Image.Resampling.BICUBIC, expand=True)
    if not glass:
        layer = _apply_opacity(layer, opacity)
    left = round(float(widget.get("x", 0)) + width / 2 - layer.width / 2)
    top = round(float(widget.get("y", 0)) + height / 2 - layer.height / 2)
    _paste(canvas, layer, left, top)


def render_document(
    doc: dict[str, Any],
    *,
    base_path: Path | None = None,
    today: date | None = None,
    flatten: bool = True,
    widget_resolver: Callable[[str], dict[str, Any] | None] | None = None,
) -> Image.Image:
    """Composite a normalised preset document into a wallpaper image."""
    canvas_cfg = doc.get("canvas") or {}
    width = max(1, int(canvas_cfg.get("width") or 2560))
    height = max(1, int(canvas_cfg.get("height") or 1440))
    background = parse_color(canvas_cfg.get("background") or DEFAULT_BACKGROUND, (16, 16, 20, 255))
    canvas = Image.new("RGBA", (width, height), background)

    base = doc.get("base") or {}
    base_image = open_base_image(base, base_path)
    if base_image is not None and base.get("visible", True):
        box_width = max(1, int(round(float(base.get("width", width)))))
        box_height = max(1, int(round(float(base.get("height", height)))))
        if str(base.get("fit") or "cover") == "contain":
            fitted = _contain(base_image, box_width, box_height)
        else:
            fitted = _cover(base_image, box_width, box_height)
        if base.get("flipX"):
            fitted = fitted.transpose(Image.Transpose.FLIP_LEFT_RIGHT)
        if base.get("flipY"):
            fitted = fitted.transpose(Image.Transpose.FLIP_TOP_BOTTOM)
        fitted = _apply_opacity(fitted, max(0.0, min(1.0, float(base.get("opacity", 1)))))
        _paste(
            canvas,
            fitted,
            round(float(base.get("x", 0))),
            round(float(base.get("y", 0))),
        )

    for widget in doc.get("widgets") or []:
        if isinstance(widget, dict):
            _composite_widget(canvas, widget, today, widget_resolver)

    return canvas.convert("RGB") if flatten else canvas


def save_image(image: Image.Image, path: Path, quality: int = 92) -> Path:
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.suffix.lower() in (".png", ".webp"):
        image.save(path, optimize=True)
    else:
        image.save(path, "JPEG", quality=quality, subsampling=0, optimize=True)
    return path


def thumbnail(image: Image.Image, size: tuple[int, int] = (640, 360)) -> Image.Image:
    copy = image.copy()
    copy.thumbnail(size, Image.Resampling.LANCZOS)
    return copy
