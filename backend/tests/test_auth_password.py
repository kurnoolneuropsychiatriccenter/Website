"""Auth + password change + auth-gate tests for the clinic app."""
import os
import requests
import pytest

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")


def _raw_post(path, json=None, headers=None):
    """Bypass conftest auto-headers by using an isolated Session with cleared headers."""
    r = requests.Session()
    r.headers.clear()
    r.headers.update({"Content-Type": "application/json", "X-No-Auth": "1"})
    if headers:
        r.headers.update(headers)
        r.headers.pop("X-No-Auth", None)  # if caller provided real auth, keep it
        # But still tell send() to not overwrite
        r.headers["X-No-Auth"] = "1"
    return r.post(f"{BASE_URL}{path}", json=json)


def _raw_get(path, headers=None):
    r = requests.Session()
    r.headers.clear()
    r.headers["X-No-Auth"] = "1"
    if headers:
        r.headers.update(headers)
        r.headers["X-No-Auth"] = "1"
    return r.get(f"{BASE_URL}{path}")


def _raw_delete(path, headers=None):
    r = requests.Session()
    r.headers.clear()
    r.headers["X-No-Auth"] = "1"
    if headers:
        r.headers.update(headers)
        r.headers["X-No-Auth"] = "1"
    return r.delete(f"{BASE_URL}{path}")


# ---------- Login ----------
def test_login_success():
    r = _raw_post("/api/auth/login", json={"password": "admin123"})
    assert r.status_code == 200
    d = r.json()
    assert d["success"] is True
    assert isinstance(d["data"]["token"], str) and len(d["data"]["token"]) > 10


def test_login_wrong_password():
    r = _raw_post("/api/auth/login", json={"password": "totally-wrong"})
    assert r.status_code == 401
    assert "Wrong password" in r.json().get("message", "")


def test_login_missing_password():
    r = _raw_post("/api/auth/login", json={})
    assert r.status_code == 400


# ---------- Auth gate ----------
@pytest.mark.parametrize("path", [
    "/api/patients", "/api/doctors", "/api/medicines",
    "/api/dashboard/summary", "/api/medicalbill/history",
    "/api/op/history", "/api/labbill/history",
])
def test_endpoints_require_auth(path):
    r = _raw_get(path)
    assert r.status_code == 401
    assert r.json().get("message") == "Not logged in"


def test_expired_or_tampered_token_rejected():
    r = _raw_get("/api/patients", headers={"Authorization": "Bearer not-a-real-token"})
    assert r.status_code == 401


def test_public_gst_no_auth():
    r = _raw_get("/api/public/gst")
    assert r.status_code == 200
    assert r.json()["success"] is True


# ---------- With valid token, endpoints return 200 ----------
@pytest.mark.parametrize("path", [
    "/api/patients", "/api/doctors", "/api/medicines",
    "/api/dashboard/summary", "/api/medicalbill/history",
    "/api/op/history", "/api/labbill/history",
])
def test_endpoints_ok_with_auth(auth_headers, path):
    r = _raw_get(path, headers={"Authorization": auth_headers["Authorization"]})
    assert r.status_code == 200, r.text
    assert r.json()["success"] is True


# ---------- Delete password guard ----------
def test_delete_missing_password_header(auth_headers):
    # login-authed but no X-Delete-Password header
    r = _raw_delete("/api/patients/999999",
                    headers={"Authorization": auth_headers["Authorization"]})
    assert r.status_code == 401
    assert r.json()["message"] == "Delete password required"


def test_delete_wrong_password(auth_headers):
    r = _raw_delete("/api/patients/999999",
                    headers={"Authorization": auth_headers["Authorization"],
                             "X-Delete-Password": "wrong"})
    assert r.status_code == 401
    assert r.json()["message"] == "Wrong delete password"


def test_delete_correct_password_passes_guard(auth_headers):
    # Even if id doesn't exist, guard passes => endpoint returns success:true
    r = _raw_delete("/api/patients/999999",
                    headers={"Authorization": auth_headers["Authorization"],
                             "X-Delete-Password": "delete123"})
    # The route runs; may return 200 (no-op delete succeeds in sqlite)
    assert r.status_code == 200


# ---------- Change password ----------
def test_change_password_flow(auth_headers):
    hdr = {"Authorization": auth_headers["Authorization"]}
    # rotate login: admin123 -> newlogin456
    r = _raw_post("/api/auth/change-password",
                  json={"type": "login", "current_password": "admin123",
                        "new_password": "newlogin456"},
                  headers=hdr)
    assert r.status_code == 200, r.text

    # Old admin123 must fail
    assert _raw_post("/api/auth/login", json={"password": "admin123"}).status_code == 401
    # New works
    r2 = _raw_post("/api/auth/login", json={"password": "newlogin456"})
    assert r2.status_code == 200

    # revert to admin123
    new_token = r2.json()["data"]["token"]
    r3 = _raw_post("/api/auth/change-password",
                   json={"type": "login", "current_password": "newlogin456",
                         "new_password": "admin123"},
                   headers={"Authorization": f"Bearer {new_token}"})
    assert r3.status_code == 200


def test_change_password_min_length(auth_headers):
    r = _raw_post("/api/auth/change-password",
                  json={"type": "login", "current_password": "admin123",
                        "new_password": "abc"},
                  headers={"Authorization": auth_headers["Authorization"]})
    assert r.status_code == 400


def test_change_password_login_delete_must_differ(auth_headers):
    # Try to set the login password equal to current delete password (delete123)
    r = _raw_post("/api/auth/change-password",
                  json={"type": "login", "current_password": "admin123",
                        "new_password": "delete123"},
                  headers={"Authorization": auth_headers["Authorization"]})
    assert r.status_code == 400
    assert "different" in r.json().get("message", "").lower()


def test_change_password_wrong_current(auth_headers):
    r = _raw_post("/api/auth/change-password",
                  json={"type": "login", "current_password": "wrong-current",
                        "new_password": "somethingnew"},
                  headers={"Authorization": auth_headers["Authorization"]})
    assert r.status_code == 401


# ---------- Static file access without auth ----------
@pytest.mark.parametrize("page", ["/login.html", "/index.html", "/medicalbillprint.html", "/labbillprint.html"])
def test_static_files_no_auth(page):
    r = _raw_get(page)
    assert r.status_code == 200
    assert "<html" in r.text.lower() or "<!doctype" in r.text.lower()
