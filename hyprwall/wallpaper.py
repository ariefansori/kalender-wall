"""Applying the composed wallpaper to the desktop.

Caelestia draws wallpapers itself through Quickshell, so the primary backend is
``caelestia wallpaper -f <file>``.  When ``caelestiaScheme`` is enabled (the
default) the shell's light/dark mode is also set to the preset's own theme:
``caelestia scheme set --mode dark`` for a dark preset, ``--mode light`` for a
light one.  hyprpaper and swww are supported as fallbacks, and any other setup
can be wired up with ``wallpaper.applyCommand`` in
``~/.config/hyprwall/config.json``.
"""

from __future__ import annotations

import re
import shlex
import shutil
import subprocess
from dataclasses import dataclass, field
from datetime import date
from pathlib import Path
from typing import Any

from .config import WALLPAPER_BACKENDS, Config
from .presets import PresetStore
from .renderer import save_image

COMMAND_TIMEOUT = 30

#: ``YYYYmmdd-HHMMSS`` plus an optional ``-a1b2`` collision suffix.
STAMP_PATTERN = r"\d{8}-\d{6}(?:-[0-9a-f]{4})?"
_STAMP_RE = re.compile(rf"^(?P<base>.+)-(?:{STAMP_PATTERN})$")


@dataclass
class Attempt:
    backend: str
    label: str
    commands: list[list[str]]
    ok: bool
    error: str | None = None
    output: str | None = None
    #: Follow-up steps (Caelestia's colour mode) that failed without undoing
    #: the wallpaper that was already applied.
    warnings: list[str] = field(default_factory=list)


@dataclass
class ApplyResult:
    applied: bool
    backend: str | None = None
    command: list[str] | None = None
    message: str = ""
    #: Steps that failed after the wallpaper itself was applied.
    warnings: list[str] = field(default_factory=list)
    attempts: list[Attempt] = field(default_factory=list)

    def to_dict(self) -> dict[str, Any]:
        return {
            "applied": self.applied,
            "backend": self.backend,
            "command": self.command,
            "message": self.message,
            "warnings": self.warnings,
            "attempts": [
                {
                    "backend": attempt.backend,
                    "label": attempt.label,
                    "ok": attempt.ok,
                    "error": attempt.error,
                    "warnings": attempt.warnings,
                }
                for attempt in self.attempts
            ],
        }


def _custom_commands(cfg: Config, path: Path) -> list[list[str]] | None:
    if not cfg.apply_command:
        return None
    try:
        tokens = shlex.split(cfg.apply_command)
    except ValueError:
        tokens = []
    if not tokens:
        return None
    has_placeholder = any("{path}" in token or "{file}" in token for token in tokens)
    command = [
        token.replace("{path}", str(path)).replace("{file}", str(path)) for token in tokens
    ]
    if not has_placeholder:
        command.append(str(path))
    return [command]


def _hyprpaper_commands(path: Path) -> list[list[str]]:
    if shutil.which("hyprctl"):
        return [
            ["hyprctl", "hyprpaper", "preload", str(path)],
            ["hyprctl", "hyprpaper", "wallpaper", f",{path}"],
        ]
    swww = shutil.which("swww")
    if swww:
        return [
            [
                swww,
                "img",
                str(path),
                "--transition-type",
                "fade",
                "--transition-duration",
                "1",
            ]
        ]
    return []


def _kde_commands(path: Path) -> list[list[str]]:
    plasma = shutil.which("plasma-apply-wallpaperimage")
    if plasma:
        return [[plasma, str(path)]]
    qdbus = shutil.which("qdbus6") or shutil.which("qdbus")
    if qdbus:
        script = (
            "var d = desktops(); for (i = 0; i < d.length; i++) { "
            'd[i].wallpaperPlugin = "org.kde.image"; '
            'd[i].currentConfigGroup = ["Wallpaper", "org.kde.image", "General"]; '
            f'd[i].writeConfig("Image", "{path}"); }}'
        )
        return [[qdbus, "org.kde.plasmashell", "/PlasmaShell", "org.kde.PlasmaShell.evaluateScript", script]]
    return []


def _gnome_commands(path: Path) -> list[list[str]]:
    gsettings = shutil.which("gsettings")
    if not gsettings:
        return []
    uri = path.resolve().as_uri()
    keys = ("picture-uri", "picture-uri-dark")
    return [
        [gsettings, "set", "org.gnome.desktop.background", key, uri] for key in keys
    ] + [[gsettings, "set", "org.gnome.desktop.background", "picture-options", "zoom"]]


def _caelestia_commands(cfg: Config, path: Path, theme: str | None = None) -> list[list[str]] | None:
    """Caelestia apply steps: set the wallpaper, then match the preset's mode.

    ``caelestia scheme set --mode dark|light`` makes the shell's colour scheme
    follow the preset theme, so a dark preset also puts Caelestia in dark mode
    (and a light preset in light mode).
    """
    caelestia = shutil.which("caelestia")
    if not caelestia:
        return None
    args = [caelestia, "wallpaper"]
    if not cfg.caelestia_smart_scheme:
        args.append("-N")  # do not derive a scheme from the image itself
    args += ["-f", str(path)]
    commands = [args]
    mode = theme if theme in ("light", "dark") else None
    if cfg.caelestia_scheme and mode:
        commands.append([caelestia, "scheme", "set", "--mode", mode])
    return commands


def build_candidate(backend: str, cfg: Config, path: Path, theme: str | None = None) -> dict[str, Any] | None:
    """One apply strategy for ``backend``, or ``None`` if it is unavailable."""
    if backend == "custom":
        commands = _custom_commands(cfg, path)
        return (
            {"backend": "custom", "label": "custom applyCommand", "commands": commands}
            if commands
            else None
        )
    if backend == "gnome":
        commands = _gnome_commands(path)
        return {"backend": "gnome", "label": "GNOME desktop", "commands": commands} if commands else None
    if backend == "kde":
        commands = _kde_commands(path)
        return {"backend": "kde", "label": "KDE Plasma", "commands": commands} if commands else None
    if backend == "hyprland":
        commands = _hyprpaper_commands(path)
        if not commands:
            return None
        return {
            "backend": "hyprpaper",
            "label": "Hyprland (hyprpaper/swww)",
            "commands": commands,
        }
    if backend == "hyprland-caelestia":
        commands = _caelestia_commands(cfg, path, theme)
        return {"backend": "caelestia", "label": "Caelestia shell", "commands": commands} if commands else None
    return None


def candidate_backends(cfg: Config, path: Path, theme: str | None = None) -> list[dict[str, Any]]:
    """Ordered apply strategies: the selected backend first, then fallbacks."""
    order = [cfg.wallpaper_backend] + [
        backend
        for backend in ("hyprland-caelestia", "hyprland", "kde", "gnome")
        if backend != cfg.wallpaper_backend
    ]
    candidates: list[dict[str, Any]] = []
    seen: set[str] = set()
    for backend in order:
        candidate = build_candidate(backend, cfg, path, theme)
        if not candidate or candidate["backend"] in seen:
            continue
        seen.add(candidate["backend"])
        candidates.append(candidate)
    return candidates


def backend_status(cfg: Config) -> list[dict[str, Any]]:
    """All selectable backends with availability, for the Options page."""
    status: list[dict[str, Any]] = []
    for backend, meta in WALLPAPER_BACKENDS.items():
        if backend == "custom":
            available = bool(cfg.apply_command)
        elif backend == "gnome":
            available = bool(shutil.which("gsettings"))
        elif backend == "kde":
            available = bool(
                shutil.which("plasma-apply-wallpaperimage")
                or shutil.which("qdbus6")
                or shutil.which("qdbus")
            )
        elif backend == "hyprland":
            available = bool(shutil.which("hyprctl") or shutil.which("swww"))
        else:
            available = bool(shutil.which("caelestia"))
        status.append(
            {
                "id": backend,
                "label": meta["label"],
                "detail": meta["detail"],
                "available": available,
                "selected": backend == cfg.wallpaper_backend,
            }
        )
    return status


def detect_backends(cfg: Config | None = None) -> list[str]:
    """Ids of the backends that are usable on this machine."""
    if cfg is None:
        from .config import ConfigError, load_config

        try:
            cfg = load_config()
        except ConfigError:
            cfg = Config()
    return [
        item["id"]
        for item in backend_status(cfg)
        if item["available"] and item["id"] != "custom"
    ]


def apply_wallpaper(path: Path, cfg: Config, theme: str | None = None) -> ApplyResult:
    """Put ``path`` on the desktop; ``theme`` also drives Caelestia's mode."""
    path = Path(path)
    if not path.is_file():
        return ApplyResult(applied=False, message=f"Wallpaper file not found: {path}")

    attempts: list[Attempt] = []
    for candidate in candidate_backends(cfg, path, theme):
        attempt = Attempt(
            backend=candidate["backend"], label=candidate["label"], commands=candidate["commands"], ok=True
        )
        for index, command in enumerate(candidate["commands"]):
            try:
                result = subprocess.run(
                    command,
                    capture_output=True,
                    text=True,
                    timeout=COMMAND_TIMEOUT,
                    check=False,
                )
            except (OSError, subprocess.TimeoutExpired) as exc:
                attempt.ok = False
                attempt.error = f"{command[0]}: {exc}"
                break
            if result.returncode != 0:
                detail = (result.stderr or result.stdout or "").strip().splitlines()
                failure = (
                    f"{' '.join(command)} exited {result.returncode}"
                    + (f": {detail[-1][:200]}" if detail else "")
                )
                if index == 0:
                    attempt.ok = False
                    attempt.error = failure
                    break
                # A follow-up step (setting Caelestia's light/dark mode) must not
                # undo the wallpaper that is already on screen.
                attempt.warnings.append(failure)
                continue
            attempt.output = (result.stdout or "").strip()[:400] or None
        attempts.append(attempt)
        if attempt.ok:
            return ApplyResult(
                applied=True,
                backend=attempt.backend,
                command=attempt.commands[0],
                message=f"Wallpaper applied via {attempt.label}",
                warnings=attempt.warnings,
                attempts=attempts,
            )

    if not attempts:
        message = (
            "No wallpaper backend found. Pick one on the Options page, install "
            "Caelestia / hyprpaper / swww, or set wallpaper.applyCommand in "
            "~/.config/hyprwall/config.json."
        )
    else:
        message = "Wallpaper rendered but could not be applied: " + "; ".join(
            f"{attempt.label}: {attempt.error}" for attempt in attempts if attempt.error
        )
    return ApplyResult(applied=False, message=message, attempts=attempts)


def prune_wallpapers(target: Path) -> list[Path]:
    """Delete earlier compositions of the wallpaper at ``target``.

    Only files that look like previous renders of the same target
    (``current_wallpaper-20261027-004500.jpg``) and its pre-timestamp name
    (``current_wallpaper.jpg``) are removed, so a shared cache directory keeps
    every unrelated file.
    """
    target = Path(target)
    directory = target.parent
    suffix = target.suffix or ".jpg"
    match = _STAMP_RE.match(target.stem)
    base = match.group("base") if match else target.stem
    if not directory.is_dir():
        return []

    stamp_re = re.compile(rf"^{re.escape(base)}-{STAMP_PATTERN}{re.escape(suffix)}$")
    legacy = f"{base}{suffix}"
    removed: list[Path] = []
    for entry in directory.iterdir():
        if entry.name == target.name or not entry.is_file():
            continue
        if entry.name != legacy and not stamp_re.match(entry.name):
            continue
        try:
            entry.unlink()
        except OSError:
            continue
        removed.append(entry)
    return removed


def compose_preset(
    store: PresetStore,
    slug: str,
    cfg: Config,
    *,
    output: Path | None = None,
    today: date | None = None,
    prune: bool = True,
) -> Path:
    """Render a preset and write it to a fresh wallpaper file.

    The file name carries a timestamp so wallpaper backends that cache images by
    path (Caelestia/Quickshell in particular) actually reload the new image.
    Previous compositions are deleted afterwards unless ``prune`` is false.
    """
    # Refuse a source ratio mismatch before rendering anything: the final image
    # must always be composed at the current canvas resolution and ratio.
    store.check_usable(slug)
    image = store.render(slug, today=today, target=(cfg.canvas_width, cfg.canvas_height))
    target = Path(output) if output else cfg.wallpaper_path()
    save_image(image, target)
    if prune:
        prune_wallpapers(target)
    return target
