const express = require('express');
const session = require('express-session');
const bcrypt = require('bcryptjs');
const cors = require('cors');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const moment = require('moment');
const cron = require('node-cron');
const Database = require('better-sqlite3');
moment.locale('tr');

const app = express();
const PORT = process.env.PORT || 3000;
const DB_PATH = path.join(__dirname, 'baloglu.db');

// ── SQLite ─────────────────────────────────────────────────────────────────────
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS staff (
    id   INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    title TEXT DEFAULT 'Berber',
    active INTEGER DEFAULT 1
  );
  CREATE TABLE IF NOT EXISTS services (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    duration   INTEGER DEFAULT 30,
    price      REAL DEFAULT 0,
    active     INTEGER DEFAULT 1,
    sort_order INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS working_hours (
    day       INTEGER PRIMARY KEY,
    open_time TEXT DEFAULT '09:00',
    close_time TEXT DEFAULT '20:00',
    is_closed  INTEGER DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS appointments (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_name   TEXT NOT NULL,
    customer_phone  TEXT NOT NULL,
    staff_id        INTEGER,
    service_id      INTEGER,
    date            TEXT NOT NULL,
    time            TEXT NOT NULL,
    notes           TEXT DEFAULT '',
    status          TEXT DEFAULT 'pending',
    whatsapp_sent   INTEGER DEFAULT 0,
    reminder_sent   INTEGER DEFAULT 0,
    admin_note      TEXT DEFAULT '',
    created_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS appointment_services (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL,
    service_id     INTEGER,
    staff_id       INTEGER,
    name           TEXT NOT NULL,
    duration       INTEGER DEFAULT 30,
    price          REAL DEFAULT 0
  );
  CREATE TABLE IF NOT EXISTS appointment_photos (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL,
    filename       TEXT NOT NULL,
    created_at     TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS appointment_payments (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    appointment_id INTEGER NOT NULL,
    type           TEXT NOT NULL,
    amount         REAL NOT NULL,
    note           TEXT DEFAULT '',
    created_at     TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS settings (
    key   TEXT PRIMARY KEY,
    value TEXT
  );
  CREATE TABLE IF NOT EXISTS customers (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL,
    phone      TEXT NOT NULL UNIQUE,
    email      TEXT DEFAULT '',
    notes      TEXT DEFAULT '',
    tags       TEXT DEFAULT '',
    created_at TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS expenses (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    category    TEXT NOT NULL,
    amount      REAL NOT NULL,
    description TEXT DEFAULT '',
    date        TEXT NOT NULL,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS products (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    name        TEXT NOT NULL,
    category    TEXT DEFAULT '',
    price       REAL NOT NULL DEFAULT 0,
    stock       INTEGER NOT NULL DEFAULT 0,
    created_at  TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS product_sales (
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id      INTEGER NOT NULL,
    product_name    TEXT NOT NULL,
    quantity        INTEGER NOT NULL,
    unit_price      REAL NOT NULL,
    total           REAL NOT NULL,
    customer_name   TEXT DEFAULT '',
    customer_phone  TEXT DEFAULT '',
    date            TEXT NOT NULL,
    created_at      TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS packages (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    name          TEXT NOT NULL,
    description   TEXT DEFAULT '',
    session_count INTEGER NOT NULL DEFAULT 1,
    price         REAL NOT NULL DEFAULT 0,
    created_at    TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS customer_packages (
    id                  INTEGER PRIMARY KEY AUTOINCREMENT,
    package_id          INTEGER NOT NULL,
    package_name        TEXT NOT NULL,
    customer_name       TEXT NOT NULL,
    customer_phone      TEXT NOT NULL,
    total_sessions      INTEGER NOT NULL,
    remaining_sessions  INTEGER NOT NULL,
    price               REAL NOT NULL,
    purchase_date       TEXT NOT NULL,
    created_at          TEXT DEFAULT (datetime('now'))
  );
  CREATE TABLE IF NOT EXISTS loyalty_transactions (
    id             INTEGER PRIMARY KEY AUTOINCREMENT,
    customer_id    INTEGER NOT NULL,
    type           TEXT NOT NULL,
    amount         REAL NOT NULL,
    note           TEXT DEFAULT '',
    appointment_id INTEGER,
    created_at     TEXT DEFAULT (datetime('now'))
  );
`);

// ── Eski semaya yeni kolonlar (varsa atla) ──────────────────────────────────────
const apptCols = db.prepare("PRAGMA table_info(appointments)").all().map(c => c.name);
function addColumnIfMissing(name, def) {
  if (!apptCols.includes(name)) db.exec(`ALTER TABLE appointments ADD COLUMN ${name} ${def}`);
}
addColumnIfMissing('color', "TEXT DEFAULT ''");
addColumnIfMissing('tags', "TEXT DEFAULT ''");
addColumnIfMissing('reminder_enabled', 'INTEGER DEFAULT 1');
addColumnIfMissing('discount', 'REAL DEFAULT 0');
addColumnIfMissing('loyalty_used', 'REAL DEFAULT 0');
addColumnIfMissing('payment_status', "TEXT DEFAULT ''");
addColumnIfMissing('internal_note', "TEXT DEFAULT ''");

const custCols = db.prepare("PRAGMA table_info(customers)").all().map(c => c.name);
if (!custCols.includes('loyalty_balance')) db.exec(`ALTER TABLE customers ADD COLUMN loyalty_balance REAL DEFAULT 0`);

// Eski tek-hizmet randevularini appointment_services'e tasi (bir kerelik)
if (db.prepare('SELECT COUNT(*) as c FROM appointment_services').get().c === 0) {
  const olds = db.prepare(`SELECT a.id as appointment_id, a.staff_id, s.id as service_id, s.name, s.duration, s.price
                            FROM appointments a JOIN services s ON s.id = a.service_id
                            WHERE a.service_id IS NOT NULL`).all();
  if (olds.length) {
    const ins = db.prepare(`INSERT INTO appointment_services (appointment_id,service_id,staff_id,name,duration,price) VALUES (?,?,?,?,?,?)`);
    db.transaction(() => olds.forEach(o => ins.run(o.appointment_id, o.service_id, o.staff_id, o.name, o.duration, o.price)))();
  }
}

// Telefon numarasini sadece rakamlara indir (musteri eslestirme icin)
function normalizePhone(phone) {
  return String(phone || '').replace(/\D/g, '');
}

// Randevu olusturulurken musteri kaydini ekle/guncelle
function upsertCustomer(name, phone) {
  const norm = normalizePhone(phone);
  if (!norm) return;
  const existing = db.prepare('SELECT id FROM customers WHERE phone=?').get(norm);
  if (existing) db.prepare('UPDATE customers SET name=? WHERE id=?').run(name, existing.id);
  else db.prepare('INSERT INTO customers (name, phone) VALUES (?,?)').run(name, norm);
}

// Eski randevulardan musteri listesini olustur (bir kerelik)
if (db.prepare('SELECT COUNT(*) as c FROM customers').get().c === 0) {
  const apts = db.prepare('SELECT customer_name, customer_phone FROM appointments ORDER BY created_at ASC').all();
  db.transaction(() => apts.forEach(a => upsertCustomer(a.customer_name, a.customer_phone)))();
}

// ── Varsayilan veriler ─────────────────────────────────────────────────────────
function initDefaults() {
  if (db.prepare('SELECT COUNT(*) as c FROM staff').get().c === 0) {
    const ins = db.prepare('INSERT INTO staff (name, title) VALUES (?, ?)');
    ins.run('Ahmet Usta', 'Bas Berber');
    ins.run('Mehmet Usta', 'Berber');
    ins.run('Ali Usta', 'Berber');
    ins.run('Hasan Usta', 'Berber');
  }
  if (db.prepare('SELECT COUNT(*) as c FROM services').get().c === 0) {
    const ins = db.prepare('INSERT INTO services (name, duration, price, sort_order) VALUES (?, ?, ?, ?)');
    [
      ['Sac Kesimi', 30, 150, 1], ['Sakal Duzeltme', 20, 100, 2],
      ['Sac + Sakal', 45, 220, 3], ['Sac Yikama', 15, 80, 4],
      ['Fon', 20, 100, 5], ['Ense Tirasi', 10, 60, 6],
      ['Kas Alma', 10, 50, 7], ['Komple Bakim', 75, 350, 8]
    ].forEach(([n,d,p,s]) => ins.run(n,d,p,s));
  }
  if (db.prepare('SELECT COUNT(*) as c FROM working_hours').get().c === 0) {
    const ins = db.prepare('INSERT INTO working_hours (day, open_time, close_time, is_closed) VALUES (?, ?, ?, ?)');
    ins.run(0,'10:00','18:00',1);
    for (let d=1;d<=5;d++) ins.run(d,'09:00','20:00',0);
    ins.run(6,'09:00','18:00',0);
  }
  const ig = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  ig.run('shop_name', 'Baloglu Erkek Sac Tasarim Merkezi');
  ig.run('shop_phone', '05XX XXX XX XX');
  ig.run('shop_address', 'Adres bilgisi girilmemis');
  ig.run('owner_notify_phone', '');
  ig.run('admin_password', bcrypt.hashSync('admin123', 10));
  ig.run('slot_duration', '30');
  ig.run('advance_booking_days', '30');
  ig.run('twilio_account_sid', '');
  ig.run('twilio_auth_token', '');
  ig.run('twilio_from_number', 'whatsapp:+14155238886');
  ig.run('twilio_active', '0');
  ig.run('meta_access_token', '');
  ig.run('meta_phone_number_id', '');
  ig.run('meta_active', '0');
  ig.run('notifications_read_at', '');
}
initDefaults();

// ── Settings yardimcilari ──────────────────────────────────────────────────────
const stmtGet = db.prepare('SELECT value FROM settings WHERE key = ?');
const stmtSet = db.prepare('INSERT OR REPLACE INTO settings (key, value) VALUES (?, ?)');
function getSetting(key) { const r = stmtGet.get(key); return r ? r.value : null; }
function setSetting(key, val) { stmtSet.run(key, String(val ?? '')); }
function getAllSettings() {
  const obj = {};
  db.prepare('SELECT key, value FROM settings').all().forEach(r => obj[r.key] = r.value);
  return obj;
}

// ── db.json'dan goc ────────────────────────────────────────────────────────────
const jsonPath = path.join(__dirname, 'db.json');
if (fs.existsSync(jsonPath)) {
  try {
    const data = JSON.parse(fs.readFileSync(jsonPath, 'utf8'));
    db.transaction(() => {
      if (data.staff?.length) {
        db.prepare('DELETE FROM staff').run();
        const ins = db.prepare('INSERT INTO staff (id,name,title,active) VALUES (?,?,?,?)');
        data.staff.forEach(s => ins.run(s.id, s.name, s.title||'Berber', s.active?1:0));
      }
      if (data.services?.length) {
        db.prepare('DELETE FROM services').run();
        const ins = db.prepare('INSERT INTO services (id,name,duration,price,active,sort_order) VALUES (?,?,?,?,?,?)');
        data.services.forEach(s => ins.run(s.id,s.name,s.duration,s.price,s.active?1:0,s.sort_order||s.id));
      }
      if (data.working_hours?.length) {
        db.prepare('DELETE FROM working_hours').run();
        const ins = db.prepare('INSERT INTO working_hours (day,open_time,close_time,is_closed) VALUES (?,?,?,?)');
        data.working_hours.forEach(h => ins.run(h.day,h.open,h.close,h.closed?1:0));
      }
      if (data.appointments?.length) {
        const ins = db.prepare(`INSERT OR IGNORE INTO appointments
          (id,customer_name,customer_phone,staff_id,service_id,date,time,notes,status,whatsapp_sent,reminder_sent,admin_note,created_at)
          VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`);
        data.appointments.forEach(a => ins.run(
          a.id, a.customer_name, a.customer_phone,
          a.staff_id||null, a.service_id||null,
          a.date, a.time, a.notes||'', a.status||'pending',
          a.whatsapp_sent?1:0, a.reminder_sent?1:0,
          a.admin_note||'', a.created_at||new Date().toISOString()
        ));
      }
      if (data.settings) {
        const s = data.settings;
        if (s.shop_name) setSetting('shop_name', s.shop_name);
        if (s.shop_phone) setSetting('shop_phone', s.shop_phone);
        if (s.shop_address) setSetting('shop_address', s.shop_address);
        if (s.owner_notify_phone) setSetting('owner_notify_phone', s.owner_notify_phone);
        if (s.admin_password) setSetting('admin_password', s.admin_password);
        if (s.slot_duration) setSetting('slot_duration', s.slot_duration);
        if (s.advance_booking_days) setSetting('advance_booking_days', s.advance_booking_days);
      }
      if (data.twilio) {
        if (data.twilio.account_sid) setSetting('twilio_account_sid', data.twilio.account_sid);
        if (data.twilio.auth_token)  setSetting('twilio_auth_token', data.twilio.auth_token);
        if (data.twilio.from_number) setSetting('twilio_from_number', data.twilio.from_number);
        setSetting('twilio_active', data.twilio.active ? '1' : '0');
      }
    })();
    fs.renameSync(jsonPath, jsonPath + '.bak');
    console.log('db.json verileri SQLite\'a aktarildi, db.json.bak olarak yedeklendi.');
  } catch(e) { console.error('Goc hatasi:', e.message); }
}

// ── Middleware ─────────────────────────────────────────────────────────────────
app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(cors());
app.use(express.static(path.join(__dirname, 'public')));

// ── Foto Yukleme (Multer) ────────────────────────────────────────────────────────
const UPLOAD_DIR = path.join(__dirname, 'public', 'uploads', 'appointments');
const upload = multer({
  storage: multer.diskStorage({
    destination: (req, file, cb) => {
      const dir = path.join(UPLOAD_DIR, String(req.params.id));
      fs.mkdirSync(dir, { recursive: true });
      cb(null, dir);
    },
    filename: (req, file, cb) => {
      const ext = path.extname(file.originalname) || '.jpg';
      cb(null, Date.now() + '-' + Math.round(Math.random() * 1e9) + ext);
    }
  }),
  limits: { fileSize: 8 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (/^image\/(jpeg|png|webp|gif)$/.test(file.mimetype)) cb(null, true);
    else cb(new Error('Sadece resim dosyalari yuklenebilir'));
  }
});
function uploadAppointmentPhoto(req, res, next) {
  upload.single('photo')(req, res, (err) => {
    if (err) return res.status(400).json({ error: err.message });
    next();
  });
}

// Oturum anahtari: once SESSION_SECRET ortam degiskeninden okunur.
// Tanimli degilse ilk calistirmada rastgele uretilip veritabaninda saklanir,
// boylece kod icine gomulu sabit bir anahtar bulunmaz.
function getSessionSecret() {
  if (process.env.SESSION_SECRET) return process.env.SESSION_SECRET;
  let s = getSetting('session_secret');
  if (!s) {
    s = require('crypto').randomBytes(32).toString('hex');
    setSetting('session_secret', s);
  }
  return s;
}

app.use(session({
  secret: getSessionSecret(),
  resave: false,
  saveUninitialized: false,
  cookie: { maxAge: 24 * 60 * 60 * 1000 }
}));

// ── WhatsApp ───────────────────────────────────────────────────────────────────
let waClient = null, waReady = false, waQR = null;
try {
  const { Client, LocalAuth } = require('whatsapp-web.js');
  const qrcode = require('qrcode-terminal');
  waClient = new Client({
    authStrategy: new LocalAuth({ dataPath: './wa-session' }),
    puppeteer: { headless: true, args: ['--no-sandbox', '--disable-setuid-sandbox'] },
    webVersionCache: { type: 'none' }
  });
  waClient.on('qr', qr => { qrcode.generate(qr, { small: true }); waQR = qr; waReady = false; });
  waClient.on('ready', () => { console.log('WhatsApp hazir!'); waReady = true; waQR = null; });
  waClient.on('disconnected', () => { waReady = false; });
  waClient.on('auth_failure', () => { waReady = false; waClient = null; });
  waClient.initialize().catch(() => { waClient = null; });
} catch { waClient = null; }

async function sendViaTwilio(phone, message) {
  const sid    = getSetting('twilio_account_sid');
  const token  = getSetting('twilio_auth_token');
  const from   = getSetting('twilio_from_number') || 'whatsapp:+14155238886';
  const active = getSetting('twilio_active') === '1';
  if (!active || !sid || !token) return false;
  try {
    const n = phone.replace(/\D/g,'');
    const num = n.startsWith('90') ? n : n.startsWith('0') ? '90'+n.slice(1) : '90'+n;
    const resp = await fetch(
      `https://api.twilio.com/2010-04-01/Accounts/${sid}/Messages.json`,
      {
        method: 'POST',
        headers: {
          'Authorization': 'Basic ' + Buffer.from(`${sid}:${token}`).toString('base64'),
          'Content-Type': 'application/x-www-form-urlencoded'
        },
        body: new URLSearchParams({ From: from, To: 'whatsapp:+'+num, Body: message }).toString()
      }
    );
    const result = await resp.json();
    return !!result.sid;
  } catch { return false; }
}

function normalizePhone(phone) {
  const n = phone.replace(/\D/g,'');
  return n.startsWith('90') ? n : n.startsWith('0') ? '90'+n.slice(1) : '90'+n;
}

async function sendViaMetaCloud(phone, message) {
  const token  = getSetting('meta_access_token');
  const phoneId = getSetting('meta_phone_number_id');
  const active = getSetting('meta_active') === '1';
  if (!active || !token || !phoneId) return false;
  try {
    const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizePhone(phone),
        type: 'text',
        text: { body: message }
      })
    });
    const result = await resp.json();
    return !!result.messages;
  } catch { return false; }
}

async function sendMetaTemplate(phone, templateName, langCode, params) {
  const token  = getSetting('meta_access_token');
  const phoneId = getSetting('meta_phone_number_id');
  if (!token || !phoneId) return { ok:false, error:'Meta bilgilerini kaydedin' };
  try {
    const template = { name: templateName, language: { code: langCode } };
    if (params && params.length) {
      template.components = [{
        type: 'body',
        parameters: params.map(p => ({ type: 'text', text: String(p) }))
      }];
    }
    const resp = await fetch(`https://graph.facebook.com/v21.0/${phoneId}/messages`, {
      method: 'POST',
      headers: { 'Authorization': `Bearer ${token}`, 'Content-Type': 'application/json' },
      body: JSON.stringify({
        messaging_product: 'whatsapp',
        to: normalizePhone(phone),
        type: 'template',
        template
      })
    });
    const result = await resp.json();
    return { ok: !!result.messages, error: result.error?.message };
  } catch (e) { return { ok:false, error: e.message }; }
}

async function sendWhatsApp(phone, message) {
  let sent = await sendViaMetaCloud(phone, message);
  if (!sent) sent = await sendViaTwilio(phone, message);
  if (sent) return true;
  if (!waClient || !waReady) return false;
  try {
    const n = phone.replace(/\D/g,'');
    const num = n.startsWith('90') ? n : n.startsWith('0') ? '90'+n.slice(1) : '90'+n;
    await waClient.sendMessage(num+'@c.us', message);
    return true;
  } catch { return false; }
}

// ── Yardimcilar ────────────────────────────────────────────────────────────────
function requireAuth(req, res, next) {
  if (req.session?.admin) return next();
  res.status(401).json({ error: 'Yetkisiz erisim' });
}

function getAppointmentServices(appointmentId) {
  return db.prepare(`SELECT aps.*, st.name as staff_name
                      FROM appointment_services aps
                      LEFT JOIN staff st ON st.id = aps.staff_id
                      WHERE aps.appointment_id = ?
                      ORDER BY aps.id ASC`).all(appointmentId);
}

function enrichAppointment(a) {
  const staff   = db.prepare('SELECT name FROM staff WHERE id = ?').get(a.staff_id);
  const services = getAppointmentServices(a.id);
  const primary = services[0];
  return {
    ...a,
    appointment_date: a.date,
    appointment_time: a.time,
    staff_name:   staff ? staff.name : null,
    services,
    service_name: primary ? primary.name : null,
    price:        primary ? primary.price : null,
    duration:     services.reduce((sum, s) => sum + (s.duration || 0), 0) || (primary ? primary.duration : null)
  };
}

function appointmentTotals(a, services) {
  const total = services.reduce((sum, s) => sum + (s.price || 0), 0);
  const paid = db.prepare(`SELECT COALESCE(SUM(CASE WHEN type='tahsilat' THEN amount WHEN type='alacak' THEN -amount ELSE 0 END),0) as s
                            FROM appointment_payments WHERE appointment_id = ?`).get(a.id).s;
  const net = total - (a.discount || 0) - (a.loyalty_used || 0);
  const remaining = net - paid;
  return { total, net, paid, remaining };
}

function getSlots(date, staffId, duration) {
  const dow = new Date(date + 'T00:00:00').getDay();
  const wh = db.prepare('SELECT * FROM working_hours WHERE day = ?').get(dow);
  if (!wh || wh.is_closed) return [];
  const dur = duration || parseInt(getSetting('slot_duration') || '30');
  const slots = [];
  let [sh, sm] = wh.open_time.split(':').map(Number);
  const [eh, em] = wh.close_time.split(':').map(Number);
  const endMins = eh * 60 + em;
  let cur = sh * 60 + sm;
  while (cur + dur <= endMins) {
    const t = String(Math.floor(cur/60)).padStart(2,'0') + ':' + String(cur%60).padStart(2,'0');
    const takenQ = staffId
      ? db.prepare(`SELECT id FROM appointments WHERE date=? AND time=? AND staff_id=? AND status NOT IN ('rejected','cancelled')`).get(date,t,staffId)
      : db.prepare(`SELECT id FROM appointments WHERE date=? AND time=? AND status NOT IN ('rejected','cancelled')`).get(date,t);
    if (!takenQ) slots.push(t);
    cur += dur;
  }
  return slots;
}

// ── PUBLIC API ─────────────────────────────────────────────────────────────────
app.get('/api/info', (req, res) => {
  const s = getAllSettings();
  res.json({
    settings: {
      shop_name: s.shop_name, shop_phone: s.shop_phone,
      shop_address: s.shop_address, slot_duration: s.slot_duration,
      advance_booking_days: s.advance_booking_days
    },
    services: db.prepare('SELECT * FROM services WHERE active=1 ORDER BY sort_order').all(),
    staff: db.prepare('SELECT id, name, title FROM staff WHERE active=1').all(),
    workingHours: db.prepare('SELECT day as day_of_week, open_time, close_time, is_closed FROM working_hours').all()
  });
});

app.get('/api/slots', (req, res) => {
  const { date, staff_id, service_id } = req.query;
  if (!date) return res.status(400).json({ error: 'Tarih gerekli' });
  const today = new Date().toISOString().split('T')[0];
  if (date < today) return res.json({ slots: [] });
  let dur = 30;
  if (service_id) {
    const s = db.prepare('SELECT duration FROM services WHERE id=?').get(service_id);
    if (s) dur = s.duration;
  }
  res.json({ slots: getSlots(date, staff_id||null, dur) });
});

app.post('/api/appointments', (req, res) => {
  const { customer_name, customer_phone, staff_id, service_id, appointment_date, appointment_time, notes } = req.body;
  if (!customer_name || !customer_phone || !appointment_date || !appointment_time)
    return res.status(400).json({ error: 'Lutfen tum alanlari doldurun' });
  if (customer_phone.replace(/\D/g,'').length < 10)
    return res.status(400).json({ error: 'Gecerli telefon numarasi girin' });

  const conflict = staff_id
    ? db.prepare(`SELECT id FROM appointments WHERE date=? AND time=? AND staff_id=? AND status NOT IN ('rejected','cancelled')`).get(appointment_date, appointment_time, staff_id)
    : db.prepare(`SELECT id FROM appointments WHERE date=? AND time=? AND status NOT IN ('rejected','cancelled')`).get(appointment_date, appointment_time);
  if (conflict) return res.status(409).json({ error: 'Bu saat dolu. Baska saat secin.' });

  const result = db.prepare(`INSERT INTO appointments
    (customer_name,customer_phone,staff_id,service_id,date,time,notes,status)
    VALUES (?,?,?,?,?,?,?,'pending')`)
    .run(customer_name, customer_phone, staff_id||null, service_id||null, appointment_date, appointment_time, notes||'');

  if (service_id) {
    const svc = db.prepare('SELECT * FROM services WHERE id=?').get(service_id);
    if (svc) {
      db.prepare(`INSERT INTO appointment_services (appointment_id,service_id,staff_id,name,duration,price) VALUES (?,?,?,?,?,?)`)
        .run(result.lastInsertRowid, svc.id, staff_id||null, svc.name, svc.duration, svc.price);
    }
  }

  upsertCustomer(customer_name, customer_phone);

  res.json({ success: true, message: 'Randevunuz alindi! Onay bekleniyor.', appointment_id: result.lastInsertRowid });

  const ownerPhone = getSetting('owner_notify_phone');
  if (ownerPhone) {
    const staff   = staff_id   ? db.prepare('SELECT name FROM staff WHERE id=?').get(staff_id)     : null;
    const service = service_id ? db.prepare('SELECT name FROM services WHERE id=?').get(service_id) : null;
    const msg =
      `Yeni Randevu Talebi\n\n` +
      `Musteri: ${customer_name}\n` +
      `Telefon: ${customer_phone}\n` +
      `Hizmet: ${service ? service.name : '-'}\n` +
      `Tarih: ${appointment_date}\n` +
      `Saat: ${appointment_time}\n` +
      (staff   ? `Personel: ${staff.name}\n` : '') +
      (notes   ? `Not: ${notes}\n` : '') +
      `\nAdmin panelinden onaylayabilirsiniz.`;
    (async () => {
      let sent = false;
      if (getSetting('meta_active') === '1') {
        const result = await sendMetaTemplate(ownerPhone, 'yeni_randevu_bildirim', 'tr',
          [customer_name, customer_phone, service ? service.name : '-', appointment_date, appointment_time]);
        sent = result.ok;
      }
      if (!sent) await sendWhatsApp(ownerPhone, msg);
    })().catch(() => {});
  }
});

// ── ADMIN API ──────────────────────────────────────────────────────────────────
app.post('/api/admin/login', (req, res) => {
  if (bcrypt.compareSync(req.body.password || '', getSetting('admin_password') || '')) {
    req.session.admin = true;
    res.json({ success: true });
  } else res.status(401).json({ error: 'Sifre hatali' });
});
app.post('/api/admin/logout', (req, res) => { req.session.destroy(); res.json({ success: true }); });
app.get('/api/admin/check', (req, res) => res.json({ authenticated: !!(req.session?.admin) }));

app.get('/api/admin/dashboard', requireAuth, (req, res) => {
  const today = new Date().toISOString().split('T')[0];
  const weekEnd = new Date(); weekEnd.setDate(weekEnd.getDate() + 7);
  const we = weekEnd.toISOString().split('T')[0];
  const todayAppts = db.prepare('SELECT * FROM appointments WHERE date=?').all(today);
  const recent = db.prepare(`SELECT * FROM appointments WHERE status='pending' ORDER BY created_at DESC LIMIT 5`).all().map(enrichAppointment);
  res.json({
    today_total:   todayAppts.length,
    today_pending: todayAppts.filter(a => a.status==='pending').length,
    today_approved:todayAppts.filter(a => a.status==='approved').length,
    total_pending: db.prepare(`SELECT COUNT(*) as c FROM appointments WHERE status='pending'`).get().c,
    week_total:    db.prepare('SELECT COUNT(*) as c FROM appointments WHERE date>=? AND date<=?').get(today,we).c,
    recent
  });
});

app.get('/api/admin/appointments', requireAuth, (req, res) => {
  const { status, date, staff_id, start_date, end_date } = req.query;
  let q = 'SELECT * FROM appointments WHERE 1=1';
  const params = [];
  if (status)   { q += ' AND status=?';   params.push(status); }
  if (date)     { q += ' AND date=?';     params.push(date); }
  if (start_date) { q += ' AND date>=?'; params.push(start_date); }
  if (end_date)   { q += ' AND date<=?'; params.push(end_date); }
  if (staff_id) { q += ' AND staff_id=?'; params.push(staff_id); }
  q += ' ORDER BY date DESC, time ASC';
  const list = db.prepare(q).all(...params).map(enrichAppointment);
  res.json({ appointments: list });
});

// Admin tarafindan yeni randevu / adisyon (walk-in) olusturma
app.post('/api/admin/appointments', requireAuth, (req, res) => {
  const { customer_name, customer_phone, staff_id, service_id, date, time, notes, status } = req.body;
  if (!customer_name || !customer_phone || !date || !time)
    return res.status(400).json({ error: 'Lutfen tum alanlari doldurun' });
  if (normalizePhone(customer_phone).length < 10)
    return res.status(400).json({ error: 'Gecerli telefon numarasi girin' });

  const allowedStatuses = ['pending','approved','completed','no_show','cancelled','rejected'];
  const st = allowedStatuses.includes(status) ? status : 'approved';

  const result = db.prepare(`INSERT INTO appointments
    (customer_name,customer_phone,staff_id,service_id,date,time,notes,status)
    VALUES (?,?,?,?,?,?,?,?)`)
    .run(customer_name, customer_phone, staff_id||null, service_id||null, date, time, notes||'', st);

  if (service_id) {
    const svc = db.prepare('SELECT * FROM services WHERE id=?').get(service_id);
    if (svc) {
      db.prepare(`INSERT INTO appointment_services (appointment_id,service_id,staff_id,name,duration,price) VALUES (?,?,?,?,?,?)`)
        .run(result.lastInsertRowid, svc.id, staff_id||null, svc.name, svc.duration, svc.price);
    }
  }

  upsertCustomer(customer_name, customer_phone);

  res.json({ success: true, id: result.lastInsertRowid });
});

app.post('/api/admin/appointments/:id/approve', requireAuth, async (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Bulunamadi' });
  db.prepare(`UPDATE appointments SET status='approved', admin_note=? WHERE id=?`).run(req.body.admin_note||'', a.id);
  const ea = enrichAppointment(a);
  const shopPhone   = getSetting('shop_phone') || '';
  const shopAddress = getSetting('shop_address') || '';
  const shopName    = getSetting('shop_name') || 'Salon';
  const dateStr = new Date(a.date+'T00:00:00').toLocaleDateString('tr-TR',{weekday:'long',day:'numeric',month:'long',year:'numeric'});
  const msg = `Randevu Onay Bildirimi\n\nSayin ${a.customer_name},\n\nRandevunuz onaylandi:\n\nTarih: ${dateStr}\nSaat: ${a.time}\nHizmet: ${ea.service_name||'Belirtilmedi'}\nPersonel: ${ea.staff_name||'Berber'}\n\n${shopName}${shopAddress?'\nAdres: '+shopAddress:''}${shopPhone?'\nTelefon: '+shopPhone:''}${req.body.admin_note?'\n\nNot: '+req.body.admin_note:''}\n\nGoruscek uzere.`;
  let waSent = false;
  if (getSetting('meta_active') === '1') {
    const result = await sendMetaTemplate(a.customer_phone, 'randevu_onay', 'tr',
      [a.customer_name, dateStr, a.time, ea.service_name || 'Belirtilmedi']);
    waSent = result.ok;
  }
  if (!waSent) waSent = await sendWhatsApp(a.customer_phone, msg);
  if (waSent) db.prepare('UPDATE appointments SET whatsapp_sent=1 WHERE id=?').run(a.id);
  const phone = a.customer_phone.replace(/\D/g,'').replace(/^0/,'');
  res.json({ success:true, whatsapp_sent:waSent, whatsapp_link:`https://wa.me/90${phone}?text=${encodeURIComponent(msg)}` });
});

app.post('/api/admin/appointments/:id/reject', requireAuth, async (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Bulunamadi' });
  db.prepare(`UPDATE appointments SET status='rejected', admin_note=? WHERE id=?`).run(req.body.admin_note||'', a.id);
  const shopName = getSetting('shop_name') || 'Salon';
  const msg = `Randevu Bildirimi\n\nSayin ${a.customer_name},\n\nMaalesef randevunuz onaylanamadi.${req.body.admin_note?'\nNeden: '+req.body.admin_note:''}\n\n${shopName}`;
  let waSent = false;
  if (getSetting('meta_active') === '1') {
    const reason = req.body.admin_note ? `Neden: ${req.body.admin_note}` : 'Detaylı bilgi için bizi arayabilirsiniz.';
    const result = await sendMetaTemplate(a.customer_phone, 'randevu_red', 'tr', [a.customer_name, reason]);
    waSent = result.ok;
  }
  if (!waSent) waSent = await sendWhatsApp(a.customer_phone, msg);
  const phone = a.customer_phone.replace(/\D/g,'').replace(/^0/,'');
  res.json({ success:true, whatsapp_sent:waSent, whatsapp_link:`https://wa.me/90${phone}?text=${encodeURIComponent(msg)}` });
});

app.post('/api/admin/appointments/:id/cancel', requireAuth, (req, res) => {
  db.prepare(`UPDATE appointments SET status='cancelled' WHERE id=?`).run(req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/appointments/:id/complete', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Randevu bulunamadi' });
  db.prepare(`UPDATE appointments SET status='completed' WHERE id=?`).run(a.id);
  res.json({ success: true });
});

app.post('/api/admin/appointments/:id/no-show', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Randevu bulunamadi' });
  db.prepare(`UPDATE appointments SET status='no_show' WHERE id=?`).run(a.id);
  res.json({ success: true });
});

// ── Randevu Detayi ─────────────────────────────────────────────────────────────
app.get('/api/admin/appointments/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Randevu bulunamadi' });
  const appointment = enrichAppointment(a);
  const totals = appointmentTotals(a, appointment.services);
  const photos = db.prepare('SELECT * FROM appointment_photos WHERE appointment_id=? ORDER BY id DESC').all(a.id)
    .map(p => ({ ...p, url: `/uploads/appointments/${p.filename}` }));
  const payments = db.prepare('SELECT * FROM appointment_payments WHERE appointment_id=? ORDER BY id DESC').all(a.id);
  const customer = db.prepare('SELECT id, loyalty_balance FROM customers WHERE phone=?').get(normalizePhone(a.customer_phone));
  appointment.customer_id = customer ? customer.id : null;
  appointment.loyalty_available = (customer ? customer.loyalty_balance : 0) + (a.loyalty_used || 0);
  res.json({ appointment, totals, photos, payments });
});

app.put('/api/admin/appointments/:id', requireAuth, (req, res) => {
  const a = db.prepare('SELECT * FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Randevu bulunamadi' });
  const b = req.body;
  const merged = {
    internal_note:    b.internal_note    !== undefined ? b.internal_note : a.internal_note,
    tags:             b.tags             !== undefined ? b.tags : a.tags,
    color:            b.color            !== undefined ? b.color : a.color,
    reminder_enabled: b.reminder_enabled !== undefined ? (b.reminder_enabled ? 1 : 0) : a.reminder_enabled,
    discount:         b.discount         !== undefined ? (+b.discount || 0) : a.discount,
    loyalty_used:     b.loyalty_used     !== undefined ? (+b.loyalty_used || 0) : a.loyalty_used
  };

  const loyaltyDelta = merged.loyalty_used - (a.loyalty_used || 0);
  if (loyaltyDelta !== 0) {
    const customer = db.prepare('SELECT * FROM customers WHERE phone=?').get(normalizePhone(a.customer_phone));
    const balance = customer ? customer.loyalty_balance : 0;
    if (loyaltyDelta > balance) return res.status(400).json({ error: 'Yetersiz parapuan bakiyesi' });
    if (customer) {
      db.prepare('UPDATE customers SET loyalty_balance=? WHERE id=?').run(balance - loyaltyDelta, customer.id);
      db.prepare('INSERT INTO loyalty_transactions (customer_id, type, amount, note, appointment_id) VALUES (?,?,?,?,?)')
        .run(customer.id, 'used', -loyaltyDelta, `Randevu #${a.id}`, a.id);
    }
  }

  db.prepare(`UPDATE appointments SET internal_note=?, tags=?, color=?, reminder_enabled=?, discount=?, loyalty_used=? WHERE id=?`)
    .run(merged.internal_note, merged.tags, merged.color, merged.reminder_enabled, merged.discount, merged.loyalty_used, a.id);
  res.json({ success: true });
});

// ── Randevu Hizmetleri ─────────────────────────────────────────────────────────
app.post('/api/admin/appointments/:id/services', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Randevu bulunamadi' });
  const svc = db.prepare('SELECT * FROM services WHERE id=?').get(req.body.service_id);
  if (!svc) return res.status(400).json({ error: 'Hizmet bulunamadi' });
  const r = db.prepare(`INSERT INTO appointment_services (appointment_id,service_id,staff_id,name,duration,price) VALUES (?,?,?,?,?,?)`)
    .run(a.id, svc.id, req.body.staff_id || null, svc.name, svc.duration, svc.price);
  res.json({ success: true, id: r.lastInsertRowid, services: getAppointmentServices(a.id) });
});

app.delete('/api/admin/appointments/:id/services/:rowId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM appointment_services WHERE id=? AND appointment_id=?').run(req.params.rowId, req.params.id);
  res.json({ success: true, services: getAppointmentServices(req.params.id) });
});

// ── Randevu Fotograflari ───────────────────────────────────────────────────────
app.post('/api/admin/appointments/:id/photos', requireAuth, uploadAppointmentPhoto, (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'Dosya yuklenemedi' });
  const filename = `${req.params.id}/${req.file.filename}`;
  db.prepare('INSERT INTO appointment_photos (appointment_id, filename) VALUES (?,?)').run(req.params.id, filename);
  res.json({ success: true, filename, url: `/uploads/appointments/${filename}` });
});

app.get('/api/admin/appointments/:id/photos', requireAuth, (req, res) => {
  const photos = db.prepare('SELECT * FROM appointment_photos WHERE appointment_id=? ORDER BY id DESC').all(req.params.id)
    .map(p => ({ ...p, url: `/uploads/appointments/${p.filename}` }));
  res.json({ photos });
});

app.delete('/api/admin/appointments/:id/photos/:photoId', requireAuth, (req, res) => {
  const p = db.prepare('SELECT * FROM appointment_photos WHERE id=? AND appointment_id=?').get(req.params.photoId, req.params.id);
  if (p) {
    try { fs.unlinkSync(path.join(UPLOAD_DIR, p.filename)); } catch {}
    db.prepare('DELETE FROM appointment_photos WHERE id=?').run(p.id);
  }
  res.json({ success: true });
});

// ── Randevu Odeme / Tahsilat ───────────────────────────────────────────────────
app.post('/api/admin/appointments/:id/payments', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Randevu bulunamadi' });
  const { type, amount, note } = req.body;
  if (!['tahsilat','alacak'].includes(type)) return res.status(400).json({ error: 'Gecersiz odeme turu' });
  const amt = +amount;
  if (!amt || amt <= 0) return res.status(400).json({ error: 'Gecersiz tutar' });
  const r = db.prepare('INSERT INTO appointment_payments (appointment_id,type,amount,note) VALUES (?,?,?,?)')
    .run(a.id, type, amt, note || '');
  db.prepare(`UPDATE appointments SET payment_status='' WHERE id=?`).run(a.id);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/admin/appointments/:id/payments/:paymentId', requireAuth, (req, res) => {
  db.prepare('DELETE FROM appointment_payments WHERE id=? AND appointment_id=?').run(req.params.paymentId, req.params.id);
  res.json({ success: true });
});

app.post('/api/admin/appointments/:id/close-unpaid', requireAuth, (req, res) => {
  const a = db.prepare('SELECT id FROM appointments WHERE id=?').get(req.params.id);
  if (!a) return res.status(404).json({ error: 'Randevu bulunamadi' });
  db.prepare(`UPDATE appointments SET payment_status='closed_unpaid' WHERE id=?`).run(a.id);
  res.json({ success: true });
});

// ── Musteriler (CRM) ───────────────────────────────────────────────────────────
app.get('/api/admin/customers', requireAuth, (req, res) => {
  const q = (req.query.q || '').trim();
  let customers;
  if (q) {
    const qPhone = normalizePhone(q);
    if (qPhone) {
      customers = db.prepare(`SELECT * FROM customers WHERE name LIKE ? OR phone LIKE ? ORDER BY name COLLATE NOCASE ASC`)
        .all(`%${q}%`, `%${qPhone}%`);
    } else {
      customers = db.prepare(`SELECT * FROM customers WHERE name LIKE ? ORDER BY name COLLATE NOCASE ASC`).all(`%${q}%`);
    }
  } else {
    customers = db.prepare('SELECT * FROM customers ORDER BY name COLLATE NOCASE ASC').all();
  }
  res.json({ customers });
});

app.post('/api/admin/customers', requireAuth, (req, res) => {
  const { name, phone, email, notes, tags } = req.body;
  if (!name || !phone) return res.status(400).json({ error: 'Isim ve telefon gerekli' });
  const norm = normalizePhone(phone);
  if (norm.length < 10) return res.status(400).json({ error: 'Gecerli telefon numarasi girin' });
  const existing = db.prepare('SELECT id FROM customers WHERE phone=?').get(norm);
  if (existing) return res.status(409).json({ error: 'Bu telefon numarasi ile kayitli musteri var' });
  const r = db.prepare('INSERT INTO customers (name, phone, email, notes, tags) VALUES (?,?,?,?,?)')
    .run(name, norm, email || '', notes || '', tags || '');
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/customers/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Musteri bulunamadi' });
  const { name, phone, email, notes, tags } = req.body;
  const norm = phone !== undefined ? normalizePhone(phone) : c.phone;
  if (phone !== undefined && norm.length < 10) return res.status(400).json({ error: 'Gecerli telefon numarasi girin' });
  if (norm !== c.phone) {
    const dup = db.prepare('SELECT id FROM customers WHERE phone=? AND id!=?').get(norm, c.id);
    if (dup) return res.status(409).json({ error: 'Bu telefon numarasi ile kayitli baska bir musteri var' });
  }
  db.prepare('UPDATE customers SET name=?, phone=?, email=?, notes=?, tags=? WHERE id=?')
    .run(name !== undefined ? name : c.name, norm, email !== undefined ? email : c.email,
         notes !== undefined ? notes : c.notes, tags !== undefined ? tags : c.tags, c.id);
  res.json({ success: true });
});

app.get('/api/admin/customers/:id', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Musteri bulunamadi' });

  const appointments = db.prepare('SELECT * FROM appointments ORDER BY date DESC, time DESC').all()
    .filter(a => normalizePhone(a.customer_phone) === c.phone)
    .map(a => {
      const enriched = enrichAppointment(a);
      const totals = appointmentTotals(a, enriched.services);
      return { ...enriched, totals };
    });

  const balance = appointments.reduce((sum, a) => sum + a.totals.remaining, 0);

  const photos = [];
  appointments.forEach(a => {
    db.prepare('SELECT * FROM appointment_photos WHERE appointment_id=? ORDER BY id DESC').all(a.id)
      .forEach(p => photos.push({ ...p, url: `/uploads/appointments/${p.filename}`, appointment_id: a.id, appointment_date: a.date }));
  });

  const loyalty_history = db.prepare('SELECT * FROM loyalty_transactions WHERE customer_id=? ORDER BY id DESC').all(c.id);

  res.json({ customer: c, appointments, balance, photos, loyalty_history });
});

app.post('/api/admin/customers/:id/loyalty-adjust', requireAuth, (req, res) => {
  const c = db.prepare('SELECT * FROM customers WHERE id=?').get(req.params.id);
  if (!c) return res.status(404).json({ error: 'Musteri bulunamadi' });
  const amount = +req.body.amount;
  const note = req.body.note || '';
  if (!amount) return res.status(400).json({ error: 'Gecerli bir tutar girin' });
  const newBalance = c.loyalty_balance + amount;
  if (newBalance < 0) return res.status(400).json({ error: 'Bakiye negatif olamaz' });
  db.prepare('UPDATE customers SET loyalty_balance=? WHERE id=?').run(newBalance, c.id);
  db.prepare('INSERT INTO loyalty_transactions (customer_id, type, amount, note) VALUES (?,?,?,?)')
    .run(c.id, 'manual', amount, note);
  res.json({ success: true, balance: newBalance });
});

// ── Adisyonlar (POS) ───────────────────────────────────────────────────────────
app.get('/api/admin/adisyonlar', requireAuth, (req, res) => {
  const { bucket, date } = req.query;
  let q = `SELECT * FROM appointments WHERE status != 'pending'`;
  const params = [];
  if (date) { q += ' AND date=?'; params.push(date); }
  q += ' ORDER BY date DESC, time DESC';

  let list = db.prepare(q).all(...params).map(a => {
    const enriched = enrichAppointment(a);
    const totals = appointmentTotals(a, enriched.services);
    let adisyonStatus;
    if (['cancelled','rejected'].includes(a.status)) adisyonStatus = 'iptal';
    else if (totals.remaining > 0 && a.payment_status !== 'closed_unpaid') adisyonStatus = 'acik';
    else adisyonStatus = 'kapatilmis';
    return { ...enriched, totals, adisyon_status: adisyonStatus };
  });

  if (bucket) list = list.filter(a => a.adisyon_status === bucket);
  res.json({ adisyonlar: list });
});

// ── Bildirimler (Notifications) ─────────────────────────────────────────────────
app.get('/api/admin/notifications', requireAuth, (req, res) => {
  const readAt = getSetting('notifications_read_at') || '';
  const pending = db.prepare(`SELECT * FROM appointments WHERE status='pending' ORDER BY created_at DESC`).all().map(enrichAppointment);
  const notifications = pending.map(a => ({
    type: 'pending_appointment',
    id: a.id,
    customer_name: a.customer_name,
    service_name: a.service_name,
    date: a.appointment_date,
    time: a.appointment_time,
    created_at: a.created_at,
    read: !!readAt && a.created_at <= readAt
  }));
  const unread_count = notifications.filter(n => !n.read).length;
  res.json({ notifications, unread_count });
});

app.post('/api/admin/notifications/mark-read', requireAuth, (req, res) => {
  setSetting('notifications_read_at', db.prepare("SELECT datetime('now') as t").get().t);
  res.json({ success: true });
});

// ── Masraflar (Expenses) ─────────────────────────────────────────────────────────
app.get('/api/admin/expenses', requireAuth, (req, res) => {
  const { category, start_date, end_date } = req.query;
  let q = 'SELECT * FROM expenses WHERE 1=1';
  const params = [];
  if (category)   { q += ' AND category=?'; params.push(category); }
  if (start_date) { q += ' AND date>=?';     params.push(start_date); }
  if (end_date)   { q += ' AND date<=?';     params.push(end_date); }
  q += ' ORDER BY date DESC, id DESC';
  const expenses = db.prepare(q).all(...params);
  const total = expenses.reduce((sum, e) => sum + e.amount, 0);
  res.json({ expenses, total });
});

app.post('/api/admin/expenses', requireAuth, (req, res) => {
  const { category, amount, description, date } = req.body;
  const amt = +amount;
  if (!category || !date || !amt || amt <= 0) return res.status(400).json({ error: 'Lutfen tum alanlari dogru doldurun' });
  const r = db.prepare('INSERT INTO expenses (category, amount, description, date) VALUES (?,?,?,?)')
    .run(category, amt, description || '', date);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/expenses/:id', requireAuth, (req, res) => {
  const { category, amount, description, date } = req.body;
  const amt = +amount;
  if (!category || !date || !amt || amt <= 0) return res.status(400).json({ error: 'Lutfen tum alanlari dogru doldurun' });
  db.prepare('UPDATE expenses SET category=?, amount=?, description=?, date=? WHERE id=?')
    .run(category, amt, description || '', date, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/expenses/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM expenses WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Ürünler (Products & Sales) ─────────────────────────────────────────────────
app.get('/api/admin/products', requireAuth, (req, res) => {
  const products = db.prepare('SELECT * FROM products ORDER BY name ASC').all();
  res.json({ products });
});

app.post('/api/admin/products', requireAuth, (req, res) => {
  const { name, category, price, stock } = req.body;
  const p = +price, s = +stock;
  if (!name || !(p >= 0) || !(s >= 0)) return res.status(400).json({ error: 'Lutfen tum alanlari dogru doldurun' });
  const r = db.prepare('INSERT INTO products (name, category, price, stock) VALUES (?,?,?,?)')
    .run(name, category || '', p, s);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/products/:id', requireAuth, (req, res) => {
  const { name, category, price, stock } = req.body;
  const p = +price, s = +stock;
  if (!name || !(p >= 0) || !(s >= 0)) return res.status(400).json({ error: 'Lutfen tum alanlari dogru doldurun' });
  db.prepare('UPDATE products SET name=?, category=?, price=?, stock=? WHERE id=?')
    .run(name, category || '', p, s, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/products/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM products WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/product-sales', requireAuth, (req, res) => {
  const { start_date, end_date } = req.query;
  let q = 'SELECT * FROM product_sales WHERE 1=1';
  const params = [];
  if (start_date) { q += ' AND date>=?'; params.push(start_date); }
  if (end_date)   { q += ' AND date<=?'; params.push(end_date); }
  q += ' ORDER BY date DESC, id DESC';
  const sales = db.prepare(q).all(...params);
  const total = sales.reduce((sum, s) => sum + s.total, 0);
  res.json({ sales, total });
});

app.post('/api/admin/product-sales', requireAuth, (req, res) => {
  const { product_id, quantity, customer_name, customer_phone, date } = req.body;
  const qty = +quantity;
  if (!product_id || !qty || qty <= 0 || !date) return res.status(400).json({ error: 'Lutfen tum alanlari dogru doldurun' });
  const product = db.prepare('SELECT * FROM products WHERE id=?').get(product_id);
  if (!product) return res.status(404).json({ error: 'Urun bulunamadi' });
  if (product.stock < qty) return res.status(400).json({ error: 'Stokta yeterli urun yok' });
  const total = product.price * qty;
  const r = db.prepare(`INSERT INTO product_sales (product_id, product_name, quantity, unit_price, total, customer_name, customer_phone, date)
    VALUES (?,?,?,?,?,?,?,?)`).run(product.id, product.name, qty, product.price, total, customer_name || '', customer_phone || '', date);
  db.prepare('UPDATE products SET stock = stock - ? WHERE id=?').run(qty, product.id);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.delete('/api/admin/product-sales/:id', requireAuth, (req, res) => {
  const sale = db.prepare('SELECT * FROM product_sales WHERE id=?').get(req.params.id);
  if (sale) {
    db.prepare('UPDATE products SET stock = stock + ? WHERE id=?').run(sale.quantity, sale.product_id);
    db.prepare('DELETE FROM product_sales WHERE id=?').run(req.params.id);
  }
  res.json({ success: true });
});

// ── Paketler (Packages) ────────────────────────────────────────────────────────
app.get('/api/admin/packages', requireAuth, (req, res) => {
  const packages = db.prepare('SELECT * FROM packages ORDER BY name ASC').all();
  res.json({ packages });
});

app.post('/api/admin/packages', requireAuth, (req, res) => {
  const { name, description, session_count, price } = req.body;
  const sc = +session_count, p = +price;
  if (!name || !(sc > 0) || !(p >= 0)) return res.status(400).json({ error: 'Lutfen tum alanlari dogru doldurun' });
  const r = db.prepare('INSERT INTO packages (name, description, session_count, price) VALUES (?,?,?,?)')
    .run(name, description || '', sc, p);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.put('/api/admin/packages/:id', requireAuth, (req, res) => {
  const { name, description, session_count, price } = req.body;
  const sc = +session_count, p = +price;
  if (!name || !(sc > 0) || !(p >= 0)) return res.status(400).json({ error: 'Lutfen tum alanlari dogru doldurun' });
  db.prepare('UPDATE packages SET name=?, description=?, session_count=?, price=? WHERE id=?')
    .run(name, description || '', sc, p, req.params.id);
  res.json({ success: true });
});

app.delete('/api/admin/packages/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM packages WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

app.get('/api/admin/customer-packages', requireAuth, (req, res) => {
  const { active } = req.query;
  let q = 'SELECT * FROM customer_packages WHERE 1=1';
  if (active === '1') q += ' AND remaining_sessions > 0';
  q += ' ORDER BY created_at DESC, id DESC';
  const customer_packages = db.prepare(q).all();
  const total = customer_packages.reduce((sum, c) => sum + c.price, 0);
  res.json({ customer_packages, total });
});

app.post('/api/admin/customer-packages', requireAuth, (req, res) => {
  const { package_id, customer_name, customer_phone, purchase_date } = req.body;
  if (!package_id || !customer_name || !customer_phone || !purchase_date) return res.status(400).json({ error: 'Lutfen tum alanlari dogru doldurun' });
  const pkg = db.prepare('SELECT * FROM packages WHERE id=?').get(package_id);
  if (!pkg) return res.status(404).json({ error: 'Paket bulunamadi' });
  const r = db.prepare(`INSERT INTO customer_packages (package_id, package_name, customer_name, customer_phone, total_sessions, remaining_sessions, price, purchase_date)
    VALUES (?,?,?,?,?,?,?,?)`).run(pkg.id, pkg.name, customer_name, customer_phone, pkg.session_count, pkg.session_count, pkg.price, purchase_date);
  upsertCustomer(customer_name, customer_phone);
  res.json({ success: true, id: r.lastInsertRowid });
});

app.post('/api/admin/customer-packages/:id/use', requireAuth, (req, res) => {
  const cp = db.prepare('SELECT * FROM customer_packages WHERE id=?').get(req.params.id);
  if (!cp) return res.status(404).json({ error: 'Kayit bulunamadi' });
  if (cp.remaining_sessions <= 0) return res.status(400).json({ error: 'Kalan seans yok' });
  db.prepare('UPDATE customer_packages SET remaining_sessions = remaining_sessions - 1 WHERE id=?').run(cp.id);
  res.json({ success: true });
});

app.delete('/api/admin/customer-packages/:id', requireAuth, (req, res) => {
  db.prepare('DELETE FROM customer_packages WHERE id=?').run(req.params.id);
  res.json({ success: true });
});

// ── Staff ──────────────────────────────────────────────────────────────────────
app.get('/api/admin/staff', requireAuth, (req, res) => {
  res.json({ staff: db.prepare('SELECT * FROM staff').all() });
});
app.post('/api/admin/staff', requireAuth, (req, res) => {
  const r = db.prepare('INSERT INTO staff (name, title, active) VALUES (?, ?, 1)').run(req.body.name, req.body.title||'Berber');
  res.json({ success:true, id: r.lastInsertRowid });
});
app.put('/api/admin/staff/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE staff SET name=?, title=?, active=? WHERE id=?')
    .run(req.body.name, req.body.title, req.body.active!=0?1:0, req.params.id);
  res.json({ success:true });
});
app.delete('/api/admin/staff/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE staff SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success:true });
});

// ── Services ───────────────────────────────────────────────────────────────────
app.get('/api/admin/services', requireAuth, (req, res) => {
  res.json({ services: db.prepare('SELECT * FROM services').all() });
});
app.post('/api/admin/services', requireAuth, (req, res) => {
  const r = db.prepare('INSERT INTO services (name, duration, price, active, sort_order) VALUES (?, ?, ?, 1, ?)')
    .run(req.body.name, +req.body.duration||30, +req.body.price||0, Date.now());
  res.json({ success:true, id: r.lastInsertRowid });
});
app.put('/api/admin/services/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE services SET name=?, duration=?, price=?, active=? WHERE id=?')
    .run(req.body.name, +req.body.duration, +req.body.price, req.body.active!=0?1:0, req.params.id);
  res.json({ success:true });
});
app.delete('/api/admin/services/:id', requireAuth, (req, res) => {
  db.prepare('UPDATE services SET active=0 WHERE id=?').run(req.params.id);
  res.json({ success:true });
});

// ── Working Hours ──────────────────────────────────────────────────────────────
app.get('/api/admin/working-hours', requireAuth, (req, res) => {
  res.json({ hours: db.prepare('SELECT day as id, day as day_of_week, open_time, close_time, is_closed FROM working_hours').all() });
});
app.put('/api/admin/working-hours/:day', requireAuth, (req, res) => {
  db.prepare('UPDATE working_hours SET open_time=?, close_time=?, is_closed=? WHERE day=?')
    .run(req.body.open_time, req.body.close_time, req.body.is_closed?1:0, req.params.day);
  res.json({ success:true });
});

// ── Settings ───────────────────────────────────────────────────────────────────
app.get('/api/admin/settings', requireAuth, (req, res) => {
  const s = getAllSettings();
  const { admin_password, session_secret, twilio_account_sid, twilio_auth_token, twilio_from_number, twilio_active, meta_access_token, meta_phone_number_id, meta_active, ...rest } = s;
  res.json({ settings: rest });
});
app.put('/api/admin/settings', requireAuth, (req, res) => {
  Object.entries(req.body.settings || {}).forEach(([k,v]) => {
    if (k !== 'admin_password') setSetting(k, v);
  });
  res.json({ success:true });
});
app.put('/api/admin/password', requireAuth, (req, res) => {
  if (!bcrypt.compareSync(req.body.current_password||'', getSetting('admin_password')||''))
    return res.status(401).json({ error: 'Mevcut sifre hatali' });
  setSetting('admin_password', bcrypt.hashSync(req.body.new_password, 10));
  res.json({ success:true });
});

// ── WhatsApp (whatsapp-web.js) ─────────────────────────────────────────────────
app.get('/api/admin/whatsapp/status', requireAuth, (req, res) => res.json({ ready:waReady, has_qr:!!waQR }));
app.get('/api/admin/whatsapp/qr', requireAuth, async (req, res) => {
  if (!waQR) return res.json({ qr:null });
  try { const QRCode = require('qrcode'); res.json({ qr: await QRCode.toDataURL(waQR) }); }
  catch { res.json({ qr:null }); }
});

// ── Twilio ─────────────────────────────────────────────────────────────────────
app.get('/api/admin/twilio', requireAuth, (req, res) => {
  const token = getSetting('twilio_auth_token');
  res.json({ twilio: {
    account_sid:  getSetting('twilio_account_sid'),
    auth_token:   token ? '***' : '',
    from_number:  getSetting('twilio_from_number'),
    active:       getSetting('twilio_active') === '1'
  }});
});
app.put('/api/admin/twilio', requireAuth, (req, res) => {
  const { account_sid, auth_token, from_number, active } = req.body;
  if (account_sid !== undefined) setSetting('twilio_account_sid', account_sid);
  if (auth_token  !== undefined && auth_token !== '***') setSetting('twilio_auth_token', auth_token);
  if (from_number !== undefined) setSetting('twilio_from_number', from_number);
  if (active      !== undefined) setSetting('twilio_active', active ? '1' : '0');
  res.json({ success:true });
});
app.post('/api/admin/twilio/test', requireAuth, async (req, res) => {
  const { test_phone } = req.body;
  if (!test_phone) return res.status(400).json({ error: 'Telefon numarasi gerekli' });
  if (!getSetting('twilio_account_sid')) return res.status(400).json({ error: 'Twilio bilgilerini kaydedin' });
  const shopName = getSetting('shop_name') || 'Salon';
  const msg = `Twilio Test Mesaji\n\n${shopName} randevu sisteminden test mesaji gonderildi.\nSistem basariyla calisiyor.`;
  const sent = await sendViaTwilio(test_phone, msg);
  if (sent) res.json({ success:true, message:'Test mesaji gonderildi!' });
  else res.status(500).json({ error:'Gonderilemedi. Twilio bilgilerini kontrol edin.' });
});

// ── Meta WhatsApp Cloud API ─────────────────────────────────────────────────────
app.get('/api/admin/meta', requireAuth, (req, res) => {
  const token = getSetting('meta_access_token');
  res.json({ meta: {
    phone_number_id: getSetting('meta_phone_number_id'),
    access_token:    token ? '***' : '',
    active:          getSetting('meta_active') === '1'
  }});
});
app.put('/api/admin/meta', requireAuth, (req, res) => {
  const { phone_number_id, access_token, active } = req.body;
  if (phone_number_id !== undefined) setSetting('meta_phone_number_id', phone_number_id);
  if (access_token    !== undefined && access_token !== '***' && access_token !== '') setSetting('meta_access_token', access_token);
  if (active          !== undefined) setSetting('meta_active', active ? '1' : '0');
  res.json({ success:true });
});
app.post('/api/admin/meta/test', requireAuth, async (req, res) => {
  const { test_phone } = req.body;
  if (!test_phone) return res.status(400).json({ error: 'Telefon numarasi gerekli' });
  if (!getSetting('meta_phone_number_id') || !getSetting('meta_access_token'))
    return res.status(400).json({ error: 'Meta bilgilerini kaydedin' });
  const result = await sendMetaTemplate(test_phone, 'hello_world', 'en_US');
  if (result.ok) res.json({ success:true, message:'Test mesaji (hello_world) gonderildi!' });
  else res.status(500).json({ error: result.error || 'Gonderilemedi. Meta bilgilerini ve numarayi kontrol edin.' });
});

app.get('/', (req, res) => res.sendFile(path.join(__dirname,'public','index.html')));
app.get('/admin*', (req, res) => res.sendFile(path.join(__dirname,'public','admin.html')));

// ── Hatirlatma Cron (her saat) ─────────────────────────────────────────────────
cron.schedule('0 * * * *', async () => {
  try {
    const now = moment();
    const apts = db.prepare(`SELECT * FROM appointments WHERE reminder_sent=0 AND reminder_enabled=1 AND status NOT IN ('rejected','cancelled') AND customer_phone != ''`).all();
    for (const apt of apts) {
      const aptTime = moment(`${apt.date} ${apt.time}`, 'YYYY-MM-DD HH:mm');
      const hoursUntil = aptTime.diff(now, 'hours', true);
      if (hoursUntil > 0 && hoursUntil <= 12) {
        const shopName  = getSetting('shop_name') || 'Salon';
        const shopPhone = getSetting('shop_phone') || '';
        const staff = apt.staff_id ? db.prepare('SELECT name FROM staff WHERE id=?').get(apt.staff_id) : null;
        const msg =
          `Randevu Hatirlatmasi\n\n` +
          `Sayin ${apt.customer_name},\n` +
          `${aptTime.format('DD MMMM YYYY')} tarihinde saat ${apt.time}'deki randevunuzu hatirlatmak istedik.\n` +
          (staff ? `Personel: ${staff.name}\n` : '') +
          `Salon: ${shopName}` +
          (shopPhone ? `\nTelefon: ${shopPhone}` : '') +
          `\n\nIptal veya degisiklik icin lutfen bizi arayin.`;
        let sent = false;
        if (getSetting('meta_active') === '1') {
          const result = await sendMetaTemplate(apt.customer_phone, 'randevu_hatirlatma', 'tr',
            [apt.customer_name, aptTime.format('DD MMMM YYYY'), apt.time, staff ? staff.name : 'Berber']);
          sent = result.ok;
        }
        if (!sent) sent = await sendWhatsApp(apt.customer_phone, msg);
        if (sent) {
          db.prepare('UPDATE appointments SET reminder_sent=1 WHERE id=?').run(apt.id);
          console.log(`Hatirlatma gonderildi: ${apt.customer_name} - ${apt.date} ${apt.time}`);
        }
      }
    }
  } catch(e) { console.error('Hatirlatma cron hatasi:', e.message); }
});

app.listen(PORT, () => {
  console.log(`\nBaloglu Randevu Sistemi Baslatildi!`);
  console.log(`Musteri:  http://localhost:${PORT}`);
  console.log(`Admin:    http://localhost:${PORT}/admin`);
  console.log(`Sifre:    admin123\n`);
});
