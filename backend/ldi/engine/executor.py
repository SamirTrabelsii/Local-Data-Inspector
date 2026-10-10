"""Background execution. Runs are chains of node ids executed in order; a failure stops the chain."""

import logging
import threading
import time
from concurrent.futures import ThreadPoolExecutor

from .. import db, repo
from ..cache import store
from . import dag, source_bq, transform_duck

log = logging.getLogger(__name__)


class Busy(Exception):
    pass


def run_node(node_id: str) -> None:
    node = repo.get_node(node_id)
    sql = node["sql"]
    if not sql.strip():
        raise ValueError("SQL is empty")
    out = store.new_result_path(node_id)
    started = time.perf_counter()
    inputs: dict[str, str] = {}
    stats: dict = {}
    try:
        if node["kind"] == "source":
            stats = source_bq.run_to_parquet(sql, db.get_settings(), out)
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
            transform_duck.run_to_parquet(sql, views, out)
        exec_ms = round((time.perf_counter() - started) * 1000)
        row_count, columns = store.describe(out)
    except BaseException:
        out.unlink(missing_ok=True)
        out.with_suffix(".tmp").unlink(missing_ok=True)
        raise
    repo.save_run(
        node_id,
        sql_hash=dag.sql_hash(sql),
        inputs=inputs,
        cache_file=out.name,
        row_count=row_count,
        columns=columns,
        exec_ms=exec_ms,
        **stats,
    )
    store.cleanup(node_id, keep=out)


class Executor:
    def __init__(self) -> None:
        self._lock = threading.Lock()
        self._running: set[str] = set()
        self._pool = ThreadPoolExecutor(max_workers=4, thread_name_prefix="ldi-run")

    def running(self) -> set[str]:
        with self._lock:
            return set(self._running)

    def submit(self, node_ids: list[str]) -> None:
        with self._lock:
            if self._running.intersection(node_ids):
                raise Busy("Some of these nodes are already running")
            self._running.update(node_ids)
        self._pool.submit(self._run_chain, node_ids)

    def _run_chain(self, node_ids: list[str]) -> None:
        try:
            for node_id in node_ids:
                try:
                    run_node(node_id)
                except Exception as exc:  # noqa: BLE001 - every failure is reported on the node
                    log.warning("Node %s failed: %s", node_id, exc)
                    repo.save_error(node_id, source_bq.error_message(exc))
                    return
                finally:
                    with self._lock:
                        self._running.discard(node_id)
        finally:
            with self._lock:
                self._running.difference_update(node_ids)


executor = Executor()
