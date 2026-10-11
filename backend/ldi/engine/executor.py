"""Background execution. Runs are chains of node ids executed in order; a failure or a cancel stops the chain."""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .. import db, repo
from ..cache import store
from . import dag, source_bq, source_file, transform_duck
from .cancel import Cancelled, Token

log = logging.getLogger(__name__)


class Busy(Exception):
    pass


def _run_source(node: dict, out, token: Token) -> dict:
    source_type = node["source_type"]
    if source_type == "bq_table":
        return source_bq.read_table_to_parquet(node["config"], db.get_settings(), out, token)
    if source_type == "file":
        source_file.to_parquet(node["config"], out, token)
        return {}
    if not node["sql"].strip():
        raise ValueError("SQL is empty")
    sql = source_bq.effective_sql(node["sql"], node["config"].get("sample_percent"))
    return source_bq.run_to_parquet(sql, db.get_settings(), out, token)


def _record_savings(node: dict, stats: dict) -> None:
    """Ledger entry for a finished run: what a BigQuery run billed, or what a free transform run avoided."""
    price = db.get_settings()["price_per_tib_usd"]
    if node["kind"] == "source":
        if node["source_type"] == "bq_query":
            repo.add_ledger(
                node["id"], node["name"], "bq",
                bytes_billed=stats.get("bytes_billed") or 0, bytes_avoided=0, price_per_tib_usd=price,
            )  # fmt: skip
        return
    # A transform reads cached data; without the cache each run would have re-queried its upstream sources.
    edges = repo.list_edges()
    ancestors = dag.ancestors(edges, node["id"])
    runs = repo.get_runs()
    avoided = sum(
        (runs[n["id"]]["bytes_processed"] or 0)
        for n in repo.list_nodes()
        if n["id"] in ancestors and n["kind"] == "source" and n["source_type"] != "file" and n["id"] in runs
    )
    repo.add_ledger(
        node["id"], node["name"], "local", bytes_billed=0, bytes_avoided=avoided, price_per_tib_usd=price
    )


def run_node(node_id: str, token: Token | None = None) -> None:
    token = token or Token()
    node = repo.get_node(node_id)
    sql = node["sql"]
    if node["kind"] == "transform" and not sql.strip():
        raise ValueError("SQL is empty")
    out = store.new_result_path(node_id)
    started = time.perf_counter()
    inputs: dict[str, str] = {}
    stats: dict = {}
    try:
        if node["kind"] == "source":
            stats = _run_source(node, out, token)
        else:
            names = {n["id"]: n["name"] for n in repo.list_nodes()}
            runs = repo.get_runs()
            views = {}
            for parent in dag.parents_map(repo.list_edges()).get(node_id, []):
                run = runs.get(parent)
                if run is None:
                    raise ValueError(f"Input '{names[parent]}' has no results yet - run it first")
                views[names[parent]] = store.result_path(parent, run["cache_file"])
                inputs[parent] = run["finished_at"]
            transform_duck.run_to_parquet(sql, views, out, token)
        token.check()
        exec_ms = round((time.perf_counter() - started) * 1000)
        row_count, columns = store.describe(out)
    except BaseException:
        out.unlink(missing_ok=True)
        out.with_suffix(".tmp").unlink(missing_ok=True)
        raise
    repo.save_run(
        node_id,
        sql_hash=dag.node_hash(node),
        inputs=inputs,
        cache_file=out.name,
        row_count=row_count,
        columns=columns,
        exec_ms=exec_ms,
        **stats,
    )
    try:
        _record_savings(node, stats)
    except Exception:  # bookkeeping must never fail a run that already succeeded
        log.exception("Could not record savings for %s", node["name"])
    store.cleanup(node_id, keep=out)


class _Chain:
    def __init__(self, node_ids: list[str]) -> None:
        self.node_ids = node_ids
        self.token = Token()


class Executor:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._running: set[str] = set()
        self._chains: list[_Chain] = []
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ldi-run")

    def running(self) -> set[str]:
        with self._lock:
            return set(self._running)

    def submit(self, node_ids: list[str]) -> None:
        chain = _Chain(node_ids)
        with self._lock:
            if self._running.intersection(node_ids):
                raise Busy("Some of these nodes are already running")
            self._running.update(node_ids)
            self._chains.append(chain)
        self._pool.submit(self._run_chain, chain)

    def cancel(self, node_id: str) -> bool:
        """Cancel the run that `node_id` is part of (the node itself, or a queued chain containing it)."""
        with self._lock:
            chains = [c for c in self._chains if node_id in c.node_ids and node_id in self._running]
        for chain in chains:
            chain.token.cancel()
        return bool(chains)

    def _run_chain(self, chain: _Chain) -> None:
        try:
            for node_id in chain.node_ids:
                try:
                    run_node(node_id, chain.token)
                except Exception as exc:  # noqa: BLE001 - every failure is reported on the node
                    if chain.token.cancelled or isinstance(exc, Cancelled):
                        log.info("Run of %s cancelled", node_id)
                        return
                    log.warning("Node %s failed: %s", node_id, exc)
                    repo.save_error(node_id, source_bq.error_message(exc))
                    return
                finally:
                    with self._lock:
                        self._running.discard(node_id)
        finally:
            with self._lock:
                self._running.difference_update(chain.node_ids)
                self._chains.remove(chain)


executor = Executor()
