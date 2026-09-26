"""SSRF-safe fetching of a public web page or file for document ingestion.

Every hop (including redirects) is resolved first; the request fails unless
EVERY resolved address is globally routable (no private, loopback, link-local,
CGNAT, multicast, reserved or cloud-metadata addresses). The connection is then
pinned to the vetted IP, with the original host kept for Host/SNI/TLS
verification, so DNS rebinding cannot swap in an internal address.
"""

from __future__ import annotations

import asyncio
import ipaddress
import socket
from collections.abc import Awaitable, Callable
from dataclasses import dataclass
from pathlib import PurePosixPath
from urllib.parse import unquote, urljoin, urlsplit, urlunsplit

import httpx

MAX_FETCH_BYTES = 25 * 1024 * 1024
MAX_REDIRECTS = 4
TIMEOUT = httpx.Timeout(15.0, connect=5.0)
TOTAL_DEADLINE_SECONDS = 30
ALLOWED_PORTS = {80, 443, 8080, 8443}
USER_AGENT = "MeetingsAI-DocumentFetcher/1.0 (+https://meeting.genaiprotos.com)"
_BLOCKED_NETWORKS = tuple(ipaddress.ip_network(value) for value in (
    "100.64.0.0/10",       # carrier-grade NAT
    "169.254.0.0/16",      # link-local incl. 169.254.169.254 metadata
    "192.0.0.0/24", "198.18.0.0/15",
    "fd00:ec2::/32",       # AWS IPv6 metadata
    "64:ff9b::/96", "2002::/16",  # NAT64 / 6to4 can embed private IPv4
))

Resolver = Callable[[str, int], Awaitable[list[str]]]


class UrlFetchError(ValueError):
    """Safe to show to the user."""


@dataclass(frozen=True)
class FetchedResource:
    url: str
    filename: str
    content_type: str
    data: bytes


async def system_resolver(host: str, port: int) -> list[str]:
    loop = asyncio.get_running_loop()
    try:
        infos = await loop.getaddrinfo(host, port, type=socket.SOCK_STREAM)
    except socket.gaierror as exc:
        raise UrlFetchError("the host name could not be resolved") from exc
    return list(dict.fromkeys(info[4][0] for info in infos))


def is_public_address(value: str) -> bool:
    try:
        address = ipaddress.ip_address(value.split("%", 1)[0])
    except ValueError:
        return False
    if isinstance(address, ipaddress.IPv6Address) and address.ipv4_mapped is not None:
        address = address.ipv4_mapped
    if not address.is_global or address.is_multicast or address.is_reserved or address.is_loopback \
            or address.is_link_local or address.is_private or address.is_unspecified:
        return False
    return not any(address in network for network in _BLOCKED_NETWORKS if network.version == address.version)


def _validated(url: str) -> tuple[str, str, int]:
    parts = urlsplit(url.strip())
    if parts.scheme not in {"http", "https"}:
        raise UrlFetchError("only http and https links can be fetched")
    if not parts.hostname or parts.username or parts.password:
        raise UrlFetchError("enter a public link without credentials")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    if port not in ALLOWED_PORTS:
        raise UrlFetchError("this port is not allowed")
    host = parts.hostname.rstrip(".").lower()
    if host in {"localhost"} or host.endswith((".localhost", ".local", ".internal")):
        raise UrlFetchError("private or internal addresses cannot be fetched")
    return parts.scheme, host, port


class SafeFetcher:
    def __init__(self, *, resolver: Resolver = system_resolver, transport: httpx.AsyncBaseTransport | None = None,
                 max_bytes: int = MAX_FETCH_BYTES) -> None:
        self.resolver = resolver
        self.transport = transport
        self.max_bytes = max_bytes

    async def fetch(self, url: str) -> FetchedResource:
        try:
            return await asyncio.wait_for(self._fetch(url), timeout=TOTAL_DEADLINE_SECONDS)
        except TimeoutError as exc:
            raise UrlFetchError("the page took too long to download") from exc

    async def _fetch(self, url: str) -> FetchedResource:
        current = url.strip()
        async with httpx.AsyncClient(timeout=TIMEOUT, transport=self.transport, follow_redirects=False) as client:
            for _ in range(MAX_REDIRECTS + 1):
                scheme, host, port = _validated(current)
                addresses = await self.resolver(host, port)
                if not addresses or not all(is_public_address(item) for item in addresses):
                    raise UrlFetchError("private or internal addresses cannot be fetched")
                pinned = addresses[0]
                parts = urlsplit(current)
                literal = f"[{pinned}]" if ":" in pinned else pinned
                netloc = f"{literal}:{port}" if parts.port else literal
                target = urlunsplit((scheme, netloc, parts.path or "/", parts.query, ""))
                headers = {"Host": parts.netloc.rsplit("@", 1)[-1], "User-Agent": USER_AGENT,
                           "Accept": "text/html,application/pdf,text/plain,text/markdown,image/*;q=0.8,*/*;q=0.5"}
                request = client.build_request("GET", target, headers=headers,
                                               extensions={"sni_hostname": host} if scheme == "https" else {})
                try:
                    response = await client.send(request, stream=True)
                except httpx.HTTPError as exc:
                    raise UrlFetchError("the page could not be downloaded") from exc
                try:
                    if response.status_code in {301, 302, 303, 307, 308}:
                        location = response.headers.get("location")
                        if not location:
                            raise UrlFetchError("the page redirected without a location")
                        current = urljoin(current, location)
                        continue
                    if response.status_code >= 400:
                        raise UrlFetchError(f"the page returned HTTP {response.status_code}")
                    declared = response.headers.get("content-length")
                    if declared and declared.isdigit() and int(declared) > self.max_bytes:
                        raise UrlFetchError("the file is larger than the 25 MB limit")
                    body = bytearray()
                    async for chunk in response.aiter_bytes():
                        body.extend(chunk)
                        if len(body) > self.max_bytes:
                            raise UrlFetchError("the file is larger than the 25 MB limit")
                finally:
                    await response.aclose()
                if not body:
                    raise UrlFetchError("the page was empty")
                content_type = response.headers.get("content-type", "application/octet-stream")
                return FetchedResource(url=current, filename=_filename(current, content_type),
                                       content_type=content_type, data=bytes(body))
        raise UrlFetchError("too many redirects")


def _filename(url: str, content_type: str) -> str:
    parts = urlsplit(url)
    name = PurePosixPath(unquote(parts.path)).name
    if name and "." in name:
        return name[:200]
    kind = content_type.split(";")[0].strip().lower()
    suffix = {"application/pdf": ".pdf", "text/plain": ".txt", "text/markdown": ".md",
              "image/png": ".png", "image/jpeg": ".jpg", "image/webp": ".webp"}.get(kind, ".html")
    return f"{(parts.hostname or 'page')[:120]}{name and '-' + name[:60]}{suffix}"
