"""Verify medical bill print (compact A5) HTML contents and GST display."""
import os
import requests

BASE_URL = os.environ["REACT_APP_BACKEND_URL"].rstrip("/")


def test_medicalbillprint_has_compact_a5_and_note():
    r = requests.get(f"{BASE_URL}/medicalbillprint.html")
    assert r.status_code == 200
    body = r.text
    # Note must be present
    assert "Medicine once sold cannot be returned" in body, "Missing return-policy note"
    # A5 in @page rule (@media print)
    upper = body.upper()
    assert "@PAGE" in upper
    assert "A5" in upper
    # 3-column compact meta labels present
    for label in ["Name", "Phone", "Date", "Ref", "Town", "Invoice"]:
        assert label in body, f"Missing meta label: {label}"
    # GST print hook (an element referencing gst)
    assert "gst" in body.lower(), "No GST wiring on medical bill print page"


def test_login_page_exists_and_shows_clinic_name():
    r = requests.get(f"{BASE_URL}/login.html")
    assert r.status_code == 200
    # Common clinic identifiers used in this codebase
    txt = r.text
    assert any(k in txt for k in ["Clinic", "clinic", "Asha", "Kurnool Neuro", "Rahiman"])


def test_index_has_lab_bill_and_settings_nav():
    r = requests.get(f"{BASE_URL}/index.html")
    assert r.status_code == 200
    txt = r.text
    assert "Lab Bill" in txt
    assert "Lab Bill History" in txt
    assert "Settings" in txt
    assert "Logout" in txt or "logout" in txt


def test_all_html_pages_include_auth_js():
    # spot-check: existing app pages should include auth.js (client-side gate)
    for page in ["patients.html", "medicalbill.html", "opbooking.html", "labbill.html", "settings.html"]:
        r = requests.get(f"{BASE_URL}/{page}")
        assert r.status_code == 200, page
        assert "js/auth.js" in r.text, f"{page} missing auth.js include"
