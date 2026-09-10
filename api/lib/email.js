// DepthData transactional email — shared templates + sender.
// Used by auth.js (welcome) and connect.js (first connection).
//
// Env:
//   RESEND_API_KEY   required to send (else calls no-op and return 'skipped')
//   FROM_EMAIL       optional; defaults to onboarding@resend.dev (test sender).
//                    With the test sender, Resend only delivers to your own address.
//                    Verify a domain in Resend and set FROM_EMAIL to hello@depthdata.app
//                    to email real users.
//   NOTIFY_EMAIL     optional; owner address BCC'd on key events.

const BRAND = {
  bg: '#262624', card: '#30302E', ink: '#F5F4ED', ink2: '#B7B5A9', ink3: '#85837A',
  accent: '#C8F24E', border: '#3B3B38',
};

function shell(title, bodyHtml) {
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"></head>
<body style="margin:0;background:${BRAND.bg};font-family:'Helvetica Neue',Arial,sans-serif;color:${BRAND.ink};padding:32px 16px">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0" style="max-width:520px;margin:0 auto">
    <tr><td style="padding:0 0 22px">
      <span style="font-size:18px;font-weight:700;letter-spacing:-.02em;color:${BRAND.ink}">Depth<span style="color:${BRAND.accent}">data</span></span>
    </td></tr>
    <tr><td style="background:${BRAND.card};border:1px solid ${BRAND.border};border-radius:12px;padding:30px 28px">
      ${bodyHtml}
    </td></tr>
    <tr><td style="padding:20px 4px 0;color:${BRAND.ink3};font-size:11px;line-height:1.6">
      DepthData — the system of record for your company's AI investment.<br>
      Read-only. Metadata only. Prompt contents are never read or stored.
    </td></tr>
  </table>
</body></html>`;
}

function button(label, href) {
  return `<a href="${href}" style="display:inline-block;background:${BRAND.accent};color:#1A2B0A;font-weight:600;font-size:14px;text-decoration:none;padding:12px 22px;border-radius:99px;margin:6px 0">${label}</a>`;
}

function h1(t) { return `<div style="font-size:20px;font-weight:700;letter-spacing:-.01em;margin:0 0 12px;color:${BRAND.ink}">${t}</div>`; }
function p(t) { return `<div style="font-size:14px;line-height:1.6;color:${BRAND.ink2};margin:0 0 16px">${t}</div>`; }

export function welcomeEmail(name, appUrl) {
  const first = (name || '').split(' ')[0] || 'there';
  const body =
    h1(`Welcome to DepthData, ${first}.`) +
    p(`Your workspace is ready. DepthData turns every AI tool your company uses into one clear view of adoption, spend, and return.`) +
    p(`The next step takes about five minutes: connect one AI admin console with a read-only key, and your real numbers appear after the first sync.`) +
    `<div style="margin:8px 0 18px">${button('Connect your first tool', appUrl + '#integrations')}</div>` +
    p(`No agents to install. Read-only access. We never read or store prompt contents — only usage, seats, and spend.`);
  return { subject: 'Welcome to DepthData', html: shell('Welcome to DepthData', body) };
}

export function connectedEmail(name, provider, appUrl) {
  const first = (name || '').split(' ')[0] || 'there';
  const label = { anthropic: 'Claude', openai: 'ChatGPT / OpenAI', copilot: 'GitHub Copilot' }[provider] || provider;
  const body =
    h1(`${label} is connected.`) +
    p(`Nice work, ${first}. DepthData is now pulling read-only usage and spend from ${label}. Your first sync runs now, and daily after that.`) +
    p(`Head to your Overview to see your real numbers, labeled by how we know them: measured, derived, or modeled.`) +
    `<div style="margin:8px 0 18px">${button('See your numbers', appUrl + '#overview')}</div>` +
    p(`Want a fuller picture? Connect another tool anytime from Integrations.`);
  return { subject: `${label} is connected to DepthData`, html: shell('Connected', body) };
}

// Low-level send. Returns 'sent' | 'skipped' | 'failed N'. Never throws.
export async function sendEmail(to, subject, html, bcc) {
  const key = process.env.RESEND_API_KEY;
  if (!key || !to) return 'skipped';
  const from = process.env.FROM_EMAIL || 'DepthData <onboarding@resend.dev>';
  const payload = { from, to: [to], subject, html };
  const owner = process.env.NOTIFY_EMAIL;
  if (bcc && owner && owner !== to) payload.bcc = [owner];
  try {
    const r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    return r.ok ? 'sent' : 'failed ' + r.status;
  } catch (e) {
    return 'failed';
  }
}
