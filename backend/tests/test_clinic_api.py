"""
End-to-end pytest for Clinic Management System (Node.js + SQLite)
Tests hit the internal Node server at http://localhost:3000 because
external ingress at REACT_APP_BACKEND_URL routes /api to FastAPI (wrong backend).
"""
import os
import pytest
import requests
from datetime import datetime

BASE_URL = "http://localhost:3000"
TODAY = datetime.now().strftime("%Y-%m-%d")


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def state():
    return {}


# ---------------- Dashboard ----------------
def test_dashboard_summary(s):
    r = s.get(f"{BASE_URL}/api/dashboard/summary")
    assert r.status_code == 200
    data = r.json()
    assert data["success"] is True
    for k in ["todays_op_count", "todays_patients", "todays_medical_bills",
              "todays_medical_collection", "todays_purchase", "total_patients",
              "low_stock_medicines", "expiring_medicines"]:
        assert k in data["data"], f"Missing dashboard key {k}"


# ---------------- Patients ----------------
def test_patients_list(s):
    r = s.get(f"{BASE_URL}/api/patients")
    assert r.status_code == 200
    assert r.json()["success"] is True


def test_patient_create_and_get(s, state):
    payload = {"patient_name": "TEST_Patient_E2E", "age": 30,
               "gender": "Male", "mobile": "9999900001", "address": "Kurnool"}
    r = s.post(f"{BASE_URL}/api/patients", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["patient_code"].startswith("KNC001"), d["patient_code"]
    assert len(d["patient_code"]) == 12
    state["patient_id"] = d["id"]
    state["patient_code"] = d["patient_code"]

    r2 = s.get(f"{BASE_URL}/api/patients/code/{d['patient_code']}")
    assert r2.status_code == 200
    assert r2.json()["data"]["patient_name"] == "TEST_Patient_E2E"


def test_patient_update(s, state):
    pid = state["patient_id"]
    r = s.put(f"{BASE_URL}/api/patients/{pid}",
              json={"patient_name": "TEST_Patient_Updated", "age": 31,
                    "gender": "Male", "mobile": "9999900001", "address": "K"})
    assert r.status_code == 200
    r2 = s.get(f"{BASE_URL}/api/patients/code/{state['patient_code']}")
    assert r2.json()["data"]["patient_name"] == "TEST_Patient_Updated"


# ---------------- Doctors ----------------
def test_doctors_list_has_seed(s):
    r = s.get(f"{BASE_URL}/api/doctors")
    assert r.status_code == 200
    docs = r.json()["data"]
    assert len(docs) >= 2


def test_doctor_crud(s, state):
    r = s.post(f"{BASE_URL}/api/doctors", json={
        "doctor_name": "TEST_Dr_X", "qualification": "MBBS",
        "mobile": "9000000000", "consultation_fee": 300, "status": "Active"})
    assert r.status_code == 200
    did = r.json()["data"]["id"]
    state["doctor_id"] = did

    r = s.put(f"{BASE_URL}/api/doctors/{did}", json={
        "doctor_name": "TEST_Dr_X2", "qualification": "MBBS",
        "mobile": "9000000000", "consultation_fee": 350, "status": "Active"})
    assert r.status_code == 200
    docs = s.get(f"{BASE_URL}/api/doctors").json()["data"]
    assert any(d["id"] == did and d["doctor_name"] == "TEST_Dr_X2" for d in docs)


# ---------------- Medicines ----------------
def test_medicines_list(s):
    r = s.get(f"{BASE_URL}/api/medicines")
    assert r.status_code == 200
    assert len(r.json()["data"]) >= 2


def test_medicine_crud(s, state):
    r = s.post(f"{BASE_URL}/api/medicines", json={
        "medicine_name": "TEST_Med_A", "generic_name": "Gen", "hsn_number": "3004",
        "batch_number": "TB1", "expiry_date": "2027-12-31",
        "rate": 5, "mrp": 10, "current_stock": 50, "minimum_stock": 5,
        "status": "Active"})
    assert r.status_code == 200
    state["medicine_id"] = r.json()["data"]["id"]


# ---------------- Purchase flow & stock increment ----------------
def test_purchase_save_increments_stock(s, state):
    mid = state["medicine_id"]
    before = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)["current_stock"]

    payload = {"invoice_no": "TEST_INV1", "supplier_name": "TEST_Sup",
               "invoice_date": TODAY,
               "items": [{"medicine_id": mid, "batch": "NB1", "expiry": "2028-01-01",
                          "qty": 20, "hsn": "3004", "rate": 4, "mrp": 9}]}
    r = s.post(f"{BASE_URL}/api/purchase/save", json=payload)
    assert r.status_code == 200, r.text
    state["purchase_id"] = r.json()["data"]["purchase_id"]

    after_med = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)
    assert after_med["current_stock"] == before + 20
    assert after_med["batch_number"] == "NB1"
    assert after_med["mrp"] == 9


def test_purchase_history_today(s, state):
    r = s.get(f"{BASE_URL}/api/purchase/history?today=true")
    assert r.status_code == 200
    ids = [row["purchase_id"] for row in r.json()["data"]]
    assert state["purchase_id"] in ids


# ---------------- OP Booking ----------------
def test_op_save_and_history(s, state):
    payload = {"op_date": TODAY, "patient_id": state["patient_id"],
               "doctor_id": state["doctor_id"], "consultation_fee": 500,
               "payment_mode": "Cash", "remarks": "test"}
    r = s.post(f"{BASE_URL}/api/op/save", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    assert d["op_bill_id"].startswith("OP-")
    assert d["token_number"] >= 1
    state["op_id"] = d["id"]

    r2 = s.get(f"{BASE_URL}/api/op/history?today=true")
    assert r2.status_code == 200
    rows = r2.json()["data"]
    assert any(row["id"] == d["id"] for row in rows)

    r3 = s.get(f"{BASE_URL}/api/op/print/{d['id']}")
    assert r3.status_code == 200
    assert r3.json()["data"]["patient_name"] == "TEST_Patient_Updated"


# ---------------- Medical Billing & stock decrement ----------------
def test_medicalbill_save_decrements_stock(s, state):
    mid = state["medicine_id"]
    before = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)["current_stock"]

    payload = {"bill_date": TODAY, "patient_id": state["patient_id"],
               "discount_percent": 10,
               "items": [{"medicine_id": mid, "batch": "NB1", "expiry": "2028-01-01",
                          "qty": 5, "rate": 9}]}
    r = s.post(f"{BASE_URL}/api/medicalbill/save", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    # subtotal = 5*9=45, discount 10% = 4.5, grand=40.5
    assert abs(d["grand_total"] - 40.5) < 0.01
    state["medbill_id"] = d["medical_bill_id"]

    after = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)["current_stock"]
    assert after == before - 5


def test_medicalbill_oversell_blocked(s, state):
    mid = state["medicine_id"]
    r = s.post(f"{BASE_URL}/api/medicalbill/save", json={
        "bill_date": TODAY, "patient_id": state["patient_id"],
        "discount_percent": 0,
        "items": [{"medicine_id": mid, "batch": "NB1", "expiry": "2028",
                   "qty": 99999, "rate": 9}]})
    assert r.status_code == 400
    assert "Insufficient stock" in r.json().get("message", "")


def test_medicalbill_history_today(s, state):
    r = s.get(f"{BASE_URL}/api/medicalbill/history?today=true")
    assert r.status_code == 200
    rows = r.json()["data"]
    assert any(row["id"] == state["medbill_id"] and row.get("patient_code") for row in rows)


def test_medicalbill_print(s, state):
    r = s.get(f"{BASE_URL}/api/medicalbill/print/{state['medbill_id']}")
    assert r.status_code == 200
    data = r.json()["data"]
    assert len(data["items"]) >= 1
    assert data["patient_code"] == state["patient_code"]


# ---------------- Medicine Returns ----------------
def test_return_decrements_stock(s, state):
    mid = state["medicine_id"]
    before = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)["current_stock"]
    r = s.post(f"{BASE_URL}/api/returns", json={
        "return_date": TODAY, "medicine_id": mid, "batch": "NB1",
        "qty": 2, "reason": "damaged", "supplier": "TEST_Sup"})
    assert r.status_code == 200
    after = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)["current_stock"]
    assert after == before - 2


def test_return_over_stock_blocked(s, state):
    r = s.post(f"{BASE_URL}/api/returns", json={
        "medicine_id": state["medicine_id"], "qty": 999999})
    assert r.status_code == 400


# ---------------- Reports ----------------
@pytest.mark.parametrize("rtype", [
    "todays_op", "op_collection", "medical_sales", "purchase",
    "stock", "low_stock", "expiry", "patient_report",
    "doctor_report", "daily_collection"])
def test_reports(s, rtype):
    q = "?today=true" if rtype in ("todays_op", "op_collection", "medical_sales", "purchase") else ""
    r = s.get(f"{BASE_URL}/api/reports/{rtype}{q}")
    assert r.status_code == 200, f"{rtype}: {r.text}"
    assert r.json()["success"] is True


# ---------------- Deletes: stock reverse/restore ----------------
def test_delete_medicalbill_restores_stock(s, state):
    mid = state["medicine_id"]
    before = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)["current_stock"]
    r = s.delete(f"{BASE_URL}/api/medicalbill/{state['medbill_id']}")
    assert r.status_code == 200
    after = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)["current_stock"]
    assert after == before + 5


def test_delete_purchase_reverses_stock(s, state):
    mid = state["medicine_id"]
    before = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)["current_stock"]
    r = s.delete(f"{BASE_URL}/api/purchase/{state['purchase_id']}")
    assert r.status_code == 200
    after = next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"] if m["id"] == mid)["current_stock"]
    assert after == max(before - 20, 0)


def test_delete_op(s, state):
    r = s.delete(f"{BASE_URL}/api/op/{state['op_id']}")
    assert r.status_code == 200


# ---------------- Cleanup ----------------
def test_zz_cleanup(s, state):
    for path in [f"/api/patients/{state.get('patient_id')}",
                 f"/api/doctors/{state.get('doctor_id')}",
                 f"/api/medicines/{state.get('medicine_id')}"]:
        if state.get(path.split('/')[-1]):
            s.delete(f"{BASE_URL}{path}")
