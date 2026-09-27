"""Profile photos: validate by bytes, re-encode to a small square, serve inside the workspace.

The original upload is never stored or served. Every photo is decoded with a
pixel cap, orientation-corrected, centre-cropped to a square, resized and
re-encoded from raw pixels, so EXIF, GPS, ICC and XMP metadata cannot survive.
"""

from __future__ import annotations

import io
from dataclasses import dataclass
from datetime import UTC, datetime
from uuid import UUID

from sqlalchemy import delete, select

from .database import Database, OrganizationMembershipRow, UserProfilePhotoRow
from .document_extraction import IMAGE_KINDS, MAX_IMAGE_PIXELS, ExtractionError, sniff_kind

MAX_PHOTO_BYTES = 5 * 1024 * 1024
# Well below the global Pillow bomb limit: a 24 MP phone photo fits, a
# crafted 20k×20k header does not get decoded at all.
MAX_PHOTO_PIXELS = 40_000_000
PHOTO_SIDE_PX = 256
WEBP_QUALITY = 82
JPEG_QUALITY = 85


class ProfilePhotoError(ValueError):
    """The upload is rejected. The message is safe to show to the uploader."""

    def __init__(self, message: str, status_code: int = 422) -> None:
        super().__init__(message)
        self.status_code = status_code


@dataclass(frozen=True)
class EncodedPhoto:
    content_type: str
    data: bytes
    width: int
    height: int


@dataclass(frozen=True)
class StoredPhoto:
    content_type: str
    data: bytes
    etag: str
    updated_at: datetime


def photo_version(updated_at: datetime) -> str:
    # SQLite hands back naive datetimes; they were written as UTC.
    aware = updated_at if updated_at.tzinfo else updated_at.replace(tzinfo=UTC)
    return str(int(aware.timestamp() * 1000))


def photo_url(user_id: UUID | str, updated_at: datetime | None) -> str | None:
    """Relative API path with a cache-busting version, or None when there is no photo."""
    if updated_at is None:
        return None
    return f"/v1/users/{user_id}/photo?v={photo_version(updated_at)}"


def _webp_supported() -> bool:
    from PIL import features

    return bool(features.check("webp"))


def encode_profile_photo(data: bytes) -> EncodedPhoto:
    """Turn an uploaded PNG/JPEG/WebP into a clean square WebP (JPEG when WebP is unavailable)."""
    from PIL import Image, ImageOps, UnidentifiedImageError

    if not data:
        raise ProfilePhotoError("choose an image to upload")
    if len(data) > MAX_PHOTO_BYTES:
        raise ProfilePhotoError("profile photos must be 5 MB or smaller", status_code=413)
    try:
        kind = sniff_kind(data, "", None)
    except ExtractionError as exc:
        raise ProfilePhotoError("upload a PNG, JPEG or WebP image", status_code=415) from exc
    if kind not in IMAGE_KINDS:
        raise ProfilePhotoError("upload a PNG, JPEG or WebP image", status_code=415)
    # document_extraction sets this process-wide cap; keep it in force here too.
    Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS
    try:
        with Image.open(io.BytesIO(data)) as image:
            if image.format not in {"PNG", "JPEG", "WEBP"}:
                raise ProfilePhotoError("upload a PNG, JPEG or WebP image", status_code=415)
            width, height = image.size
            if width < 1 or height < 1 or width * height > MAX_PHOTO_PIXELS:
                raise ProfilePhotoError("the image dimensions are too large")
            if image.format == "JPEG":
                # Let libjpeg decode at a reduced scale; it never goes below the target size.
                image.draft("RGB", (PHOTO_SIDE_PX * 2, PHOTO_SIDE_PX * 2))
            image.load()
            oriented = ImageOps.exif_transpose(image) or image
            has_alpha = oriented.mode in {"RGBA", "LA", "PA"} or (
                oriented.mode == "P" and "transparency" in oriented.info
            )
            converted = oriented.convert("RGBA" if has_alpha else "RGB")
            square = ImageOps.fit(converted, (PHOTO_SIDE_PX, PHOTO_SIDE_PX), Image.Resampling.LANCZOS)
    except ProfilePhotoError:
        raise
    except (UnidentifiedImageError, Image.DecompressionBombError, OSError, SyntaxError, ValueError) as exc:
        raise ProfilePhotoError("the image is corrupt or unsupported") from exc
    # Rebuild from raw pixels so no info/metadata dictionary is carried into the encoder.
    clean = Image.frombytes(square.mode, square.size, square.tobytes())
    buffer = io.BytesIO()
    if _webp_supported():
        clean.save(buffer, format="WEBP", quality=WEBP_QUALITY, method=4)
        content_type = "image/webp"
    else:
        if clean.mode == "RGBA":
            flattened = Image.new("RGB", clean.size, "white")
            flattened.paste(clean, mask=clean.split()[-1])
            clean = flattened
        clean.save(buffer, format="JPEG", quality=JPEG_QUALITY, optimize=True)
        content_type = "image/jpeg"
    return EncodedPhoto(content_type=content_type, data=buffer.getvalue(), width=PHOTO_SIDE_PX, height=PHOTO_SIDE_PX)


class ProfilePhotoService:
    def __init__(self, database: Database) -> None:
        self.database = database

    def save(self, user_id: UUID, photo: EncodedPhoto) -> str:
        now = datetime.now(UTC)
        with self.database.session_factory.begin() as session:
            row = session.get(UserProfilePhotoRow, str(user_id))
            if row is None:
                session.add(UserProfilePhotoRow(
                    user_id=str(user_id), content_type=photo.content_type, image=photo.data,
                    width=photo.width, height=photo.height, byte_size=len(photo.data), updated_at=now,
                ))
            else:
                row.content_type = photo.content_type
                row.image = photo.data
                row.width = photo.width
                row.height = photo.height
                row.byte_size = len(photo.data)
                row.updated_at = now
        return f"/v1/users/{user_id}/photo?v={photo_version(now)}"

    def remove(self, user_id: UUID) -> None:
        with self.database.session_factory.begin() as session:
            session.execute(delete(UserProfilePhotoRow).where(UserProfilePhotoRow.user_id == str(user_id)))

    def url_for(self, user_id: UUID) -> str | None:
        return self.urls_for([user_id]).get(str(user_id))

    def urls_for(self, user_ids: list[UUID] | list[str]) -> dict[str, str]:
        """Versioned photo URLs for the given users, loading timestamps only (never image bytes)."""
        ids = sorted({str(user_id) for user_id in user_ids})
        if not ids:
            return {}
        with self.database.session_factory() as session:
            rows = session.execute(
                select(UserProfilePhotoRow.user_id, UserProfilePhotoRow.updated_at)
                .where(UserProfilePhotoRow.user_id.in_(ids))
            ).all()
        return {user_id: url for user_id, updated_at in rows if (url := photo_url(user_id, updated_at))}

    def get_visible(self, viewer_user_id: UUID, organization_id: UUID, user_id: UUID) -> StoredPhoto | None:
        """The photo, if the viewer is that user or the user belongs to the viewer's current workspace."""
        with self.database.session_factory() as session:
            if viewer_user_id != user_id and session.get(
                OrganizationMembershipRow, (str(organization_id), str(user_id))
            ) is None:
                return None
            row = session.get(UserProfilePhotoRow, str(user_id))
            if row is None:
                return None
            version = photo_version(row.updated_at)
            return StoredPhoto(content_type=row.content_type, data=row.image,
                               etag=f'"{user_id}-{version}"', updated_at=row.updated_at)
