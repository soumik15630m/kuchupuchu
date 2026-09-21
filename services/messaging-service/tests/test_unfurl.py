import pytest

from app.unfurl import (
    UnfurlError,
    is_public_address,
    parse_preview,
    resolve_public,
    validate_url,
)


class TestAddressGuard:
    @pytest.mark.parametrize(
        "address",
        [
            "127.0.0.1",
            "0.0.0.0",
            "10.0.0.5",
            "172.16.4.1",
            "192.168.1.1",
            # The cloud metadata endpoint, the single most valuable SSRF target.
            "169.254.169.254",
            "::1",
            "fe80::1",
            "fc00::1",
            # A v4 loopback smuggled in as a mapped v6 address.
            "::ffff:127.0.0.1",
        ],
    )
    def test_private_and_reserved_addresses_are_refused(self, address):
        assert is_public_address(address) is False

    @pytest.mark.parametrize("address", ["8.8.8.8", "1.1.1.1", "2606:4700::1111"])
    def test_public_addresses_pass(self, address):
        assert is_public_address(address) is True

    def test_nonsense_is_not_public(self):
        assert is_public_address("not-an-address") is False


class TestResolution:
    def test_localhost_is_refused_at_resolution(self):
        # The end of the guard that actually matters: a name that looks
        # ordinary but resolves inward never gets a socket.
        with pytest.raises(UnfurlError, match="private network"):
            resolve_public("localhost", 80)

    def test_an_unresolvable_host_is_reported_as_such(self):
        with pytest.raises(UnfurlError, match="could not be resolved"):
            resolve_public("no-such-host.invalid", 443)


class TestUrlGuard:
    @pytest.mark.parametrize(
        "url",
        [
            "file:///etc/passwd",
            "gopher://example.com/",
            "ftp://example.com/x",
            "javascript:alert(1)",
        ],
    )
    def test_only_http_and_https(self, url):
        with pytest.raises(UnfurlError):
            validate_url(url)

    def test_credentials_in_the_url_are_refused(self):
        # http://evil@internal/ is read as the host "internal" by some
        # parsers and "evil" by others; refusing the shape ends the argument.
        with pytest.raises(UnfurlError):
            validate_url("http://user:pass@example.com/")

    def test_nonstandard_ports_are_refused(self):
        with pytest.raises(UnfurlError):
            validate_url("http://example.com:6379/")

    def test_a_plain_url_is_split(self):
        assert validate_url("https://example.com/a/b?c=d") == (
            "https",
            "example.com",
            443,
            "/a/b?c=d",
        )

    def test_an_empty_path_becomes_root(self):
        assert validate_url("https://example.com")[3] == "/"


HTML = b"""
<html><head>
  <title>Fallback title</title>
  <meta name="description" content="Fallback description">
  <meta property="og:title" content="Open Graph title">
  <meta property="og:description" content="  Spread   over
  lines  ">
  <meta property="og:site_name" content="Example">
  <meta property="og:image" content="/img/hero.png">
</head><body></body></html>
"""


class TestParsing:
    def test_open_graph_wins(self):
        preview = parse_preview(HTML, "text/html", "https://example.com/page")
        assert preview.title == "Open Graph title"
        assert preview.site_name == "Example"

    def test_whitespace_is_collapsed(self):
        preview = parse_preview(HTML, "text/html", "https://example.com/page")
        assert preview.description == "Spread over lines"

    def test_relative_images_are_resolved_against_the_final_url(self):
        preview = parse_preview(HTML, "text/html", "https://example.com/page")
        assert preview.image_url == "https://example.com/img/hero.png"

    def test_the_document_title_is_the_fallback(self):
        body = b"<html><head><title>Only this</title></head></html>"
        preview = parse_preview(body, "text/html", "https://example.com/")
        assert preview.title == "Only this"
        assert preview.description is None

    def test_entities_are_decoded(self):
        body = b'<html><head><meta property="og:title" content="Tom &amp; Jerry"></head></html>'
        assert parse_preview(body, "text/html", "https://example.com/").title == "Tom & Jerry"

    def test_parsing_does_not_resolve_dns_so_private_images_survive_this_stage(self):
        body = b'<html><head><meta property="og:image" content="http://169.254.169.254/x.png"></head></html>'
        preview = parse_preview(body, "text/html", "https://example.com/")
        # Deliberate: parse_preview only checks a URL's *shape*, and this one
        # is well-formed. The address guard lives in the fetch path, which the
        # image endpoint always goes through -- so this never leaves the box.
        assert preview.image_url == "http://169.254.169.254/x.png"
        assert is_public_address("169.254.169.254") is False

    def test_a_file_scheme_image_is_dropped(self):
        body = b'<html><head><meta property="og:image" content="file:///etc/passwd"></head></html>'
        assert parse_preview(body, "text/html", "https://example.com/").image_url is None

    def test_a_title_longer_than_the_cap_is_truncated(self):
        body = b'<html><head><title>' + b"x" * 500 + b"</title></head></html>"
        assert len(parse_preview(body, "text/html", "https://example.com/").title) == 160

    def test_single_quoted_attributes_are_read(self):
        body = b"<html><head><meta property='og:title' content='Quoted'></head></html>"
        assert parse_preview(body, "text/html", "https://example.com/").title == "Quoted"

    def test_a_declared_charset_is_honoured(self):
        body = "<html><head><title>Привет</title></head></html>".encode("cp1251")
        preview = parse_preview(body, "text/html; charset=windows-1251", "https://example.com/")
        assert preview.title == "Привет"

    def test_an_unknown_charset_falls_back_rather_than_raising(self):
        body = b"<html><head><title>Fine</title></head></html>"
        preview = parse_preview(body, "text/html; charset=definitely-not-real", "https://x.test/")
        assert preview.title == "Fine"

    def test_an_empty_document_yields_nothing_rather_than_failing(self):
        preview = parse_preview(b"", "text/html", "https://example.com/")
        assert preview.title is None and preview.image_url is None

    def test_an_escaped_image_query_string_is_unescaped(self):
        body = (
            b'<html><head><meta property="og:image" '
            b'content="https://cdn.example.com/x.png?a=1&amp;b=2"></head></html>'
        )
        preview = parse_preview(body, "text/html", "https://example.com/")
        assert preview.image_url == "https://cdn.example.com/x.png?a=1&b=2"
