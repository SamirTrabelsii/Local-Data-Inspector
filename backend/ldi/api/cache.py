"""Cost intelligence endpoints: the savings meter, and the cache manager (disk usage, pin, clean-up)."""

from datetime import UTC, datetime, timedelta

from fastapi import APIRouter

from .. import config, db, repo
from ..cache import store
from ..engine import dag
from ..engine.executor import Busy, executor
from ..models import CleanRequest, PinRequest

router = APIRouter(prefix="/api")

TIB = 1024**4


@router.get("/savings")
def get_savings() -> dict:
    return repo.savings()


def _entries() -> list[dict]:
    """One row per node that has a cached result."""
    nodes = repo.list_nodes()
    runs = repo.get_runs()
    stale = dag.compute_stale(nodes, repo.list_edges(), runs)
    price = db.get_settings()["price_per_tib_usd"]
    out = []
    for n in nodes:
        run = runs.get(n["id"])
        if run is None:
            continue
        # What it would cost to get the data back after a clean-up: only BigQuery query sources bill.
        rebuild = (run["bytes_processed"] or 0) / TIB * price if n["source_type"] == "bq_query" else 0.0
        out.append(
            {
                "node_id": n["id"],
                "name": n["name"],
                "kind": n["kind"],
                "source_type": n["source_type"],
                "bytes": store.disk_usage(n["id"]),
                "row_count": run["row_count"],
                "finished_at": run["finished_at"],
                "pinned": n["pinned"],
                "stale": stale[n["id"]],
                "rebuild_usd": rebuild,
                "rebuild_from_bigquery": n["kind"] == "source" and n["source_type"] != "file",
            }
        )
    return sorted(out, key=lambda e: -e["bytes"])


@router.get("/cache")
def get_cache() -> dict:
    entries = _entries()
    return {
        "entries": entries,
        "total_bytes": sum(e["bytes"] for e in entries),
        "pinned_bytes": sum(e["bytes"] for e in entries if e["pinned"]),
        "location": str(config.cache_dir()),
    }


@router.post("/nodes/{node_id}/pin")
def pin_node(node_id: str, body: PinRequest) -> dict:
    return repo.set_pinned(node_id, body.pinned)


def _clear(entry: dict) -> int:
    store.remove_node(entry["node_id"])
    repo.clear_run(entry["node_id"])
    return entry["bytes"]


@router.delete("/cache/{node_id}")
def clear_node_cache(node_id: str) -> dict:
    """Delete one node's cached result. Pinned nodes must be unpinned first."""
    node = repo.get_node(node_id)
    if node["pinned"]:
        raise repo.Invalid(f"{node['name']} is pinned. Unpin it first to delete its cache.")
    if node_id in executor.running():
        raise Busy("Can't clear the cache of a node while it is running")
    entry = next((e for e in _entries() if e["node_id"] == node_id), None)
    return {"freed_bytes": _clear(entry) if entry else 0}


@router.post("/cache/clean")
def clean_cache(body: CleanRequest) -> dict:
    """Bulk clean-up. Pinned and running nodes are always skipped. `preview` reports without deleting."""
    running = executor.running()
    cutoff = datetime.now(UTC) - timedelta(days=body.older_than_days)
    chosen = []
    for e in _entries():
        if e["pinned"] or e["node_id"] in running:
            continue
        if body.scope == "stale" and not e["stale"]:
            continue
        if body.scope == "older_than" and datetime.fromisoformat(e["finished_at"]) > cutoff:
            continue
        chosen.append(e)
    freed = sum(e["bytes"] for e in chosen) if body.preview else sum(_clear(e) for e in chosen)
    return {
        "preview": body.preview,
        "freed_bytes": freed,
        "nodes": [
            {k: e[k] for k in ("node_id", "name", "bytes", "rebuild_usd", "rebuild_from_bigquery")}
            for e in chosen
        ],
    }
