# Clinic Software — Kurnool Neuro Psychiatric and ENT Center

A self-contained clinic management system that runs on your own PC. No internet
needed after setup. All data is stored in a single file (`clinic.db`) next to
the code, so you always own your data.

---

## Windows — one-time setup (5 minutes)

1. **Install Node.js LTS v20.**
   - Go to https://nodejs.org
   - Click the button labelled **LTS** (currently v20 or v22). Do **NOT** pick
     the newest / "Current" version — the SQLite package does not have a
     prebuilt binary for the very newest Node versions yet, and installation
     will fail.
   - Run the downloaded `.msi` installer. Click Next / Next / Install with the
     default settings. Restart the computer once when it finishes.

2. **Copy the software folder to your computer.** For example,
   `C:\Users\<YourName>\Desktop\clinic-software\`.

3. **Double-click `start.bat`.**
   - The first time you run it, it will install the required packages
     automatically (this takes 2–5 minutes and needs internet). Any subsequent
     time it will just start the software instantly.
   - A black terminal window will open — **do not close it while using the
     software.** Closing it stops the software.
   - Your default browser will open automatically to
     `http://localhost:3000`.

4. **Optional:** right-click `start.bat` → **Send to → Desktop (create shortcut)**
   and rename the shortcut to *Clinic Software*. From then on you launch the
   software from that shortcut.

---

## Mac / Linux setup

```
cd /path/to/clinic-software
bash start.sh
```

---

## Daily use

- Just double-click `start.bat` (Windows) or run `bash start.sh` (Mac/Linux).
- The software opens at `http://localhost:3000`.
- To stop the software, close the black terminal window.

---

## Where is the data stored?

- All patients, OP visits, purchases, medicines, medical bills and stock are in
  a single file: **`clinic.db`** — right next to `server.js`.
- To back up your data, just copy that `clinic.db` file to a USB stick or cloud
  folder. To restore, put it back in the same folder.
- We **strongly recommend** copying `clinic.db` to a pen drive every evening.

---

## Modules

- Dashboard (today's OP count, patients, medical bills, collection, purchase,
  total patients, low stock, expiring medicines).
- Patient Master — auto-generated patient code `KNC001XXXXXX`.
- Doctor Master.
- Medicine Master with low-stock & expiry alerts.
- Purchase — multi-medicine entry, stock is added automatically.
- Purchase History — Today filter by default. Deleting a purchase reverses the
  stock.
- Medical Billing (Asha Medicals format) — auto-fills patient by code, picks
  batch/expiry/HSN/MRP from stock, blocks over-selling, supports % or ₹
  discount.
- Medical Bill History — Print reprints in the exact Asha Medicals design.
- OP Booking + OP History — auto token per day, invoice numbers, print in the
  exact Kurnool Neuro OP bill format.
- Medicine Return — reduces stock when returning to supplier.
- Reports — Today's OP, OP Collection, Medical Sales, Purchase, Stock, Low
  Stock, Expiring, Patient list, Doctor list, Daily Collection.

---

## Troubleshooting

**"Cannot find module 'sqlite3'"**
You did not run `npm install`. Use `start.bat` — it does it for you.

**`npm install` fails with "gyp" / "MSBuild" / "python" errors on Windows**
You are on a Node.js version too new for the SQLite prebuilt binary. Uninstall
Node from *Add or remove programs*, then install **Node.js LTS v20** from
https://nodejs.org. Delete the `node_modules` folder if it exists, then
double-click `start.bat` again.

**Port 3000 is already used**
Some other program is using port 3000. Close that program, or edit `server.js`
line `const PORT = process.env.PORT || 3000;` and change 3000 to 3001, then
open `http://localhost:3001` instead.

**Browser shows "This site can't be reached"**
The terminal window was closed. Double-click `start.bat` again and wait until
the browser opens.

---

## Files

- `server.js` — backend + SQLite database.
- `public/` — all screens (`.html` files).
- `clinic.db` — your live data. Back this up.
- `start.bat` / `start.sh` — launcher scripts.
- `package.json` — dependency list.
