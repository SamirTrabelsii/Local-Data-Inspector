"""Workspace parameters: `{{name}}` placeholders in Source and Transform SQL.

BigQuery sources bind them as native query parameters (`@ldi_name`), so a value can never alter the query.
DuckDB transforms get a safely quoted literal. Placeholders inside comments are ignored; inside a quoted string
they are an error (a bound parameter can't live inside a string literal), so write `d >= {{start}}`, not
`d >= '{{start}}'`.
"""

import datetime as dt
import re
from dataclasses import dataclass

PARAM_TYPES = ("string", "number", "date", "bool")
NAME_RE = re.compile(r"^[A-Za-z_][A-Za-z0-9_]{0,62}$")
PLACEHOLDER = re.compile(r"\{\{\s*([A-Za-z_][A-Za-z0-9_]*)\s*\}\}")

_COMMENT = r"(?P<comment>--[^\n]*|/\*.*?(?:\*/|$))"
_BQ_STRING = (
    r"""(?P<string>(?:'''.*?(?:'''|$)|\"\"\".*?(?:\"\"\"|$)|'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?))"""
)
_DUCK_STRING = r"""(?P<string>'(?:[^']|'')*'?|"(?:[^"]|"")*"?)"""
_SCANNERS = {
    d: re.compile(rf"{_COMMENT}|{s}|(?P<code>[^-/'\"]+|.)", re.DOTALL)
    for d, s in (("bigquery", _BQ_STRING), ("duckdb", _DUCK_STRING))
}


class ParamError(ValueError):
    pass


@dataclass(frozen=True)
class Param:
    name: str
    type: str
    value: str

    @property
    def typed(self) -> str | int | float | dt.date | bool:
        return parse_value(self.type, self.value)

    @property
    def fingerprint(self) -> str:
        """What a run records: changes whenever the value or its type changes."""
        return f"{self.type}:{self.value}"


def parse_value(type_: str, value: str) -> str | int | float | dt.date | bool:
    text = str(value).strip() if type_ != "string" else str(value)
    try:
        if type_ == "string":
            return text
        if type_ == "number":
            return int(text) if re.fullmatch(r"[+-]?\d+", text) else float(text)
        if type_ == "date":
            return dt.date.fromisoformat(text)
        if type_ == "bool":
            if text.lower() not in ("true", "false"):
                raise ValueError
            return text.lower() == "true"
    except ValueError:
        pass
    raise ParamError(f"'{value}' is not a valid {type_}" + (" (use YYYY-MM-DD)" if type_ == "date" else ""))


def validate(name: str, type_: str, value: str) -> Param:
    if not NAME_RE.match(name):
        raise ParamError("Names must start with a letter or _ and contain only letters, digits and _")
    if type_ not in PARAM_TYPES:
        raise ParamError(f"Unknown parameter type '{type_}'")
    text = str(value).strip() if type_ != "string" else str(value)
    parse_value(type_, text)
    return Param(name, type_, text)


def _segments(sql: str, dialect: str):
    for m in _SCANNERS[dialect].finditer(sql):
        yield m.lastgroup, m.group()


def find(sql: str, dialect: str = "duckdb") -> list[str]:
    """Names used in the code part of the SQL (not in comments), in order of first use."""
    seen: dict[str, None] = {}
    for kind, text in _segments(sql, dialect):
        if kind in ("code", "string"):
            for m in PLACEHOLDER.finditer(text):
                seen.setdefault(m.group(1))
    return list(seen)


def _substitute(sql: str, dialect: str, params: dict[str, Param], render) -> str:
    out: list[str] = []
    for kind, text in _segments(sql, dialect):
        if kind == "comment":
            out.append(text)
            continue

        def sub(m: re.Match, in_string: bool = kind == "string") -> str:
            if in_string:
                raise ParamError(
                    f"{{{{{m.group(1)}}}}} is inside a quoted string. Remove the quotes: parameters are typed values"
                )
            p = params.get(m.group(1))
            if p is None:
                raise ParamError(f"Unknown parameter {{{{{m.group(1)}}}}}. Define it in Parameters")
            return render(p)

        out.append(PLACEHOLDER.sub(sub, text))
    return "".join(out)


def _bq_type(p: Param) -> str:
    return {"string": "STRING", "date": "DATE", "bool": "BOOL"}.get(p.type) or (
        "INT64" if isinstance(p.typed, int) else "FLOAT64"
    )


def bind_bigquery(sql: str, params: dict[str, Param]) -> tuple[str, list[tuple[str, str, object]]]:
    """SQL with `@ldi_<name>` markers, plus (name, BigQuery type, value) for each parameter used."""
    used: dict[str, Param] = {}

    def render(p: Param) -> str:
        used[p.name] = p
        return f"@ldi_{p.name}"

    bound = _substitute(sql, "bigquery", params, render)
    return bound, [(f"ldi_{p.name}", _bq_type(p), p.typed) for p in used.values()]


def duckdb_literal(p: Param) -> str:
    v = p.typed
    if isinstance(v, bool):
        return "TRUE" if v else "FALSE"
    if isinstance(v, dt.date):
        return f"DATE '{v.isoformat()}'"
    if isinstance(v, (int, float)):
        return repr(v)
    return "'" + v.replace("'", "''") + "'"


def bind_duckdb(sql: str, params: dict[str, Param]) -> str:
    return _substitute(sql, "duckdb", params, duckdb_literal)


def snapshot(sql: str, params: dict[str, Param], dialect: str) -> dict[str, str | None]:
    """{name: fingerprint} for the parameters this SQL uses (None when undefined). Compared to decide staleness."""
    return {n: (params[n].fingerprint if n in params else None) for n in find(sql, dialect)}
