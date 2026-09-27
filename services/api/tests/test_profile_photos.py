"""Profile photos are sniffed, re-encoded without metadata and only served inside the workspace."""

import io

import pytest
from fastapi.testclient import TestClient
from PIL import Image

from app.main import create_app
from app.profile_photos import MAX_PHOTO_BYTES, PHOTO_SIDE_PX, ProfilePhotoError, encode_profile_photo

OWNER_EMAIL = "owner@example.test"
OWNER_PASSWORD = "owner-password-for-test"


def _image_bytes(image: Image.Image, fmt: str, **options) -> bytes:
    buffer = io.BytesIO()
    image.save(buffer, format=fmt, **options)
    return buffer.getvalue()


def _two_tone(width: int, height: int) -> Image.Image:
    """Left half red, right half blue."""
    image = Image.new("RGB", (width, height), (220, 20, 20))
    image.paste((20, 20, 220), (width // 2, 0, width, height))
    return image


def test_png_with_alpha_becomes_square_photo() -> None:
    source = Image.new("RGBA", (640, 320), (10, 120, 110, 128))
    encoded = encode_profile_photo(_image_bytes(source, "PNG"))
    assert encoded.content_type in {"image/webp", "image/jpeg"}
    with Image.open(io.BytesIO(encoded.data)) as result:
        assert result.size == (PHOTO_SIDE_PX, PHOTO_SIDE_PX)
        assert result.format in {"WEBP", "JPEG"}


def test_jpeg_metadata_is_stripped_and_orientation_applied() -> None:
    source = _two_tone(400, 200)
    exif = Image.Exif()
    exif[0x0112] = 6  # Orientation: rotate 90° clockwise for display
    exif[0x010E] = "private description"
    exif[0x8825] = {1: "N", 2: (51.0, 30.0, 0.0)}  # GPS IFD
    data = _image_bytes(source, "JPEG", exif=exif.tobytes(), quality=95)
    encoded = encode_profile_photo(data)
    assert b"private description" not in encoded.data
    with Image.open(io.BytesIO(encoded.data)) as result:
        assert not result.getexif()
        assert "exif" not in result.info and "xmp" not in result.info and "icc_profile" not in result.info
        rgb = result.convert("RGB")
        top, bottom = rgb.getpixel((128, 30)), rgb.getpixel((128, 226))
    # After a clockwise turn the stored left (red) half is on top.
    assert top[0] > 150 and top[2] < 100
    assert bottom[2] > 150 and bottom[0] < 100


@pytest.mark.parametrize(("payload", "status"), [
    (b"", 422),
    (b"GIF89a" + b"\x00" * 64, 415),
    (b"%PDF-1.7\n" + b"0" * 64, 415),
    (b"plain text pretending to be a picture", 415),
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * 128, 422),
    (b"\x89PNG\r\n\x1a\n" + b"\x00" * MAX_PHOTO_BYTES, 413),
])
def test_rejects_unsupported_corrupt_and_oversized_uploads(payload: bytes, status: int) -> None:
    with pytest.raises(ProfilePhotoError) as caught:
        encode_profile_photo(payload)
    assert caught.value.status_code == status


def test_rejects_images_with_too_many_pixels() -> None:
    huge = _image_bytes(Image.new("1", (7000, 7000)), "PNG")
    assert len(huge) < MAX_PHOTO_BYTES
    with pytest.raises(ProfilePhotoError, match="dimensions"):
        encode_profile_photo(huge)


def _login(client: TestClient, email: str, password: str) -> None:
    assert client.post("/v1/auth/login", json={"email": email, "password": password}).status_code == 200


def _upload(client: TestClient, data: bytes, content_type: str = "image/png"):
    return client.put("/v1/auth/me/photo", files={"file": ("photo.png", data, content_type)})


def test_photo_api_lifecycle_and_workspace_isolation(tmp_path, monkeypatch) -> None:
    monkeypatch.setenv("MEETINGS_AI_ADMIN_PASSWORD", OWNER_PASSWORD)
    monkeypatch.setenv("MEETINGS_AI_SESSION_SECRET", "owner-session-signing-test-secret")
    monkeypatch.setenv("MEETINGS_AI_ADMIN_EMAIL", OWNER_EMAIL)
    app = create_app(database_url=f"sqlite+pysqlite:///{tmp_path / 'photos.db'}", credential_key="test-credential-key")
    with TestClient(app) as owner, TestClient(app) as outsider, TestClient(app) as anonymous:
        _login(owner, OWNER_EMAIL, OWNER_PASSWORD)
        me = owner.get("/v1/auth/me").json()
        owner_id, legacy_id = me["user_id"], me["organization_id"]
        assert me["photo_url"] is None
        assert owner.get(f"/v1/users/{owner_id}/photo").status_code == 404

        uploaded = _upload(owner, _image_bytes(_two_tone(300, 300), "PNG"))
        assert uploaded.status_code == 200
        photo_url = uploaded.json()["photo_url"]
        assert photo_url.startswith(f"/v1/users/{owner_id}/photo?v=")
        assert owner.get("/v1/auth/me").json()["photo_url"] == photo_url
        assert owner.get("/v1/workspace/members").json()[0]["photo_url"] == photo_url

        served = owner.get(photo_url)
        assert served.status_code == 200
        assert served.headers["content-type"] in {"image/webp", "image/jpeg"}
        assert served.headers["cache-control"] == "private, max-age=86400"
        assert served.headers["x-content-type-options"] == "nosniff"
        etag = served.headers["etag"]
        assert owner.get(photo_url, headers={"If-None-Match": etag}).status_code == 304
        with Image.open(io.BytesIO(served.content)) as image:
            assert image.size == (PHOTO_SIDE_PX, PHOTO_SIDE_PX)

        assert _upload(owner, b"GIF89a" + b"\x00" * 32, "image/png").status_code == 415
        assert anonymous.get(photo_url).status_code == 401

        # An account that only belongs to another workspace.
        second = owner.post("/v1/workspaces", json={"display_name": "Elsewhere"}).json()
        invited = owner.post("/v1/workspace/invite", json={
            "email": "outsider@example.test", "display_name": "Out Sider", "role": "member",
        }).json()
        outsider_id = invited["account"]["user_id"]
        _login(outsider, "outsider@example.test", invited["temporary_password"])
        assert _upload(outsider, _image_bytes(_two_tone(64, 64), "PNG")).status_code == 403  # password first
        assert outsider.post("/v1/auth/change-password", json={
            "current_password": invited["temporary_password"], "new_password": "outsider-new-password-test",
        }).status_code == 200
        assert _upload(outsider, _image_bytes(_two_tone(64, 64), "JPEG"), "image/jpeg").status_code == 200
        outsider_url = outsider.get("/v1/auth/me").json()["photo_url"]
        assert outsider.get(outsider_url).status_code == 200

        # Cross-tenant: from a workspace the outsider does not belong to, their photo does not exist.
        assert owner.post(f"/v1/workspaces/{legacy_id}/switch").status_code == 200
        assert owner.get(outsider_url).status_code == 404
        assert owner.post(f"/v1/workspaces/{second['organization_id']}/switch").status_code == 200
        assert owner.get(outsider_url).status_code == 200
        assert outsider.get(f"/v1/users/{owner_id}/photo").status_code == 200

        # Removal from the shared workspace revokes access.
        assert owner.delete(f"/v1/workspace/members/{outsider_id}").status_code == 204
        assert owner.get(outsider_url).status_code == 404

        removed = owner.delete("/v1/auth/me/photo")
        assert removed.status_code == 200 and removed.json()["photo_url"] is None
        assert owner.get(photo_url).status_code == 404
        assert owner.get("/v1/auth/me").json()["photo_url"] is None
