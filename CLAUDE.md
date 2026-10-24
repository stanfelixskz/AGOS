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
  app/routes/            weather, rainfall, reports (community), system
  app/services/          weather_service, rainfall_grid_service, scheduler,
                         report_service (satellite; not wired, do not touch)
  app/config/settings.py loads backend/.env
  agos_data_lifecycle.py SQLite ingest/analytics/validation (/data-lifecycle/*)
  tests/                 unit + API smoke tests
frontend/
  index.html, js/*.js, css/*.css   static site; js/config.js sets the API URL
```

## Run and test (from `backend/`)

```
pip install -r requirements-dev.txt
python -m pytest
uvicorn app.main:app --reload          # http://127.0.0.1:8000/docs
```
Frontend: `cd frontend; python -m http.server 5500` then open http://localhost:5500.
Windows PowerShell: activate the venv with `.\.venv\Scripts\Activate.ps1`
(run `Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass` first if blocked).
`backend/.env` already exists on the owner's machine: never overwrite it.

(Tests, `requirements-dev.txt`, `js/config.js` and the scheduler arrive with the
Phase 0 pull request; they may not be on `master` yet.)

## Not in the repo (intentional)

- `frontend/data/`: municipality and province GeoJSON, `flood-data.json`,
  `evacuation-centers.json`, terrain tiles under `tiles/`.
- Sentinel/SAR/DEM processing outputs and scripts, `.tif`, `.qgz`.
- `backend/.env`, `backend/data/` (reports, photos, SQLite).

## Known gaps (do not assume these work)

- Evacuation directory (hardcoded in `evacuation.js`) and the map layer
  (`data/evacuation-centers.json`) use different sources.
- Analytics page calls Open-Meteo from the browser, not the project database.
- CORS allows all origins; restrict before public deployment.
- Repo default branch on GitHub is `main` (nearly empty); real code is on `master`.

## Roadmap

The phased upgrade plan and codebase overview are kept in the claude.ai Project
"AGOS — Flood Intelligence System" (docs `claude/agos-upgrade-plan.md` and
`claude/agos-codebase-overview.md`). Phase 1 (explainable map: legends, PAGASA
rainfall levels, municipality detail panel, rain time slider, forecast accuracy,
tide/low-lying scenarios) follows Phase 0 (foundation).
