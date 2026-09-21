"""Server-side link unfurling for the sender only.

Rich previews cannot be built in the browser -- almost no site sends CORS
headers for its own HTML -- so somebody has to fetch the page. Doing it here
means this service learns which links a member pastes, which is a real
privacy cost and the reason previews are opt-out per member. What it buys is
that the *recipient* never touches the third party at all: the sender fetches
the metadata, downscales the image locally, and ships the result inside the
encrypted envelope. Only one person's address is exposed to the site, and it
is the person who chose to paste the link.

Everything here is written defensively because a URL supplied by a user and
fetched by a server is the textbook SSRF sink. The guards are:

  * http/https only, no credentials in the URL, no non-default ports beyond
    80/443;
  * DNS resolved up front, every resulting address checked against the
    private/loopback/link-local/reserved ranges;
  * the socket connects to the *validated IP*, with Host and TLS SNI set to
    the hostname. Re-resolving inside the HTTP client would leave a window
    where DNS answers differently the second time (DNS rebinding);
  * redirects followed manually, at most three, each hop re-validated from
    scratch;
  * response bodies truncated at a byte cap while reading, not after.
"""

from __future__ import annotations

import html
import http.client
import ipaddress
import re
import socket
import ssl
import time
from dataclasses import dataclass
from urllib.parse import urljoin, urlsplit

MAX_REDIRECTS = 3
MAX_HTML_BYTES = 512 * 1024
MAX_IMAGE_BYTES = 2 * 1024 * 1024
TIMEOUT_SECONDS = 6.0

# Sending a browser-shaped User-Agent gets the same markup a person would see;
# many sites serve a stub to anything that looks like a bot.
USER_AGENT = (
    "Mozilla/5.0 (compatible; KuchupuchuPreview/1.0; +https://kuchupuchu.invalid/preview)"
)

ALLOWED_SCHEMES = frozenset({"http", "https"})
ALLOWED_PORTS = frozenset({80, 443})


class UnfurlError(Exception):
    """Anything that stops a preview. The message is safe to show a user."""


@dataclass
class Fetched:
    url: str
    content_type: str
    body: bytes


@dataclass
class Preview:
    url: str
    title: str | None = None
    description: str | None = None
    site_name: str | None = None
    image_url: str | None = None


def is_public_address(raw: str) -> bool:
    """False for anything that could reach infrastructure rather than the
    internet: loopback, RFC1918, link-local (including cloud metadata at
    169.254.169.254), multicast, reserved, and the v6 equivalents."""
    try:
        ip = ipaddress.ip_address(raw)
    except ValueError:
        return False
    if isinstance(ip, ipaddress.IPv6Address) and ip.ipv4_mapped is not None:
        ip = ip.ipv4_mapped
    return not (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_multicast
        or ip.is_reserved
        or ip.is_unspecified
    )


def validate_url(url: str) -> tuple[str, str, int, str]:
    """Returns (scheme, host, port, path_with_query) or raises."""
    parts = urlsplit(url)
    if parts.scheme.lower() not in ALLOWED_SCHEMES:
        raise UnfurlError("only http and https links can be previewed")
    if parts.username or parts.password:
        raise UnfurlError("links with credentials in them are not previewed")
    host = parts.hostname
    if not host:
        raise UnfurlError("that link has no host")
    port = parts.port or (443 if parts.scheme.lower() == "https" else 80)
    if port not in ALLOWED_PORTS:
        raise UnfurlError("only the standard web ports can be previewed")
    path = parts.path or "/"
    if parts.query:
        path = f"{path}?{parts.query}"
    return parts.scheme.lower(), host, port, path


def resolve_public(host: str, port: int) -> str:
    """Resolves the host and returns one address that passed every check.
    A host that resolves to *any* non-public address is refused outright
    rather than filtered: a name pointing at both is a strong signal of an
    attempt, not a misconfiguration worth working around."""
    try:
        infos = socket.getaddrinfo(host, port, proto=socket.IPPROTO_TCP)
    except socket.gaierror:
        raise UnfurlError("that host could not be resolved")
    addresses = [info[4][0] for info in infos]
    if not addresses:
        raise UnfurlError("that host could not be resolved")
    for address in addresses:
        if not is_public_address(address):
            raise UnfurlError("that link points inside a private network")
    return addresses[0]


def _read_capped(response: http.client.HTTPResponse, cap: int) -> bytes:
    """Reads at most `cap` bytes. Trusting Content-Length would let a server
    declare 1KB and then stream forever."""
    chunks: list[bytes] = []
    remaining = cap
    while remaining > 0:
        chunk = response.read(min(65536, remaining))
        if not chunk:
            break
        chunks.append(chunk)
        remaining -= len(chunk)
    return b"".join(chunks)


def fetch(url: str, *, accept: str, max_bytes: int) -> Fetched:
    seen = 0
    current = url
    deadline = time.monotonic() + TIMEOUT_SECONDS * (MAX_REDIRECTS + 1)

    while True:
        if time.monotonic() > deadline:
            raise UnfurlError("that link took too long to answer")
        scheme, host, port, path = validate_url(current)
        address = resolve_public(host, port)

        # The connection is built by hand rather than left to http.client,
        # which would re-resolve the hostname itself and reopen the rebinding
        # window this function exists to close. The socket goes to the address
        # already validated; TLS and the Host header still carry the real
        # name, so certificate validation stays meaningful.
        conn = http.client.HTTPConnection(host, port, timeout=TIMEOUT_SECONDS)
        try:
            sock = socket.create_connection((address, port), timeout=TIMEOUT_SECONDS)
            if scheme == "https":
                sock = ssl.create_default_context().wrap_socket(sock, server_hostname=host)
            conn.sock = sock
        except (OSError, ssl.SSLError):
            conn.close()
            raise UnfurlError("that link could not be reached")

        try:
            conn.request(
                "GET",
                path,
                headers={
                    "Host": host,
                    "User-Agent": USER_AGENT,
                    "Accept": accept,
                    "Accept-Language": "en",
                    "Connection": "close",
                },
            )
            response = conn.getresponse()
            status = response.status

            if status in (301, 302, 303, 307, 308):
                location = response.getheader("Location")
                if not location:
                    raise UnfurlError("that link redirected nowhere")
                seen += 1
                if seen > MAX_REDIRECTS:
                    raise UnfurlError("that link redirects too many times")
                current = urljoin(current, location)
                continue

            if status != 200:
                raise UnfurlError(f"that link answered {status}")

            content_type = (response.getheader("Content-Type") or "").split(";")[0].strip().lower()
            body = _read_capped(response, max_bytes)
            return Fetched(url=current, content_type=content_type, body=body)
        except UnfurlError:
            raise
        except (OSError, http.client.HTTPException, ssl.SSLError):
            raise UnfurlError("that link could not be reached")
        finally:
            conn.close()


_META_RE = re.compile(rb"<meta\b[^>]*>", re.IGNORECASE)
_ATTR_RE = re.compile(
    rb"""(\w[\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s">]+))""", re.IGNORECASE
)
_TITLE_RE = re.compile(rb"<title[^>]*>(.*?)</title>", re.IGNORECASE | re.DOTALL)
_CHARSET_RE = re.compile(rb"charset=([\w-]+)", re.IGNORECASE)


def _decode(body: bytes, content_type: str) -> str:
    match = _CHARSET_RE.search(content_type.encode()) or _CHARSET_RE.search(body[:2048])
    encoding = match.group(1).decode("ascii", "replace") if match else "utf-8"
    try:
        return body.decode(encoding, "replace")
    except LookupError:
        return body.decode("utf-8", "replace")


def _clean(value: str | None, limit: int) -> str | None:
    if not value:
        return None
    text = html.unescape(value)
    text = re.sub(r"\s+", " ", text).strip()
    if not text:
        return None
    return text[:limit]


def parse_preview(body: bytes, content_type: str, base_url: str) -> Preview:
    """Open Graph first, then Twitter cards, then the plain <title> and
    meta description -- the order sites actually expect to be read in."""
    text = _decode(body, content_type)
    raw = text.encode("utf-8", "replace")

    meta: dict[str, str] = {}
    for tag in _META_RE.findall(raw):
        attrs: dict[str, str] = {}
        for name, _full, dq, sq, bare in _ATTR_RE.findall(tag):
            value = dq or sq or bare
            attrs[name.decode("ascii", "replace").lower()] = value.decode("utf-8", "replace")
        key = attrs.get("property") or attrs.get("name")
        content = attrs.get("content")
        if key and content and key.lower() not in meta:
            meta[key.lower()] = content

    title_match = _TITLE_RE.search(raw)
    doc_title = title_match.group(1).decode("utf-8", "replace") if title_match else None

    image = meta.get("og:image") or meta.get("og:image:url") or meta.get("twitter:image")
    if image:
        try:
            # Attribute values arrive HTML-escaped, so a query string reads as
            # "a=1&amp;b=2". Most servers tolerate it; some 404.
            image = urljoin(base_url, html.unescape(image).strip())
            # A relative og:image on a page that later redirects could resolve
            # somewhere private; the image endpoint validates independently,
            # but refusing obvious cases here saves a round trip.
            validate_url(image)
        except UnfurlError:
            image = None

    return Preview(
        url=base_url,
        title=_clean(meta.get("og:title") or meta.get("twitter:title") or doc_title, 160),
        description=_clean(
            meta.get("og:description") or meta.get("twitter:description") or meta.get("description"),
            300,
        ),
        site_name=_clean(meta.get("og:site_name"), 60),
        image_url=image,
    )


def unfurl(url: str) -> Preview:
    fetched = fetch(url, accept="text/html,application/xhtml+xml", max_bytes=MAX_HTML_BYTES)
    if fetched.content_type and not (
        fetched.content_type.startswith("text/html")
        or fetched.content_type.startswith("application/xhtml")
    ):
        raise UnfurlError("that link is not a web page")
    return parse_preview(fetched.body, fetched.content_type, fetched.url)


def fetch_image(url: str) -> Fetched:
    fetched = fetch(url, accept="image/*", max_bytes=MAX_IMAGE_BYTES)
    if not fetched.content_type.startswith("image/"):
        raise UnfurlError("that is not an image")
    return fetched
