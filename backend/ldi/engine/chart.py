"""Chart data for chart nodes: DuckDB aggregates the input's Parquet so only a few thousand points leave the server."""

from pathlib import Path

import duckdb

from ..cache.store import quote_ident, quote_path, to_json
from .profile import kind_of

MAX_POINTS = 5000
MAX_CATEGORIES = 30
MAX_SERIES = 8
MAX_PIVOT_ROWS = 50
MAX_PIVOT_COLS = 20

AGG_SQL = {
    "sum": "sum({})",
    "avg": "avg({})",
    "min": "min({})",
    "max": "max({})",
    "count": "count({})",
    "count_distinct": "count(DISTINCT {})",
}


class ChartError(ValueError):
    pass


def _agg(agg: str, col: str | None) -> str:
    if col is None:
        if agg == "count":
            return "count(*)"
        raise ChartError("Pick a column to aggregate")
    arg = f"{quote_ident(col)}::DOUBLE" if agg in ("sum", "avg") else quote_ident(col)
    return AGG_SQL[agg].format(arg)


def _check(cols: dict[str, str], *names: str | None) -> None:
    for n in names:
        if n and n not in cols:
            raise ChartError(f"The input has no column '{n}'")


def _num(v):
    if v is None:
        return None
    return to_json(v if isinstance(v, (int, float)) else float(v))


def _label(v) -> str:
    return "(empty)" if v is None else str(to_json(v))


def chart_data(path: Path, cfg: dict) -> dict:
    src = f"read_parquet({quote_path(path)})"
    builders = {"bar": _bar, "line": _line, "scatter": _scatter, "pivot": _pivot}
    kind = cfg.get("type", "bar")
    if kind not in builders:
        raise ChartError(f"Unknown chart type '{kind}'")
    with duckdb.connect() as con:
        cols = {r[0]: r[1] for r in con.execute(f"DESCRIBE SELECT * FROM {src}").fetchall()}
        try:
            return builders[kind](con, src, cols, cfg)
        except duckdb.Error as exc:
            raise ChartError(str(exc).splitlines()[0]) from None


def _measures(cfg: dict) -> list[str | None]:
    ys = cfg.get("y") or []
    if not ys and cfg.get("agg") == "count":
        return [None]
    if not ys:
        raise ChartError("Pick at least one Y column")
    return ys


def _measure_name(agg: str, y: str | None) -> str:
    return "count" if y is None else f"{agg}({y})"


def _series_values(con, src: str, series: str, limit: int) -> list:
    """The most frequent values of the series column."""
    rows = con.execute(
        f"SELECT {quote_ident(series)} FROM {src} GROUP BY 1 ORDER BY count(*) DESC, 1 LIMIT {limit}"
    ).fetchall()
    return [r[0] for r in rows]


def _bar(con, src, cols, cfg) -> dict:
    x, series, agg = cfg.get("x"), cfg.get("series"), cfg.get("agg", "sum")
    if not x:
        raise ChartError("Pick an X column")
    ys = _measures(cfg)
    _check(cols, x, series, *ys)
    if series and len(ys) > 1:
        raise ChartError("Use either several Y columns or a series column, not both")
    key = f"coalesce({quote_ident(x)}::VARCHAR, '(empty)')"
    # Keep the biggest categories (by the first measure) and fold the rest into "Other".
    top = [
        r[0]
        for r in con.execute(
            f"SELECT {key} FROM {src} GROUP BY 1 ORDER BY {_agg(agg, ys[0])} DESC NULLS LAST, 1 LIMIT {MAX_CATEGORIES}"
        ).fetchall()
    ]
    (total,) = con.execute(f"SELECT count(DISTINCT {key}) FROM {src}").fetchone()
    bucket = f"CASE WHEN {key} IN ({', '.join('?' for _ in top) or 'NULL'}) THEN {key} ELSE 'Other' END"
    params: list = list(top)
    if series:
        values = _series_values(con, src, series, MAX_SERIES)
        sq = quote_ident(series)
        names = [_label(v) for v in values]
        measures = ", ".join(f"{_agg(agg, ys[0])} FILTER (WHERE {sq} IS NOT DISTINCT FROM ?)" for _ in values)
        params += values
    else:
        names = [_measure_name(agg, y) for y in ys]
        measures = ", ".join(_agg(agg, y) for y in ys)
    if not names:
        raise ChartError("The series column has no values")
    rows = {
        r[0]: r[1:]
        for r in con.execute(
            f"SELECT {bucket} AS bucket, {measures} FROM {src} GROUP BY bucket", params
        ).fetchall()
    }
    labels = list(top) + (["Other"] if "Other" in rows else [])
    return {
        "type": "bar",
        "labels": labels,
        "series": [
            {"name": n, "values": [_num(rows[lab][i]) if lab in rows else None for lab in labels]}
            for i, n in enumerate(names)
        ],
        "truncated": total > MAX_CATEGORIES,
        "categories": total,
    }


def _x_axis(cols: dict[str, str], x: str) -> tuple[str, str]:
    """(SQL expression, kind) that turns the X column into numbers uPlot can draw."""
    k = kind_of(cols[x])
    xq = quote_ident(x)
    if k == "numeric":
        return f"{xq}::DOUBLE", "numeric"
    if k == "temporal":
        return f"epoch({xq}::TIMESTAMP)", "temporal"
    return f"{xq}::VARCHAR", "category"


def _line(con, src, cols, cfg) -> dict:
    x, series, agg = cfg.get("x"), cfg.get("series"), cfg.get("agg", "sum")
    if not x:
        raise ChartError("Pick an X column")
    ys = _measures(cfg)
    _check(cols, x, series, *ys)
    if series and len(ys) > 1:
        raise ChartError("Use either several Y columns or a series column, not both")
    xe, xkind = _x_axis(cols, x)
    if series:
        values = _series_values(con, src, series, MAX_SERIES)
        sq = quote_ident(series)
        names = [_label(v) for v in values]
        measures = ", ".join(f"{_agg(agg, ys[0])} FILTER (WHERE {sq} IS NOT DISTINCT FROM ?)" for _ in values)
        params = list(values)
    else:
        names = [_measure_name(agg, y) for y in ys]
        measures = ", ".join(_agg(agg, y) for y in ys)
        params = []
    if not names:
        raise ChartError("The series column has no values")
    rows = con.execute(
        f"SELECT {xe} AS x, {measures} FROM {src} WHERE {quote_ident(x)} IS NOT NULL "
        f"GROUP BY x ORDER BY x LIMIT {MAX_POINTS + 1}",
        params,
    ).fetchall()
    truncated = len(rows) > MAX_POINTS
    rows = rows[:MAX_POINTS]
    if xkind == "category":
        labels, xs = [r[0] for r in rows], list(range(len(rows)))
    else:
        labels, xs = None, [r[0] for r in rows]
    return {
        "type": "line",
        "xkind": xkind,
        "x": xs,
        "labels": labels,
        "series": [{"name": n, "values": [_num(r[i + 1]) for r in rows]} for i, n in enumerate(names)],
        "truncated": truncated,
    }


def _scatter(con, src, cols, cfg) -> dict:
    x, series = cfg.get("x"), cfg.get("series")
    ys = cfg.get("y") or []
    if not x or not ys:
        raise ChartError("Pick an X and a Y column")
    y = ys[0]
    _check(cols, x, y, series)
    if kind_of(cols[y]) != "numeric":
        raise ChartError("The Y column of a scatter plot must be numeric")
    xe, xkind = _x_axis(cols, x)
    if xkind == "category":
        raise ChartError("The X column of a scatter plot must be numeric or a date")
    where = f"{quote_ident(x)} IS NOT NULL AND {quote_ident(y)} IS NOT NULL"
    (total,) = con.execute(f"SELECT count(*) FROM {src} WHERE {where}").fetchone()
    sq = quote_ident(series) if series else "NULL"
    rows = con.execute(
        f"SELECT {xe} AS x, {quote_ident(y)}::DOUBLE AS y, {sq} AS s FROM {src} WHERE {where} "
        f"USING SAMPLE reservoir({MAX_POINTS} ROWS) REPEATABLE (42)"
    ).fetchall()
    rows.sort(key=lambda r: r[0])
    if series:
        counts: dict = {}
        for r in rows:
            counts[r[2]] = counts.get(r[2], 0) + 1
        keep = sorted(counts, key=lambda k: -counts[k])[:MAX_SERIES]
        out = [{"name": _label(k), "values": [r[1] if r[2] == k else None for r in rows]} for k in keep]
    else:
        out = [{"name": y, "values": [r[1] for r in rows]}]
    return {
        "type": "scatter",
        "xkind": xkind,
        "x": [r[0] for r in rows],
        "series": out,
        "total": total,
        "shown": len(rows),
    }


def _pivot(con, src, cols, cfg) -> dict:
    rows_col, cols_col, value, agg = cfg.get("rows"), cfg.get("cols"), cfg.get("value"), cfg.get("agg", "sum")
    if not rows_col:
        raise ChartError("Pick a Rows column")
    _check(cols, rows_col, cols_col, value)
    rq = quote_ident(rows_col)
    measure = _agg(agg, value)
    top_rows = _series_values(con, src, rows_col, MAX_PIVOT_ROWS)
    (n_rows,) = con.execute(f"SELECT count(DISTINCT {rq}) FROM {src}").fetchone()
    top_cols: list = [None]
    n_cols = 1
    if cols_col:
        top_cols = _series_values(con, src, cols_col, MAX_PIVOT_COLS)
        (n_cols,) = con.execute(f"SELECT count(DISTINCT {quote_ident(cols_col)}) FROM {src}").fetchone()
    col_sql = quote_ident(cols_col) if cols_col else "NULL"
    cells = {
        (r[0], r[1]): r[2]
        for r in con.execute(f"SELECT {rq}, {col_sql}, {measure} FROM {src} GROUP BY 1, 2").fetchall()
    }
    top_rows.sort(key=lambda v: (v is None, str(v)))
    top_cols.sort(key=lambda v: (v is None, str(v)))
    return {
        "type": "pivot",
        "rows_label": rows_col,
        "cols_label": cols_col,
        "measure": _measure_name(agg, value),
        "row_labels": [_label(r) for r in top_rows],
        "col_labels": [_label(c) for c in top_cols] if cols_col else [_measure_name(agg, value)],
        "cells": [[_num(cells.get((r, c))) for c in top_cols] for r in top_rows],
        "truncated": n_rows > MAX_PIVOT_ROWS or n_cols > MAX_PIVOT_COLS,
        "row_count": n_rows,
        "col_count": n_cols,
    }
