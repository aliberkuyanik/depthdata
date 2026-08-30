// DepthData connectors — /api/connect
// Customers paste a vendor admin key. We validate it live against the vendor's
// API (probe), store it AES-256-GCM encrypted, and sync.js pulls usage from it.
// Read-only by design: only usage, seat, and cost endpoints are ever called.
// Prompt or conversation content is never requested from any vendor.
//
// GET    /api/connect                    -> {ok, connectors:[...]}  (session auth)
// POST   /api/connect {provider,key,meta}-> probe + save -> {ok, connector}
// POST   /api/connect?action=syncnow {id}-> pull now -> {ok, inserted}
// DELETE /api/connect?id=N               -> remove
//
// Providers (documented admin APIs, verified July 2026):
//   anthropic: Admin API key (sk-ant-admin...). Probe GET /v1/organizations/users?limit=1
//   openai:    Admin API key. Probe GET /v1/organization/users?limit=1
//   copilot:   GitHub token with manage_billing:copilot. meta = org slug.
//              Probe GET /orgs/{org}/copilot/billing
//
// Env: SUPABASE_URL, SUPABASE_SERVICE_KEY, DD_SECRET
// Optional test overrides: ANTHROPIC_BASE, OPENAI_BASE, GITHUB_BASE

import { createHash, createCipheriv, createDecipheriv, randomBytes } from 'crypto';
import { sessionFromReq } from './auth.js';
import { pullProvider, storeRows } from './sync.js';

const SB = () => process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
function sb(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(SB() + path, {
    ...opts,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=representation', ...(opts && opts.headers) },
  });
}

function aesKey() { return createHash('sha256').update(process.env.DD_SECRET).digest(); }
export function encKey(plain) {
  const iv = randomBytes(12);
  const c = createCipheriv('aes-256-gcm', aesKey(), iv);
  const out = Buffer.concat([c.update(String(plain), 'utf8'), c.final()]);
  return iv.toString('hex') + ':' + c.getAuthTag().toString('hex') + ':' + out.toString('hex');
}
export function decKey(enc) {
  const [iv, tag, data] = String(enc).split(':');
  const d = createDecipheriv('aes-256-gcm', aesKey(), Buffer.from(iv, 'hex'));
  d.setAuthTag(Buffer.from(tag, 'hex'));
  return Buffer.concat([d.update(Buffer.from(data, 'hex')), d.final()]).toString('utf8');
}

export const BASES = {
  anthropic: () => process.env.ANTHROPIC_BASE || 'https://api.anthropic.com',
  openai: () => process.env.OPENAI_BASE || 'https://api.openai.com',
  copilot: () => process.env.GITHUB_BASE || 'https://api.github.com',
};

export async function probe(provider, key, meta) {
  try {
    if (provider === 'anthropic') {
      const r = await fetch(BASES.anthropic() + '/v1/organizations/users?limit=1', {
        headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01' },
      });
      return r.ok ? { ok: true } : { ok: false, error: 'Anthropic rejected the key (HTTP ' + r.status + '). Use an Admin API key (sk-ant-admin...) from Console settings.' };
    }
    if (provider === 'openai') {
      const r = await fetch(BASES.openai() + '/v1/organization/users?limit=1', {
        headers: { Authorization: 'Bearer ' + key },
      });
      return r.ok ? { ok: true } : { ok: false, error: 'OpenAI rejected the key (HTTP ' + r.status + '). Use an Admin API key created by an org Owner.' };
    }
    if (provider === 'copilot') {
      const org = String(meta || '').trim();
      if (!org) return { ok: false, error: 'Enter your GitHub organization slug.' };
      const r = await fetch(BASES.copilot() + '/orgs/' + encodeURIComponent(org) + '/copilot/billing', {
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/vnd.github+json' },
      });
      return r.ok ? { ok: true } : { ok: false, error: 'GitHub rejected the token for org "' + org + '" (HTTP ' + r.status + '). The token needs manage_billing:copilot scope.' };
    }
    return { ok: false, error: 'Unknown provider.' };
  } catch (e) {
    return { ok: false, error: 'Could not reach the vendor API: ' + (e && e.message) };
  }
}

export default async function handler(req, res) {
  if (!process.env.DD_SECRET) { res.status(500).json({ ok: false, error: 'DD_SECRET missing' }); return; }
  const s = await sessionFromReq(req);
  if (!s) { res.status(401).json({ ok: false, error: 'unauthorized' }); return; }
  try {
    const action = (req.query && req.query.action) || '';

    if (req.method === 'GET') {
      const r = await sb('connectors?workspace_id=eq.' + s.wid + '&select=id,provider,label,meta,status,last_sync,last_error&order=created_at.asc');
      res.status(200).json({ ok: true, connectors: r.ok ? await r.json() : [] });
      return;
    }

    if (req.method === 'POST' && action === 'syncnow') {
      const b = typeof req.body === 'object' && req.body ? req.body : {};
      const r = await sb('connectors?id=eq.' + parseInt(b.id, 10) + '&workspace_id=eq.' + s.wid + '&select=*');
      const cx = (await r.json())[0];
      if (!cx) { res.status(404).json({ ok: false, error: 'connector not found' }); return; }
      const out = await pullProvider(cx.provider, decKey(cx.enc_key), cx.meta);
      if (!out.ok) {
        await sb('connectors?id=eq.' + cx.id, { method: 'PATCH', body: JSON.stringify({ status: 'error', last_error: out.error }) });
        res.status(200).json({ ok: false, error: out.error });
        return;
      }
      const inserted = await storeRows(s.wid, cx.provider, out.rows);
      await sb('connectors?id=eq.' + cx.id, { method: 'PATCH', body: JSON.stringify({ status: 'connected', last_sync: new Date().toISOString(), last_error: '' }) });
      console.log('SYNC ws=' + s.wid + ' ' + cx.provider + ' rows=' + inserted);
      res.status(200).json({ ok: true, inserted });
      return;
    }

    if (req.method === 'POST') {
      const b = typeof req.body === 'object' && req.body ? req.body : {};
      const provider = String(b.provider || '');
      const key = String(b.key || '').trim();
      const meta = String(b.meta || '').trim();
      if (!BASES[provider]) { res.status(400).json({ ok: false, error: 'unknown provider' }); return; }
      if (key.length < 12) { res.status(400).json({ ok: false, error: 'That does not look like an admin key.' }); return; }
      const p = await probe(provider, key, meta);
      if (!p.ok) { res.status(400).json({ ok: false, error: p.error }); return; }
      const r = await sb('connectors', {
        method: 'POST',
        body: JSON.stringify({ workspace_id: s.wid, provider, label: String(b.label || '').slice(0, 80), enc_key: encKey(key), meta }),
      });
      const row = (await r.json())[0];
      console.log('CONNECT ws=' + s.wid + ' ' + provider);
      res.status(200).json({ ok: r.ok, connector: row && { id: row.id, provider: row.provider, status: row.status } });
      return;
    }

    if (req.method === 'DELETE') {
      const id = parseInt((req.query && req.query.id) || '0', 10);
      await sb('connectors?id=eq.' + id + '&workspace_id=eq.' + s.wid, { method: 'DELETE' });
      res.status(200).json({ ok: true });
      return;
    }

    res.status(400).json({ ok: false, error: 'unknown action' });
  } catch (e) {
    console.error('CONNECT_ERROR', e && e.message);
    res.status(500).json({ ok: false, error: 'server error' });
  }
}
