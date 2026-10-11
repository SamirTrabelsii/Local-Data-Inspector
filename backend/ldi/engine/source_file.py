"""File sources: a CSV / Parquet / Excel / JSON file dropped in the UI, copied into the workspace, read by DuckDB."""

import re
import zipfile
from pathlib import Path

import duckdb

from .. import config
from ..cache.store import quote_path
from .cancel import Token

FORMATS = {
    ".csv": "csv",
    ".tsv": "csv",
    ".txt": "csv",
    ".parquet": "parquet",
    ".xlsx": "excel",
    ".json": "json",
    ".jsonl": "json",
    ".ndjson": "json",
}


def detect_format(filename: str) -> str:
    fmt = FORMATS.get(Path(filename).suffix.lower())
    if fmt is None:
        raise ValueError(f"Unsupported file type '{Path(filename).suffix}'. Use CSV, Parquet, Excel (.xlsx) or JSON")
    return fmt


def file_path(cfg: dict) -> Path:
    """Resolve a node's stored file, refusing anything outside the workspace files directory."""
    root = config.files_dir().resolve()
    path = (root / cfg.get("file", "")).resolve()
    if root not in path.parents:
        raise ValueError("Invalid file reference")
    return path


def excel_sheets(path: Path) -> list[str]:
    with zipfile.ZipFile(path) as z:
        xml = z.read("xl/workbook.xml").decode("utf-8", errors="replace")
    return re.findall(r'<sheet\b[^>]*\bname="([^"]*)"', xml)


def _reader(path: Path, fmt: str, cfg: dict) -> str:
    p = quote_path(path)
    if fmt == "csv":
        return f"read_csv({p}, auto_detect = true)"
    if fmt == "parquet":
        return f"read_parquet({p})"
    if fmt == "json":
        return f"read_json_auto({p})"
    sheet = cfg.get("sheet")
    sheet_arg = f", sheet = '{sheet.replace(chr(39), chr(39) * 2)}'" if sheet else ""
    return f"read_xlsx({p}, header = true{sheet_arg})"


def to_parquet(cfg: dict, out: Path, token: Token | None = None) -> None:
    token = token or Token()
    path = file_path(cfg)
    if not path.exists():
        raise ValueError(f"The file {cfg.get('name', path.name)} is missing - drop it again")
    fmt = cfg.get("format") or detect_format(path.name)
    tmp = out.with_suffix(".tmp")
    with duckdb.connect() as con, token.on_cancel(con.interrupt):
        token.check()
        if fmt == "excel":
            con.execute("INSTALL excel; LOAD excel")  # downloaded once, then cached by DuckDB
        con.execute(
            f"COPY (SELECT * FROM {_reader(path, fmt, cfg)}) TO {quote_path(tmp)} (FORMAT parquet, COMPRESSION zstd)"
        )
    token.check()
    tmp.replace(out)
