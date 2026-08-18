"""
Tests for the 11-feature expansion (iteration 8):
- Forgot password / recovery code
- Supplier + purchase expanded
- Medical bill tax_percent=5 + adjustment
- Medicine returns patient/supplier
- Expenses CRUD
- Staff + attendance
- Records detailed
- Backup download
"""
import os
import time
import pytest
import requests
from datetime import datetime, timedelta

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


# =========================================================================
# AUTH REGRESSION + FORGOT PASSWORD
# =========================================================================
def test_login_admin123_still_works():
    # No-auth request to /api/auth/login. Retry to tolerate another parallel test
    # module (test_auth_password.py) briefly rotating the password.
    last = None
    for _ in range(8):
        r = requests.post(f"{BASE_URL}/api/auth/login", json={"password": "admin123"},
                          headers={"X-No-Auth": "1"})
        last = r
        if r.status_code == 200:
            assert r.json()["data"]["token"]
            return
        time.sleep(0.5)
    pytest.fail(f"admin123 login failed after retries: {last.status_code} {last.text}")


def test_login_wrong_password_401():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"password": "wrongxxx"},
                      headers={"X-No-Auth": "1"})
    assert r.status_code == 401


def test_delete_guard_wrong_delete_pw(s):
    # Create a throwaway patient and try delete w/ wrong X-Delete-Password
    r = s.post(f"{BASE_URL}/api/patients", json={"patient_name": "TEST_DelGuard", "age": 20})
    pid = r.json()["data"]["id"]
    # Manually set wrong delete pw header (conftest sets it correctly by default)
    r2 = s.delete(f"{BASE_URL}/api/patients/{pid}", headers={"X-Delete-Password": "WRONGxxx"})
    assert r2.status_code == 401
    # cleanup w/ correct
    r3 = s.delete(f"{BASE_URL}/api/patients/{pid}")
    assert r3.status_code == 200


def test_settings_returns_recovery_code(s):
    r = s.get(f"{BASE_URL}/api/settings")
    assert r.status_code == 200
    code = r.json()["data"].get("recovery_code")
    assert code and len(code) >= 4, f"recovery_code missing/short: {code!r}"


def test_forgot_password_wrong_code_401():
    r = requests.post(f"{BASE_URL}/api/auth/forgot-password",
                      json={"recovery_code": "BOGUSXXX"},
                      headers={"X-No-Auth": "1"})
    assert r.status_code == 401


def test_forgot_password_correct_returns_login_password(s, state):
    code = s.get(f"{BASE_URL}/api/settings").json()["data"]["recovery_code"]
    state["recovery_code"] = code
    r = requests.post(f"{BASE_URL}/api/auth/forgot-password",
                      json={"recovery_code": code},
                      headers={"X-No-Auth": "1"})
    assert r.status_code == 200, r.text
    pw = r.json()["data"]["login_password"]
    # first run may be empty if plaintext mirror wasn't backfilled; accept 'admin123' or non-empty seed
    # If plain mirror empty, subsequent change-password test will populate it. Just assert key exists.
    assert "login_password" in r.json()["data"]
    state["plain_pw"] = pw


def test_regenerate_recovery_code_invalidates_old(s, state):
    old = state["recovery_code"]
    r = s.post(f"{BASE_URL}/api/auth/regenerate-recovery-code")
    assert r.status_code == 200
    new_code = r.json()["data"]["recovery_code"]
    assert new_code and new_code != old
    # old code no longer works
    r2 = requests.post(f"{BASE_URL}/api/auth/forgot-password",
                       json={"recovery_code": old},
                       headers={"X-No-Auth": "1"})
    assert r2.status_code == 401
    state["recovery_code"] = new_code


def test_change_login_password_syncs_plain_mirror(s, state):
    # Change login password to a temp value, verify forgot-password returns it, then restore
    new_pw = "temp_pw_9987"
    r = s.post(f"{BASE_URL}/api/auth/change-password",
               json={"type": "login", "current_password": "admin123", "new_password": new_pw})
    assert r.status_code == 200, r.text
    # forgot-password now returns new_pw
    r2 = requests.post(f"{BASE_URL}/api/auth/forgot-password",
                       json={"recovery_code": state["recovery_code"]},
                       headers={"X-No-Auth": "1"})
    assert r2.status_code == 200
    assert r2.json()["data"]["login_password"] == new_pw
    # restore original
    r3 = s.post(f"{BASE_URL}/api/auth/change-password",
                json={"type": "login", "current_password": new_pw, "new_password": "admin123"})
    assert r3.status_code == 200


# =========================================================================
# SUPPLIER + PURCHASE
# =========================================================================
@pytest.fixture(scope="module")
def _med(s, state):
    r = s.post(f"{BASE_URL}/api/medicines", json={
        "medicine_name": "TEST_Med_NF", "generic_name": "G", "hsn_number": "3004",
        "batch_number": "B0", "expiry_date": "2028-01-01",
        "rate": 10, "mrp": 20, "current_stock": 100, "minimum_stock": 5, "status": "Active"})
    mid = r.json()["data"]["id"]
    state["med_id"] = mid
    yield mid
    s.delete(f"{BASE_URL}/api/medicines/{mid}")


def _stock(s, mid):
    return next(m for m in s.get(f"{BASE_URL}/api/medicines").json()["data"]
                if m["id"] == mid)["current_stock"]


def test_purchase_save_with_supplier_fields_and_adjustment(s, state, _med):
    before = _stock(s, _med)
    payload = {
        "invoice_no": "TEST_NF_INV1", "supplier_name": "TEST_ABC",
        "invoice_date": TODAY,
        "supplier_gst": "29ABCDE1234F1Z5", "supplier_fssai": "F123", "supplier_pan": "P123",
        "supplier_msme": "M123", "supplier_phone": "9990001111", "supplier_address": "Kurnool",
        "adjustment": -15,
        "items": [
            {"medicine_id": _med, "batch": "NB2", "expiry": "2028-06-30", "package": "10x10",
             "qty": 10, "hsn": "3004", "rate": 100, "mrp": 120,
             "discount_percent": 10, "sgst_percent": 6, "igst_percent": 0}
        ]
    }
    r = s.post(f"{BASE_URL}/api/purchase/save", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    state["purchase_id"] = d["purchase_id"]
    # base = 10*100*0.9 = 900; sgst=54; cgst=54; total_before_adj=1008; grand=1008-15=993
    assert abs(d["subtotal"] - 900) < 0.5, d
    assert abs(d["sgst_total"] - 54) < 0.5, d
    assert abs(d["cgst_total"] - 54) < 0.5, d
    assert abs(d["grand_total"] - 993) < 0.5, d
    # stock increased by 10
    assert _stock(s, _med) == before + 10


def test_purchase_print_returns_supplier_fields(s, state):
    r = s.get(f"{BASE_URL}/api/purchase/print/{state['purchase_id']}")
    assert r.status_code == 200
    d = r.json()["data"]
    assert d["supplier_gst"] == "29ABCDE1234F1Z5"
    assert d["supplier_phone"] == "9990001111"
    assert d["supplier_address"] == "Kurnool"
    assert abs(d["adjustment"] - (-15)) < 0.5
    assert abs(d["subtotal"] - 900) < 0.5
    assert abs(d["sgst_total"] - 54) < 0.5
    assert abs(d["cgst_total"] - 54) < 0.5
    it = d["items"][0]
    assert it["package"] == "10x10"
    assert it["discount_percent"] == 10


def test_purchase_history_lists_row(s, state):
    r = s.get(f"{BASE_URL}/api/purchase/history?today=true")
    assert r.status_code == 200
    ids = [row["purchase_id"] for row in r.json()["data"]]
    assert state["purchase_id"] in ids


# =========================================================================
# MEDICAL BILL: tax_percent=5 + adjustment
# =========================================================================
@pytest.fixture(scope="module")
def _patient(s, state):
    r = s.post(f"{BASE_URL}/api/patients", json={
        "patient_name": "TEST_PT_NF", "age": 25, "gender": "M",
        "mobile": "9998887777", "address": "K"})
    pid = r.json()["data"]["id"]
    state["patient_id"] = pid
    yield pid
    try:
        s.delete(f"{BASE_URL}/api/patients/{pid}")
    except Exception:
        pass


def test_medicalbill_tax5_and_adjustment(s, state, _med, _patient):
    before = _stock(s, _med)
    payload = {
        "bill_date": TODAY, "patient_id": _patient,
        "tax_percent": 5, "adjustment": -3, "discount_percent": 0,
        "items": [
            {"medicine_id": _med, "qty": 4, "mrp": 20, "rate": 20,
             "batch": "NB2", "hsn": "3004", "pack": "10s"}
        ]
    }
    r = s.post(f"{BASE_URL}/api/medicalbill/save", json=payload)
    assert r.status_code == 200, r.text
    d = r.json()["data"]
    # base = 4*20 = 80; tax = 4; amount=84; adj=-3; grand=81
    assert abs(d["grand_total"] - 81) < 0.5, d
    state["medbill_id"] = d["medical_bill_id"]
    # stock decrement
    assert _stock(s, _med) == before - 4


def test_medicalbill_print_returns_tax_and_adj(s, state):
    r = s.get(f"{BASE_URL}/api/medicalbill/print/{state['medbill_id']}")
    assert r.status_code == 200
    d = r.json()["data"]
    assert abs(d["tax_percent"] - 5) < 0.01
    assert abs(d["adjustment"] - (-3)) < 0.5
    it = d["items"][0]
    assert it["pack"] == "10s"
    assert abs(it["tax_amount"] - 4) < 0.5
    # cleanup
    s.delete(f"{BASE_URL}/api/medicalbill/{state['medbill_id']}")


# =========================================================================
# MEDICINE RETURN (patient/supplier)
# =========================================================================
def test_return_patient_increases_stock(s, state, _med, _patient):
    before = _stock(s, _med)
    r = s.post(f"{BASE_URL}/api/returns", json={
        "return_type": "patient", "patient_id": _patient,
        "medicine_id": _med, "qty": 2, "return_date": TODAY,
        "batch": "NB2", "reason": "unused"})
    assert r.status_code == 200, r.text
    assert _stock(s, _med) == before + 2

    rows = s.get(f"{BASE_URL}/api/returns").json()["data"]
    row = next((r for r in rows if r["return_type"] == "patient" and r["medicine_id"] == _med), None)
    assert row is not None
    assert row.get("patient_code")
    assert row.get("patient_name") == "TEST_PT_NF"


def test_return_supplier_decreases_stock(s, _med):
    before = _stock(s, _med)
    r = s.post(f"{BASE_URL}/api/returns", json={
        "return_type": "supplier", "medicine_id": _med, "qty": 1,
        "supplier": "ABC", "return_date": TODAY, "batch": "NB2"})
    assert r.status_code == 200, r.text
    assert _stock(s, _med) == before - 1


def test_return_supplier_over_stock_blocked(s, _med):
    r = s.post(f"{BASE_URL}/api/returns", json={
        "return_type": "supplier", "medicine_id": _med, "qty": 9999999})
    assert r.status_code == 400


# =========================================================================
# EXPENSES CRUD
# =========================================================================
def test_expenses_crud(s, state):
    r = s.post(f"{BASE_URL}/api/expenses",
               json={"expense_date": TODAY, "description": "TEST_Electricity", "amount": 2000})
    assert r.status_code == 200, r.text
    eid = r.json()["data"]["id"]

    r2 = s.get(f"{BASE_URL}/api/expenses?today=true")
    assert r2.status_code == 200
    rows = r2.json()["data"]
    assert any(x["id"] == eid and x["description"] == "TEST_Electricity" for x in rows)

    r3 = s.put(f"{BASE_URL}/api/expenses/{eid}",
               json={"expense_date": TODAY, "description": "TEST_Electricity2", "amount": 2500})
    assert r3.status_code == 200

    r4 = s.get(f"{BASE_URL}/api/expenses?today=true").json()["data"]
    row = next(x for x in r4 if x["id"] == eid)
    assert row["description"] == "TEST_Electricity2"
    assert abs(row["amount"] - 2500) < 0.5

    r5 = s.delete(f"{BASE_URL}/api/expenses/{eid}")
    assert r5.status_code == 200


# =========================================================================
# STAFF + ATTENDANCE
# =========================================================================
def test_staff_and_attendance_upsert(s, state):
    r = s.post(f"{BASE_URL}/api/staff", json={"staff_name": "TEST_Ravi", "role": "Nurse"})
    assert r.status_code == 200
    sid = r.json()["data"]["id"]
    state["staff_id"] = sid

    d = TODAY
    r1 = s.post(f"{BASE_URL}/api/staff/attendance",
                json={"attendance_date": d, "entries": [{"staff_id": sid, "status": "Present"}]})
    assert r1.status_code == 200, r1.text

    rows1 = s.get(f"{BASE_URL}/api/staff/attendance?attendance_date={d}").json()["data"]
    match = [x for x in rows1 if x["staff_id"] == sid]
    assert len(match) == 1
    assert match[0]["status"] == "Present"
    assert match[0]["staff_name"] == "TEST_Ravi"
    assert match[0]["role"] == "Nurse"

    # upsert -> Absent, must NOT duplicate
    r2 = s.post(f"{BASE_URL}/api/staff/attendance",
                json={"attendance_date": d, "entries": [{"staff_id": sid, "status": "Absent"}]})
    assert r2.status_code == 200
    rows2 = s.get(f"{BASE_URL}/api/staff/attendance?attendance_date={d}").json()["data"]
    match2 = [x for x in rows2 if x["staff_id"] == sid]
    assert len(match2) == 1, f"duplicate created: {match2}"
    assert match2[0]["status"] == "Absent"

    # range query
    r3 = s.get(f"{BASE_URL}/api/staff/attendance?from_date={d}&to_date={d}")
    assert r3.status_code == 200

    # cleanup
    s.delete(f"{BASE_URL}/api/staff/{sid}")


# =========================================================================
# RECORDS DETAILED
# =========================================================================
def test_records_detailed_all_types_and_periods(s, _patient):
    for t in ("op", "medical", "lab", "expenses"):
        r = s.get(f"{BASE_URL}/api/records/detailed?type={t}&period=day")
        assert r.status_code == 200, f"{t}: {r.text}"
        d = r.json()["data"]
        assert "rows" in d and "total" in d and "from" in d and "to" in d
        if t in ("medical", "lab"):
            # each row should have items array (may be empty)
            for row in d["rows"]:
                assert "items" in row

    # month
    r = s.get(f"{BASE_URL}/api/records/detailed?type=op&period=month&month={TODAY[:7]}")
    assert r.status_code == 200

    # year
    r = s.get(f"{BASE_URL}/api/records/detailed?type=medical&period=year&year={TODAY[:4]}")
    assert r.status_code == 200

    # range
    r = s.get(f"{BASE_URL}/api/records/detailed?type=expenses&period=range&from_date={TODAY}&to_date={TODAY}")
    assert r.status_code == 200

    # patient filter
    r = s.get(f"{BASE_URL}/api/records/detailed?type=op&period=day&patient_id={_patient}")
    assert r.status_code == 200


# =========================================================================
# BACKUP DOWNLOAD
# =========================================================================
def test_backup_download(s):
    r = s.get(f"{BASE_URL}/api/backup/download")
    assert r.status_code == 200
    cd = r.headers.get("Content-Disposition", "")
    assert "attachment" in cd.lower() and "clinic-backup-" in cd
    # SQLite header magic
    assert r.content[:15] == b"SQLite format 3", r.content[:20]
