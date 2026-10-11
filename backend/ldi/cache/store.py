"""Parquet result cache: one directory per node, one live file per directory."""

import base64
import math
import shutil
import uuid
from datetime import date, datetime, time, timedelta
from decimal import Decimal
from pathlib import Path

import duckdb

from .. import config


def quote_ident(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def quote_path(path: Path) -> str:
    return "'" + path.as_posix().replace("'", "''") + "'"


def node_dir(node_id: str) -> Path:
    d = config.cache_dir() / node_id
    d.mkdir(parents=True, exist_ok=True)
    return d


def new_result_path(node_id: str) -> Path:
    return node_dir(node_id) / f"{uuid.uuid4().hex}.parquet"


def result_path(node_id: str, cache_file: str) -> Path:
    return config.cache_dir() / node_id / cache_file


def cleanup(node_id: str, keep: Path) -> None:
    """Delete superseded files. On Windows a file still open by a reader can't be removed; it goes next time."""
    for f in node_dir(node_id).iterdir():
        if f != keep:
            try:
                f.unlink()
            except OSError:
                pass


def remove_node(node_id: str) -> None:
    shutil.rmtree(config.cache_dir() / node_id, ignore_errors=True)


def disk_usage(node_id: str) -> int:
    """Bytes the node's cache directory takes on disk (0 if it has none)."""
    d = config.cache_dir() / node_id
    if not d.is_dir():
        return 0
    total = 0
    for f in d.iterdir():
        try:
            total += f.stat().st_size
        except OSError:
            pass
    return total


def _columns(con: duckdb.DuckDBPyConnection, src: str) -> list[dict]:
    return [{"name": c[0], "type": c[1]} for c in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()]


def describe(path: Path) -> tuple[int, list[dict]]:
    src = f"read_parquet({quote_path(path)})"
    with duckdb.connect() as con:
        columns = _columns(con, src)
        (row_count,) = con.execute(f"SELECT count(*) FROM {src}").fetchone()
    return row_count, columns


def read_page(path: Path, offset: int, limit: int, sort: str | None, desc: bool) -> dict:
    src = f"read_parquet({quote_path(path)})"
    with duckdb.connect() as con:
        columns = _columns(con, src)
        order = ""
        if sort is not None:
            if sort not in {c["name"] for c in columns}:
                raise ValueError(f"Unknown column '{sort}'")
            order = f" ORDER BY {quote_ident(sort)} {'DESC' if desc else 'ASC'} NULLS LAST"
        rows = con.execute(f"SELECT * FROM {src}{order} LIMIT ? OFFSET ?", [limit, offset]).fetchall()
    return {"columns": columns, "rows": [[to_json(v) for v in row] for row in rows]}


EXCEL_MAX_ROWS = 1_048_575  # one sheet, minus the header row

EXPORT_OPTIONS = {
    "csv": "FORMAT csv, HEADER true",
    "tsv": "FORMAT csv, HEADER true, DELIMITER '\t'",
    "xlsx": "FORMAT xlsx, HEADER true",
}


def export(path: Path, fmt: str, dest: Path, limit: int | None = None) -> None:
    """Write a cached result as CSV / TSV / XLSX (Parquet results are served as-is)."""
    limit_sql = f" LIMIT {int(limit)}" if limit else ""
    with duckdb.connect() as con:
        if fmt == "xlsx":
            con.execute("INSTALL excel; LOAD excel")
        con.execute(
            f"COPY (SELECT * FROM read_parquet({quote_path(path)}){limit_sql}) TO {quote_path(dest)} "
            f"({EXPORT_OPTIONS[fmt]})"
        )


MAX_SAFE_INT = 2**53


def to_json(v):
    """Make a DuckDB value JSON-safe without losing precision (big ints / decimals become strings)."""
    if v is None or isinstance(v, (bool, str)):
        return v
    if isinstance(v, int):
        return v if -MAX_SAFE_INT < v < MAX_SAFE_INT else str(v)
    if isinstance(v, float):
        return v if math.isfinite(v) else str(v)
    if isinstance(v, Decimal):
        return str(v)
    if isinstance(v, (datetime, date, time)):
        return v.isoformat()
    if isinstance(v, timedelta):
        return str(v)
    if isinstance(v, (bytes, bytearray, memoryview)):
        return base64.b64encode(bytes(v)).decode()
    if isinstance(v, dict):
        return {str(k): to_json(x) for k, x in v.items()}
    if isinstance(v, (list, tuple)):
        return [to_json(x) for x in v]
    return str(v)
