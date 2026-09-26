"""Type sniffing and per-type extraction, including scanned-page detection and rendering."""

import pytest

from app.document_extraction import (
    ExtractionError, extract, prepare_image, render_pdf_page, sniff_kind, validate_image,
)
from document_fixtures import docx_bytes, image_bytes, scanned_pdf, text_pdf


def test_sniffing_trusts_bytes_not_the_declared_type() -> None:
    assert sniff_kind(text_pdf(["Hello world"]), "notes.txt", "text/plain") == "pdf"
    assert sniff_kind(image_bytes("PNG"), "report.pdf", "application/pdf") == "png"
    assert sniff_kind(image_bytes("JPEG"), "a.bin", None) == "jpeg"
    assert sniff_kind(image_bytes("WEBP"), "a", "application/octet-stream") == "webp"
    assert sniff_kind(docx_bytes(), "upload", "application/zip") == "docx"
    assert sniff_kind(b"<!DOCTYPE html><html><body>x</body></html>", "page", None) == "html"
    assert sniff_kind(b"# Title\n\nBody", "readme.md", None) == "markdown"
    assert sniff_kind(b"# Title\n\nBody", "readme", "text/markdown") == "markdown"
    assert sniff_kind(b"plain words", "notes.txt", "image/png") == "text"


def test_sniffing_rejects_binary_and_unsupported_archives() -> None:
    with pytest.raises(ExtractionError, match="unsupported"):
        sniff_kind(b"\x00\x01\x02binary" * 50, "a.exe", "application/pdf")
    import io
    import zipfile

    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        archive.writestr("xl/workbook.xml", "<workbook/>")
    with pytest.raises(ExtractionError, match="docx"):
        sniff_kind(buffer.getvalue(), "sheet.xlsx", None)


def test_pdf_pages_keep_text_and_flag_low_text_pages_for_vision() -> None:
    document = extract(text_pdf(["Quarterly pricing overview for enterprise customers. " * 3, ""]), "pdf")
    assert document.content_type == "application/pdf"
    assert [page.number for page in document.pages] == [1, 2]
    assert "Quarterly pricing overview" in document.pages[0].text
    assert document.pages[0].needs_vision is False
    assert document.pages[1].text == "" and document.pages[1].needs_vision is True


def test_scanned_pdf_is_detected_and_rendered_to_bounded_jpeg() -> None:
    data = scanned_pdf()
    document = extract(data, "pdf")
    assert len(document.pages) == 1 and document.pages[0].needs_vision
    rendered = render_pdf_page(data, 1)
    assert rendered.startswith(b"\xff\xd8\xff")
    from PIL import Image
    import io

    with Image.open(io.BytesIO(rendered)) as image:
        assert max(image.size) <= 1600


def test_docx_html_markdown_and_text_extraction_keep_structure() -> None:
    docx = extract(docx_bytes(), "docx")
    assert docx.title == "Service catalogue"
    assert "# Services" in docx.pages[0].text and "## Pricing" in docx.pages[0].text
    assert "- Pilots start at a fixed fee." in docx.pages[0].text and "Tier | Gold" in docx.pages[0].text

    html = extract(b"<html><head><title>About us</title><script>alert(1)</script></head><body>"
                   b"<nav>Menu</nav><h1>Company</h1><p>We build <b>robots</b>. Really <i>fast</i> ones.</p><ul><li>Fast</li></ul>"
                   b"<footer>Copyright</footer></body></html>", "html")
    assert html.title == "About us"
    text = html.pages[0].text
    assert "# Company" in text and "We build robots. Really fast ones." in text
    assert "- Fast" in text and "alert" not in text and "Menu" not in text and "Copyright" not in text

    assert extract("# Title\r\n\r\n\r\n\r\nBody".encode(), "markdown").pages[0].text == "# Title\n\nBody"
    assert extract("café".encode("cp1252"), "text").pages[0].text == "café"


def test_images_are_validated_and_downscaled() -> None:
    assert validate_image(image_bytes("PNG")) == (320, 200)
    document = extract(image_bytes("WEBP"), "webp")
    assert document.pages[0].needs_vision and document.content_type == "image/webp"
    big = prepare_image(image_bytes("PNG", (3200, 1000)))
    from PIL import Image
    import io

    with Image.open(io.BytesIO(big)) as image:
        assert image.format == "JPEG" and max(image.size) == 1600
    with pytest.raises(ExtractionError):
        validate_image(b"\x89PNG\r\n\x1a\n" + b"garbage" * 10)
    with pytest.raises(ExtractionError):
        extract(b"%PDF-1.4 not really a pdf", "pdf")


def test_docx_zip_bomb_is_rejected_before_parsing(monkeypatch) -> None:
    import app.document_extraction as extraction

    monkeypatch.setattr(extraction, "MAX_ZIP_UNCOMPRESSED", 1000)
    with pytest.raises(ExtractionError, match="too large"):
        sniff_kind(docx_bytes(), "big.docx", None)
