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
| Interface API | `/api/overview` (rain levels, alerts, briefing), `/api/municipalities[/{name}]`, `/api/evacuation-centers`, `/api/history` |
| Forecast accuracy | `/skill/rain` — saved day-ahead forecasts vs archive rainfall |

### Interface pages (frontend/index.html, hash routes)

| Page | What it answers |
|---|---|
| `#/overview` | Is my area safe now? Briefing (English/Filipino), rain alerts, towns ranked, small map |
| `#/map` | Full map: rain level by town (peak or hour by hour, 48 h), MGB susceptibility, precipitation tiles, evacuation centers, reports; details drawer |
| `#/municipality/<name>` | Everything about one town, shareable |
| `#/analytics` | Daily history from the AGOS database and forecast accuracy |
| `#/evacuate` | Nearest listed evacuation center (straight-line), directions |
| `#/report` | Submit a flood report; recent reports |
| `#/sources` | Every data source, live system status, method and limits |

## How to Start AGOS (Windows PowerShell)

AGOS needs **two PowerShell windows open at the same time**: one for the
backend (Terminal 1) and one for the frontend (Terminal 2). If you only
start one, the website will not work properly.

### Step 1 — Start the Backend (Terminal 1)

Open PowerShell, then run:

1. Go to the backend folder:

```powershell
cd "$HOME\OneDrive\Desktop\AGOS\backend"
```

2. Activate the virtual environment. If PowerShell blocks script execution,
   first run this (it only affects the current window):

```powershell
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
```

Then activate:

```powershell
.\.venv\Scripts\Activate.ps1
```

The prompt should now start with `(.venv)`. If it does not, the environment is
not active; run the activate command again.

3. Start FastAPI:

```powershell
python -m uvicorn app.main:app --reload
```

The backend runs at <http://127.0.0.1:8000> and the API documentation is at
<http://127.0.0.1:8000/docs>.

**Keep this terminal open.** To stop the backend, click this window and press
`Ctrl+C`.

### Step 2 — Start the Frontend (Terminal 2)

Open a **second** PowerShell window. Do not close or stop Terminal 1.

1. Go to the frontend folder:

```powershell
cd "$HOME\OneDrive\Desktop\AGOS\frontend"
```

2. Start the frontend server:

```powershell
python -m http.server 5500
```

Open <http://localhost:5500> in your browser. The frontend and the backend must
run at the same time, each in its own terminal. To stop the frontend, click
Terminal 2 and press `Ctrl+C`.

### Step 3 — Verify AGOS

- [ ] The backend starts without errors (Terminal 1 shows "Uvicorn running").
- [ ] The API documentation opens at <http://127.0.0.1:8000/docs>.
- [ ] The frontend website loads at <http://localhost:5500>.
- [ ] **Overview** opens (`#/overview`).
- [ ] **Map** opens (`#/map`).
- [ ] **Report** opens (`#/report`).
- [ ] **Evacuate** opens (`#/evacuate`).

Some map layers may be missing. This is expected: the local GIS datasets
(`frontend/data/`) are intentionally not included in the GitHub repository. A
missing data file is not a code error; the interface says when a layer is
unavailable.

## Keep AGOS Collecting Data Every Hour (Windows)

AGOS can save a fresh weather forecast for all 12 towns every hour. These
saved forecasts are what the forecast accuracy numbers and later analytics are
built from, so every hour the backend is off is data that cannot be recovered.
This is optional, and it only works while the backend is running.

### 1. Turn it on in `backend/.env`

Add these two lines (keep your existing lines, such as `WEATHERAPI_API_KEY`):

```
AGOS_SCHEDULER_ENABLED=true
AGOS_INGEST_INTERVAL_HOURS=1
```

Never commit `backend/.env`.

### 2. Run the backend in its own PowerShell window

Do not run it inside VS Code: it stops when VS Code closes. Open PowerShell from
the Start menu, then:

```powershell
cd "$HOME\OneDrive\Desktop\AGOS\backend"
Set-ExecutionPolicy -Scope Process -ExecutionPolicy Bypass
.\.venv\Scripts\Activate.ps1
python -m uvicorn app.main:app
```

Use **no `--reload`** and a single worker, because the scheduler runs inside the
backend process. Keep the window open (minimizing is fine). Do not click or
select text inside it: in classic Windows consoles that pauses the server until
you press Esc or Enter.

### 3. Stop Windows from sleeping

Collection stops while the PC sleeps or hibernates. Keep the laptop plugged in
and run once in PowerShell:

```powershell
powercfg /change standby-timeout-ac 0
powercfg /change hibernate-timeout-ac 0
```

Then set Control Panel, Power Options, "Choose what closing the lid does", "When
I close the lid" to **Do nothing** (plugged in). Turning the display off is fine.
On battery the laptop can still sleep.

### 4. Check that it is working

Open <http://127.0.0.1:8000/system/status>:

- `scheduler.interval_hours` should be `1.0`.
- `scheduler.last_finished_at` should be within the last hour.
- `stored_forecasts.runs` should grow by 12 each hour (one snapshot per town).
- Failures are listed under `scheduler.last_summary.errors`; they are never hidden.

After a restart or shutdown, start the backend again by hand (step 2). Nothing
starts it automatically. If the project folder is inside OneDrive and you ever
see "database is locked", pause OneDrive sync for the `backend/data` folder.

## Fill In Past Years of Data (backfill)

The hourly collector only keeps recent days. To give Analytics years of history,
run the backfill once (the backend can stay running). It fetches daily rain,
temperature and wind (Open-Meteo / ERA5 reanalysis, from 1940) and modeled river
discharge (GloFAS, from 1984) for the 12 towns, one request per town, source and
year, newest years first. These are gridded model values, not gauge readings.

```powershell
cd "$HOME\OneDrive\Desktop\AGOS\backend"
.\.venv\Scripts\Activate.ps1
python tools/backfill_history.py --dry-run --from-year 2015   # plan and estimate, no requests
python tools/backfill_history.py --from-year 2015             # first stage (about 1 hour)
python tools/backfill_history.py --from-year 1990             # later: the older years
python tools/backfill_history.py --status                     # what the database holds
```

It is safe to run again and again: finished years are skipped. If Open-Meteo's
hourly or daily limit is reached it stops and says so; run it again later. It
shares that limit with the hourly collection, so do not run it together with a
terrain build. The database lives in `backend/data/` and is never committed.

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
cd frontend/app
node --test tests/*.test.js
```

These cover formatting, routing, the API client, translations (every English
text has a Filipino one), charts, and that the rain-level thresholds and colors
match the backend.

MapLibre is loaded from `frontend/vendor/maplibre-gl/` and falls back to a
pinned CDN copy. To vendor it once (then commit the files):

```bash
python frontend/tools/vendor_maplibre.py
```

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

- Local GIS working files (DEM, rasters, research outputs).

Municipal boundaries are included in the repository:
`frontend/app/data/bataan-municipalities-psgc2023.geojson` — the 12 Bataan
municipalities with PSA PSGC codes as of 31 December 2023, from
[faeldon/philippines-json-maps](https://github.com/faeldon/philippines-json-maps)
(MIT licence, `frontend/app/data/LICENSE-philippines-json-maps.txt`), built from
altcoder/philippines-psgc-shapefiles. Simplified for display; not an official
survey boundary. A local `frontend/data/bataan-municipalities.geojson` is only
used if the repository file is missing.

The evacuation center list now lives in the repository at
`backend/app/data/evacuation_centers.json` (one list for the map and the
Evacuate page). If you have a longer local `evacuation-centers.json`, merge its
records into that file.

Runtime data (`backend/data/`: community reports, photos, SQLite database) is
git-ignored because it can contain personal information such as contact numbers.
The public reports API never returns contact numbers.

## Contributing workflow

Work on a branch (for example `claude/...` or `feature/...`), open a pull
request and merge into `master` after review.
