"""Column profiles of a cached result: DuckDB SUMMARIZE plus a small histogram or top values per column."""

import re
from decimal import Decimal
from pathlib import Path

import duckdb

from ..cache.store import quote_ident, quote_path, to_json

BINS = 20
TOP_VALUES = 5
MAX_COLUMNS = 200  # per-column queries; beyond this a profile would take longer than it is worth

NUMERIC = re.compile(r"^(U?(TINY|SMALL|BIG|HUGE)?INT(EGER)?|FLOAT|REAL|DOUBLE|DECIMAL\(\d+,\s*\d+\))$")
TEMPORAL = re.compile(r"^(DATE|TIMESTAMP.*)$")


def kind_of(duck_type: str) -> str:
    t = duck_type.upper()
    if NUMERIC.match(t):
        return "numeric"
    if TEMPORAL.match(t):
        return "temporal"
    if t == "BOOLEAN":
        return "bool"
    if t == "VARCHAR":
        return "text"
    return "other"  # lists, structs, maps, blobs...


def _axis_expr(col: str, kind: str) -> str:
    c = quote_ident(col)
    return f"{c}::DOUBLE" if kind == "numeric" else f"epoch({c}::TIMESTAMP)"


def _histogram(con: duckdb.DuckDBPyConnection, src: str, col: str, kind: str) -> dict | None:
    expr = _axis_expr(col, kind)
    lo, hi = con.execute(
        f"SELECT min(e), max(e) FROM (SELECT {expr} AS e FROM {src}) WHERE isfinite(e)"
    ).fetchone()
    if lo is None:
        return None
    if lo == hi:
        (n,) = con.execute(
            f"SELECT count(*) FROM (SELECT {expr} AS e FROM {src}) WHERE e = ?", [lo]
        ).fetchone()
        return {"lo": lo, "hi": hi, "counts": [n]}
    width = (hi - lo) / BINS
    counts = [0] * BINS
    rows = con.execute(
        f"SELECT least(floor((e - ?) / ?)::BIGINT, {BINS - 1}) AS b, count(*) "
        f"FROM (SELECT {expr} AS e FROM {src}) WHERE isfinite(e) GROUP BY b",
        [lo, width],
    ).fetchall()
    for b, n in rows:
        counts[int(b)] += n
    return {"lo": lo, "hi": hi, "counts": counts}


def _top_values(con: duckdb.DuckDBPyConnection, src: str, col: str) -> list[dict]:
    c = quote_ident(col)
    rows = con.execute(
        f"SELECT {c}::VARCHAR AS v, count(*) AS n FROM {src} WHERE {c} IS NOT NULL "
        f"GROUP BY v ORDER BY n DESC, v LIMIT {TOP_VALUES}"
    ).fetchall()
    return [{"value": v, "count": n} for v, n in rows]


def _num(v):
    return float(v) if isinstance(v, Decimal) else v


def profile(path: Path) -> dict:
    src = f"read_parquet({quote_path(path)})"
    with duckdb.connect() as con:
        cur = con.execute(f"SUMMARIZE SELECT * FROM {src}")
        names = [d[0] for d in cur.description]
        summary = [dict(zip(names, row, strict=True)) for row in cur.fetchall()]
        columns = []
        for row in summary[:MAX_COLUMNS]:
            name, kind = row["column_name"], kind_of(row["column_type"])
            entry = {
                "name": name,
                "type": row["column_type"],
                "kind": kind,
                "count": row["count"],
                "null_pct": float(_num(row["null_percentage"]) or 0),
                "distinct": row["approx_unique"],
                "min": to_json(row["min"]),
                "max": to_json(row["max"]),
                "avg": to_json(_num(row["avg"])) if kind == "numeric" else None,
                "q50": to_json(row["q50"]) if kind == "numeric" else None,
                "histogram": None,
                "top": None,
            }
            try:
                if kind in ("numeric", "temporal"):
                    entry["histogram"] = _histogram(con, src, name, kind)
                elif kind in ("text", "bool"):
                    entry["top"] = _top_values(con, src, name)
            except duckdb.Error:
                pass  # a column that can't be binned still shows its summary stats
            columns.append(entry)
    return {
        "rows": summary[0]["count"] if summary else 0,
        "columns": columns,
        "truncated": len(summary) > MAX_COLUMNS,
    }
