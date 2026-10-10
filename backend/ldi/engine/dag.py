"""Pure graph logic: ordering, cycle checks, staleness."""

import hashlib
import json
from collections import defaultdict, deque

Edge = tuple[str, str]  # (source, target)


def sql_hash(sql: str) -> str:
    return hashlib.sha256(sql.strip().encode()).hexdigest()


def node_hash(node: dict) -> str:
    """Fingerprint of what a node computes: its SQL, plus its config for table / file sources."""
    cfg = node.get("config") or {}
    if not cfg:
        return sql_hash(node["sql"])  # same as before configs existed, so old runs stay fresh
    return hashlib.sha256((node["sql"].strip() + "\0" + json.dumps(cfg, sort_keys=True)).encode()).hexdigest()


def parents_map(edges: list[Edge]) -> dict[str, list[str]]:
    parents: dict[str, list[str]] = defaultdict(list)
    for source, target in edges:
        parents[target].append(source)
    return parents


def children_map(edges: list[Edge]) -> dict[str, list[str]]:
    children: dict[str, list[str]] = defaultdict(list)
    for source, target in edges:
        children[source].append(target)
    return children


def descendants(edges: list[Edge], node_id: str) -> set[str]:
    children = children_map(edges)
    seen: set[str] = set()
    queue = deque(children[node_id])
    while queue:
        n = queue.popleft()
        if n not in seen:
            seen.add(n)
            queue.extend(children[n])
    return seen


def would_cycle(edges: list[Edge], source: str, target: str) -> bool:
    """True if adding source -> target closes a cycle (target already reaches source)."""
    return source == target or source in descendants(edges, target)


def topo_order(node_ids: list[str], edges: list[Edge]) -> list[str]:
    """Kahn's algorithm; ties keep the order of node_ids so results are stable."""
    index = {n: i for i, n in enumerate(node_ids)}
    indegree = {n: 0 for n in node_ids}
    children = children_map(edges)
    for _, target in edges:
        if target in indegree:
            indegree[target] += 1
    ready = sorted((n for n, d in indegree.items() if d == 0), key=index.__getitem__)
    order: list[str] = []
    while ready:
        n = ready.pop(0)
        order.append(n)
        for c in children[n]:
            if c in indegree:
                indegree[c] -= 1
                if indegree[c] == 0:
                    ready.append(c)
                    ready.sort(key=index.__getitem__)
    return order


def compute_stale(nodes: list[dict], edges: list[Edge], runs: dict[str, dict]) -> dict[str, bool]:
    """A node is stale if it never ran, its SQL changed, its inputs changed or re-ran, or an input is stale."""
    by_id = {n["id"]: n for n in nodes}
    parents = parents_map(edges)
    stale: dict[str, bool] = {}
    for nid in topo_order(list(by_id), edges):
        run = runs.get(nid)
        if run is None:
            stale[nid] = True
            continue
        ps = parents.get(nid, [])
        current_inputs = {p: runs[p]["finished_at"] if p in runs else None for p in ps}
        stale[nid] = (
            run["sql_hash"] != node_hash(by_id[nid])
            or run["inputs"] != current_inputs
            or any(stale.get(p, True) for p in ps)
        )
    return stale
