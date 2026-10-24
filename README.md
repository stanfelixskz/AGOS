# AGOS — Flood Intelligence System for Bataan

**An Analytics-Driven Geospatial Observation and Flood Support System** for the
Province of Bataan, Philippines. AGOS shows weather and rainfall forecasts,
modeled river discharge, flood susceptibility, evacuation centers and
community flood reports on an interactive map.

> **Prototype.** AGOS is a decision-support and learning project. It is **not**
> an official warning system. For official warnings use PAGASA, NDRRMC and your
> local DRRMO.

## What is in this repository

```
backend/    FastAPI API, SQLite data pipeline, tests
frontend/   Static site (HTML, CSS, vanilla JS, MapLibre GL). No build step.
```

| Area | What it does |
|---|---|
| Weather & forecast | `/weather`, `/weather/forecast-grid`, `/weather/forecast-series`, `/weather/rainfall-outlook` (Open-Meteo, cached 15 min) |
| Flood outlook | `/weather/flood-outlook` — modeled river discharge (Open-Meteo Flood API / GloFAS) |
| Current conditions | `/weather/grid` — WeatherAPI.com, **one** reference point in Balanga (needs an API key) |
| Community reports | `/reports/community` (submit, photo upload), `/reports`, `/reports/{id}` |
| Data lifecycle | `/data-lifecycle/*` — ingest history into SQLite, daily analytics, validation |
| System status | `/system/status` — scheduler state, database stats, config checks |
| Map | MGB flood susceptibility, rainfall tiles, terrain layers, municipalities, evacuation centers |
| Map legend | "Layers and legend" panel: every layer with a checkbox, color key and "Why these colors?" (source, freshness, limits) |

## Run it locally

You need **Python 3.10 or newer** and any static file server.

```bash
# 1. Backend
cd backend
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env               # Windows: copy .env.example .env
# edit .env and add your WEATHERAPI_API_KEY (optional, see below)
uvicorn app.main:app --reload      # http://127.0.0.1:8000  (API docs at /docs)

# 2. Frontend (new terminal)
cd frontend
python -m http.server 5500         # open http://localhost:5500
```

Pages opened from `localhost`, `127.0.0.1` or `file://` automatically talk to
`http://127.0.0.1:8000`.

### Configuration

All backend settings live in `backend/.env` (never committed). See
`backend/.env.example` for every option.

| Variable | Purpose |
|---|---|
| `WEATHERAPI_API_KEY` | Free key from weatherapi.com. Without it `/weather/grid` returns a clear error; everything else still works. |
| `AGOS_DATA_DIR` | Where the SQLite database is stored (default `backend/data`). |
| `AGOS_SCHEDULER_ENABLED` | `true` turns on automatic data refresh (default `false`). |
| `AGOS_INGEST_INTERVAL_HOURS` | Hours between refreshes (default 6, minimum 1). |
| `AGOS_INGEST_LOOKBACK_DAYS` | Days re-ingested each refresh (default 7, max 30). |

### Automatic data refresh

With `AGOS_SCHEDULER_ENABLED=true`, a background job fetches recent daily weather
and modeled river discharge for all 12 municipalities and stores them in SQLite.
Failures are recorded in `/system/status`, never hidden. Run **one** uvicorn
worker when this is on.

### Deploying

Edit `DEPLOYED_API_BASE` in `frontend/js/config.js` to your backend's public URL
(leave empty if the backend serves the frontend). Set secrets in your host's
environment settings, not in the repository. CORS currently allows all origins;
restrict `allow_origins` in `backend/app/main.py` before going public.

## Tests

```bash
cd backend
pip install -r requirements-dev.txt
python -m pytest            # or: python -m unittest discover -s tests -t .
```

Tests use no network. API smoke tests are skipped automatically if FastAPI or
httpx is not installed.

Frontend (needs Node 20+; no packages to install):

```bash
node --test frontend/tests/map-legend.test.js
```

This checks that the map legend (`frontend/js/map-legend.js`) still matches the
layer ids and colors used in `frontend/js/map.js`.

## Data sources and honest limits

- **Open-Meteo** forecasts, historical weather and the flood API are **model
  output**, not rain-gauge or river-gauge readings.
- **GloFAS river discharge** is modeled for the nearest grid cell and may not
  match a specific local river.
- **WeatherAPI.com** current conditions are for one point in Balanga, not a grid.
- **MGB flood susceptibility** is a baseline hazard layer, not a live prediction.
- **Community reports** are unverified until reviewed.
- **Evacuation centers**: locations come from public map listings; capacity and
  operating status are unverified.

AGOS never invents data. When a source is unavailable the interface says so.

## Data files not included in this repository

Some GIS datasets and research files are intentionally excluded. The map
expects these under `frontend/data/` and reports them as unavailable when absent:

- `bataan-municipalities.geojson`, `bataan_province_boundary.geojson`
- `flood-data.json`, `evacuation-centers.json`
- `tiles/elevation/`, `tiles/slope/`, `tiles/flow_accumulation/` (`{z}/{x}/{y}.png`)

Runtime data (`backend/data/`: community reports, photos, SQLite database) is
git-ignored because it can contain personal information such as contact numbers.

## Contributing workflow

Work on a branch (for example `claude/...` or `feature/...`), open a pull
request and merge into `master` after review.
