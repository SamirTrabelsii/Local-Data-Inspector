"""The workspace snapshot the UI renders: nodes with derived status, plus edges."""

from . import repo
from .engine import dag
from .engine import params as params_engine
from .engine.executor import node_dialect


def _status(node: dict, running: set[str], errors: dict, runs: dict, stale: dict, parents: list[str]) -> str:
    node_id = node["id"]
    if node_id in running:
        return "running"
    if node_id in errors:
        return "error"
    # A chart has no result of its own: it is as ready as the node it reads.
    has_result = (bool(parents) and parents[0] in runs) if node["kind"] == "chart" else node_id in runs
    if not has_result:
        return "never_run"
    return "stale" if stale[node_id] else "fresh"


def snapshot(running: set[str]) -> dict:
    nodes = repo.list_nodes()
    edges = repo.list_edges()
    runs = repo.get_runs()
    errors = repo.get_errors()
    params = repo.list_params()
    used = {n["id"]: params_engine.find(n["sql"], node_dialect(n)) if node_dialect(n) else [] for n in nodes}
    fingerprints = {
        nid: {name: (params[name].fingerprint if name in params else None) for name in names}
        for nid, names in used.items()
    }
    stale = dag.compute_stale(nodes, edges, runs, fingerprints)
    parents = dag.parents_map(edges)
    names = {n["id"]: n["name"] for n in nodes}
    sampled_sources = {n["id"] for n in nodes if n["kind"] == "source" and n["config"].get("sample_percent")}

    out = []
    for n in nodes:
        run = runs.get(n["id"])
        out.append(
            {
                **n,
                "status": _status(n, running, errors, runs, stale, parents.get(n["id"], [])),
                "stale": stale[n["id"]],
                "error": errors.get(n["id"], {}).get("message"),
                "inputs": [names[p] for p in parents.get(n["id"], [])],
                "input_ids": parents.get(n["id"], []),
                "params_used": used[n["id"]],
                "params_missing": [name for name in used[n["id"]] if name not in params],
                # Built from a sample: the source itself, or a transform reading one (directly or further up).
                "sampled": n["id"] in sampled_sources
                or bool(dag.ancestors(edges, n["id"]) & sampled_sources),
                "result": None
                if run is None
                else {
                    k: run[k]
                    for k in (
                        "row_count",
                        "columns",
                        "exec_ms",
                        "bytes_processed",
                        "bytes_billed",
                        "finished_at",
                    )
                },
            }
        )
    return {"nodes": out, "edges": [{"source": s, "target": t} for s, t in edges]}
