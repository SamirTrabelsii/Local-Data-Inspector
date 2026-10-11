"""Comparing two runs of the same node: what changed in the SQL, parameters, schema and numbers."""

import difflib
import json


def sql_diff(old: str, new: str) -> list[dict]:
    """Line diff as [{op: 'same' | 'add' | 'del', text}]."""
    a, b = old.splitlines(), new.splitlines()
    out: list[dict] = []
    for tag, i1, i2, j1, j2 in difflib.SequenceMatcher(None, a, b, autojunk=False).get_opcodes():
        if tag == "equal":
            out += [{"op": "same", "text": t} for t in a[i1:i2]]
        else:
            out += [{"op": "del", "text": t} for t in a[i1:i2]]
            out += [{"op": "add", "text": t} for t in b[j1:j2]]
    return out


def _delta(a, b):
    return None if a is None or b is None else b - a


def compare(a: dict, b: dict) -> dict:
    """`a` is the earlier run, `b` the later one; deltas are b - a."""
    cols_a = {c["name"]: c["type"] for c in a["columns"]}
    cols_b = {c["name"]: c["type"] for c in b["columns"]}
    params = {
        name: {"before": a["params"].get(name), "after": b["params"].get(name)}
        for name in sorted(set(a["params"]) | set(b["params"]))
        if a["params"].get(name) != b["params"].get(name)
    }
    return {
        "a": a["id"],
        "b": b["id"],
        "sql_changed": a["sql"].strip() != b["sql"].strip(),
        "sql_diff": sql_diff(a["sql"], b["sql"]),
        "config_changed": json.dumps(a["config"], sort_keys=True) != json.dumps(b["config"], sort_keys=True),
        "params_changed": params,
        "columns": {
            "added": [{"name": n, "type": t} for n, t in cols_b.items() if n not in cols_a],
            "removed": [{"name": n, "type": t} for n, t in cols_a.items() if n not in cols_b],
            "retyped": [
                {"name": n, "before": cols_a[n], "after": t}
                for n, t in cols_b.items()
                if n in cols_a and cols_a[n] != t
            ],
        },
        "stats": {
            key: {"a": a[key], "b": b[key], "delta": _delta(a[key], b[key])}
            for key in ("row_count", "exec_ms", "bytes_processed", "bytes_billed")
        },
    }
