"""Calendar widget: three visual styles drawn with Pillow.

Styles are laid out in a fixed *design* coordinate space and scaled uniformly
to the widget box, which keeps typography proportional however the user resizes
the widget.  ``web/js/render/calendar.js`` is a line-for-line port.

Styles
------
``grid``     Month card: month title, weekday header, 7-column day grid.
``strip``    Wide two-row "filmstrip" of the month, big month abbreviation.
``minimal``  Vertical editorial card with an oversized day number.
"""

from __future__ import annotations

import calendar as calendar_module
import math
from datetime import date, datetime
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from ..colors import parse_color, with_alpha
from ..fonts import load_font, normalise_family, normalise_weight
from .text import measure_line

CALENDAR_DESIGNS: dict[str, tuple[int, int]] = {
    "grid": (880, 620),
    "strip": (1800, 320),
    "minimal": (520, 640),
}

#: Layout overrides that ignore the style's own design space: one row of days
#: (horizontal strip) or one column of days (vertical grid).  ``vertical`` is
#: built for the left screen edge (numbers outside, weekdays inside);
#: ``vertical-right`` mirrors the columns for the right edge.
CALENDAR_LAYOUTS: dict[str, tuple[int, int]] = {
    "horizontal": (1800, 280),
    "vertical": (420, 1240),
    "vertical-right": (420, 1240),
}

LAYOUT_NAMES = ("auto", "horizontal", "vertical", "vertical-right")

#: Widest horizontal gap the ``gap`` prop can pull the weekday column through.
MAX_DAY_GAP = 260.0

MONTHS = (
    "January",
    "February",
    "March",
    "April",
    "May",
    "June",
    "July",
    "August",
    "September",
    "October",
    "November",
    "December",
)
WEEKDAY_HEADERS = {
    0: ("SU", "MO", "TU", "WE", "TH", "FR", "SA"),
    1: ("MO", "TU", "WE", "TH", "FR", "SA", "SU"),
}
WEEKDAY_INITIALS = {
    0: ("S", "M", "T", "W", "T", "F", "S"),
    1: ("M", "T", "W", "T", "F", "S", "S"),
}


def resolve_date(value: object, today: date | None = None) -> date:
    """Accept ``YYYY-MM-DD`` (or ``None`` for "today")."""
    fallback = today or date.today()
    if isinstance(value, date):
        return value
    if isinstance(value, str) and len(value.strip()) == 10:
        try:
            return datetime.strptime(value.strip(), "%Y-%m-%d").date()
        except ValueError:
            return fallback
    return fallback


def calendar_design(props: dict[str, Any]) -> tuple[int, int]:
    """Design space a calendar widget is drawn in (layout wins over style)."""
    layout = str(props.get("layout") or "auto")
    if layout in CALENDAR_LAYOUTS:
        return CALENDAR_LAYOUTS[layout]
    style = str(props.get("style") or "grid")
    return CALENDAR_DESIGNS[style if style in CALENDAR_DESIGNS else "grid"]


def calendar_style(props: dict[str, Any]) -> dict[str, Any]:
    family = normalise_family(props.get("font"), "barlow-condensed")
    style = str(props.get("style") or "grid")
    if style not in CALENDAR_DESIGNS:
        style = "grid"
    layout = str(props.get("layout") or "auto")
    if layout not in CALENDAR_LAYOUTS:
        layout = "auto"
    week_start = 0 if str(props.get("weekStart", 1)) in ("0", "sun", "sunday") else 1
    return {
        "style": style,
        "layout": layout,
        "date": resolve_date(props.get("date")),
        "week_start": week_start,
        "font": family,
        "bg": parse_color(props.get("bg"), (0, 0, 0, 0)),
        "fg": parse_color(props.get("fg"), (245, 239, 230, 255)),
        "muted": parse_color(props.get("muted"), (138, 138, 138, 255)),
        "accent": parse_color(props.get("accent"), (226, 52, 43, 255)),
        "accent_text": parse_color(props.get("accentText"), (253, 246, 236, 255)),
        "show_title": bool(props.get("showTitle", True)),
        "show_weekdays": bool(props.get("showWeekdays", True)),
        "show_lines": bool(props.get("showLines", True)),
        "gap": max(0.0, min(MAX_DAY_GAP, float(props.get("gap", 0) or 0))),
        "radius": max(0.0, float(props.get("radius", 28))),
        "glass": bool(props.get("glass", False)),
        "glass_blur": max(0.0, min(80.0, float(props.get("glassBlur", 18) or 0))),
        "card": bool(props.get("__card", True)),
    }


class _Pen:
    """Draw with *design* coordinates; ``scale`` maps them to device pixels."""

    def __init__(self, draw: ImageDraw.ImageDraw, scale: float, offset: tuple[float, float], family: str):
        self.draw = draw
        self.scale = scale
        self.offset = offset
        self.family = family
        self._fonts: dict[tuple[int, int], ImageFont.FreeTypeFont] = {}

    def _font(self, size: float, weight: int) -> ImageFont.FreeTypeFont:
        px = max(1, int(round(size * self.scale)))
        key = (px, normalise_weight(self.family, weight))
        if key not in self._fonts:
            self._fonts[key] = load_font(self.family, key[1], key[0])
        return self._fonts[key]

    def _point(self, x: float, y: float) -> tuple[float, float]:
        return self.offset[0] + x * self.scale, self.offset[1] + y * self.scale

    def line_width(self, size: float, weight: int, text: str, spacing: float = 0.0) -> float:
        font = self._font(size, weight)
        return measure_line(font, text, spacing * self.scale) / self.scale

    def text(
        self,
        x: float,
        baseline: float,
        text: str,
        size: float,
        weight: int = 500,
        color: tuple[int, int, int, int] = (255, 255, 255, 255),
        spacing: float = 0.0,
        anchor: str = "left",
    ) -> None:
        if not text:
            return
        font = self._font(size, weight)
        gap = spacing * self.scale
        width = measure_line(font, text, gap)
        px, py = self._point(x, baseline)
        if anchor == "center":
            px -= width / 2
        elif anchor == "right":
            px -= width
        cursor = px
        for char in text:
            self.draw.text((cursor, py), char, font=font, fill=color, anchor="ls")
            cursor += font.getlength(char) + gap

    def rect(
        self,
        box: tuple[float, float, float, float],
        fill: tuple[int, int, int, int],
        radius: float = 0.0,
    ) -> None:
        if fill[3] == 0:
            return
        x0, y0, x1, y1 = box
        left, top = self._point(x0, y0)
        right, bottom = self._point(x1, y1)
        if right <= left or bottom <= top:
            return
        limit = min(right - left, bottom - top) / 2
        pixel_radius = min(radius * self.scale, limit)
        if pixel_radius <= 0:
            self.draw.rectangle((left, top, right, bottom), fill=fill)
        else:
            self.draw.rounded_rectangle(
                (left, top, right, bottom), radius=pixel_radius, fill=fill
            )

    def rule(
        self,
        x0: float,
        y0: float,
        x1: float,
        y1: float,
        fill: tuple[int, int, int, int],
        width: float = 1,
    ) -> None:
        if fill[3] == 0:
            return
        start = self._point(x0, y0)
        end = self._point(x1, y1)
        self.draw.line((start, end), fill=fill, width=max(1, int(round(width * self.scale))))


def _vertically_centred(size: float, centre: float) -> float:
    """Baseline that visually centres a cap-height glyph run on ``centre``."""
    return centre + size * 0.36


def _draw_grid(pen: _Pen, style: dict[str, Any]) -> None:
    design_w, design_h = CALENDAR_DESIGNS["grid"]
    pad = 46.0
    if style["card"]:
        pen.rect((0, 0, design_w, design_h), style["bg"], style["radius"])

    day = style["date"]
    # Python's calendar module uses Monday == 0; presets use 1 == Monday.
    first_weekday = calendar_module.MONDAY if style["week_start"] else calendar_module.SUNDAY
    weeks = calendar_module.Calendar(firstweekday=first_weekday).monthdayscalendar(
        day.year, day.month
    )
    weeks = [week for week in weeks if any(week)] or [[0] * 7]

    header_bottom = pad
    if style["show_title"]:
        pen.text(pad, pad + 52, MONTHS[day.month - 1].upper(), 62, 700, style["fg"], spacing=2.0)
        pen.text(
            design_w - pad,
            pad + 50,
            str(day.year),
            24,
            500,
            style["muted"],
            spacing=1.5,
            anchor="right",
        )
        pen.rule(pad, pad + 84, design_w - pad, pad + 84, with_alpha(style["fg"], 0.18))
        header_bottom = pad + 104

    top = header_bottom + (34 if style["show_weekdays"] else 10)
    if style["show_weekdays"]:
        cell_w = (design_w - pad * 2) / 7
        labels = WEEKDAY_HEADERS[style["week_start"]]
        for index, label in enumerate(labels):
            centre = pad + cell_w * (index + 0.5)
            pen.text(centre, header_bottom + 18, label, 18, 500, style["muted"], spacing=1.2, anchor="center")

    bottom = design_h - pad
    rows = len(weeks)
    cell_h = (bottom - top) / rows
    cell_w = (design_w - pad * 2) / 7
    number_size = min(cell_h * 0.46, 32.0)

    if style["show_lines"]:
        for row in range(1, rows):
            y = top + cell_h * row
            pen.rule(pad, y, design_w - pad, y, with_alpha(style["fg"], 0.10))

    for row, week in enumerate(weeks):
        centre_y = top + cell_h * (row + 0.5)
        for column, day_number in enumerate(week):
            if not day_number:
                continue
            centre_x = pad + cell_w * (column + 0.5)
            is_today = day_number == day.day
            if is_today:
                pill = min(cell_h * 0.72, 54.0)
                half = pill / 2
                pen.rect(
                    (centre_x - half, centre_y - half, centre_x + half, centre_y + half),
                    style["accent"],
                    radius=pill * 0.3,
                )
            pen.text(
                centre_x,
                _vertically_centred(number_size, centre_y),
                str(day_number),
                number_size,
                600,
                style["accent_text"] if is_today else style["fg"],
                spacing=0,
                anchor="center",
            )


def _draw_strip(pen: _Pen, style: dict[str, Any]) -> None:
    design_w, design_h = CALENDAR_DESIGNS["strip"]
    pad = 40.0
    if style["card"]:
        pen.rect((0, 0, design_w, design_h), style["bg"], style["radius"])

    day = style["date"]
    days_in_month = calendar_module.monthrange(day.year, day.month)[1]

    # Left block: label + oversized month abbreviation.
    if style["show_title"]:
        pen.text(pad, 62, f"CALENDAR · {day.year}", 20, 500, style["muted"], spacing=3.4)
        pen.text(pad - 4, 244, MONTHS[day.month - 1][:3].upper(), 190, 800, style["fg"], spacing=-1.0)
        pen.rect((pad, 264, pad + 116, 269), style["accent"], radius=1)
        days_left = 470.0
    else:
        days_left = pad

    if style["show_title"]:
        pen.rule(440, 28, 440, design_h - 28, with_alpha(style["fg"], 0.22))

    top, bottom = 26.0, design_h - 26
    rows = 2
    columns = math.ceil(days_in_month / rows)
    cell_w = (design_w - pad - days_left) / columns
    row_h = (bottom - top) / rows
    initials = WEEKDAY_INITIALS[style["week_start"]]

    if style["show_lines"]:
        pen.rule(days_left, top + row_h, design_w - pad, top + row_h, with_alpha(style["fg"], 0.14))

    for index in range(days_in_month):
        row, column = divmod(index, columns)
        number = index + 1
        centre_x = days_left + cell_w * (column + 0.5)
        row_top = top + row_h * row
        is_today = number == day.day

        if style["show_weekdays"]:
            weekday_index = (
                date(day.year, day.month, number).weekday() + 1 - style["week_start"]
            ) % 7
            pen.text(
                centre_x,
                row_top + 34,
                initials[weekday_index],
                17,
                500,
                style["muted"],
                spacing=1.2,
                anchor="center",
            )

        number_baseline = row_top + 96
        if is_today:
            half_w, half_h = 24.0, 25.0
            centre_y = number_baseline - 13.0
            pen.rect(
                (centre_x - half_w, centre_y - half_h, centre_x + half_w, centre_y + half_h),
                style["accent"],
                radius=8,
            )
        pen.text(
            centre_x,
            number_baseline,
            str(number),
            38,
            600,
            style["accent_text"] if is_today else style["fg"],
            anchor="center",
        )


def _draw_minimal(pen: _Pen, style: dict[str, Any]) -> None:
    design_w, design_h = CALENDAR_DESIGNS["minimal"]
    pad = 44.0
    if style["card"]:
        pen.rect((0, 0, design_w, design_h), style["bg"], style["radius"])

    day = style["date"]
    pen.text(pad, 78, calendar_module.day_name[day.weekday()].upper(), 20, 500, style["muted"], spacing=3.4)
    pen.text(pad - 6, 344, str(day.day), 290, 800, style["fg"], spacing=-2.0)
    if style["show_title"]:
        pen.text(pad, 414, MONTHS[day.month - 1].upper(), 38, 600, style["fg"], spacing=2.6)
        pen.rect((pad, 440, pad + 74, 444), style["accent"], radius=1)
        pen.text(pad, 498, f"{day.year} · MONTH {day.month:02d}", 22, 500, style["muted"], spacing=2.0)


def _draw_horizontal(pen: _Pen, style: dict[str, Any]) -> None:
    """One row of the month's days: weekday initial above the day number."""
    design_w, design_h = CALENDAR_LAYOUTS["horizontal"]
    pad = 22.0
    if style["card"]:
        pen.rect((0, 0, design_w, design_h), style["bg"], style["radius"])

    day = style["date"]
    days_in_month = calendar_module.monthrange(day.year, day.month)[1]
    left = pad
    if style["show_title"]:
        pen.text(pad, 118, MONTHS[day.month - 1][:3].upper(), 78, 800, style["fg"], -1.0)
        pen.text(pad, 152, str(day.year), 20, 500, style["muted"], 2.6)
        pen.rule(206, 24, 206, design_h - 24, with_alpha(style["fg"], 0.2))
        left = 224.0

    cell_w = (design_w - pad - left) / days_in_month
    centre_y = design_h / 2
    initials = WEEKDAY_INITIALS[style["week_start"]]
    accent_text = style["accent_text"]

    for index in range(days_in_month):
        number = index + 1
        centre_x = left + cell_w * (index + 0.5)
        is_today = number == day.day
        if style["show_weekdays"]:
            weekday_index = (
                date(day.year, day.month, number).weekday() + 1 - style["week_start"]
            ) % 7
            pen.text(
                centre_x,
                centre_y - 26,
                initials[weekday_index],
                16,
                500,
                style["muted"],
                1.0,
                anchor="center",
            )
        if is_today:
            half = min(cell_w * 0.42, 26.0)
            pen.rect(
                (centre_x - half, centre_y - 14, centre_x + half, centre_y + 40),
                style["accent"],
                radius=9,
            )
        pen.text(
            centre_x,
            centre_y + 30,
            str(number),
            30,
            600,
            accent_text if is_today else style["fg"],
            0,
            anchor="center",
        )


def _draw_vertical(pen: _Pen, style: dict[str, Any], *, mirrored: bool = False) -> None:
    """One column of the month's days.

    ``vertical`` puts the day numbers on the outer (left) edge and the weekday
    labels on the inner edge; ``vertical-right`` mirrors that so the numbers sit
    against the right screen edge.  ``gap`` pulls the weekday column towards the
    day numbers, which is the only direction with room to move — the numbers are
    already pinned to the outer edge.
    """

    design_w, design_h = CALENDAR_LAYOUTS["vertical-right" if mirrored else "vertical"]
    pad = 22.0
    if style["card"]:
        pen.rect((0, 0, design_w, design_h), style["bg"], style["radius"])

    day = style["date"]
    days_in_month = calendar_module.monthrange(day.year, day.month)[1]
    top = pad
    if style["show_title"]:
        pen.text(pad, 62, MONTHS[day.month - 1].upper(), 30, 700, style["fg"], 2.4)
        pen.text(design_w - pad, 58, str(day.year), 18, 500, style["muted"], 2.0, anchor="right")
        pen.rule(pad, 82, design_w - pad, 82, with_alpha(style["fg"], 0.18))
        top = 100.0

    bottom = design_h - pad
    row_h = (bottom - top) / days_in_month
    number_size = min(row_h * 0.56, 26.0)

    # Distance between the number column and the weekday column.
    gap = max(0.0, min(style["gap"], design_w - pad * 2 - 80))
    if mirrored:
        number_x, number_anchor = design_w - pad - 4, "right"
        label_x, label_anchor = pad + 4 + gap, "left"
    else:
        number_x, number_anchor = pad + 4, "left"
        label_x, label_anchor = design_w - pad - 4 - gap, "right"

    for index in range(days_in_month):
        number = index + 1
        centre_y = top + row_h * (index + 0.5)
        if style["show_lines"] and index:
            pen.rule(
                pad,
                top + row_h * index,
                design_w - pad,
                top + row_h * index,
                with_alpha(style["fg"], 0.1),
            )
        is_today = number == day.day
        if is_today:
            pen.rect(
                (pad - 6, centre_y - row_h * 0.5 + 2, design_w - pad + 6, centre_y + row_h * 0.5 - 2),
                style["accent"],
                radius=6,
            )
        pen.text(
            number_x,
            _vertically_centred(number_size, centre_y),
            str(number),
            number_size,
            600,
            style["accent_text"] if is_today else style["fg"],
            0,
            anchor=number_anchor,
        )
        if style["show_weekdays"]:
            weekday = date(day.year, day.month, number).weekday()
            pen.text(
                label_x,
                _vertically_centred(14, centre_y),
                calendar_module.day_abbr[weekday].upper(),
                14,
                500,
                style["accent_text"] if is_today else style["muted"],
                1.4,
                anchor=label_anchor,
            )


def _draw_vertical_right(pen: _Pen, style: dict[str, Any]) -> None:
    """Mirrored vertical grid for the right screen edge."""
    _draw_vertical(pen, style, mirrored=True)


_DRAWERS = {"grid": _draw_grid, "strip": _draw_strip, "minimal": _draw_minimal}
_LAYOUT_DRAWERS = {
    "horizontal": _draw_horizontal,
    "vertical": _draw_vertical,
    "vertical-right": _draw_vertical_right,
}


def render_calendar(widget: dict[str, Any], today: date | None = None, *, card: bool = True) -> Image.Image:
    """Render a calendar widget into an RGBA layer sized to the widget box.

    ``card=False`` skips the card's own background rectangle, which lets the
    compositor place a frosted-glass backplate underneath the contents.
    """
    width = max(1, int(round(float(widget.get("width", 1)))))
    height = max(1, int(round(float(widget.get("height", 1)))))
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    draw = ImageDraw.Draw(layer)

    props = dict(widget.get("props") or {})
    if today is not None and not props.get("date"):
        props["date"] = today.isoformat()
    props["__card"] = card
    style = calendar_style(props)
    if style["layout"] in _LAYOUT_DRAWERS:
        design_w, design_h = CALENDAR_LAYOUTS[style["layout"]]
        drawer = _LAYOUT_DRAWERS[style["layout"]]
    else:
        design_w, design_h = CALENDAR_DESIGNS[style["style"]]
        drawer = _DRAWERS[style["style"]]
    scale = min(width / design_w, height / design_h)
    offset = ((width - design_w * scale) / 2, (height - design_h * scale) / 2)

    drawer(_Pen(draw, scale, offset, style["font"]), style)
    return layer
