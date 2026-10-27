# AGOS — project instructions for Claude

AGOS is an Analytics-Driven Geospatial Observation and Flood Support System for
the Province of Bataan, Philippines: an interactive flood map, weather and
rainfall visualization, flood-related analytics, evacuation centers and
community flood reports. Stack: HTML/CSS/vanilla JS + MapLibre GL (frontend),
Python + FastAPI + SQLite (backend). Owner: stanfelixskz. Code lives on `master`.

## Working rules

1. **Inspect before changing.** Read the relevant files fully before editing.
   Say what is already implemented and what is missing.
2. **Preserve the architecture.** No rewrites, no framework swaps, no build step
   unless asked. Small, reviewable changes that do not break working parts.
3. **Never invent data.** Do not fabricate values, coordinates, capacities,
   rainfall, flood extents or evidence to make a feature look functional. If a
   source is unavailable, the interface must say so.
4. **Missing data is not a bug.** Some GIS datasets and research files are
   intentionally excluded from the repo (see "Not in the repo"). Report them as
   missing data assets, separate from code problems.
5. **Label every number and color** with its source and date. Open-Meteo values
   are model output, not gauge readings; GloFAS discharge is modeled; community
   reports are unverified; evacuation capacity/status is unverified.
6. **Do not touch the satellite work** (`report_service.py`, Sentinel-1/2
   processing, candidate-zone overlays, the SAR/DEM scripts) unless the owner
   explicitly asks. It will be planned separately.
7. **Git workflow.** Work on a branch (`claude/<topic>`), open a pull request
   into `master`. Merge only when the owner says so. Never force-push. Never
   commit secrets, `backend/.env`, `backend/data/`, SQLite files, uploaded
   photos, or large raster/satellite files. Check `git status` before
   committing and stage files by name, not `git add .`.
8. **Be honest about verification.** State what was run and what was only read.

## Layout

```
backend/
  app/main.py            FastAPI app, routers, startup scheduler
  app/routes/            weather, rainfall, reports (community), system,
                         skill (/skill/rain), api (/api/* for the interface)
  app/services/          weather_service, overview_service (levels, alerts,
                         briefing, town detail), history_service,
                         forecast_store, forecast_skill, scheduler,
                         rainfall_grid_service,
                         report_service (satellite; not wired, do not touch)
  app/data/              municipality points, evacuation_centers.json
  app/config/settings.py loads backend/.env
  agos_data_lifecycle.py SQLite ingest/analytics/validation (/data-lifecycle/*)
  tests/                 unit + API smoke tests
frontend/
  index.html             app shell (hash routes #/overview, #/map, ...)
  js/config.js           sets the API URL (window.AGOS_CONFIG.apiBase)
  app/css/agos.css       the only stylesheet (design tokens, components)
  app/js/main.js         navigation, routing, theme, language, backend badge
  app/js/core/           api, i18n (en + fil), format, levels, charts, icons,
                         explain ("why" dialogs), sources registry, router, ui
  app/js/map/            MapLibre loader + map engine (HTML markers, no glyphs)
  app/js/views/          one module per page; parts/muni-detail.js is shared
  app/data/              Bataan municipal boundaries (PSGC 2023) + licence
  app/tests/             node tests (run from frontend/app)
  vendor/                Inter font, MapLibre (see vendor/README.md)
  tools/vendor_maplibre.py  downloads MapLibre into vendor/
```

## Run and test (from `backend/`)

```
pip install -r requirements-dev.txt
python -m pytest
uvicorn app.main:app --reload          # http://127.0.0.1:8000/docs
```
Frontend: `cd frontend; python -m http.server 5500` then open http://localhost:5500.
Frontend tests: `cd frontend/app; node --test tests/*.test.js`.
Every interface text must exist in English and Filipino (`app/js/core/i18n.js`);
rain-level thresholds live in `backend/app/services/overview_service.py` and
`app/js/core/levels.js` (a test keeps them equal).
Windows PowerShell: activate the venv with `.\.venv\Scripts\Activate.ps1`
(run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first if blocked).
`backend/.env` already exists on the owner's machine: never overwrite it.

## Not in the repo (intentional)

- `frontend/data/` (local GIS files on the owner's laptop). Municipal boundaries are now in
  the repo: `frontend/app/data/bataan-municipalities-psgc2023.geojson` (PSGC 2023, from
  faeldon/philippines-json-maps, MIT).
- Sentinel/SAR/DEM processing outputs and scripts, `.tif`, `.qgz`.
- `backend/.env`, `backend/data/` (reports, photos, SQLite).

## Known gaps (do not assume these work)

- Evacuation centers: 12 records in `backend/app/data/evacuation_centers.json`;
  capacity and status are not provided by any source.
- Community reports have no review/admin screen yet (all show "unverified").
- Flood chance (`flood_chance_model_service`) is a count of past cases, low confidence; it needs
  `backend/data/chance_model.json`, built offline with `backend/tools/build_chance_model.py`.
  Tide and storms were tested and do not improve it (see project doc `claude/agos-tide-storm-plan.md`).
- CORS allows all origins; restrict before public deployment.
- Repo default branch on GitHub is `main` (nearly empty); real code is on `master`.

## Roadmap

The phased upgrade plan and codebase overview are kept in the claude.ai Project
"AGOS — Flood Intelligence System" (docs `claude/agos-upgrade-plan.md` and
`claude/agos-codebase-overview.md`). The redesign
(`claude/agos-redesign-plan.md`, `claude/agos-redesign-prompt.md`) replaced the
old one-page interface; next are flood susceptibility
(`claude/agos-flood-susceptibility-stages.md`) and tide/low-lying scenarios.
