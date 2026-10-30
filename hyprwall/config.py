"""Configuration, paths and time-of-day theme rules for Kalender-Wall.

Everything is optionally overridable through ``~/.config/hyprwall/config.json``
and / or environment variables so the CLI keeps working from any working
directory (important for Hyprland autostart).
"""

from __future__ import annotations

import json
import os
import re
import uuid
from dataclasses import dataclass, field
from datetime import datetime, time
from pathlib import Path
from typing import Any

PROJECT_ROOT = Path(__file__).resolve().parent.parent
ASSETS_DIR = PROJECT_ROOT / "assets"
FONTS_DIR = ASSETS_DIR / "fonts"
STICKERS_DIR = ASSETS_DIR / "stickers"
WEB_DIR = PROJECT_ROOT / "web"

DEFAULT_CANVAS_WIDTH = 2560
DEFAULT_CANVAS_HEIGHT = 1440
DEFAULT_BACKGROUND = "#101014"
DEFAULT_OUTPUT = Path.home() / ".cache" / "current_wallpaper.jpg"
DEFAULT_DAY_START = "07:00"
DEFAULT_DAY_END = "19:00"
DEFAULT_CLOCK_THEME = "dark"
DEFAULT_WALLPAPER_BACKEND = "hyprland-caelestia"
CLOCK_THEMES = ("light", "dark")

#: Desktop wallpaper strategies the Options page can select.  The chosen one is
#: tried first; other detected backends remain as fallbacks.
WALLPAPER_BACKENDS: dict[str, dict[str, str]] = {
    "gnome": {
        "label": "GNOME",
        "detail": "gsettings org.gnome.desktop.background picture-uri",
    },
    "kde": {
        "label": "KDE Plasma",
        "detail": "plasma-apply-wallpaperimage <path>",
    },
    "hyprland": {
        "label": "Hyprland",
        "detail": "hyprpaper (hyprctl) with swww as fallback",
    },
    "hyprland-caelestia": {
        "label": "Hyprland + Caelestia",
        "detail": "caelestia wallpaper -f <path> + caelestia scheme set --mode <theme>",
    },
    "custom": {
        "label": "Custom command",
        "detail": "any command containing {path} (or {file})",
    },
}

#: Expanded to ``YYYYmmdd-HHMMSS`` when present in ``outputPath``.
TIMESTAMP_TOKEN = "{timestamp}"

CONFIG_ENV = "HYPRWALL_CONFIG"


class ConfigError(RuntimeError):
    """Raised when the user configuration file cannot be used."""


@dataclass
class Config:
    """Resolved runtime configuration."""

    presets_dir: Path = PROJECT_ROOT / "presets"
    widgets_dir: Path = PROJECT_ROOT / "widgets"
    cache_dir: Path = Path.home() / ".cache" / "hyprwall"
    output_path: Path = DEFAULT_OUTPUT
    apply_command: str | None = None
    day_start: time = time(7, 0)
    day_end: time = time(19, 0)
    canvas_width: int = DEFAULT_CANVAS_WIDTH
    canvas_height: int = DEFAULT_CANVAS_HEIGHT
    canvas_background: str = DEFAULT_BACKGROUND
    clock_theme: str = DEFAULT_CLOCK_THEME
    wallpaper_backend: str = DEFAULT_WALLPAPER_BACKEND
    caelestia_smart_scheme: bool = False
    caelestia_scheme: bool = True
    source: Path | None = None
    raw: dict[str, Any] = field(default_factory=dict, repr=False)

    # -- derived locations -------------------------------------------------
    @property
    def uploads_dir(self) -> Path:
        return self.cache_dir / "uploads"

    @property
    def thumbs_dir(self) -> Path:
        return self.cache_dir / "thumbs"

    @property
    def state_file(self) -> Path:
        return self.cache_dir / "state.json"

    # -- wallpaper files ---------------------------------------------------
    def wallpaper_path(self, moment: datetime | None = None) -> Path:
        """Return a fresh file name for the next composed wallpaper.

        Caelestia (Quickshell) caches images by source path, so re-writing the
        same file leaves the desktop showing the previous image.  Every render
        therefore gets its own timestamped file, and :func:`wallpaper.prune`
        removes the one it replaced.
        """
        stamp = (moment or datetime.now()).strftime("%Y%m%d-%H%M%S")
        configured = Path(self.output_path)
        if TIMESTAMP_TOKEN in str(configured):
            return Path(str(configured).replace(TIMESTAMP_TOKEN, stamp))
        suffix = configured.suffix or ".jpg"
        stem = configured.stem or "wallpaper"
        candidate = configured.with_name(f"{stem}-{stamp}{suffix}")
        if candidate.exists():
            # Two renders inside one second: keep the name unique regardless.
            candidate = configured.with_name(f"{stem}-{stamp}-{uuid.uuid4().hex[:4]}{suffix}")
        return candidate

    @property
    def output_pattern(self) -> str:
        """Human readable form of :meth:`wallpaper_path` for `/api/config`."""
        configured = Path(self.output_path)
        if TIMESTAMP_TOKEN in str(configured):
            return str(configured)
        suffix = configured.suffix or ".jpg"
        stem = configured.stem or "wallpaper"
        return str(configured.with_name(f"{stem}-<timestamp>{suffix}"))

    @property
    def default_canvas(self) -> dict[str, Any]:
        return {
            "width": self.canvas_width,
            "height": self.canvas_height,
            "background": self.canvas_background,
        }

    @property
    def canvas_ratio(self) -> float:
        return self.canvas_width / self.canvas_height if self.canvas_height else 0.0

    def ensure_dirs(self) -> None:
        for directory in (
            self.cache_dir,
            self.uploads_dir,
            self.thumbs_dir,
            self.presets_dir,
            self.widgets_dir,
        ):
            directory.mkdir(parents=True, exist_ok=True)

    def read_state(self) -> dict[str, Any]:
        try:
            return json.loads(self.state_file.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError):
            return {}

    def write_state(self, state: dict[str, Any]) -> None:
        write_json_atomic(self.state_file, state)

    # -- time of day -------------------------------------------------------
    def theme_for(self, moment: datetime | None = None) -> str:
        """Return ``light`` during the day window, ``dark`` otherwise."""
        moment = moment or datetime.now()
        now = moment.time()
        start, end = self.day_start, self.day_end
        if start <= end:
            return "light" if start <= now < end else "dark"
        # Window crosses midnight (e.g. 20:00 -> 06:00).
        return "light" if (now >= start or now < end) else "dark"


def parse_hhmm(value: str, fallback: time) -> time:
    """Parse ``"07:30"`` into :class:`datetime.time`."""
    try:
        hours, minutes = str(value).strip().split(":", 1)
        return time(int(hours) % 24, int(minutes) % 60)
    except (ValueError, AttributeError):
        return fallback


#: ``HH:MM`` as the Options page sends it (``7:05`` is accepted and normalised).
HHMM_RE = re.compile(r"^([01]?\d|2[0-3]):([0-5]\d)$")


def normalise_hhmm(value: Any, label: str) -> str:
    """Validate one schedule time and return it as ``HH:MM``."""
    text = str(value or "").strip()
    match = HHMM_RE.match(text)
    if not match:
        raise ConfigError(f"{label} must be a time like 07:00")
    return f"{int(match.group(1)):02d}:{match.group(2)}"


def _expand(value: str | os.PathLike[str]) -> Path:
    return Path(os.path.expandvars(os.path.expanduser(str(value))))


def config_path() -> Path:
    override = os.environ.get(CONFIG_ENV)
    if override:
        return _expand(override)
    base = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    return base / "hyprwall" / "config.json"


def load_config(path: Path | None = None) -> Config:
    """Load configuration from JSON + environment overrides."""
    config_file = _expand(path) if path else config_path()
    raw: dict[str, Any] = {}
    if config_file.exists():
        try:
            raw = json.loads(config_file.read_text(encoding="utf-8"))
            if not isinstance(raw, dict):
                raise ValueError("config root must be an object")
        except (OSError, ValueError) as exc:
            raise ConfigError(f"Cannot read {config_file}: {exc}") from exc

    theme_cfg = raw.get("theme") or {}
    wallpaper_cfg = raw.get("wallpaper") or {}
    canvas_cfg = raw.get("canvas") or {}

    presets_dir = _expand(
        os.environ.get("HYPRWALL_PRESETS_DIR")
        or raw.get("presetsDir")
        or (PROJECT_ROOT / "presets")
    )
    widgets_dir = _expand(
        os.environ.get("HYPRWALL_WIDGETS_DIR")
        or raw.get("widgetsDir")
        or (PROJECT_ROOT / "widgets")
    )
    cache_dir = _expand(
        os.environ.get("HYPRWALL_CACHE_DIR") or raw.get("cacheDir") or Path.home() / ".cache" / "hyprwall"
    )
    output_path = _expand(
        os.environ.get("HYPRWALL_OUTPUT") or raw.get("outputPath") or DEFAULT_OUTPUT
    )
    apply_command = os.environ.get("HYPRWALL_APPLY_COMMAND") or wallpaper_cfg.get("applyCommand")

    cfg = Config(
        presets_dir=presets_dir,
        widgets_dir=widgets_dir,
        cache_dir=cache_dir,
        output_path=output_path,
        apply_command=str(apply_command) if apply_command else None,
        day_start=parse_hhmm(
            os.environ.get("HYPRWALL_DAY_START") or theme_cfg.get("dayStart") or DEFAULT_DAY_START,
            time(7, 0),
        ),
        day_end=parse_hhmm(
            os.environ.get("HYPRWALL_DAY_END") or theme_cfg.get("dayEnd") or DEFAULT_DAY_END,
            time(19, 0),
        ),
        canvas_width=int(canvas_cfg.get("width") or DEFAULT_CANVAS_WIDTH),
        canvas_height=int(canvas_cfg.get("height") or DEFAULT_CANVAS_HEIGHT),
        canvas_background=str(canvas_cfg.get("background") or DEFAULT_BACKGROUND),
        clock_theme=str(raw.get("clockTheme") or DEFAULT_CLOCK_THEME)
        if str(raw.get("clockTheme") or DEFAULT_CLOCK_THEME) in CLOCK_THEMES
        else DEFAULT_CLOCK_THEME,
        wallpaper_backend=str(wallpaper_cfg.get("backend") or DEFAULT_WALLPAPER_BACKEND)
        if str(wallpaper_cfg.get("backend") or DEFAULT_WALLPAPER_BACKEND) in WALLPAPER_BACKENDS
        else DEFAULT_WALLPAPER_BACKEND,
        caelestia_smart_scheme=bool(wallpaper_cfg.get("caelestiaSmartScheme", False)),
        caelestia_scheme=bool(wallpaper_cfg.get("caelestiaScheme", True)),
        source=config_file if config_file.exists() else None,
        raw=raw,
    )
    cfg.ensure_dirs()
    return cfg


def save_options(values: dict[str, Any], path: Path | None = None) -> Config:
    """Validate and persist the Options page values, then reload the config.

    Unknown keys and unrelated settings in ``~/.config/hyprwall/config.json``
    are preserved; only ``canvas``, ``theme`` (the light/dark schedule),
    ``clockTheme`` and ``wallpaper`` change.
    """
    cfg = load_config(path)
    target = cfg.source or config_path()
    raw = dict(cfg.raw)
    raw.setdefault("presetsDir", str(cfg.presets_dir))
    raw.setdefault("widgetsDir", str(cfg.widgets_dir))
    raw.setdefault("cacheDir", str(cfg.cache_dir))
    raw.setdefault("outputPath", str(cfg.output_path))

    canvas = dict(raw.get("canvas") or {})
    for key, default in (("width", cfg.canvas_width), ("height", cfg.canvas_height)):
        if key not in values:
            canvas[key] = default
            continue
        try:
            number = int(round(float(values[key])))
        except (TypeError, ValueError) as exc:
            raise ConfigError(f"Canvas {key} must be a number") from exc
        if not 320 <= number <= 8192:
            raise ConfigError(f"Canvas {key} must be between 320 and 8192 pixels")
        canvas[key] = number
    canvas.setdefault("background", cfg.canvas_background)
    raw["canvas"] = canvas

    if "clockTheme" in values:
        theme = str(values["clockTheme"] or "").strip().lower()
        if theme not in CLOCK_THEMES:
            raise ConfigError("Clock theme must be light or dark")
        raw["clockTheme"] = theme

    if "theme" in values:
        schedule = values["theme"] if isinstance(values["theme"], dict) else {}
        theme_cfg = dict(raw.get("theme") or {})
        for key, current in (("dayStart", cfg.day_start), ("dayEnd", cfg.day_end)):
            if key not in schedule:
                theme_cfg[key] = current.strftime("%H:%M")
                continue
            label = "Light starts" if key == "dayStart" else "Dark starts"
            theme_cfg[key] = normalise_hhmm(schedule[key], label)
        if theme_cfg["dayStart"] == theme_cfg["dayEnd"]:
            raise ConfigError("Light and dark need different start times")
        raw["theme"] = theme_cfg

    wallpaper = dict(raw.get("wallpaper") or {})
    if "backend" in values:
        backend = str(values["backend"] or "").strip().lower()
        if backend not in WALLPAPER_BACKENDS:
            raise ConfigError(f"Unknown wallpaper backend: {backend!r}")
        wallpaper["backend"] = backend
    if "applyCommand" in values:
        command = str(values["applyCommand"] or "").strip()
        if len(command) > 500:
            raise ConfigError("The custom command is too long (max 500 characters)")
        wallpaper["applyCommand"] = command or None
    if "caelestiaScheme" in values:
        wallpaper["caelestiaScheme"] = bool(values["caelestiaScheme"])
    if str(wallpaper.get("backend") or "") == "custom" and not wallpaper.get("applyCommand"):
        raise ConfigError("A custom wallpaper command is required when the custom backend is selected")
    raw["wallpaper"] = wallpaper

    write_json_atomic(target, raw)
    return load_config(target)


def write_json_atomic(path: Path, payload: Any) -> None:
    """Write JSON through a temporary file so readers never see half a file."""
    import tempfile

    path.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.NamedTemporaryFile(
        "w", encoding="utf-8", dir=path.parent, prefix=f".{path.name}.", delete=False
    ) as handle:
        json.dump(payload, handle, indent=2, ensure_ascii=False)
        handle.write("\n")
        temp_name = handle.name
    os.replace(temp_name, path)
