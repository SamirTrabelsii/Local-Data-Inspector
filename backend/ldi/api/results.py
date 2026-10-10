from fastapi import APIRouter, HTTPException, Query

from .. import repo
from ..cache import store

router = APIRouter(prefix="/api")


@router.get("/nodes/{node_id}/results")
def get_results(
    node_id: str,
    offset: int = Query(0, ge=0),
    limit: int = Query(200, ge=1, le=2000),
    sort: str | None = None,
    desc: bool = False,
) -> dict:
    repo.get_node(node_id)
    run = repo.get_run(node_id)
    if run is None:
        raise HTTPException(404, "This node has no results yet")
    try:
        page = store.read_page(store.result_path(node_id, run["cache_file"]), offset, limit, sort, desc)
    except ValueError as exc:
        raise HTTPException(400, str(exc)) from None
    return {**page, "offset": offset, "total": run["row_count"]}
