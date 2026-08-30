// DepthData in-app reports — /api/report
// Deploy: put this file at api/report.js in the repo serving depthdata.app.
// Uses the same environment variables as request-access.js:
//   RESEND_API_KEY, NOTIFY_EMAIL, SLACK_WEBHOOK_URL
// Missing variables disable that channel; the endpoint always answers ok so the
// in-app form never breaks for the person reporting.
//
// The app's help drawer fires POST /api/report with {type,message,email,page,app}.

function esc(s, n) {
  return String(s || '').slice(0, n || 400).replace(/[<>]/g, '');
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

async function notifySlack(p) {
  const url = process.env.SLACK_WEBHOOK_URL;
  if (!url) return 'skipped';
  const text =
    `:tools: *In-app report — ${p.type}*\n` +
    `*From:* ${p.email}\n*App:* ${p.app} · *Page:* ${p.page}\n` +
    `*Message:*\n${p.message}`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ text }),
  });
  return r.ok ? 'sent' : 'failed ' + r.status;
}

async function notifyEmail(p) {
  const key = process.env.RESEND_API_KEY;
  const to = process.env.NOTIFY_EMAIL;
  if (!key || !to) return 'skipped';
  const html =
    `<h2>In-app report: ${p.type}</h2>` +
    `<p><b>From:</b> ${p.email}<br><b>App:</b> ${p.app} · <b>Page:</b> ${p.page}<br>` +
    `<b>Time:</b> ${new Date().toISOString()}</p>` +
    `<p style="white-space:pre-wrap">${p.message}</p>`;
  const r = await fetch('https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      from: 'DepthData <onboarding@resend.dev>',
      to: [to],
      subject: `Report (${p.type}): ${p.message.slice(0, 60)}`,
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
    const message = esc(b.message, 2000);
    if (message.length < 5) {
      res.status(400).json({ ok: false, error: 'message required' });
      return;
    }
    const payload = {
      type: esc(b.type, 60) || 'General',
      message,
      email: esc(b.email, 200) || 'not given',
      page: esc(b.page, 120) || 'unknown',
      app: esc(b.app, 60) || 'app',
    };
    console.log('REPORT', JSON.stringify(payload));
    const [slack, mail, db] = await Promise.allSettled([
      notifySlack(payload),
      notifyEmail(payload),
      storeRow('reports', payload),
    ]);
    console.log(
      'REPORT_NOTIFY slack=' + (slack.value || slack.reason) +
      ' email=' + (mail.value || mail.reason) +
      ' db=' + (db.value || db.reason)
    );
    res.status(200).json({ ok: true });
  } catch (e) {
    console.error('REPORT_ERROR', e && e.message);
    res.status(200).json({ ok: true });
  }
}
