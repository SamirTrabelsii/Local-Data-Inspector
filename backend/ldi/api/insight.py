"""M3 endpoints: column profiles, chart data, run history and comparison, workspace parameters."""

from typing import Literal

from fastapi import APIRouter, HTTPException, Query, Response
from pydantic import BaseModel

from .. import repo
from ..cache import store
from ..engine import chart, dag, history, profile
from ..engine import params as params_engine
from ..engine.executor import node_dialect

router = APIRouter(prefix="/api")


def _run_or_404(node_id: str) -> dict:
    repo.get_node(node_id)
    run = repo.get_run(node_id)
    if run is None:
        raise HTTPException(404, "This node has no results yet")
    return run


@router.get("/nodes/{node_id}/profile")
def get_profile(node_id: str) -> dict:
    run = _run_or_404(node_id)
    cached = repo.get_profile(node_id, run["cache_file"])
    if cached is not None:
        return cached
    data = profile.profile(store.result_path(node_id, run["cache_file"]))
    repo.save_profile(node_id, run["cache_file"], data)
    return data


class ChartRequest(BaseModel):
    config: dict | None = None  # unsaved settings from the editor; the saved ones are used when absent


@router.post("/nodes/{node_id}/chart-data")
def chart_data(node_id: str, body: ChartRequest) -> dict:
    node = repo.get_node(node_id)
    if node["kind"] != "chart":
        raise HTTPException(400, "Only chart nodes draw charts")
    parents = dag.parents_map(repo.list_edges()).get(node_id, [])
    if not parents:
        raise HTTPException(400, "Connect this chart to a node first")
    run = repo.get_run(parents[0])
    if run is None:
        raise HTTPException(409, "The input has no results yet - run it first")
    cfg = repo.clean_chart_config(body.config if body.config is not None else node["config"])
    try:
        return chart.chart_data(store.result_path(parents[0], run["cache_file"]), cfg)
    except chart.ChartError as exc:
        raise HTTPException(400, str(exc)) from None


@router.get("/nodes/{node_id}/history")
def get_history(node_id: str) -> list[dict]:
    return repo.list_history(node_id)


@router.get("/nodes/{node_id}/history/compare")
def compare_runs(node_id: str, a: int = Query(...), b: int = Query(...)) -> dict:
    first, second = repo.get_history_entry(node_id, a), repo.get_history_entry(node_id, b)
    if first["id"] > second["id"]:  # always diff older -> newer
        first, second = second, first
    return history.compare(first, second)


# ---- workspace parameters ----


class ParamBody(BaseModel):
    type: Literal["string", "number", "date", "bool"]
    value: str


def _param_list() -> list[dict]:
    params = repo.list_params()
    nodes = repo.list_nodes()
    used_by: dict[str, list[str]] = {name: [] for name in params}
    for n in nodes:
        dialect = node_dialect(n)
        for name in params_engine.find(n["sql"], dialect) if dialect else []:
            used_by.setdefault(name, []).append(n["name"])
    out = [
        {"name": p.name, "type": p.type, "value": p.value, "used_by": used_by.get(p.name, [])}
        for p in params.values()
    ]
    # Placeholders that no parameter defines yet, so the dialog can offer to create them.
    out += [
        {"name": name, "type": None, "value": None, "used_by": nodes_using}
        for name, nodes_using in used_by.items()
        if name not in params and nodes_using
    ]
    return out


@router.get("/params")
def list_params() -> list[dict]:
    return _param_list()


@router.put("/params/{name}")
def put_param(name: str, body: ParamBody) -> list[dict]:
    repo.set_param(name, body.type, body.value)
    return _param_list()


@router.delete("/params/{name}")
def delete_param(name: str) -> Response:
    repo.delete_param(name)
    return Response(status_code=204)
