from conftest import wait_idle

from ldi.engine import costwarn
from ldi.engine.sampling import sample_sql

GIB = 1024**3
SETTINGS = {"max_bytes_billed": 50 * GIB}


def run(client, node_id):
    assert client.post(f"/api/nodes/{node_id}/run").status_code == 202
    return wait_idle(client)


def make_pipeline(client):
    src = client.post("/api/nodes", json={"kind": "source", "name": "orders", "sql": "SELECT 1"}).json()
    sql = "SELECT country, sum(amount) AS t FROM orders GROUP BY ALL"
    tr = client.post(
        "/api/nodes", json={"kind": "transform", "name": "agg", "sql": sql, "inputs": [src["id"]]}
    ).json()
    return src, tr


# ---- savings meter ----------------------------------------------------------------


def test_savings_ledger_counts_spend_and_avoided_bytes(client):
    src, tr = make_pipeline(client)
    assert client.get("/api/savings").json()["total"]["spent_bytes"] == 0

    run(client, src["id"])  # BigQuery: billed 10 MiB (fake), processed 1234
    run(client, tr["id"])  # free local run: avoids re-querying the source
    run(client, tr["id"])
    data = client.get("/api/savings").json()

    assert data["total"]["spent_bytes"] == 10485760
    assert data["total"]["avoided_bytes"] == 2 * 1234
    assert data["total"]["bq_runs"] == 1 and data["total"]["local_runs"] == 2
    assert data["total"]["avoided_usd"] > 0
    by_name = {n["name"]: n for n in data["nodes"]}
    assert by_name["orders"]["spent_bytes"] == 10485760 and by_name["orders"]["avoided_bytes"] == 0
    assert by_name["agg"]["avoided_bytes"] == 2 * 1234 and by_name["agg"]["spent_bytes"] == 0


def test_savings_history_survives_node_deletion(client):
    src, tr = make_pipeline(client)
    run(client, src["id"])
    run(client, tr["id"])
    assert client.delete(f"/api/nodes/{tr['id']}").status_code == 204
    data = client.get("/api/savings").json()
    assert data["total"]["avoided_bytes"] == 1234  # still counted in the total
    assert [n["name"] for n in data["nodes"]] == ["orders"]  # but no row for the deleted node


# ---- sample-first -------------------------------------------------------------------


def test_sample_sql_targets_only_real_tables():
    s = "SELECT EXTRACT(DAY FROM t.d), a IS DISTINCT FROM b.c FROM p.d.t t JOIN `p.d.u` AS u ON t.id = u.id, t.items"
    out, n = sample_sql(s, 10)
    assert n == 2
    assert (
        "FROM p.d.t t TABLESAMPLE SYSTEM (10 PERCENT) JOIN `p.d.u` AS u TABLESAMPLE SYSTEM (10 PERCENT) ON"
        in out
    )
    assert out.endswith(", t.items")


def test_sample_sql_leaves_ctes_wildcards_subqueries_and_existing_samples_alone():
    assert sample_sql("WITH c AS (SELECT 1) SELECT * FROM c", 5) == (
        "WITH c AS (SELECT 1) SELECT * FROM c",
        0,
    )
    assert sample_sql("SELECT * FROM p.d.events_*", 5)[1] == 0
    assert sample_sql("SELECT * FROM p.d.t TABLESAMPLE SYSTEM (1 PERCENT)", 5)[1] == 0
    assert sample_sql("SELECT * FROM p.d.t FOR SYSTEM_TIME AS OF CURRENT_TIMESTAMP()", 5)[1] == 0
    assert sample_sql("SELECT 'FROM p.d.t' -- FROM p.d.q\n", 5)[1] == 0
    out, n = sample_sql("SELECT * FROM (SELECT * FROM p.d.t) x", 12.5)
    assert n == 1 and "TABLESAMPLE SYSTEM (12.5 PERCENT)" in out


def test_sample_run_sends_sampled_sql_and_flags_downstream(client, monkeypatch):
    import pyarrow as pa
    import pyarrow.parquet as pq

    from ldi.engine import source_bq

    seen = []

    def fake(sql, settings, out, token=None):
        seen.append(sql)
        pq.write_table(pa.table({"amount": [1.0, 2.0], "country": ["TN", "FR"]}), out)
        return {"bytes_processed": 100, "bytes_billed": 1000}

    monkeypatch.setattr(source_bq, "run_to_parquet", fake)
    src, _ = make_pipeline(client)
    client.patch(
        f"/api/nodes/{src['id']}", json={"sql": "SELECT * FROM p.d.orders", "config": {"sample_percent": 10}}
    )
    nodes = run(client, src["id"])
    assert seen == ["SELECT * FROM p.d.orders TABLESAMPLE SYSTEM (10 PERCENT)"]
    assert nodes["orders"]["sampled"] is True and nodes["agg"]["sampled"] is True

    # Promote: switching sampling off makes the node stale until it is run in full.
    client.patch(f"/api/nodes/{src['id']}", json={"config": {}})
    nodes = wait_idle(client)
    assert nodes["orders"]["status"] == "stale" and nodes["orders"]["sampled"] is False
    run(client, src["id"])
    assert seen[-1] == "SELECT * FROM p.d.orders"


def test_sample_mode_without_a_table_is_an_error(client):
    src, _ = make_pipeline(client)  # "SELECT 1" has no table
    client.patch(f"/api/nodes/{src['id']}", json={"config": {"sample_percent": 10}})
    nodes = run(client, src["id"])
    assert nodes["orders"]["status"] == "error" and "no table to sample" in nodes["orders"]["error"]


def test_sample_percent_is_validated(client):
    src, _ = make_pipeline(client)
    assert (
        client.patch(f"/api/nodes/{src['id']}", json={"config": {"sample_percent": 100}}).status_code == 400
    )
    assert (
        client.patch(f"/api/nodes/{src['id']}", json={"config": {"sample_percent": "abc"}}).status_code == 400
    )


# ---- dry-run warnings ----------------------------------------------------------------

BIG = {"id": "p.d.events", "num_bytes": 20 * GIB, "num_columns": 40, "partition_field": "event_date"}


def codes(sql, tables=(BIG,), processed=GIB, previous=None):
    return [w["code"] for w in costwarn.analyze(sql, list(tables), processed, previous, SETTINGS)]


def test_warns_when_the_partition_column_is_not_filtered():
    assert "missing_partition_filter" in codes("SELECT a FROM p.d.events")
    assert "missing_partition_filter" in codes("SELECT a FROM p.d.events WHERE country = 'TN'")
    assert "missing_partition_filter" in codes("SELECT a FROM p.d.events -- WHERE event_date > 1\n")
    assert "missing_partition_filter" not in codes(
        "SELECT a FROM p.d.events WHERE event_date >= '2024-01-01'"
    )
    small = {**BIG, "num_bytes": 10 * 1024**2}
    assert "missing_partition_filter" not in codes("SELECT a FROM p.d.events", tables=[small])
    ingestion = {**BIG, "partition_field": "_PARTITIONTIME"}
    assert "missing_partition_filter" not in codes(
        "SELECT a FROM t WHERE _PARTITIONDATE = '2024-01-01'", [ingestion]
    )


def test_warns_on_select_star_only_for_wide_tables():
    assert "select_star_wide" in codes("SELECT * FROM p.d.events WHERE event_date > 1")
    assert "select_star_wide" in codes("SELECT e.* FROM p.d.events e WHERE event_date > 1")
    assert "select_star_wide" not in codes("SELECT * EXCEPT (a) FROM p.d.events WHERE event_date > 1")
    assert "select_star_wide" not in codes("SELECT count(*) FROM p.d.events WHERE event_date > 1")
    narrow = {**BIG, "num_columns": 5}
    assert "select_star_wide" not in codes("SELECT * FROM p.d.events WHERE event_date > 1", tables=[narrow])


def test_warns_on_unusually_large_scans():
    ok = "SELECT a FROM p.d.events WHERE event_date > 1"
    assert "large_scan" in codes(ok, processed=10 * GIB, previous=1 * GIB)  # 10x the last run
    assert "large_scan" not in codes(ok, processed=2 * GIB, previous=1 * GIB)
    assert "large_scan" in codes(ok, processed=30 * GIB)  # over half of the 50 GiB cap
    assert "large_scan" not in codes(ok, processed=10 * GIB)
    assert codes(ok, processed=1024**2 * 100, previous=1024**2) == []  # 100x but tiny


# ---- cache manager ---------------------------------------------------------------------


def test_cache_lists_usage_and_pin_protects_from_cleaning(client):
    src, tr = make_pipeline(client)
    run(client, src["id"])
    run(client, tr["id"])
    cache = client.get("/api/cache").json()
    assert {e["name"] for e in cache["entries"]} == {"orders", "agg"}
    assert cache["total_bytes"] > 0 and all(e["bytes"] > 0 for e in cache["entries"])
    orders = next(e for e in cache["entries"] if e["name"] == "orders")
    assert orders["rebuild_from_bigquery"] is True and orders["rebuild_usd"] > 0

    assert client.post(f"/api/nodes/{src['id']}/pin", json={"pinned": True}).json()["pinned"] is True
    preview = client.post("/api/cache/clean", json={"scope": "unpinned", "preview": True}).json()
    assert [n["name"] for n in preview["nodes"]] == ["agg"]
    assert len(client.get("/api/cache").json()["entries"]) == 2  # a preview deletes nothing

    cleaned = client.post("/api/cache/clean", json={"scope": "unpinned"}).json()
    assert [n["name"] for n in cleaned["nodes"]] == ["agg"] and cleaned["freed_bytes"] > 0
    nodes = wait_idle(client)
    assert nodes["agg"]["status"] == "never_run" and nodes["orders"]["status"] == "fresh"
    assert nodes["orders"]["pinned"] is True


def test_clearing_a_node_cache_needs_unpin_and_makes_downstream_stale(client):
    src, tr = make_pipeline(client)
    run(client, src["id"])
    run(client, tr["id"])
    client.post(f"/api/nodes/{src['id']}/pin", json={"pinned": True})
    assert client.delete(f"/api/cache/{src['id']}").status_code == 400
    client.post(f"/api/nodes/{src['id']}/pin", json={"pinned": False})
    assert client.delete(f"/api/cache/{src['id']}").json()["freed_bytes"] > 0
    nodes = wait_idle(client)
    assert nodes["orders"]["status"] == "never_run" and nodes["agg"]["status"] == "stale"
    assert client.get(f"/api/nodes/{src['id']}/results").status_code == 404


def test_clean_by_stale_and_age(client):
    src, tr = make_pipeline(client)
    run(client, src["id"])
    run(client, tr["id"])
    client.patch(f"/api/nodes/{tr['id']}", json={"sql": "SELECT 1 AS x FROM orders"})
    stale = client.post("/api/cache/clean", json={"scope": "stale", "preview": True}).json()
    assert [n["name"] for n in stale["nodes"]] == ["agg"]
    young = {"scope": "older_than", "older_than_days": 1, "preview": True}
    assert client.post("/api/cache/clean", json=young).json()["nodes"] == []
    now = {"scope": "older_than", "older_than_days": 0, "preview": True}
    assert {n["name"] for n in client.post("/api/cache/clean", json=now).json()["nodes"]} == {"orders", "agg"}
