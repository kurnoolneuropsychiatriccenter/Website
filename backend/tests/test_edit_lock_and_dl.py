"""
Iteration 13 tests:
- Edit/Delete password middleware for PUT/PATCH/DELETE
- Whitelist exemptions
- Suppliers dl_number persistence + upsert preservation
- Purchase save propagating supplier_dl (documented in review request)
"""
import os
import uuid
import requests
import pytest

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
LOGIN_PASSWORD = os.environ.get("CLINIC_LOGIN_PASSWORD", "Arif07@07")
DELETE_PASSWORD = os.environ.get("CLINIC_DELETE_PASSWORD", "Arif0707")


def _fresh_token():
    r = requests.post(f"{BASE_URL}/api/auth/login", json={"password": LOGIN_PASSWORD}, timeout=10)
    assert r.status_code == 200, r.text
    return r.json()["data"]["token"]


def _bare(headers_extra=None):
    """Returns a request-friendly headers dict WITHOUT the auto conftest injection.
    We use a plain urllib3-like path: build headers manually and set X-No-Auth so conftest bypasses."""
    h = {"X-No-Auth": "1", "Authorization": f"Bearer {_fresh_token()}", "Content-Type": "application/json"}
    if headers_extra:
        h.update(headers_extra)
    return h


# ---------- Edit-lock middleware ----------

class TestEditDeleteMiddleware:
    def _make_supplier(self):
        name = f"TEST_EDLK_{uuid.uuid4().hex[:6]}"
        r = requests.post(f"{BASE_URL}/api/suppliers", json={"supplier_name": name})
        assert r.status_code == 200
        # find id via list
        lst = requests.get(f"{BASE_URL}/api/suppliers").json().get("data", [])
        row = next((x for x in lst if x["supplier_name"] == name), None)
        assert row, "supplier not found"
        return row["id"], name

    def test_put_without_password_returns_401(self):
        sid, name = self._make_supplier()
        # PUT to /api/suppliers/:id doesn't exist? Try /api/medicines PUT? Use /api/staff PUT which exists
        # Simpler: use PUT /api/staff/:id — check if exists. Fallback: use PUT /api/medicines/:id.
        # We just need any non-whitelisted PUT. Use /api/staff/nope: even 404 comes AFTER middleware.
        r = requests.put(f"{BASE_URL}/api/staff/999999", json={"name": "x"}, headers=_bare())
        assert r.status_code == 401
        assert "Edit/Delete password required" in r.text

    def test_put_wrong_password_returns_401(self):
        r = requests.put(
            f"{BASE_URL}/api/staff/999999",
            json={"name": "x"},
            headers=_bare({"X-Delete-Password": "WRONG_PW"}),
        )
        assert r.status_code == 401
        assert "Wrong edit/delete password" in r.text

    def test_delete_without_password_returns_401(self):
        r = requests.delete(f"{BASE_URL}/api/suppliers/999999", headers=_bare())
        assert r.status_code == 401
        assert "Edit/Delete password required" in r.text

    def test_delete_wrong_password_returns_401(self):
        r = requests.delete(
            f"{BASE_URL}/api/suppliers/999999",
            headers=_bare({"X-Delete-Password": "WRONG_PW"}),
        )
        assert r.status_code == 401
        assert "Wrong edit/delete password" in r.text

    def test_delete_correct_password_succeeds(self):
        sid, name = self._make_supplier()
        r = requests.delete(
            f"{BASE_URL}/api/suppliers/{sid}",
            headers=_bare({"X-Delete-Password": DELETE_PASSWORD}),
        )
        assert r.status_code == 200
        assert r.json().get("success") is True


# ---------- Whitelist ----------

class TestWhitelistBypass:
    def test_put_settings_without_edit_password_still_succeeds(self):
        # Read current settings, then PUT them back — with NO X-Delete-Password header.
        cur = requests.get(f"{BASE_URL}/api/settings").json().get("data", {})
        payload = {
            "clinic_name": cur.get("clinic_name") or "Kurnool Neuro-ENT Clinic",
            "gst_number": cur.get("gst_number") or "",
        }
        r = requests.put(f"{BASE_URL}/api/settings", json=payload, headers=_bare())
        assert r.status_code == 200, f"whitelist failed: {r.status_code} {r.text}"
        assert r.json().get("success") is True

    def test_put_settings_smtp_without_edit_password_succeeds(self):
        cur = requests.get(f"{BASE_URL}/api/settings").json().get("data", {})
        payload = {
            "smtp_host": cur.get("smtp_host") or "",
            "smtp_port": cur.get("smtp_port") or 587,
            "smtp_user": cur.get("smtp_user") or "",
            "smtp_pass": "",  # keep unchanged when empty (server-side rule)
            "smtp_from": cur.get("smtp_from") or "",
        }
        r = requests.put(f"{BASE_URL}/api/settings/smtp", json=payload, headers=_bare())
        # Endpoint may 400 on invalid payload but MUST NOT 401 with 'Edit/Delete password required'
        assert r.status_code != 401 or "Edit/Delete" not in r.text, r.text


# ---------- Suppliers dl_number ----------

class TestSupplierDLNumber:
    def test_create_and_read_dl(self):
        name = f"TEST_DL_{uuid.uuid4().hex[:6]}"
        dl = "DL-KA-01-2025-9999"
        r = requests.post(f"{BASE_URL}/api/suppliers", json={"supplier_name": name, "supplier_dl": dl})
        assert r.status_code == 200

        lst = requests.get(f"{BASE_URL}/api/suppliers").json().get("data", [])
        row = next((x for x in lst if x["supplier_name"] == name), None)
        assert row, "supplier not found in list"
        assert row.get("dl_number") == dl, f"dl_number not persisted: {row}"

        # cleanup
        requests.delete(f"{BASE_URL}/api/suppliers/{row['id']}")

    def test_upsert_preserves_dl_when_same_name(self):
        name = f"TEST_DL_UP_{uuid.uuid4().hex[:6]}"
        dl1 = "DL-ORIG-111"
        dl2 = "DL-UPDATED-222"
        requests.post(f"{BASE_URL}/api/suppliers", json={"supplier_name": name, "supplier_dl": dl1})
        # upsert with new dl
        requests.post(f"{BASE_URL}/api/suppliers", json={"supplier_name": name, "supplier_dl": dl2})

        lst = requests.get(f"{BASE_URL}/api/suppliers").json().get("data", [])
        rows = [x for x in lst if x["supplier_name"].lower() == name.lower()]
        assert len(rows) == 1, f"expected one supplier row, got {len(rows)}"
        assert rows[0]["dl_number"] == dl2

        requests.delete(f"{BASE_URL}/api/suppliers/{rows[0]['id']}")


# ---------- Purchase supplier_dl propagation ----------

class TestPurchaseSupplierDL:
    def test_purchase_save_propagates_supplier_dl(self):
        name = f"TEST_PURDL_{uuid.uuid4().hex[:6]}"
        dl = "DL-PUR-777"
        payload = {
            "invoice_no": f"INV_{uuid.uuid4().hex[:6]}",
            "supplier_name": name,
            "supplier_dl": dl,
            "invoice_date": "2026-01-15",
            "items": [{"medicine_name": "TEST_MED_DL", "hsn_code": "3004", "qty": 1,
                       "rate": 10, "sgst_percent": 0, "igst_percent": 0, "discount_percent": 0}],
            "adjustment": 0,
        }
        r = requests.post(f"{BASE_URL}/api/purchase/save", json=payload)
        assert r.status_code == 200, r.text

        lst = requests.get(f"{BASE_URL}/api/suppliers").json().get("data", [])
        row = next((x for x in lst if x["supplier_name"] == name), None)
        assert row, "purchase did not create supplier"
        # The review request specifies dl_number should propagate.
        assert row.get("dl_number") == dl, (
            f"BUG: /api/purchase/save did NOT propagate supplier_dl to suppliers table "
            f"(got dl_number={row.get('dl_number')!r})"
        )
