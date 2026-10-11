"""Cost warnings shown next to a dry run. Pure functions: the table facts come from source_bq.

The checks are deliberately conservative. A missed warning costs nothing; a noisy one teaches you to ignore them.
"""

import re

MIB = 1024**2
GIB = 1024**3

WIDE_TABLE_COLUMNS = 20  # SELECT * on a table with more columns than this is flagged
MIN_TABLE_BYTES = 1 * GIB  # smaller tables are cheap to scan whole, so a missing filter doesn't matter
GROWTH_FACTOR = 5  # a scan this many times bigger than the node's previous run is unusual...
GROWTH_MIN_BYTES = 256 * MIB  # ...but only worth mentioning above this size
CAP_FRACTION = 0.5  # a scan using this share of the safety cap

_NOISE = re.compile(
    r"--[^\n]*|#[^\n]*|/\*.*?\*/|'''.*?'''|\"\"\".*?\"\"\"|'(?:\\.|[^'\\\n])*'|\"(?:\\.|[^\"\\\n])*\"",
    re.DOTALL,
)
_WHERE = re.compile(r"\bWHERE\b", re.IGNORECASE)
_SELECT_STAR = re.compile(
    r"\bSELECT\s+(?:DISTINCT\s+)?(?:[\w`.]+\.)?\*(?!\s*(?:EXCEPT|REPLACE)\b)", re.IGNORECASE
)


def strip_noise(sql: str) -> str:
    """Blank out comments and string literals so keywords inside them don't count."""
    return _NOISE.sub(" ", sql)


def _fmt(n: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if n < 1024 or unit == "TB":
            return f"{n:.0f} {unit}" if unit == "B" or n >= 100 else f"{n:.1f} {unit}"
        n /= 1024
    return str(n)


def missing_partition_filter(sql: str, table: dict) -> bool:
    field = table.get("partition_field")
    if not field or (table.get("num_bytes") or 0) < MIN_TABLE_BYTES:
        return False
    names = {field.lower()}
    if field.upper() in ("_PARTITIONTIME", "_PARTITIONDATE"):
        names = {"_partitiontime", "_partitiondate"}
    clean = strip_noise(sql)
    where = _WHERE.search(clean)
    if where is None:
        return True
    filtered = clean[where.end() :].lower()
    return not any(re.search(rf"\b{re.escape(n)}\b", filtered) for n in names)


def analyze(
    sql: str, tables: list[dict], bytes_processed: int, previous_bytes: int | None, settings: dict
) -> list[dict]:
    out: list[dict] = []
    for t in tables:
        if missing_partition_filter(sql, t):
            out.append(
                {
                    "code": "missing_partition_filter",
                    "table": t["id"],
                    "message": f"{t['id']} is partitioned by {t['partition_field']} ({_fmt(t['num_bytes'])}) "
                    "but no WHERE condition uses it, so every partition is scanned.",
                }
            )
    if _SELECT_STAR.search(strip_noise(sql)):
        for t in tables:
            if t.get("num_columns", 0) > WIDE_TABLE_COLUMNS:
                out.append(
                    {
                        "code": "select_star_wide",
                        "table": t["id"],
                        "message": f"SELECT * reads all {t['num_columns']} columns of {t['id']}. "
                        "BigQuery bills per column, so list only the ones you need.",
                    }
                )
    cap = settings["max_bytes_billed"]
    if (
        previous_bytes
        and bytes_processed >= GROWTH_MIN_BYTES
        and bytes_processed >= previous_bytes * GROWTH_FACTOR
    ):
        out.append(
            {
                "code": "large_scan",
                "table": None,
                "message": f"This scans {_fmt(bytes_processed)}, {bytes_processed / previous_bytes:.0f}x more "
                f"than this node's last run ({_fmt(previous_bytes)}).",
            }
        )
    elif cap and bytes_processed >= cap * CAP_FRACTION:
        out.append(
            {
                "code": "large_scan",
                "table": None,
                "message": f"This scans {_fmt(bytes_processed)}, over half of your {_fmt(cap)} safety cap.",
            }
        )
    return out
