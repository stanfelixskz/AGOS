
from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware

from app.routes.weather import router as weather_router
from app.routes.reports import router as reports_router
from app.routes.rainfall import router as rainfall_router
from agos_data_lifecycle import router as data_lifecycle_router


app = FastAPI(
    title="AGOS API",
    version="0.1.0",
    description=(
        "Analytics-Driven Geospatial Observation and "
        "Flood Support System"
    ),
)


# CORS configuration
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# Existing AGOS routes
app.include_router(weather_router)
app.include_router(reports_router)
app.include_router(rainfall_router)

# SQLite Data Lifecycle routes
app.include_router(data_lifecycle_router)


@app.get("/")
def home():
    return {
        "system": "AGOS API",
        "status": "Running",
        "version": "0.1.0",
    }
