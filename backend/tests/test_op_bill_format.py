"""
Tests for the Kurnool Neuro OP Bill format changes:
- POST /api/op/save now supports optional invoice_no (auto INV{1000+id} if omitted)
- Stores snapshot fields (name/phone/age)
- GET /api/op/print/:id returns snapshot + doctor + invoice_no + consultation_fee
- Idempotent ALTER TABLE (survives backend restart)
- No regression on OP history, delete, dashboard
"""
import os
import subprocess
import time
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def state():
    return {}


# ---------- Seed: create patient "arif" age 23, and doctor exists ----------
def test_create_arif_patient(s, state):
    r = s.post(f"{BASE_URL}/api/patients", json={
        "patient_name": "arif", "age": 23, "gender": "Male",
        "mobile": "9000123456", "address": "Kurnool"
    })
    assert r.status_code == 200, r.text
    data = r.json()
    assert data["success"] is True
    assert "id" in data["data"]
    state["patient_id"] = data["data"]["id"]
    state["patient_code"] = data["data"]["patient_code"]


def test_doctor_available(s, state):
    r = s.get(f"{BASE_URL}/api/doctors")
    assert r.status_code == 200
    docs = r.json()["data"]
    assert len(docs) >= 1
    # pick Dr. K. Ramesh if present else first
    dr = next((d for d in docs if "Ramesh" in (d["doctor_name"] or "")), docs[0])
    state["doctor_id"] = dr["id"]
    state["doctor_name"] = dr["doctor_name"]


# ---------- Auto invoice_no when omitted ----------
def test_op_save_auto_invoice(s, state):
    r = s.post(f"{BASE_URL}/api/op/save", json={
        "patient_id": state["patient_id"],
        "doctor_id": state["doctor_id"],
        "consultation_fee": 300,
        "payment_mode": "Cash"
    })
    assert r.status_code == 200, r.text
    d = r.json()
    assert d["success"] is True
    inv = d["data"]["invoice_no"]
    assert inv and inv.startswith("INV"), f"Expected auto INV*, got {inv}"
    # Should be INV{>=1001}
    num = int(inv.replace("INV", ""))
    assert num >= 1001
    state["op_auto_id"] = d["data"]["id"]
    state["op_auto_invoice"] = inv


# ---------- Supplied invoice_no preserved ----------
def test_op_save_supplied_invoice(s, state):
    r = s.post(f"{BASE_URL}/api/op/save", json={
        "patient_id": state["patient_id"],
        "doctor_id": state["doctor_id"],
        "consultation_fee": 300,
        "payment_mode": "Cash",
        "invoice_no": "INV1001"
    })
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["invoice_no"] == "INV1001"
    state["op_manual_id"] = d["id"]


# ---------- Print endpoint returns snapshot + all required fields ----------
def test_op_print_manual(s, state):
    r = s.get(f"{BASE_URL}/api/op/print/{state['op_manual_id']}")
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    # Snapshot fields
    assert d.get("patient_name_snapshot") == "arif"
    assert d.get("patient_age_snapshot") == 23
    assert d.get("patient_phone_snapshot") == "9000123456"
    # Invoice + fee + doctor
    assert d.get("invoice_no") == "INV1001"
    assert float(d.get("consultation_fee")) == 300.0
    assert "doctor_name" in d and d["doctor_name"]
    assert "patient_code" in d and d["patient_code"]
    assert "op_date" in d and d["op_date"]
    # Joined patient_name still present
    assert d.get("patient_name") == "arif"


def test_op_print_auto(s, state):
    r = s.get(f"{BASE_URL}/api/op/print/{state['op_auto_id']}")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["invoice_no"] == state["op_auto_invoice"]
    assert d["patient_name_snapshot"] == "arif"


# ---------- Snapshot survives patient edit ----------
def test_snapshot_survives_patient_edit(s, state):
    # rename patient; snapshot should stay "arif"
    r = s.put(f"{BASE_URL}/api/patients/{state['patient_id']}", json={
        "patient_name": "arif_renamed", "age": 24, "gender": "Male",
        "mobile": "9000123457", "address": "Kurnool"
    })
    assert r.status_code == 200
    r = s.get(f"{BASE_URL}/api/op/print/{state['op_manual_id']}")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["patient_name_snapshot"] == "arif"
    assert d["patient_age_snapshot"] == 23
    assert d["patient_phone_snapshot"] == "9000123456"


# ---------- Regression: history, dashboard, delete ----------
def test_op_history_regression(s, state):
    r = s.get(f"{BASE_URL}/api/op/history")
    assert r.status_code == 200
    rows = r.json()["data"]
    ids = [row["id"] for row in rows]
    assert state["op_manual_id"] in ids
    assert state["op_auto_id"] in ids


def test_dashboard_regression(s):
    r = s.get(f"{BASE_URL}/api/dashboard/summary")
    assert r.status_code == 200
    assert r.json()["success"] is True


def test_op_delete_regression(s, state):
    r = s.delete(f"{BASE_URL}/api/op/{state['op_auto_id']}")
    assert r.status_code == 200
    assert r.json()["success"] is True


# ---------- Idempotent ALTER TABLE - restart server ----------
def test_idempotent_alter_after_restart(s, state):
    # Restart the node server (child of frontend supervisor). Kill node /app/server.js
    try:
        subprocess.run(["pkill", "-f", "node /app/server.js"], check=False)
    except Exception:
        pass
    # Wait for the parent (yarn start via nodemon/concurrently or plain) to respawn.
    # The frontend supervisor command is `yarn start` (which runs `node server.js`).
    # After pkill, yarn/npm should exit; supervisor will autorestart frontend.
    # Poll until API responds.
    deadline = time.time() + 45
    ok = False
    last_err = None
    while time.time() < deadline:
        try:
            r = requests.get(f"{BASE_URL}/api/doctors", timeout=3)
            if r.status_code == 200:
                ok = True
                break
        except Exception as e:
            last_err = e
        time.sleep(2)
    assert ok, f"Server did not come back up after restart: {last_err}"

    # Now GET the saved OP bill; should still return snapshot columns (schema intact)
    r = requests.get(f"{BASE_URL}/api/op/print/{state['op_manual_id']}", timeout=5)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["invoice_no"] == "INV1001"
    assert d["patient_name_snapshot"] == "arif"


# ---------- Cleanup ----------
def test_cleanup(s, state):
    s.delete(f"{BASE_URL}/api/op/{state['op_manual_id']}")
    s.delete(f"{BASE_URL}/api/patients/{state['patient_id']}")
