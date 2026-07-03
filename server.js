// WinningVocal site server
// - Serves the static site in /public
// - POST /api/create-call : creates a Ravan (Agni) *web* call and returns the
//   LiveKit connection details the browser needs. The Ravan API key stays here,
//   on the server, and is never sent to the browser.
// - POST /api/contact : forwards a contact request to the Make.com webhook.
//
// Requires Node >= 18 (uses the built-in global fetch).

// Load .env for local dev. On Railway, real values come from the dashboard
// Variables (no .env file present), so this is a harmless no-op there.
try { require('dotenv').config(); } catch (_) {}

const path = require('path');
const express = require('express');

const app = express();
app.use(express.json({ limit: '1mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ---- Configuration (set these in Railway → Variables) ----------------------
const RAVAN_API_URL =
  process.env.RAVAN_API_URL || 'https://api.ravan.ai/api/v1/calling/create-call';
const RAVAN_API_KEY = process.env.RAVAN_API_KEY || '';   // secret — env only
const RAVAN_AGENT_ID = process.env.RAVAN_AGENT_ID || ''; // the demo agent id
const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL ||
  'https://hook.us1.make.com/2duhuouszq919zesc4arpcfaarp2br9g';

// Lets the front-end show a friendly "demo not configured yet" message
// without ever exposing the key.
app.get('/api/config', (_req, res) => {
  res.json({ demoConfigured: Boolean(RAVAN_API_KEY && RAVAN_AGENT_ID) });
});

function cleanStr(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// ---- Create a browser (web) call with the Ravan agent ----------------------
app.post('/api/create-call', async (req, res) => {
  if (!RAVAN_API_KEY || !RAVAN_AGENT_ID) {
    return res.status(503).json({
      error:
        'The live demo isn’t configured on the server yet. Set RAVAN_API_KEY and RAVAN_AGENT_ID.',
    });
  }

  const fullName = cleanStr(req.body?.full_name);
  const businessType = cleanStr(req.body?.business_type);
  if (!fullName || !businessType) {
    return res
      .status(400)
      .json({ error: 'full_name and business_type are required.' });
  }

  // Payload for a browser-based call. Per the Ravan docs, `type: "web_call"`
  // returns a LiveKit access_token + url instead of dialling a phone number,
  // so the phone fields aren't used here. The values the agent needs are
  // injected through prompt_dynamic_variables (full_name, business_type).
  const payload = {
    type: 'web_call',
    agent_id: RAVAN_AGENT_ID,
    metadata: { source: 'winningvocal-website', full_name: fullName, business_type: businessType },
    prompt_dynamic_variables: { full_name: fullName, business_type: businessType },
  };

  try {
    const r = await fetch(RAVAN_API_URL, {
      method: 'POST',
      // The key is sent via both common conventions; Ravan uses whichever it
      // recognizes and ignores the other. If your account requires a specific
      // one, keep just that header.
      headers: {
        'Content-Type': 'application/json',
        'X-Api-Key': RAVAN_API_KEY,
        Authorization: `Bearer ${RAVAN_API_KEY}`,
      },
      body: JSON.stringify(payload),
    });

    const text = await r.text();
    let data;
    try {
      data = JSON.parse(text);
    } catch {
      data = { raw: text };
    }

    if (!r.ok) {
      // Surface Ravan's own message so any mismatch is easy to debug.
      console.error('Ravan create-call failed:', r.status, text);
      return res
        .status(502)
        .json({ error: 'Could not start the call.', status: r.status, detail: data });
    }

    // Ravan returned success. Find the LiveKit token + websocket URL wherever
    // they live in the response (field names/nesting can vary by API version).
    const norm = (k) => k.toLowerCase().replace(/[^a-z]/g, '');
    const findByKeys = (obj, keys, test) => {
      const seen = new Set();
      const queue = [obj];
      while (queue.length) {
        const cur = queue.shift();
        if (!cur || typeof cur !== 'object' || seen.has(cur)) continue;
        seen.add(cur);
        for (const [k, v] of Object.entries(cur)) {
          if (typeof v === 'string' && v && keys.includes(norm(k)) && (!test || test(v))) return v;
          if (v && typeof v === 'object') queue.push(v);
        }
      }
      return undefined;
    };

    const token = findByKeys(data, [
      'accesstoken', 'token', 'jwt', 'livekittoken', 'participanttoken', 'authtoken',
    ]);
    let url =
      findByKeys(
        data,
        ['url', 'wsurl', 'wssurl', 'serverurl', 'livekiturl', 'websocketurl', 'socketurl', 'livekitwsurl'],
        (v) => /^(wss?|https?):\/\//i.test(v)
      ) || findByKeys(data, [], (v) => /^wss?:\/\//i.test(v)); // any ws(s):// string

    const roomId = findByKeys(data, ['roomid', 'room', 'roomname']);
    const sessionId = findByKeys(data, ['sessionid', 'session', 'callid']);

    if (token && url) {
      return res.json({ access_token: token, url, room_id: roomId, session_id: sessionId });
    }

    // Success status but we couldn't locate the connection details — return the
    // raw response so it can be inspected in the browser console and logs.
    console.error('Ravan 2xx but no token/url found. Raw response:', text);
    return res.status(502).json({
      error: 'The call was created but connection details were missing from the response.',
      raw: data,
    });
  } catch (err) {
    console.error('Ravan create-call error:', err);
    return res.status(502).json({ error: 'Could not reach the calling service.' });
  }
});

// ---- Forward a contact request to Make.com ---------------------------------
app.post('/api/contact', async (req, res) => {
  const body = {
    name: cleanStr(req.body?.name),
    email: cleanStr(req.body?.email),
    phone: cleanStr(req.body?.phone, 60),
    message: cleanStr(req.body?.message, 3000),
    source: cleanStr(req.body?.source, 60) || 'website',
    submitted_at: new Date().toISOString(),
  };

  if (!body.name || !body.email) {
    return res.status(400).json({ error: 'Name and email are required.' });
  }

  try {
    const r = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!r.ok) {
      const text = await r.text();
      console.error('Make webhook failed:', r.status, text);
      return res.status(502).json({ error: 'Could not submit your request. Please try again.' });
    }
    return res.json({ ok: true });
  } catch (err) {
    console.error('Make webhook error:', err);
    return res.status(502).json({ error: 'Could not submit your request. Please try again.' });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WinningVocal site running on port ${PORT}`));
