"""
Download MapLibre GL JS into frontend/vendor/maplibre-gl/ so the map works
without a CDN at runtime. Run once from the repo root, then commit the files:

    python frontend/tools/vendor_maplibre.py

Uses only the Python standard library. Prints SHA-256 checksums and writes
them to VERSION.txt so later changes are visible in review.
"""

import hashlib
import sys
import urllib.request
from pathlib import Path

VERSION = "5.6.2"  # same version the previous interface used
BASE = f"https://unpkg.com/maplibre-gl@{VERSION}"
FILES = {
    "maplibre-gl.js": f"{BASE}/dist/maplibre-gl.js",
    "maplibre-gl.css": f"{BASE}/dist/maplibre-gl.css",
    "LICENSE.txt": f"{BASE}/LICENSE.txt",
}

target = Path(__file__).resolve().parents[1] / "vendor" / "maplibre-gl"
target.mkdir(parents=True, exist_ok=True)
lines = [f"maplibre-gl {VERSION} (BSD-3-Clause), downloaded from unpkg.com"]

for name, url in FILES.items():
    print(f"Downloading {url}")
    try:
        with urllib.request.urlopen(url, timeout=60) as response:
            data = response.read()
    except Exception as error:  # noqa: BLE001
        sys.exit(f"Failed to download {url}: {error}")
    (target / name).write_bytes(data)
    digest = hashlib.sha256(data).hexdigest()
    lines.append(f"{digest}  {name}  ({len(data)} bytes)")
    print(f"  saved {name}: {len(data)} bytes, sha256 {digest}")

(target / "VERSION.txt").write_text("\n".join(lines) + "\n", encoding="utf-8")
print(f"Done. Files are in {target}. Commit them so the map needs no CDN.")
