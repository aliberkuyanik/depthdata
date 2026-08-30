// DepthData help desk backend — /api/support
// Deploy: put this file at api/support.js in the aliberkuyanik/depthdata repo
// (the project serving depthdata.vercel.app), then in Vercel → Project →
// Settings → Environment Variables add: ANTHROPIC_API_KEY = sk-ant-...
// (create the key at console.anthropic.com). Redeploy. No dependencies needed.
//
// The in-app chat already calls POST /api/support with {messages:[{role,content},...]}
// and expects {reply:"..."} back. If this function is missing or errors, the app
// falls back to its built-in answers, so shipping this can never break the chat.

const KB_SYSTEM = `You are DepthData's support assistant, answering inside the product's help desk chat.

DepthData is an AI workforce analytics platform: it connects a company's AI tool admin consoles (Claude, ChatGPT, Cursor, GitHub Copilot, Gemini, Microsoft Copilot, Vercel AI Gateway, Notion AI, Replit, Windsurf, Lovable, Bolt, Perplexity, Glean, and custom connectors) into one governed view of adoption, spend, and return.

Product concepts you can explain:
- Adoption: how many people with a seat actually use their AI tools, and how deeply. Shown as active users out of total seats, per tool and per department.
- AI score / depth: a DERIVED measure of how substantially someone uses AI (chained workflows, breadth of tools, consistency), not raw message counts.
- Cost per active user: spend divided by people actually using the tool, so idle seats are visible.
- Idle seats: paid seats with no meaningful activity. A key source of reclaimable spend.
- Hours modeled: an estimate of time saved, always MODELED with a plus-minus band, never a bare number.

Non-negotiable rules you must reflect accurately:
- Read-only and metadata-only. Prompts, conversations, and file content are never read. DepthData cannot change anything in anyone's vendor account.
- Every number carries a confidence label: MEASURED (straight from a vendor API), DERIVED (computed from measured inputs, formula shown), MODELED (estimate with a band), ALLOCATED (real total split by a stated rule).
- If a vendor's API does not expose something, it stays a visible gap. Never invent numbers. Examples: Replit pools AI credits so per-user Replit cost is a gap; Gemini cost is bundled into the Workspace license.
- Data freshness: vendor APIs report daily aggregates. Cost is hours to a day behind, engagement up to a few days. Numbers are as of last sync, not live.

Current state, be honest about it:
- The product is a demo running on clearly labeled sample data. Connectors are in active development.
- Pricing is not set; early design partners are being onboarded. Invite interested users to leave contact details via the Report tab or email.

Style: concise (2-5 sentences unless more is truly needed), plain language, no hype, never invent capabilities or roadmap dates. If you do not know, say so and point to the Report tab. Do not use em dashes.`;


async function logQuestion(messages) {
  try {
    const url = process.env.SUPABASE_URL, key = process.env.SUPABASE_SERVICE_KEY;
    if (!url || !key || !Array.isArray(messages)) return;
    const userMsgs = messages.filter((m) => m && m.role === 'user');
    if (userMsgs.length !== 1) return; // log only the first question of a session
    const q = String(userMsgs[0].content || '').slice(0, 500);
    if (q.length < 3) return;
    await fetch(url.replace(/\/$/, '') + '/rest/v1/support_logs', {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'return=minimal' },
      body: JSON.stringify({ question: q, page: 'help desk' }),
    });
  } catch (e) {}
}

export default async function handler(req, res) {
  if (req.method !== 'POST') {
    res.status(405).json({ error: 'POST only' });
    return;
  }
  const key = process.env.ANTHROPIC_API_KEY;
  if (!key) {
    res.status(500).json({ error: 'ANTHROPIC_API_KEY not configured' });
    return;
  }
  try {
    const { messages } = req.body || {};
  logQuestion(messages);
    if (!Array.isArray(messages) || messages.length === 0) {
      res.status(400).json({ error: 'messages required' });
      return;
    }
    // keep only role/content, cap history to last 12 turns
    const clean = messages.slice(-12).map(m => ({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || '').slice(0, 4000)
    }));
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-6',
        max_tokens: 700,
        system: KB_SYSTEM,
        messages: clean
      })
    });
    if (!r.ok) {
      const t = await r.text();
      res.status(502).json({ error: 'upstream ' + r.status, detail: t.slice(0, 200) });
      return;
    }
    const data = await r.json();
    let reply = '';
    if (data && Array.isArray(data.content)) {
      for (const block of data.content) {
        if (block.type === 'text') reply += block.text;
      }
    }
    if (!reply) {
      res.status(502).json({ error: 'empty reply' });
      return;
    }
    res.status(200).json({ reply });
  } catch (e) {
    res.status(500).json({ error: String(e && e.message || e).slice(0, 200) });
  }
}
