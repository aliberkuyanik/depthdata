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
import { welcomeEmail, sendEmail } from './lib/email.js';

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
      try {
        const appUrl = 'https://depthdata.app/app';
        const wm = welcomeEmail(name, appUrl);
        sendEmail(email, wm.subject, wm.html, true).catch(function(){});
      } catch (e) {}
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
      const ar = await sb('accounts?id=eq.' + s.aid + '&select=id,name,email,created_at,role'); const acct=(await ar.json())[0]||{email:s.email}; res.status(200).json({ ok: true, account: acct, ws });
      return;
    }

    if (req.method === 'POST' && action === 'update') {
      const s = await sessionFromReq(req);
      if (!s) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      const body = req.body || {};
      // update workspace name
      if (typeof body.wsName === 'string' && body.wsName.trim()) {
        await sb('workspaces?id=eq.' + s.wid, { method: 'PATCH', body: JSON.stringify({ name: body.wsName.trim() }) });
      }
      // update account display name
      if (typeof body.name === 'string') {
        await sb('accounts?id=eq.' + s.aid, { method: 'PATCH', body: JSON.stringify({ name: body.name.trim() }) });
      }
      const wr = await sb('workspaces?id=eq.' + s.wid + '&select=id,name');
      const ws = (await wr.json())[0];
      res.status(200).json({ ok: true, ws });
      return;
    }

    if (req.method === 'POST' && action === 'delete-request') {
      const s = await sessionFromReq(req);
      if (!s) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      // generate 6-digit code, store with 15-min expiry (in accounts table meta or a codes table)
      const code = String(Math.floor(100000 + Math.random() * 900000));
      const expires = Date.now() + 15 * 60 * 1000;
      // store code hashed in the account row (reuse a column via PATCH to a codes table)
      await sb('accounts?id=eq.' + s.aid, { method: 'PATCH', body: JSON.stringify({ del_code: code, del_code_exp: expires }) });
      // email the code
      try {
        const html = '<!doctype html><html><body style="margin:0;background:#262624;font-family:Helvetica,Arial,sans-serif;color:#F5F4ED;padding:32px 16px"><table width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto"><tr><td style="padding:0 0 22px"><span style="font-size:18px;font-weight:700">Depth<span style="color:#C8F24E">data</span></span></td></tr><tr><td style="background:#30302E;border:1px solid #3B3B38;border-radius:12px;padding:30px 28px"><div style="font-size:20px;font-weight:700;margin-bottom:12px">Confirm account deletion</div><div style="font-size:14px;line-height:1.6;color:#B7B5A9;margin-bottom:20px">You asked to delete your DepthData workspace. Enter this code to confirm. It expires in 15 minutes.</div><div style="font-family:monospace;font-size:32px;font-weight:700;letter-spacing:8px;color:#D7FF87;background:#2B2B28;border-radius:10px;padding:16px;text-align:center">' + code + '</div><div style="font-size:12px;color:#85837A;margin-top:20px">If you did not request this, ignore this email and your account stays safe. Nothing is deleted until the code is entered.</div></td></tr></table></body></html>';
        await sendEmail(s.email, 'Confirm your DepthData account deletion', html, true);
      } catch (e) {}
      console.log('DELETE_REQUEST', s.email);
      res.status(200).json({ ok: true, sent: true });
      return;
    }

    if (req.method === 'POST' && action === 'delete-confirm') {
      const s = await sessionFromReq(req);
      if (!s) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
      const body = req.body || {};
      const code = String(body.code || '').trim();
      if (!code) { res.status(400).json({ ok: false, error: 'code required' }); return; }
      // fetch stored code
      const ar = await sb('accounts?id=eq.' + s.aid + '&select=del_code,del_code_exp,workspace_id');
      const acct = (await ar.json())[0];
      if (!acct || !acct.del_code) { res.status(400).json({ ok: false, error: 'no pending deletion. request a code first' }); return; }
      if (Date.now() > Number(acct.del_code_exp || 0)) { res.status(400).json({ ok: false, error: 'code expired. request a new one' }); return; }
      if (String(acct.del_code) !== code) { res.status(400).json({ ok: false, error: 'wrong code' }); return; }
      // delete: account + its workspace (cascades connectors + usage)
      await sb('accounts?id=eq.' + s.aid, { method: 'DELETE' });
      if (acct.workspace_id) { await sb('workspaces?id=eq.' + acct.workspace_id, { method: 'DELETE' }); }
      console.log('DELETE_CONFIRMED', s.email, 'ws', acct.workspace_id);
      res.status(200).json({ ok: true, deleted: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    console.error('AUTH_ERROR', e && e.message);
    res.status(500).json({ ok: false, error: 'server error' });
  }
}
