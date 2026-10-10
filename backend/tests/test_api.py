from conftest import wait_idle


def test_source_transform_loop(client):
    src = client.post("/api/nodes", json={"kind": "source", "name": "orders", "sql": "SELECT * FROM t"}).json()
    assert client.post(f"/api/nodes/{src['id']}/run").status_code == 202
    nodes = wait_idle(client)
    assert nodes["orders"]["status"] == "fresh"
    assert nodes["orders"]["result"]["row_count"] == 4
    assert nodes["orders"]["result"]["bytes_billed"] == 10485760

    sql = "SELECT country, sum(amount) AS total FROM orders GROUP BY country ORDER BY total DESC"
    tr = client.post("/api/nodes", json={"kind": "transform", "name": "by_country", "sql": sql, "inputs": [src["id"]]})
    assert tr.status_code == 201
    tr = tr.json()
    client.post(f"/api/nodes/{tr['id']}/run")
    nodes = wait_idle(client)
    assert nodes["by_country"]["status"] == "fresh", nodes["by_country"]["error"]
    assert nodes["by_country"]["inputs"] == ["orders"]
    assert [c["name"] for c in nodes["by_country"]["result"]["columns"]] == ["country", "total"]

    page = client.get(f"/api/nodes/{tr['id']}/results", params={"sort": "total", "desc": True}).json()
    assert page["total"] == 3
    assert page["rows"][0] == ["FR", 20.0]

    # Refreshing the source makes the transform stale; run-downstream fixes it without re-running the source.
    client.post(f"/api/nodes/{src['id']}/run")
    nodes = wait_idle(client)
    assert nodes["by_country"]["status"] == "stale"
    queued = client.post(f"/api/nodes/{src['id']}/run-downstream").json()["queued"]
    assert queued == [tr["id"]]
    nodes = wait_idle(client)
    assert nodes["by_country"]["status"] == "fresh"

    # Editing SQL marks it stale.
    client.patch(f"/api/nodes/{tr['id']}", json={"sql": sql + " LIMIT 1"})
    assert wait_idle(client)["by_country"]["status"] == "stale"


def test_transform_errors_and_multi_input(client):
    a = client.post("/api/nodes", json={"kind": "source", "name": "a", "sql": "x"}).json()
    b = client.post("/api/nodes", json={"kind": "source", "name": "b", "sql": "x"}).json()
    t = client.post(
        "/api/nodes",
        json={"kind": "transform", "sql": "SELECT count(*) AS n FROM a JOIN b USING (id)", "inputs": [a["id"], b["id"]]},
    ).json()
    assert t["name"] == "transform_1"

    client.post(f"/api/nodes/{t['id']}/run")
    nodes = wait_idle(client)
    assert nodes["transform_1"]["status"] == "error"
    assert "no results yet" in nodes["transform_1"]["error"]

    client.post(f"/api/nodes/{a['id']}/run")
    wait_idle(client)
    client.post(f"/api/nodes/{b['id']}/run")
    wait_idle(client)
    client.post(f"/api/nodes/{t['id']}/run")
    nodes = wait_idle(client)
    assert nodes["transform_1"]["status"] == "fresh"
    assert client.get(f"/api/nodes/{t['id']}/results").json()["rows"] == [[4]]

    client.patch(f"/api/nodes/{t['id']}", json={"sql": "SELECT nope FROM a"})
    client.post(f"/api/nodes/{t['id']}/run")
    nodes = wait_idle(client)
    assert nodes["transform_1"]["status"] == "error"
    assert nodes["transform_1"]["result"]["row_count"] == 1  # previous result kept


def test_edge_rules(client):
    s = client.post("/api/nodes", json={"kind": "source"}).json()
    t1 = client.post("/api/nodes", json={"kind": "transform", "inputs": [s["id"]]}).json()
    t2 = client.post("/api/nodes", json={"kind": "transform", "inputs": [t1["id"]]}).json()
    assert client.post("/api/edges", json={"source": t2["id"], "target": t1["id"]}).status_code == 400  # cycle
    assert client.post("/api/edges", json={"source": t1["id"], "target": s["id"]}).status_code == 400  # into source
    assert client.post("/api/nodes", json={"kind": "source", "name": "Source_1"}).status_code == 400  # dup name
    assert client.patch(f"/api/nodes/{t1['id']}", json={"name": "bad name"}).status_code == 400
    assert client.delete(f"/api/nodes/{t1['id']}").status_code == 204
    assert client.get("/api/workspace").json()["edges"] == []
