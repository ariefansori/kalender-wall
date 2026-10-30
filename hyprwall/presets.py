"""Preset storage.

Layout on disk::

    presets/<slug>/
    ├── base.jpg               # the wallpaper source, cropped to the base box
    ├── original-image.<ext>   # the untouched high-resolution upload
    └── widget.json            # layout + configuration

``base.jpg`` is never larger than the current canvas: uploaded images are
cropped to the base box aspect ratio and downscaled, while the original file is
kept next to it so the editor can re-crop it later.

Every document records the real pixel dimensions of that source
(``sourceWidth`` / ``sourceHeight``); the aspect ratio is derived from them on
the fly and compared with the canvas ratio when a preset is applied.
"""

from __future__ import annotations

import json
import shutil
import uuid
from collections.abc import Callable
from copy import deepcopy
from datetime import date, datetime
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from .config import (
    DEFAULT_CANVAS_HEIGHT,
    DEFAULT_CANVAS_WIDTH,
    PROJECT_ROOT,
    write_json_atomic,
)
from .renderer import group_resolver, render_document, save_image
from .renderer import thumbnail as make_thumbnail
from .schema import (
    SLUG_RE,
    UPLOAD_RE,
    PresetValidationError,
    normalize_preset,
    ratio_label,
    ratio_of,
    ratios_match,
    slugify,
    unique_slug,
)

DOCUMENT_NAME = "widget.json"
BASE_NAME = "base.jpg"
ORIGINAL_STEM = "original-image"
ORIGINAL_EXTENSIONS = (".jpg", ".jpeg", ".png", ".webp")
THUMB_SIZE = (720, 405)


class PresetError(RuntimeError):
    """Raised for missing presets or invalid preset operations."""


class PresetRatioError(PresetError):
    """Raised when a preset cannot be used at the current canvas ratio."""


def _is_slug(value: object) -> bool:
    return isinstance(value, str) and bool(SLUG_RE.match(value))


def _image_size(path: Path | None) -> tuple[int, int]:
    if not path or not path.is_file():
        return (0, 0)
    try:
        with Image.open(path) as image:
            return (image.width, image.height)
    except (OSError, ValueError):
        return (0, 0)


def scale_document(doc: dict[str, Any], width: int, height: int) -> dict[str, Any]:
    """Return a copy of ``doc`` composed for a ``width`` x ``height`` canvas.

    Widgets are scaled uniformly into the new canvas.  Composite layers keep
    their own design space (children are positioned inside it), so only the
    box of the composite moves; text sizes and letter spacing are scaled so the
    typography keeps its relative size.
    """
    canvas = doc.get("canvas") or {}
    old_width = max(1, int(canvas.get("width") or width))
    old_height = max(1, int(canvas.get("height") or height))
    if (old_width, old_height) == (int(width), int(height)):
        return doc

    scaled = deepcopy(doc)
    scale_x = width / old_width
    scale_y = height / old_height
    text_scale = (scale_x + scale_y) / 2

    def scale_layer(layer: dict[str, Any]) -> None:
        for key, factor in (
            ("x", scale_x),
            ("y", scale_y),
            ("width", scale_x),
            ("height", scale_y),
        ):
            value = layer.get(key)
            if isinstance(value, (int, float)):
                layer[key] = value * factor
        props = layer.get("props")
        if layer.get("type") == "text" and isinstance(props, dict):
            if isinstance(props.get("size"), (int, float)):
                props["size"] = props["size"] * text_scale
            if isinstance(props.get("letterSpacing"), (int, float)):
                props["letterSpacing"] = props["letterSpacing"] * text_scale

    base = scaled.get("base")
    if isinstance(base, dict):
        scale_layer(base)
    for widget in scaled.get("widgets") or []:
        if isinstance(widget, dict):
            scale_layer(widget)

    scaled["canvas"] = {
        **(scaled.get("canvas") or {}),
        "width": int(width),
        "height": int(height),
    }
    return scaled


def _crop_region(base: dict[str, Any], image_width: int, image_height: int) -> tuple[int, int, int, int]:
    """Region of the source image the base box shows (``cover`` crops it)."""
    if image_width <= 0 or image_height <= 0:
        return (0, 0, 0, 0)
    if str(base.get("fit") or "cover") == "contain":
        return (0, 0, image_width, image_height)
    try:
        box_aspect = float(base.get("width") or 1) / float(base.get("height") or 1)
    except (TypeError, ValueError, ZeroDivisionError):
        return (0, 0, image_width, image_height)
    if box_aspect <= 0:
        return (0, 0, image_width, image_height)
    image_aspect = image_width / image_height
    if box_aspect >= image_aspect:
        # The box is wider than the image: crop top and bottom.
        crop_height = max(1, min(image_height, round(image_width / box_aspect)))
        top = (image_height - crop_height) // 2
        return (0, top, image_width, top + crop_height)
    crop_width = max(1, min(image_width, round(image_height * box_aspect)))
    left = (image_width - crop_width) // 2
    return (left, 0, left + crop_width, image_height)


class PresetStore:
    def __init__(
        self,
        presets_dir: Path,
        thumbs_dir: Path | None = None,
        widgets_dir: Path | None = None,
        canvas: tuple[int, int] | None = None,
    ):
        self.root = Path(presets_dir)
        self.thumbs_dir = Path(thumbs_dir) if thumbs_dir else Path.home() / ".cache" / "hyprwall" / "thumbs"
        self.widgets_dir = Path(widgets_dir) if widgets_dir else PROJECT_ROOT / "widgets"
        width, height = canvas or (DEFAULT_CANVAS_WIDTH, DEFAULT_CANVAS_HEIGHT)
        self.canvas_width = max(1, int(width))
        self.canvas_height = max(1, int(height))

    # -- paths -------------------------------------------------------------
    def preset_dir(self, slug: str) -> Path:
        if not _is_slug(slug):
            raise PresetError(f"Invalid preset name: {slug!r}")
        directory = self.root / slug
        if directory.parent.resolve() != self.root.resolve():
            raise PresetError("Invalid preset path")
        return directory

    def exists(self, slug: str) -> bool:
        try:
            return (self.preset_dir(slug) / DOCUMENT_NAME).is_file()
        except PresetError:
            return False

    def base_path(self, slug: str) -> Path | None:
        path = self.preset_dir(slug) / BASE_NAME
        return path if path.is_file() else None

    def original_path(self, slug: str) -> Path | None:
        directory = self.preset_dir(slug)
        if not directory.is_dir():
            return None
        for path in sorted(directory.glob(f"{ORIGINAL_STEM}.*")):
            if path.is_file() and path.suffix.lower() in ORIGINAL_EXTENSIONS:
                return path
        return None

    # -- reading -----------------------------------------------------------
    def _read_document(self, slug: str) -> dict[str, Any]:
        document = self.preset_dir(slug) / DOCUMENT_NAME
        if not document.is_file():
            raise PresetError(f"Preset '{slug}' does not exist")
        try:
            raw = json.loads(document.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise PresetError(f"Preset '{slug}' is unreadable: {exc}") from exc
        doc = normalize_preset(raw, default_name=slug)
        self._fill_source_dimensions(doc, slug)
        return doc

    def _fill_source_dimensions(self, doc: dict[str, Any], slug: str) -> None:
        """Older documents have no dimensions: read them from the image."""
        if doc.get("sourceWidth") and doc.get("sourceHeight"):
            return
        width, height = _image_size(self.base_path(slug))
        if width and height:
            doc["sourceWidth"] = width
            doc["sourceHeight"] = height

    def _decorate(self, doc: dict[str, Any]) -> dict[str, Any]:
        """Add the derived ratio fields the UI needs (never written to disk)."""
        width = int(doc.get("sourceWidth") or 0)
        height = int(doc.get("sourceHeight") or 0)
        canvas = doc.get("canvas") or {}
        canvas_width = int(canvas.get("width") or self.canvas_width)
        canvas_height = int(canvas.get("height") or self.canvas_height)

        ratio = ratio_of(width, height) or ratio_of(canvas_width, canvas_height)
        target = ratio_of(self.canvas_width, self.canvas_height)
        doc["ratio"] = round(ratio, 6)
        doc["ratioLabel"] = ratio_label(width, height) if width and height else ratio_label(
            canvas_width, canvas_height
        )
        doc["canvasRatio"] = round(target, 6)
        doc["canvasRatioLabel"] = ratio_label(self.canvas_width, self.canvas_height)
        doc["ratioMatch"] = ratios_match(ratio, target)
        return doc

    def load(self, slug: str) -> dict[str, Any]:
        doc = self._decorate(self._read_document(slug))
        original = self.original_path(slug)
        doc["slug"] = slug
        doc["baseUrl"] = f"/api/presets/{slug}/asset/{BASE_NAME}" if self.base_path(slug) else None
        doc["originalUrl"] = f"/api/presets/{slug}/asset/{original.name}" if original else None
        doc["thumbnailUrl"] = f"/api/presets/{slug}/thumbnail"
        return doc

    def list(self) -> list[dict[str, Any]]:
        if not self.root.is_dir():
            return []
        items: list[dict[str, Any]] = []
        for directory in self.root.iterdir():
            if not directory.is_dir() or not _is_slug(directory.name):
                continue
            if not (directory / DOCUMENT_NAME).is_file():
                continue
            try:
                doc = self._decorate(self._read_document(directory.name))
            except PresetError:
                continue
            document_mtime = int((directory / DOCUMENT_NAME).stat().st_mtime)
            items.append(
                {
                    "slug": directory.name,
                    "name": doc["name"],
                    "theme": doc["theme"],
                    "width": doc["canvas"]["width"],
                    "height": doc["canvas"]["height"],
                    "sourceWidth": doc["sourceWidth"],
                    "sourceHeight": doc["sourceHeight"],
                    "ratio": doc["ratio"],
                    "ratioLabel": doc["ratioLabel"],
                    "ratioMatch": doc["ratioMatch"],
                    "canvasRatioLabel": doc["canvasRatioLabel"],
                    "widgetCount": len(doc["widgets"]),
                    "updatedAt": doc["updatedAt"],
                    "thumbnailUrl": f"/api/presets/{directory.name}/thumbnail?v={document_mtime}",
                    "baseUrl": f"/api/presets/{directory.name}/asset/{BASE_NAME}"
                    if (directory / BASE_NAME).is_file()
                    else None,
                }
            )
        items.sort(key=lambda item: item["updatedAt"], reverse=True)
        return items

    def stats(self) -> dict[str, Any]:
        presets = self.list()
        return {
            "total": len(presets),
            "light": sum(1 for item in presets if item["theme"] == "light"),
            "dark": sum(1 for item in presets if item["theme"] == "dark"),
            "matching": sum(1 for item in presets if item["ratioMatch"]),
            "canvas": {"width": self.canvas_width, "height": self.canvas_height},
        }

    # -- ratio -------------------------------------------------------------
    def mismatch_message(self, doc: dict[str, Any]) -> str:
        return (
            f"“{doc['name']}” is {doc['ratioLabel']}"
            f" ({doc.get('sourceWidth') or '?'}×{doc.get('sourceHeight') or '?'})"
            f" but the canvas is {ratio_label(self.canvas_width, self.canvas_height)}"
            f" ({self.canvas_width}×{self.canvas_height}). Open it in the editor,"
            " crop the image to the canvas and save it as a new preset."
        )

    def check_usable(self, slug: str) -> dict[str, Any]:
        """Load a preset for applying, refusing a canvas ratio mismatch."""
        doc = self.load(slug)
        if not doc["ratioMatch"]:
            raise PresetRatioError(self.mismatch_message(doc))
        return doc

    # -- writing -----------------------------------------------------------
    def save(
        self,
        document: Any,
        *,
        original_slug: str | None = None,
        upload_resolver: Callable[[str], Path | None] | None = None,
        base_source_slug: str | None = None,
    ) -> dict[str, Any]:
        try:
            doc = normalize_preset(document)
        except PresetValidationError as exc:
            raise PresetError(str(exc)) from exc

        if original_slug is not None:
            if not self.exists(original_slug):
                raise PresetError(f"Preset '{original_slug}' does not exist")
            slug = self._rename_if_needed(original_slug, doc["name"])
        else:
            taken = {item["slug"] for item in self.list()}
            slug = unique_slug(slugify(doc["name"]), taken)

        target = self.preset_dir(slug)
        target.mkdir(parents=True, exist_ok=True)
        base_path = target / BASE_NAME
        original_path = self.original_path(slug)

        token = str(doc["base"].get("file") or "")
        if token == BASE_NAME and not base_path.is_file() and base_source_slug:
            # "Save as new preset": the source image still lives in the preset
            # being adapted, so copy it (and its original) into the new folder.
            self._copy_base_from(base_source_slug, target)
            original_path = self.original_path(slug)
        if token.startswith("upload:"):
            upload_id = token.split(":", 1)[1]
            source = upload_resolver(upload_id) if UPLOAD_RE.match(token) and upload_resolver else None
            if source is None or not Path(source).is_file():
                raise PresetError("The uploaded image has expired; upload it again")
            self._import_base(doc, Path(source), target, original_path)
        elif token == BASE_NAME and base_path.is_file():
            self._optimise_base(doc, target, base_path, original_path)
        else:
            base_path.unlink(missing_ok=True)
            if original_path:
                original_path.unlink(missing_ok=True)
            doc["base"]["original"] = ""
            # No image means no source ratio of its own: the canvas is the source.
            doc["sourceWidth"] = doc["canvas"]["width"]
            doc["sourceHeight"] = doc["canvas"]["height"]

        if doc["base"].get("file") and base_path.is_file():
            doc["base"]["file"] = BASE_NAME
        else:
            doc["base"]["file"] = ""

        existing_created = None
        if (target / DOCUMENT_NAME).is_file():
            try:
                existing_created = json.loads(
                    (target / DOCUMENT_NAME).read_text(encoding="utf-8")
                ).get("createdAt")
            except (OSError, json.JSONDecodeError):
                existing_created = None
        if isinstance(existing_created, str):
            doc["createdAt"] = existing_created
        doc["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")

        write_json_atomic(target / DOCUMENT_NAME, doc)
        self.thumbnail_path(slug).unlink(missing_ok=True)
        return self.load(slug)

    def _copy_base_from(self, source_slug: str, target: Path) -> None:
        if not self.exists(source_slug) or source_slug == target.name:
            return
        source_dir = self.preset_dir(source_slug)
        source_base = source_dir / BASE_NAME
        if source_base.is_file():
            shutil.copyfile(source_base, target / BASE_NAME)
        for original in source_dir.glob(f"{ORIGINAL_STEM}.*"):
            if original.is_file() and original.suffix.lower() in ORIGINAL_EXTENSIONS:
                shutil.copyfile(original, target / original.name)

    def _rename_if_needed(self, original_slug: str, name: str) -> str:
        """Keep the folder slug in sync with the display name."""
        desired = slugify(name)
        if desired == original_slug:
            return original_slug
        taken = {item["slug"] for item in self.list() if item["slug"] != original_slug}
        slug = unique_slug(desired, taken)
        old_dir = self.preset_dir(original_slug)
        new_dir = self.preset_dir(slug)
        old_dir.rename(new_dir)
        self.thumbnail_path(original_slug).unlink(missing_ok=True)
        return slug

    def _write_original(self, source: Path, target: Path) -> Path:
        """Copy the untouched upload next to ``base.jpg``, keeping its format."""
        suffix = source.suffix.lower()
        if suffix not in ORIGINAL_EXTENSIONS:
            suffix = ".jpg"
        if suffix == ".jpeg":
            suffix = ".jpg"
        destination = target / f"{ORIGINAL_STEM}{suffix}"
        for stale in target.glob(f"{ORIGINAL_STEM}.*"):
            if stale != destination:
                stale.unlink(missing_ok=True)
        if source.resolve() != destination.resolve():
            shutil.copyfile(source, destination)
        return destination

    def _bake_base(self, doc: dict[str, Any], master: Path, base_path: Path) -> None:
        """Crop ``master`` to the base box aspect, downscale it, write base.jpg."""
        with Image.open(master) as raw:
            image = ImageOps.exif_transpose(raw).convert("RGB")
        base = doc["base"]
        region = _crop_region(base, image.width, image.height)
        cropped = image.crop(region) if region != (0, 0, image.width, image.height) else image
        source_width = max(1, cropped.width)
        source_height = max(1, cropped.height)

        existing_width, existing_height = _image_size(base_path)
        if existing_width and existing_height:
            same_aspect = (
                abs(existing_width / existing_height - source_width / source_height)
                / (source_width / source_height)
                < 0.002
            )
            small_enough = (
                existing_width <= self.canvas_width and existing_height <= self.canvas_height
            )
            if same_aspect and small_enough:
                # base.jpg already is the cropped, canvas-sized source: keep the
                # bytes (and the JPEG generation) untouched.
                doc["sourceWidth"] = source_width
                doc["sourceHeight"] = source_height
                return

        scale = min(
            1.0,
            self.canvas_width / source_width,
            self.canvas_height / source_height,
        )
        if scale < 0.999:
            cropped = cropped.resize(
                (max(1, round(source_width * scale)), max(1, round(source_height * scale))),
                Image.Resampling.LANCZOS,
            )
        save_image(cropped, base_path, quality=95)
        doc["sourceWidth"] = source_width
        doc["sourceHeight"] = source_height

    def _import_base(
        self, doc: dict[str, Any], source: Path, target: Path, existing_original: Path | None
    ) -> None:
        original = self._write_original(source, target)
        doc["base"]["original"] = original.name
        self._bake_base(doc, original, target / BASE_NAME)

    def _optimise_base(
        self,
        doc: dict[str, Any],
        target: Path,
        base_path: Path,
        original_path: Path | None,
    ) -> None:
        """Re-crop an already stored base, keeping its high-resolution source."""
        if original_path is None:
            width, height = _image_size(base_path)
            oversized = width > self.canvas_width or height > self.canvas_height
            # Presets saved before the original was kept: promote the full
            # resolution file before rewriting base.jpg.
            if oversized:
                original_path = self._write_original(base_path, target)
                doc["base"]["original"] = original_path.name
        master = original_path or base_path
        self._bake_base(doc, master, base_path)
        doc["base"]["original"] = original_path.name if original_path else ""

    def delete(self, slug: str) -> None:
        directory = self.preset_dir(slug)
        if not directory.is_dir():
            raise PresetError(f"Preset '{slug}' does not exist")
        shutil.rmtree(directory)
        self.thumbnail_path(slug).unlink(missing_ok=True)

    def restore_original(self, slug: str, uploads_dir: Path) -> dict[str, Any]:
        """Copy ``original-image`` into the upload cache for re-cropping.

        The editor replaces its base with the returned upload, so the next save
        re-crops the full-resolution image into ``base.jpg``.
        """
        original = self.original_path(slug)
        if original is None:
            raise PresetError("This preset has no original image stored")
        uploads_dir.mkdir(parents=True, exist_ok=True)
        upload_id = uuid.uuid4().hex
        extension = original.suffix.lower()
        if extension == ".jpeg":
            extension = ".jpg"
        destination = uploads_dir / f"{upload_id}{extension}"
        shutil.copyfile(original, destination)
        width, height = _image_size(destination)
        meta = {
            "id": upload_id,
            "filename": original.name,
            "width": width,
            "height": height,
            "extension": extension,
            "createdAt": int(datetime.now().timestamp()),
        }
        write_json_atomic(uploads_dir / f"{upload_id}.json", meta)
        return {**meta, "url": f"/api/uploads/{upload_id}/image"}

    # -- rendering ---------------------------------------------------------
    def render(
        self,
        slug: str,
        today: date | None = None,
        *,
        target: tuple[int, int] | None = None,
    ) -> Image.Image:
        doc = self.load(slug)
        if target:
            doc = scale_document(doc, target[0], target[1])
        return render_document(
            doc,
            base_path=self.base_path(slug),
            today=today,
            widget_resolver=group_resolver(self.widgets_dir),
        )

    def thumbnail_path(self, slug: str) -> Path:
        return self.thumbs_dir / f"{slug}.jpg"

    def thumbnail(self, slug: str) -> Path:
        document = self.preset_dir(slug) / DOCUMENT_NAME
        if not document.is_file():
            raise PresetError(f"Preset '{slug}' does not exist")
        cached = self.thumbnail_path(slug)
        newest_source = max(
            document.stat().st_mtime,
            (self.preset_dir(slug) / BASE_NAME).stat().st_mtime
            if (self.preset_dir(slug) / BASE_NAME).is_file()
            else 0,
        )
        if cached.is_file() and cached.stat().st_mtime >= newest_source:
            return cached
        image = self.render(slug)
        self.thumbs_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.thumbs_dir / f".{slug}-{uuid.uuid4().hex[:6]}.jpg"
        make_thumbnail(image, THUMB_SIZE).save(temporary, "JPEG", quality=86)
        temporary.replace(cached)
        return cached

    # -- helpers -----------------------------------------------------------
    def resolve_name(self, value: str) -> str:
        """Accept a slug or a display name (case insensitive)."""
        if self.exists(value):
            return value
        lowered = value.strip().lower()
        for item in self.list():
            if item["name"].lower() == lowered:
                return item["slug"]
        raise PresetError(f"No preset matches '{value}'")


__all__ = [
    "BASE_NAME",
    "DOCUMENT_NAME",
    "ORIGINAL_STEM",
    "PresetError",
    "PresetRatioError",
    "PresetStore",
    "scale_document",
]
