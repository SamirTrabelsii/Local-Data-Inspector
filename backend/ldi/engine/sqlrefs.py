"""Rewrite references to a renamed input in DuckDB SQL, without touching strings, comments or columns.

A reference is an identifier token (bare or "quoted") equal to the old name, case-insensitively, that is
not a column of something else (`x.orders`), not a function call (`orders(`) and not an alias (`AS orders`).
"""

import re

TOKEN = re.compile(
    r"""
    (?P<comment>--[^\n]*|/\*.*?(?:\*/|$))
  | (?P<string>'(?:[^']|'')*'?)
  | (?P<dollar>\$(?P<tag>[A-Za-z_]*)\$.*?(?:\$(?P=tag)\$|$))
  | (?P<quoted>"(?:[^"]|"")*"?)
  | (?P<word>[A-Za-z_][A-Za-z0-9_$]*)
  | (?P<other>\s+|.)
    """,
    re.VERBOSE | re.DOTALL,
)


def _quote(name: str) -> str:
    return '"' + name.replace('"', '""') + '"'


def rename_references(sql: str, old: str, new: str) -> tuple[str, int]:
    """Return the rewritten SQL and how many references were replaced."""
    out: list[str] = []
    count = 0
    prev = ""  # last significant token, upper-cased for keywords
    for m in TOKEN.finditer(sql):
        kind = m.lastgroup
        text = m.group()
        if kind in ("word", "quoted"):
            ident = text if kind == "word" else text[1:-1].replace('""', '"')
            nxt = sql[m.end() :].lstrip()[:1]
            if ident.lower() == old.lower() and prev not in (".", "AS") and nxt != "(":
                text = new if kind == "word" else _quote(new)
                count += 1
        out.append(text)
        if kind != "comment" and not text.isspace():
            prev = text.upper() if kind == "word" else text
    return "".join(out), count
