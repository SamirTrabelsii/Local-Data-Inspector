import uuid
from typing import Literal

from fastapi import APIRouter, HTTPException, Query
from fastapi.responses import FileResponse
from starlette.background import BackgroundTask

from .. import config, db, repo
from ..cache import store
from ..engine import source_bq
from ..models import PushRequest

router = APIRouter(prefix="/api")

MEDIA_TYPES = {
    "csv": "text/csv",
    "tsv": "text/tab-separated-values",
    "parquet": "application/vnd.apache.parquet",
    "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
}


def _result(node_id: str) -> tuple[dict, dict]:
    node = repo.get_node(node_id)
    run = repo.get_run(node_id)
    if run is None:
        raise HTTPException(404, "This node has no results yet")
    return node, run


@router.get("/nodes/{node_id}/results")
def get_results(
    node_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
    sort: str | None = None,
    desc: bool = False,
) -> dict:
    _, run = _result(node_id)
    try:
        page = store.read_page(store.result_path(node_id, run["cache_file"]), offset, limit, sort, desc)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {**page, "offset": offset, "total": run["row_count"]}


@router.get("/nodes/{node_id}/export")
def export(
    node_id: str,
    format: Literal["csv", "tsv", "parquet", "xlsx"] = "csv",
    limit: int | None = Query(None, ge=1),
) -> FileResponse:
    """Download the cached result. `tsv` with a `limit` is what the UI copies to the clipboard."""
    node, run = _result(node_id)
    path = store.result_path(node_id, run["cache_file"])
    filename = f"{node['name']}.{format}"
    if format == "parquet":
        return FileResponse(path, filename=filename, media_type=MEDIA_TYPES[format])
    if format == "xlsx" and min(run["row_count"], limit or run["row_count"]) > store.EXCEL_MAX_ROWS:
        raise HTTPException(400, f"Excel holds at most {store.EXCEL_MAX_ROWS:,} rows: export CSV or Parquet")
    dest = config.exports_dir() / f"{uuid.uuid4().hex}.{format}"
    store.export(path, format, dest, limit)
    return FileResponse(
        dest,
        filename=filename,
        media_type=MEDIA_TYPES[format],
        background=BackgroundTask(dest.unlink, missing_ok=True),
    )


@router.post("/nodes/{node_id}/push")
def push(node_id: str, body: PushRequest) -> dict:
    """Load the cached result into a BigQuery table (load jobs are free)."""
    _, run = _result(node_id)
    try:
        return source_bq.push_parquet(
            store.result_path(node_id, run["cache_file"]), body.table, body.mode, db.get_settings()
        )
    except Exception as exc:  # noqa: BLE001 - BigQuery errors go back to the dialog
        raise HTTPException(400, source_bq.error_message(exc)) from None
