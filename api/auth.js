// DepthData auth — /api/auth
// Self-serve accounts. Each signup creates an account plus a workspace.
// Sessions are stateless signed tokens (HMAC-SHA256 over payload with DD_SECRET).
//
// POST /api/auth?action=signup {name,email,password,company} -> {ok, token, ws}
// POST /api/auth?action=signin {email,password}              -> {ok, token, ws}
// GET  /api/auth?action=me      header authorization: Bearer <token> -> {ok, account, ws}
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, DD_SECRET (any long random string)

import { createHmac, createHash, scryptSync, randomBytes, timingSafeEqual } from 'crypto';

const SB = () => process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';

function sb(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(SB() + path, {
    ...opts,
    headers: {
      apikey: key, Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json', Prefer: 'return=representation',
      ...(opts && opts.headers),
    },
  });
}

function hashPass(pw) {
  const salt = randomBytes(16).toString('hex');
  return salt + ':' + scryptSync(pw, salt, 32).toString('hex');
}
function checkPass(pw, stored) {
  const [salt, hex] = String(stored).split(':');
  if (!salt || !hex) return false;
  const a = scryptSync(pw, salt, 32);
  const b = Buffer.from(hex, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}

export function signToken(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = createHmac('sha256', process.env.DD_SECRET).update(body).digest('base64url');
  return body + '.' + sig;
}
export function verifyToken(token) {
  try {
    const [body, sig] = String(token || '').split('.');
    const want = createHmac('sha256', process.env.DD_SECRET).update(body).digest('base64url');
    if (sig !== want) return null;
    const p = JSON.parse(Buffer.from(body, 'base64url').toString());
    if (!p.exp || p.exp < Date.now()) return null;
    return p;
  } catch (e) { return null; }
}
export async function sessionFromReq(req) {
  const h = String(req.headers.authorization || '');
  const token = h.startsWith('Bearer ') ? h.slice(7) : '';
  return verifyToken(token);
}

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;

export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY || !process.env.DD_SECRET) {
    res.status(500).json({ ok: false, error: 'auth not configured (DD_SECRET missing?)' });
    return;
  }
  try {
    const action = (req.query && req.query.action) || '';
    const b = typeof req.body === 'object' && req.body ? req.body : {};

    if (req.method === 'POST' && action === 'signup') {
      const email = String(b.email || '').trim().toLowerCase();
      const name = String(b.name || '').slice(0, 120).trim();
      const company = String(b.company || '').slice(0, 120).trim() || (email.split('@')[1] || 'Workspace');
      const password = String(b.password || '');
      if (!EMAIL_RE.test(email)) { res.status(400).json({ ok: false, error: 'Enter a valid work email.' }); return; }
      if (password.length < 8) { res.status(400).json({ ok: false, error: 'Password needs at least 8 characters.' }); return; }

      const dupe = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id');
      if ((await dupe.json()).length) { res.status(409).json({ ok: false, error: 'An account with this email already exists. Sign in instead.' }); return; }

      const wsr = await sb('workspaces', { method: 'POST', body: JSON.stringify({ name: company, domain: email.split('@')[1] || '', code_hash: 'acct_' + createHash('sha256').update(email + Date.now()).digest('hex') }) });
      const ws = (await wsr.json())[0];
      if (!ws) { res.status(500).json({ ok: false, error: 'Could not create workspace.' }); return; }

      const ar = await sb('accounts', { method: 'POST', body: JSON.stringify({ email, name, pass_hash: hashPass(password), workspace_id: ws.id }) });
      const acct = (await ar.json())[0];
      if (!acct) { res.status(500).json({ ok: false, error: 'Could not create account.' }); return; }

      const token = signToken({ aid: acct.id, wid: ws.id, email, exp: Date.now() + 14 * 864e5 });
      console.log('SIGNUP', email, 'ws', ws.id);
      res.status(200).json({ ok: true, token, ws: { id: ws.id, name: ws.name }, account: { email, name } });
      return;
    }

    if (req.method === 'POST' && action === 'signin') {
      const email = String(b.email || '').trim().toLowerCase();
      const r = await sb('accounts?email=eq.' + encodeURIComponent(email) + '&select=id,email,name,pass_hash,workspace_id');
      const rows = await r.json();
      const acct = rows[0];
      if (!acct || !checkPass(String(b.password || ''), acct.pass_hash)) {
        res.status(401).json({ ok: false, error: 'Email or password did not match.' });
        return;
      }
      const wr = await sb('workspaces?id=eq.' + acct.workspace_id + '&select=id,name');
      const ws = (await wr.json())[0] || { id: acct.workspace_id, name: 'Workspace' };
      const token = signToken({ aid: acct.id, wid: ws.id, email, exp: Date.now() + 14 * 864e5 });
      res.status(200).json({ ok: true, token, ws, account: { email: acct.email, name: acct.name } });
      return;
    }

    if (req.method === 'GET' && action === 'me') {
      const s = await sessionFromReq(req);
      if (!s) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      const wr = await sb('workspaces?id=eq.' + s.wid + '&select=id,name');
      const ws = (await wr.json())[0];
      res.status(200).json({ ok: true, account: { email: s.email }, ws });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    console.error('AUTH_ERROR', e && e.message);
    res.status(500).json({ ok: false, error: 'server error' });
  }
}
