const { neon } = require('@neondatabase/serverless');
const bcrypt = require('bcryptjs');
const jwt = require('jsonwebtoken');

const sql = neon(process.env.DATABASE_URL || '');
const JWT_SECRET = process.env.JWT_SECRET;

function json(res, status, body, extraHeaders = {}) {
  res.status(status).setHeader('Content-Type', 'application/json; charset=utf-8');
  Object.entries(extraHeaders).forEach(([k, v]) => res.setHeader(k, v));
  return res.end(JSON.stringify(body));
}
function publicUser(u) { return { id: u.id, email: u.email, name: u.name }; }
function sign(u) { return jwt.sign({ sub: String(u.id), email: u.email }, JWT_SECRET, { expiresIn: '30d' }); }
function cookie(token) {
  return `im_session=${encodeURIComponent(token)}; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=${30 * 24 * 60 * 60}`;
}
function clearCookie() { return 'im_session=; Path=/; HttpOnly; Secure; SameSite=Lax; Max-Age=0'; }
function parseCookies(req) {
  const raw = req.headers.cookie || '';
  return Object.fromEntries(raw.split(';').filter(Boolean).map(x => {
    const i = x.indexOf('='); return [x.slice(0, i).trim(), decodeURIComponent(x.slice(i + 1).trim())];
  }));
}
function bearer(req) {
  const h = req.headers.authorization || '';
  return h.startsWith('Bearer ') ? h.slice(7) : '';
}
async function currentUser(req) {
  const token = bearer(req) || parseCookies(req).im_session;
  if (!token || !JWT_SECRET) return null;
  try {
    const p = jwt.verify(token, JWT_SECRET);
    const rows = await sql`SELECT id,email,name FROM users WHERE id=${Number(p.sub)} LIMIT 1`;
    return rows[0] || null;
  } catch (_) { return null; }
}
async function body(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  let raw = '';
  for await (const chunk of req) raw += chunk;
  if (!raw) return {};
  try { return JSON.parse(raw); } catch (_) { return {}; }
}

async function initDb() {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL is not configured');
  if (!JWT_SECRET) throw new Error('JWT_SECRET is not configured');
  await sql`
    CREATE TABLE IF NOT EXISTS users (
      id BIGSERIAL PRIMARY KEY,
      email TEXT NOT NULL UNIQUE,
      password_hash TEXT NOT NULL,
      name TEXT NOT NULL,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS user_state (
      user_id BIGINT PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
      state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`
    CREATE TABLE IF NOT EXISTS attempts (
      id BIGSERIAL PRIMARY KEY,
      user_id BIGINT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      module TEXT,
      question_id TEXT,
      correct BOOLEAN NOT NULL DEFAULT FALSE,
      answer TEXT,
      metadata_json JSONB NOT NULL DEFAULT '{}'::jsonb,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    )`;
  await sql`CREATE INDEX IF NOT EXISTS idx_attempts_user_created ON attempts(user_id, created_at DESC)`;
}

module.exports = async function handler(req, res) {
  const path = '/' + ((req.query && req.query.path) ? (Array.isArray(req.query.path) ? req.query.path.join('/') : req.query.path) : '');
  try {
    await initDb();

    if (req.method === 'OPTIONS') return json(res, 204, {});
    if (path === '/health' && req.method === 'GET') return json(res, 200, { ok: true, database: 'PostgreSQL', time: new Date().toISOString() });

    if (path === '/auth/register' && req.method === 'POST') {
      const b = await body(req);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      if (!/^\S+@\S+\.\S+$/.test(email)) return json(res, 400, { error: 'Valid email is required' });
      if (password.length < 8) return json(res, 400, { error: 'Password must be at least 8 characters' });
      const exists = await sql`SELECT id FROM users WHERE LOWER(email)=LOWER(${email}) LIMIT 1`;
      if (exists.length) return json(res, 409, { error: 'Account already exists. Sign in instead.' });
      const name = (email.split('@')[0] || 'Candidate').replace(/[._-]+/g, ' ').trim() || 'Candidate';
      const hash = await bcrypt.hash(password, 12);
      const rows = await sql`INSERT INTO users(email,password_hash,name) VALUES(${email},${hash},${name}) RETURNING id,email,name`;
      const u = rows[0];
      const initial = { user: publicUser(u), questions: 0, correct: 0, score: 0, streak: 0, lastDay: null, history: [], plans: [], aptitudeDone: {}, bankProgress: {}, commProgress: {} };
      await sql`INSERT INTO user_state(user_id,state_json) VALUES(${u.id},${JSON.stringify(initial)}::jsonb)`;
      const t = sign(u);
      return json(res, 201, { token: t, user: publicUser(u), state: initial }, { 'Set-Cookie': cookie(t) });
    }

    if (path === '/auth/login' && req.method === 'POST') {
      const b = await body(req);
      const email = String(b.email || '').trim().toLowerCase();
      const password = String(b.password || '');
      const rows = await sql`SELECT * FROM users WHERE LOWER(email)=LOWER(${email}) LIMIT 1`;
      if (!rows.length || !(await bcrypt.compare(password, rows[0].password_hash))) return json(res, 401, { error: 'Invalid email or password' });
      const u = rows[0];
      const stateRows = await sql`SELECT state_json FROM user_state WHERE user_id=${u.id} LIMIT 1`;
      const state = stateRows[0] ? stateRows[0].state_json : { user: publicUser(u) };
      const t = sign(u);
      return json(res, 200, { token: t, user: publicUser(u), state }, { 'Set-Cookie': cookie(t) });
    }

    if (path === '/auth/logout' && req.method === 'POST') return json(res, 200, { ok: true }, { 'Set-Cookie': clearCookie() });

    const user = await currentUser(req);
    if (!user) return json(res, 401, { error: 'Authentication required' });

    if (path === '/me' && req.method === 'GET') return json(res, 200, { user: publicUser(user) });

    if (path === '/state' && req.method === 'GET') {
      const rows = await sql`SELECT state_json,updated_at FROM user_state WHERE user_id=${user.id} LIMIT 1`;
      return json(res, 200, { state: rows[0]?.state_json || {}, updatedAt: rows[0]?.updated_at || null });
    }

    if (path === '/state' && req.method === 'PUT') {
      const b = await body(req);
      if (!b.state || typeof b.state !== 'object') return json(res, 400, { error: 'state object required' });
      const state = { ...b.state, user: publicUser(user) };
      await sql`
        INSERT INTO user_state(user_id,state_json,updated_at) VALUES(${user.id},${JSON.stringify(state)}::jsonb,NOW())
        ON CONFLICT(user_id) DO UPDATE SET state_json=EXCLUDED.state_json, updated_at=NOW()`;
      await sql`UPDATE users SET updated_at=NOW() WHERE id=${user.id}`;
      return json(res, 200, { ok: true, updatedAt: new Date().toISOString() });
    }

    if (path === '/attempts' && req.method === 'POST') {
      const b = await body(req);
      const rows = await sql`
        INSERT INTO attempts(user_id,module,question_id,correct,answer,metadata_json)
        VALUES(${user.id},${String(b.module || '')},${String(b.questionId || '')},${!!b.correct},${String(b.answer || '')},${JSON.stringify(b.metadata || {})}::jsonb)
        RETURNING id`;
      return json(res, 201, { ok: true, id: rows[0].id });
    }

    if (path === '/attempts' && req.method === 'GET') {
      const limit = Math.min(Math.max(Number(req.query.limit || 50), 1), 200);
      const rows = await sql`SELECT id,module,question_id,correct,answer,metadata_json,created_at FROM attempts WHERE user_id=${user.id} ORDER BY id DESC LIMIT ${limit}`;
      return json(res, 200, { attempts: rows.map(x => ({ ...x, metadata: x.metadata_json || {} })) });
    }

    if (path === '/admin/stats' && req.method === 'GET') {
      const [u, a] = await Promise.all([sql`SELECT COUNT(*)::int AS count FROM users`, sql`SELECT COUNT(*)::int AS count FROM attempts`]);
      return json(res, 200, { users: u[0].count, attempts: a[0].count });
    }

    return json(res, 404, { error: 'API route not found' });
  } catch (err) {
    console.error(err);
    return json(res, 500, { error: 'Server error', detail: process.env.NODE_ENV === 'development' ? err.message : undefined });
  }
};
