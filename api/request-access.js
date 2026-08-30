// DepthData lead capture — /api/request-access
// Deploy: put this file at api/request-access.js in the repo serving depthdata.app.
// Then in Vercel → Project → Settings → Environment Variables add:
//   RESEND_API_KEY    = re_...        (free account at resend.com, API Keys page)
//   NOTIFY_EMAIL      = you@yourmail  (where signup alerts land)
//   SLACK_WEBHOOK_URL = https://hooks.slack.com/services/...  (Slack → apps → Incoming Webhooks)
// Any variable you leave out simply disables that channel. The endpoint never
// fails the visitor because a notification channel is down: it logs and returns ok.
//
// The login page fires POST /api/request-access with {name,email,company,source}.

function esc(s) {
  return String(s || '').slice(0, 300).replace(/[<>]/g, '');
}


async function storeRow(table, row) {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_KEY;
  if (!url || !key) return 'skipped';
  const r = await fetch(url.replace(/\/$/, '') + '/rest/v1/' + table, {
    method: 'POST',
    headers: {
      apikey: key,
      Authorization: 'Bearer ' + key,
      'Content-Type': 'application/json',
      Prefer: 'return=minimal',
    },
    body: JSON.stringify(row),
  });
  return r.ok ? 'stored' : 'failed ' + r.status;
}

async function notifySlack(payload) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return 'skipped';
  const text =
    `:sparkles: *New access request on depthdata.app*\n` +
    `*Name:* ${payload.name}\n*Email:* ${payload.email}\n` +
    `*Company:* ${payload.company}\n*Source:* ${payload.source}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return r.ok ? 'sent' : 'failed ' + r.status;
}

async function notifyEmail(payload) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return 'skipped';
  const html =
    `<h2>New access request on depthdata.app</h2>` +
    `<p><b>Name:</b> ${payload.name}<br>` +
    `<b>Email:</b> ${payload.email}<br>` +
    `<b>Company:</b> ${payload.company}<br>` +
    `<b>Source:</b> ${payload.source}<br>` +
    `<b>Time:</b> ${new Date().toISOString()}</p>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'DepthData <onboarding@resend.dev>',
      to: [to],
      subject: `Access request: ${payload.email}`,
      html,
    }),
  });
  return r.ok ? 'sent' : 'failed ' + r.status;
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ ok: false, error: 'POST only' });
    return;
  }
  try {
    const b = typeof req.body === 'object' && req.body ? req.body : {};
    // honeypot: bots fill every field; humans never see this one
    if (b.website) {
      res.status(200).json({ ok: true });
      return;
    }
    const email = esc(b.email).toLowerCase();
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(email)) {
      res.status(400).json({ ok: false, error: 'valid email required' });
      return;
    }
    const payload = {
      name: esc(b.name) || 'not given',
      email,
      company: esc(b.company) || 'not given',
      source: esc(b.source) || 'login page',
    };
    // Function logs are the Stage 1 record of every request.
    console.log('ACCESS_REQUEST', JSON.stringify(payload));
    const [slack, mail, db] = await Promise.allSettled([
      notifySlack(payload),
      notifyEmail(payload),
      storeRow('access_requests', payload),
    ]);
    console.log(
      'ACCESS_NOTIFY slack=' + (slack.value || slack.reason) +
      ' email=' + (mail.value || mail.reason) +
      ' db=' + (db.value || db.reason)
    );
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('ACCESS_ERROR', e && e.message);
    // Never block the visitor on our plumbing.
    res.status(200).json({ ok: true });
  }
}
