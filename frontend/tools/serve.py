"""
Local development server for the AGOS frontend that tells the browser not to
cache files. The plain `python -m http.server` lets browsers keep old copies
of the page scripts (especially pages loaded later, like Analytics), so a
change can stay invisible even after a reload.

Run from the frontend folder:

    python tools/serve.py            # http://localhost:5500
    python tools/serve.py 5501       # another port
"""

import http.server
import os
import sys
from functools import partial


class NoCacheHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        self.send_header("Expires", "0")
        super().end_headers()


def main() -> None:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5500
    root = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # the frontend folder
    handler = partial(NoCacheHandler, directory=root)
    with http.server.ThreadingHTTPServer(("", port), handler) as server:
        print(f"AGOS frontend on http://localhost:{port} (no browser caching). Ctrl+C to stop.")
        server.serve_forever()


if __name__ == "__main__":
    main()
