"""Small colour helpers shared by every renderer.

Colours travel through presets as hex strings (``#rrggbb`` or ``#rrggbbaa``)
because exactly the same strings are fed to the HTML canvas and to Pillow.
"""

from __future__ import annotations

import re

RGBA = tuple[int, int, int, int]

_HEX_RE = re.compile(r"^#?([0-9a-fA-F]{3,8})$")
TRANSPARENT: RGBA = (0, 0, 0, 0)


def parse_color(value: object, default: RGBA | None = None) -> RGBA:
    """Parse ``#rgb``, ``#rgba``, ``#rrggbb``, ``#rrggbbaa`` or ``transparent``."""
    fallback = default if default is not None else (0, 0, 0, 255)
    if isinstance(value, (list, tuple)) and len(value) in (3, 4):
        try:
            channels = [max(0, min(255, int(c))) for c in value]
            if len(channels) == 3:
                channels.append(255)
            return channels[0], channels[1], channels[2], channels[3]  # type: ignore[return-value]
        except (TypeError, ValueError):
            return fallback
    if not isinstance(value, str):
        return fallback
    text = value.strip()
    if not text or text.lower() == "transparent":
        return TRANSPARENT
    match = _HEX_RE.match(text)
    if not match:
        return fallback
    digits = match.group(1)
    if len(digits) in (3, 4):
        digits = "".join(ch * 2 for ch in digits)
    if len(digits) == 6:
        digits += "ff"
    if len(digits) != 8:
        return fallback
    return (
        int(digits[0:2], 16),
        int(digits[2:4], 16),
        int(digits[4:6], 16),
        int(digits[6:8], 16),
    )


def to_hex(color: RGBA, with_alpha: bool = True) -> str:
    r, g, b, a = color
    base = f"#{r:02x}{g:02x}{b:02x}"
    return base if not with_alpha else f"{base}{a:02x}"


def is_transparent(color: RGBA) -> bool:
    return color[3] == 0


def with_alpha(color: RGBA, alpha: float) -> RGBA:
    return color[0], color[1], color[2], max(0, min(255, round(color[3] * alpha)))


def mix(first: RGBA, second: RGBA, ratio: float) -> RGBA:
    ratio = max(0.0, min(1.0, ratio))
    return (
        round(first[0] + (second[0] - first[0]) * ratio),
        round(first[1] + (second[1] - first[1]) * ratio),
        round(first[2] + (second[2] - first[2]) * ratio),
        round(first[3] + (second[3] - first[3]) * ratio),
    )


def readable_on(color: RGBA, light: RGBA = (250, 246, 238, 255), dark: RGBA = (18, 16, 14, 255)) -> RGBA:
    """Return a readable text colour for a background."""
    luminance = (0.299 * color[0] + 0.587 * color[1] + 0.114 * color[2]) / 255
    return dark if luminance > 0.6 else light


def hex_or(value: object, default: str) -> str:
    """Validate a hex colour string, returning ``default`` when invalid."""
    if isinstance(value, str) and (value.lower() == "transparent" or _HEX_RE.match(value.strip())):
        return value.strip()
    return default
