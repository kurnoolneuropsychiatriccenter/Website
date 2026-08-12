"""
Tests for the Asha Medicals medical-bill print format changes.
Covers:
- POST /api/medicalbill/save accepts new fields and computes amounts (rate + SGST + CGST)
- GET  /api/medicalbill/print/:id returns new fields (invoice_no, town, referred_by_name, snapshots, per-item hsn/mrp/sgst_amount/cgst_amount)
- Reference math from spec: items -> amounts 47.25 & 115.50, subtotal 162.75 (0 discount)
- Oversell qty blocked with 400 + 'Insufficient stock'
- Idempotent ALTER TABLE (schema still healthy: /api/medicines works)
- DELETE restores stock
"""
import os
import pytest
import requests
from datetime import datetime

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
TODAY = datetime.now().strftime("%Y-%m-%d")


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


@pytest.fixture(scope="module")
def state():
    return {}


def _get_stock(s, mid):
    meds = s.get(f"{BASE_URL}/api/medicines").json()["data"]
    return next(m for m in meds if m["id"] == mid)["current_stock"]


# --- Setup: patient, doctor, 2 medicines ---
def test_setup_entities(s, state):
    # existing patient (do NOT assume id=1)
    pats = s.get(f"{BASE_URL}/api/patients").json()["data"]
    assert pats, "No patients seeded"
    p = next((p for p in pats if p.get("patient_code") == "KNC001000001"), pats[-1])
    state["patient_id"] = p["id"]
    state["patient_code"] = p["patient_code"]
    state["patient_name"] = p["patient_name"]

    docs = s.get(f"{BASE_URL}/api/doctors").json()["data"]
    assert len(docs) >= 1
    state["doctor_id"] = docs[0]["id"]
    state["doctor_name"] = docs[0]["doctor_name"]

    # create 2 fresh medicines with known stock
    r1 = s.post(f"{BASE_URL}/api/medicines", json={
        "medicine_name": "TEST_Asha_Med1", "generic_name": "G1",
        "hsn_number": "3004", "batch_number": "B101", "expiry_date": "2026-12-31",
        "rate": 45, "mrp": 50, "current_stock": 100, "minimum_stock": 5,
        "status": "Active"})
    assert r1.status_code == 200
    state["mid1"] = r1.json()["data"]["id"]

    r2 = s.post(f"{BASE_URL}/api/medicines", json={
        "medicine_name": "TEST_Asha_Med2", "generic_name": "G2",
        "hsn_number": "3003", "batch_number": "A210", "expiry_date": "2025-08-31",
        "rate": 110, "mrp": 120, "current_stock": 100, "minimum_stock": 5,
        "status": "Active"})
    assert r2.status_code == 200
    state["mid2"] = r2.json()["data"]["id"]


# --- Reference math check from spec ---
def test_reference_math_save(s, state):
    payload = {
        "bill_date": TODAY,
        "patient_id": state["patient_id"],
        "invoice_no": "INV-ASHA-1001",
        "town": "Kurnool",
        "referred_by_doctor_id": state["doctor_id"],
        "discount_percent": 0,
        "items": [
            {"medicine_id": state["mid1"], "batch": "B101", "expiry": "12/26",
             "hsn": "3004", "mrp": 50, "qty": 1, "rate": 45,
             "sgst_percent": 2.5, "cgst_percent": 2.5},
            {"medicine_id": state["mid2"], "batch": "A210", "expiry": "08/25",
             "hsn": "3003", "mrp": 120, "qty": 1, "rate": 110,
             "sgst_percent": 2.5, "cgst_percent": 2.5},
        ]
    }
    stock1_before = _get_stock(s, state["mid1"])
    stock2_before = _get_stock(s, state["mid2"])

    r = s.post(f"{BASE_URL}/api/medicalbill/save", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    state["medbill_id"] = d["medical_bill_id"]

    # Grand total (0 discount) equals subtotal = 47.25 + 115.50 = 162.75
    assert abs(d["grand_total"] - 162.75) < 0.02, f"grand_total={d['grand_total']}"
    assert d.get("invoice_no") == "INV-ASHA-1001"

    # Stock decremented
    assert _get_stock(s, state["mid1"]) == stock1_before - 1
    assert _get_stock(s, state["mid2"]) == stock2_before - 1


def test_reference_math_print_payload(s, state):
    r = s.get(f"{BASE_URL}/api/medicalbill/print/{state['medbill_id']}")
    assert r.status_code == 200
    data = r.json()["data"]

    # Bill-level new fields
    assert data.get("invoice_no") == "INV-ASHA-1001"
    assert data.get("town") == "Kurnool"
    assert data.get("referred_by_name") == state["doctor_name"], data
    assert data.get("patient_name_snapshot") == state["patient_name"]
    assert data.get("patient_phone_snapshot") is not None
    assert abs(data["grand_total"] - 162.75) < 0.02
    assert abs(data["subtotal"] - 162.75) < 0.02

    items = data["items"]
    assert len(items) == 2
    by_med = {i["medicine_id"]: i for i in items}
    i1 = by_med[state["mid1"]]
    i2 = by_med[state["mid2"]]

    # Per-item new fields present
    for it in (i1, i2):
        for k in ("hsn", "mrp", "sgst_percent", "cgst_percent", "sgst_amount", "cgst_amount", "amount"):
            assert k in it, f"missing {k} in item {it}"

    # Reference amounts
    assert abs(i1["amount"] - 47.25) < 0.02, i1
    assert abs(i2["amount"] - 115.50) < 0.02, i2
    assert abs(i1["sgst_amount"] - 1.125) < 0.02 or abs(i1["sgst_amount"] - 1.13) < 0.02
    assert i1["hsn"] == "3004"
    assert i2["hsn"] == "3003"
    assert i1["mrp"] == 50
    assert i2["mrp"] == 120


# --- Oversell blocked ---
def test_oversell_blocked_and_no_row_created(s, state):
    hist_before = s.get(f"{BASE_URL}/api/medicalbill/history").json()["data"]
    count_before = len(hist_before)

    r = s.post(f"{BASE_URL}/api/medicalbill/save", json={
        "bill_date": TODAY, "patient_id": state["patient_id"],
        "invoice_no": "INV-BAD",
        "referred_by_doctor_id": state["doctor_id"],
        "items": [{"medicine_id": state["mid1"], "batch": "B101", "expiry": "12/26",
                   "hsn": "3004", "mrp": 50, "qty": 999999, "rate": 45,
                   "sgst_percent": 2.5, "cgst_percent": 2.5}]
    })
    assert r.status_code == 400
    assert "Insufficient stock" in r.json().get("message", "")

    hist_after = s.get(f"{BASE_URL}/api/medicalbill/history").json()["data"]
    assert len(hist_after) == count_before, "Bill row should NOT be created on oversell"


# --- Fixed rupee discount path (new alternate to %) ---
def test_fixed_rupee_discount(s, state):
    payload = {
        "bill_date": TODAY, "patient_id": state["patient_id"],
        "invoice_no": "INV-ASHA-1002",
        "town": "Nandyal",
        "referred_by_doctor_id": state["doctor_id"],
        "discount_amount": 12.75,
        "items": [
            {"medicine_id": state["mid1"], "batch": "B101", "expiry": "12/26",
             "hsn": "3004", "mrp": 50, "qty": 1, "rate": 45,
             "sgst_percent": 2.5, "cgst_percent": 2.5},
            {"medicine_id": state["mid2"], "batch": "A210", "expiry": "08/25",
             "hsn": "3003", "mrp": 120, "qty": 1, "rate": 110,
             "sgst_percent": 2.5, "cgst_percent": 2.5},
        ]
    }
    r = s.post(f"{BASE_URL}/api/medicalbill/save", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    # subtotal 162.75 - 12.75 = 150.00
    assert abs(d["grand_total"] - 150.00) < 0.02, d
    state["medbill_id2"] = d["medical_bill_id"]

    r2 = s.get(f"{BASE_URL}/api/medicalbill/print/{d['medical_bill_id']}")
    assert r2.status_code == 200
    dd = r2.json()["data"]
    assert abs(dd["discount_amount"] - 12.75) < 0.02
    assert dd["town"] == "Nandyal"


# --- Medicines endpoint healthy after ALTER TABLE (idempotency check) ---
def test_medicines_endpoint_still_healthy(s):
    r = s.get(f"{BASE_URL}/api/medicines")
    assert r.status_code == 200
    assert r.json()["success"]


# --- DELETE restores stock ---
def test_delete_medicalbill_restores_stock(s, state):
    mid1 = state["mid1"]
    mid2 = state["mid2"]
    b1 = _get_stock(s, mid1)
    b2 = _get_stock(s, mid2)
    r = s.delete(f"{BASE_URL}/api/medicalbill/{state['medbill_id']}")
    assert r.status_code == 200
    assert _get_stock(s, mid1) == b1 + 1
    assert _get_stock(s, mid2) == b2 + 1


# --- Cleanup ---
def test_zz_cleanup(s, state):
    if state.get("medbill_id2"):
        s.delete(f"{BASE_URL}/api/medicalbill/{state['medbill_id2']}")
    for mid_key in ("mid1", "mid2"):
        if state.get(mid_key):
            s.delete(f"{BASE_URL}/api/medicines/{state[mid_key]}")
