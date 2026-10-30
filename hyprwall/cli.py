"""Command line interface.

``hyprwall apply`` is the autostart entry point: it picks a preset matching the
time of day, composites it to ``~/.cache/current_wallpaper.jpg`` and asks the
desktop to display it.
"""

from __future__ import annotations

import argparse
import json
import random
import sys
import tempfile
import time
from datetime import datetime
from pathlib import Path

from . import __version__
from .config import Config, ConfigError, load_config
from .presets import PresetError, PresetRatioError, PresetStore
from .schema import ALLOWED_THEMES, ratio_label
from .wallpaper import apply_wallpaper, candidate_backends, compose_preset, detect_backends
from .widgetstore import WidgetStore


class CliError(RuntimeError):
    pass


def _log(message: str, quiet: bool = False) -> None:
    if not quiet:
        print(message, flush=True)


def _store(cfg: Config) -> PresetStore:
    return PresetStore(
        cfg.presets_dir,
        cfg.thumbs_dir,
        cfg.widgets_dir,
        canvas=(cfg.canvas_width, cfg.canvas_height),
    )


def _parse_moment(value: str | None) -> datetime:
    if not value:
        return datetime.now()
    try:
        hours, minutes = value.split(":", 1)
        return datetime.now().replace(
            hour=int(hours) % 24, minute=int(minutes) % 60, second=0, microsecond=0
        )
    except (ValueError, AttributeError) as exc:
        raise CliError(f"Invalid --time '{value}', expected HH:MM") from exc


def _pick_random(
    store: PresetStore,
    theme: str,
    cfg: Config,
    seed: int | None,
    allow_fallback: bool,
) -> tuple[dict, bool]:
    presets = store.list()
    if not presets:
        raise CliError(
            f"No presets found in {store.root}. "
            "Create one with the web editor or add widget.json manually."
        )
    usable = [item for item in presets if item["ratioMatch"]]
    if not usable:
        raise CliError(
            f"None of the {len(presets)} presets match the {ratio_label(cfg.canvas_width, cfg.canvas_height)} "
            f"canvas ({cfg.canvas_width}×{cfg.canvas_height}). Open a preset in the editor, "
            "crop it to the canvas and save it as a new preset."
        )
    pool = [item for item in usable if item["theme"] == theme]
    fallback = False
    if not pool:
        if not allow_fallback:
            raise CliError(
                f"No '{theme}' presets available for this time of day. "
                "Save a preset with that theme, pass --theme, or use --allow-fallback."
            )
        pool = usable
        fallback = True

    if len(pool) > 1:
        previous = cfg.read_state().get("lastPreset")
        pool = [item for item in pool if item["slug"] != previous] or pool

    rng = random.Random(seed) if seed is not None else random.SystemRandom()
    return rng.choice(pool), fallback


def command_apply(args: argparse.Namespace) -> int:
    cfg = load_config()
    store = _store(cfg)
    moment = _parse_moment(args.time)
    requested_theme = args.theme or cfg.theme_for(moment)
    quiet = args.quiet

    stamp = moment.strftime("%Y-%m-%d %H:%M")
    window = f"{cfg.day_start.strftime('%H:%M')}–{cfg.day_end.strftime('%H:%M')}"
    _log(f"[hyprwall] {stamp} · time window {window} · theme {requested_theme}", quiet)

    if args.preset:
        slug = store.resolve_name(args.preset)
        doc = store.check_usable(slug)
        theme = doc["theme"]
        _log(
            f"[hyprwall] preset {slug} ({theme}, {doc['ratioLabel']}) selected by name",
            quiet,
        )
    else:
        picked, fallback = _pick_random(store, requested_theme, cfg, args.seed, args.allow_fallback)
        slug, theme = picked["slug"], picked["theme"]
        if fallback:
            _log(f"[hyprwall] no '{requested_theme}' presets, falling back to the whole library", quiet)
        _log(f"[hyprwall] preset {slug} ({theme}, {picked['ratioLabel']}) selected at random", quiet)

    explicit_output = Path(args.output).expanduser() if args.output else None
    output = explicit_output or cfg.wallpaper_path(moment)
    if args.dry_run:
        _log(f"[hyprwall] output: {output}", quiet)
        _log(f"[hyprwall] presets dir: {store.root}", quiet)
        _log(
            f"[hyprwall] canvas: {cfg.canvas_width}×{cfg.canvas_height} "
            f"({ratio_label(cfg.canvas_width, cfg.canvas_height)})",
            quiet,
        )
        _log(f"[hyprwall] wallpaper backend: {cfg.wallpaper_backend}", quiet)
        backends = detect_backends()
        _log(f"[hyprwall] apply backends: {', '.join(backends) or 'none detected'}", quiet)
        for candidate in candidate_backends(cfg, output):
            _log(f"[hyprwall]   {candidate['label']}: {' '.join(candidate['commands'][-1])}", quiet)
        _log("[hyprwall] dry run: nothing rendered or applied", quiet)
        return 0

    try:
        rendered = compose_preset(store, slug, cfg, output=output, prune=explicit_output is None)
    except PresetRatioError as exc:
        raise CliError(str(exc)) from exc
    except (OSError, PresetError) as exc:
        raise CliError(f"Could not render preset '{slug}': {exc}") from exc

    _log(
        f"[hyprwall] composed {cfg.canvas_width}×{cfg.canvas_height} "
        f"({ratio_label(cfg.canvas_width, cfg.canvas_height)}) → {rendered}",
        quiet,
    )

    state = cfg.read_state()
    state.update(
        {
            "lastPreset": slug,
            "lastTheme": theme,
            "lastRenderedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
            "output": str(rendered),
        }
    )
    cfg.write_state(state)

    if args.no_apply:
        _log("[hyprwall] --no-apply given, wallpaper left untouched", quiet)
        return 0

    retries = max(0, int(args.retry))
    attempt = 0
    while True:
        attempt += 1
        result = apply_wallpaper(rendered, cfg)
        if result.applied:
            _log(f"[hyprwall] {result.message}: {' '.join(result.command or [])}", quiet)
            state["lastBackend"] = result.backend
            state["lastApplyOk"] = True
            cfg.write_state(state)
            return 0
        if not result.attempts or attempt > retries:
            print(f"[hyprwall] {result.message}", file=sys.stderr, flush=True)
            state["lastApplyOk"] = False
            state["lastApplyError"] = result.message
            cfg.write_state(state)
            return 1
        _log(
            f"[hyprwall] apply attempt {attempt} failed ({result.attempts[-1].error}); "
            f"retrying in {args.retry_delay:g}s",
            quiet,
        )
        time.sleep(max(0.0, float(args.retry_delay)))


def command_list(args: argparse.Namespace) -> int:
    cfg = load_config()
    store = _store(cfg)
    presets = store.list()
    if args.theme:
        presets = [item for item in presets if item["theme"] == args.theme]
    if args.json:
        print(json.dumps(presets, indent=2))
        return 0
    if not presets:
        print(f"No presets in {store.root}")
        return 0
    print(f"{'SLUG':<24} {'THEME':<7} {'SIZE':<11} {'WIDGETS':<8} UPDATED")
    for item in presets:
        size = f"{item['width']}x{item['height']}"
        updated = item["updatedAt"].replace("T", " ")[:16]
        print(f"{item['slug']:<24} {item['theme']:<7} {size:<11} {item['widgetCount']:<8} {updated}")
    print(f"\n{len(presets)} preset(s) in {store.root}")
    return 0


def _check_writable(directory: Path) -> tuple[bool, str]:
    try:
        directory.mkdir(parents=True, exist_ok=True)
        with tempfile.NamedTemporaryFile(dir=directory, prefix=".hyprwall-check-", delete=True):
            pass
        return True, "writable"
    except OSError as exc:
        return False, str(exc)


def command_doctor(args: argparse.Namespace) -> int:
    cfg = load_config()
    store = _store(cfg)
    stats = store.stats()
    theme = cfg.theme_for()
    ok = True

    print(f"HyprWall {__version__}")
    print(f"  python          {sys.version.split()[0]}")
    try:
        import PIL

        print(f"  pillow          {PIL.__version__}")
    except ImportError:
        print("  pillow          MISSING")
        ok = False

    print(f"  presets dir     {store.root} ({stats['total']} presets, {stats['light']} light / {stats['dark']} dark)")
    print(
        f"  canvas          {cfg.canvas_width}×{cfg.canvas_height} "
        f"({ratio_label(cfg.canvas_width, cfg.canvas_height)}), "
        f"{stats['matching']} preset(s) match"
    )
    if stats["total"] == 0:
        ok = False

    widgets = WidgetStore(cfg.widgets_dir, cfg.thumbs_dir / "widgets")
    print(f"  widgets dir     {widgets.root} ({len(widgets.list())} reusable widgets)")

    writable, detail = _check_writable(cfg.output_path.parent)
    print(f"  output          {cfg.output_pattern} ({detail})")
    ok = ok and writable

    print(f"  config          {cfg.source or 'defaults (no ~/.config/hyprwall/config.json)'}")
    print(f"  theme window    {cfg.day_start.strftime('%H:%M')}–{cfg.day_end.strftime('%H:%M')} (now: {theme})")

    session = "Hyprland" if __import__("os").environ.get("HYPRLAND_INSTANCE_SIGNATURE") else "no Hyprland instance"
    wayland = __import__("os").environ.get("WAYLAND_DISPLAY", "not set")
    print(f"  session         {session}, WAYLAND_DISPLAY={wayland}")

    backends = detect_backends(cfg)
    print(f"  selected        {cfg.wallpaper_backend}")
    print(f"  apply backends  {', '.join(backends) if backends else 'none detected'}")
    if cfg.apply_command:
        print(f"  custom command  {cfg.apply_command}")
    if not backends and not cfg.apply_command:
        ok = False

    last_output = cfg.read_state().get("output")
    if isinstance(last_output, str):
        print(f"  last output     {last_output} ({'exists' if Path(last_output).is_file() else 'missing'})")

    print(f"  caelestia smart {'on' if cfg.caelestia_smart_scheme else 'off (passes -N)'}")
    return 0 if ok else 1


def command_serve(args: argparse.Namespace) -> int:
    try:
        import uvicorn
    except ImportError as exc:
        raise CliError("fastapi/uvicorn are not installed. Run: uv sync") from exc

    host = args.host
    display_host = "localhost" if host in ("127.0.0.1", "0.0.0.0") else host
    _log(f"HyprWall Studio → http://{display_host}:{args.port}")
    uvicorn.run("hyprwall.server:app", host=host, port=args.port, reload=args.reload)
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="hyprwall",
        description="Generate static calendar wallpapers from presets and apply them on Hyprland + Caelestia.",
    )
    parser.add_argument("--version", action="version", version=f"hyprwall {__version__}")
    subparsers = parser.add_subparsers(dest="command")

    apply_parser = subparsers.add_parser(
        "apply", help="compose a preset (random by time of day) and set it as wallpaper"
    )
    apply_parser.add_argument("--preset", "-p", help="preset slug or display name")
    apply_parser.add_argument("--theme", choices=ALLOWED_THEMES, help="force light or dark presets")
    apply_parser.add_argument("--time", help="simulate a time of day, HH:MM")
    apply_parser.add_argument("--seed", type=int, help="deterministic random selection")
    apply_parser.add_argument(
        "--output",
        help="write the image to this exact path instead of a timestamped file next to outputPath",
    )
    apply_parser.add_argument("--no-apply", action="store_true", help="render only, do not change the wallpaper")
    apply_parser.add_argument("--dry-run", action="store_true", help="show what would happen and exit")
    apply_parser.add_argument("--allow-fallback", action="store_true", help="use any preset if none match the theme")
    apply_parser.add_argument("--retry", type=int, default=0, help="retry applying N times (useful at login)")
    apply_parser.add_argument("--retry-delay", type=float, default=2.0, help="seconds between retries")
    apply_parser.add_argument("--quiet", "-q", action="store_true")
    apply_parser.set_defaults(func=command_apply)

    list_parser = subparsers.add_parser("list", help="list presets")
    list_parser.add_argument("--theme", choices=ALLOWED_THEMES)
    list_parser.add_argument("--json", action="store_true")
    list_parser.set_defaults(func=command_list)

    doctor_parser = subparsers.add_parser("doctor", help="check installation, presets and apply backends")
    doctor_parser.set_defaults(func=command_doctor)

    serve_parser = subparsers.add_parser("serve", help="run the web editor")
    serve_parser.add_argument("--host", default="127.0.0.1")
    serve_parser.add_argument("--port", type=int, default=8787)
    serve_parser.add_argument("--reload", action="store_true", help="reload on code changes (development)")
    serve_parser.set_defaults(func=command_serve)

    return parser


def main(argv: list[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)
    if not getattr(args, "func", None):
        parser.print_help()
        return 0
    try:
        return int(args.func(args))
    except CliError as exc:
        print(f"[hyprwall] {exc}", file=sys.stderr)
        return 2
    except ConfigError as exc:
        print(f"[hyprwall] configuration error: {exc}", file=sys.stderr)
        return 2
    except PresetError as exc:
        print(f"[hyprwall] {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        return 130


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
