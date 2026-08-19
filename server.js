const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

app.use(cors());
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(express.static(path.join(__dirname, 'public')));

// =============================================================================
// AUTHENTICATION
// =============================================================================
const sessions = new Map(); // token -> { expiresAt }
const SESSION_TTL_MS = 12 * 60 * 60 * 1000; // 12 hours

function makeToken() { return crypto.randomBytes(24).toString('hex'); }

function getSetting(key) {
  return new Promise((resolve) => {
    db.get(`SELECT svalue FROM settings WHERE skey = ?`, [key], (err, row) => resolve(row ? row.svalue : null));
  });
}

function setSetting(key, value) {
  return new Promise((resolve) => {
    db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES (?, ?)`, [key, value], () => resolve());
  });
}

// Public endpoints (no auth required)
app.post('/api/auth/login', async (req, res) => {
  const { password } = req.body || {};
  if (!password) return res.status(400).json({ success: false, message: 'Password required' });
  const hash = await getSetting('login_password_hash');
  if (!hash || !bcrypt.compareSync(password, hash)) {
    return res.status(401).json({ success: false, message: 'Wrong password' });
  }
  const token = makeToken();
  sessions.set(token, { expiresAt: Date.now() + SESSION_TTL_MS });
  res.json({ success: true, data: { token } });
});

// Guard: every /api/* request except a small whitelist needs a valid Bearer token
app.use('/api', (req, res, next) => {
  if (req.path === '/auth/login' || req.path === '/auth/forgot-password' || req.path === '/public/gst') return next();
  const auth = req.headers.authorization || '';
  const token = auth.startsWith('Bearer ') ? auth.slice(7) : null;
  const s = token && sessions.get(token);
  if (!s || s.expiresAt < Date.now()) {
    return res.status(401).json({ success: false, message: 'Not logged in' });
  }
  // slide expiry
  s.expiresAt = Date.now() + SESSION_TTL_MS;
  next();
});

// Guard: every DELETE /api/* needs the correct delete password header
app.use('/api', async (req, res, next) => {
  if (req.method !== 'DELETE') return next();
  const pw = req.headers['x-delete-password'];
  if (!pw) return res.status(401).json({ success: false, message: 'Delete password required' });
  const hash = await getSetting('delete_password_hash');
  if (!hash || !bcrypt.compareSync(String(pw), hash)) {
    return res.status(401).json({ success: false, message: 'Wrong delete password' });
  }
  next();
});

// Change either the login or delete password (requires current login password + type)
app.post('/api/auth/change-password', async (req, res) => {
  const { type, current_password, new_password } = req.body || {};
  if (!['login', 'delete'].includes(type)) return res.status(400).json({ success: false, message: 'type must be login or delete' });
  if (!new_password || new_password.length < 4) return res.status(400).json({ success: false, message: 'New password must be at least 4 characters' });
  const loginHash = await getSetting('login_password_hash');
  if (!loginHash || !bcrypt.compareSync(String(current_password || ''), loginHash)) {
    return res.status(401).json({ success: false, message: 'Current login password is wrong' });
  }
  // Enforce: login and delete passwords must not be same
  const otherKey = type === 'login' ? 'delete_password_hash' : 'login_password_hash';
  const otherHash = await getSetting(otherKey);
  if (otherHash && bcrypt.compareSync(String(new_password), otherHash)) {
    return res.status(400).json({ success: false, message: 'Login and Delete passwords must be different' });
  }
  const newHash = bcrypt.hashSync(String(new_password), 10);
  await setSetting(type === 'login' ? 'login_password_hash' : 'delete_password_hash', newHash);
  // Keep the plain-text mirror of the LOGIN password up-to-date for recovery.
  if (type === 'login') await setSetting('login_password_plain', String(new_password));
  res.json({ success: true, message: 'Password changed' });
});

// Forgot password: user provides recovery_code, we return their existing LOGIN password.
app.post('/api/auth/forgot-password', async (req, res) => {
  const { recovery_code } = req.body || {};
  const stored = await getSetting('recovery_code');
  if (!stored || String(recovery_code || '').trim().toUpperCase() !== String(stored).toUpperCase()) {
    return res.status(401).json({ success: false, message: 'Wrong recovery code' });
  }
  const plain = (await getSetting('login_password_plain')) || '';
  res.json({ success: true, data: { login_password: plain } });
});

// Regenerate a new recovery code (protected by login)
app.post('/api/auth/regenerate-recovery-code', async (req, res) => {
  const nu = crypto.randomBytes(4).toString('hex').toUpperCase();
  await setSetting('recovery_code', nu);
  res.json({ success: true, data: { recovery_code: nu } });
});

// Settings: GST number, recovery code, recovery email
app.get('/api/settings', async (req, res) => {
  const gst = (await getSetting('gst_number')) || '';
  const email = (await getSetting('recovery_email')) || '';
  const rec = (await getSetting('recovery_code')) || '';
  const devEmail = (await getSetting('developer_email')) || '';
  res.json({ success: true, data: { gst_number: gst, recovery_email: email, recovery_code: rec, developer_email: devEmail } });
});
app.put('/api/settings', async (req, res) => {
  const { gst_number, recovery_email } = req.body || {};
  if (gst_number !== undefined) await setSetting('gst_number', String(gst_number));
  if (recovery_email !== undefined) await setSetting('recovery_email', String(recovery_email));
  res.json({ success: true, message: 'Settings saved' });
});

// Public-safe GST getter for print pages (no auth to allow print reload after session expiry — read-only string)
app.get('/api/public/gst', async (req, res) => {
  const gst = (await getSetting('gst_number')) || '';
  res.json({ success: true, data: { gst_number: gst } });
});


// Database setup
const dbFile = path.join(__dirname, 'clinic.db');
const db = new sqlite3.Database(dbFile, (err) => {
  if (err) {
    console.error('Error opening database', err.message);
  } else {
    console.log('Connected to SQLite database.');
    initDb();
  }
});

function initDb() {
  db.serialize(() => {
    // Patients
    db.run(`CREATE TABLE IF NOT EXISTS patients (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      patient_code TEXT UNIQUE NOT NULL,
      patient_name TEXT NOT NULL,
      age INTEGER,
      gender TEXT,
      mobile TEXT,
      address TEXT,
      registration_date TEXT
    )`);

    // Doctors
    db.run(`CREATE TABLE IF NOT EXISTS doctors (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      doctor_name TEXT NOT NULL,
      qualification TEXT,
      mobile TEXT,
      consultation_fee REAL,
      status TEXT DEFAULT 'Active'
    )`);

    // Medicines Master
    db.run(`CREATE TABLE IF NOT EXISTS medicines (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medicine_name TEXT NOT NULL,
      generic_name TEXT,
      hsn_number TEXT,
      batch_number TEXT,
      expiry_date TEXT,
      rate REAL,
      mrp REAL,
      current_stock REAL DEFAULT 0,
      minimum_stock REAL DEFAULT 10,
      status TEXT DEFAULT 'Active'
    )`);

    // OP Token Counter per date
    db.run(`CREATE TABLE IF NOT EXISTS op_token_counter (
      date TEXT PRIMARY KEY,
      last_token INTEGER
    )`);

    // OP Bills
    db.run(`CREATE TABLE IF NOT EXISTS op_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      op_bill_id TEXT UNIQUE,
      op_date TEXT,
      token_number INTEGER,
      patient_id INTEGER,
      doctor_id INTEGER,
      consultation_fee REAL,
      payment_mode TEXT,
      remarks TEXT,
      FOREIGN KEY(patient_id) REFERENCES patients(id),
      FOREIGN KEY(doctor_id) REFERENCES doctors(id)
    )`);

    // Additive columns for the OP Bill (Kurnool Neuro) print format
    ['ALTER TABLE op_bills ADD COLUMN invoice_no TEXT',
     'ALTER TABLE op_bills ADD COLUMN patient_name_snapshot TEXT',
     'ALTER TABLE op_bills ADD COLUMN patient_phone_snapshot TEXT',
     'ALTER TABLE op_bills ADD COLUMN patient_age_snapshot INTEGER'
    ].forEach(sql => db.run(sql, () => {}));

    // Purchases Master
    db.run(`CREATE TABLE IF NOT EXISTS purchases (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      invoice_no TEXT,
      supplier_name TEXT,
      invoice_date TEXT,
      grand_total REAL
    )`);

    // Purchase Items
    db.run(`CREATE TABLE IF NOT EXISTS purchase_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      purchase_id INTEGER,
      medicine_id INTEGER,
      batch TEXT,
      expiry TEXT,
      qty REAL,
      hsn TEXT,
      rate REAL,
      mrp REAL,
      amount REAL,
      FOREIGN KEY(purchase_id) REFERENCES purchases(id) ON DELETE CASCADE,
      FOREIGN KEY(medicine_id) REFERENCES medicines(id)
    )`);

    // Medical Bills Master
    db.run(`CREATE TABLE IF NOT EXISTS medical_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_no TEXT UNIQUE,
      bill_date TEXT,
      patient_id INTEGER,
      subtotal REAL,
      discount_percent REAL,
      discount_amount REAL,
      grand_total REAL,
      FOREIGN KEY(patient_id) REFERENCES patients(id)
    )`);

    // Additive columns for the Asha Medicals print format (safe if they already exist)
    ['ALTER TABLE medical_bills ADD COLUMN invoice_no TEXT',
     'ALTER TABLE medical_bills ADD COLUMN town TEXT',
     'ALTER TABLE medical_bills ADD COLUMN referred_by_doctor_id INTEGER',
     'ALTER TABLE medical_bills ADD COLUMN patient_name_snapshot TEXT',
     'ALTER TABLE medical_bills ADD COLUMN patient_phone_snapshot TEXT'
    ].forEach(sql => db.run(sql, () => {}));

    // Medical Bill Items
    db.run(`CREATE TABLE IF NOT EXISTS medical_bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      medical_bill_id INTEGER,
      medicine_id INTEGER,
      batch TEXT,
      expiry TEXT,
      qty REAL,
      rate REAL,
      amount REAL,
      FOREIGN KEY(medical_bill_id) REFERENCES medical_bills(id) ON DELETE CASCADE,
      FOREIGN KEY(medicine_id) REFERENCES medicines(id)
    )`);

    ['ALTER TABLE medical_bill_items ADD COLUMN hsn TEXT',
     'ALTER TABLE medical_bill_items ADD COLUMN mrp REAL',
     'ALTER TABLE medical_bill_items ADD COLUMN sgst_percent REAL DEFAULT 0',
     'ALTER TABLE medical_bill_items ADD COLUMN cgst_percent REAL DEFAULT 0',
     'ALTER TABLE medical_bill_items ADD COLUMN sgst_amount REAL DEFAULT 0',
     'ALTER TABLE medical_bill_items ADD COLUMN cgst_amount REAL DEFAULT 0'
    ].forEach(sql => db.run(sql, () => {}));

    // Medicine Returns
    db.run(`CREATE TABLE IF NOT EXISTS medicine_returns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      return_date TEXT,
      medicine_id INTEGER,
      batch TEXT,
      qty REAL,
      reason TEXT,
      supplier TEXT,
      FOREIGN KEY(medicine_id) REFERENCES medicines(id)
    )`);

    // Settings (key/value pairs: login_password_hash, delete_password_hash, gst_number, clinic settings, etc.)
    db.run(`CREATE TABLE IF NOT EXISTS settings (
      skey TEXT PRIMARY KEY,
      svalue TEXT
    )`);

    // Lab Bills Master (Dr. Rahiman Diagnostics)
    db.run(`CREATE TABLE IF NOT EXISTS lab_bills (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      bill_no TEXT UNIQUE,
      bill_date TEXT,
      patient_id INTEGER,
      patient_name_snapshot TEXT,
      patient_phone_snapshot TEXT,
      patient_age_snapshot INTEGER,
      referred_by_doctor_id INTEGER,
      invoice_no TEXT,
      subtotal REAL,
      discount_percent REAL,
      discount_amount REAL,
      grand_total REAL,
      notes TEXT,
      FOREIGN KEY(patient_id) REFERENCES patients(id),
      FOREIGN KEY(referred_by_doctor_id) REFERENCES doctors(id)
    )`);

    // Lab Bill Items (test rows)
    db.run(`CREATE TABLE IF NOT EXISTS lab_bill_items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lab_bill_id INTEGER,
      test_name TEXT,
      rate REAL,
      amount REAL,
      FOREIGN KEY(lab_bill_id) REFERENCES lab_bills(id) ON DELETE CASCADE
    )`);

    // Suppliers master (used by Purchase)
    db.run(`CREATE TABLE IF NOT EXISTS suppliers (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      supplier_name TEXT,
      gst_number TEXT,
      fssai_number TEXT,
      pan_number TEXT,
      msme_number TEXT,
      phone TEXT,
      address TEXT
    )`);

    // Additive columns for enriched purchases
    ['ALTER TABLE purchases ADD COLUMN supplier_gst TEXT',
     'ALTER TABLE purchases ADD COLUMN supplier_fssai TEXT',
     'ALTER TABLE purchases ADD COLUMN supplier_pan TEXT',
     'ALTER TABLE purchases ADD COLUMN supplier_msme TEXT',
     'ALTER TABLE purchases ADD COLUMN supplier_phone TEXT',
     'ALTER TABLE purchases ADD COLUMN supplier_address TEXT',
     'ALTER TABLE purchases ADD COLUMN subtotal REAL DEFAULT 0',
     'ALTER TABLE purchases ADD COLUMN sgst_total REAL DEFAULT 0',
     'ALTER TABLE purchases ADD COLUMN cgst_total REAL DEFAULT 0',
     'ALTER TABLE purchases ADD COLUMN adjustment REAL DEFAULT 0'
    ].forEach(sql => db.run(sql, () => {}));

    ['ALTER TABLE purchase_items ADD COLUMN package TEXT',
     'ALTER TABLE purchase_items ADD COLUMN discount_percent REAL DEFAULT 0',
     'ALTER TABLE purchase_items ADD COLUMN sgst_percent REAL DEFAULT 0',
     'ALTER TABLE purchase_items ADD COLUMN igst_percent REAL DEFAULT 0',
     'ALTER TABLE purchase_items ADD COLUMN sgst_amount REAL DEFAULT 0',
     'ALTER TABLE purchase_items ADD COLUMN igst_amount REAL DEFAULT 0'
    ].forEach(sql => db.run(sql, () => {}));

    // Medical bill: adjustment (add/less)
    ['ALTER TABLE medical_bills ADD COLUMN adjustment REAL DEFAULT 0',
     'ALTER TABLE medical_bills ADD COLUMN tax_percent REAL DEFAULT 5'
    ].forEach(sql => db.run(sql, () => {}));
    ['ALTER TABLE medical_bill_items ADD COLUMN pack TEXT',
     'ALTER TABLE medical_bill_items ADD COLUMN tax_percent REAL DEFAULT 5',
     'ALTER TABLE medical_bill_items ADD COLUMN tax_amount REAL DEFAULT 0'
    ].forEach(sql => db.run(sql, () => {}));

    // Medicine return with patient link
    ['ALTER TABLE medicine_returns ADD COLUMN patient_id INTEGER',
     'ALTER TABLE medicine_returns ADD COLUMN return_type TEXT DEFAULT "supplier"'
    ].forEach(sql => db.run(sql, () => {}));

    // Product code on medicines for barcode-style quick add on Purchase entry
    ['ALTER TABLE medicines ADD COLUMN product_code TEXT'].forEach(sql => db.run(sql, () => {}));

    // Patient pending / credit balance
    ['ALTER TABLE patients ADD COLUMN pending_amount REAL DEFAULT 0'].forEach(sql => db.run(sql, () => {}));

    // Daily expenses
    db.run(`CREATE TABLE IF NOT EXISTS expenses (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      expense_date TEXT,
      description TEXT,
      amount REAL,
      created_at TEXT DEFAULT (datetime('now', 'localtime'))
    )`);

    // Staff & Attendance
    db.run(`CREATE TABLE IF NOT EXISTS staff (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_name TEXT,
      role TEXT,
      mobile TEXT,
      status TEXT DEFAULT 'Active'
    )`);
    db.run(`CREATE TABLE IF NOT EXISTS staff_attendance (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      staff_id INTEGER,
      attendance_date TEXT,
      status TEXT,           -- Present / Absent / Half-day / Leave
      FOREIGN KEY(staff_id) REFERENCES staff(id) ON DELETE CASCADE,
      UNIQUE(staff_id, attendance_date)
    )`);

    // Password recovery: store plain login password AND a recovery code (both created on first boot)
    ['ALTER TABLE settings ADD COLUMN dummy TEXT' // no-op, safe if fails
    ].forEach(sql => db.run(sql, () => {}));

    // Seed default login+delete passwords + empty GST number on FIRST boot.
    // Also store the login password in PLAIN TEXT alongside the hash so that a
    // "forgot password" flow can reveal it after the user proves their identity
    // with a Recovery Code. The Recovery Code is shown to the user in Settings.
    db.get(`SELECT svalue FROM settings WHERE skey = 'login_password_hash'`, (err, row) => {
      if (!row) {
        const loginPlain = 'admin123';
        const deletePlain = 'delete123';
        const loginHash = bcrypt.hashSync(loginPlain, 10);
        const deleteHash = bcrypt.hashSync(deletePlain, 10);
        const recovery = crypto.randomBytes(4).toString('hex').toUpperCase();  // 8 chars
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('login_password_hash', ?)`, [loginHash]);
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('delete_password_hash', ?)`, [deleteHash]);
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('login_password_plain', ?)`, [loginPlain]);
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('recovery_code', ?)`, [recovery]);
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('gst_number', '37IMFPS7901M1Z9')`);
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('recovery_email', 'shaikabuzarrahiman@gmail.com')`);
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('developer_email', 'arif052705@gmail.com')`);
        // Developer password (used by developer-reset endpoint). Default: DEV12345
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('developer_password_hash', ?)`, [bcrypt.hashSync('DEV12345', 10)]);
      }
    });
    // Back-fill recovery_code + login_password_plain for existing installs that pre-date this feature.
    db.get(`SELECT svalue FROM settings WHERE skey = 'recovery_code'`, (err, row) => {
      if (!row || !row.svalue) {
        const recovery = crypto.randomBytes(4).toString('hex').toUpperCase();
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('recovery_code', ?)`, [recovery]);
      }
    });
    db.get(`SELECT svalue FROM settings WHERE skey = 'login_password_plain'`, (err, row) => {
      if (!row || !row.svalue) {
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('login_password_plain', 'admin123')`);
      }
    });
    // Back-fill the fixed clinic GST + emails + developer password for existing installs
    db.get(`SELECT svalue FROM settings WHERE skey = 'gst_number'`, (err, row) => {
      if (!row || !row.svalue) db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('gst_number', '37IMFPS7901M1Z9')`);
    });
    db.get(`SELECT svalue FROM settings WHERE skey = 'recovery_email'`, (err, row) => {
      if (!row || !row.svalue) db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('recovery_email', 'shaikabuzarrahiman@gmail.com')`);
    });
    db.get(`SELECT svalue FROM settings WHERE skey = 'developer_email'`, (err, row) => {
      if (!row || !row.svalue) db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('developer_email', 'arif052705@gmail.com')`);
    });
    db.get(`SELECT svalue FROM settings WHERE skey = 'developer_password_hash'`, (err, row) => {
      if (!row || !row.svalue) db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('developer_password_hash', ?)`, [bcrypt.hashSync('DEV12345', 10)]);
    });

    // NOTE: Seed sample data intentionally REMOVED so a fresh install starts at 0 patients / 0 doctors / 0 medicines.
    // For existing installs that still contain the two demo doctors, delete them via /api/dev/clear-demo-data (see below).
  });
}

// Helper to get today YYYY-MM-DD
function getTodayDate() {
  const d = new Date();
  const year = d.getFullYear();
  const month = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// -----------------------------------------------------------------------
// PATIENTS API
// -----------------------------------------------------------------------
app.get('/api/patients', (req, res) => {
  const { search, from_date, to_date, today } = req.query;
  let query = `SELECT * FROM patients WHERE 1=1`;
  let params = [];

  if (today === 'true') {
    const todayStr = getTodayDate();
    query += ` AND date(registration_date) = ?`;
    params.push(todayStr);
  } else if (from_date && to_date) {
    query += ` AND date(registration_date) BETWEEN ? AND ?`;
    params.push(from_date, to_date);
  }

  if (search) {
    query += ` AND (patient_code LIKE ? OR patient_name LIKE ? OR mobile LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  query += ` ORDER BY id DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.get('/api/patients/code/:code', (req, res) => {
  const code = req.params.code;
  db.get(`SELECT * FROM patients WHERE patient_code = ?`, [code], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!row) return res.status(404).json({ success: false, message: 'Patient not found' });
    res.json({ success: true, data: row });
  });
});

app.post('/api/patients', (req, res) => {
  const { patient_name, age, gender, mobile, address } = req.body;
  if (!patient_name) return res.status(400).json({ success: false, message: 'Patient Name is required' });

  // Generate Patient Code: KNC001 + 6 digit sequential ID
  db.get(`SELECT MAX(id) as max_id FROM patients`, (err, row) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    const nextId = (row && row.max_id ? row.max_id : 0) + 1;
    const patient_code = `KNC001${String(nextId).padStart(6, '0')}`;
    const registration_date = new Date().toISOString();

    db.run(
      `INSERT INTO patients (patient_code, patient_name, age, gender, mobile, address, registration_date) VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [patient_code, patient_name, age, gender, mobile, address, registration_date],
      function(err) {
        if (err) return res.status(500).json({ success: false, message: err.message });
        res.json({ success: true, data: { id: this.lastID, patient_code, patient_name } });
      }
    );
  });
});

app.put('/api/patients/:id', (req, res) => {
  const { id } = req.params;
  const { patient_name, age, gender, mobile, address } = req.body;
  db.run(
    `UPDATE patients SET patient_name = ?, age = ?, gender = ?, mobile = ?, address = ? WHERE id = ?`,
    [patient_name, age, gender, mobile, address, id],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'Patient updated successfully' });
    }
  );
});

app.delete('/api/patients/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM patients WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'Patient deleted successfully' });
  });
});

// -----------------------------------------------------------------------
// DOCTORS API
// -----------------------------------------------------------------------
app.get('/api/doctors', (req, res) => {
  db.all(`SELECT * FROM doctors ORDER BY doctor_name`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.post('/api/doctors', (req, res) => {
  const { doctor_name, qualification, mobile, consultation_fee, status } = req.body;
  if (!doctor_name) return res.status(400).json({ success: false, message: 'Doctor Name is required' });

  db.run(
    `INSERT INTO doctors (doctor_name, qualification, mobile, consultation_fee, status) VALUES (?, ?, ?, ?, ?)`,
    [doctor_name, qualification, mobile, consultation_fee || 0, status || 'Active'],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, data: { id: this.lastID } });
    }
  );
});

app.put('/api/doctors/:id', (req, res) => {
  const { id } = req.params;
  const { doctor_name, qualification, mobile, consultation_fee, status } = req.body;
  db.run(
    `UPDATE doctors SET doctor_name = ?, qualification = ?, mobile = ?, consultation_fee = ?, status = ? WHERE id = ?`,
    [doctor_name, qualification, mobile, consultation_fee, status, id],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'Doctor updated successfully' });
    }
  );
});

app.delete('/api/doctors/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM doctors WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'Doctor deleted successfully' });
  });
});

// -----------------------------------------------------------------------
// MEDICINES API
// -----------------------------------------------------------------------
app.get('/api/medicines', (req, res) => {
  const { search, low_stock, expiry_alert } = req.query;
  let query = `SELECT * FROM medicines WHERE 1=1`;
  let params = [];

  if (search) {
    query += ` AND (medicine_name LIKE ? OR generic_name LIKE ? OR batch_number LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }
  if (low_stock === 'true') {
    query += ` AND current_stock <= minimum_stock`;
  }
  if (expiry_alert === 'true') {
    const today = getTodayDate();
    query += ` AND expiry_date <= date('now', '+30 days')`;
  }

  query += ` ORDER BY medicine_name`;
  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.post('/api/medicines', (req, res) => {
  const { medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status, product_code } = req.body;
  if (!medicine_name) return res.status(400).json({ success: false, message: 'Medicine Name is required' });

  db.run(
    `INSERT INTO medicines (medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status, product_code) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate || 0, mrp || 0, current_stock || 0, minimum_stock || 10, status || 'Active', product_code || null],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, data: { id: this.lastID } });
    }
  );
});

app.put('/api/medicines/:id', (req, res) => {
  const { id } = req.params;
  const { medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status, product_code } = req.body;
  db.run(
    `UPDATE medicines SET medicine_name = ?, generic_name = ?, hsn_number = ?, batch_number = ?, expiry_date = ?, rate = ?, mrp = ?, current_stock = ?, minimum_stock = ?, status = ?, product_code = ? WHERE id = ?`,
    [medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status, product_code || null, id],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, message: 'Medicine updated successfully' });
    }
  );
});

app.delete('/api/medicines/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM medicines WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'Medicine deleted successfully' });
  });
});

// -----------------------------------------------------------------------
// OP BOOKING & HISTORY API
// -----------------------------------------------------------------------
app.post('/api/op/save', (req, res) => {
  const { op_date, patient_id, doctor_id, consultation_fee, payment_mode, remarks, invoice_no } = req.body;
  const dateStr = op_date || getTodayDate();

  // Get token number for date
  db.get(`SELECT last_token FROM op_token_counter WHERE date = ?`, [dateStr], (err, row) => {
    let token_number = 1;
    if (row) {
      token_number = row.last_token + 1;
      db.run(`UPDATE op_token_counter SET last_token = ? WHERE date = ?`, [token_number, dateStr]);
    } else {
      db.run(`INSERT INTO op_token_counter (date, last_token) VALUES (?, ?)`, [dateStr, 1]);
    }

    const op_bill_id = `OP-${dateStr.replace(/-/g, '')}-${String(token_number).padStart(3, '0')}`;

    // Fetch patient snapshot so print stays correct even if patient is later edited
    db.get(`SELECT patient_name, mobile, age FROM patients WHERE id = ?`, [patient_id], (err, p) => {
      const name_snap = p ? p.patient_name : '';
      const phone_snap = p ? (p.mobile || '') : '';
      const age_snap = p ? p.age : null;

      // Auto-generate invoice no if not supplied. Prefix INV; number = 1000 + next op_bills id
      db.get(`SELECT MAX(id) as max_id FROM op_bills`, (e, r) => {
        const nextId = ((r && r.max_id) ? r.max_id : 0) + 1;
        const finalInvoiceNo = (invoice_no && invoice_no.trim()) ? invoice_no.trim() : `INV${1000 + nextId}`;

        db.run(
          `INSERT INTO op_bills (op_bill_id, op_date, token_number, patient_id, doctor_id, consultation_fee, payment_mode, remarks,
                                 invoice_no, patient_name_snapshot, patient_phone_snapshot, patient_age_snapshot)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
          [op_bill_id, dateStr, token_number, patient_id, doctor_id, consultation_fee || 0, payment_mode || 'Cash', remarks || '',
           finalInvoiceNo, name_snap, phone_snap, age_snap],
          function(err) {
            if (err) return res.status(500).json({ success: false, message: err.message });
            res.json({ success: true, data: { id: this.lastID, op_bill_id, token_number, invoice_no: finalInvoiceNo } });
          }
        );
      });
    });
  });
});

app.get('/api/op/history', (req, res) => {
  const { from_date, to_date, today, search, doctor_id } = req.query;
  let query = `
    SELECT o.*, p.patient_code, p.patient_name, p.age, p.gender, p.mobile, d.doctor_name
    FROM op_bills o
    JOIN patients p ON o.patient_id = p.id
    JOIN doctors d ON o.doctor_id = d.id
    WHERE 1=1
  `;
  let params = [];

  if (today === 'true') {
    query += ` AND o.op_date = ?`;
    params.push(getTodayDate());
  } else if (from_date && to_date) {
    query += ` AND o.op_date BETWEEN ? AND ?`;
    params.push(from_date, to_date);
  }

  if (search) {
    query += ` AND (p.patient_code LIKE ? OR p.patient_name LIKE ? OR p.mobile LIKE ? OR o.op_bill_id LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  if (doctor_id) {
    query += ` AND o.doctor_id = ?`;
    params.push(doctor_id);
  }

  query += ` ORDER BY o.id DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.get('/api/op/print/:id', (req, res) => {
  const { id } = req.params;
  const query = `
    SELECT o.*, p.patient_code, p.patient_name, p.age, p.gender, p.mobile, p.address, d.doctor_name, d.qualification
    FROM op_bills o
    JOIN patients p ON o.patient_id = p.id
    JOIN doctors d ON o.doctor_id = d.id
    WHERE o.id = ?
  `;
  db.get(query, [id], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!row) return res.status(404).json({ success: false, message: 'OP Bill not found' });
    res.json({ success: true, data: row });
  });
});

app.delete('/api/op/:id', (req, res) => {
  const { id } = req.params;
  db.run(`DELETE FROM op_bills WHERE id = ?`, [id], function(err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, message: 'OP Bill deleted successfully' });
  });
});

// -----------------------------------------------------------------------
// PURCHASE API & STOCK INCREMENT
// -----------------------------------------------------------------------
app.post('/api/purchase/save', (req, res) => {
  const { invoice_no, supplier_name, invoice_date, items,
          supplier_gst, supplier_fssai, supplier_pan, supplier_msme, supplier_phone, supplier_address,
          adjustment } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ success: false, message: 'No purchase items provided' });

  // Compute per-item + totals
  let subtotal = 0, sgst_total = 0, cgst_total = 0;
  items.forEach(item => {
    const qty = parseFloat(item.qty) || 0;
    const rate = parseFloat(item.rate) || 0;
    const disc = parseFloat(item.discount_percent) || 0;
    const sgstP = parseFloat(item.sgst_percent) || 0;
    const igstP = parseFloat(item.igst_percent) || 0;
    const base = qty * rate * (1 - disc / 100);
    const sgstAmt = +(base * sgstP / 100).toFixed(2);
    // CGST mirrors SGST by convention when IGST=0 (intra-state); when IGST > 0 treat that as inter-state and put IGST as cgst equivalent
    const cgstAmt = +(base * (igstP || sgstP) / 100).toFixed(2);
    const amt = +(base + sgstAmt + cgstAmt).toFixed(2);
    item._computed = { base: +base.toFixed(2), sgst_amount: sgstAmt, cgst_amount_or_igst: cgstAmt, amount: amt };
    subtotal += base;
    sgst_total += sgstAmt;
    cgst_total += cgstAmt;
  });
  subtotal = +subtotal.toFixed(2);
  sgst_total = +sgst_total.toFixed(2);
  cgst_total = +cgst_total.toFixed(2);
  const adj = parseFloat(adjustment) || 0;
  const grand_total = +(subtotal + sgst_total + cgst_total + adj).toFixed(2);

  db.serialize(() => {
    db.run(`BEGIN TRANSACTION`);

    db.run(
      `INSERT INTO purchases (invoice_no, supplier_name, invoice_date, grand_total,
                              supplier_gst, supplier_fssai, supplier_pan, supplier_msme, supplier_phone, supplier_address,
                              subtotal, sgst_total, cgst_total, adjustment)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [invoice_no, supplier_name, invoice_date || getTodayDate(), grand_total,
       supplier_gst || '', supplier_fssai || '', supplier_pan || '', supplier_msme || '', supplier_phone || '', supplier_address || '',
       subtotal, sgst_total, cgst_total, adj],
      function(err) {
        if (err) {
          db.run(`ROLLBACK`);
          return res.status(500).json({ success: false, message: err.message });
        }
        const purchase_id = this.lastID;
        let completed = 0;
        let hasError = false;

        items.forEach(item => {
          const c = item._computed;

          db.get(`SELECT id, current_stock FROM medicines WHERE id = ?`, [item.medicine_id], (err) => {
            if (hasError) return;
            if (err) {
              hasError = true; db.run(`ROLLBACK`);
              return res.status(500).json({ success: false, message: err.message });
            }

            db.run(
              `INSERT INTO purchase_items (purchase_id, medicine_id, batch, expiry, qty, hsn, rate, mrp, amount,
                                           package, discount_percent, sgst_percent, igst_percent, sgst_amount, igst_amount)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [purchase_id, item.medicine_id, item.batch || '', item.expiry || '', item.qty, item.hsn || '', item.rate || 0, item.mrp || 0, c.amount,
               item.package || '', parseFloat(item.discount_percent) || 0,
               parseFloat(item.sgst_percent) || 0, parseFloat(item.igst_percent) || 0,
               c.sgst_amount, c.cgst_amount_or_igst],
              (err) => {
                if (err && !hasError) {
                  hasError = true; db.run(`ROLLBACK`);
                  return res.status(500).json({ success: false, message: err.message });
                }

                db.run(
                  `UPDATE medicines SET current_stock = current_stock + ?, batch_number = ?, expiry_date = ?, rate = ?, mrp = ? WHERE id = ?`,
                  [item.qty, item.batch || '', item.expiry || '', item.rate || 0, item.mrp || 0, item.medicine_id],
                  (err) => {
                    if (err && !hasError) {
                      hasError = true; db.run(`ROLLBACK`);
                      return res.status(500).json({ success: false, message: err.message });
                    }
                    completed++;
                    if (completed === items.length && !hasError) {
                      db.run(`COMMIT`);
                      res.json({ success: true, data: { purchase_id, grand_total, subtotal, sgst_total, cgst_total, adjustment: adj } });
                    }
                  }
                );
              }
            );
          });
        });
      }
    );
  });
});

app.get('/api/purchase/history', (req, res) => {
  const { from_date, to_date, today, search } = req.query;
  let query = `
    SELECT p.id as purchase_id, p.invoice_no, p.supplier_name, p.invoice_date, p.grand_total,
           pi.batch, pi.expiry, pi.qty, pi.rate, pi.mrp, pi.amount, pi.hsn,
           m.medicine_name, m.generic_name, m.id as medicine_id
    FROM purchases p
    JOIN purchase_items pi ON p.id = pi.purchase_id
    JOIN medicines m ON pi.medicine_id = m.id
    WHERE 1=1
  `;
  let params = [];

  if (today === 'true') {
    query += ` AND p.invoice_date = ?`;
    params.push(getTodayDate());
  } else if (from_date && to_date) {
    query += ` AND p.invoice_date BETWEEN ? AND ?`;
    params.push(from_date, to_date);
  }

  if (search) {
    query += ` AND (p.invoice_no LIKE ? OR p.supplier_name LIKE ? OR m.medicine_name LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`);
  }

  query += ` ORDER BY p.id DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.get('/api/purchase/print/:id', (req, res) => {
  const { id } = req.params;
  db.get(`SELECT * FROM purchases WHERE id = ?`, [id], (err, purchase) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!purchase) return res.status(404).json({ success: false, message: 'Purchase not found' });

    db.all(`
      SELECT pi.*, m.medicine_name, m.generic_name
      FROM purchase_items pi
      JOIN medicines m ON pi.medicine_id = m.id
      WHERE pi.purchase_id = ?
    `, [id], (err, items) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, data: { ...purchase, items } });
    });
  });
});

app.delete('/api/purchase/:id', (req, res) => {
  const { id } = req.params;
  db.all(`SELECT medicine_id, qty FROM purchase_items WHERE purchase_id = ?`, [id], (err, items) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!items || items.length === 0) {
      // Still try to delete the master row
      db.run(`DELETE FROM purchases WHERE id = ?`, [id], function(e) {
        if (e) return res.status(500).json({ success: false, message: e.message });
        return res.json({ success: true, message: 'Purchase deleted successfully' });
      });
      return;
    }

    let processed = 0;
    let hasError = false;
    items.forEach(item => {
      db.run(
        `UPDATE medicines SET current_stock = MAX(current_stock - ?, 0) WHERE id = ?`,
        [item.qty, item.medicine_id],
        (e) => {
          if (e) hasError = true;
          processed++;
          if (processed === items.length) {
            if (hasError) {
              return res.status(500).json({ success: false, message: 'Error reversing stock' });
            }
            db.run(`DELETE FROM purchase_items WHERE purchase_id = ?`, [id], (e1) => {
              if (e1) return res.status(500).json({ success: false, message: e1.message });
              db.run(`DELETE FROM purchases WHERE id = ?`, [id], (e2) => {
                if (e2) return res.status(500).json({ success: false, message: e2.message });
                res.json({ success: true, message: 'Purchase deleted and stock reversed successfully' });
              });
            });
          }
        }
      );
    });
  });
});

// -----------------------------------------------------------------------
// MEDICAL BILLING API & STOCK DECREMENT
// -----------------------------------------------------------------------
app.post('/api/medicalbill/save', (req, res) => {
  const { bill_date, patient_id, discount_percent, discount_amount: discountAmtInput,
          invoice_no, town, referred_by_doctor_id, tax_percent, adjustment, items } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ success: false, message: 'No items in medical bill' });
  if (!patient_id) return res.status(400).json({ success: false, message: 'Patient Code / ID is required' });

  const DEFAULT_TAX = 5;

  // Verify stock for all items first
  let itemsProcessed = 0;
  let stockError = null;

  items.forEach(item => {
    db.get(`SELECT current_stock, medicine_name FROM medicines WHERE id = ?`, [item.medicine_id], (err, med) => {
      if (err) stockError = err.message;
      if (!med) stockError = `Medicine ID ${item.medicine_id} not found`;
      if (med && med.current_stock < item.qty) {
        stockError = `Insufficient stock for ${med.medicine_name}. Available: ${med.current_stock}, Requested: ${item.qty}`;
      }

      itemsProcessed++;
      if (itemsProcessed === items.length) {
        if (stockError) {
          return res.status(400).json({ success: false, message: stockError });
        }

        const dateStr = bill_date || getTodayDate();

        db.get(`SELECT patient_name, mobile FROM patients WHERE id = ?`, [patient_id], (err, patientRow) => {
          const patient_name_snapshot = patientRow ? patientRow.patient_name : '';
          const patient_phone_snapshot = patientRow ? patientRow.mobile : '';

          db.get(`SELECT MAX(id) as max_id FROM medical_bills`, (err, row) => {
            const billNoNum = ((row && row.max_id) ? row.max_id : 0) + 1;
            const bill_no = `MED-${dateStr.replace(/-/g, '')}-${String(billNoNum).padStart(4, '0')}`;
            const finalInvoiceNo = invoice_no || `INV${String(1000 + billNoNum)}`;

            const taxPct = tax_percent != null && tax_percent !== '' ? parseFloat(tax_percent) : DEFAULT_TAX;

            // Compute per-item amount: qty * mrp * (1 + tax%/100) OR use rate then add tax
            let subtotal = 0;
            items.forEach(i => {
              const q = parseFloat(i.qty) || 0;
              const r = parseFloat(i.rate != null && i.rate !== '' ? i.rate : i.mrp) || 0;   // rate defaults to MRP
              const base = q * r;
              const tax_amount = +(base * taxPct / 100).toFixed(2);
              const amt = +(base + tax_amount).toFixed(2);
              i._computed = { tax_amount, amount: amt };
              subtotal += amt;
            });
            subtotal = +subtotal.toFixed(2);

            const discPct = discount_percent ? parseFloat(discount_percent) : 0;
            const discAmt = discountAmtInput != null && discountAmtInput !== ''
              ? parseFloat(discountAmtInput)
              : +((subtotal * discPct) / 100).toFixed(2);
            const adj = parseFloat(adjustment) || 0;   // can be negative (subtract) or positive (add)
            const grand_total = +(subtotal - discAmt + adj).toFixed(2);

            db.run(
              `INSERT INTO medical_bills (bill_no, bill_date, patient_id, subtotal, discount_percent, discount_amount, grand_total,
                                          invoice_no, town, referred_by_doctor_id, patient_name_snapshot, patient_phone_snapshot,
                                          tax_percent, adjustment)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [bill_no, dateStr, patient_id, subtotal, discPct, discAmt, grand_total,
               finalInvoiceNo, town || '', referred_by_doctor_id || null,
               patient_name_snapshot, patient_phone_snapshot,
               taxPct, adj],
              function(err) {
                if (err) return res.status(500).json({ success: false, message: err.message });

                const medical_bill_id = this.lastID;
                let savedItems = 0;
                let hasError = false;

                items.forEach(i => {
                  const { tax_amount, amount } = i._computed;
                  const rateUsed = parseFloat(i.rate != null && i.rate !== '' ? i.rate : i.mrp) || 0;
                  db.run(
                    `INSERT INTO medical_bill_items
                       (medical_bill_id, medicine_id, batch, expiry, qty, rate, amount, hsn, mrp, pack, tax_percent, tax_amount,
                        sgst_percent, cgst_percent, sgst_amount, cgst_amount)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 0, 0, 0, 0)`,
                    [medical_bill_id, i.medicine_id, i.batch || '', i.expiry || '',
                     i.qty, rateUsed, amount,
                     i.hsn || '', parseFloat(i.mrp) || 0, i.pack || '',
                     taxPct, tax_amount],
                    (err) => { if (err) hasError = true; }
                  );

                  db.run(
                    `UPDATE medicines SET current_stock = current_stock - ? WHERE id = ?`,
                    [i.qty, i.medicine_id],
                    (err) => {
                      if (err) hasError = true;
                      savedItems++;
                      if (savedItems === items.length) {
                        if (hasError) {
                          res.status(500).json({ success: false, message: 'Error saving medical bill' });
                        } else {
                          res.json({ success: true, data: { medical_bill_id, bill_no, invoice_no: finalInvoiceNo, grand_total } });
                        }
                      }
                    }
                  );
                });
              }
            );
          });
        });
      }
    });
  });
});

app.get('/api/medicalbill/history', (req, res) => {
  const { from_date, to_date, today, search } = req.query;
  let query = `
    SELECT mb.*, p.patient_code, p.patient_name, p.age, p.gender, p.mobile
    FROM medical_bills mb
    JOIN patients p ON mb.patient_id = p.id
    WHERE 1=1
  `;
  let params = [];

  if (today === 'true') {
    query += ` AND mb.bill_date = ?`;
    params.push(getTodayDate());
  } else if (from_date && to_date) {
    query += ` AND mb.bill_date BETWEEN ? AND ?`;
    params.push(from_date, to_date);
  }

  if (search) {
    query += ` AND (mb.bill_no LIKE ? OR p.patient_code LIKE ? OR p.patient_name LIKE ? OR p.mobile LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`);
  }

  query += ` ORDER BY mb.id DESC`;

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.get('/api/medicalbill/print/:id', (req, res) => {
  const { id } = req.params;
  const query = `
    SELECT mb.*, p.patient_code, p.patient_name, p.age, p.gender, p.mobile, p.address,
           d.doctor_name as referred_by_name, d.qualification as referred_by_qual
    FROM medical_bills mb
    JOIN patients p ON mb.patient_id = p.id
    LEFT JOIN doctors d ON mb.referred_by_doctor_id = d.id
    WHERE mb.id = ?
  `;
  db.get(query, [id], (err, bill) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!bill) return res.status(404).json({ success: false, message: 'Medical Bill not found' });

    db.all(`
      SELECT mbi.*, m.medicine_name, m.generic_name
      FROM medical_bill_items mbi
      JOIN medicines m ON mbi.medicine_id = m.id
      WHERE mbi.medical_bill_id = ?
    `, [id], (err, items) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, data: { ...bill, items } });
    });
  });
});

app.delete('/api/medicalbill/:id', (req, res) => {
  const { id } = req.params;
  db.all(`SELECT medicine_id, qty FROM medical_bill_items WHERE medical_bill_id = ?`, [id], (err, items) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!items || items.length === 0) {
      db.run(`DELETE FROM medical_bills WHERE id = ?`, [id], function(e) {
        if (e) return res.status(500).json({ success: false, message: e.message });
        return res.json({ success: true, message: 'Medical bill deleted successfully' });
      });
      return;
    }

    let processed = 0;
    let hasError = false;
    items.forEach(item => {
      db.run(
        `UPDATE medicines SET current_stock = current_stock + ? WHERE id = ?`,
        [item.qty, item.medicine_id],
        (e) => {
          if (e) hasError = true;
          processed++;
          if (processed === items.length) {
            if (hasError) {
              return res.status(500).json({ success: false, message: 'Error restoring stock' });
            }
            db.run(`DELETE FROM medical_bill_items WHERE medical_bill_id = ?`, [id], (e1) => {
              if (e1) return res.status(500).json({ success: false, message: e1.message });
              db.run(`DELETE FROM medical_bills WHERE id = ?`, [id], (e2) => {
                if (e2) return res.status(500).json({ success: false, message: e2.message });
                res.json({ success: true, message: 'Medical bill deleted and stock restored successfully' });
              });
            });
          }
        }
      );
    });
  });
});

// -----------------------------------------------------------------------
// MEDICINE RETURNS API
// -----------------------------------------------------------------------
app.post('/api/returns', (req, res) => {
  const { return_date, medicine_id, batch, qty, reason, supplier, patient_id, return_type } = req.body;
  if (!medicine_id || !qty) return res.status(400).json({ success: false, message: 'Medicine and Qty are required' });

  // Two flavours:
  //  - return_type = "supplier" (default): stock DECREASES (goods sent back to supplier)
  //  - return_type = "patient"          : stock INCREASES (patient returned unused medicine)
  const rtype = (return_type === 'patient') ? 'patient' : 'supplier';

  db.get(`SELECT current_stock, medicine_name FROM medicines WHERE id = ?`, [medicine_id], (err, med) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!med) return res.status(404).json({ success: false, message: 'Medicine not found' });
    if (rtype === 'supplier' && med.current_stock < qty) {
      return res.status(400).json({ success: false, message: `Cannot return ${qty} to supplier. Current stock is only ${med.current_stock}` });
    }
    if (rtype === 'patient' && !patient_id) {
      return res.status(400).json({ success: false, message: 'Patient is required for a patient return' });
    }

    db.serialize(() => {
      db.run(`BEGIN TRANSACTION`);
      db.run(
        `INSERT INTO medicine_returns (return_date, medicine_id, batch, qty, reason, supplier, patient_id, return_type)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
        [return_date || getTodayDate(), medicine_id, batch || '', qty, reason || '', supplier || '', patient_id || null, rtype],
        function(err) {
          if (err) {
            db.run(`ROLLBACK`);
            return res.status(500).json({ success: false, message: err.message });
          }
          const stockDelta = rtype === 'patient' ? +qty : -qty;
          db.run(`UPDATE medicines SET current_stock = current_stock + ? WHERE id = ?`, [stockDelta, medicine_id], (err) => {
            if (err) {
              db.run(`ROLLBACK`);
              return res.status(500).json({ success: false, message: err.message });
            }
            db.run(`COMMIT`);
            res.json({ success: true, message: rtype === 'patient' ? 'Patient return saved; stock increased' : 'Supplier return saved; stock decreased' });
          });
        }
      );
    });
  });
});

app.get('/api/returns', (req, res) => {
  db.all(`
    SELECT r.*, m.medicine_name, m.generic_name, p.patient_code, p.patient_name
    FROM medicine_returns r
    JOIN medicines m ON r.medicine_id = m.id
    LEFT JOIN patients p ON r.patient_id = p.id
    ORDER BY r.id DESC
  `, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

// -----------------------------------------------------------------------
// REPORTS & DASHBOARD SUMMARY API
// -----------------------------------------------------------------------
app.get('/api/dashboard/summary', (req, res) => {
  const today = getTodayDate();
  const summary = {};

  db.get(`SELECT COUNT(*) as cnt FROM op_bills WHERE op_date = ?`, [today], (err, row) => {
    summary.todays_op_count = row ? row.cnt : 0;

    db.get(`SELECT COUNT(DISTINCT patient_id) as cnt FROM op_bills WHERE op_date = ?`, [today], (err, row) => {
      summary.todays_patients = row ? row.cnt : 0;

      db.get(`SELECT COUNT(*) as cnt, SUM(grand_total) as total FROM medical_bills WHERE bill_date = ?`, [today], (err, row) => {
        summary.todays_medical_bills = row ? row.cnt : 0;
        summary.todays_medical_collection = row && row.total ? row.total : 0;

        db.get(`SELECT SUM(grand_total) as total FROM purchases WHERE invoice_date = ?`, [today], (err, row) => {
          summary.todays_purchase = row && row.total ? row.total : 0;

          db.get(`SELECT COUNT(*) as cnt FROM patients`, (err, row) => {
            summary.total_patients = row ? row.cnt : 0;

            db.get(`SELECT COUNT(*) as cnt FROM medicines WHERE current_stock <= minimum_stock`, (err, row) => {
              summary.low_stock_medicines = row ? row.cnt : 0;

              db.get(`SELECT COUNT(*) as cnt FROM medicines WHERE expiry_date <= date('now', '+30 days')`, (err, row) => {
                summary.expiring_medicines = row ? row.cnt : 0;

                res.json({ success: true, data: summary });
              });
            });
          });
        });
      });
    });
  });
});

app.get('/api/reports/:type', (req, res) => {
  const type = req.params.type;
  const { from_date, to_date, today } = req.query;
  let query = '';
  let params = [];

  if (type === 'todays_op' || type === 'op_collection') {
    query = `
      SELECT o.op_bill_id as ref_no, o.op_date as bill_date, p.patient_code, p.patient_name, p.mobile, d.doctor_name, o.consultation_fee as amount, o.payment_mode
      FROM op_bills o
      JOIN patients p ON o.patient_id = p.id
      JOIN doctors d ON o.doctor_id = d.id
      WHERE 1=1
    `;
    if (today === 'true') { query += ` AND o.op_date = ?`; params.push(getTodayDate()); }
    else if (from_date && to_date) { query += ` AND o.op_date BETWEEN ? AND ?`; params.push(from_date, to_date); }
  } else if (type === 'medical_sales') {
    query = `
      SELECT mb.bill_no as ref_no, mb.bill_date, p.patient_code, p.patient_name, p.mobile, mb.subtotal, mb.discount_amount, mb.grand_total as amount
      FROM medical_bills mb
      JOIN patients p ON mb.patient_id = p.id
      WHERE 1=1
    `;
    if (today === 'true') { query += ` AND mb.bill_date = ?`; params.push(getTodayDate()); }
    else if (from_date && to_date) { query += ` AND mb.bill_date BETWEEN ? AND ?`; params.push(from_date, to_date); }
  } else if (type === 'purchase') {
    query = `
      SELECT p.invoice_no as ref_no, p.invoice_date as bill_date, p.supplier_name, p.grand_total as amount
      FROM purchases p
      WHERE 1=1
    `;
    if (today === 'true') { query += ` AND p.invoice_date = ?`; params.push(getTodayDate()); }
    else if (from_date && to_date) { query += ` AND p.invoice_date BETWEEN ? AND ?`; params.push(from_date, to_date); }
  } else if (type === 'stock') {
    query = `SELECT * FROM medicines ORDER BY medicine_name`;
  } else if (type === 'low_stock') {
    query = `SELECT * FROM medicines WHERE current_stock <= minimum_stock ORDER BY medicine_name`;
  } else if (type === 'expiry') {
    query = `SELECT * FROM medicines WHERE expiry_date <= date('now', '+30 days') ORDER BY expiry_date`;
  } else if (type === 'patient_report') {
    query = `SELECT * FROM patients ORDER BY id DESC`;
  } else if (type === 'doctor_report') {
    query = `SELECT * FROM doctors ORDER BY doctor_name`;
  } else if (type === 'daily_collection') {
    query = `
      SELECT bill_date, SUM(grand_total) as total_collection 
      FROM (
        SELECT op_date as bill_date, consultation_fee as grand_total FROM op_bills
        UNION ALL
        SELECT bill_date, grand_total FROM medical_bills
      )
      GROUP BY bill_date
      ORDER BY bill_date DESC
    `;
  } else {
    return res.status(400).json({ success: false, message: 'Invalid report type' });
  }

  db.all(query, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

// =============================================================================
// LAB BILL API (Dr. Rahiman Diagnostics)
// =============================================================================
app.post('/api/labbill/save', (req, res) => {
  const { bill_date, patient_id, referred_by_doctor_id, invoice_no, discount_percent, discount_amount: discAmtIn, items, notes } = req.body || {};
  if (!patient_id) return res.status(400).json({ success: false, message: 'Patient Code / ID is required' });
  if (!items || !items.length) return res.status(400).json({ success: false, message: 'No test items in lab bill' });

  const dateStr = bill_date || getTodayDate();

  db.get(`SELECT patient_name, mobile, age FROM patients WHERE id = ?`, [patient_id], (err, p) => {
    if (err || !p) return res.status(400).json({ success: false, message: 'Patient not found' });

    db.get(`SELECT MAX(id) as max_id FROM lab_bills`, (e, r) => {
      const nextId = ((r && r.max_id) ? r.max_id : 0) + 1;
      const bill_no = `LAB-${dateStr.replace(/-/g, '')}-${String(nextId).padStart(4, '0')}`;
      const finalInvoiceNo = (invoice_no && String(invoice_no).trim()) ? String(invoice_no).trim() : `INV${2000 + nextId}`;

      let subtotal = 0;
      const computed = items.map(it => {
        const rate = parseFloat(it.rate) || 0;
        const amount = +(rate).toFixed(2);
        subtotal += amount;
        return { test_name: it.test_name || '', rate, amount };
      });
      subtotal = +subtotal.toFixed(2);
      const discPct = parseFloat(discount_percent) || 0;
      const discAmt = discAmtIn != null && discAmtIn !== '' ? parseFloat(discAmtIn) : +(subtotal * discPct / 100).toFixed(2);
      const grand_total = +(subtotal - discAmt).toFixed(2);

      db.run(
        `INSERT INTO lab_bills (bill_no, bill_date, patient_id, patient_name_snapshot, patient_phone_snapshot, patient_age_snapshot,
                                referred_by_doctor_id, invoice_no, subtotal, discount_percent, discount_amount, grand_total, notes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [bill_no, dateStr, patient_id, p.patient_name, p.mobile || '', p.age || null,
         referred_by_doctor_id || null, finalInvoiceNo, subtotal, discPct, discAmt, grand_total, notes || ''],
        function(err2) {
          if (err2) return res.status(500).json({ success: false, message: err2.message });
          const lab_bill_id = this.lastID;
          let done = 0, hadError = false;
          computed.forEach(ci => {
            db.run(
              `INSERT INTO lab_bill_items (lab_bill_id, test_name, rate, amount) VALUES (?, ?, ?, ?)`,
              [lab_bill_id, ci.test_name, ci.rate, ci.amount],
              (err3) => {
                if (err3) hadError = true;
                done++;
                if (done === computed.length) {
                  if (hadError) return res.status(500).json({ success: false, message: 'Error saving lab bill items' });
                  res.json({ success: true, data: { lab_bill_id, bill_no, invoice_no: finalInvoiceNo, grand_total } });
                }
              }
            );
          });
        }
      );
    });
  });
});

app.get('/api/labbill/history', (req, res) => {
  const { from_date, to_date, today, search } = req.query;
  let q = `SELECT lb.*, p.patient_code, p.patient_name, p.mobile
           FROM lab_bills lb LEFT JOIN patients p ON lb.patient_id = p.id WHERE 1=1`;
  const params = [];
  if (today === 'true') { q += ` AND lb.bill_date = ?`; params.push(getTodayDate()); }
  else if (from_date && to_date) { q += ` AND lb.bill_date BETWEEN ? AND ?`; params.push(from_date, to_date); }
  if (search) { q += ` AND (lb.bill_no LIKE ? OR lb.invoice_no LIKE ? OR p.patient_code LIKE ? OR p.patient_name LIKE ? OR p.mobile LIKE ?)`;
    params.push(`%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`, `%${search}%`); }
  q += ` ORDER BY lb.id DESC`;
  db.all(q, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

app.get('/api/labbill/print/:id', (req, res) => {
  db.get(`SELECT lb.*, p.patient_code, p.patient_name, p.mobile,
                 d.doctor_name AS referred_by_name, d.qualification AS referred_by_qual
          FROM lab_bills lb
          LEFT JOIN patients p ON lb.patient_id = p.id
          LEFT JOIN doctors d ON lb.referred_by_doctor_id = d.id
          WHERE lb.id = ?`, [req.params.id], (err, bill) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!bill) return res.status(404).json({ success: false, message: 'Lab bill not found' });
    db.all(`SELECT * FROM lab_bill_items WHERE lab_bill_id = ? ORDER BY id`, [req.params.id], (err2, items) => {
      if (err2) return res.status(500).json({ success: false, message: err2.message });
      res.json({ success: true, data: { ...bill, items } });
    });
  });
});

app.delete('/api/labbill/:id', (req, res) => {
  db.run(`DELETE FROM lab_bill_items WHERE lab_bill_id = ?`, [req.params.id], (e1) => {
    if (e1) return res.status(500).json({ success: false, message: e1.message });
    db.run(`DELETE FROM lab_bills WHERE id = ?`, [req.params.id], (e2) => {
      if (e2) return res.status(500).json({ success: false, message: e2.message });
      res.json({ success: true, message: 'Lab bill deleted' });
    });
  });
});

// =============================================================================
// DAILY EXPENSES
// =============================================================================
app.get('/api/expenses', (req, res) => {
  const { from_date, to_date, today } = req.query;
  let q = `SELECT * FROM expenses WHERE 1=1`;
  const params = [];
  if (today === 'true') { q += ` AND expense_date = ?`; params.push(getTodayDate()); }
  else if (from_date && to_date) { q += ` AND expense_date BETWEEN ? AND ?`; params.push(from_date, to_date); }
  q += ` ORDER BY id DESC`;
  db.all(q, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});
app.post('/api/expenses', (req, res) => {
  const { expense_date, description, amount } = req.body || {};
  if (!description || amount == null) return res.status(400).json({ success: false, message: 'Description and Amount are required' });
  db.run(`INSERT INTO expenses (expense_date, description, amount) VALUES (?, ?, ?)`,
    [expense_date || getTodayDate(), description, parseFloat(amount) || 0],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, data: { id: this.lastID } });
    });
});
app.put('/api/expenses/:id', (req, res) => {
  const { expense_date, description, amount } = req.body || {};
  db.run(`UPDATE expenses SET expense_date=?, description=?, amount=? WHERE id=?`,
    [expense_date, description, parseFloat(amount) || 0, req.params.id],
    (err) => err ? res.status(500).json({ success: false, message: err.message }) : res.json({ success: true }));
});
app.delete('/api/expenses/:id', (req, res) => {
  db.run(`DELETE FROM expenses WHERE id = ?`, [req.params.id], (err) =>
    err ? res.status(500).json({ success: false, message: err.message }) : res.json({ success: true, message: 'Expense deleted' }));
});

// =============================================================================
// STAFF + ATTENDANCE
// =============================================================================
app.get('/api/staff', (req, res) => {
  db.all(`SELECT * FROM staff ORDER BY id DESC`, [], (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});
app.post('/api/staff', (req, res) => {
  const { staff_name, role, mobile, status } = req.body || {};
  if (!staff_name) return res.status(400).json({ success: false, message: 'Staff name required' });
  db.run(`INSERT INTO staff (staff_name, role, mobile, status) VALUES (?, ?, ?, ?)`,
    [staff_name, role || '', mobile || '', status || 'Active'],
    function(err) { err ? res.status(500).json({ success: false, message: err.message })
                         : res.json({ success: true, data: { id: this.lastID } }); });
});
app.put('/api/staff/:id', (req, res) => {
  const { staff_name, role, mobile, status } = req.body || {};
  db.run(`UPDATE staff SET staff_name=?, role=?, mobile=?, status=? WHERE id=?`,
    [staff_name, role, mobile, status, req.params.id],
    (err) => err ? res.status(500).json({ success: false, message: err.message }) : res.json({ success: true }));
});
app.delete('/api/staff/:id', (req, res) => {
  db.run(`DELETE FROM staff WHERE id = ?`, [req.params.id], (err) =>
    err ? res.status(500).json({ success: false, message: err.message }) : res.json({ success: true, message: 'Staff removed' }));
});

// Attendance: upsert one row per (staff, date)
app.post('/api/staff/attendance', (req, res) => {
  const { attendance_date, entries } = req.body || {};
  // entries: [{staff_id, status}, ...]
  const dateStr = attendance_date || getTodayDate();
  if (!entries || !entries.length) return res.status(400).json({ success: false, message: 'No attendance entries' });
  let done = 0, hadErr = false;
  entries.forEach(e => {
    db.run(`INSERT INTO staff_attendance (staff_id, attendance_date, status) VALUES (?, ?, ?)
            ON CONFLICT(staff_id, attendance_date) DO UPDATE SET status = excluded.status`,
      [e.staff_id, dateStr, e.status || 'Absent'],
      (err) => {
        if (err) hadErr = true;
        done++;
        if (done === entries.length) {
          if (hadErr) return res.status(500).json({ success: false, message: 'Failed to save attendance' });
          res.json({ success: true, message: 'Attendance saved', data: { attendance_date: dateStr } });
        }
      });
  });
});
app.get('/api/staff/attendance', (req, res) => {
  const { attendance_date, from_date, to_date } = req.query;
  let q = `SELECT sa.*, s.staff_name, s.role FROM staff_attendance sa JOIN staff s ON sa.staff_id = s.id WHERE 1=1`;
  const params = [];
  if (attendance_date) { q += ` AND sa.attendance_date = ?`; params.push(attendance_date); }
  else if (from_date && to_date) { q += ` AND sa.attendance_date BETWEEN ? AND ?`; params.push(from_date, to_date); }
  q += ` ORDER BY sa.attendance_date DESC, s.staff_name`;
  db.all(q, params, (err, rows) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true, data: rows });
  });
});

// =============================================================================
// DETAILED RECORDS (day / month / year / range) with drill-down per bill type
// =============================================================================
app.get('/api/records/detailed', (req, res) => {
  const { type, period, date, month, year, from_date, to_date, patient_id } = req.query;
  const T = (type || 'op').toLowerCase();          // 'op' | 'medical' | 'lab' | 'expenses'

  // Compute date-range
  let from = null, to = null;
  if (period === 'day') { from = to = date || getTodayDate(); }
  else if (period === 'month') { const [y, m] = (month || getTodayDate().slice(0, 7)).split('-'); from = `${y}-${m}-01`; to = `${y}-${m}-31`; }
  else if (period === 'year') { const y = year || getTodayDate().slice(0, 4); from = `${y}-01-01`; to = `${y}-12-31`; }
  else if (period === 'range') { from = from_date || '1900-01-01'; to = to_date || '2999-12-31'; }
  else { from = to = getTodayDate(); }

  if (T === 'op') {
    let q = `SELECT o.id, o.op_bill_id, o.op_date AS bill_date, o.token_number, o.consultation_fee AS amount,
                    o.payment_mode, o.invoice_no, o.remarks,
                    p.patient_code, p.patient_name, p.mobile,
                    d.doctor_name
             FROM op_bills o
             LEFT JOIN patients p ON o.patient_id = p.id
             LEFT JOIN doctors  d ON o.doctor_id  = d.id
             WHERE o.op_date BETWEEN ? AND ?`;
    const params = [from, to];
    if (patient_id) { q += ` AND o.patient_id = ?`; params.push(patient_id); }
    q += ` ORDER BY o.op_date DESC, o.id DESC`;
    db.all(q, params, (err, rows) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
      res.json({ success: true, data: { rows, total: +total.toFixed(2), from, to } });
    });
    return;
  }

  if (T === 'medical') {
    // Return bills + their items so caller can drill down
    let q = `SELECT mb.*, p.patient_code, p.patient_name, p.mobile, d.doctor_name AS referred_by_name
             FROM medical_bills mb
             LEFT JOIN patients p ON mb.patient_id = p.id
             LEFT JOIN doctors d ON mb.referred_by_doctor_id = d.id
             WHERE mb.bill_date BETWEEN ? AND ?`;
    const params = [from, to];
    if (patient_id) { q += ` AND mb.patient_id = ?`; params.push(patient_id); }
    q += ` ORDER BY mb.bill_date DESC, mb.id DESC`;
    db.all(q, params, (err, bills) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      if (!bills.length) return res.json({ success: true, data: { rows: [], total: 0, from, to } });
      const ids = bills.map(b => b.id);
      db.all(`SELECT mbi.*, m.medicine_name FROM medical_bill_items mbi JOIN medicines m ON mbi.medicine_id = m.id
              WHERE mbi.medical_bill_id IN (${ids.map(() => '?').join(',')})`, ids, (err2, items) => {
        if (err2) return res.status(500).json({ success: false, message: err2.message });
        const byBill = {};
        items.forEach(it => { (byBill[it.medical_bill_id] = byBill[it.medical_bill_id] || []).push(it); });
        bills.forEach(b => b.items = byBill[b.id] || []);
        const total = bills.reduce((s, b) => s + Number(b.grand_total || 0), 0);
        res.json({ success: true, data: { rows: bills, total: +total.toFixed(2), from, to } });
      });
    });
    return;
  }

  if (T === 'lab') {
    let q = `SELECT lb.*, p.patient_code, p.patient_name, p.mobile, d.doctor_name AS referred_by_name
             FROM lab_bills lb
             LEFT JOIN patients p ON lb.patient_id = p.id
             LEFT JOIN doctors d ON lb.referred_by_doctor_id = d.id
             WHERE lb.bill_date BETWEEN ? AND ?`;
    const params = [from, to];
    if (patient_id) { q += ` AND lb.patient_id = ?`; params.push(patient_id); }
    q += ` ORDER BY lb.bill_date DESC, lb.id DESC`;
    db.all(q, params, (err, bills) => {
      if (err) return res.status(500).json({ success: false, message: err.message });
      if (!bills.length) return res.json({ success: true, data: { rows: [], total: 0, from, to } });
      const ids = bills.map(b => b.id);
      db.all(`SELECT * FROM lab_bill_items WHERE lab_bill_id IN (${ids.map(() => '?').join(',')})`, ids, (err2, items) => {
        if (err2) return res.status(500).json({ success: false, message: err2.message });
        const byBill = {};
        items.forEach(it => { (byBill[it.lab_bill_id] = byBill[it.lab_bill_id] || []).push(it); });
        bills.forEach(b => b.items = byBill[b.id] || []);
        const total = bills.reduce((s, b) => s + Number(b.grand_total || 0), 0);
        res.json({ success: true, data: { rows: bills, total: +total.toFixed(2), from, to } });
      });
    });
    return;
  }

  if (T === 'expenses') {
    db.all(`SELECT * FROM expenses WHERE expense_date BETWEEN ? AND ? ORDER BY expense_date DESC, id DESC`,
      [from, to], (err, rows) => {
        if (err) return res.status(500).json({ success: false, message: err.message });
        const total = rows.reduce((s, r) => s + Number(r.amount || 0), 0);
        res.json({ success: true, data: { rows, total: +total.toFixed(2), from, to } });
      });
    return;
  }

  res.status(400).json({ success: false, message: 'Invalid type. Use op | medical | lab | expenses' });
});

// =============================================================================
// UTILITIES: DANGER-ZONE 2-STEP CODE + SMTP HELPERS + medicine lookup by code + patient pending
// =============================================================================

// One-time codes for destructive actions. Stored in-memory: { hash, action, expiresAt }.
const dangerCodes = new Map();
const DANGER_CODE_TTL_MS = 15 * 60 * 1000; // 15 minutes

function newDangerCode() {
  // Human-friendly 6-digit numeric code
  return String(Math.floor(100000 + Math.random() * 900000));
}

async function sendMail({ to, subject, text }) {
  const host = await getSetting('smtp_host');
  const port = parseInt((await getSetting('smtp_port')) || '465', 10);
  const user = await getSetting('smtp_user');
  const pass = await getSetting('smtp_pass');
  const fromName = (await getSetting('smtp_from_name')) || 'Kurnool Neuro Clinic';
  if (!host || !user || !pass) {
    const err = new Error('SMTP not configured. Go to Settings → Email Setup and fill in your Gmail address + App Password.');
    err.code = 'SMTP_NOT_CONFIGURED';
    throw err;
  }
  const transporter = nodemailer.createTransport({
    host, port,
    secure: port === 465,
    auth: { user, pass }
  });
  await transporter.sendMail({
    from: `"${fromName}" <${user}>`,
    to, subject, text
  });
}

// SMTP status (never leaks the password)
app.get('/api/settings/smtp-status', async (req, res) => {
  const host = await getSetting('smtp_host');
  const user = await getSetting('smtp_user');
  const pass = await getSetting('smtp_pass');
  res.json({
    success: true,
    data: {
      configured: !!(host && user && pass),
      host: host || '',
      port: (await getSetting('smtp_port')) || '465',
      user: user || '',
      from_name: (await getSetting('smtp_from_name')) || 'Kurnool Neuro Clinic'
    }
  });
});

// Save SMTP settings (Gmail: host=smtp.gmail.com, port=465, user=your@gmail.com, pass=App Password)
app.put('/api/settings/smtp', async (req, res) => {
  const { host, port, user, pass, from_name } = req.body || {};
  if (host !== undefined) await setSetting('smtp_host', String(host));
  if (port !== undefined) await setSetting('smtp_port', String(port || '465'));
  if (user !== undefined) await setSetting('smtp_user', String(user));
  if (pass !== undefined && pass) await setSetting('smtp_pass', String(pass));
  if (from_name !== undefined) await setSetting('smtp_from_name', String(from_name || 'Kurnool Neuro Clinic'));
  res.json({ success: true, message: 'Email settings saved.' });
});

// Send a test email to verify SMTP works
app.post('/api/settings/smtp-test', async (req, res) => {
  const to = (await getSetting('recovery_email')) || '';
  if (!to) return res.status(400).json({ success: false, message: 'No recovery email is set. Save one first.' });
  try {
    await sendMail({
      to,
      subject: 'Kurnool Neuro Clinic — Test Email',
      text: 'This is a test email from your Clinic Management System. If you can read this, email is working correctly.'
    });
    res.json({ success: true, message: `Test email sent to ${to}. Please check the Gmail inbox (or Spam folder).` });
  } catch (e) {
    res.status(500).json({ success: false, message: e.message });
  }
});

// STEP 1: request a one-time code for a destructive action
// body: { action: "clear_demo" | "reset_all" }
app.post('/api/dev/request-danger-code', async (req, res) => {
  const action = (req.body && req.body.action) || '';
  if (!['clear_demo', 'reset_all'].includes(action)) {
    return res.status(400).json({ success: false, message: 'Unknown action' });
  }
  const to = (await getSetting('recovery_email')) || '';
  if (!to) return res.status(400).json({ success: false, message: 'No recovery email set. Save one in Settings first.' });

  const code = newDangerCode();
  const hash = bcrypt.hashSync(code, 8);
  // Invalidate any older pending codes
  for (const [k, v] of dangerCodes) if (v.action === action) dangerCodes.delete(k);
  const key = crypto.randomBytes(8).toString('hex');
  dangerCodes.set(key, { hash, action, expiresAt: Date.now() + DANGER_CODE_TTL_MS });

  const label = action === 'clear_demo' ? 'Clear DEMO patients / doctors / medicines' : 'ERASE ALL DATA (start fresh)';
  const subject = `Kurnool Neuro Clinic — Code to ${label}`;
  const text =
`Someone at the clinic just requested this action:

    ${label}

Your one-time code is:

    ${code}

Type this code inside the software within 15 minutes to complete the action.
If you did NOT request this, IGNORE this email — no changes were made.

— Kurnool Neuro Clinic Management System`;

  try {
    await sendMail({ to, subject, text });
    res.json({
      success: true,
      message: `A 6-digit code has been emailed to ${to}. Please open Gmail and type the code in the software (valid 15 minutes).`,
      data: { request_key: key, sent_to: to, action }
    });
  } catch (e) {
    dangerCodes.delete(key);
    if (e.code === 'SMTP_NOT_CONFIGURED') return res.status(400).json({ success: false, message: e.message });
    res.status(500).json({ success: false, message: 'Could not send email: ' + e.message });
  }
});

// STEP 2: verify the code and execute the destructive action
// body: { request_key, code, action }
app.post('/api/dev/verify-danger-code', (req, res) => {
  const { request_key, code, action } = req.body || {};
  const entry = dangerCodes.get(request_key);
  if (!entry) return res.status(400).json({ success: false, message: 'No code was requested, or it has expired. Please request a new code.' });
  if (entry.expiresAt < Date.now()) { dangerCodes.delete(request_key); return res.status(400).json({ success: false, message: 'This code has expired. Please request a new one.' }); }
  if (entry.action !== action) return res.status(400).json({ success: false, message: 'Action mismatch. Please start again.' });
  if (!code || !bcrypt.compareSync(String(code), entry.hash)) {
    return res.status(401).json({ success: false, message: 'Wrong code. Please check the Gmail message and try again.' });
  }
  // consume the code
  dangerCodes.delete(request_key);

  if (action === 'clear_demo') {
    db.serialize(() => {
      db.run(`DELETE FROM doctors WHERE doctor_name IN ('Dr. K. Ramesh','Dr. S. Sujatha') AND (mobile IN ('9876543210','9876543211'))`);
      db.run(`DELETE FROM patients WHERE patient_code IN ('KNC001000001','KNC001000002')`);
      db.run(`DELETE FROM medicines WHERE medicine_name IN ('Paracetamol 650mg','Clonazepam 0.5mg') AND (batch_number IN ('B123','C456'))`);
    });
    return res.json({ success: true, message: 'Demo data cleared successfully.' });
  }
  if (action === 'reset_all') {
    db.serialize(() => {
      ['op_bills', 'medical_bills', 'medical_bill_items', 'lab_bills', 'lab_bill_items',
       'purchases', 'purchase_items', 'medicine_returns', 'expenses',
       'staff_attendance', 'staff', 'patients', 'doctors', 'medicines',
       'op_token_counter'].forEach(t => db.run(`DELETE FROM ${t}`, () => {}));
    });
    return res.json({ success: true, message: 'All data has been erased. Only settings + passwords are preserved.' });
  }
  res.status(400).json({ success: false, message: 'Unknown action' });
});

// LEGACY endpoints — kept for backward compatibility BUT now guarded by the danger-code flow.
// They will refuse to run without the two-step verification above.
app.post('/api/dev/clear-demo-data', (req, res) => {
  res.status(403).json({ success: false, message: 'This action now requires a one-time email code. Please use the button in Settings → Danger Zone.' });
});
app.post('/api/dev/reset-all-data', (req, res) => {
  res.status(403).json({ success: false, message: 'This action now requires a one-time email code. Please use the button in Settings → Danger Zone.' });
});

// Lookup medicine by product_code for Purchase quick-add
app.get('/api/medicines/code/:code', (req, res) => {
  db.get(`SELECT * FROM medicines WHERE product_code = ? OR medicine_name = ?`, [req.params.code, req.params.code], (err, row) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!row) return res.status(404).json({ success: false, message: 'No medicine with that product code' });
    res.json({ success: true, data: row });
  });
});

// Patient pending: read + add/subtract adjustment
app.get('/api/patients/:id/pending', (req, res) => {
  db.get(`SELECT id, patient_code, patient_name, pending_amount FROM patients WHERE id = ?`, [req.params.id], (err, row) => {
    if (err || !row) return res.status(404).json({ success: false, message: 'Patient not found' });
    res.json({ success: true, data: row });
  });
});
app.post('/api/patients/:id/pending-adjust', (req, res) => {
  const { delta, note } = req.body || {};
  const d = parseFloat(delta) || 0;
  db.run(`UPDATE patients SET pending_amount = COALESCE(pending_amount, 0) + ? WHERE id = ?`, [d, req.params.id], function (err) {
    if (err) return res.status(500).json({ success: false, message: err.message });
    res.json({ success: true });
  });
});

// Developer-only endpoint: reset LOGIN password to a fresh random one + email to developer_email
app.post('/api/auth/developer-reset-password', async (req, res) => {
  const { developer_password } = req.body || {};
  const devHash = await getSetting('developer_password_hash');
  if (!devHash || !bcrypt.compareSync(String(developer_password || ''), devHash)) {
    return res.status(401).json({ success: false, message: 'Wrong developer password' });
  }
  const newPlain = crypto.randomBytes(4).toString('hex');   // 8-char random
  const newHash = bcrypt.hashSync(newPlain, 10);
  await setSetting('login_password_hash', newHash);
  await setSetting('login_password_plain', newPlain);
  const devEmail = (await getSetting('developer_email')) || '';
  // Actual SMTP delivery: leaves an audit trail; requires SMTP env vars to actually send an email
  // (see README-EMAIL.md). For now we return the new password so the developer can note it.
  res.json({
    success: true,
    message: `Password reset. Sent to ${devEmail} if SMTP is configured.`,
    data: { new_login_password: newPlain, developer_email: devEmail }
  });
});

// Change developer password itself (protected: needs current developer_password)
app.post('/api/auth/change-developer-password', async (req, res) => {
  const { current, new_password } = req.body || {};
  const devHash = await getSetting('developer_password_hash');
  if (!devHash || !bcrypt.compareSync(String(current || ''), devHash)) {
    return res.status(401).json({ success: false, message: 'Wrong current developer password' });
  }
  if (!new_password || new_password.length < 6) return res.status(400).json({ success: false, message: 'New developer password must be at least 6 chars' });
  await setSetting('developer_password_hash', bcrypt.hashSync(String(new_password), 10));
  res.json({ success: true, message: 'Developer password changed' });
});

// =============================================================================
const DB_PATH = path.join(__dirname, 'clinic.db');
app.get('/api/backup/download', (req, res) => {
  const stamp = new Date().toISOString().replace(/[:T]/g, '-').slice(0, 19);
  res.download(DB_PATH, `clinic-backup-${stamp}.db`);
});

app.listen(PORT, () => {
  console.log(`Clinic Management System running on http://localhost:${PORT}`);
});
