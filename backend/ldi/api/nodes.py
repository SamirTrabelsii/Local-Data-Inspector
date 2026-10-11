import shutil

from fastapi import APIRouter, HTTPException, Query, Response

from .. import repo, workspace
from ..cache import store
from ..engine import dag, source_file
from ..engine.executor import Busy, executor
from ..models import EdgeCreate, NodeCreate, NodeUpdate

router = APIRouter(prefix="/api")


@router.get("/workspace")
def get_workspace() -> dict:
    return workspace.snapshot(executor.running())


@router.post("/nodes", status_code=201)
def create_node(body: NodeCreate) -> dict:
    return repo.create_node(
        body.kind,
        body.name,
        body.sql,
        body.x,
        body.y,
        body.inputs,
        source_type=body.source_type,
        config=body.config if body.kind == "chart" else repo.clean_config(body.source_type, body.config),
        name_hint=body.name_hint,
    )


@router.patch("/nodes/{node_id}")
def update_node(node_id: str, body: NodeUpdate) -> dict:
    return repo.update_node(node_id, body.model_dump(exclude_none=True))


@router.get("/nodes/{node_id}/rename-preview")
def rename_preview(node_id: str, name: str = Query(...)) -> dict:
    """Which downstream transforms reference this node by name and will be rewritten on rename."""
    return {"affected": repo.rename_preview(node_id, name)}


@router.delete("/nodes/{node_id}", status_code=204)
def delete_node(node_id: str) -> Response:
    if node_id in executor.running():
        raise Busy("Can't delete a node while it is running")
    node = repo.get_node(node_id)
    repo.delete_node(node_id)
    store.remove_node(node_id)
    if node["source_type"] == "file" and node["config"].get("file"):
        shutil.rmtree(source_file.file_path(node["config"]).parent, ignore_errors=True)
    return Response(status_code=204)


@router.post("/edges", status_code=201)
def create_edge(body: EdgeCreate) -> dict:
    repo.add_edge(body.source, body.target)
    return {"source": body.source, "target": body.target}


@router.delete("/edges/{source}/{target}", status_code=204)
def delete_edge(source: str, target: str) -> Response:
    repo.remove_edge(source, target)
    return Response(status_code=204)


@router.post("/nodes/{node_id}/run", status_code=202)
def run_node(node_id: str) -> dict:
    if repo.get_node(node_id)["kind"] == "chart":
        raise HTTPException(400, "Charts draw themselves from their input; there is nothing to run")
    executor.submit([node_id])
    return {"queued": [node_id]}


@router.post("/nodes/{node_id}/cancel")
def cancel_node(node_id: str) -> dict:
    return {"cancelled": executor.cancel(node_id)}


@router.post("/nodes/{node_id}/run-downstream", status_code=202)
def run_downstream(node_id: str) -> dict:
    """Re-run every downstream transform in dependency order (plus this node if it is a transform).

    Never re-runs a Source, so this is always free.
    """
    node = repo.get_node(node_id)
    nodes = repo.list_nodes()
    edges = repo.list_edges()
    kinds = {n["id"]: n["kind"] for n in nodes}
    targets = {t for t in dag.descendants(edges, node_id) if kinds[t] != "chart"}
    if node["kind"] == "transform":
        targets.add(node_id)
    order = [n for n in dag.topo_order([n["id"] for n in nodes], edges) if n in targets]
    if not order:
        raise HTTPException(400, "Nothing downstream to run")
    executor.submit(order)
    return {"queued": order}
