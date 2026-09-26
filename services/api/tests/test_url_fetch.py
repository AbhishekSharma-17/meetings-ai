"""SSRF guard for URL ingestion: every hop is resolved and must be a public address."""

import asyncio

import httpx
import pytest

from app.url_fetch import SafeFetcher, UrlFetchError, is_public_address

DNS = {
    "public.example": ["93.184.216.34"],
    "mixed.example": ["93.184.216.34", "10.1.2.3"],
    "rebind.example": ["127.0.0.1"],
    "metadata.example": ["169.254.169.254"],
    "v6.example": ["2606:2800:220:1:248:1893:25c8:1946"],
}


async def resolver(host, port):
    return DNS[host]


def _fetch(url, handler, **kwargs):
    fetcher = SafeFetcher(resolver=resolver, transport=httpx.MockTransport(handler), **kwargs)
    return asyncio.run(fetcher.fetch(url))


def _ok(request):
    return httpx.Response(200, headers={"content-type": "application/pdf"}, content=b"%PDF-1.4 tiny")


@pytest.mark.parametrize("address", [
    "10.0.0.1", "172.16.5.4", "192.168.1.1", "127.0.0.1", "169.254.169.254", "100.64.0.1", "0.0.0.0",
    "::1", "fe80::1", "fc00::1", "::ffff:127.0.0.1", "::ffff:10.0.0.1", "fd00:ec2::254", "224.0.0.1",
    "64:ff9b::a00:1", "not-an-ip",
])
def test_private_link_local_metadata_and_mapped_addresses_are_blocked(address) -> None:
    assert is_public_address(address) is False


def test_public_addresses_are_allowed() -> None:
    assert is_public_address("93.184.216.34") and is_public_address("2606:2800:220:1:248:1893:25c8:1946")


@pytest.mark.parametrize("url, message", [
    ("ftp://public.example/file", "http"),
    ("file:///etc/passwd", "http"),
    ("https://user:pass@public.example/", "credentials"),
    ("https://public.example:6379/", "port"),
    ("http://localhost/admin", "private"),
    ("http://service.internal/", "private"),
    ("https://mixed.example/", "private"),
    ("https://rebind.example/", "private"),
    ("https://metadata.example/latest/meta-data/", "private"),
])
def test_unsafe_urls_are_rejected_before_any_request(url, message) -> None:
    def never(request):
        raise AssertionError("no request may be sent")

    with pytest.raises(UrlFetchError, match=message):
        _fetch(url, never)


def test_connection_is_pinned_to_the_vetted_ip_with_original_host() -> None:
    seen = []

    def handler(request):
        seen.append((request.url.host, request.headers["host"], request.extensions.get("sni_hostname")))
        return _ok(request)

    resource = _fetch("https://public.example/files/deck.pdf", handler)
    assert resource.filename == "deck.pdf" and resource.data.startswith(b"%PDF")
    assert seen == [("93.184.216.34", "public.example", "public.example")]
    v6 = _fetch("http://v6.example/", _ok)
    assert v6.url == "http://v6.example/"


def test_redirects_are_revalidated_and_bounded() -> None:
    def to_metadata(request):
        return httpx.Response(302, headers={"location": "http://metadata.example/latest/"})

    with pytest.raises(UrlFetchError, match="private"):
        _fetch("https://public.example/start", to_metadata)

    def loop(request):
        return httpx.Response(301, headers={"location": "/again"})

    with pytest.raises(UrlFetchError, match="redirects"):
        _fetch("https://public.example/start", loop)


def test_size_limits_and_errors() -> None:
    def big(request):
        return httpx.Response(200, content=b"x" * 5000)

    with pytest.raises(UrlFetchError, match="25 MB"):
        _fetch("https://public.example/big", big, max_bytes=1000)

    def declared(request):
        return httpx.Response(200, headers={"content-length": "999999999"}, content=b"x")

    with pytest.raises(UrlFetchError, match="25 MB"):
        _fetch("https://public.example/big", declared, max_bytes=1000)
    with pytest.raises(UrlFetchError, match="HTTP 404"):
        _fetch("https://public.example/missing", lambda request: httpx.Response(404))
