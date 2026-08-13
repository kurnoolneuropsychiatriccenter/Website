"""Lab Bill module tests (Dr. Rahiman Diagnostics)."""
import os
import re
import requests
import pytest
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


def test_setup(s, state):
    # existing patient
    p = s.get(f"{BASE_URL}/api/patients").json()["data"][0]
    state["patient_id"] = p["id"]
    state["patient_name"] = p["patient_name"]
    state["patient_code"] = p["patient_code"]
    d = s.get(f"{BASE_URL}/api/doctors").json()["data"][0]
    state["doctor_id"] = d["id"]
    state["doctor_name"] = d["doctor_name"]


def test_lab_bill_save_auto_numbers(s, state):
    payload = {
        "bill_date": TODAY,
        "patient_id": state["patient_id"],
        "referred_by_doctor_id": state["doctor_id"],
        "items": [
            {"test_name": "CBC", "rate": 300},
            {"test_name": "LFT", "rate": 450},
        ],
    }
    r = s.post(f"{BASE_URL}/api/labbill/save", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    state["lab_bill_id"] = d["lab_bill_id"]
    state["bill_no"] = d["bill_no"]
    state["invoice_no"] = d["invoice_no"]

    assert re.match(r"^LAB-\d{8}-\d{4}$", d["bill_no"]), d["bill_no"]
    assert d["invoice_no"].startswith("INV"), d["invoice_no"]
    num = int(d["invoice_no"].replace("INV", ""))
    assert num >= 2001
    assert abs(d["grand_total"] - 750.0) < 0.01


def test_lab_bill_save_with_discount(s, state):
    payload = {
        "bill_date": TODAY,
        "patient_id": state["patient_id"],
        "referred_by_doctor_id": state["doctor_id"],
        "invoice_no": "INV-LAB-TEST-1",
        "discount_percent": 10,
        "items": [{"test_name": "X-Ray", "rate": 500}],
    }
    r = s.post(f"{BASE_URL}/api/labbill/save", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    # 500 - 50 = 450
    assert abs(d["grand_total"] - 450.0) < 0.01
    assert d["invoice_no"] == "INV-LAB-TEST-1"
    state["lab_bill_id2"] = d["lab_bill_id"]


def test_lab_bill_print_snapshot(s, state):
    r = s.get(f"{BASE_URL}/api/labbill/print/{state['lab_bill_id']}")
    assert r.status_code == 200
    d = r.json()["data"]
    # snapshot fields
    assert d["patient_name_snapshot"] == state["patient_name"]
    assert "patient_phone_snapshot" in d
    assert d["referred_by_name"] == state["doctor_name"]
    assert len(d["items"]) == 2
    names = {i["test_name"] for i in d["items"]}
    assert {"CBC", "LFT"} == names
    assert abs(d["grand_total"] - 750.0) < 0.01
    assert d["invoice_no"] == state["invoice_no"]
    assert d["bill_no"] == state["bill_no"]


def test_lab_bill_history_today(s, state):
    r = s.get(f"{BASE_URL}/api/labbill/history?today=true")
    assert r.status_code == 200
    ids = [row["id"] for row in r.json()["data"]]
    assert state["lab_bill_id"] in ids


def test_lab_bill_history_search(s, state):
    r = s.get(f"{BASE_URL}/api/labbill/history?search={state['bill_no']}")
    assert r.status_code == 200
    rows = r.json()["data"]
    assert any(row["bill_no"] == state["bill_no"] for row in rows)


def test_lab_bill_save_no_items_rejected(s, state):
    r = s.post(f"{BASE_URL}/api/labbill/save",
               json={"bill_date": TODAY, "patient_id": state["patient_id"], "items": []})
    assert r.status_code == 400


def test_lab_bill_save_no_patient_rejected(s, state):
    r = s.post(f"{BASE_URL}/api/labbill/save",
               json={"bill_date": TODAY, "items": [{"test_name": "X", "rate": 1}]})
    assert r.status_code == 400


def test_lab_bill_delete(s, state):
    r = s.delete(f"{BASE_URL}/api/labbill/{state['lab_bill_id']}")
    assert r.status_code == 200
    # verify removed
    r2 = s.get(f"{BASE_URL}/api/labbill/print/{state['lab_bill_id']}")
    assert r2.status_code == 404


def test_zz_cleanup(s, state):
    if state.get("lab_bill_id2"):
        s.delete(f"{BASE_URL}/api/labbill/{state['lab_bill_id2']}")


# ---------- Static print page content ----------
def test_labbill_print_html_contents():
    r = requests.get(f"{BASE_URL}/labbillprint.html")
    assert r.status_code == 200
    body = r.text.upper()
    for needle in [
        "DR. RAHIMAN DIAGNOSTICS",
        "SHOP NO: 14, J.C.S. COMPLEX, OPP NEW RTC BUS STAND, KURNOOL",
        "PH: 9154794360, 9441088220",
        "NOTE: PLEASE KEEP THIS BILL SAFELY TO COLLECT REPORTS.",
    ]:
        assert needle in body, f"Missing: {needle}"
    # A5 size in @page rule
    assert "A5" in r.text.upper()
    assert "@PAGE" in r.text.upper() or "@page" in r.text
