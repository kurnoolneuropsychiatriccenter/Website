"""Settings (GST number) tests."""
import os
import requests
import pytest

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")


@pytest.fixture(scope="module")
def s():
    sess = requests.Session()
    sess.headers.update({"Content-Type": "application/json"})
    return sess


def test_settings_put_and_get(s):
    r = s.put(f"{BASE_URL}/api/settings", json={"gst_number": "37ABCDE1234F1Z2"})
    assert r.status_code == 200
    r2 = s.get(f"{BASE_URL}/api/settings")
    assert r2.status_code == 200
    assert r2.json()["data"]["gst_number"] == "37ABCDE1234F1Z2"


def test_public_gst_no_auth_returns_value(s):
    # Set first
    s.put(f"{BASE_URL}/api/settings", json={"gst_number": "37ABCDE1234F1Z2"})
    # Now call without auth headers
    fresh = requests.Session()
    fresh.headers.clear()
    r = fresh.get(f"{BASE_URL}/api/public/gst")
    assert r.status_code == 200
    assert r.json()["data"]["gst_number"] == "37ABCDE1234F1Z2"


def test_settings_blank_gst(s):
    r = s.put(f"{BASE_URL}/api/settings", json={"gst_number": ""})
    assert r.status_code == 200
    r2 = s.get(f"{BASE_URL}/api/settings")
    assert r2.json()["data"]["gst_number"] == ""
