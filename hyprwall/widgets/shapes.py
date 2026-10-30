"""Built-in SVG shape library.

Every shape is a single SVG path drawn in the universal ``0 0 100 100``
viewBox, so a shape can be scaled to any box without distortion.  The path data
is the single source of truth: the browser gets it from ``/api/config`` and
paints it with ``Path2D``, the compositor rasterises the same path with
cairosvg.

Shapes are filled and stroked with the layer's own colours.  ``line`` is a
stroke-only shape, so a fill would paint nothing; its defaults (and the
defaults returned by :func:`new_shape_props`) make it visible out of the box.
"""

from __future__ import annotations

import io
import math
from functools import lru_cache
from typing import Any

from PIL import Image

SHAPE_VIEWBOX = 100


def _points_to_path(points: list[tuple[float, float]]) -> str:
    commands = []
    for index, (x, y) in enumerate(points):
        commands.append(f"{'M' if index == 0 else 'L'}{round(x, 2)} {round(y, 2)}")
    return " ".join(commands) + " Z"


def _radial(
    count: int,
    radius: float,
    *,
    inner: float | None = None,
    start: float = -90.0,
    centre: tuple[float, float] = (50.0, 50.0),
) -> str:
    """Regular polygon (``inner`` None) or star with ``count`` points."""
    if inner is None:
        angles = [start + index * 360.0 / count for index in range(count)]
        points = [
            (
                centre[0] + radius * math.cos(math.radians(angle)),
                centre[1] + radius * math.sin(math.radians(angle)),
            )
            for angle in angles
        ]
        return _points_to_path(points)
    points = []
    for index in range(count * 2):
        angle = start + index * 180.0 / count
        length = radius if index % 2 == 0 else inner
        points.append(
            (
                centre[0] + length * math.cos(math.radians(angle)),
                centre[1] + length * math.sin(math.radians(angle)),
            )
        )
    return _points_to_path(points)


#: ``fill``: whether a fill is drawn by default, ``strokeWidth``: default width in
#: viewBox units (the same units as the 0–100 canvas, so it scales with the box).
SHAPES: dict[str, dict[str, Any]] = {
    "line": {
        "label": "Line",
        "d": "M6 50H94",
        "fill": False,
        "strokeWidth": 6,
    },
    "circle": {
        "label": "Circle",
        "d": "M4 50A46 46 0 1 0 96 50A46 46 0 1 0 4 50Z",
    },
    "square": {
        "label": "Square",
        "d": "M6 6H94V94H6Z",
    },
    "triangle": {
        "label": "Triangle",
        "d": "M50 6L95 92L5 92Z",
    },
    "pentagon": {
        "label": "Pentagon",
        "d": _radial(5, 46),
    },
    "hexagon": {
        "label": "Hexagon",
        "d": _radial(6, 46),
    },
    "octagon": {
        "label": "Octagon",
        "d": _radial(8, 46),
    },
    "star5": {
        "label": "Star 5-point",
        "d": _radial(5, 48, inner=19.5),
    },
    "star8": {
        "label": "Star 8-point",
        "d": _radial(8, 48, inner=27),
    },
    "heart": {
        "label": "Heart",
        "d": (
            "M50 92C20 72 6 54 6 36C6 20 18 8 32 8C41 8 47 13 50 18"
            "C53 13 59 8 68 8C82 8 94 20 94 36C94 54 80 72 50 92Z"
        ),
    },
    "shield": {
        "label": "Shield",
        "d": "M50 4L92 18V50C92 74 74 90 50 96C26 90 8 74 8 50V18Z",
    },
    "badge": {
        "label": "Badge / starburst",
        "d": _radial(16, 48, inner=41),
    },
    "bubble": {
        "label": "Speech bubble",
        "d": (
            "M50 8C24 8 6 22 6 40C6 58 24 72 50 72C56 72 62 71 67 69"
            "L86 84L82 65C90 58 94 49 94 40C94 22 76 8 50 8Z"
        ),
    },
}

DEFAULT_FILL = "#f4efe6"
DEFAULT_STROKE = "#00000000"


def shape_catalogue() -> list[dict[str, Any]]:
    """Public shape list sent to the browser in ``/api/config``."""
    return [
        {
            "id": shape_id,
            "label": shape["label"],
            "d": shape["d"],
            "fill": shape.get("fill", True),
            "strokeWidth": shape.get("strokeWidth", 0),
        }
        for shape_id, shape in SHAPES.items()
    ]


def is_shape(shape_id: object) -> bool:
    return isinstance(shape_id, str) and shape_id in SHAPES


def shape_label(shape_id: object) -> str:
    shape = SHAPES.get(shape_id) if isinstance(shape_id, str) else None
    return shape["label"] if shape else "Shape"


def new_shape_props(shape_id: str) -> dict[str, Any]:
    """Colours that make a freshly added shape visible."""
    shape = SHAPES.get(shape_id) or SHAPES["square"]
    filled = shape.get("fill", True)
    return {
        "shape": shape_id if shape_id in SHAPES else "square",
        "fill": DEFAULT_FILL if filled else DEFAULT_STROKE,
        "stroke": DEFAULT_STROKE if filled else DEFAULT_FILL,
        "strokeWidth": shape.get("strokeWidth", 0),
    }


def shape_svg(shape_id: str, fill: str, stroke: str, stroke_width: float) -> str:
    """One-shape SVG with the universal viewBox."""
    shape = SHAPES.get(shape_id) or SHAPES["square"]
    fill_attr = fill if fill and fill != "#00000000" else "none"
    stroke_attr = stroke if stroke and stroke != "#00000000" and stroke_width > 0 else "none"
    width = f'{round(float(stroke_width), 2)}' if stroke_attr != "none" else "0"
    return (
        '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100" '
        f'width="100" height="100" preserveAspectRatio="xMidYMid meet">'
        f'<path d="{shape["d"]}" fill="{fill_attr}" stroke="{stroke_attr}" '
        f'stroke-width="{width}" stroke-linejoin="round" stroke-linecap="round"/>'
        "</svg>"
    )


def render_shape(widget: dict[str, Any]) -> Image.Image:
    """Rasterise one shape into an RGBA layer sized to the widget box."""
    width = max(1, int(round(float(widget.get("width", 1)))))
    height = max(1, int(round(float(widget.get("height", 1)))))
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    props = widget.get("props") or {}
    shape_id = props.get("shape") if isinstance(props.get("shape"), str) else "square"
    fill = props.get("fill") if isinstance(props.get("fill"), str) else DEFAULT_FILL
    stroke = props.get("stroke") if isinstance(props.get("stroke"), str) else DEFAULT_STROKE
    try:
        stroke_width = max(0.0, min(40.0, float(props.get("strokeWidth") or 0)))
    except (TypeError, ValueError):
        stroke_width = 0.0
    try:
        png = shape_png(shape_id, fill, stroke, stroke_width, width, height)
    except Exception:  # noqa: BLE001 - a broken shape must not break the render
        return layer
    with Image.open(io.BytesIO(png)) as image:
        shaped = image.convert("RGBA")
    if shaped.size != layer.size:
        shaped = shaped.resize(layer.size, Image.Resampling.LANCZOS)
    layer.alpha_composite(shaped)
    return layer


@lru_cache(maxsize=48)
def shape_png(
    shape_id: str,
    fill: str,
    stroke: str,
    stroke_width: float,
    width: int,
    height: int,
) -> bytes:
    import cairosvg  # lazy: needs the system cairo library

    return cairosvg.svg2png(
        bytestring=shape_svg(shape_id, fill, stroke, stroke_width).encode("utf-8"),
        output_width=width,
        output_height=height,
    )


__all__ = [
    "DEFAULT_FILL",
    "DEFAULT_STROKE",
    "SHAPES",
    "SHAPE_VIEWBOX",
    "is_shape",
    "new_shape_props",
    "shape_catalogue",
    "shape_label",
    "render_shape",
    "shape_png",
    "shape_svg",
]
