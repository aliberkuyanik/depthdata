// DepthData pilot workspace API — /api/workspace
// Used by the product itself (login page + app) for concierge pilot companies.
// Auth model: the workspace access code IS the credential. It is generated in the
// console (owner only), stored as a sha256 hash, and sent by you to the pilot
// company. No account creation needed for pilot stage.
//
// POST /api/workspace?action=login   {code}         -> {ok, ws:{id,name,domain}}
// GET  /api/workspace?action=summary  header x-ws-code -> {ok, ws, totals, days, people, tools}
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY (same as the rest of the backend).

import { createHash } from 'crypto';
import { sessionFromReq } from './auth.js';

function sha256(s) {
  return createHash('sha256').update(String(s)).digest('hex');
}

function sb(path) {
  const url = process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/' + path;
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(url, {
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
  });
}

async function wsByCode(code) {
  if (!code || code.length < 8) return null;
  const r = await sb('workspaces?code_hash=eq.' + sha256(code) + '&status=eq.active&select=id,name,domain');
  const rows = r.ok ? await r.json() : [];
  return rows.length ? rows[0] : null;
}

export default async function handler(req, res) {
  if (!process.env.SUPABASE_URL || !process.env.SUPABASE_SERVICE_KEY) {
    res.status(500).json({ ok: false, error: 'storage not configured' });
    return;
  }
  try {
    const action = (req.query && req.query.action) || '';

    if (req.method === 'POST' && action === 'login') {
      const b = typeof req.body === 'object' && req.body ? req.body : {};
      const ws = await wsByCode(String(b.code || '').trim());
      if (!ws) {
        res.status(401).json({ ok: false, error: 'That code did not match an active workspace.' });
        return;
      }
      console.log('WS_LOGIN', ws.name);
      res.status(200).json({ ok: true, ws });
      return;
    }

    if (req.method === 'GET' && action === 'summary') {
      let ws = await wsByCode(String(req.headers['x-ws-code'] || '').trim());
      if (!ws) {
        const s = await sessionFromReq(req);
        if (s && s.wid) {
          const r0 = await sb('workspaces?id=eq.' + s.wid + '&select=id,name,domain');
          const rows0 = r0.ok ? await r0.json() : [];
          ws = rows0.length ? rows0[0] : null;
        }
      }
      if (!ws) {
        res.status(401).json({ ok: false, error: 'unauthorized' });
        return;
      }
      const r = await sb(
        'usage_daily?workspace_id=eq.' + ws.id +
        '&select=day,email,name,department,tool,prompts,tokens,cost&order=day.desc&limit=20000'
      );
      const rows = r.ok ? await r.json() : [];

      const totals = { prompts: 0, tokens: 0, cost: 0, activeUsers: 0, days: 0 };
      const byUser = {}, byDay = {}, byTool = {};
      rows.forEach(function (x) {
        totals.prompts += x.prompts || 0;
        totals.tokens += Number(x.tokens || 0);
        totals.cost += Number(x.cost || 0);
        byDay[x.day] = (byDay[x.day] || 0) + (x.prompts || 0);
        if (x.tool) byTool[x.tool] = (byTool[x.tool] || 0) + (x.prompts || 0);
        if (!x.email) return; // org level rows count in totals only, never as users
        const u = byUser[x.email] || (byUser[x.email] = { email: x.email, name: x.name || x.email.split('@')[0], department: x.department || '', prompts: 0, tokens: 0, cost: 0, lastDay: x.day, tools: {} });
        u.prompts += x.prompts || 0;
        u.tokens += Number(x.tokens || 0);
        u.cost += Number(x.cost || 0);
        if (x.day > u.lastDay) u.lastDay = x.day;
        if (x.tool) u.tools[x.tool] = 1;
      });
      totals.activeUsers = Object.keys(byUser).length;
      totals.days = Object.keys(byDay).length;

      const people = Object.values(byUser)
        .map(function (u) { return { email: u.email, name: u.name, department: u.department, prompts: u.prompts, tokens: u.tokens, cost: Math.round(u.cost * 100) / 100, lastDay: u.lastDay, tools: Object.keys(u.tools) }; })
        .sort(function (a, b) { return b.prompts - a.prompts; });

      const days = Object.keys(byDay).sort().map(function (d) { return { day: d, prompts: byDay[d] }; });
      const tools = Object.keys(byTool).map(function (t) { return { tool: t, prompts: byTool[t] }; }).sort(function (a, b) { return b.prompts - a.prompts; });

      res.status(200).json({ ok: true, ws, totals: { prompts: totals.prompts, tokens: totals.tokens, cost: Math.round(totals.cost * 100) / 100, activeUsers: totals.activeUsers, days: totals.days }, days, people, tools });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    console.error('WS_ERROR', e && e.message);
    res.status(500).json({ ok: false, error: 'server error' });
  }
}
