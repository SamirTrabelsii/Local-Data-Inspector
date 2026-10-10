from fastapi import APIRouter, HTTPException, Response

from .. import repo, workspace
from ..cache import store
from ..engine import dag
from ..engine.executor import Busy, executor
from ..models import EdgeCreate, NodeCreate, NodeUpdate

router = APIRouter(prefix="/api")


@router.get("/workspace")
def get_workspace() -> dict:
    return workspace.snapshot(executor.running())


@router.post("/nodes", status_code=201)
def create_node(body: NodeCreate) -> dict:
    return repo.create_node(body.kind, body.name, body.sql, body.x, body.y, body.inputs)


@router.patch("/nodes/{node_id}")
def update_node(node_id: str, body: NodeUpdate) -> dict:
    return repo.update_node(node_id, body.model_dump(exclude_none=True))


@router.delete("/nodes/{node_id}", status_code=204)
def delete_node(node_id: str) -> Response:
    if node_id in executor.running():
        raise Busy("Can't delete a node while it is running")
    repo.delete_node(node_id)
    store.remove_node(node_id)
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
    repo.get_node(node_id)
    executor.submit([node_id])
    return {"queued": [node_id]}


@router.post("/nodes/{node_id}/run-downstream", status_code=202)
def run_downstream(node_id: str) -> dict:
    """Re-run every downstream transform in dependency order (plus this node if it is a transform).

    Never re-runs a Source, so this is always free.
    """
    node = repo.get_node(node_id)
    nodes = repo.list_nodes()
    edges = repo.list_edges()
    targets = dag.descendants(edges, node_id)
    if node["kind"] == "transform":
        targets.add(node_id)
    order = [n for n in dag.topo_order([n["id"] for n in nodes], edges) if n in targets]
    if not order:
        raise HTTPException(400, "Nothing downstream to run")
    executor.submit(order)
    return {"queued": order}
