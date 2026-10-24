# Vendored frontend libraries

Files here are served with the site, so AGOS does not depend on a CDN at runtime.

| Library | Version | Licence | Files | Notes |
|---|---|---|---|---|
| Inter (font) | 4.0 (Debian `fonts-inter`) | OFL-1.1 | `fonts/inter/*.woff` (~124 KB, Latin subset, 4 weights) | Subset with `pyftsubset`. Licence in `fonts/inter/LICENSE.txt`. |
| Tabler Icons | 3.2.0 | MIT | inlined in `app/js/core/icons.js` (~9 KB, 52 icons) | Extracted from react-icons 5.7.0 (MIT). |
| MapLibre GL JS | 5.6.2 | BSD-3-Clause | `maplibre-gl/` | **Run `python frontend/tools/vendor_maplibre.py` once and commit the result.** Until then the app falls back to the pinned unpkg URL for this exact version. |

Charts are drawn with a small built-in SVG module (`app/js/core/charts.js`), so
no chart library is needed. Native HTML controls (`<dialog>`, switches, range
sliders) replace a component library.
