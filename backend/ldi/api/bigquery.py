from collections.abc import Callable

from fastapi import APIRouter, HTTPException, Query

from .. import db
from ..engine import source_bq
from ..models import DryRunRequest, Settings

router = APIRouter(prefix="/api")

def _bq[T](fn: Callable[[], T]) -> T:
    try:
        return fn()
    except Exception as exc:  # noqa: BLE001 - BigQuery errors go back to the UI as 400s
        raise HTTPException(400, source_bq.error_message(exc)) from None


@router.get("/bq/status")
def bq_status() -> dict:
    return source_bq.auth_status(db.get_settings())


@router.post("/bq/dry-run")
def bq_dry_run(body: DryRunRequest) -> dict:
    if not body.sql.strip():
        raise HTTPException(400, "SQL is empty")
    return _bq(lambda: source_bq.dry_run(body.sql, db.get_settings()))


@router.get("/bq/projects")
def bq_projects() -> dict:
    """The schema browser shows the billing project plus the projects pinned in Settings."""
    settings = db.get_settings()
    billing = _bq(lambda: source_bq.client(settings).project)
    pinned = [p for p in settings["bq_pinned_projects"] if p and p != billing]
    return {"billing": billing, "projects": [billing, *pinned] if billing else pinned}


@router.get("/bq/datasets")
def bq_datasets(project: str) -> list[dict]:
    return _bq(lambda: source_bq.list_datasets(db.get_settings(), project))


@router.get("/bq/tables")
def bq_tables(project: str, dataset: str) -> list[dict]:
    return _bq(lambda: source_bq.list_tables(db.get_settings(), project, dataset))


@router.get("/bq/table")
def bq_table(id: str) -> dict:
    return _bq(lambda: source_bq.describe_table(db.get_settings(), id))


@router.get("/bq/preview")
def bq_preview(id: str, limit: int = Query(100, ge=1, le=1000)) -> dict:
    """First rows of a table, free (tabledata.list, no query job)."""
    return _bq(lambda: source_bq.preview(db.get_settings(), id, limit))


@router.get("/settings")
def get_settings() -> dict:
    return db.get_settings()


@router.put("/settings")
def put_settings(body: Settings) -> dict:
    values = body.model_dump()
    values["bq_pinned_projects"] = list(dict.fromkeys(p.strip() for p in values["bq_pinned_projects"] if p.strip()))
    return db.save_settings(values)
