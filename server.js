const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const cors = require('cors');
const path = require('path');
const bcrypt = require('bcryptjs');
const crypto = require('crypto');

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
  if (req.path === '/auth/login' || req.path === '/public/gst') return next();
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
  res.json({ success: true, message: 'Password changed' });
});

// Settings: GST number, etc.
app.get('/api/settings', async (req, res) => {
  const gst = (await getSetting('gst_number')) || '';
  res.json({ success: true, data: { gst_number: gst } });
});
app.put('/api/settings', async (req, res) => {
  const { gst_number } = req.body || {};
  if (gst_number !== undefined) await setSetting('gst_number', String(gst_number));
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

    // Seed default login+delete passwords + empty GST number on FIRST boot
    db.get(`SELECT svalue FROM settings WHERE skey = 'login_password_hash'`, (err, row) => {
      if (!row) {
        const loginHash = bcrypt.hashSync('admin123', 10);
        const deleteHash = bcrypt.hashSync('delete123', 10);
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('login_password_hash', ?)`, [loginHash]);
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('delete_password_hash', ?)`, [deleteHash]);
        db.run(`INSERT OR REPLACE INTO settings (skey, svalue) VALUES ('gst_number', '')`);
      }
    });

    // Seed sample doctor if none exists
    db.get(`SELECT COUNT(*) as count FROM doctors`, (err, row) => {
      if (row && row.count === 0) {
        db.run(`INSERT INTO doctors (doctor_name, qualification, mobile, consultation_fee, status) VALUES ('Dr. K. Ramesh', 'MS (Neuro), MCh (Psychiatry)', '9876543210', 500, 'Active')`);
        db.run(`INSERT INTO doctors (doctor_name, qualification, mobile, consultation_fee, status) VALUES ('Dr. S. Sujatha', 'MS (ENT)', '9876543211', 400, 'Active')`);
      }
    });

    // Seed sample patient if none exists
    db.get(`SELECT COUNT(*) as count FROM patients`, (err, row) => {
      if (row && row.count === 0) {
        db.run(`INSERT INTO patients (patient_code, patient_name, age, gender, mobile, address, registration_date) VALUES ('KNC001000001', 'Venkat Reddy', 45, 'Male', '9988776655', 'Kurnool', datetime('now', 'localtime'))`);
        db.run(`INSERT INTO patients (patient_code, patient_name, age, gender, mobile, address, registration_date) VALUES ('KNC001000002', 'Lakshmi Devi', 38, 'Female', '9988776644', 'Nandyal', datetime('now', 'localtime'))`);
      }
    });

    // Seed sample medicine if none exists
    db.get(`SELECT COUNT(*) as count FROM medicines`, (err, row) => {
      if (row && row.count === 0) {
        db.run(`INSERT INTO medicines (medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status) VALUES ('Paracetamol 650mg', 'Paracetamol', '3004', 'B123', '2026-12-31', 2.0, 3.5, 150, 20, 'Active')`);
        db.run(`INSERT INTO medicines (medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status) VALUES ('Clonazepam 0.5mg', 'Clonazepam', '3004', 'C456', '2027-06-30', 5.0, 8.0, 100, 15, 'Active')`);
      }
    });
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
  const { medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status } = req.body;
  if (!medicine_name) return res.status(400).json({ success: false, message: 'Medicine Name is required' });

  db.run(
    `INSERT INTO medicines (medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate || 0, mrp || 0, current_stock || 0, minimum_stock || 10, status || 'Active'],
    function(err) {
      if (err) return res.status(500).json({ success: false, message: err.message });
      res.json({ success: true, data: { id: this.lastID } });
    }
  );
});

app.put('/api/medicines/:id', (req, res) => {
  const { id } = req.params;
  const { medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status } = req.body;
  db.run(
    `UPDATE medicines SET medicine_name = ?, generic_name = ?, hsn_number = ?, batch_number = ?, expiry_date = ?, rate = ?, mrp = ?, current_stock = ?, minimum_stock = ?, status = ? WHERE id = ?`,
    [medicine_name, generic_name, hsn_number, batch_number, expiry_date, rate, mrp, current_stock, minimum_stock, status, id],
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
  const { invoice_no, supplier_name, invoice_date, items } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ success: false, message: 'No purchase items provided' });

  let grand_total = 0;
  items.forEach(item => {
    grand_total += (item.qty * item.rate);
  });

  db.serialize(() => {
    db.run(`BEGIN TRANSACTION`);

    db.run(
      `INSERT INTO purchases (invoice_no, supplier_name, invoice_date, grand_total) VALUES (?, ?, ?, ?)`,
      [invoice_no, supplier_name, invoice_date || getTodayDate(), grand_total],
      function(err) {
        if (err) {
          db.run(`ROLLBACK`);
          return res.status(500).json({ success: false, message: err.message });
        }
        const purchase_id = this.lastID;
        let completed = 0;
        let hasError = false;

        items.forEach(item => {
          const amount = item.qty * item.rate;
          
          // Check if medicine already exists or create/update
          db.get(`SELECT id, current_stock FROM medicines WHERE id = ?`, [item.medicine_id], (err, med) => {
            if (hasError) return;
            if (err) {
              hasError = true;
              db.run(`ROLLBACK`);
              return res.status(500).json({ success: false, message: err.message });
            }

            db.run(
              `INSERT INTO purchase_items (purchase_id, medicine_id, batch, expiry, qty, hsn, rate, mrp, amount) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [purchase_id, item.medicine_id, item.batch, item.expiry, item.qty, item.hsn, item.rate, item.mrp, amount],
              (err) => {
                if (err && !hasError) {
                  hasError = true;
                  db.run(`ROLLBACK`);
                  return res.status(500).json({ success: false, message: err.message });
                }

                // Increase medicine stock and update batch/expiry/rate/mrp
                db.run(
                  `UPDATE medicines SET current_stock = current_stock + ?, batch_number = ?, expiry_date = ?, rate = ?, mrp = ? WHERE id = ?`,
                  [item.qty, item.batch, item.expiry, item.rate, item.mrp, item.medicine_id],
                  (err) => {
                    if (err && !hasError) {
                      hasError = true;
                      db.run(`ROLLBACK`);
                      return res.status(500).json({ success: false, message: err.message });
                    }

                    completed++;
                    if (completed === items.length && !hasError) {
                      db.run(`COMMIT`);
                      res.json({ success: true, data: { purchase_id, grand_total } });
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
          invoice_no, town, referred_by_doctor_id, items } = req.body;
  if (!items || items.length === 0) return res.status(400).json({ success: false, message: 'No items in medical bill' });
  if (!patient_id) return res.status(400).json({ success: false, message: 'Patient Code / ID is required' });

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

        // Get patient snapshot (name + phone) so bill still prints correctly if patient is edited later
        db.get(`SELECT patient_name, mobile FROM patients WHERE id = ?`, [patient_id], (err, patientRow) => {
          const patient_name_snapshot = patientRow ? patientRow.patient_name : '';
          const patient_phone_snapshot = patientRow ? patientRow.mobile : '';

          // Generate Bill No using max id (delete-safe)
          db.get(`SELECT MAX(id) as max_id FROM medical_bills`, (err, row) => {
            const billNoNum = ((row && row.max_id) ? row.max_id : 0) + 1;
            const bill_no = `MED-${dateStr.replace(/-/g, '')}-${String(billNoNum).padStart(4, '0')}`;
            const finalInvoiceNo = invoice_no || `INV${String(1000 + billNoNum)}`;

            // Compute per-item amount (rate + SGST + CGST) and subtotal
            let subtotal = 0;
            items.forEach(i => {
              const q = parseFloat(i.qty) || 0;
              const r = parseFloat(i.rate) || 0;
              const sp = parseFloat(i.sgst_percent) || 0;
              const cp = parseFloat(i.cgst_percent) || 0;
              const base = q * r;
              const sgst_amount = +(base * sp / 100).toFixed(2);
              const cgst_amount = +(base * cp / 100).toFixed(2);
              const amt = +(base + sgst_amount + cgst_amount).toFixed(2);
              i._computed = { sgst_amount, cgst_amount, amount: amt };
              subtotal += amt;
            });
            subtotal = +subtotal.toFixed(2);

            const discPct = discount_percent ? parseFloat(discount_percent) : 0;
            // Allow either % or fixed rupee discount from client
            const discAmt = discountAmtInput != null && discountAmtInput !== ''
              ? parseFloat(discountAmtInput)
              : +((subtotal * discPct) / 100).toFixed(2);
            const grand_total = +(subtotal - discAmt).toFixed(2);

            db.run(
              `INSERT INTO medical_bills (bill_no, bill_date, patient_id, subtotal, discount_percent, discount_amount, grand_total,
                                          invoice_no, town, referred_by_doctor_id, patient_name_snapshot, patient_phone_snapshot)
               VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
              [bill_no, dateStr, patient_id, subtotal, discPct, discAmt, grand_total,
               finalInvoiceNo, town || '', referred_by_doctor_id || null,
               patient_name_snapshot, patient_phone_snapshot],
              function(err) {
                if (err) return res.status(500).json({ success: false, message: err.message });

                const medical_bill_id = this.lastID;
                let savedItems = 0;
                let hasError = false;

                items.forEach(i => {
                  const { sgst_amount, cgst_amount, amount } = i._computed;
                  db.run(
                    `INSERT INTO medical_bill_items
                       (medical_bill_id, medicine_id, batch, expiry, qty, rate, amount, hsn, mrp, sgst_percent, cgst_percent, sgst_amount, cgst_amount)
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
                    [medical_bill_id, i.medicine_id, i.batch || '', i.expiry || '',
                     i.qty, i.rate, amount,
                     i.hsn || '', parseFloat(i.mrp) || 0,
                     parseFloat(i.sgst_percent) || 0, parseFloat(i.cgst_percent) || 0,
                     sgst_amount, cgst_amount],
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
  const { return_date, medicine_id, batch, qty, reason, supplier } = req.body;
  if (!medicine_id || !qty) return res.status(400).json({ success: false, message: 'Medicine and Qty are required' });

  db.get(`SELECT current_stock, medicine_name FROM medicines WHERE id = ?`, [medicine_id], (err, med) => {
    if (err) return res.status(500).json({ success: false, message: err.message });
    if (!med) return res.status(404).json({ success: false, message: 'Medicine not found' });
    if (med.current_stock < qty) {
      return res.status(400).json({ success: false, message: `Cannot return ${qty}. Current stock is only ${med.current_stock}` });
    }

    db.serialize(() => {
      db.run(`BEGIN TRANSACTION`);
      db.run(
        `INSERT INTO medicine_returns (return_date, medicine_id, batch, qty, reason, supplier) VALUES (?, ?, ?, ?, ?, ?)`,
        [return_date || getTodayDate(), medicine_id, batch || '', qty, reason || '', supplier || ''],
        function(err) {
          if (err) {
            db.run(`ROLLBACK`);
            return res.status(500).json({ success: false, message: err.message });
          }
          db.run(`UPDATE medicines SET current_stock = current_stock - ? WHERE id = ?`, [qty, medicine_id], (err) => {
            if (err) {
              db.run(`ROLLBACK`);
              return res.status(500).json({ success: false, message: err.message });
            }
            db.run(`COMMIT`);
            res.json({ success: true, message: 'Medicine return saved and stock updated' });
          });
        }
      );
    });
  });
});

app.get('/api/returns', (req, res) => {
  db.all(`
    SELECT r.*, m.medicine_name, m.generic_name
    FROM medicine_returns r
    JOIN medicines m ON r.medicine_id = m.id
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

app.listen(PORT, () => {
  console.log(`Clinic Management System running on http://localhost:${PORT}`);
});
