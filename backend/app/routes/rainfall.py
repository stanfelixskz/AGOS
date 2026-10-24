
from fastapi import APIRouter, HTTPException

from app.services.rainfall_grid_service import get_rainfall_grid

router = APIRouter(tags=["Rainfall"])


@router.get("/weather/grid")
def rainfall_grid():
    try:
        return get_rainfall_grid()
    except RuntimeError as error:
        raise HTTPException(
            status_code=502,
            detail=str(error),
        ) from error
