import sqlite3
import threading
import time

import pyarrow as pa
import pyarrow.parquet as pq
from conftest import wait_idle

from ldi.engine.sqlrefs import rename_references

CSV = b"id,country,amount\n1,TN,10.5\n2,FR,20\n3,TN,5.25\n"


def upload(client, name, data, x=0, y=0):
    return client.post(f"/api/files?filename={name}&x={x}&y={y}", content=data)


def run(client, node_id):
    assert client.post(f"/api/nodes/{node_id}/run").status_code == 202
    return wait_idle(client)


# ---- safe rename -----------------------------------------------------------------


def test_rename_references_skips_strings_comments_columns_and_aliases():
    sql = (
        "SELECT o.id, orders.amount, x.orders, count(*) AS orders, 'orders' s -- orders\n"
        'FROM orders o JOIN "Orders" USING (id) WHERE orders(1) /* orders */'
    )
    out, n = rename_references(sql, "orders", "sales")
    assert n == 3
    assert out == (
        "SELECT o.id, sales.amount, x.orders, count(*) AS orders, 'orders' s -- orders\n"
        'FROM sales o JOIN "sales" USING (id) WHERE orders(1) /* orders */'
    )
    assert rename_references("SELECT 1", "orders", "sales") == ("SELECT 1", 0)


def test_rename_rewrites_downstream_and_keeps_it_fresh(client):
    src = client.post("/api/nodes", json={"kind": "source", "name": "orders", "sql": "x"}).json()
    sql = "SELECT country, sum(amount) AS t FROM orders GROUP BY ALL"
    tr = client.post("/api/nodes", json={"kind": "transform", "name": "agg", "sql": sql, "inputs": [src["id"]]})
    tr = tr.json()
    run(client, src["id"])
    assert run(client, tr["id"])["agg"]["status"] == "fresh"

    preview = client.get(f"/api/nodes/{src['id']}/rename-preview", params={"name": "sales"}).json()
    assert preview == {"affected": [{"id": tr["id"], "name": "agg", "references": 1}]}

    assert client.patch(f"/api/nodes/{src['id']}", json={"name": "sales"}).status_code == 200
    nodes = wait_idle(client)
    assert nodes["agg"]["sql"] == sql.replace("FROM orders", "FROM sales")
    assert nodes["agg"]["status"] == "fresh"
    assert run(client, tr["id"])["agg"]["status"] == "fresh"  # and it still runs against the renamed input


# ---- cancel ---------------------------------------------------------------------


def test_cancel_running_transform_keeps_previous_state(client):
    t = client.post("/api/nodes", json={"kind": "transform", "name": "slow", "sql": "SELECT 1 AS x"}).json()
    run(client, t["id"])
    client.patch(f"/api/nodes/{t['id']}", json={"sql": "SELECT sum(hash(i)) AS s FROM range(20000000000) r(i)"})
    client.post(f"/api/nodes/{t['id']}/run")
    time.sleep(0.3)
    assert client.post(f"/api/nodes/{t['id']}/cancel").json() == {"cancelled": True}
    nodes = wait_idle(client, timeout=10)
    assert nodes["slow"]["status"] == "stale"  # not an error; the previous result is still there
    assert nodes["slow"]["error"] is None
    assert nodes["slow"]["result"]["row_count"] == 1
    assert client.post(f"/api/nodes/{t['id']}/cancel").json() == {"cancelled": False}


def test_cancel_source_stops_the_chain(client, monkeypatch):
    from ldi.engine import source_bq

    started = threading.Event()

    def slow_bq(sql, settings, out, token=None):
        started.set()
        while True:  # stands in for _wait() polling a BigQuery job
            token.check()
            time.sleep(0.01)

    monkeypatch.setattr(source_bq, "run_to_parquet", slow_bq)
    s = client.post("/api/nodes", json={"kind": "source", "name": "s", "sql": "x"}).json()
    client.post(f"/api/nodes/{s['id']}/run")
    assert started.wait(5)
    client.post(f"/api/nodes/{s['id']}/cancel")
    nodes = wait_idle(client)
    assert nodes["s"]["status"] == "never_run"


# ---- file sources -----------------------------------------------------------------


def test_csv_file_source_runs_and_feeds_transforms(client):
    res = upload(client, "Sales 2024.csv", CSV, x=10, y=20)
    assert res.status_code == 201, res.text
    node = res.json()
    assert node["name"] == "Sales_2024"
    assert node["source_type"] == "file"
    assert node["config"]["format"] == "csv"
    nodes = run(client, node["id"])
    assert nodes["Sales_2024"]["status"] == "fresh", nodes["Sales_2024"]["error"]
    assert nodes["Sales_2024"]["result"]["row_count"] == 3

    t = client.post(
        "/api/nodes",
        json={"kind": "transform", "sql": "SELECT sum(amount) AS s FROM Sales_2024", "inputs": [node["id"]]},
    ).json()
    run(client, t["id"])
    assert client.get(f"/api/nodes/{t['id']}/results").json()["rows"] == [[35.75]]

    # Replacing the file makes the source stale and changes its data on the next run.
    res = client.put(f"/api/nodes/{node['id']}/file?filename=new.csv", content=b"id,amount\n1,1\n")
    assert res.status_code == 200
    assert wait_idle(client)["Sales_2024"]["status"] == "stale"
    assert run(client, node["id"])["Sales_2024"]["result"]["row_count"] == 1


def test_parquet_and_excel_files(client, tmp_path):
    path = tmp_path / "t.parquet"
    pq.write_table(pa.table({"a": [1, 2]}), path)
    p = upload(client, "t.parquet", path.read_bytes()).json()
    assert run(client, p["id"])["t"]["result"]["row_count"] == 2

    xlsx = client.get(f"/api/nodes/{p['id']}/export", params={"format": "xlsx"})
    assert xlsx.status_code == 200
    x = upload(client, "book.xlsx", xlsx.content).json()
    assert x["config"]["sheets"] == ["Sheet1"]
    nodes = run(client, x["id"])
    assert nodes["book"]["status"] == "fresh", nodes["book"]["error"]
    assert nodes["book"]["result"]["row_count"] == 2


def test_unsupported_file_is_rejected(client):
    assert upload(client, "notes.docx", b"x").status_code == 400
    assert client.get("/api/workspace").json()["nodes"] == []


def test_deleting_a_file_source_removes_the_file(client, tmp_path):
    node = upload(client, "a.csv", CSV).json()
    folder = tmp_path / "files" / node["config"]["file"].split("/")[0]
    assert folder.exists()
    client.delete(f"/api/nodes/{node['id']}")
    assert not folder.exists()


# ---- export / push ------------------------------------------------------------------


def test_exports(client):
    node = upload(client, "a.csv", CSV).json()
    run(client, node["id"])
    csv = client.get(f"/api/nodes/{node['id']}/export", params={"format": "csv"})
    assert csv.status_code == 200
    assert csv.headers["content-disposition"] == 'attachment; filename="a.csv"'
    assert csv.text.splitlines()[0] == "id,country,amount"
    tsv = client.get(f"/api/nodes/{node['id']}/export", params={"format": "tsv", "limit": 1})
    assert tsv.text.splitlines() == ["id\tcountry\tamount", "1\tTN\t10.5"]
    parquet = client.get(f"/api/nodes/{node['id']}/export", params={"format": "parquet"})
    assert parquet.content[:4] == b"PAR1"


def test_push_loads_the_cached_parquet(client, monkeypatch):
    from ldi.engine import source_bq

    calls = {}

    class FakeJob:
        output_rows = 3

        def result(self):
            return self

    class FakeClient:
        project = "p"

        def load_table_from_file(self, f, target, job_config):
            calls.update(target=target, magic=f.read(4), cfg=job_config)
            return FakeJob()

    monkeypatch.setattr(source_bq, "client", lambda settings: FakeClient())
    node = upload(client, "a.csv", CSV).json()
    run(client, node["id"])
    res = client.post(f"/api/nodes/{node['id']}/push", json={"table": "p.d.t", "mode": "overwrite"})
    assert res.json() == {"table": "p.d.t", "rows": 3}
    assert calls["magic"] == b"PAR1"
    assert calls["cfg"].write_disposition == "WRITE_TRUNCATE"
    bad = client.post(f"/api/nodes/{node['id']}/push", json={"table": "d.t"})
    assert bad.status_code == 400
    assert "project.dataset.table" in bad.json()["detail"]


# ---- table sources -------------------------------------------------------------------


def test_table_source_config_and_staleness(client, monkeypatch):
    from ldi.engine import source_bq

    seen = {}

    def fake_read(cfg, settings, out, token=None):
        seen.update(cfg)
        pq.write_table(pa.table({"name": ["a"]}), out)
        return {"bytes_processed": 99, "bytes_billed": None}

    monkeypatch.setattr(source_bq, "read_table_to_parquet", fake_read)
    node = client.post(
        "/api/nodes",
        json={
            "kind": "source",
            "source_type": "bq_table",
            "name_hint": "usa_1910_current",
            "config": {"table": "`p.d.t`", "columns": ["name"], "row_filter": "  ", "junk": 1},
        },
    ).json()
    assert node["name"] == "usa_1910_current"
    assert node["config"] == {"table": "p.d.t", "columns": ["name"]}
    nodes = run(client, node["id"])
    assert nodes["usa_1910_current"]["status"] == "fresh"
    assert nodes["usa_1910_current"]["result"]["bytes_processed"] == 99
    assert seen == {"table": "p.d.t", "columns": ["name"]}

    client.patch(f"/api/nodes/{node['id']}", json={"config": {"table": "p.d.t", "row_filter": "x > 1"}})
    assert wait_idle(client)["usa_1910_current"]["status"] == "stale"


def test_bq_projects_and_pinned_settings(client, monkeypatch):
    from ldi.engine import source_bq

    class FakeClient:
        project = "billing-p"

    monkeypatch.setattr(source_bq, "client", lambda settings: FakeClient())
    s = client.get("/api/settings").json()
    s["bq_pinned_projects"] = [" bigquery-public-data ", "billing-p", "bigquery-public-data", ""]
    assert client.put("/api/settings", json=s).json()["bq_pinned_projects"] == ["bigquery-public-data", "billing-p"]
    assert client.get("/api/bq/projects").json() == {
        "billing": "billing-p",
        "projects": ["billing-p", "bigquery-public-data"],
    }


# ---- migration ---------------------------------------------------------------------


def test_old_workspace_is_migrated(tmp_path, monkeypatch):
    monkeypatch.setenv("LDI_HOME", str(tmp_path))
    from ldi import db, repo

    con = sqlite3.connect(tmp_path / "workspace.sqlite")
    con.executescript(
        "CREATE TABLE nodes (id TEXT PRIMARY KEY, kind TEXT NOT NULL, name TEXT NOT NULL UNIQUE COLLATE NOCASE,"
        " sql TEXT NOT NULL DEFAULT '', pos_x REAL NOT NULL DEFAULT 0, pos_y REAL NOT NULL DEFAULT 0,"
        " created_at TEXT NOT NULL, updated_at TEXT NOT NULL);"
        "INSERT INTO nodes VALUES ('a', 'source', 'orders', 'select 1', 0, 0, 't', 't');"
        "INSERT INTO nodes VALUES ('b', 'transform', 'agg', 'select 2', 0, 0, 't', 't');"
    )
    con.commit()
    con.close()
    db.init()
    db.init()  # idempotent
    by_name = {n["name"]: n for n in repo.list_nodes()}
    assert by_name["orders"]["source_type"] == "bq_query"
    assert by_name["orders"]["config"] == {}
    assert by_name["agg"]["source_type"] is None
