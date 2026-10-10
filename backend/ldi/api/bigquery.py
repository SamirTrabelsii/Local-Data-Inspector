from fastapi import APIRouter, HTTPException

from .. import db
from ..engine import source_bq
from ..models import DryRunRequest, Settings

router = APIRouter(prefix="/api")


@router.get("/bq/status")
def bq_status() -> dict:
    return source_bq.auth_status(db.get_settings())


@router.post("/bq/dry-run")
def bq_dry_run(body: DryRunRequest) -> dict:
    if not body.sql.strip():
        raise HTTPException(400, "SQL is empty")
    try:
        return source_bq.dry_run(body.sql, db.get_settings())
    except Exception as exc:  # noqa: BLE001 - BigQuery errors go back to the editor
        raise HTTPException(400, source_bq.error_message(exc)) from None


@router.get("/settings")
def get_settings() -> dict:
    return db.get_settings()


@router.put("/settings")
def put_settings(body: Settings) -> dict:
    return db.save_settings(body.model_dump())
