"""Sample-first mode for BigQuery queries: add `TABLESAMPLE SYSTEM (n PERCENT)` to the tables a query reads.

BigQuery bills TABLESAMPLE by the blocks it actually reads, so a 10 percent sample scans about a tenth of the
bytes. Only fully written table references (`project.dataset.table`, or backtick-quoted) are sampled; CTE
names, subqueries, UNNEST and wildcard tables are left alone.
"""

import re

TOKEN = re.compile(
    r"""
    (?P<comment>--[^\n]*|\#[^\n]*|/\*.*?(?:\*/|$))
  | (?P<string>(?:[rRbB]{0,2})(?:'''.*?(?:'''|$)|\"\"\".*?(?:\"\"\"|$)|'(?:\\.|[^'\\\n])*'?|"(?:\\.|[^"\\\n])*"?))
  | (?P<ref>(?:`[^`]*`|[A-Za-z_][A-Za-z0-9_-]*\*?)(?:\s*\.\s*(?:`[^`]*`|[A-Za-z_][A-Za-z0-9_-]*\*?))*)
  | (?P<ws>\s+)
  | (?P<other>.)
    """,
    re.VERBOSE | re.DOTALL,
)

# Keywords that can follow a table reference, so a word after it is NOT an alias.
NOT_ALIAS = {
    "WHERE", "GROUP", "ORDER", "HAVING", "QUALIFY", "WINDOW", "LIMIT", "UNION", "INTERSECT", "EXCEPT",
    "JOIN", "INNER", "LEFT", "RIGHT", "FULL", "CROSS", "NATURAL", "ON", "USING", "FOR", "TABLESAMPLE",
    "PIVOT", "UNPIVOT", "SELECT", "FROM", "WITH", "OFFSET", "LATERAL",
}  # fmt: skip
# `FROM` inside these calls is part of the expression syntax (EXTRACT(DAY FROM d)), not a table list.
EXPRESSION_FROM = {"EXTRACT", "TRIM", "LTRIM", "RTRIM", "SUBSTRING", "SUBSTR", "OVERLAY"}


def _parts(ref: str) -> int:
    return len(re.findall(r"`[^`]*`|[^.\s`]+", ref))


def _is_table(ref: str, strict: bool) -> bool:
    """FROM accepts `dataset.table`; after JOIN or a comma, `t.items` may be a correlated array, so be strict."""
    if "*" in ref:
        return False
    if "`" in ref:
        return True
    return _parts(ref) >= (3 if strict else 2)


def sample_sql(sql: str, percent: float) -> tuple[str, int]:
    """Return the SQL with TABLESAMPLE added to every plain table reference, and how many were sampled."""
    clause = f" TABLESAMPLE SYSTEM ({percent:g} PERCENT)"
    toks = [(m.lastgroup, m.group(), m.start(), m.end()) for m in TOKEN.finditer(sql)]
    sig = [t for t in toks if t[0] not in ("ws", "comment")]
    inserts: list[int] = []
    parens: list[str] = []  # the word before each open "(", upper-cased
    in_list = False  # inside a FROM list, where a comma starts another table
    i = 0
    while i < len(sig):
        kind, text = sig[i][:2]
        up = text.upper()
        if kind == "other" and text == "(":
            parens.append(sig[i - 1][1].upper() if i and sig[i - 1][0] == "ref" else "")
            in_list = False
        elif kind == "other" and text == ")":
            if parens:
                parens.pop()
            in_list = False
        elif kind == "ref" and up in ("FROM", "JOIN"):
            prev = sig[i - 1][1].upper() if i else ""
            expr_from = up == "FROM" and (prev == "DISTINCT" or (parens and parens[-1] in EXPRESSION_FROM))
            if not expr_from:
                in_list = True
                i = _table(sig, i + 1, strict=up == "JOIN", inserts=inserts) - 1
        elif kind == "other" and text == "," and in_list:
            i = _table(sig, i + 1, strict=True, inserts=inserts) - 1
        elif kind == "ref" and up in NOT_ALIAS:
            in_list = in_list and up in (
                "JOIN",
                "ON",
                "USING",
                "LATERAL",
                "INNER",
                "LEFT",
                "RIGHT",
                "FULL",
                "CROSS",
            )
        elif kind == "other" and text == ";":
            in_list = False
        i += 1
    for pos in sorted(inserts, reverse=True):
        sql = sql[:pos] + clause + sql[pos:]
    return sql, len(inserts)


def _table(sig: list, i: int, *, strict: bool, inserts: list[int]) -> int:
    """Look at the table reference starting at sig[i]; record where to insert. Returns the next index to scan."""
    if i >= len(sig) or sig[i][0] != "ref":
        return i
    ref = sig[i][1]
    up = ref.upper()
    if up in ("UNNEST", "LATERAL") or not _is_table(ref, strict):
        return i + 1
    pos = sig[i][3]
    j = i + 1
    if j < len(sig) and sig[j][0] == "ref" and sig[j][1].upper() == "AS" and j + 1 < len(sig):
        pos, j = sig[j + 1][3], j + 2
    elif j < len(sig) and sig[j][0] == "ref" and sig[j][1].upper() not in NOT_ALIAS:
        pos, j = sig[j][3], j + 1
    nxt = sig[j][1].upper() if j < len(sig) and sig[j][0] == "ref" else ""
    if nxt not in ("TABLESAMPLE", "FOR"):  # already sampled, or time travel: leave it
        inserts.append(pos)
    return j
