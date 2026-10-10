"""The workspace snapshot the UI renders: nodes with derived status, plus edges."""

from . import repo
from .engine import dag


def _status(node_id: str, running: set[str], errors: dict, runs: dict, stale: dict) -> str:
    if node_id in running:
        return "running"
    if node_id in errors:
        return "error"
    if node_id not in runs:
        return "never_run"
    return "stale" if stale[node_id] else "fresh"


def snapshot(running: set[str]) -> dict:
    nodes = repo.list_nodes()
    edges = repo.list_edges()
    runs = repo.get_runs()
    errors = repo.get_errors()
    stale = dag.compute_stale(nodes, edges, runs)
    parents = dag.parents_map(edges)
    names = {n["id"]: n["name"] for n in nodes}

    out = []
    for n in nodes:
        run = runs.get(n["id"])
        out.append(
            {
                **n,
                "status": _status(n["id"], running, errors, runs, stale),
                "stale": stale[n["id"]],
                "error": errors.get(n["id"], {}).get("message"),
                "inputs": [names[p] for p in parents.get(n["id"], [])],
                "result": None
                if run is None
                else {
                    k: run[k]
                    for k in ("row_count", "columns", "exec_ms", "bytes_processed", "bytes_billed", "finished_at")
                },
            }
        )
    return {"nodes": out, "edges": [{"source": s, "target": t} for s, t in edges]}
