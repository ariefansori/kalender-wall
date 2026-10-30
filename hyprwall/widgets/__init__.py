"""Widget renderers (Pillow side).

Each renderer returns an RGBA layer the size of the widget box.  The browser
editor mirrors these draw routines in ``web/js/render`` so the preview matches
the composited wallpaper.
"""

from .calendar import CALENDAR_DESIGNS, CALENDAR_LAYOUTS, render_calendar
from .shapes import render_shape, shape_catalogue
from .sticker import render_sticker
from .text import BASELINE_RATIO, expand_tokens, render_text

__all__ = [
    "BASELINE_RATIO",
    "CALENDAR_DESIGNS",
    "CALENDAR_LAYOUTS",
    "expand_tokens",
    "render_calendar",
    "render_shape",
    "render_sticker",
    "render_text",
    "shape_catalogue",
]
