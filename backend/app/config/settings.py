
import os
from pathlib import Path

from dotenv import load_dotenv

# Load the .env file from the backend directory.
BACKEND_DIR = Path(__file__).resolve().parents[2]
load_dotenv(BACKEND_DIR / ".env")

# ==========================================
# AGOS SETTINGS
# ==========================================

# Open-Meteo compatibility for existing weather_service.py
OPEN_METEO_URL = "https://api.open-meteo.com/v1/forecast"


# Balanga City, Bataan
LATITUDE = 14.6760
LONGITUDE = 120.5363
TIMEZONE = "Asia/Manila"

# ==========================================
# WeatherAPI.com
# ==========================================

WEATHERAPI_BASE_URL = "https://api.weatherapi.com/v1"

WEATHERAPI_API_KEY = os.getenv(
    "WEATHERAPI_API_KEY", ""
).strip()

# ==========================================
# Weather cache settings
# ==========================================

WEATHER_CACHE_TTL_SECONDS = 900
WEATHER_STALE_CACHE_TTL_SECONDS = 3600
WEATHER_REQUEST_TIMEOUT_SECONDS = 15
