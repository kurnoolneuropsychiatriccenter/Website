"""
Iteration 11 tests:
  - /api/suppliers GET / POST (upsert by name case-insensitive) / search
  - /api/purchase/save auto-upserts supplier
  - /api/pending-medicines GET (?status=pending|cleared|all), POST snapshot,
    DELETE (clear) needs X-Delete-Password, DELETE /:id/purge needs it too
  - /api/backup/all-pdf returns application/pdf when authed, 401 when not
"""
import os
import time
import requests
import pytest

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")


# ------------------------- Suppliers -------------------------
class TestSuppliers:
    def test_list_returns_data_list(self):
        r = requests.get(f"{BASE_URL}/api/suppliers")
        assert r.status_code == 200
        body = r.json()
        assert body["success"] is True
        assert isinstance(body["data"], list)

    def test_upsert_by_name_case_insensitive(self):
        name = f"TEST_Supplier_{int(time.time())}"
        # first insert
        r1 = requests.post(f"{BASE_URL}/api/suppliers", json={
            "supplier_name": name,
            "supplier_gst": "GST111",
            "supplier_phone": "9999999999",
            "supplier_address": "Addr1",
        })
        assert r1.status_code == 200 and r1.json()["success"]
        id1 = r1.json()["data"]["id"]

        # re-post with different case + updated fields -> must reuse same id (upsert)
        r2 = requests.post(f"{BASE_URL}/api/suppliers", json={
            "supplier_name": name.lower(),
            "supplier_gst": "GST222",
            "supplier_phone": "8888888888",
            "supplier_address": "Addr2",
        })
        assert r2.status_code == 200
        id2 = r2.json()["data"]["id"]
        assert id1 == id2, f"upsert failed: id1={id1} id2={id2}"

        # search finds it
        r3 = requests.get(f"{BASE_URL}/api/suppliers", params={"search": name[:10]})
        assert r3.status_code == 200
        names = [x["supplier_name"] for x in r3.json()["data"]]
        assert any(n.lower() == name.lower() for n in names)

        # cleanup
        requests.delete(f"{BASE_URL}/api/suppliers/{id1}")

    def test_list_sorted_by_name_nocase(self):
        # add a few, then verify sort
        stamp = int(time.time())
        added = []
        for nm in ["TEST_zz_s1", "TEST_aa_s2", "TEST_Mm_s3"]:
            r = requests.post(f"{BASE_URL}/api/suppliers",
                              json={"supplier_name": f"{nm}_{stamp}"})
            added.append(r.json()["data"]["id"])
        r = requests.get(f"{BASE_URL}/api/suppliers")
        names = [x["supplier_name"].lower() for x in r.json()["data"]]
        assert names == sorted(names)
        for i in added:
            requests.delete(f"{BASE_URL}/api/suppliers/{i}")

    def test_purchase_save_upserts_supplier(self):
        name = f"TEST_PurSup_{int(time.time())}"
        # save a minimal purchase referencing a medicine
        meds = requests.get(f"{BASE_URL}/api/medicines").json()["data"]
        if not meds:
            pytest.skip("no medicines to reference")
        med_id = meds[0]["id"]
        payload = {
            "invoice_no": f"TESTINV{int(time.time())}",
            "supplier_name": name,
            "supplier_gst": "GSTX",
            "supplier_phone": "7777777777",
            "supplier_address": "PurchAddr",
            "items": [{
                "medicine_id": med_id, "qty": 1, "rate": 10,
                "discount_percent": 0, "sgst_percent": 0, "igst_percent": 0,
                "batch_number": "B1", "expiry_date": "2030-12-31", "mrp": 15,
            }],
        }
        r = requests.post(f"{BASE_URL}/api/purchase/save", json=payload)
        assert r.status_code == 200 and r.json()["success"], r.text
        # give the fire-and-forget upsert a moment
        time.sleep(0.5)
        r2 = requests.get(f"{BASE_URL}/api/suppliers", params={"search": name})
        names = [x["supplier_name"] for x in r2.json()["data"]]
        assert name in names, f"supplier '{name}' was not auto-saved; got {names}"


# ------------------------- Pending Medicines -------------------------
class TestPendingMedicines:
    def test_list_default_pending(self):
        r = requests.get(f"{BASE_URL}/api/pending-medicines")
        assert r.status_code == 200
        b = r.json()
        assert b["success"] is True
        assert isinstance(b["data"], list)
        assert all(row["status"] == "pending" for row in b["data"])

    def test_status_all_and_cleared_filters(self):
        for st in ["all", "cleared", "pending"]:
            r = requests.get(f"{BASE_URL}/api/pending-medicines", params={"status": st})
            assert r.status_code == 200
            b = r.json()
            assert b["success"] is True
            if st in ("cleared", "pending"):
                assert all(row["status"] == st for row in b["data"])

    def test_post_snapshots_patient_name_and_phone(self):
        # find or create a patient
        pts = requests.get(f"{BASE_URL}/api/patients").json()["data"]
        if not pts:
            r = requests.post(f"{BASE_URL}/api/patients", json={
                "patient_name": "TEST_PPending", "age": 30, "gender": "Male",
                "mobile": "9123456780", "address": "A",
            })
            pid = r.json()["data"]["id"]
            pts = requests.get(f"{BASE_URL}/api/patients").json()["data"]
        p = pts[0]
        r = requests.post(f"{BASE_URL}/api/pending-medicines", json={
            "patient_id": p["id"],
            "medicine_name": "TEST_Med_Snap",
            "qty": 2,
            "notes": "out of stock",
        })
        assert r.status_code == 200
        pid_row = r.json()["data"]["id"]
        rows = requests.get(f"{BASE_URL}/api/pending-medicines",
                            params={"status": "all"}).json()["data"]
        row = next((x for x in rows if x["id"] == pid_row), None)
        assert row is not None
        assert row["medicine_name"] == "TEST_Med_Snap"
        assert row["qty"] == 2
        assert row["patient_name_snapshot"] == p["patient_name"]
        assert (row.get("patient_phone_snapshot") or "") == (p.get("mobile") or "")

        # cleanup: purge
        requests.delete(f"{BASE_URL}/api/pending-medicines/{pid_row}/purge")

    def test_missing_medicine_or_qty_returns_400(self):
        r = requests.post(f"{BASE_URL}/api/pending-medicines", json={"qty": 1})
        assert r.status_code == 400

    def test_clear_requires_delete_password(self):
        # create
        r = requests.post(f"{BASE_URL}/api/pending-medicines",
                          json={"medicine_name": "TEST_ClrReq", "qty": 1})
        pid = r.json()["data"]["id"]

        # Use a raw urllib3 pool to bypass the conftest autouse header injection
        import urllib3, json as _json
        pool = urllib3.PoolManager()
        token = requests.post(f"{BASE_URL}/api/auth/login",
                              json={"password": "admin123"}).json()["data"]["token"]

        # DELETE without pw -> 401
        r_no_pw = pool.request("DELETE", f"{BASE_URL}/api/pending-medicines/{pid}",
                               headers={"Authorization": f"Bearer {token}"})
        assert r_no_pw.status == 401, r_no_pw.data[:200]

        # wrong pw -> 401
        r_bad = pool.request("DELETE", f"{BASE_URL}/api/pending-medicines/{pid}",
                             headers={"Authorization": f"Bearer {token}",
                                      "X-Delete-Password": "wrong"})
        assert r_bad.status == 401

        h = {"Authorization": f"Bearer {token}"}

        # correct pw -> 200, status flips to cleared
        r_ok = requests.delete(f"{BASE_URL}/api/pending-medicines/{pid}",
                               headers={**h, "X-Delete-Password": "delete123"})
        assert r_ok.status_code == 200
        rows = requests.get(f"{BASE_URL}/api/pending-medicines",
                            params={"status": "cleared"}).json()["data"]
        row = next((x for x in rows if x["id"] == pid), None)
        assert row is not None
        assert row["status"] == "cleared"
        assert row["cleared_at"]

        # purge cleanup
        requests.delete(f"{BASE_URL}/api/pending-medicines/{pid}/purge")

    def test_purge_requires_delete_password(self):
        r = requests.post(f"{BASE_URL}/api/pending-medicines",
                          json={"medicine_name": "TEST_Purge", "qty": 1})
        pid = r.json()["data"]["id"]
        import urllib3
        pool = urllib3.PoolManager()
        token = requests.post(f"{BASE_URL}/api/auth/login",
                              json={"password": "admin123"}).json()["data"]["token"]
        r_no = pool.request("DELETE",
                            f"{BASE_URL}/api/pending-medicines/{pid}/purge",
                            headers={"Authorization": f"Bearer {token}"})
        assert r_no.status == 401
        r_ok = requests.delete(f"{BASE_URL}/api/pending-medicines/{pid}/purge",
                               headers={"Authorization": f"Bearer {token}",
                                        "X-Delete-Password": "delete123"})
        assert r_ok.status_code == 200


# ------------------------- Full PDF export -------------------------
class TestBackupAllPdf:
    def test_unauth_returns_401(self):
        import urllib3
        pool = urllib3.PoolManager()
        r = pool.request("GET", f"{BASE_URL}/api/backup/all-pdf")
        assert r.status == 401

    def test_authed_returns_pdf(self):
        r = requests.get(f"{BASE_URL}/api/backup/all-pdf", timeout=60)
        assert r.status_code == 200, r.text[:400]
        ct = r.headers.get("Content-Type", "")
        assert "application/pdf" in ct, f"unexpected content-type: {ct}"
        assert r.content[:5] == b"%PDF-", f"bad PDF header: {r.content[:20]!r}"
        assert len(r.content) > 500
