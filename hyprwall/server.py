"""FastAPI application serving the editor, the gallery and the REST API."""

from __future__ import annotations

import io
from contextlib import asynccontextmanager
from datetime import date, datetime
from pathlib import Path
from typing import Any

from fastapi import Body, FastAPI, File, HTTPException, UploadFile
from fastapi.responses import FileResponse, JSONResponse, Response
from fastapi.staticfiles import StaticFiles

from . import __version__
from .config import (
    ASSETS_DIR,
    CLOCK_THEMES,
    WALLPAPER_BACKENDS,
    WEB_DIR,
    Config,
    ConfigError,
    load_config,
    save_options,
)
from .presets import PresetError, PresetRatioError, PresetStore
from .renderer import group_resolver, render_document, render_widget_document
from .schema import (
    ALLOWED_THEMES,
    CALENDAR_DEFAULTS,
    RATIO_TOLERANCE,
    SHAPE_DEFAULTS,
    STICKER_DEFAULTS,
    TEXT_DEFAULTS,
    PresetValidationError,
    normalize_preset,
    normalize_widget_doc,
    ratio_label,
    slugify,
    theme_palette,
)
from .uploads import UploadError, cleanup_uploads, find_upload, save_upload
from .wallpaper import (
    apply_wallpaper,
    backend_status,
    compose_preset,
    detect_backends,
)
from .widgets.calendar import CALENDAR_DESIGNS, CALENDAR_LAYOUTS
from .widgets.shapes import shape_catalogue
from .widgets.sticker import list_stickers
from .widgetstore import WidgetError, WidgetStore

_CFG: Config | None = None


def config() -> Config:
    global _CFG
    if _CFG is None:
        _CFG = load_config()
    return _CFG


def reset_config_cache() -> None:
    """Used by tests after changing the environment."""
    global _CFG
    _CFG = None


def store() -> PresetStore:
    cfg = config()
    return PresetStore(
        cfg.presets_dir,
        cfg.thumbs_dir,
        cfg.widgets_dir,
        canvas=(cfg.canvas_width, cfg.canvas_height),
    )


def widget_store() -> WidgetStore:
    cfg = config()
    return WidgetStore(cfg.widgets_dir, cfg.thumbs_dir / "widgets")


@asynccontextmanager
async def lifespan(_: FastAPI):
    cleanup_uploads(config())
    yield


app = FastAPI(title="HyprWall Studio", version=__version__, lifespan=lifespan)


def _error(status: int, message: str) -> JSONResponse:
    return JSONResponse({"detail": message}, status_code=status)


def _simulated_date(value: Any) -> date | None:
    """``YYYY-MM-DD`` from the request, or ``None`` for the real today."""
    if not isinstance(value, str) or len(value) < 10:
        return None
    try:
        return date.fromisoformat(value[:10])
    except ValueError:
        return None


def _invalidate_preset_thumbnails() -> None:
    """Forget gallery thumbnails after a widget they may place changed."""
    for path in config().thumbs_dir.glob("*.jpg"):
        path.unlink(missing_ok=True)


@app.get("/", include_in_schema=False)
def index() -> FileResponse:
    return FileResponse(WEB_DIR / "index.html")


@app.get("/gallery", include_in_schema=False)
def gallery_page() -> FileResponse:
    return FileResponse(WEB_DIR / "gallery.html")


@app.get("/widgets", include_in_schema=False)
def widgets_page() -> FileResponse:
    return FileResponse(WEB_DIR / "widgets.html")


@app.get("/test", include_in_schema=False)
def test_page() -> FileResponse:
    return FileResponse(WEB_DIR / "test.html")


@app.get("/options", include_in_schema=False)
def options_page() -> FileResponse:
    return FileResponse(WEB_DIR / "options.html")


@app.get("/api/health")
def health() -> dict[str, Any]:
    return {"ok": True, "version": __version__}


@app.get("/api/config")
def api_config() -> dict[str, Any]:
    from .fonts import font_catalogue

    cfg = config()
    return {
        "version": __version__,
        "canvas": cfg.default_canvas,
        "canvasRatio": ratio_label(cfg.canvas_width, cfg.canvas_height),
        "clockTheme": cfg.clock_theme,
        "themes": list(ALLOWED_THEMES),
        "timeWindow": {
            "dayStart": cfg.day_start.strftime("%H:%M"),
            "dayEnd": cfg.day_end.strftime("%H:%M"),
            "theme": cfg.theme_for(datetime.now()),
        },
        "ratioTolerance": RATIO_TOLERANCE,
        "wallpaperBackend": cfg.wallpaper_backend,
        "applyCommand": cfg.apply_command,
        "presetsDir": str(cfg.presets_dir),
        "widgetsDir": str(cfg.widgets_dir),
        "outputPath": cfg.output_pattern,
        "fonts": font_catalogue(),
        "stickers": list_stickers(),
        "shapes": shape_catalogue(),
        "calendarStyles": [
            {"id": style, "width": size[0], "height": size[1]}
            for style, size in CALENDAR_DESIGNS.items()
        ],
        "calendarLayouts": [
            {"id": layout, "width": size[0], "height": size[1]}
            for layout, size in CALENDAR_LAYOUTS.items()
        ],
        "defaults": {
            "text": TEXT_DEFAULTS,
            "calendar": CALENDAR_DEFAULTS,
            "sticker": STICKER_DEFAULTS,
            "shape": SHAPE_DEFAULTS,
        },
        "palette": {"light": theme_palette("light"), "dark": theme_palette("dark")},
        "backends": detect_backends(cfg),
        "backendOptions": backend_status(cfg),
        "canvasSize": {"width": cfg.canvas_width, "height": cfg.canvas_height},
        "maxUploadMb": 40,
    }


@app.get("/api/options")
def api_options() -> dict[str, Any]:
    cfg = config()
    return {
        "canvas": {
            "width": cfg.canvas_width,
            "height": cfg.canvas_height,
            "background": cfg.canvas_background,
            "ratio": ratio_label(cfg.canvas_width, cfg.canvas_height),
        },
        "clockTheme": cfg.clock_theme,
        "themes": list(CLOCK_THEMES),
        "theme": {
            "dayStart": cfg.day_start.strftime("%H:%M"),
            "dayEnd": cfg.day_end.strftime("%H:%M"),
            "active": cfg.theme_for(datetime.now()),
            "activeAt": datetime.now().astimezone().isoformat(timespec="seconds"),
        },
        "wallpaper": {
            "backend": cfg.wallpaper_backend,
            "applyCommand": cfg.apply_command or "",
            "smartScheme": cfg.caelestia_smart_scheme,
            "outputPath": cfg.output_pattern,
            "backends": backend_status(cfg),
            "labels": WALLPAPER_BACKENDS,
        },
        "configFile": str(cfg.source or ""),
        "presetsDir": str(cfg.presets_dir),
        "widgetsDir": str(cfg.widgets_dir),
    }


@app.put("/api/options")
def api_save_options(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    canvas = payload.get("canvas") if isinstance(payload.get("canvas"), dict) else {}
    wallpaper = payload.get("wallpaper") if isinstance(payload.get("wallpaper"), dict) else {}
    values: dict[str, Any] = {}
    if "width" in canvas:
        values["width"] = canvas["width"]
    if "height" in canvas:
        values["height"] = canvas["height"]
    if "clockTheme" in payload:
        values["clockTheme"] = payload["clockTheme"]
    if isinstance(payload.get("theme"), dict):
        values["theme"] = payload["theme"]
    if "backend" in wallpaper:
        values["backend"] = wallpaper["backend"]
    if "applyCommand" in wallpaper:
        values["applyCommand"] = wallpaper["applyCommand"]
    try:
        save_options(values)
    except ConfigError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    reset_config_cache()
    return {"ok": True, "options": api_options()}


@app.get("/api/presets")
def api_presets() -> dict[str, Any]:
    presets = store()
    return {"presets": presets.list(), "stats": presets.stats()}


@app.post("/api/presets")
def api_create_preset(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    document = payload.get("preset")
    original = payload.get("originalSlug")
    if not isinstance(document, dict):
        raise HTTPException(status_code=400, detail="Missing preset document")
    cfg = config()
    base_from = payload.get("baseFromSlug")
    try:
        saved = store().save(
            document,
            original_slug=original if isinstance(original, str) else None,
            upload_resolver=lambda upload_id: find_upload(upload_id, cfg),
            base_source_slug=base_from if isinstance(base_from, str) else None,
        )
    except PresetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"preset": saved}


@app.get("/api/presets/{slug}")
def api_get_preset(slug: str) -> dict[str, Any]:
    try:
        return {"preset": store().load(slug)}
    except PresetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.put("/api/presets/{slug}")
def api_update_preset(slug: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    document = payload.get("preset")
    if not isinstance(document, dict):
        raise HTTPException(status_code=400, detail="Missing preset document")
    cfg = config()
    try:
        saved = store().save(
            document,
            original_slug=slug,
            upload_resolver=lambda upload_id: find_upload(upload_id, cfg),
        )
    except PresetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    return {"preset": saved}


@app.delete("/api/presets/{slug}")
def api_delete_preset(slug: str) -> dict[str, Any]:
    try:
        store().delete(slug)
    except PresetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"deleted": slug}


@app.get("/api/widgets")
def api_widgets() -> dict[str, Any]:
    widgets = widget_store()
    items = widgets.list()
    groups: dict[str, Any] = {}
    for item in items:
        try:
            groups[item["slug"]] = widgets.load(item["slug"])
        except WidgetError:
            continue
    return {"widgets": items, "groups": groups}


@app.post("/api/widgets")
def api_create_widget(payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    document = payload.get("widget")
    original = payload.get("originalSlug")
    if not isinstance(document, dict):
        raise HTTPException(status_code=400, detail="Missing widget document")
    try:
        saved = widget_store().save(
            document, original_slug=original if isinstance(original, str) else None
        )
    except WidgetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_preset_thumbnails()
    return {"widget": saved}


@app.post("/api/widgets/render")
def api_render_widget(payload: dict[str, Any] = Body(...)) -> Response:
    document = payload.get("widget")
    if not isinstance(document, dict):
        raise HTTPException(status_code=400, detail="Missing widget document")
    try:
        doc = normalize_widget_doc(document)
    except PresetValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    image = render_widget_document(doc)
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    filename = f"{slugify(doc['name'])}.png"
    return Response(
        content=buffer.getvalue(),
        media_type="image/png",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@app.get("/api/widgets/{slug}")
def api_widget(slug: str) -> dict[str, Any]:
    try:
        return {"widget": widget_store().load(slug)}
    except WidgetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc


@app.put("/api/widgets/{slug}")
def api_update_widget(slug: str, payload: dict[str, Any] = Body(...)) -> dict[str, Any]:
    document = payload.get("widget")
    if not isinstance(document, dict):
        raise HTTPException(status_code=400, detail="Missing widget document")
    try:
        saved = widget_store().save(document, original_slug=slug)
    except WidgetError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc
    _invalidate_preset_thumbnails()
    return {"widget": saved}


@app.delete("/api/widgets/{slug}")
def api_delete_widget(slug: str) -> dict[str, Any]:
    try:
        widget_store().delete(slug)
    except WidgetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    _invalidate_preset_thumbnails()
    return {"deleted": slug}


@app.get("/api/widgets/{slug}/thumbnail")
def api_widget_thumbnail(slug: str) -> FileResponse:
    try:
        path = widget_store().thumbnail(slug)
    except WidgetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not render thumbnail: {exc}") from exc
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-cache"})


@app.get("/api/presets/{slug}/thumbnail")
def api_thumbnail(slug: str) -> FileResponse:
    try:
        path = store().thumbnail(slug)
    except PresetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    except OSError as exc:
        raise HTTPException(status_code=500, detail=f"Could not render thumbnail: {exc}") from exc
    return FileResponse(path, media_type="image/jpeg", headers={"Cache-Control": "no-cache"})


@app.get("/api/presets/{slug}/asset/{filename}")
def api_preset_asset(slug: str, filename: str) -> FileResponse:
    try:
        directory = store().preset_dir(slug)
    except PresetError as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    if filename != Path(filename).name or filename.startswith("."):
        raise HTTPException(status_code=400, detail="Invalid asset name")
    path = directory / filename
    if not path.is_file():
        raise HTTPException(status_code=404, detail="Asset not found")
    return FileResponse(path)


@app.post("/api/presets/{slug}/original")
def api_restore_original(slug: str) -> dict[str, Any]:
    """Expose the stored ``original-image`` as a fresh upload for re-cropping."""
    cfg = config()
    try:
        upload = store().restore_original(slug, cfg.uploads_dir)
    except (PresetError, OSError) as exc:
        raise HTTPException(status_code=404, detail=str(exc)) from exc
    return {"upload": upload}


@app.post("/api/presets/{slug}/apply")
def api_apply_preset(slug: str) -> dict[str, Any]:
    cfg = config()
    presets = store()
    if not presets.exists(slug):
        raise HTTPException(status_code=404, detail=f"Preset '{slug}' does not exist")
    try:
        output = compose_preset(presets, slug, cfg)
    except PresetRatioError as exc:
        raise HTTPException(status_code=409, detail=str(exc)) from exc
    except (PresetError, OSError) as exc:
        raise HTTPException(status_code=500, detail=f"Could not compose wallpaper: {exc}") from exc
    result = apply_wallpaper(output, cfg)
    if result.applied:
        state = cfg.read_state()
        state.update(
            {
                "lastPreset": slug,
                "lastTheme": presets.load(slug)["theme"],
                "lastRenderedAt": datetime.now().astimezone().isoformat(timespec="seconds"),
                "lastBackend": result.backend,
                "lastApplyOk": True,
                "output": str(output),
            }
        )
        cfg.write_state(state)
    return {
        "ok": True,
        "preset": slug,
        "output": str(output),
        "outputSize": output.stat().st_size,
        "apply": result.to_dict(),
    }


@app.post("/api/render")
def api_render(payload: dict[str, Any] = Body(...)) -> Response:
    """Render the current editor draft to PNG (used for export / checks)."""
    document = payload.get("preset")
    if not isinstance(document, dict):
        raise HTTPException(status_code=400, detail="Missing preset document")
    try:
        doc = normalize_preset(document)
    except PresetValidationError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc

    cfg = config()
    base_path: Path | None = None
    token = str((doc.get("base") or {}).get("file") or "")
    if token.startswith("upload:"):
        base_path = find_upload(token.split(":", 1)[1], cfg)
    elif token == "base.jpg" and isinstance(payload.get("presetSlug"), str):
        try:
            base_path = store().base_path(payload["presetSlug"])
        except PresetError:
            base_path = None

    today = _simulated_date(payload.get("date"))
    image = render_document(
        doc,
        base_path=base_path,
        today=today,
        widget_resolver=group_resolver(config().widgets_dir),
    )
    buffer = io.BytesIO()
    image.save(buffer, "PNG", optimize=True)
    filename = f"{slugify(doc['name'])}.png"
    return Response(
        content=buffer.getvalue(),
        media_type="image/png",
        headers={"Content-Disposition": f'inline; filename="{filename}"'},
    )


@app.post("/api/uploads")
async def api_upload(file: UploadFile = File(...)) -> dict[str, Any]:
    data = await file.read()
    try:
        return save_upload(data, file.filename or "base.jpg", config())
    except UploadError as exc:
        raise HTTPException(status_code=400, detail=str(exc)) from exc


@app.get("/api/uploads/{upload_id}/image")
def api_upload_image(upload_id: str) -> FileResponse:
    path = find_upload(upload_id, config())
    if not path:
        raise HTTPException(status_code=404, detail="Upload not found")
    return FileResponse(path)


@app.get("/api/stickers")
def api_stickers() -> list[dict[str, Any]]:
    return list_stickers()


@app.exception_handler(PresetError)
def preset_error_handler(_, exc: PresetError) -> JSONResponse:  # pragma: no cover
    return JSONResponse({"detail": str(exc)}, status_code=400)


app.mount("/static", StaticFiles(directory=WEB_DIR), name="static")
app.mount("/assets", StaticFiles(directory=ASSETS_DIR), name="assets")


@app.get("/favicon.ico", include_in_schema=False)
def favicon() -> FileResponse:
    return FileResponse(WEB_DIR / "favicon.svg", media_type="image/svg+xml")


if __name__ == "__main__":  # pragma: no cover
    import uvicorn

    uvicorn.run("hyprwall.server:app", host="127.0.0.1", port=8787)
