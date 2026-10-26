"""
AGOS — typhoon details read from a news article or bulletin URL.

Only what the article states is used. Every extracted value keeps the
sentence it came from ("evidence") so the interface can show it. Nothing is
estimated: if the article gives no position, the result says so.

Positions come from:
  1. coordinates written in the text ("15.2°N, 125.4°E"), or
  2. a distance and direction from a named place ("320 km East of Virac,
     Catanduanes"), where the place is located with the Open-Meteo
     Geocoding API and the point is projected from it.

The URL fetch only reaches public http(s) addresses (no localhost or private
networks), follows at most a few redirects, and reads a limited amount.
"""

from __future__ import annotations

import ipaddress
import math
import re
import socket
from datetime import datetime, timezone
from html.parser import HTMLParser
from typing import Any, Callable
from urllib.parse import urljoin, urlsplit

import requests

GEOCODING_URL = "https://geocoding-api.open-meteo.com/v1/search"
USER_AGENT = "AGOS-flood-research/0.1 (Bataan student project; reads public articles)"
FETCH_TIMEOUT = (5, 12)
MAX_BYTES = 3 * 1024 * 1024
MAX_REDIRECTS = 5
EARTH_RADIUS_KM = 6371.0088

SOURCE_NOTE = (
    "Extracted automatically from the article text. Unverified and possibly "
    "outdated. Not an official PAGASA bulletin."
)


class UrlRejected(ValueError):
    """The URL is not allowed (bad scheme, private address, ...)."""


class FetchFailed(RuntimeError):
    """The page could not be downloaded or read."""


class GeocoderUnavailable(RuntimeError):
    """The place-name lookup service could not be reached."""


# ---------------------------------------------------------------- URL safety
def _blocked_ip(ip: ipaddress._BaseAddress) -> bool:
    return (
        ip.is_private or ip.is_loopback or ip.is_link_local or ip.is_multicast
        or ip.is_reserved or ip.is_unspecified
    )


def validate_public_url(url: str, resolve: Callable = socket.getaddrinfo) -> str:
    """Return the URL if it points to a public http(s) host, else raise UrlRejected."""
    url = (url or "").strip()
    if len(url) > 2048:
        raise UrlRejected("The link is too long.")
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https"):
        raise UrlRejected("Only http:// and https:// links can be read.")
    if not parts.hostname:
        raise UrlRejected("The link has no website address.")
    if parts.username or parts.password:
        raise UrlRejected("Links with a user name or password are not allowed.")
    if parts.port not in (None, 80, 443):
        raise UrlRejected("Only the standard web ports (80 and 443) are allowed.")
    try:
        infos = resolve(parts.hostname, parts.port or (443 if parts.scheme == "https" else 80))
    except (socket.gaierror, UnicodeError) as error:
        raise UrlRejected(f"The website address could not be found ({parts.hostname}).") from error
    addresses = {info[4][0] for info in infos}
    if not addresses:
        raise UrlRejected("The website address could not be found.")
    for address in addresses:
        if _blocked_ip(ipaddress.ip_address(address.split("%")[0])):
            raise UrlRejected("Links to local or private network addresses are not allowed.")
    return url


def fetch_page(url: str, session: Any = requests, resolve: Callable = socket.getaddrinfo) -> tuple[str, str]:
    """Download an HTML or text page. Returns (final_url, decoded_text)."""
    current = validate_public_url(url, resolve)
    for _ in range(MAX_REDIRECTS + 1):
        try:
            response = session.get(
                current,
                headers={"User-Agent": USER_AGENT, "Accept": "text/html,text/plain;q=0.9"},
                timeout=FETCH_TIMEOUT,
                allow_redirects=False,
                stream=True,
            )
        except requests.RequestException as error:
            raise FetchFailed(f"The page could not be reached: {error.__class__.__name__}.") from error
        try:
            if response.status_code in (301, 302, 303, 307, 308):
                location = response.headers.get("Location")
                if not location:
                    raise FetchFailed("The website redirected without a target address.")
                current = validate_public_url(urljoin(current, location), resolve)
                continue
            if response.status_code != 200:
                raise FetchFailed(f"The website answered with HTTP {response.status_code} (it may block automated reading).")
            content_type = response.headers.get("Content-Type", "").lower()
            if content_type and not any(kind in content_type for kind in ("text/html", "text/plain", "application/xhtml")):
                raise FetchFailed(f"The link is not a web page ({content_type.split(';')[0]}).")
            chunks, size = [], 0
            for chunk in response.iter_content(chunk_size=65536):
                size += len(chunk)
                if size > MAX_BYTES:
                    raise FetchFailed("The page is too large to read.")
                chunks.append(chunk)
            raw = b"".join(chunks)
            encoding = response.encoding or "utf-8"
            try:
                return current, raw.decode(encoding, errors="replace")
            except LookupError:
                return current, raw.decode("utf-8", errors="replace")
        finally:
            response.close()
    raise FetchFailed("The website redirected too many times.")


# ---------------------------------------------------------------- HTML → text
class _TextExtractor(HTMLParser):
    SKIP = {"script", "style", "noscript", "template", "svg", "iframe", "head"}
    BLOCK = {"p", "div", "br", "li", "h1", "h2", "h3", "h4", "h5", "h6", "tr", "section", "article", "td", "th", "pre"}

    def __init__(self) -> None:
        super().__init__(convert_charrefs=True)
        self.parts: list[str] = []
        self.skip_depth = 0
        self.in_title = False
        self.title = ""
        self.meta: dict[str, str] = {}

    def handle_starttag(self, tag, attrs):
        if tag == "meta":
            a = {k.lower(): (v or "") for k, v in attrs}
            key = (a.get("property") or a.get("name") or "").lower()
            if key and a.get("content"):
                self.meta.setdefault(key, a["content"].strip())
            return
        if tag == "title":
            self.in_title = True
        if tag in self.SKIP:
            self.skip_depth += 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self.in_title = False
        if tag in self.SKIP and self.skip_depth:
            self.skip_depth -= 1
        elif tag in self.BLOCK:
            self.parts.append("\n")

    def handle_data(self, data):
        if self.in_title:
            self.title += data
        if not self.skip_depth:
            self.parts.append(data)


def html_to_text(html: str) -> dict[str, Any]:
    parser = _TextExtractor()
    try:
        parser.feed(html)
        parser.close()
    except Exception:  # malformed HTML: keep what was parsed
        pass
    text = "".join(parser.parts).replace("\xa0", " ")
    text = re.sub(r"[ \t\r\f\v]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n", text).strip()
    meta = parser.meta
    return {
        "text": text,
        "title": (meta.get("og:title") or parser.title or "").strip() or None,
        "site": meta.get("og:site_name") or None,
        "published": meta.get("article:published_time") or meta.get("date") or meta.get("pubdate") or None,
    }


# ---------------------------------------------------------------- extraction
COMPASS = {
    "n": 0, "north": 0, "nne": 22.5, "northnortheast": 22.5, "ne": 45, "northeast": 45,
    "ene": 67.5, "eastnortheast": 67.5, "e": 90, "east": 90, "ese": 112.5, "eastsoutheast": 112.5,
    "se": 135, "southeast": 135, "sse": 157.5, "southsoutheast": 157.5, "s": 180, "south": 180,
    "ssw": 202.5, "southsouthwest": 202.5, "sw": 225, "southwest": 225, "wsw": 247.5,
    "westsouthwest": 247.5, "w": 270, "west": 270, "wnw": 292.5, "westnorthwest": 292.5,
    "nw": 315, "northwest": 315, "nnw": 337.5, "northnorthwest": 337.5,
    # Filipino
    "hilaga": 0, "hilagangsilangan": 45, "silangan": 90, "timogsilangan": 135,
    "timog": 180, "timogkanluran": 225, "kanluran": 270, "hilagangkanluran": 315,
}

_DIR_WORDS = r"(?i:(?:north|south|east|west)(?:[\s-]*(?:north|south|east|west)){0,2})"
_DIR = rf"(?:{_DIR_WORDS}|\b[NSEW]{{1,3}}\b)"
_FIL_DIR = r"(?i:hilagang[\s-]*silangan|hilagang[\s-]*kanluran|timog[\s-]*silangan|timog[\s-]*kanluran|hilaga|timog|silangan|kanluran)"
# Place names stay on one line (spaces only) and do not swallow a sentence's final period.
_PLACE = r"[A-Z][\w'’-]*(?:\.(?=\w))?(?:[ \t]+(?:de[ \t]+|del[ \t]+)?[A-Z][\w'’-]*){0,3}(?:,[ \t]*[A-Z][\w'’-]*(?:[ \t]+[A-Z][\w'’-]*){0,2})?"
_NUM = r"\d{1,3}(?:,\d{3})+|\d+"
_UNIT = r"(?i:km|kms|kilometers|kilometres|kilometro(?:ng)?|nautical\s+miles|nmi)"
NMI_KM = 1.852
# Open seas are too large to place a storm "near"; they only count with a direction.
OPEN_SEAS = {
    "philippine sea", "west philippine sea", "south china sea", "pacific ocean", "western pacific",
    "luzon strait", "bashi channel", "celebes sea", "sulu sea",
}

RE_STORM = re.compile(
    r"(?P<cat>(?i:super\s+typhoon|typhoon|severe\s+tropical\s+storm|tropical\s+storm|tropical\s+depression|bagyong))"
    r"\s+[\"“'‘#]?(?P<name>[A-Z][A-Za-z-]{2,})[\"”'’]?"
    r"(?:\s*\((?:international\s+name[:\s]+)?(?P<intl>[A-Z][A-Za-z-]{2,})\))?"
)
NOT_NAMES = {
    "signal", "signals", "warning", "warnings", "bulletin", "update", "updates", "advisory", "track",
    "information", "wind", "winds", "season", "the", "was", "has", "is", "will", "may", "and", "or",
    "category", "intensity", "news", "live", "alert", "outlook", "watch", "forecast",
    # month names and abbreviations ("Tropical Storm Nov. 9 update")
    "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec",
    "january", "february", "march", "april", "june", "july", "august", "september", "october",
    "november", "december",
}
RE_COORDS = [
    re.compile(r"(?P<lat>\d{1,2}(?:\.\d+)?)\s*°?\s*(?:N|North)\b\s*[,/]?\s*(?:and\s+)?(?P<lon>\d{2,3}(?:\.\d+)?)\s*°?\s*(?:E|East)\b"),
    re.compile(r"(?i:latitude)\s*(?P<lat>\d{1,2}(?:\.\d+)?)\s*°?\s*(?:N|North)?\s*,?\s*(?:and\s+)?(?i:longitude)\s*(?P<lon>\d{2,3}(?:\.\d+)?)\s*°?\s*(?:E|East)?"),
]
# "320 km East of Virac", "190 nautical miles east-northeast of Virac", "1,600 kilometers (km) east of ..."
RE_RELATIVE = re.compile(
    rf"(?P<km>{_NUM})\s*(?P<unit>{_UNIT})\s+(?:\([^)]{{1,12}}\)\s+)?(?P<dir>{_DIR})\s+(?i:of)\s+(?:the\s+)?(?P<place>{_PLACE})"
)
# Filipino: "120 km silangan ng Virac", "320 kilometro sa hilagang-silangan ng Aparri"
RE_RELATIVE_FIL = re.compile(
    rf"(?P<km>{_NUM})\s*(?P<unit>{_UNIT})\s+(?i:sa\s+)?(?P<dir>{_FIL_DIR})\s+(?i:ng\s+bayan\s+ng|ng|sa)\s+(?P<place>{_PLACE})"
)
# Over / near a named place: "over the coastal waters of Morong, Bataan", "made landfall in Casiguran",
# "in the vicinity of Hsinchu", "sa baybayin ng Morong", "nag-landfall sa Casiguran".
RE_NEAR_PLACE = [
    re.compile(
        r"(?P<how>(?i:over\s+the\s+(?:coastal\s+)?(?:waters|seas)\s+of|over\s+the\s+vicinity\s+of|in\s+the\s+vicinity\s+of"
        r"|off\s+the\s+coast\s+of|made\s+(?:its\s+)?(?:\w+\s+)?landfall\s+(?:in|over|at|near|on)|landfall\s+(?:in|over|at|near|on)))"
        rf"\s+(?:the\s+)?(?P<place>{_PLACE})"
    ),
    re.compile(
        r"(?P<how>(?i:(?:was|is)\s+(?:located|estimated|spotted|centered|last\s+seen|last\s+spotted)?\s*(?:over|near)))"
        rf"\s+(?P<place>{_PLACE})"
    ),
    re.compile(
        r"(?P<how>(?i:sa\s+(?:baybayin|karagatan|katubigan|bisinidad)\s+ng|nag-?landfall\s+sa|tumama\s+(?:ang\s+bagyo\s+)?sa|malapit\s+sa))"
        rf"\s+(?P<place>{_PLACE})"
    ),
]
# Forecast wording just before a place phrase: that is where the storm may go, not where it is.
RE_FORECAST_WORD = re.compile(
    r"(?i)\b(?:may|might|could|would|will|shall|expected|forecast(?:ed)?|projected|likely|possible|possibly|"
    r"predicted|anticipated|seen\s+to|set\s+to|poised|maaaring|inaasahang|posibleng)\b"
)


def _is_forecast(text: str, start: int) -> bool:
    """True when the sentence holding a place phrase talks about the future before that phrase."""
    sentence_start = max(text.rfind(". ", 0, start), text.rfind("\n", 0, start), text.rfind("? ", 0, start)) + 1
    return bool(RE_FORECAST_WORD.search(text[sentence_start:start]))
# Direction with no distance: "over the Philippine Sea east of Aurora", "silangan ng Samar".
RE_AREA = [
    re.compile(rf"(?<![\w,])(?P<dir>{_DIR_WORDS})\s+of\s+(?:the\s+)?(?P<place>{_PLACE})"),
    re.compile(rf"(?<![\w,])(?P<dir>{_FIL_DIR})\s+ng\s+(?P<place>{_PLACE})"),
]
RE_WIND = [
    re.compile(r"(?i)maximum\s+sustained\s+winds?\s+(?:of\s+)?(?:up\s+to\s+)?(?P<v>\d{2,3})\s*(?:km/?h|kph|kilometers\s+per\s+hour)"),
    re.compile(r"(?i)sustained\s+winds?\s+(?:of\s+)?(?:up\s+to\s+)?(?P<v>\d{2,3})\s*(?:km/?h|kph|kilometers\s+per\s+hour)"),
    re.compile(r"(?i)(?P<v>\d{2,3})\s*(?:km/?h|kph)\s+near\s+the\s+cent(?:er|re)"),
]
RE_GUST = [
    re.compile(r"(?i)gust(?:s|iness)?\s+(?:of\s+)?(?:up\s+to\s+|reaching\s+)?(?P<v>\d{2,3})\s*(?:km/?h|kph|kilometers\s+per\s+hour)"),
]
RE_MOVE = re.compile(
    rf"(?i)moving\s+(?P<dir>{_DIR_WORDS}|[NSEW]{{1,3}})(?:wards?)?(?:\s+(?:slowly|quickly|rapidly|steadily))?"
    r"(?:\s+(?:at|at\s+about|at\s+around|at\s+a\s+speed\s+of))?\s+(?P<v>\d{1,2})\s*(?:km/?h|kph|kilometers\s+per\s+hour)"
)
RE_MOVE_DIR = re.compile(rf"(?i)moving\s+(?P<dir>{_DIR_WORDS})wards?\b")
RE_STATIONARY = re.compile(r"(?i)\b(?:almost|nearly|quasi-?)\s*stationary\b")
RE_RADIUS = [
    (re.compile(r"(?i)winds?\s+extend(?:s|ing)?\s+(?:outwards?\s+)?(?:up\s+to\s+)?(?P<v>" + _NUM + r")\s*km\s+from\s+the\s+cent(?:er|re)"), "radius"),
    (re.compile(r"(?i)extent\s+of\s+(?:tropical\s+cyclone|tc)\s+winds?\D{0,40}?(?P<v>" + _NUM + r")\s*km"), "radius"),
    (re.compile(r"(?i)radius\s+of\s+(?:about\s+|around\s+|up\s+to\s+)?(?P<v>" + _NUM + r")\s*(?:km|kilometers|kilometres)"), "radius"),
    (re.compile(r"(?i)(?P<v>" + _NUM + r")[\s-]*(?:km|kilometers|kilometres)\s+radius"), "radius"),
    (re.compile(r"(?i)diameter\s+of\s+(?:about\s+|around\s+|up\s+to\s+)?(?P<v>" + _NUM + r")\s*(?:km|kilometers|kilometres)"), "diameter"),
    (re.compile(r"(?i)(?P<v>" + _NUM + r")[\s-]*(?:km|kilometers|kilometres)(?:[\s-]+wide|\s+diameter|\s+across)"), "diameter"),
]
RE_PRESSURE = re.compile(r"(?i)(?:central|minimum|sea[\s-]level)?\s*pressure\s+(?:of\s+)?(?P<v>\d{3,4})\s*(?:hPa|mb|millibars?)")
RE_ISSUED = re.compile(
    r"(?i)(?:issued|as\s+of|valid\s+as\s+of)\s+(?:at\s+)?(?P<v>\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)(?:[^.\n]{0,40}?\d{4})?)"
)


def _num(text: str) -> float:
    return float(text.replace(",", ""))


def _evidence(text: str, start: int, end: int, limit: int = 280) -> str:
    """The sentence (or line) around a match, trimmed for display."""
    left = max(text.rfind(". ", 0, start), text.rfind("\n", 0, start))
    left = 0 if left < 0 else left + 1
    right_candidates = [i for i in (text.find(". ", end), text.find("\n", end)) if i >= 0]
    right = min(right_candidates) + 1 if right_candidates else len(text)
    snippet = text[left:right].strip()
    if len(snippet) > limit:
        a = max(0, start - left - limit // 2)
        snippet = ("…" if a else "") + snippet[a:a + limit].strip() + "…"
    return snippet


def _bearing(word: str) -> float | None:
    key = re.sub(r"[\s-]+", "", word).lower()
    return COMPASS.get(key)


def _first(patterns, text):
    for pattern in patterns:
        match = pattern.search(text)
        if match:
            return match
    return None


def destination_point(lat: float, lon: float, bearing_deg: float, distance_km: float) -> tuple[float, float]:
    """Point at a distance and bearing from a start point (great circle)."""
    d = distance_km / EARTH_RADIUS_KM
    b = math.radians(bearing_deg)
    p1, l1 = math.radians(lat), math.radians(lon)
    p2 = math.asin(math.sin(p1) * math.cos(d) + math.cos(p1) * math.sin(d) * math.cos(b))
    l2 = l1 + math.atan2(math.sin(b) * math.sin(d) * math.cos(p1), math.cos(d) - math.sin(p1) * math.sin(p2))
    return round(math.degrees(p2), 3), round((math.degrees(l2) + 540) % 360 - 180, 3)


GEOCODE_TIMEOUT = (6, 20)  # the geocoder can take 5-10 s to answer from the Philippines
GEOCODE_ATTEMPTS = 3
_geocode_cache: dict[str, dict | None] = {}


def _geocode_request(session: Any, params: dict) -> list[dict]:
    """One geocoder query, retried. Raises GeocoderUnavailable when it cannot be reached."""
    last_error = None
    for _ in range(GEOCODE_ATTEMPTS):
        try:
            response = session.get(GEOCODING_URL, params=params, timeout=GEOCODE_TIMEOUT)
            response.raise_for_status()
            return response.json().get("results") or []
        except (requests.RequestException, ValueError) as error:
            last_error = error
    raise GeocoderUnavailable(f"Open-Meteo geocoder unreachable ({last_error.__class__.__name__}).")


def geocode_place(place: str, session: Any = requests) -> dict[str, Any] | None:
    """Locate a named place with the Open-Meteo Geocoding API (Philippines first).

    Returns None when the place is not found; raises GeocoderUnavailable
    when the service cannot be reached. Answers are remembered for the life
    of the server (place coordinates do not change).
    """
    key = place.strip().lower()
    if key in _geocode_cache:
        return _geocode_cache[key]
    found = _geocode_lookup(place, session)
    _geocode_cache[key] = found
    return found


def _name_variants(name: str) -> list[str]:
    """'Borongan City' and 'City of Borongan' are listed as 'Borongan' in GeoNames."""
    variants = [name]
    bare = re.sub(r"^(?i:city\s+of)\s+|\s+(?i:city)$", "", name).strip()
    if bare and bare != name:
        variants.append(bare)
    return variants


def _geocode_lookup(place: str, session: Any) -> dict[str, Any] | None:
    name, _, hint = place.partition(",")
    name, hint = name.strip(), hint.strip().lower()
    attempts = [(variant, params) for variant in _name_variants(name) for params in ({"countryCode": "PH"}, {})]
    for variant, params in attempts:
        results = _geocode_request(session, {"name": variant, "count": 10, "language": "en", "format": "json", **params})
        if not results:
            continue
        chosen = results[0]
        if hint:
            for item in results:
                admin = " ".join(str(item.get(k) or "") for k in ("admin1", "admin2", "admin3")).lower()
                if hint in admin:
                    chosen = item
                    break
        return {
            "query": place,
            "name": chosen.get("name"),
            "admin1": chosen.get("admin1"),
            "country": chosen.get("country"),
            "latitude": chosen.get("latitude"),
            "longitude": chosen.get("longitude"),
            "source": "Open-Meteo Geocoding API (GeoNames)",
        }
    return None


def _clean_place(raw: str) -> str:
    return re.sub(r"\s+", " ", raw).strip().rstrip(".,")


def _relative_matches(text: str) -> list[dict[str, Any]]:
    """Every "distance + direction + place" phrase (English and Filipino), in text order."""
    found = []
    for pattern in (RE_RELATIVE, RE_RELATIVE_FIL):
        for match in pattern.finditer(text):
            bearing = _bearing(match.group("dir"))
            if bearing is None:
                continue
            amount = _num(match.group("km"))
            nautical = bool(re.match(r"(?i)nautical|nmi", match.group("unit")))
            found.append({
                "start": match.start(),
                "distance_km": round(amount * NMI_KM, 1) if nautical else amount,
                "distance_stated": f"{match.group('km')} nautical miles" if nautical else None,
                "direction": re.sub(r"\s+", " ", match.group("dir")).strip(),
                "bearing_deg": bearing,
                "place": _clean_place(match.group("place")),
                "evidence": _evidence(text, match.start(), match.end()),
            })
    return sorted(found, key=lambda r: r["start"])


def _find_position(text: str, geocode: Callable[[str], dict | None]) -> tuple[dict | None, dict | None, str | None]:
    """
    The storm's position from the text, most precise form first:
      1. coordinates written in the article                         -> method "coordinates"
      2. distance + direction from a place (km or nautical miles)   -> method "relative"
      3. over / near / landfall at a named place                    -> method "place" (approximate)
      4. direction from a place with no distance                    -> no position; an "area" only
    Returns (position, area, note). Nothing is estimated beyond what the text states.
    """
    notes: list[str] = []
    geocoder_down = False

    def locate(place: str):
        nonlocal geocoder_down
        try:
            return geocode(place)
        except GeocoderUnavailable:
            geocoder_down = True
            return None

    # 1. Coordinates.
    for pattern in RE_COORDS:
        for match in pattern.finditer(text):
            lat, lon = float(match.group("lat")), float(match.group("lon"))
            if 0 < lat <= 60 and 90 <= lon <= 180:
                position = {"latitude": lat, "longitude": lon, "method": "coordinates", "evidence": _evidence(text, match.start(), match.end())}
                relatives = _relative_matches(text)
                if relatives:
                    position["relative"] = {k: v for k, v in relatives[0].items() if k != "start"}
                return position, None, None

    # 2. Distance + direction from a place.
    for relative in _relative_matches(text):
        place = locate(relative["place"])
        if place and place.get("latitude") is not None:
            lat, lon = destination_point(place["latitude"], place["longitude"], relative["bearing_deg"], relative["distance_km"])
            rel = {k: v for k, v in relative.items() if k != "start"}
            return {"latitude": lat, "longitude": lon, "method": "relative", "relative": rel, "geocode": place, "evidence": relative["evidence"]}, None, None
        notes.append(f"“{relative['place']}”")

    # 3. Over / near / landfall at a named place (not forecasts like "may make landfall over ...").
    for pattern in RE_NEAR_PLACE:
        for match in pattern.finditer(text):
            name = _clean_place(match.group("place"))
            if name.lower() in OPEN_SEAS or _is_forecast(text, match.start()):
                continue
            place = locate(name)
            if place and place.get("latitude") is not None:
                return {
                    "latitude": round(place["latitude"], 3), "longitude": round(place["longitude"], 3),
                    "method": "place", "approximate": True,
                    "near": {"place": name, "how": re.sub(r"\s+", " ", match.group("how")).strip().lower()},
                    "geocode": place, "evidence": _evidence(text, match.start(), match.end()),
                }, None, None
            notes.append(f"“{name}”")

    # 4. Direction from a place, no distance: no position, only the direction.
    for pattern in RE_AREA:
        for match in pattern.finditer(text):
            before = text[max(0, match.start() - 30):match.start()]
            if re.search(rf"\d\s*{_UNIT}\s*(?:\([^)]*\)\s*)?$", before):
                continue  # part of a distance phrase handled above
            bearing = _bearing(match.group("dir"))
            name = _clean_place(match.group("place"))
            if bearing is None or name.lower() in OPEN_SEAS or _is_forecast(text, match.start()):
                continue
            place = locate(name)
            area = {
                "direction": re.sub(r"\s+", " ", match.group("dir")).strip(), "bearing_deg": bearing,
                "place": name, "geocode": place if place and place.get("latitude") is not None else None,
                "evidence": _evidence(text, match.start(), match.end()),
            }
            note = (f"The article only says the storm is {area['direction']} of {name}, without a distance, "
                    "so AGOS cannot place it on the map." + ("" if area["geocode"] else f" “{name}” could not be located either."))
            return None, area, note

    if geocoder_down:
        return None, None, ("The article places the storm relative to a named place, but the place-name lookup "
                            "(Open-Meteo geocoder) could not be reached. Try again in a moment.")
    if notes:
        return None, None, f"The article places the storm relative to {', '.join(dict.fromkeys(notes))}, but the geocoder found no place with that name."
    return None, None, "The article does not state the storm’s coordinates, its distance from a named place, or a place it is over."


HEADLINE_NOT_NAMES = NOT_NAMES | {
    "signal", "super", "typhoon", "tropical", "severe", "storm", "depression", "bagyong", "pagasa", "state",
    "weather", "low", "pressure", "area", "more", "heavy", "rains", "rain", "flood", "floods", "classes",
    "suspension", "residents", "philippines", "luzon", "visayas", "mindanao", "metro", "manila", "breaking",
}


def _headline_storm_name(title: str | None, text: str) -> str | None:
    """
    The storm name when a headline starts with it ("Pepito rapidly intensifies into typhoon")
    but the article never writes "Typhoon Pepito". The word must appear at least 3 times in
    the article. None when the headline does not start that way.
    """
    if not title:
        return None
    first = re.match(r"\s*[\"“'‘#]?([A-Z][a-z]{3,})\b", title)
    if not first or first.group(1).lower() in HEADLINE_NOT_NAMES:
        return None
    word = first.group(1)
    return word if len(re.findall(rf"\b{word}\b", text)) >= 3 else None


def extract_typhoon(
    text: str,
    geocode: Callable[[str], dict | None] = geocode_place,
    title: str | None = None,
) -> dict[str, Any]:
    """Pick out the storm characteristics the text states. Missing values stay None."""
    result: dict[str, Any] = {
        "storm": None, "position": None, "area": None, "position_note": None, "max_wind_kmh": None, "gust_kmh": None,
        "movement": None, "radius_km": None, "pressure_hpa": None, "bulletin_time": None,
    }

    def clean_name(raw: str) -> str:
        name = raw.strip("-")
        if len(name) > 4 and name.endswith("PH") and name[:-2][-1:].islower():  # hashtag form "#PepitoPH"
            name = name[:-2]
        return name.title() if name.isupper() else name

    candidates = [m for m in RE_STORM.finditer(text) if m.group("name").lower() not in NOT_NAMES]
    # Pages often mention other storms in sidebars or "related" links: prefer a storm named in the headline.
    headline = (title or "").lower()
    in_title = [m for m in candidates if clean_name(m.group("name")).lower() in headline]
    headline_name = None if in_title else _headline_storm_name(title, text)
    match = None if headline_name else (in_title or candidates or [None])[0]
    if headline_name:
        first = re.search(rf"\b{re.escape(headline_name)}\b", text)
        result["storm"] = {
            "name": headline_name,
            "category": None,  # the article does not write "Typhoon <name>", so it is not guessed
            "international_name": None,
            "evidence": _evidence(text, first.start(), first.end()) if first else title,
        }
    if match:
        category = re.sub(r"\s+", " ", match.group("cat")).strip().title()
        result["storm"] = {
            "name": clean_name(match.group("name")),
            "category": "Tropical cyclone (Filipino: Bagyong)" if category == "Bagyong" else category,
            "international_name": match.group("intl"),
            "evidence": _evidence(text, match.start(), match.end()),
        }

    result["position"], result["area"], result["position_note"] = _find_position(text, geocode)

    match = _first(RE_WIND, text)
    if match:
        result["max_wind_kmh"] = {"value": int(match.group("v")), "evidence": _evidence(text, match.start(), match.end())}
    match = _first(RE_GUST, text)
    if match:
        result["gust_kmh"] = {"value": int(match.group("v")), "evidence": _evidence(text, match.start(), match.end())}

    match = RE_MOVE.search(text)
    if match:
        direction = re.sub(r"\s+", " ", match.group("dir")).strip()
        result["movement"] = {
            "direction": direction, "bearing_deg": _bearing(direction), "speed_kmh": int(match.group("v")),
            "stationary": False, "evidence": _evidence(text, match.start(), match.end()),
        }
    elif match := RE_MOVE_DIR.search(text):
        direction = re.sub(r"\s+", " ", match.group("dir")).strip()
        result["movement"] = {
            "direction": direction, "bearing_deg": _bearing(direction), "speed_kmh": None,
            "stationary": False, "evidence": _evidence(text, match.start(), match.end()),
        }
    else:
        match = RE_STATIONARY.search(text)
        if match:
            result["movement"] = {
                "direction": None, "bearing_deg": None, "speed_kmh": None,
                "stationary": True, "evidence": _evidence(text, match.start(), match.end()),
            }

    for pattern, basis in RE_RADIUS:
        match = pattern.search(text)
        if match:
            value = _num(match.group("v"))
            radius = value / 2 if basis == "diameter" else value
            if 10 <= radius <= 2000:
                result["radius_km"] = {
                    "value": radius,
                    "basis": "half of the stated diameter" if basis == "diameter" else "stated wind-extent radius",
                    "evidence": _evidence(text, match.start(), match.end()),
                }
                break

    match = RE_PRESSURE.search(text)
    if match and 850 <= int(match.group("v")) <= 1020:
        result["pressure_hpa"] = {"value": int(match.group("v")), "evidence": _evidence(text, match.start(), match.end())}

    match = RE_ISSUED.search(text)
    if match:
        result["bulletin_time"] = {"text": match.group("v").strip(), "evidence": _evidence(text, match.start(), match.end())}

    return result


def typhoon_from_url(
    url: str,
    fetch: Callable[[str], tuple[str, str]] = fetch_page,
    geocode: Callable[[str], dict | None] = geocode_place,
) -> dict[str, Any]:
    final_url, html = fetch(url)
    page = html_to_text(html)
    found = extract_typhoon(page["text"], geocode=geocode, title=page["title"])
    found_any = any(found[key] for key in ("storm", "position", "area", "max_wind_kmh", "radius_km", "movement"))
    return {
        "url": url,
        "final_url": final_url,
        "fetched_at": datetime.now(timezone.utc).isoformat(timespec="seconds"),
        "article": {"title": page["title"], "site": page["site"] or urlsplit(final_url).hostname, "published": page["published"]},
        "found": found_any,
        **found,
        "note": SOURCE_NOTE,
    }
