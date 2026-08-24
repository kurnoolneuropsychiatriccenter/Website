"""
Shared conftest for the Clinic Management System tests.

Adds session-scoped auth so every existing test file automatically gets an
Authorization Bearer token + X-Delete-Password header without changes.

Also auto-refreshes the token on 401 (in case the Node server was restarted
mid-run, which wipes the in-memory session Map).
"""
import os
import threading
import pytest
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")
LOGIN_PASSWORD = os.environ.get("CLINIC_LOGIN_PASSWORD", "Arif07@07")
DELETE_PASSWORD = os.environ.get("CLINIC_DELETE_PASSWORD", "Arif0707")

_token_lock = threading.Lock()
_token_holder = {"token": None}


def _login_and_get_token():
    for attempt in range(5):
        try:
            r = requests.post(
                f"{BASE_URL}/api/auth/login",
                json={"password": LOGIN_PASSWORD},
                timeout=10,
            )
            if r.status_code == 200:
                return r.json()["data"]["token"]
        except Exception:
            pass
        import time
        time.sleep(2)
    raise RuntimeError("Cannot log in to backend")


def _refresh_token():
    with _token_lock:
        _token_holder["token"] = _login_and_get_token()
        return _token_holder["token"]


@pytest.fixture(scope="session", autouse=True)
def _patch_session_auth():
    """Auto-attach + auto-refresh Authorization on every requests.Session()."""
    _refresh_token()
    original_init = requests.Session.__init__
    original_send = requests.Session.send

    def new_init(self, *args, **kwargs):
        original_init(self, *args, **kwargs)
        # Only set Authorization at session level; X-Delete-Password is added per-request
        # inside new_send / new_api_request so tests can override it via X-No-Auth.
        self.headers.update({
            "Authorization": f"Bearer {_token_holder['token']}",
        })

    def new_send(self, request, **kwargs):
        # Allow tests to opt-out of auto-auth by setting X-No-Auth header
        no_auth = request.headers.pop("X-No-Auth", None) is not None
        # inject latest token
        if not no_auth and "/api/" in request.url \
                and "/api/auth/login" not in request.url \
                and "/api/public/" not in request.url:
            request.headers["Authorization"] = f"Bearer {_token_holder['token']}"
            if request.method in ("DELETE", "PUT", "PATCH"):
                request.headers.setdefault("X-Delete-Password", DELETE_PASSWORD)
        resp = original_send(self, request, **kwargs)
        # If 401 "Not logged in", refresh once and retry
        if not no_auth and resp.status_code == 401 and "/api/" in request.url \
                and "/api/auth/login" not in request.url:
            try:
                msg = resp.json().get("message", "")
            except Exception:
                msg = ""
            if msg == "Not logged in":
                _refresh_token()
                request.headers["Authorization"] = f"Bearer {_token_holder['token']}"
                resp = original_send(self, request, **kwargs)
        return resp

    requests.Session.__init__ = new_init
    requests.Session.send = new_send

    # Patch requests.api.request as well (for module-level requests.get/post/etc.)
    import requests.api as _rapi
    orig_api_request = _rapi.request

    def new_api_request(method, url, **kwargs):
        headers = kwargs.pop("headers", None) or {}
        no_auth = "X-No-Auth" in headers  # keep it in headers; send() will pop
        if not no_auth and "/api/" in url and "/api/auth/login" not in url \
                and "/api/public/" not in url:
            headers.setdefault("Authorization", f"Bearer {_token_holder['token']}")
            if method.upper() in ("DELETE", "PUT", "PATCH"):
                headers.setdefault("X-Delete-Password", DELETE_PASSWORD)
        return orig_api_request(method, url, headers=headers, **kwargs)

    _rapi.request = new_api_request

    yield
    requests.Session.__init__ = original_init
    requests.Session.send = original_send
    _rapi.request = orig_api_request


@pytest.fixture(scope="session")
def auth_token():
    return _token_holder["token"] or _refresh_token()


@pytest.fixture(scope="session")
def auth_headers(auth_token):
    return {
        "Authorization": f"Bearer {auth_token}",
        "X-Delete-Password": DELETE_PASSWORD,
        "Content-Type": "application/json",
    }
