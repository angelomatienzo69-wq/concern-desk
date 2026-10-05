// Student Concern Routing & Resolution Tracking System (Node 22.13+)
// Database: PostgreSQL when DATABASE_URL is set (production / free hosting), otherwise a local SQLite file (zero install).
const http = require('http'), fs = require('fs'), path = require('path'), crypto = require('crypto');
const { AsyncLocalStorage } = require('async_hooks');
const PORT = process.env.PORT || 3000;
const PG_URL = process.env.DATABASE_URL;
const DB_FILE = process.env.DB_PATH || path.join(__dirname, 'data.db');
const SEED_PASSWORD = process.env.SEED_PASSWORD || 'Demo@12345';
const SCHEMA = `
CREATE TABLE IF NOT EXISTS departments(dept_id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL);
CREATE TABLE IF NOT EXISTS users(user_id INTEGER PRIMARY KEY, full_name TEXT NOT NULL, email TEXT UNIQUE NOT NULL,
  password_hash TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN('student','staff','admin')),
  dept_id INTEGER REFERENCES departments(dept_id), is_active INTEGER NOT NULL DEFAULT 1, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS categories(category_id INTEGER PRIMARY KEY, name TEXT UNIQUE NOT NULL,
  dept_id INTEGER NOT NULL REFERENCES departments(dept_id));
CREATE TABLE IF NOT EXISTS concerns(concern_id INTEGER PRIMARY KEY, ref_no TEXT UNIQUE NOT NULL,
  student_id INTEGER NOT NULL REFERENCES users(user_id), category_id INTEGER NOT NULL REFERENCES categories(category_id),
  dept_id INTEGER NOT NULL REFERENCES departments(dept_id), assigned_to INTEGER REFERENCES users(user_id),
  subject TEXT NOT NULL, description TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'Normal' CHECK(priority IN('Low','Normal','Urgent')),
  status TEXT NOT NULL DEFAULT 'Submitted', due_at TEXT NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP, updated_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS concern_logs(log_id INTEGER PRIMARY KEY, concern_id INTEGER NOT NULL REFERENCES concerns(concern_id),
  actor_id INTEGER NOT NULL REFERENCES users(user_id), from_status TEXT, to_status TEXT NOT NULL, remarks TEXT, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS notifications(notif_id INTEGER PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(user_id),
  concern_id INTEGER REFERENCES concerns(concern_id), message TEXT NOT NULL, is_read INTEGER DEFAULT 0, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS attachments(attachment_id INTEGER PRIMARY KEY, concern_id INTEGER NOT NULL REFERENCES concerns(concern_id),
  uploaded_by INTEGER NOT NULL REFERENCES users(user_id), filename TEXT NOT NULL, mime TEXT NOT NULL, size INTEGER NOT NULL, data BLOB NOT NULL, created_at TEXT DEFAULT CURRENT_TIMESTAMP);
CREATE TABLE IF NOT EXISTS sessions(token TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(user_id), expires INTEGER NOT NULL);
`;
// ---- database layer: q = all rows, one = first row, run = write (returns lastInsertRowid), tx = transaction
const als = new AsyncLocalStorage();
const nn = a => a.map(v => v === undefined ? null : v);
const PK = { users: 'user_id', departments: 'dept_id', categories: 'category_id', concerns: 'concern_id', concern_logs: 'log_id', notifications: 'notif_id', attachments: 'attachment_id' };
const NOW_PG = "to_char(now() at time zone 'utc','YYYY-MM-DD HH24:MI:SS')";
const toPg = s => { let i = 0; return s.replace(/datetime\('now'\)/g, NOW_PG).replace(/ LIKE /g, ' ILIKE ').replace(/\?/g, () => '$' + (++i)); };
const pgSchema = s => s.replace(/INTEGER PRIMARY KEY/g, 'SERIAL PRIMARY KEY').replace(/\bBLOB\b/g, 'BYTEA').replace(/expires INTEGER/, 'expires BIGINT')
  .replace(/TEXT DEFAULT CURRENT_TIMESTAMP/g, 'TEXT DEFAULT (' + NOW_PG + ')');
let sdb, pool;
if (PG_URL) {
  const pg = require('pg');
  pg.types.setTypeParser(20, Number);   // COUNT(*) / BIGINT come back as numbers, not strings
  pool = new pg.Pool({ connectionString: PG_URL, max: 5, ssl: /localhost|127\.0\.0\.1/.test(PG_URL) ? false : { rejectUnauthorized: false } });
} else {
  const { DatabaseSync } = require('node:sqlite');
  sdb = new DatabaseSync(DB_FILE);
  sdb.exec('PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL;');
}
const pgq = (s, a) => (als.getStore() || pool).query(toPg(s), nn(a));
const q = async (s, ...a) => PG_URL ? (await pgq(s, a)).rows : sdb.prepare(s).all(...nn(a));
const one = async (s, ...a) => PG_URL ? (await pgq(s, a)).rows[0] : sdb.prepare(s).get(...nn(a));
const run = async (s, ...a) => {
  if (!PG_URL) return sdb.prepare(s).run(...nn(a));
  const pk = PK[(/^\s*INSERT INTO (\w+)/i.exec(s) || [])[1]];
  const r = await pgq(pk ? s + ' RETURNING ' + pk : s, a);
  return { lastInsertRowid: pk ? r.rows[0][pk] : 0, changes: r.rowCount };
};
const tx = async fn => {
  if (!PG_URL) { sdb.exec('BEGIN'); try { const r = await fn(); sdb.exec('COMMIT'); return r; } catch (e) { sdb.exec('ROLLBACK'); throw e; } }
  const c = await pool.connect();
  try { await c.query('BEGIN'); const r = await als.run(c, fn); await c.query('COMMIT'); return r; }
  catch (e) { await c.query('ROLLBACK').catch(() => {}); throw e; } finally { c.release(); }
};
const each = async (arr, f) => { for (const x of arr) await f(x); };
async function init() {
  if (PG_URL) await pool.query(pgSchema(SCHEMA)); else sdb.exec(SCHEMA);
  await seed();
}
const hash = p => { const s = crypto.randomBytes(16).toString('hex'); return s + ':' + crypto.scryptSync(p, s, 32).toString('hex'); };
const verify = (p, h) => { const [s, k] = h.split(':'); return crypto.timingSafeEqual(Buffer.from(k, 'hex'), crypto.scryptSync(p, s, 32)); };
const now = () => new Date().toISOString().replace('T', ' ').slice(0, 19);
const SLA_DAYS = { Urgent: 1, Normal: 3, Low: 5 };            // Business rule 2
const due = (pr, from = new Date()) => new Date(from.getTime() + SLA_DAYS[pr] * 864e5).toISOString().replace('T', ' ').slice(0, 19);
// Business rule 3: allowed workflow transitions per role
const FLOW = {
  Submitted: { staff: ['Under Review', 'Rejected'], student: ['Cancelled'] },
  'Under Review': { staff: ['In Progress', 'Rejected'] },
  'In Progress': { staff: ['Resolved'] },
  Resolved: { student: ['Closed', 'In Progress'] },
};
const NEEDS_REMARKS = ['Rejected', 'Resolved'];

async function createConcern(studentId, categoryId, subject, description, priority) {
  const cat = (await one('SELECT * FROM categories WHERE category_id=?', categoryId));
  const ref = 'SC-' + new Date().getFullYear() + '-' + String((await one('SELECT COUNT(*)+1 n FROM concerns')).n).padStart(4, '0');
  const staff = (await one("SELECT user_id FROM users WHERE role='staff' AND is_active=1 AND dept_id=? ORDER BY (SELECT COUNT(*) FROM concerns c WHERE c.assigned_to=users.user_id AND c.status IN('Submitted','Under Review','In Progress')) LIMIT 1", cat.dept_id));
  const r = (await run('INSERT INTO concerns(ref_no,student_id,category_id,dept_id,assigned_to,subject,description,priority,due_at) VALUES(?,?,?,?,?,?,?,?,?)',
    ref, studentId, categoryId, cat.dept_id, staff ? staff.user_id : null, subject, description, priority, due(priority)));
  const id = Number(r.lastInsertRowid);
  (await run('INSERT INTO concern_logs(concern_id,actor_id,to_status,remarks) VALUES(?,?,?,?)', id, studentId, 'Submitted', 'Auto-routed to ' + (await one('SELECT name FROM departments WHERE dept_id=?', cat.dept_id)).name));
  if (staff) (await run('INSERT INTO notifications(user_id,concern_id,message) VALUES(?,?,?)', staff.user_id, id, `New concern ${ref} routed to you: ${subject}`));
  return id;
}
async function transition(c, actor, to, remarks) {
  const allowed = (FLOW[c.status] || {})[actor.role === 'admin' ? 'staff' : actor.role] || [];
  if (!allowed.includes(to)) throw new HttpErr(409, `Cannot move from ${c.status} to ${to}`);
  if (NEEDS_REMARKS.includes(to) && !(remarks || '').trim()) throw new HttpErr(400, `Remarks are required when marking as ${to}`);
  (await run('UPDATE concerns SET status=?,updated_at=? WHERE concern_id=?', to, now(), c.concern_id));
  (await run('INSERT INTO concern_logs(concern_id,actor_id,from_status,to_status,remarks) VALUES(?,?,?,?,?)', c.concern_id, actor.user_id, c.status, to, remarks || null));
  const notify = actor.role === 'student' ? c.assigned_to : c.student_id;
  if (notify) (await run('INSERT INTO notifications(user_id,concern_id,message) VALUES(?,?,?)', notify, c.concern_id, `${c.ref_no} is now "${to}"`));
}
async function seed() {
  if ((await one('SELECT COUNT(*) n FROM users')).n) return;
  const P = hash(SEED_PASSWORD);
  await each(['Registrar Office', 'Student Affairs', 'Finance Office', 'IT Services'], async n => (await run('INSERT INTO departments(name) VALUES(?)', n)));
  await each([['Enrollment & Records', 1], ['Grades Dispute', 1], ['Scholarship & Welfare', 2], ['Discipline & Safety', 2], ['Tuition & Fees', 3], ['Refunds', 3], ['Account & Wi-Fi Access', 4], ['LMS / Portal Issues', 4]],
    async ([n, d]) => (await run('INSERT INTO categories(name,dept_id) VALUES(?,?)', n, d)));
  const U = async (n, e, r, d) => Number((await run('INSERT INTO users(full_name,email,password_hash,role,dept_id) VALUES(?,?,?,?,?)', n, e, P, r, d)).lastInsertRowid);
  await U('System Admin', 'demo.admin@email.com', 'admin', null);
  await U('Reggie Santos (Registrar)', 'registrar@school.edu', 'staff', 1); await U('Amy Cruz (Student Affairs)', 'affairs@school.edu', 'staff', 2);
  await U('Paolo Reyes (Finance)', 'finance@school.edu', 'staff', 3); await U('Iris Lim (IT)', 'it@school.edu', 'staff', 4);
  const s = [await U('Demo Student', 'demo.user@email.com', 'student'), await U('Ana Dela Cruz', 'ana@student.edu', 'student'), await U('Mark Villanueva', 'mark@student.edu', 'student')];
  const S = [[1, 'Missing subject in enrollment', 'Subject CS101 does not appear on my enrollment form.', 'Normal'], [2, 'Wrong midterm grade', 'My midterm grade shows 74 but my computed score is 88.', 'Normal'],
    [3, 'Scholarship renewal status', 'Asking about the status of my renewal documents.', 'Low'], [4, 'Locker theft report', 'My laptop was taken from the locker room.', 'Urgent'],
    [5, 'Double charged tuition', 'I was charged twice for the second installment.', 'Urgent'], [6, 'Refund for dropped subject', 'Requesting refund for PE2 dropped in week 1.', 'Normal'],
    [7, 'Cannot log in to Wi-Fi', 'Campus Wi-Fi rejects my student credentials.', 'Normal'], [8, 'LMS quiz not showing', 'The Quiz 2 link is blank in the LMS.', 'Urgent'],
    [1, 'Request for TOR copy', 'Need transcript for scholarship application.', 'Low'], [7, 'Email account locked', 'My school email is locked after password reset.', 'Normal']];
  const ids = []; for (const [i, c] of S.entries()) ids.push((await createConcern(s[i % 3], c[0], c[1], c[2], c[3])));
  const A = async u => (await one('SELECT * FROM users WHERE user_id=?', u)), C = async i => (await one('SELECT * FROM concerns WHERE concern_id=?', i));
  const step = async (i, to, r) => { const c = await C(ids[i]); (await transition(c, c.assigned_to ? await A(c.assigned_to) : await A(1), to, r)); };
  await step(1, 'Under Review'); await step(2, 'Under Review'); await step(2, 'In Progress'); await step(3, 'Under Review'); await step(4, 'Under Review'); await step(4, 'In Progress'); await step(4, 'Resolved', 'Duplicate charge reversed.');
  await step(5, 'Rejected', 'Course was dropped after the refund deadline.'); await step(6, 'Under Review'); await step(6, 'In Progress'); await step(6, 'Resolved', 'Password reset and Wi-Fi profile re-synced.');
  const c6 = await C(ids[6]); (await transition(c6, await A(c6.student_id), 'Closed', 'Works now, thank you.'));
  (await run('UPDATE concerns SET due_at=? WHERE concern_id=?', due('Low', new Date(Date.now() - 7 * 864e5)), ids[7])); // seeded overdue example
}

class HttpErr extends Error { constructor(c, m) { super(m); this.code = c; } }
const send = (res, code, data, h = {}) => { res.writeHead(code, { 'Content-Type': 'application/json', ...h }); res.end(JSON.stringify(data)); };
const body = (req, max = 1e5) => new Promise((ok, no) => { let b = ''; req.on('data', d => { b += d; if (b.length > max) { no(new HttpErr(413, 'Request too large')); req.destroy(); } }); req.on('end', () => { try { ok(b ? JSON.parse(b) : {}); } catch { no(new HttpErr(400, 'Invalid JSON')); } }); });
const need = (o, ...k) => k.forEach(f => { if (!String(o[f] ?? '').trim()) throw new HttpErr(400, `${f.replace('_', ' ')} is required`); });
const cookie = req => Object.fromEntries((req.headers.cookie || '').split(';').map(c => c.trim().split('=')).filter(c => c[0]));
const ALLOW = { 'image/png': ['png'], 'image/jpeg': ['jpg', 'jpeg'], 'application/pdf': ['pdf'], 'application/msword': ['doc'], 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['docx'], 'text/plain': ['txt'] };
const MAGIC = { 'image/png': [0x89, 0x50, 0x4e, 0x47], 'image/jpeg': [0xff, 0xd8, 0xff], 'application/pdf': [0x25, 0x50, 0x44, 0x46] };
const CLOSED = ['Closed', 'Cancelled', 'Rejected'], MAX_FILE = 2 * 1024 * 1024, MAX_FILES = 5;
const SEL = `SELECT c.*, s.full_name student_name, cat.name category, d.name department, a.full_name assignee,
  CASE WHEN c.status IN('Submitted','Under Review','In Progress') AND c.due_at < datetime('now') THEN 1 ELSE 0 END overdue
  FROM concerns c JOIN users s ON s.user_id=c.student_id JOIN categories cat ON cat.category_id=c.category_id
  JOIN departments d ON d.dept_id=c.dept_id LEFT JOIN users a ON a.user_id=c.assigned_to`;
function scope(u) { // role-based visibility (Business rule 1)
  if (u.role === 'student') return [' WHERE c.student_id=?', [u.user_id]];
  if (u.role === 'staff') return [' WHERE c.dept_id=?', [u.dept_id]];
  return [' WHERE 1=1', []];
}
async function visible(u, id) { const [w, p] = scope(u); const c = (await one(SEL + w + ' AND c.concern_id=?', ...p, id)); if (!c) throw new HttpErr(404, 'Concern not found'); return c; }
async function list(u, url) {
  let [w, p] = scope(u); const g = url.searchParams;
  if (g.get('status')) { w += ' AND c.status=?'; p.push(g.get('status')); }
  if (g.get('dept') && u.role === 'admin') { w += ' AND c.dept_id=?'; p.push(g.get('dept')); }
  if (g.get('overdue') === '1') w += " AND c.status IN('Submitted','Under Review','In Progress') AND c.due_at < datetime('now')";
  if (g.get('q')) { w += ' AND (c.subject LIKE ? OR c.ref_no LIKE ? OR s.full_name LIKE ?)'; const l = '%' + g.get('q') + '%'; p.push(l, l, l); }
  const sorts = { newest: 'c.created_at DESC', oldest: 'c.created_at ASC', due: 'c.due_at ASC', priority: "CASE c.priority WHEN 'Urgent' THEN 0 WHEN 'Normal' THEN 1 ELSE 2 END, c.created_at DESC" };
  return (await q(SEL + w + ' ORDER BY ' + (sorts[g.get('sort')] || sorts.newest), ...p));
}

async function api(req, res, url) {
  const m = req.method, p = url.pathname;
  const send_ = (d, c = 200, h) => send(res, c, d, h);
  if (m === 'POST' && p === '/api/login') {
    const b = await body(req); need(b, 'email', 'password');
    const u = (await one('SELECT * FROM users WHERE email=?', b.email.trim().toLowerCase()));
    if (!u || !verify(b.password, u.password_hash)) throw new HttpErr(401, 'Invalid email or password');
    if (!u.is_active) throw new HttpErr(403, 'Account is deactivated');
    const t = crypto.randomBytes(32).toString('hex'); (await run('INSERT INTO sessions VALUES(?,?,?)', t, u.user_id, Date.now() + 864e5));
    return send_({ ok: true }, 200, { 'Set-Cookie': `sid=${t}; HttpOnly; SameSite=Lax; Path=/; Max-Age=86400${process.env.NODE_ENV === 'production' ? '; Secure' : ''}` });
  }
  if (m === 'POST' && p === '/api/register') {
    const b = await body(req); need(b, 'full_name', 'email', 'password');
    if (!/^\S+@\S+\.\S+$/.test(b.email)) throw new HttpErr(400, 'Invalid email format');
    if (b.password.length < 8) throw new HttpErr(400, 'Password must be at least 8 characters');
    if ((await one('SELECT 1 FROM users WHERE email=?', b.email.toLowerCase()))) throw new HttpErr(409, 'Email already registered');
    (await run("INSERT INTO users(full_name,email,password_hash,role) VALUES(?,?,?,'student')", b.full_name.trim(), b.email.trim().toLowerCase(), hash(b.password)));
    return send_({ ok: true }, 201);
  }
  const sid = cookie(req).sid;
  const sess = sid && (await one('SELECT * FROM sessions WHERE token=? AND expires>?', sid, Date.now()));
  const user = sess && (await one('SELECT user_id,full_name,email,role,dept_id,is_active FROM users WHERE user_id=?', sess.user_id));
  if (m === 'GET' && p === '/api/me') return send_(user ? { ...user, dept: user.dept_id ? (await one('SELECT name FROM departments WHERE dept_id=?', user.dept_id)).name : null } : null);
  if (!user || !user.is_active) throw new HttpErr(401, 'Please log in');
  if (m === 'POST' && p === '/api/logout') { (await run('DELETE FROM sessions WHERE token=?', sid)); return send_({ ok: true }, 200, { 'Set-Cookie': 'sid=; Path=/; Max-Age=0' }); }
  if (m === 'GET' && p === '/api/meta') return send_({ departments: (await q('SELECT * FROM departments')), categories: (await q('SELECT c.*,d.name dept FROM categories c JOIN departments d USING(dept_id)')), statuses: ['Submitted', 'Under Review', 'In Progress', 'Resolved', 'Closed', 'Rejected', 'Cancelled'] });
  if (m === 'GET' && p === '/api/concerns') return send_((await list(user, url)));
  if (m === 'GET' && p === '/api/export.csv') {
    if (user.role === 'student') throw new HttpErr(403, 'Not allowed');
    const esc = v => '"' + String(v ?? '').replace(/"/g, '""') + '"', rows = (await list(user, url));
    const csv = ['Ref,Student,Category,Department,Priority,Status,Assignee,Created,Due,Overdue'].concat(rows.map(r => [r.ref_no, r.student_name, r.category, r.department, r.priority, r.status, r.assignee, r.created_at, r.due_at, r.overdue ? 'Yes' : 'No'].map(esc).join(','))).join('\n');
    res.writeHead(200, { 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename=concerns.csv' }); return res.end(csv);
  }
  if (m === 'POST' && p === '/api/concerns') {
    if (user.role !== 'student') throw new HttpErr(403, 'Only students can submit concerns');
    const b = await body(req); need(b, 'category_id', 'subject', 'description');
    if (b.subject.length > 120) throw new HttpErr(400, 'Subject must be 120 characters or fewer');
    if (b.description.trim().length < 15) throw new HttpErr(400, 'Description must be at least 15 characters');
    if (!(await one('SELECT 1 FROM categories WHERE category_id=?', b.category_id))) throw new HttpErr(400, 'Invalid category');
    const pr = ['Low', 'Normal', 'Urgent'].includes(b.priority) ? b.priority : 'Normal';
    const open = (await one("SELECT COUNT(*) n FROM concerns WHERE student_id=? AND status IN('Submitted','Under Review','In Progress')", user.user_id)).n;
    if (open >= 5) throw new HttpErr(409, 'You already have 5 open concerns. Wait for some to be resolved.'); // Business rule 4
    return send_({ concern_id: (await createConcern(user.user_id, +b.category_id, b.subject.trim(), b.description.trim(), pr)) }, 201);
  }
  if (m === 'GET' && p === '/api/dashboard') {
    const [w, pr] = scope(user), base = SEL.replace(/^SELECT .*? FROM concerns c/s, 'SELECT c.* FROM concerns c');
    const rows = (await q(`SELECT c.status, c.priority, d.name dept, CASE WHEN c.status IN('Submitted','Under Review','In Progress') AND c.due_at<datetime('now') THEN 1 ELSE 0 END od FROM concerns c JOIN departments d USING(dept_id)` + w, ...pr));
    const by = k => rows.reduce((a, r) => (a[r[k]] = (a[r[k]] || 0) + 1, a), {});
    return send_({ total: rows.length, overdue: rows.filter(r => r.od).length, byStatus: by('status'), byPriority: by('priority'), byDept: by('dept') });
  }
  let mm;
  if ((mm = p.match(/^\/api\/concerns\/(\d+)$/)) && m === 'GET') {
    const c = (await visible(user, mm[1]));
    return send_({ ...c, attachments: (await q('SELECT a.attachment_id,a.filename,a.mime,a.size,a.uploaded_by,u.full_name uploader FROM attachments a JOIN users u ON u.user_id=a.uploaded_by WHERE a.concern_id=? ORDER BY a.attachment_id', c.concern_id)), logs: (await q('SELECT l.*,u.full_name actor FROM concern_logs l JOIN users u ON u.user_id=l.actor_id WHERE concern_id=? ORDER BY log_id', c.concern_id)) });
  }
  if ((mm = p.match(/^\/api\/concerns\/(\d+)$/)) && m === 'PUT') {
    const c = (await visible(user, mm[1])); if (user.role !== 'student' || c.status !== 'Submitted') throw new HttpErr(409, 'Only the student can edit, and only while status is Submitted');
    const b = await body(req); need(b, 'subject', 'description');
    (await run('UPDATE concerns SET subject=?,description=?,priority=?,due_at=?,updated_at=? WHERE concern_id=?', b.subject.trim(), b.description.trim(), b.priority, due(b.priority), now(), c.concern_id));
    return send_({ ok: true });
  }
  if ((mm = p.match(/^\/api\/concerns\/(\d+)\/action$/)) && m === 'POST') {
    const c = (await visible(user, mm[1])), b = await body(req); need(b, 'to');
    await tx(async () => (await transition(c, user, b.to, b.remarks)));
    return send_({ ok: true });
  }
  if ((mm = p.match(/^\/api\/concerns\/(\d+)\/reroute$/)) && m === 'POST') {
    if (user.role !== 'admin') throw new HttpErr(403, 'Admin only'); const c = (await visible(user, mm[1])), b = await body(req); need(b, 'category_id');
    const cat = (await one('SELECT * FROM categories WHERE category_id=?', b.category_id)); if (!cat) throw new HttpErr(400, 'Invalid category');
    const st = (await one("SELECT user_id FROM users WHERE role='staff' AND dept_id=? AND is_active=1", cat.dept_id));
    (await run('UPDATE concerns SET category_id=?,dept_id=?,assigned_to=? WHERE concern_id=?', cat.category_id, cat.dept_id, st ? st.user_id : null, c.concern_id));
    (await run('INSERT INTO concern_logs(concern_id,actor_id,from_status,to_status,remarks) VALUES(?,?,?,?,?)', c.concern_id, user.user_id, c.status, c.status, 'Re-routed to ' + cat.name));
    return send_({ ok: true });
  }
  if ((mm = p.match(/^\/api\/concerns\/(\d+)\/attachments$/)) && m === 'POST') {
    const c = (await visible(user, mm[1])); if (CLOSED.includes(c.status)) throw new HttpErr(409, `Cannot attach files to a ${c.status.toLowerCase()} concern`);
    const b = await body(req, 3.2e6); need(b, 'filename', 'mime', 'data');
    const ext = b.filename.split('.').pop().toLowerCase();
    if (!ALLOW[b.mime] || !ALLOW[b.mime].includes(ext)) throw new HttpErr(400, 'Allowed files: PNG, JPG, PDF, DOC, DOCX, TXT');
    const buf = Buffer.from(b.data, 'base64'); if (!buf.length) throw new HttpErr(400, 'File is empty');
    if (buf.length > MAX_FILE) throw new HttpErr(400, 'File must be 2 MB or smaller');
    if (MAGIC[b.mime] && !MAGIC[b.mime].every((x, i) => buf[i] === x)) throw new HttpErr(400, 'File content does not match its type');
    if ((await one('SELECT COUNT(*) n FROM attachments WHERE concern_id=?', c.concern_id)).n >= MAX_FILES) throw new HttpErr(409, `Maximum of ${MAX_FILES} files per concern`);
    const name = b.filename.replace(/[^\w.\- ]/g, '_').slice(0, 100);
    (await run('INSERT INTO attachments(concern_id,uploaded_by,filename,mime,size,data) VALUES(?,?,?,?,?,?)', c.concern_id, user.user_id, name, b.mime, buf.length, buf));
    (await run('INSERT INTO concern_logs(concern_id,actor_id,from_status,to_status,remarks) VALUES(?,?,?,?,?)', c.concern_id, user.user_id, c.status, c.status, 'Attached file: ' + name));
    return send_({ ok: true }, 201);
  }
  if ((mm = p.match(/^\/api\/attachments\/(\d+)$/))) {
    const a = (await one('SELECT * FROM attachments WHERE attachment_id=?', mm[1])); if (!a) throw new HttpErr(404, 'File not found');
    const c = (await visible(user, a.concern_id));
    if (m === 'GET') { const inl = a.mime.startsWith('image/') || a.mime === 'application/pdf'; res.writeHead(200, { 'Content-Type': a.mime, 'Content-Disposition': `${inl ? 'inline' : 'attachment'}; filename="${a.filename}"`, 'X-Content-Type-Options': 'nosniff' }); return res.end(Buffer.from(a.data)); }
    if (m === 'DELETE') {
      if (a.uploaded_by !== user.user_id && user.role !== 'admin') throw new HttpErr(403, 'Only the uploader can remove this file');
      if (CLOSED.includes(c.status)) throw new HttpErr(409, 'Concern is no longer open');
      (await run('DELETE FROM attachments WHERE attachment_id=?', a.attachment_id));
      (await run('INSERT INTO concern_logs(concern_id,actor_id,from_status,to_status,remarks) VALUES(?,?,?,?,?)', c.concern_id, user.user_id, c.status, c.status, 'Removed file: ' + a.filename));
      return send_({ ok: true });
    }
  }
  if (m === 'GET' && p === '/api/notifications') return send_((await q('SELECT * FROM notifications WHERE user_id=? ORDER BY notif_id DESC LIMIT 30', user.user_id)));
  if (m === 'POST' && p === '/api/notifications/read') { (await run('UPDATE notifications SET is_read=1 WHERE user_id=?', user.user_id)); return send_({ ok: true }); }
  if (p.startsWith('/api/admin')) {
    if (user.role !== 'admin') throw new HttpErr(403, 'Admin only');
    if (m === 'GET' && p === '/api/admin/users') return send_((await q('SELECT u.user_id,u.full_name,u.email,u.role,u.is_active,d.name dept FROM users u LEFT JOIN departments d USING(dept_id) ORDER BY u.role,u.full_name')));
    if (m === 'POST' && p === '/api/admin/users') {
      const b = await body(req); need(b, 'full_name', 'email', 'password', 'role');
      if (!['staff', 'admin', 'student'].includes(b.role)) throw new HttpErr(400, 'Invalid role');
      if (b.role === 'staff' && !b.dept_id) throw new HttpErr(400, 'Staff must belong to a department');
      if (b.password.length < 8) throw new HttpErr(400, 'Password must be at least 8 characters');
      if ((await one('SELECT 1 FROM users WHERE email=?', b.email.toLowerCase()))) throw new HttpErr(409, 'Email already registered');
      (await run('INSERT INTO users(full_name,email,password_hash,role,dept_id) VALUES(?,?,?,?,?)', b.full_name, b.email.toLowerCase(), hash(b.password), b.role, b.role === 'staff' ? +b.dept_id : null));
      return send_({ ok: true }, 201);
    }
    if ((mm = p.match(/^\/api\/admin\/users\/(\d+)\/toggle$/)) && m === 'POST') {
      if (+mm[1] === user.user_id) throw new HttpErr(409, 'You cannot deactivate yourself');
      (await run('UPDATE users SET is_active=1-is_active WHERE user_id=?', mm[1])); return send_({ ok: true });
    }
    if (m === 'POST' && p === '/api/admin/categories') { const b = await body(req); need(b, 'name', 'dept_id'); (await run('INSERT INTO categories(name,dept_id) VALUES(?,?)', b.name.trim(), +b.dept_id)); return send_({ ok: true }, 201); }
  }
  throw new HttpErr(404, 'Not found');
}
const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml' };
const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, 'http://x');
  try {
    if (url.pathname.startsWith('/api/')) return await api(req, res, url);
    const f = path.join(__dirname, 'public', url.pathname === '/' ? 'index.html' : path.normalize(url.pathname).replace(/^(\.\.[\/\\])+/, ''));
    if (!f.startsWith(path.join(__dirname, 'public')) || !fs.existsSync(f)) { res.writeHead(404); return res.end('Not found'); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(f)] || 'application/octet-stream' }); fs.createReadStream(f).pipe(res);
  } catch (e) {
    if (e instanceof HttpErr) return send(res, e.code, { error: e.message });
    if (e.code === '23505' || String(e.message).includes('UNIQUE')) return send(res, 409, { error: 'Record already exists' });
    console.error(e); send(res, 500, { error: 'Server error' });
  }
});
init().then(() => server.listen(PORT, () => console.log(`Student Concern System running → http://localhost:${PORT} (${PG_URL ? 'PostgreSQL' : 'SQLite'})`)))
  .catch(e => { console.error('Startup failed:', e); process.exit(1); });
