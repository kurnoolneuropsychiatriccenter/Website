"""
Tests for Msg 319 batch of features:
  - /api/dev/clear-demo-data
  - /api/medicines/code/:code (product_code lookup)
  - /api/patients/:id/pending + /api/patients/:id/pending-adjust
  - /api/returns (supplier decrement, patient increment)
  - /api/auth/developer-reset-password (wrong pw = 401)
  - settings developer_email + recovery_email backfill
  - POST /api/medicines with product_code
"""
import os
import time
import requests
import pytest

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")


# ---------- helpers ----------
def _uniq(): return str(int(time.time() * 1000))


@pytest.fixture(scope="module")
def sess():
    s = requests.Session()
    return s


# ---------- 1. clear-demo-data ----------
def test_clear_demo_data_returns_success(sess):
    r = sess.post(f"{BASE_URL}/api/dev/clear-demo-data", json={})
    assert r.status_code == 200
    j = r.json()
    assert j.get("success") is True
    assert "Demo data cleared" in j.get("message", "")


# ---------- 2. settings backfill ----------
def test_settings_developer_and_recovery_email(sess):
    r = sess.get(f"{BASE_URL}/api/settings")
    assert r.status_code == 200
    data = r.json().get("data", {})
    assert data.get("developer_email") == "arif052705@gmail.com"
    assert data.get("recovery_email") == "shaikabuzarrahiman@gmail.com"


# ---------- 3. medicines with product_code ----------
@pytest.fixture(scope="module")
def created_med(sess):
    u = _uniq()
    payload = {
        "medicine_name": f"TEST_Med_{u}",
        "generic_name": "TEST",
        "hsn_number": "30049099",
        "batch_number": f"BT{u}",
        "expiry_date": "2027-12-31",
        "rate": 10.5,
        "mrp": 20.0,
        "current_stock": 100,
        "minimum_stock": 10,
        "status": "Active",
        "product_code": f"PC{u}"
    }
    r = sess.post(f"{BASE_URL}/api/medicines", json=payload)
    assert r.status_code == 200, r.text
    j = r.json()
    assert j.get("success") is True
    med_id = j["data"]["id"]
    yield {"id": med_id, "product_code": payload["product_code"], "name": payload["medicine_name"]}
    # cleanup
    sess.delete(f"{BASE_URL}/api/medicines/{med_id}",
                headers={"X-Delete-Password": "delete123"})


def test_medicines_list_returns_product_code(sess, created_med):
    r = sess.get(f"{BASE_URL}/api/medicines")
    assert r.status_code == 200
    rows = r.json()["data"]
    match = [m for m in rows if m["id"] == created_med["id"]]
    assert match, "created med not in list"
    assert match[0].get("product_code") == created_med["product_code"]


def test_medicines_code_lookup_success(sess, created_med):
    r = sess.get(f"{BASE_URL}/api/medicines/code/{created_med['product_code']}")
    assert r.status_code == 200
    j = r.json()
    assert j["success"] is True
    assert j["data"]["id"] == created_med["id"]
    assert j["data"]["product_code"] == created_med["product_code"]


def test_medicines_code_lookup_by_name(sess, created_med):
    r = sess.get(f"{BASE_URL}/api/medicines/code/{created_med['name']}")
    assert r.status_code == 200
    assert r.json()["data"]["id"] == created_med["id"]


def test_medicines_code_lookup_404(sess):
    r = sess.get(f"{BASE_URL}/api/medicines/code/NOPE_{_uniq()}")
    assert r.status_code == 404
    assert r.json()["success"] is False


# ---------- 4. patient pending ----------
@pytest.fixture(scope="module")
def created_patient(sess):
    u = _uniq()
    payload = {
        "patient_name": f"TEST_Pat_{u}",
        "father_husband_name": "TEST",
        "age": 30, "gender": "Male",
        "mobile": "9000000000",
        "address": "TEST",
    }
    r = sess.post(f"{BASE_URL}/api/patients", json=payload)
    assert r.status_code == 200, r.text
    pid = r.json()["data"]["id"]
    yield pid
    sess.delete(f"{BASE_URL}/api/patients/{pid}",
                headers={"X-Delete-Password": "delete123"})


def test_patient_pending_get(sess, created_patient):
    r = sess.get(f"{BASE_URL}/api/patients/{created_patient}/pending")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["id"] == created_patient
    assert "patient_code" in d
    assert "patient_name" in d
    assert d["pending_amount"] == 0


def test_patient_pending_404(sess):
    r = sess.get(f"{BASE_URL}/api/patients/99999999/pending")
    assert r.status_code == 404


def test_patient_pending_adjust_increment(sess, created_patient):
    r = sess.post(f"{BASE_URL}/api/patients/{created_patient}/pending-adjust",
                  json={"delta": 50})
    assert r.status_code == 200
    # verify persistence
    r2 = sess.get(f"{BASE_URL}/api/patients/{created_patient}/pending")
    assert r2.json()["data"]["pending_amount"] == 50


def test_patient_pending_adjust_decrement(sess, created_patient):
    r = sess.post(f"{BASE_URL}/api/patients/{created_patient}/pending-adjust",
                  json={"delta": -30})
    assert r.status_code == 200
    r2 = sess.get(f"{BASE_URL}/api/patients/{created_patient}/pending")
    assert r2.json()["data"]["pending_amount"] == 20


# ---------- 5. returns supplier vs patient ----------
def _get_stock(sess, mid):
    r = sess.get(f"{BASE_URL}/api/medicines")
    for m in r.json()["data"]:
        if m["id"] == mid:
            return m["current_stock"]
    return None


def test_returns_supplier_decrements_stock(sess, created_med):
    before = _get_stock(sess, created_med["id"])
    r = sess.post(f"{BASE_URL}/api/returns", json={
        "medicine_id": created_med["id"], "qty": 5,
        "reason": "TEST", "supplier": "TEST_SUP"
    })
    assert r.status_code == 200, r.text
    after = _get_stock(sess, created_med["id"])
    assert after == before - 5


def test_returns_patient_increments_stock(sess, created_med, created_patient):
    before = _get_stock(sess, created_med["id"])
    r = sess.post(f"{BASE_URL}/api/returns", json={
        "medicine_id": created_med["id"], "qty": 3,
        "reason": "TEST", "return_type": "patient",
        "patient_id": created_patient
    })
    assert r.status_code == 200, r.text
    after = _get_stock(sess, created_med["id"])
    assert after == before + 3


# ---------- 6. developer reset password ----------
def test_developer_reset_wrong_password_401(sess):
    r = sess.post(f"{BASE_URL}/api/auth/developer-reset-password",
                  json={"developer_password": "definitely-wrong"})
    assert r.status_code == 401
    assert r.json()["success"] is False
