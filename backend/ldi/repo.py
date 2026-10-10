"""Workspace persistence: CRUD for nodes, edges, runs and errors."""

import json
import re
import sqlite3
import uuid

from . import db
from .engine import dag
from .engine.sqlrefs import rename_references

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
SOURCE_TYPES = ("bq_query", "bq_table", "file")


class NotFound(Exception):
    pass


class Invalid(Exception):
    pass


def _node(row: sqlite3.Row) -> dict:
    return {
        "id": row["id"],
        "kind": row["kind"],
        "name": row["name"],
        "sql": row["sql"],
        "source_type": row["source_type"],
        "config": json.loads(row["config"]),
        "x": row["pos_x"],
        "y": row["pos_y"],
    }


def _validate_name(name: str) -> None:
    if not NAME_RE.match(name):
        raise Invalid("Names must start with a letter or _ and contain only letters, digits and _")


def _next_name(con: sqlite3.Connection, kind: str) -> str:
    existing = {r[0].lower() for r in con.execute("SELECT name FROM nodes")}
    i = 1
    while f"{kind}_{i}" in existing:
        i += 1
    return f"{kind}_{i}"


def _name_from_hint(con: sqlite3.Connection, hint: str) -> str:
    """Turn a table or file name into a free node name: `sales 2024` -> `sales_2024`, then `_2`, `_3`..."""
    base = re.sub(r"\W+", "_", hint).strip("_")[:58] or "source"
    if not re.match(r"[A-Za-z_]", base):
        base = "_" + base
    existing = {r[0].lower() for r in con.execute("SELECT name FROM nodes")}
    name, i = base, 2
    while name.lower() in existing:
        name, i = f"{base}_{i}", i + 1
    return name


def clean_config(source_type: str | None, cfg: dict, current: dict | None = None) -> dict:
    """Validate a config coming from the API. File references are only ever set by the upload endpoint."""
    if source_type == "bq_table":
        out: dict = {"table": str(cfg.get("table") or "").strip().strip("`")}
        if cfg.get("columns"):
            out["columns"] = [str(c) for c in cfg["columns"]]
        if str(cfg.get("row_filter") or "").strip():
            out["row_filter"] = str(cfg["row_filter"]).strip()
        return out
    if source_type == "file":
        out = dict(current or {})
        if cfg.get("sheet"):
            out["sheet"] = str(cfg["sheet"])
        else:
            out.pop("sheet", None)
        return out
    return {}


def list_nodes() -> list[dict]:
    with db.connect() as con:
        return [_node(r) for r in con.execute("SELECT * FROM nodes ORDER BY created_at, id")]


def get_node(node_id: str) -> dict:
    with db.connect() as con:
        row = con.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise NotFound(f"Node {node_id} not found")
    return _node(row)


def create_node(
    kind: str,
    name: str | None,
    sql: str,
    x: float,
    y: float,
    inputs: list[str],
    *,
    source_type: str | None = None,
    config: dict | None = None,
    name_hint: str | None = None,
) -> dict:
    """`config` is trusted here: API input goes through clean_config first."""
    if kind == "source" and inputs:
        raise Invalid("Source nodes cannot have inputs")
    if kind == "source":
        source_type = source_type or "bq_query"
        if source_type not in SOURCE_TYPES:
            raise Invalid(f"Unknown source type '{source_type}'")
    else:
        source_type, config = None, {}
    node_id = uuid.uuid4().hex[:12]
    ts = db.now()
    with db.connect() as con:
        name = name or (_name_from_hint(con, name_hint) if name_hint else _next_name(con, kind))
        _validate_name(name)
        try:
            con.execute(
                "INSERT INTO nodes (id, kind, name, sql, source_type, config, pos_x, pos_y, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
                (node_id, kind, name, sql, source_type, json.dumps(config or {}), x, y, ts, ts),
            )
        except sqlite3.IntegrityError:
            raise Invalid(f"A node named '{name}' already exists") from None
        for source in inputs:
            _add_edge(con, source, node_id)
    return get_node(node_id)


def update_node(node_id: str, fields: dict) -> dict:
    """Renaming also rewrites references in the SQL of direct downstream transforms."""
    node = get_node(node_id)
    renamed = fields.get("name") is not None and fields["name"] != node["name"]
    sets, params = [], []
    if fields.get("name") is not None:
        _validate_name(fields["name"])
        sets.append("name = ?")
        params.append(fields["name"])
    if fields.get("sql") is not None:
        sets.append("sql = ?")
        params.append(fields["sql"])
    if fields.get("config") is not None and node["kind"] == "source":
        sets.append("config = ?")
        params.append(json.dumps(clean_config(node["source_type"], fields["config"], node["config"])))
    for key, col in (("x", "pos_x"), ("y", "pos_y")):
        if fields.get(key) is not None:
            sets.append(f"{col} = ?")
            params.append(fields[key])
    if sets:
        sets.append("updated_at = ?")
        params.append(db.now())
        with db.connect() as con:
            try:
                con.execute(f"UPDATE nodes SET {', '.join(sets)} WHERE id = ?", (*params, node_id))
            except sqlite3.IntegrityError:
                raise Invalid(f"A node named '{fields['name']}' already exists") from None
            if renamed:
                _rewrite_downstream(con, node_id, node["name"], fields["name"])
    return get_node(node_id)


def _children(con: sqlite3.Connection, node_id: str) -> list[dict]:
    rows = con.execute(
        "SELECT n.* FROM nodes n JOIN edges e ON e.target = n.id WHERE e.source = ? ORDER BY n.created_at",
        (node_id,),
    ).fetchall()
    return [_node(r) for r in rows]


def rename_preview(node_id: str, new_name: str) -> list[dict]:
    """Downstream nodes whose SQL would change if `node_id` were renamed to `new_name`."""
    old = get_node(node_id)["name"]
    with db.connect() as con:
        children = _children(con, node_id)
    out = []
    for child in children:
        _, count = rename_references(child["sql"], old, new_name)
        if count:
            out.append({"id": child["id"], "name": child["name"], "references": count})
    return out


def _rewrite_downstream(con: sqlite3.Connection, node_id: str, old: str, new: str) -> None:
    for child in _children(con, node_id):
        sql, count = rename_references(child["sql"], old, new)
        if not count:
            continue
        con.execute("UPDATE nodes SET sql = ?, updated_at = ? WHERE id = ?", (sql, db.now(), child["id"]))
        # Same query, new spelling: a result that was current for the old SQL stays current.
        con.execute(
            "UPDATE runs SET sql_hash = ? WHERE node_id = ? AND sql_hash = ?",
            (dag.node_hash({**child, "sql": sql}), child["id"], dag.node_hash(child)),
        )


def set_config(node_id: str, cfg: dict) -> None:
    """Trusted callers only (e.g. the upload endpoint)."""
    with db.connect() as con:
        con.execute("UPDATE nodes SET config = ?, updated_at = ? WHERE id = ?", (json.dumps(cfg), db.now(), node_id))


def delete_node(node_id: str) -> None:
    get_node(node_id)
    with db.connect() as con:
        con.execute("DELETE FROM nodes WHERE id = ?", (node_id,))


def list_edges() -> list[dag.Edge]:
    with db.connect() as con:
        return [(r[0], r[1]) for r in con.execute("SELECT source, target FROM edges ORDER BY rowid")]


def _add_edge(con: sqlite3.Connection, source: str, target: str) -> None:
    kinds = dict(con.execute("SELECT id, kind FROM nodes WHERE id IN (?, ?)", (source, target)).fetchall())
    if source not in kinds or target not in kinds:
        raise NotFound("Both ends of a connection must exist")
    if kinds[target] != "transform":
        raise Invalid("Only transform nodes can take inputs")
    edges = [(r[0], r[1]) for r in con.execute("SELECT source, target FROM edges")]
    if (source, target) in edges:
        return
    if dag.would_cycle(edges, source, target):
        raise Invalid("That connection would create a cycle")
    con.execute("INSERT INTO edges (source, target) VALUES (?, ?)", (source, target))


def add_edge(source: str, target: str) -> None:
    with db.connect() as con:
        _add_edge(con, source, target)


def remove_edge(source: str, target: str) -> None:
    with db.connect() as con:
        con.execute("DELETE FROM edges WHERE source = ? AND target = ?", (source, target))


def _run(row: sqlite3.Row) -> dict:
    return {
        "sql_hash": row["sql_hash"],
        "inputs": json.loads(row["inputs"]),
        "cache_file": row["cache_file"],
        "row_count": row["row_count"],
        "columns": json.loads(row["columns"]),
        "exec_ms": row["exec_ms"],
        "bytes_processed": row["bytes_processed"],
        "bytes_billed": row["bytes_billed"],
        "finished_at": row["finished_at"],
    }


def get_runs() -> dict[str, dict]:
    with db.connect() as con:
        return {r["node_id"]: _run(r) for r in con.execute("SELECT * FROM runs")}


def get_run(node_id: str) -> dict | None:
    with db.connect() as con:
        row = con.execute("SELECT * FROM runs WHERE node_id = ?", (node_id,)).fetchone()
    return _run(row) if row else None


def save_run(
    node_id: str,
    *,
    sql_hash: str,
    inputs: dict[str, str],
    cache_file: str,
    row_count: int,
    columns: list[dict],
    exec_ms: int,
    bytes_processed: int | None = None,
    bytes_billed: int | None = None,
) -> None:
    with db.connect() as con:
        con.execute(
            "INSERT OR REPLACE INTO runs (node_id, sql_hash, inputs, cache_file, row_count, columns, "
            "exec_ms, bytes_processed, bytes_billed, finished_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)",
            (
                node_id,
                sql_hash,
                json.dumps(inputs),
                cache_file,
                row_count,
                json.dumps(columns),
                exec_ms,
                bytes_processed,
                bytes_billed,
                db.now(),
            ),
        )
        con.execute("DELETE FROM errors WHERE node_id = ?", (node_id,))


def save_error(node_id: str, message: str) -> None:
    with db.connect() as con:
        con.execute(
            "INSERT OR REPLACE INTO errors (node_id, message, at) "
            "SELECT id, ?, ? FROM nodes WHERE id = ?",  # no-op if the node was deleted meanwhile
            (message, db.now(), node_id),
        )


def get_errors() -> dict[str, dict]:
    with db.connect() as con:
        return {r["node_id"]: {"message": r["message"], "at": r["at"]} for r in con.execute("SELECT * FROM errors")}
