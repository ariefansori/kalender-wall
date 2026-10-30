"""Reusable widget library.

Layout on disk::

    widgets/<slug>/widget.json

A widget is a small design canvas (``size``) with text, calendar and sticker
layers. Presets reference it with a single ``group`` layer, so one widget can be
designed once and placed in any number of wallpapers.
"""

from __future__ import annotations

import json
import shutil
import uuid
from datetime import datetime
from pathlib import Path
from typing import Any

from PIL import Image

from .config import PROJECT_ROOT, write_json_atomic
from .renderer import render_widget_document
from .renderer import thumbnail as make_thumbnail
from .schema import (
    SLUG_RE,
    PresetValidationError,
    normalize_widget_doc,
    slugify,
    unique_slug,
)

DOCUMENT_NAME = "widget.json"
THUMB_WIDTH = 440


class WidgetError(RuntimeError):
    """Raised for missing widgets or invalid widget operations."""


def _is_slug(value: object) -> bool:
    return isinstance(value, str) and bool(SLUG_RE.match(value))


class WidgetStore:
    def __init__(self, root: Path | None = None, thumbs_dir: Path | None = None):
        self.root = Path(root) if root else PROJECT_ROOT / "widgets"
        self.thumbs_dir = (
            Path(thumbs_dir) if thumbs_dir else Path.home() / ".cache" / "hyprwall" / "thumbs" / "widgets"
        )

    # -- paths -------------------------------------------------------------
    def widget_dir(self, slug: str) -> Path:
        if not _is_slug(slug):
            raise WidgetError(f"Invalid widget name: {slug!r}")
        directory = self.root / slug
        if directory.parent.resolve() != self.root.resolve():
            raise WidgetError("Invalid widget path")
        return directory

    def exists(self, slug: str) -> bool:
        try:
            return (self.widget_dir(slug) / DOCUMENT_NAME).is_file()
        except WidgetError:
            return False

    def thumbnail_path(self, slug: str) -> Path:
        return self.thumbs_dir / f"{slug}.png"

    # -- reading -----------------------------------------------------------
    def load(self, slug: str) -> dict[str, Any]:
        document = self.widget_dir(slug) / DOCUMENT_NAME
        if not document.is_file():
            raise WidgetError(f"Widget '{slug}' does not exist")
        try:
            raw = json.loads(document.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            raise WidgetError(f"Widget '{slug}' is unreadable: {exc}") from exc
        doc = normalize_widget_doc(raw, default_name=slug)
        doc["slug"] = slug
        doc["thumbnailUrl"] = f"/api/widgets/{slug}/thumbnail?v={int(document.stat().st_mtime)}"
        return doc

    def list(self) -> list[dict[str, Any]]:
        if not self.root.is_dir():
            return []
        items: list[dict[str, Any]] = []
        for directory in self.root.iterdir():
            if not directory.is_dir() or not _is_slug(directory.name):
                continue
            document = directory / DOCUMENT_NAME
            if not document.is_file():
                continue
            try:
                doc = self.load(directory.name)
            except WidgetError:
                continue
            items.append(
                {
                    "slug": directory.name,
                    "name": doc["name"],
                    "width": doc["size"]["width"],
                    "height": doc["size"]["height"],
                    "layerCount": len(doc["widgets"]),
                    "updatedAt": doc["updatedAt"],
                    "thumbnailUrl": doc["thumbnailUrl"],
                }
            )
        items.sort(key=lambda item: item["updatedAt"], reverse=True)
        return items

    # -- writing -----------------------------------------------------------
    def save(self, document: Any, *, original_slug: str | None = None) -> dict[str, Any]:
        try:
            doc = normalize_widget_doc(document)
        except PresetValidationError as exc:
            raise WidgetError(str(exc)) from exc

        if original_slug is not None:
            if not self.exists(original_slug):
                raise WidgetError(f"Widget '{original_slug}' does not exist")
            slug = original_slug
        else:
            taken = {item["slug"] for item in self.list()}
            slug = unique_slug(slugify(doc["name"]), taken)

        target = self.widget_dir(slug)
        target.mkdir(parents=True, exist_ok=True)
        document_path = target / DOCUMENT_NAME

        existing_created = None
        if document_path.is_file():
            try:
                existing_created = json.loads(
                    document_path.read_text(encoding="utf-8")
                ).get("createdAt")
            except (OSError, json.JSONDecodeError):
                existing_created = None
        if isinstance(existing_created, str):
            doc["createdAt"] = existing_created
        doc["updatedAt"] = datetime.now().astimezone().isoformat(timespec="seconds")

        write_json_atomic(document_path, doc)
        self.thumbnail_path(slug).unlink(missing_ok=True)
        return self.load(slug)

    def delete(self, slug: str) -> None:
        directory = self.widget_dir(slug)
        if not directory.is_dir():
            raise WidgetError(f"Widget '{slug}' does not exist")
        shutil.rmtree(directory)
        self.thumbnail_path(slug).unlink(missing_ok=True)

    # -- rendering ---------------------------------------------------------
    def render(self, slug: str) -> Image.Image:
        return render_widget_document(self.load(slug))

    def thumbnail(self, slug: str) -> Path:
        document = self.widget_dir(slug) / DOCUMENT_NAME
        if not document.is_file():
            raise WidgetError(f"Widget '{slug}' does not exist")
        cached = self.thumbnail_path(slug)
        if cached.is_file() and cached.stat().st_mtime >= document.stat().st_mtime:
            return cached
        image = self.render(slug)
        self.thumbs_dir.mkdir(parents=True, exist_ok=True)
        temporary = self.thumbs_dir / f".{slug}-{uuid.uuid4().hex[:6]}.png"
        make_thumbnail(image, (THUMB_WIDTH, THUMB_WIDTH)).save(temporary, "PNG", optimize=True)
        temporary.replace(cached)
        return cached

    # -- helpers -----------------------------------------------------------
    def resolve_name(self, value: str) -> str:
        if self.exists(value):
            return value
        lowered = value.strip().lower()
        for item in self.list():
            if item["name"].lower() == lowered:
                return item["slug"]
        raise WidgetError(f"No widget matches '{value}'")


__all__ = ["WidgetError", "WidgetStore"]
