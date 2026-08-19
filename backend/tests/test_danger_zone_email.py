"""
Tests for the new Danger-Zone 2-step email-code flow + SMTP settings endpoints.

Covers:
  - GET  /api/settings/smtp-status         (never leaks the password)
  - PUT  /api/settings/smtp                (save; empty pass keeps existing)
  - POST /api/dev/request-danger-code      (missing smtp / bad action)
  - POST /api/dev/verify-danger-code       (no code, wrong code)
  - POST /api/dev/clear-demo-data          (legacy → 403)
  - POST /api/dev/reset-all-data           (legacy → 403)
"""
import os
import requests
import pytest

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")


@pytest.fixture(scope="module")
def sess():
    return requests.Session()


@pytest.fixture(scope="module", autouse=True)
def _preserve_smtp(sess):
    """Snapshot smtp-status before mutations and restore afterwards."""
    r = sess.get(f"{BASE_URL}/api/settings/smtp-status")
    saved = r.json().get("data", {}) if r.status_code == 200 else {}
    yield
    # Restore host/port/user/from_name (pass cannot be read back — leave empty
    # so PUT keeps whatever the server currently has stored).
    sess.put(f"{BASE_URL}/api/settings/smtp", json={
        "host": saved.get("host", ""),
        "port": saved.get("port", "465"),
        "user": saved.get("user", ""),
        "pass": "",  # empty pass => server keeps existing hash
        "from_name": saved.get("from_name", "Kurnool Neuro Clinic"),
    })


# ---------- SMTP status shape ----------
def test_smtp_status_shape_no_password_leak(sess):
    r = sess.get(f"{BASE_URL}/api/settings/smtp-status")
    assert r.status_code == 200
    j = r.json()
    assert j.get("success") is True
    d = j["data"]
    for key in ("configured", "host", "port", "user", "from_name"):
        assert key in d, f"missing key {key}"
    # Never leak password
    assert "pass" not in d
    assert "password" not in d
    assert isinstance(d["configured"], bool)


# ---------- PUT /api/settings/smtp ----------
def test_smtp_save_and_empty_pass_keeps_existing(sess):
    # Save fake but full creds
    r = sess.put(f"{BASE_URL}/api/settings/smtp", json={
        "host": "smtp.example.com",
        "port": "465",
        "user": "TEST_user@example.com",
        "pass": "TEST_apppw_v1",
        "from_name": "TEST Clinic"
    })
    assert r.status_code == 200 and r.json()["success"] is True

    status = sess.get(f"{BASE_URL}/api/settings/smtp-status").json()["data"]
    assert status["host"] == "smtp.example.com"
    assert status["user"] == "TEST_user@example.com"
    assert status["from_name"] == "TEST Clinic"
    assert status["configured"] is True  # host+user+pass all set

    # Now PUT again with empty pass — configured should remain True
    r2 = sess.put(f"{BASE_URL}/api/settings/smtp", json={
        "host": "smtp.example.com",
        "port": "465",
        "user": "TEST_user@example.com",
        "pass": "",  # keep existing
        "from_name": "TEST Clinic 2"
    })
    assert r2.status_code == 200
    status2 = sess.get(f"{BASE_URL}/api/settings/smtp-status").json()["data"]
    assert status2["configured"] is True, "empty pass must not blank out stored pass"
    assert status2["from_name"] == "TEST Clinic 2"


# ---------- request-danger-code: SMTP not configured ----------
def test_request_danger_code_smtp_not_configured_returns_400(sess):
    # Wipe SMTP first (write empty host + user)
    # Note: pass "" keeps existing but empty host will fail check
    sess.put(f"{BASE_URL}/api/settings/smtp", json={
        "host": "", "port": "465", "user": "", "pass": "", "from_name": "Kurnool Neuro Clinic"
    })
    st = sess.get(f"{BASE_URL}/api/settings/smtp-status").json()["data"]
    assert st["configured"] is False

    r = sess.post(f"{BASE_URL}/api/dev/request-danger-code", json={"action": "clear_demo"})
    assert r.status_code == 400
    msg = r.json().get("message", "").lower()
    assert "smtp" in msg or "email" in msg


# ---------- request-danger-code: bad action ----------
def test_request_danger_code_bad_action_returns_400(sess):
    r = sess.post(f"{BASE_URL}/api/dev/request-danger-code", json={"action": "nuke_universe"})
    assert r.status_code == 400
    assert r.json()["success"] is False
    assert "Unknown action" in r.json().get("message", "")


def test_request_danger_code_missing_action_returns_400(sess):
    r = sess.post(f"{BASE_URL}/api/dev/request-danger-code", json={})
    assert r.status_code == 400


# ---------- verify-danger-code: unknown key ----------
def test_verify_danger_code_no_pending_request(sess):
    r = sess.post(f"{BASE_URL}/api/dev/verify-danger-code", json={
        "request_key": "does_not_exist_key_xyz",
        "code": "123456",
        "action": "clear_demo"
    })
    assert r.status_code == 400
    assert "No code was requested" in r.json().get("message", "")


# ---------- verify-danger-code: wrong code path ----------
# We cannot easily generate a real code without a working SMTP, so we assert only
# the reject-path (unknown key) here. The wrong-code 401 branch is exercised by
# the frontend Playwright test in this iteration.


# ---------- legacy destructive endpoints now 403 ----------
def test_legacy_clear_demo_data_403(sess):
    r = sess.post(f"{BASE_URL}/api/dev/clear-demo-data", json={})
    assert r.status_code == 403
    assert "one-time email code" in r.json().get("message", "")


def test_legacy_reset_all_data_403(sess):
    r = sess.post(f"{BASE_URL}/api/dev/reset-all-data", json={})
    assert r.status_code == 403
    assert "one-time email code" in r.json().get("message", "")
