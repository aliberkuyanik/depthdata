// DepthData admin API v2 — /api/admin
// Powers the internal console at /console.html.
//
// Environment variables:
//   SUPABASE_URL, SUPABASE_SERVICE_KEY  (storage, service key stays server side)
//   ADMIN_PASSWORD                      (the owner key, only you)
//
// Auth: header  x-admin-key  must be either the owner password or a console
// user's personal key (stored as sha256 in console_users). Console users can
// read and work tickets and requests; only the owner can manage console users.

import { createHash } from 'crypto';

function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

function sb(path, opts) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path;
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(url, {
    ...opts,
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=representation',
      ...(opts && opts.headers),
    },
  });
}

function timingSafeEq(a, b) {
  if (a.length !== b.length) return false;
  let ok = 0;
  for (let i = 0; i < a.length; i++) ok |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return ok === 0;
}

async function identify(req) {
  const got = String(req.headers['x-admin-key'] || '');
  const owner = process.env.ADMIN_PASSWORD || '';
  if (!owner || owner.length < 8) return null;
  if (got && timingSafeEq(got, owner)) return { type: 'owner', name: 'Owner' };
  if (!got) return null;
  const hash = sha256(got);
  const r = await sb('console_users?key_hash=eq.' + hash + '&select=*');
  const rows = r.ok ? await r.json() : [];
  if (rows.length) {
    const u = rows[0];
    sb('console_users?id=eq.' + u.id, {
      method: 'PATCH',
      body: JSON.stringify({ last_seen: new Date().toISOString() }),
    }).catch(() => {});
    return { type: 'user', id: u.id, name: u.name, role: u.role };
  }
  return null;
}

export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    res.status(500).json({ ok: false, error: 'storage not configured' });
    return;
  }
  const actor = await identify(req);
  if (!actor) {
    res.status(401).json({ ok: false, error: 'unauthorized' });
    return;
  }

  try {
    const action = (req.query && req.query.action) || '';

    if (req.method === 'GET' && action === 'overview') {
      const [reqs, reps, sup, users] = await Promise.all([
        sb('access_requests?select=*&order=created_at.desc&limit=300').then((r) => r.json()),
        sb('reports?select=*&order=created_at.desc&limit=300').then((r) => r.json()),
        sb('support_logs?select=*&order=created_at.desc&limit=300').then((r) => r.json()),
        sb('console_users?select=id,created_at,name,email,role,last_seen&order=created_at.asc').then((r) => r.json()),
      ]);
      res.status(200).json({
        ok: true,
        actor,
        requests: Array.isArray(reqs) ? reqs : [],
        reports: Array.isArray(reps) ? reps : [],
        support: Array.isArray(sup) ? sup : [],
        users: Array.isArray(users) ? users : [],
      });
      return;
    }

    if (req.method === 'PATCH' && action === 'update') {
      const b = typeof req.body === 'object' && req.body ? req.body : {};
      const table = b.table === 'reports' ? 'reports' : 'access_requests';
      const id = parseInt(b.id, 10);
      if (!id) { res.status(400).json({ ok: false, error: 'id required' }); return; }
      const patch = {};
      if (typeof b.status === 'string' && b.status.length < 24) patch.status = b.status;
      if (typeof b.notes === 'string' && table === 'access_requests') patch.notes = b.notes.slice(0, 2000);
      if (table === 'reports' && ['p1', 'p2', 'p3', 'p4'].indexOf(b.priority) >= 0) patch.priority = b.priority;
      if (table === 'reports' && typeof b.assignee === 'string') patch.assignee = b.assignee.slice(0, 80);
      if (!Object.keys(patch).length) { res.status(400).json({ ok: false, error: 'nothing to update' }); return; }
      const r = await sb(table + '?id=eq.' + id, { method: 'PATCH', body: JSON.stringify(patch) });
      const rows = await r.json();
      res.status(200).json({ ok: r.ok, row: rows && rows[0] });
      return;
    }

    if (req.method === 'POST' && action === 'addworkspace') {
      if (actor.type !== 'owner') { res.status(403).json({ ok: false, error: 'owner only' }); return; }
      const b = typeof req.body === 'object' && req.body ? req.body : {};
      const name = String(b.name || '').slice(0, 120).trim();
      const domain = String(b.domain || '').slice(0, 120).trim().toLowerCase();
      if (!name) { res.status(400).json({ ok: false, error: 'name required' }); return; }
      const code = 'ddw_' + sha256(name + Date.now() + Math.random()).slice(0, 28);
      const r = await sb('workspaces', {
        method: 'POST',
        body: JSON.stringify({ name, domain, code_hash: sha256(code) }),
      });
      const rows = await r.json();
      res.status(200).json({ ok: r.ok, ws: rows && rows[0] && { id: rows[0].id, name: rows[0].name, domain: rows[0].domain }, code });
      return;
    }

    if (req.method === 'GET' && action === 'workspaces') {
      const r = await sb('workspaces?select=id,created_at,name,domain,status&order=created_at.desc');
      const rows = r.ok ? await r.json() : [];
      res.status(200).json({ ok: true, workspaces: rows });
      return;
    }

    if (req.method === 'POST' && action === 'ingest') {
      if (actor.type !== 'owner') { res.status(403).json({ ok: false, error: 'owner only' }); return; }
      const b = typeof req.body === 'object' && req.body ? req.body : {};
      const wsId = parseInt(b.workspace_id, 10);
      const rows = Array.isArray(b.rows) ? b.rows.slice(0, 5000) : [];
      if (!wsId || !rows.length) { res.status(400).json({ ok: false, error: 'workspace_id and rows required' }); return; }
      const clean = [];
      for (const x of rows) {
        const day = String(x.day || '').slice(0, 10);
        const email = String(x.email || '').slice(0, 200).trim().toLowerCase();
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || email.indexOf('@') < 1) continue;
        clean.push({
          workspace_id: wsId,
          day,
          email,
          name: String(x.name || '').slice(0, 120),
          department: String(x.department || '').slice(0, 80),
          tool: String(x.tool || '').slice(0, 60),
          prompts: Math.max(0, parseInt(x.prompts, 10) || 0),
          tokens: Math.max(0, parseInt(x.tokens, 10) || 0),
          cost: Math.max(0, parseFloat(x.cost) || 0),
        });
      }
      if (!clean.length) { res.status(400).json({ ok: false, error: 'no valid rows. Check date format YYYY-MM-DD and email column.' }); return; }
      const r = await sb('usage_daily', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify(clean) });
      console.log('INGEST ws=' + wsId + ' rows=' + clean.length + ' ok=' + r.ok);
      res.status(200).json({ ok: r.ok, inserted: r.ok ? clean.length : 0, skipped: rows.length - clean.length });
      return;
    }

    if (req.method === 'POST' && action === 'addticket') {
      const b = typeof req.body === 'object' && req.body ? req.body : {};
      const message = String(b.message || '').slice(0, 2000).trim();
      if (message.length < 3) { res.status(400).json({ ok: false, error: 'message required' }); return; }
      const row = {
        type: ['bug', 'idea', 'question'].indexOf(b.type) >= 0 ? b.type : 'bug',
        title: String(b.title || '').slice(0, 140).trim(),
        message,
        email: String(b.email || '').slice(0, 200).trim(),
        priority: ['p1', 'p2', 'p3', 'p4'].indexOf(b.priority) >= 0 ? b.priority : 'p3',
        assignee: String(b.assignee || '').slice(0, 80).trim(),
        channel: String(b.channel || '').slice(0, 40).trim(),
        company: String(b.company || '').slice(0, 120).trim(),
        page: 'console',
        app: 'manual',
        status: 'open',
      };
      const r = await sb('reports', { method: 'POST', body: JSON.stringify(row) });
      const rows = await r.json();
      res.status(200).json({ ok: r.ok, row: rows && rows[0] });
      return;
    }

    if (req.method === 'POST' && action === 'adduser') {
      if (actor.type !== 'owner') { res.status(403).json({ ok: false, error: 'owner only' }); return; }
      const b = typeof req.body === 'object' && req.body ? req.body : {};
      const name = String(b.name || '').slice(0, 80).trim();
      const email = String(b.email || '').slice(0, 160).trim().toLowerCase();
      const role = b.role === 'admin' ? 'admin' : 'viewer';
      if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
        res.status(400).json({ ok: false, error: 'name and valid email required' });
        return;
      }
      const key = 'ddc_' + sha256(email + Date.now() + Math.random()).slice(0, 32);
      const r = await sb('console_users', {
        method: 'POST',
        body: JSON.stringify({ name, email, role, key_hash: sha256(key) }),
      });
      const rows = await r.json();
      res.status(200).json({ ok: r.ok, user: rows && rows[0], key });
      return;
    }

    if (req.method === 'DELETE' && action === 'deluser') {
      if (actor.type !== 'owner') { res.status(403).json({ ok: false, error: 'owner only' }); return; }
      const id = parseInt(req.query.id, 10);
      if (!id) { res.status(400).json({ ok: false, error: 'id required' }); return; }
      const r = await sb('console_users?id=eq.' + id, { method: 'DELETE' });
      res.status(200).json({ ok: r.ok });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    console.error('ADMIN_ERROR', e && e.message);
    res.status(500).json({ ok: false, error: 'server error' });
  }
}
