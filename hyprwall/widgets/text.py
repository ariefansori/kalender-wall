"""Text widget rendering.

Layout is deliberately simple and deterministic so the browser canvas and
Pillow agree pixel for pixel: lines are wrapped greedily, every glyph is placed
individually (that is how letter spacing is applied) and baselines sit at a
fixed ratio of the font size instead of using engine specific metrics.
"""

from __future__ import annotations

import calendar
import re
from datetime import date
from typing import Any

from PIL import Image, ImageDraw, ImageFont

from ..colors import parse_color
from ..fonts import load_font, normalise_family, normalise_weight

# Distance from the top of a line box to the baseline, in em.
BASELINE_RATIO = 0.8

_MONTHS = (
    "January", "February", "March", "April", "May", "June",
    "July", "August", "September", "October", "November", "December",
)
_WEEKDAYS = ("Monday", "Tuesday", "Wednesday", "Thursday", "Friday", "Saturday", "Sunday")

# ``{day+1:02}`` / ``{if:weekday=Monday?Week start:...}`` pieces.
_VALUE_RE = re.compile(
    r"^(?P<name>[a-z_]+)(?P<offset>[+-]\d{1,4})?(?::(?P<fmt>[a-z0-9]{1,10}))?$"
)
_COND_RE = re.compile(
    r"^(?P<name>[a-z_]+)(?P<offset>[+-]\d{1,4})?\s*(?P<op>!=|>=|<=|=|>|<)\s*(?P<value>.+)$"
)
NUMERIC_RE = re.compile(r"^-?\d+(?:\.\d+)?$")


def _shift_months(day: date, months: int) -> date:
    index = day.year * 12 + (day.month - 1) + months
    year, month = divmod(index, 12)
    last = calendar.monthrange(year, month + 1)[1]
    return day.replace(year=year, month=month + 1, day=min(day.day, last))


def _shift_years(day: date, years: int) -> date:
    try:
        return day.replace(year=day.year + years)
    except ValueError:  # 29 February in a non-leap year
        return day.replace(year=day.year + years, day=28)


def _shifted_day(name: str, offset: int, day: date) -> date:
    """Apply a token offset in the unit that makes sense for ``name``."""
    if not offset:
        return day
    if name.startswith("month"):
        return _shift_months(day, offset)
    if name == "year":
        return _shift_years(day, offset)
    return date.fromordinal(day.toordinal() + offset)


def _raw_value(name: str, day: date) -> str | None:
    """Unformatted value of a date token, or ``None`` for unknown names."""
    if name == "day":
        return str(day.day)
    if name == "day_padded":
        return f"{day.day:02d}"
    if name == "month_number":
        return f"{day.month:02d}"
    if name == "month":
        return _MONTHS[day.month - 1]
    if name in ("month_short", "month_upper"):
        month = _MONTHS[day.month - 1]
        return month[:3] if name == "month_short" else month.upper()
    if name in ("weekday", "weekday_short"):
        weekday = _WEEKDAYS[day.weekday()]
        return weekday if name == "weekday" else weekday[:3].upper()
    if name == "year":
        return str(day.year)
    if name == "date":
        return day.isoformat()
    return None


def _format_value(name: str, value: str, fmt: str | None) -> str:
    if not fmt:
        return value
    if fmt == "upper":
        return value.upper()
    if fmt == "lower":
        return value.lower()
    if fmt == "short":
        if name.startswith("month") or name.startswith("weekday"):
            return value[:3]
        if name == "year":
            return value[-2:]
        return value
    if fmt in ("pad", "02", "2digit"):
        return value.zfill(2) if value.isdigit() else value
    return value


def _value_token(body: str, day: date) -> str | None:
    match = _VALUE_RE.match(body.strip())
    if not match:
        return None
    name = match.group("name")
    offset = int(match.group("offset") or 0)
    value = _raw_value(name, _shifted_day(name, offset, day))
    if value is None:
        return None
    return _format_value(name, value, match.group("fmt"))


def _split_top_level(text: str, separator: str) -> tuple[str, str] | None:
    """Split on ``separator`` outside nested ``{...}`` tokens."""
    depth = 0
    for index, char in enumerate(text):
        if char == "{":
            depth += 1
        elif char == "}":
            depth = max(0, depth - 1)
        elif char == separator and depth == 0:
            return text[:index], text[index + 1 :]
    return None


def _equals(left: str, right: str) -> bool:
    low_left = left.strip().lower()
    low_right = right.strip().lower()
    if low_left == low_right:
        return True
    # ``Mon`` / ``Oct`` style abbreviations match their full name.
    return len(low_right) == 3 and low_left.startswith(low_right)


def _compare(left: str, op: str, right: str) -> bool:
    if op in ("=", "!="):
        equal = _equals(left, right)
        return equal if op == "=" else not equal
    if NUMERIC_RE.match(left.strip()) and NUMERIC_RE.match(right.strip()):
        first, second = float(left), float(right)
    else:
        first, second = left.strip().lower(), right.strip().lower()
    if op == ">":
        return first > second
    if op == "<":
        return first < second
    if op == ">=":
        return first >= second
    return first <= second


def _expand_conditional(body: str, day: date) -> str | None:
    """``if:weekday=Monday?Week starts:Another day`` -> one of the branches."""
    question = _split_top_level(body, "?")
    if question is None:
        return None
    condition, branches = question
    match = _COND_RE.match(condition.strip())
    if not match:
        return None
    name = match.group("name")
    offset = int(match.group("offset") or 0)
    left = _raw_value(name, _shifted_day(name, offset, day))
    if left is None:
        return None
    split = _split_top_level(branches, ":")
    then_text, else_text = split if split else (branches, "")
    chosen = then_text if _compare(left, match.group("op"), match.group("value")) else else_text
    return expand_tokens(chosen, day)


def _expand_token(body: str, day: date) -> str:
    if body.startswith("if:"):
        expanded = _expand_conditional(body[3:], day)
        if expanded is not None:
            return expanded
        return "{" + body + "}"
    value = _value_token(body, day)
    if value is None:
        return "{" + body + "}"
    return value


def expand_tokens(text: str, day: date | None = None) -> str:
    """Replace date tokens with values for the render date.

    Tokens keep a title like ``{month}`` correct every day, even though the
    wallpaper is composed from a static preset. Beyond the plain names this
    understands offsets (``{day+1}``), formats (``{day:02}``, ``{month:upper}``,
    ``{year:short}``) and a compact conditional
    (``{if:weekday=Monday?Week starts:Another day}``). Unknown tokens are left
    exactly as written.
    """
    text = str(text or "")
    day = day or date.today()
    out: list[str] = []
    index = 0
    while index < len(text):
        char = text[index]
        if char != "{":
            out.append(char)
            index += 1
            continue
        depth = 0
        end = -1
        for cursor in range(index, len(text)):
            if text[cursor] == "{":
                depth += 1
            elif text[cursor] == "}":
                depth -= 1
                if depth == 0:
                    end = cursor
                    break
        if end < 0:
            out.append(text[index:])
            break
        out.append(_expand_token(text[index + 1 : end], day))
        index = end + 1
    return "".join(out)


def text_style(props: dict[str, Any]) -> dict[str, Any]:
    family = normalise_family(props.get("font"), "barlow")
    return {
        "text": str(props.get("text") or ""),
        "font": family,
        "weight": normalise_weight(family, props.get("weight", 600)),
        "size": max(4.0, float(props.get("size", 72))),
        "line_height": min(4.0, max(0.6, float(props.get("lineHeight", 1.15)))),
        "letter_spacing": float(props.get("letterSpacing", 0)),
        "align": props.get("align") if props.get("align") in ("left", "center", "right") else "left",
        "color": parse_color(props.get("color"), (245, 239, 230, 255)),
        "uppercase": bool(props.get("uppercase", False)),
    }


def _display_text(style: dict[str, Any]) -> str:
    text = style["text"].replace("\r\n", "\n")
    return text.upper() if style["uppercase"] else text


def measure_line(font: ImageFont.FreeTypeFont, text: str, letter_spacing: float) -> float:
    if not text:
        return 0.0
    width = sum(font.getlength(char) for char in text)
    return width + letter_spacing * (len(text) - 1)


def layout_lines(
    font: ImageFont.FreeTypeFont,
    text: str,
    max_width: float,
    letter_spacing: float,
) -> list[str]:
    """Greedy word wrap that also hard-breaks words wider than the box."""

    def width_of(candidate: str) -> float:
        return measure_line(font, candidate, letter_spacing)

    lines: list[str] = []
    for paragraph in text.split("\n"):
        if not paragraph:
            lines.append("")
            continue
        current = ""
        for word in paragraph.split(" "):
            trial = f"{current} {word}" if current else word
            if width_of(trial) <= max_width or not current:
                current = trial
                continue
            lines.append(current)
            while width_of(word) > max_width and len(word) > 1:
                cut = len(word)
                while cut > 1 and width_of(word[:cut]) > max_width:
                    cut -= 1
                lines.append(word[:cut])
                word = word[cut:]
            current = word
        lines.append(current)
    return lines


def block_height(style: dict[str, Any], line_count: int) -> float:
    return max(1, line_count) * style["size"] * style["line_height"]


def _line_origin(style: dict[str, Any], line_width: float, box_width: float) -> float:
    if style["align"] == "center":
        return max(0.0, (box_width - line_width) / 2)
    if style["align"] == "right":
        return max(0.0, box_width - line_width)
    return 0.0


def draw_line(
    draw: ImageDraw.ImageDraw,
    text: str,
    x: float,
    baseline: float,
    font: ImageFont.FreeTypeFont,
    fill: tuple[int, int, int, int],
    letter_spacing: float,
) -> None:
    cursor = x
    for char in text:
        draw.text((cursor, baseline), char, font=font, fill=fill, anchor="ls")
        cursor += font.getlength(char) + letter_spacing


def render_text(widget: dict[str, Any], today: date | None = None) -> Image.Image:
    """Render a ``text`` widget into its own RGBA layer."""
    width = max(1, int(round(float(widget.get("width", 1)))))
    height = max(1, int(round(float(widget.get("height", 1)))))
    layer = Image.new("RGBA", (width, height), (0, 0, 0, 0))
    style = text_style(widget.get("props") or {})
    style["text"] = expand_tokens(style["text"], today)
    text = _display_text(style)
    if not text.strip():
        return layer

    font = load_font(style["font"], style["weight"], int(round(style["size"])))
    lines = layout_lines(font, text, float(width), style["letter_spacing"])
    draw = ImageDraw.Draw(layer)
    line_step = style["size"] * style["line_height"]
    for index, line in enumerate(lines):
        if not line:
            continue
        line_width = measure_line(font, line, style["letter_spacing"])
        x = _line_origin(style, line_width, float(width))
        baseline = style["size"] * BASELINE_RATIO + index * line_step
        if baseline - style["size"] > height:
            break
        draw_line(draw, line, x, baseline, font, style["color"], style["letter_spacing"])
    return layer
