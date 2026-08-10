# PRD — Kurnool Neuro Psychiatric and ENT Center — Clinic Management System

## Problem Statement (original)
Build a working full-stack Clinic Management System for **Kurnool Neuro Psychiatric and ENT Center** with the following modules: Dashboard, Patient Master, Doctor Master, Medicine Master, Purchase, Purchase History, Medical Billing, Medical Bill History, OP Booking, OP History, Medicine Return, Reports, and printable OP + Medical bills. Priority workflow: **Purchase → Stock → Medical Billing**.

## Tech Stack
- Backend: **Node.js + Express.js** (`/app/server.js`), single file, listens on **port 3000**.
- Database: **SQLite** file `clinic.db` (created next to server.js). This is portable, needs no install on the user's laptop other than Node.
- Frontend: **HTML + Tailwind CDN + Vanilla JavaScript** (`/app/public/*.html`), served by Express.
- Emergent preview: `/app/backend/server.py` is now a **thin FastAPI proxy on port 8001** that forwards `/api/*` to `http://localhost:3000` so the preview URL works. On the user's laptop this file is not used.

## User Personas
- Clinic staff (receptionist / pharmacist / owner). Non-technical.

## Core Requirements (STATIC)
- Auto-generated unique patient code (`KNC001XXXXXX`).
- Sequential per-day OP token numbers, printable OP bill.
- Batch-aware medicine master with stock.
- Purchase increases stock; single "Add More Medicine" button; grand total = Σ(qty·rate).
- Medical billing consumes stock; must prevent overselling; discount % applied on subtotal → grand total.
- Delete of purchase reverses stock; delete of medical bill restores stock.
- History screens default to **TODAY**; support From/To date + text search.
- Medicine return decreases stock.
- Reports for OP, sales, purchase, stock, low-stock, expiry, patient, doctor, daily collection.
- Printable OP receipt and Medical bill (buttons hidden on print).
- Every interactive element has `data-testid`.

## What's Implemented (Aug 10, 2026)
- Dashboard with 8 summary tiles + 11 nav cards.
- Patient / Doctor / Medicine CRUD + search + filters.
- OP Booking (auto today's date, auto token per day, autofill patient by code).
- OP History with Today filter, Print, Delete. OP Print page.
- Purchase multi-item form (single "Add More Medicine" button), stock increment on save.
- Purchase History with Today filter, Delete-reverses-stock.
- Medical Billing multi-item form with patient autofill, batch/expiry/MRP autofill, over-sell blocked, discount %, Save decreases stock.
- Medical Bill History with Patient Code visible, Print, Delete-restores-stock.
- Medical Bill Print page ("Asha Medical" header).
- Medicine Return module with stock decrement + history table.
- Reports page with 10 report types + Today / date-range filters.
- Dashboard summary API aggregating today's counts + total patients + low stock + expiring.
- Backend transactional stock changes; delete endpoints no longer race-condition prone.
- `bill_no` uses `MAX(id)+1` (delete-safe). Reports SQL parameterized.
- FastAPI proxy `/app/backend/server.py` routes `/api/*` from ingress to Node on 3000.

## Testing
- `/app/backend/tests/test_clinic_api.py` — 31 backend tests, all pass through preview URL.
- Playwright UI smoke of dashboard, patients, medicines, purchase, medical bill, OP booking — all pass.
- Report: `/app/test_reports/iteration_2.json` (0 critical, 0 major, only minor CDN-Tailwind warning).

## Local Laptop Setup (Windows/macOS/Linux)
1. Install Node.js 18+ from https://nodejs.org.
2. Copy the whole `/app` folder to the laptop (or just `server.js`, `package.json`, `public/`).
3. Open a terminal in that folder.
4. Run `npm install`.
5. Run `node server.js`.
6. Open `http://localhost:3000` in a browser.
Data is stored in `clinic.db` in the same folder. Back it up regularly.

## Prioritized Backlog
### P1
- Clinic address / phone / registration number for print headers — currently a placeholder ("Main Road, Kurnool, Andhra Pradesh - 518001").
- Edit endpoints for Purchase and Medical Bill (currently only Delete; add is done).
### P2
- Split `server.js` into per-route modules; extract stock-mutation helper.
- Replace Tailwind CDN with a built CSS file for production.
- Optional: switch to SQL Server 2022 Express + Windows Auth if strictly required (SQLite currently satisfies the "store data on my PC" goal with zero-install DB).
- Simple username/password login for the clinic terminal.
- Daily backup script for `clinic.db`.

## Next Tasks
- Get exact clinic address + phone from user for print headers.
- Add Edit for Purchase and Medical Bill (with correct stock reversal + re-application).
- Optional: password protect the app (single user PIN).
