// DepthData sync engine — vendor usage pulls, normalized into usage_daily.
// Implemented to each vendor's documented admin API (verified July 2026 research).
// Read-only, metadata only. Granularity is honest per vendor:
//   anthropic: org usage by day (tokens, requests) via /usage_report/messages,
//              USD via /cost_report, plus per-user rows from /usage_report/claude_code
//              when the org has Claude Code activity.
//   openai:    per-user requests by day via /organization/usage/completions
//              (group_by user), user emails via /organization/users, USD via costs.
//   copilot:   org metrics by day via /orgs/{org}/copilot/metrics (active users,
//              chats), per-seat last activity via /copilot/billing/seats.
// Rows without a user email carry email:'' and are counted in totals but never
// in active user counts. The app labels both honestly.

const SB = () => process.env.SUPABASE_URL.replace(/\/$/, '') + '/rest/v1/';
function sb(path, opts) {
  const key = process.env.SUPABASE_SERVICE_KEY;
  return fetch(SB() + path, {
    ...opts,
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal', ...(opts && opts.headers) },
  });
}

const BASES = {
  anthropic: () => process.env.ANTHROPIC_BASE || 'https://api.anthropic.com',
  openai: () => process.env.OPENAI_BASE || 'https://api.openai.com',
  copilot: () => process.env.GITHUB_BASE || 'https://api.github.com',
};

function daysAgoIso(n) { return new Date(Date.now() - n * 864e5).toISOString().slice(0, 10); }

async function jget(url, headers) {
  const r = await fetch(url, { headers });
  if (!r.ok) throw new Error('HTTP ' + r.status + ' from ' + url.split('?')[0].split('/').slice(-2).join('/'));
  return r.json();
}

// ---------- Anthropic (Admin API) ----------
async function pullAnthropic(key) {
  const H = { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  const base = BASES.anthropic();
  const since = daysAgoIso(30);
  const rows = [];

  // Org level usage by day: token counts + request counts, bucketed daily
  const usage = await jget(base + '/v1/organizations/usage_report/messages?starting_at=' + since + 'T00:00:00Z&bucket_width=1d&limit=31', H);
  (usage.data || []).forEach(function (bucket) {
    const day = String(bucket.starting_at || '').slice(0, 10);
    let tokens = 0, requests = 0;
    (bucket.results || []).forEach(function (x) {
      tokens += (x.uncached_input_tokens || 0) + (x.output_tokens || 0) + (x.cache_read_input_tokens || 0) + (x.cache_creation ? (x.cache_creation.ephemeral_5m_input_tokens || 0) + (x.cache_creation.ephemeral_1h_input_tokens || 0) : 0);
      requests += x.num_requests || x.request_count || 0;
    });
    if (day && (tokens || requests)) rows.push({ day, email: '', name: 'Organization total', department: '', tool: 'Claude API', prompts: requests, tokens, cost: 0 });
  });

  // USD by day
  try {
    const cost = await jget(base + '/v1/organizations/cost_report?starting_at=' + since + 'T00:00:00Z&limit=31', H);
    const byDay = {};
    (cost.data || []).forEach(function (bucket) {
      const day = String(bucket.starting_at || '').slice(0, 10);
      (bucket.results || []).forEach(function (x) { byDay[day] = (byDay[day] || 0) + (parseFloat(x.amount) || 0) / 100; });
    });
    rows.forEach(function (r) { if (byDay[r.day]) { r.cost = Math.round(byDay[r.day] * 100) / 100; delete byDay[r.day]; } });
    Object.keys(byDay).forEach(function (day) { rows.push({ day, email: '', name: 'Organization total', department: '', tool: 'Claude API', prompts: 0, tokens: 0, cost: Math.round(byDay[day] * 100) / 100 }); });
  } catch (e) { /* cost endpoint optional */ }

  // Per user per day from Claude Code, when present
  try {
    const cc = await jget(base + '/v1/organizations/usage_report/claude_code?starting_at=' + since + '&limit=31', H);
    (cc.data || []).forEach(function (d) {
      (d.records || d.results || []).forEach(function (u) {
        const email = String(u.actor_email || u.email || (u.actor && u.actor.email_address) || '').toLowerCase();
        if (!email) return;
        rows.push({ day: String(d.date || d.starting_at || '').slice(0, 10), email, name: email.split('@')[0], department: '', tool: 'Claude Code', prompts: u.sessions || u.num_sessions || 0, tokens: u.total_tokens || 0, cost: Math.round((parseFloat(u.estimated_cost || 0)) * 100) / 100 });
      });
    });
  } catch (e) { /* org may not use Claude Code */ }

  return rows;
}

// ---------- OpenAI (Admin API) ----------
async function pullOpenAI(key) {
  const H = { Authorization: 'Bearer ' + key };
  const base = BASES.openai();
  const start = Math.floor(Date.now() / 1000) - 30 * 86400;

  // Map user ids to emails
  const emails = {};
  try {
    const users = await jget(base + '/v1/organization/users?limit=100', H);
    (users.data || []).forEach(function (u) { emails[u.id] = String(u.email || '').toLowerCase(); });
  } catch (e) { /* fall back to ids */ }

  const rows = [];
  const usage = await jget(base + '/v1/organization/usage/completions?start_time=' + start + '&bucket_width=1d&group_by=user_id&limit=31', H);
  (usage.data || []).forEach(function (bucket) {
    const day = new Date((bucket.start_time || 0) * 1000).toISOString().slice(0, 10);
    (bucket.results || []).forEach(function (x) {
      const email = emails[x.user_id] || '';
      rows.push({ day, email, name: email ? email.split('@')[0] : 'Organization total', department: '', tool: 'OpenAI API', prompts: x.num_model_requests || 0, tokens: (x.input_tokens || 0) + (x.output_tokens || 0), cost: 0 });
    });
  });

  try {
    const cost = await jget(base + '/v1/organization/costs?start_time=' + start + '&limit=31', H);
    (cost.data || []).forEach(function (bucket) {
      const day = new Date((bucket.start_time || 0) * 1000).toISOString().slice(0, 10);
      let amt = 0;
      (bucket.results || []).forEach(function (x) { amt += (x.amount && x.amount.value) || 0; });
      if (amt) rows.push({ day, email: '', name: 'Organization total', department: '', tool: 'OpenAI API', prompts: 0, tokens: 0, cost: Math.round(amt * 100) / 100 });
    });
  } catch (e) { /* costs optional */ }

  return rows;
}

// ---------- GitHub Copilot ----------
async function pullCopilot(key, org) {
  const H = { Authorization: 'Bearer ' + key, Accept: 'application/vnd.github+json' };
  const base = BASES.copilot();
  const rows = [];

  const metrics = await jget(base + '/orgs/' + encodeURIComponent(org) + '/copilot/metrics?since=' + daysAgoIso(28), H);
  (Array.isArray(metrics) ? metrics : []).forEach(function (d) {
    const chats = d.copilot_ide_chat && d.copilot_ide_chat.editors
      ? d.copilot_ide_chat.editors.reduce(function (s, e) { return s + (e.models || []).reduce(function (s2, m) { return s2 + (m.total_chats || 0); }, 0); }, 0)
      : 0;
    rows.push({ day: String(d.date || '').slice(0, 10), email: '', name: 'Organization total', department: '', tool: 'Copilot', prompts: chats, tokens: 0, cost: 0 });
  });

  try {
    const seats = await jget(base + '/orgs/' + encodeURIComponent(org) + '/copilot/billing/seats?per_page=100', H);
    (seats.seats || []).forEach(function (st) {
      const email = String((st.assignee && (st.assignee.email || st.assignee.login)) || '').toLowerCase();
      const last = String(st.last_activity_at || '').slice(0, 10);
      if (email && last) rows.push({ day: last, email: email.indexOf('@') > 0 ? email : email + '@github', name: (st.assignee && st.assignee.login) || email, department: '', tool: 'Copilot', prompts: 1, tokens: 0, cost: 0 });
    });
  } catch (e) { /* seats need billing scope */ }

  return rows;
}

export async function pullProvider(provider, key, meta) {
  try {
    let rows = [];
    if (provider === 'anthropic') rows = await pullAnthropic(key);
    else if (provider === 'openai') rows = await pullOpenAI(key);
    else if (provider === 'copilot') rows = await pullCopilot(key, meta);
    else return { ok: false, error: 'unknown provider' };
    rows = rows.filter(function (r) { return /^\d{4}-\d{2}-\d{2}$/.test(r.day); });
    return { ok: true, rows };
  } catch (e) {
    return { ok: false, error: (e && e.message) || 'vendor pull failed' };
  }
}

// Replace-then-insert per workspace+tool set keeps re-syncs duplicate free.
export async function storeRows(wid, provider, rows) {
  if (!rows.length) return 0;
  const tools = Array.from(new Set(rows.map(function (r) { return r.tool; })));
  for (const t of tools) {
    await sb('usage_daily?workspace_id=eq.' + wid + '&tool=eq.' + encodeURIComponent(t), { method: 'DELETE' });
  }
  const clean = rows.slice(0, 5000).map(function (x) {
    return {
      workspace_id: wid, day: x.day, email: String(x.email || '').slice(0, 200),
      name: String(x.name || '').slice(0, 120), department: String(x.department || '').slice(0, 80),
      tool: String(x.tool || provider).slice(0, 60),
      prompts: Math.max(0, parseInt(x.prompts, 10) || 0),
      tokens: Math.max(0, parseInt(x.tokens, 10) || 0),
      cost: Math.max(0, parseFloat(x.cost) || 0),
    };
  });
  const r = await sb('usage_daily', { method: 'POST', body: JSON.stringify(clean) });
  return r.ok ? clean.length : 0;
}

// GET /api/sync — cron entry: sync every connector (Vercel Cron friendly)
export default async function handler(req, res) {
  try {
    const key = process.env.SUPABASE_SERVICE_KEY;
    const r = await fetch(SB() + 'connectors?select=*', { headers: { apikey: key, Authorization: 'Bearer ' + key } });
    const list = r.ok ? await r.json() : [];
    const { decKey } = await import('./connect.js');
    let synced = 0;
    for (const cx of list) {
      const out = await pullProvider(cx.provider, decKey(cx.enc_key), cx.meta);
      if (out.ok) { await storeRows(cx.workspace_id, cx.provider, out.rows); synced++; }
      await fetch(SB() + 'connectors?id=eq.' + cx.id, {
        method: 'PATCH',
        headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
        body: JSON.stringify(out.ok ? { status: 'connected', last_sync: new Date().toISOString(), last_error: '' } : { status: 'error', last_error: out.error }),
      });
    }
    res.status(200).json({ ok: true, synced, total: list.length });
  } catch (e) {
    console.error('CRON_SYNC_ERROR', e && e.message);
    res.status(500).json({ ok: false });
  }
}
