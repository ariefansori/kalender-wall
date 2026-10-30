"""Temporary storage for base images uploaded from the editor.

An uploaded image is normalised (EXIF orientation baked in, metadata dropped)
and kept in ``<cache>/uploads``.  Presets copy the image they use into their own
folder, so uploads can safely expire.
"""

from __future__ import annotations

import io
import time
import uuid
from pathlib import Path

from PIL import Image, ImageOps

from .config import Config, write_json_atomic

MAX_UPLOAD_BYTES = 40 * 1024 * 1024
UPLOAD_EXTENSIONS = {".jpg", ".jpeg", ".png", ".webp"}
FORMAT_EXTENSIONS = {"JPEG": ".jpg", "PNG": ".png", "WEBP": ".webp"}


class UploadError(ValueError):
    """Raised when an uploaded file is not a usable image."""


def _open(data: bytes) -> Image.Image:
    try:
        image = Image.open(io.BytesIO(data))
        image.load()
    except Exception as exc:  # Pillow raises a variety of errors
        raise UploadError("File is not a readable image") from exc
    # Bake in the EXIF orientation but keep the original format for re-encoding.
    ImageOps.exif_transpose(image, in_place=True)
    return image


def save_upload(data: bytes, filename: str, cfg: Config) -> dict:
    if not data:
        raise UploadError("Empty upload")
    if len(data) > MAX_UPLOAD_BYTES:
        raise UploadError("Image is larger than 40 MB")

    image = _open(data)
    fmt = (image.format or "PNG").upper()
    extension = FORMAT_EXTENSIONS.get(fmt, "")
    if not extension:
        raise UploadError("Use a JPEG, PNG or WebP image")

    upload_id = uuid.uuid4().hex
    target = cfg.uploads_dir / f"{upload_id}{extension}"
    cfg.uploads_dir.mkdir(parents=True, exist_ok=True)
    if extension == ".png":
        image.save(target, "PNG", optimize=True)
    elif extension == ".webp":
        image.save(target, "WEBP", quality=95, method=4)
    else:
        image.convert("RGB").save(target, "JPEG", quality=95, subsampling=0)

    meta = {
        "id": upload_id,
        "filename": Path(filename or "base").name[:120],
        "width": image.width,
        "height": image.height,
        "extension": extension,
        "createdAt": int(time.time()),
    }
    write_json_atomic(cfg.uploads_dir / f"{upload_id}.json", meta)
    return {**meta, "url": f"/api/uploads/{upload_id}/image"}


def find_upload(upload_id: str, cfg: Config) -> Path | None:
    if not isinstance(upload_id, str) or len(upload_id) != 32:
        return None
    if any(ch not in "0123456789abcdef" for ch in upload_id):
        return None
    for path in cfg.uploads_dir.glob(f"{upload_id}.*"):
        if path.suffix.lower() in UPLOAD_EXTENSIONS:
            return path
    return None


def cleanup_uploads(cfg: Config, max_age_days: int = 7) -> int:
    """Drop stale uploads so the cache does not grow forever."""
    if not cfg.uploads_dir.is_dir():
        return 0
    cutoff = time.time() - max_age_days * 86400
    removed = 0
    for path in cfg.uploads_dir.iterdir():
        try:
            if path.is_file() and path.stat().st_mtime < cutoff:
                path.unlink()
                removed += 1
        except OSError:
            continue
    return removed
