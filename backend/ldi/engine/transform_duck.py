"""Transform nodes: DuckDB SQL over upstream Parquet, materialized to Parquet. Free."""

from pathlib import Path

import duckdb

from .. import config
from ..cache.store import quote_ident, quote_path


def run_to_parquet(sql: str, inputs: dict[str, Path], out: Path) -> None:
    """Each input is exposed as a view named after its node. The last statement must be a query."""
    tmp = out.with_suffix(".tmp")
    with duckdb.connect() as con:
        con.execute(f"SET temp_directory = {quote_path(config.duckdb_tmp_dir())}")
        for name, path in inputs.items():
            con.execute(f"CREATE VIEW {quote_ident(name)} AS SELECT * FROM read_parquet({quote_path(path)})")
        rel = con.sql(sql)
        if rel is None:
            raise ValueError("A transform must end with a SELECT query")
        rel.write_parquet(tmp.as_posix(), compression="zstd")
    tmp.replace(out)
