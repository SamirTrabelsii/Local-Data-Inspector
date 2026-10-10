"""Workspace persistence: CRUD for nodes, edges, runs and errors."""

import json
import re
import sqlite3
import uuid

from . import db
from .engine import dag

NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")


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


def list_nodes() -> list[dict]:
    with db.connect() as con:
        return [_node(r) for r in con.execute("SELECT * FROM nodes ORDER BY created_at, id")]


def get_node(node_id: str) -> dict:
    with db.connect() as con:
        row = con.execute("SELECT * FROM nodes WHERE id = ?", (node_id,)).fetchone()
    if row is None:
        raise NotFound(f"Node {node_id} not found")
    return _node(row)


def create_node(kind: str, name: str | None, sql: str, x: float, y: float, inputs: list[str]) -> dict:
    if kind == "source" and inputs:
        raise Invalid("Source nodes cannot have inputs")
    node_id = uuid.uuid4().hex[:12]
    ts = db.now()
    with db.connect() as con:
        name = name or _next_name(con, kind)
        _validate_name(name)
        try:
            con.execute(
                "INSERT INTO nodes (id, kind, name, sql, pos_x, pos_y, created_at, updated_at) "
                "VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
                (node_id, kind, name, sql, x, y, ts, ts),
            )
        except sqlite3.IntegrityError:
            raise Invalid(f"A node named '{name}' already exists") from None
        for source in inputs:
            _add_edge(con, source, node_id)
    return get_node(node_id)


def update_node(node_id: str, fields: dict) -> dict:
    get_node(node_id)
    sets, params = [], []
    if fields.get("name") is not None:
        _validate_name(fields["name"])
        sets.append("name = ?")
        params.append(fields["name"])
    if fields.get("sql") is not None:
        sets.append("sql = ?")
        params.append(fields["sql"])
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
    return get_node(node_id)


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
