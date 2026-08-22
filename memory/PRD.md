# PRD — Kurnool Neuro Psychiatric and ENT Center — Clinic Management System

## Problem Statement (original)
Build a working full-stack Clinic Management System for **Kurnool Neuro Psychiatric and ENT Center** with modules: Dashboard, Patient Master, Doctor Master, Medicine Master, Purchase, Purchase History, Medical Billing, Medical Bill History, Lab Bill / Lab Bill History, OP Booking, OP History, Medicine Return, Daily Expenses, Staff Attendance, Reports, Records, Settings, and printable OP / Medical / Lab bills. Priority workflow: **Purchase → Stock → Medical Billing**.

## Tech Stack
- Backend: **Node.js + Express.js** (`/app/server.js`), single-file, listens on **port 3000**.
- Database: **SQLite** file `clinic.db` next to server.js. Portable — user copies it to a pen-drive for backups. NO plans to migrate to MS SQL Server.
- Frontend: **HTML + Tailwind CDN + Vanilla JavaScript** (`/app/public/*.html`), served by Express.
- Emergent preview: `/app/backend/server.py` is a thin FastAPI proxy on port 8001 that forwards `/api/*` to Node on port 3000. On the user's laptop only Node is used.

## User Personas
- Clinic staff (receptionist / pharmacist / owner). **Non-technical.** Runs the app by double-clicking `start.bat` on Windows.

## Core Requirements (STATIC)
- Auto-generated unique patient code (`KNC001XXXXXX`).
- Sequential per-day OP token numbers, printable OP bill.
- Batch-aware medicine master with stock + optional short product_code.
- Purchase increases stock; medical billing consumes stock; delete reverses stock in a transaction.
- History screens default to **TODAY**; support From/To date + text search.
- Discount can be entered as **% OR ₹** (auto-synced).
- A4 print layout matching the reference "Asha Medicals" and "Kurnool Neuro" formats.
- Two-password model: login vs delete (must be different). Recovery via 8-char hex code. Developer email + developer password for lockout recovery.
- Every interactive element has `data-testid`.

## What's Implemented — timeline

### Aug 10, 2026
- Dashboard, Patient/Doctor/Medicine CRUD, OP Booking + Print, Medical Billing + Print (Asha Medicals layout), Purchase, Reports, Medicine Return v1.
- Idempotent `ALTER TABLE ADD COLUMN` migration for all new print-format fields.

### Session 8 (Msg 243 batch)
- Lab Bills + Lab Bill History + Lab Bill Print.
- Daily Expenses, Staff Attendance modules.
- Refactored all print templates to A4.

### Session 12 — 7-Change Batch (Feb 22, 2026)
- **Suppliers form + list page** (`/suppliers.html`): Name, PAN, Phone, Address, GST, FSSAI, MSME fields with Save. Nav card `nav-suppliers` on dashboard. Backend upserts by name (case-insensitive) — no duplicates.
- **Prefix-match medicine autocomplete** — new `/public/js/medicine-autocomplete.js` (`.med-ac-list { max-height:none; overflow:visible }`). Cap at 12 visible entries so no scrollbar ever appears. Wired into `medicalbill.html` (bill-med-input) and `purchase.html` (pur-med). Typing "para" only shows medicines starting with "para".
- **Stock deduction on pending Clear** — `DELETE /api/pending-medicines/:id` now also decrements `medicines.current_stock` by the pending qty (case-insensitive match on medicine_name, clamped ≥ 0). Regular medical-bill save already deducted stock.
- **Tax removed from Medical Bill** — MRP is tax-inclusive. Amount = qty × MRP. Green banner explains this in the form. Tax column hidden in items table and in print. `tax_percent` field kept in payload for backwards-compat but forced to 0 server-side.
- **Attendance lock + monthly summary** — `POST /api/staff/attendance` switched from `ON CONFLICT DO UPDATE` to `INSERT OR IGNORE`; response says how many were saved vs already locked. `GET /api/staff/attendance/monthly-summary?month=YYYY-MM` returns present/half/absent + `present_equivalent = present + 0.5×half`. UI: locked rows show green "Locked" badge with `data-testid=att-locked-<id>` and radios are disabled; new Monthly Summary section on `staff.html`.
- **PWA installable desktop app** — `/public/manifest.json` (name "Kurnool Neuro-ENT — Clinic Management", short "Kurnool Neuro-ENT", display "standalone"), `/public/icons/icon-192.png` + `icon-512.png` (dark-blue "KN" tile), minimal `/public/sw.js` service worker, `<link rel="manifest">` + `<meta name="theme-color" content="#0f3d8f">` injected into all 25 HTML files, service worker registered in `auth.js`.
- **Medical Bill print → A5** (`@page { size: A5 portrait; margin: 6mm }`, 3-column meta, smaller fonts, Tax column removed). OP and Lab prints already on A5 from Session 11.
- Tests: 14/14 pass (`test_seven_batch.py`); regression 47+/47+ across all iterations. Report `/app/test_reports/iteration_12.json`.
- Login password changed by user from `admin123` → `Arif07@07`; Delete from `delete123` → `Arif0707`. Documented in `test_credentials.md`.

### Session 11 — Suppliers, A5 Prints, Full PDF, Pending Medicines (Feb 21, 2026)
- **Supplier autocomplete + auto-save** — new `/api/suppliers` (GET/POST/DELETE) with case-insensitive upsert by name. Purchase form now shows a datalist so staff pick a saved supplier and GST/FSSAI/PAN/MSME/phone/address auto-fill. Every `POST /api/purchase/save` also silently upserts the supplier so the list grows organically.
- **Removed the Prod Code column** from Purchase Entry (as requested — it was in the way).
- **A5 prints for OP & Lab bills** — `@page { size: A5 portrait; margin: 6mm }`. Meta section refactored into single-line `meta-row` rows (label + value inline) so the header block fits comfortably in the top half of the page. Font sizes shrunk consistently across header, table, totals.
- **Full-data PDF export** — new `GET /api/backup/all-pdf` streams a single multi-section PDF (Patients, Doctors, Medicines, Purchases, Medical / Lab / OP Bills, Pending Medicines, Returns, Expenses, Staff, Attendance) with page numbers. Uses `pdfkit ^0.19.1`. Wired to a new "Download ALL Data as PDF" button in Settings (fetch-blob so auth token is attached).
- **Pending Medicines module** — new `pending_medicines` table + REST endpoints. In Medical Bill form, each row gets an orange hourglass button that pops up a confirm and saves the medicine (name + qty + optional note) to pending, tied to the current patient. Dedicated `/pending.html` page lists everything, filter by pending/cleared/all, and Clear/Purge actions require the Delete password.
- **Dashboard**: new `nav-pending` card next to Medicine Return.
- **Backup download fix**: `Download Backup File` link converted to fetch-blob so it works with the auth wrapper.
- Tests: `/app/backend/tests/test_suppliers_pending_pdf.py` (12/12 pass). Combined 33/33 pass with prior iterations. Report `/app/test_reports/iteration_11.json`.

### Session 10 — Danger Zone Email Gate (Feb 19, 2026)
- **Destructive actions now require a 6-digit code emailed via Gmail SMTP** to `settings.recovery_email` (`shaikabuzarrahiman@gmail.com`). Staff can no longer accidentally wipe the DB by clicking a button.
- New backend endpoints:
  - `GET /api/settings/smtp-status` — returns whether email is configured (never leaks the password).
  - `PUT /api/settings/smtp` — save host/port/user/pass/from_name; empty pass keeps existing.
  - `POST /api/settings/smtp-test` — sends a test email to the recovery inbox.
  - `POST /api/dev/request-danger-code` — body `{action}`; generates a bcrypt-hashed 6-digit code (15-min TTL), emails it, returns `request_key`.
  - `POST /api/dev/verify-danger-code` — body `{request_key, code, action}`; on success executes the destructive action and consumes the code.
  - Legacy `POST /api/dev/clear-demo-data` and `/api/dev/reset-all-data` now return 403 with a helpful redirect message.
- New nodemailer dependency (`^9.0.5`) in `package.json`.
- `settings.html` gains an **Email Setup** card with step-by-step Gmail App Password instructions and a **Danger Code modal** for typing the 6-digit code.
- Tests: `/app/backend/tests/test_danger_zone_email.py` (10 tests) + updated `test_msg319_features.py`. 21/21 pass. Report `/app/test_reports/iteration_10.json`.

### Session 9 — Msg 319 batch (Feb 19, 2026)
- **1. Bill Details Modal** — clicking any bill_no on `ophistory.html`, `medicalbillhistory.html`, or `labbillhistory.html` opens a modal with all line items, subtotal, discount (hidden if zero), and grand total. Modal Print button jumps to the corresponding print page. `data-testid`s: `op-details-modal`, `bill-details-modal`, `lab-details-modal`.
- **2. Clear Demo Data endpoint** — `POST /api/dev/clear-demo-data` removes the 2 seeded demo doctors / patients / medicines only (idempotent).
- **3. Product Code lookup** — `GET /api/medicines/code/:code` returns the medicine by product_code (or exact name). Purchase.html now has a `Prod Code` input per row that auto-fills the medicine dropdown + HSN + MRP + rate + batch + expiry via this endpoint. Medicine master (`medicines.html`) now has a Product Code input and a Code column.
- **4. A4 prints** — all print pages already use A4 (`@page { size: A4; }`).
- **5. Multi-row Returns** — `returns.html` supports adding/removing multiple rows; each row POSTs to `/api/returns`.
- **6. Discount % vs ₹ radio** — `medicalbill.html` accepts either input and auto-syncs the other.
- **7. Patient code on OP print** — already included in the OP print template.
- **8. Hide zero discount** — bill details modal + print pages suppress the discount line when the amount is 0.
- **9. Hard-coded GST default** — settings.gst_number backfilled from user-configured value in Settings; exposed via `GET /api/public/gst`.
- **10. Password instructions** — `/app/memory/test_credentials.md` documents login, delete, and recovery flows.
- **11. Patient pending amount** — new `pending_amount` column on `patients`; `GET /api/patients/:id/pending` and `POST /api/patients/:id/pending-adjust` for +/- deltas.
- **12. Developer email + password reset** — `settings.developer_email` (`arif052705@gmail.com`) + `settings.developer_password_hash` + `POST /api/auth/developer-reset-password`. GET /api/settings now surfaces the developer_email.

## Testing (Iteration 9 report)
- `/app/backend/tests/test_msg319_features.py` — 13 new pytest tests, all pass.
- Playwright end-to-end: modals open, forms submit, product-code auto-fill works, stock changes verified.
- 129/131 pytest pass overall; 2 pre-existing UNRELATED failures assert literal "A5" in print HTML (harmless).
- Report file: `/app/test_reports/iteration_9.json`.

## Files of Reference
- `/app/server.js` — all backend routes, DB init, and business logic (~1740 lines, kept monolithic for portability).
- `/app/public/*.html` — one file per screen (see `medicalbillhistory.html`, `ophistory.html`, `labbillhistory.html`, `purchase.html`, `medicines.html` for latest changes).
- `/app/public/js/auth.js` — front-end auth wrapper that injects Bearer token into every fetch.
- `/app/start.bat` / `/app/start.sh` — user-facing launcher scripts.
- `/app/memory/test_credentials.md` — login / delete / recovery credentials.

## Local Laptop Setup (Windows)
1. Install Node.js 18+.
2. Double-click `start.bat` inside the copied `/app` folder — it runs `npm install` if needed and then `node server.js`.
3. Open `http://localhost:3000`.
4. Back up by copying `clinic.db` to a USB pen-drive.

## Prioritized Backlog
### P1 (Next up)
- **Desktop packaging** — bundle Node app into a `.exe` with `pkg` so clinic staff cannot see the raw `.js` files. Deliver as a `build.bat` the user double-clicks. (Msg 319 Point 12 — deferred.)
- **Edit endpoints for Purchase and Medical Bill** — currently only delete+re-add.
### P2 (Nice to have)
- Guard `POST /api/patients/:id/pending-adjust` with `max(0, ...)` so pending can't go negative.
- Require the delete password on destructive endpoints (`/api/dev/clear-demo-data`, `/api/dev/reset-all-data`).
- Split `server.js` into per-route modules once it becomes unwieldy (>2000 lines).
- Replace Tailwind CDN with a built CSS file to eliminate flash-of-unstyled-content on slow networks.
- Fix 2 pre-existing pytest print-HTML assertions still checking for literal "A5" text.

## Known Non-Blockers
- Concurrent-user race condition on stock during returns (single-user local clinic app — acceptable).
- Developer reset endpoint returns the new plaintext password in the response body — intentional for local recovery flow.
