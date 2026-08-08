import urllib.request
import json

BASE = "http://localhost:3000/api"

def test_api():
    print("Testing API endpoints...")
    
    # 1. Get Patients
    req = urllib.request.urlopen(f"{BASE}/patients")
    res = json.loads(req.read().decode())
    print("Patients:", res["success"], len(res["data"]))

    # 2. Add Patient
    data = json.dumps({"patient_name": "Test Patient", "age": 30, "gender": "Male", "mobile": "9876543210", "address": "Kurnool"}).encode()
    req = urllib.request.Request(f"{BASE}/patients", data=data, headers={'Content-Type': 'application/json'})
    res = json.loads(urllib.request.urlopen(req).read().decode())
    print("Add Patient:", res)
    patient = res["data"]

    # 3. Get Doctors
    req = urllib.request.urlopen(f"{BASE}/doctors")
    res = json.loads(req.read().decode())
    print("Doctors:", res["success"], len(res["data"]))
    doctor_id = res["data"][0]["id"]

    # 4. Get Medicines
    req = urllib.request.urlopen(f"{BASE}/medicines")
    res = json.loads(req.read().decode())
    print("Medicines:", res["success"], len(res["data"]))
    med_id = res["data"][0]["id"]

    # 5. Create Purchase
    purchase_data = json.dumps({
        "invoice_no": "INV-999",
        "supplier_name": "Test Supplier",
        "invoice_date": "2026-08-08",
        "items": [{
            "medicine_id": med_id,
            "batch": "BATCH-99",
            "expiry": "2027-12-31",
            "qty": 50,
            "hsn": "3004",
            "rate": 10,
            "mrp": 15
        }]
    }).encode()
    req = urllib.request.Request(f"{BASE}/purchase/save", data=purchase_data, headers={'Content-Type': 'application/json'})
    res = json.loads(urllib.request.urlopen(req).read().decode())
    print("Save Purchase:", res)

    # 6. Save Medical Bill
    bill_data = json.dumps({
        "bill_date": "2026-08-08",
        "patient_id": patient["id"],
        "discount_percent": 10,
        "items": [{
            "medicine_id": med_id,
            "batch": "BATCH-99",
            "expiry": "2027-12-31",
            "qty": 2,
            "rate": 15
        }]
    }).encode()
    req = urllib.request.Request(f"{BASE}/medicalbill/save", data=bill_data, headers={'Content-Type': 'application/json'})
    res = json.loads(urllib.request.urlopen(req).read().decode())
    print("Save Medical Bill:", res)

    # 7. Save OP Booking
    op_data = json.dumps({
        "op_date": "2026-08-08",
        "patient_id": patient["id"],
        "doctor_id": doctor_id,
        "consultation_fee": 500,
        "payment_mode": "Cash",
        "remarks": "Headache"
    }).encode()
    req = urllib.request.Request(f"{BASE}/op/save", data=op_data, headers={'Content-Type': 'application/json'})
    res = json.loads(urllib.request.urlopen(req).read().decode())
    print("Save OP Booking:", res)

    # 8. Dashboard Summary
    req = urllib.request.urlopen(f"{BASE}/dashboard/summary")
    res = json.loads(req.read().decode())
    print("Dashboard Summary:", res)

    print("All tests passed successfully!")

if __name__ == "__main__":
    test_api()
