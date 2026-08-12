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
app.use(express.urlencoded({ extended: true, limit: '1mb' })); // for the plain-HTML SMS consent form
app.use(express.static(path.join(__dirname, 'public')));

// Clean URLs for the legal pages required by Twilio A2P 10DLC / TCR review.
// Server-rendered static HTML, no client-side JS involved.
app.get('/privacy', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'privacy.html'));
});
app.get('/terms', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'terms.html'));
});
app.get('/sms-consent', (_req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'sms-consent.html'));
});

// ---- Configuration (set these in Railway → Variables) ----------------------
const RAVAN_API_URL =
  process.env.RAVAN_API_URL || 'https://api.ravan.ai/api/v1/calling/create-call';
const RAVAN_API_KEY = process.env.RAVAN_API_KEY || '';   // secret — env only
const RAVAN_AGENT_ID = process.env.RAVAN_AGENT_ID || ''; // Iris — the always-on demo agent
const RAVAN_AGENT_ID_CUSTOM = process.env.RAVAN_AGENT_ID_CUSTOM || ''; // James — "Build Your Own Agent"
const ANTHROPIC_API_KEY = process.env.ANTHROPIC_API_KEY || ''; // powers Iris's optional website lookup
const MAKE_WEBHOOK_URL =
  process.env.MAKE_WEBHOOK_URL ||
  'https://hook.us1.make.com/2duhuouszq919zesc4arpcfaarp2br9g';

// Lets the front-end show a friendly "demo not configured yet" message
// without ever exposing the key.
app.get('/api/config', (_req, res) => {
  res.json({
    demoConfigured: Boolean(RAVAN_API_KEY && RAVAN_AGENT_ID),
    customDemoConfigured: Boolean(RAVAN_API_KEY && RAVAN_AGENT_ID_CUSTOM),
  });
});

function cleanStr(v, max = 200) {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

// Very small HTML → text stripper. Good enough for typical server-rendered
// small-business marketing sites; not meant to handle heavy JS-only SPAs.
function htmlToText(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<!--[\s\S]*?-->/g, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
}

// ---- Optional: look up a caller's business from their website -------------
// Fetches the site, asks Claude to pull out the essentials, and returns them
// so James can open the call already knowing who he's talking to. Designed to
// fail silently and quickly — this is enrichment, never a hard dependency for
// starting the call.
async function lookupBusinessFromWebsite(rawUrl) {
  const empty = { company_name: '', main_products_services: '' };
  if (!rawUrl || !ANTHROPIC_API_KEY) {
    if (rawUrl && !ANTHROPIC_API_KEY) {
      console.log('Website lookup skipped: ANTHROPIC_API_KEY is not set.');
    }
    return empty;
  }

  let url = rawUrl.trim();
  if (!/^https?:\/\//i.test(url)) url = `https://${url}`;
  try {
    new URL(url); // throws on garbage input
  } catch {
    return empty;
  }

  let pageText = '';
  try {
    const siteRes = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; WinningVocalBot/1.0)' },
      signal: AbortSignal.timeout(6000),
      redirect: 'follow',
    });
    const html = await siteRes.text();
    pageText = htmlToText(html).slice(0, 6000);
  } catch (err) {
    console.error('Website lookup fetch failed:', url, err.message);
    return empty;
  }
  if (pageText.length < 40) return empty; // too little to work with (likely JS-only site)

  try {
    const claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': ANTHROPIC_API_KEY,
        'anthropic-version': '2023-06-01',
      },
      body: JSON.stringify({
        model: 'claude-haiku-4-5-20251001',
        max_tokens: 300,
        messages: [
          {
            role: 'user',
            content:
              'You are extracting business information from raw website text for a phone call script. ' +
              'Respond with ONLY a JSON object, no markdown, no explanation, with exactly these keys: ' +
              '"company_name" (the business name, empty string if unclear), ' +
              '"main_products_services" (a short, spoken-friendly phrase describing what they offer, ' +
              'max ~15 words, empty string if unclear). ' +
              `Website text:\n\n${pageText}`,
          },
        ],
      }),
      signal: AbortSignal.timeout(8000),
    });
    if (!claudeRes.ok) {
      console.error('Website lookup Claude call failed:', claudeRes.status, await claudeRes.text());
      return empty;
    }
    const data = await claudeRes.json();
    const raw = (data?.content || []).map((b) => b.text || '').join('').trim();
    const jsonMatch = raw.match(/\{[\s\S]*\}/); // strip stray ```json fences if Claude adds them
    const parsed = JSON.parse(jsonMatch ? jsonMatch[0] : raw);
    const result = {
      company_name: cleanStr(parsed.company_name, 120),
      main_products_services: cleanStr(parsed.main_products_services, 200),
    };
    console.log('Website lookup succeeded:', url, result);
    return result;
  } catch (err) {
    console.error('Website lookup Claude call error:', err.message);
    return empty;
  }
}

// ---- Create a browser (web) call with the Ravan agent ----------------------
app.post('/api/create-call', async (req, res) => {
  const mode = req.body?.mode === 'james' ? 'james' : 'iris';

  let payload;

  if (mode === 'james') {
    if (!RAVAN_API_KEY || !RAVAN_AGENT_ID_CUSTOM) {
      return res.status(503).json({
        error:
          'The "Build Your Own Agent" demo isn’t configured on the server yet. Set RAVAN_AGENT_ID_CUSTOM.',
      });
    }
    const visitorName = cleanStr(req.body?.visitor_name);
    const companyName = cleanStr(req.body?.company_name);
    const businessDescription = cleanStr(req.body?.business_description, 500);
    const behavior = cleanStr(req.body?.behavior, 200);
    if (!visitorName || !companyName || !businessDescription) {
      return res.status(400).json({
        error: 'visitor_name, company_name and business_description are required.',
      });
    }
    payload = {
      type: 'web_call',
      agent_id: RAVAN_AGENT_ID_CUSTOM,
      metadata: {
        source: 'winningvocal-website-build-your-own',
        visitor_name: visitorName,
        company_name: companyName,
      },
      prompt_dynamic_variables: {
        visitor_name: visitorName,
        company_name: companyName,
        business_description: businessDescription,
        behavior: behavior || 'Professional, warm, and confident',
      },
    };
  } else {
    if (!RAVAN_API_KEY || !RAVAN_AGENT_ID) {
      return res.status(503).json({
        error:
          'The live demo isn’t configured on the server yet. Set RAVAN_API_KEY and RAVAN_AGENT_ID.',
      });
    }
    const fullName = cleanStr(req.body?.full_name);
    const businessType = cleanStr(req.body?.business_type);
    const website = cleanStr(req.body?.website, 300);
    if (!fullName || !businessType) {
      return res
        .status(400)
        .json({ error: 'full_name and business_type are required.' });
    }

    // Enrichment only — never blocks or fails the call if the site is
    // unreachable, empty, or ANTHROPIC_API_KEY isn't set.
    const { company_name, main_products_services } = await lookupBusinessFromWebsite(website);
    // A dedicated flag, separate from company_name/main_products_services.
    // Ravan substitutes {{...}} everywhere in the prompt, including inside
    // conditional instructions — so checking "if {{company_name}} is empty"
    // directly breaks once substitution runs (the check text itself gets
    // blanked out along with it). This flag is only ever "yes" or "no", so
    // it's safe to branch on.
    const hasWebsiteInfo = company_name || main_products_services ? 'yes' : 'no';

    // Payload for a browser-based call. Per the Ravan docs, `type: "web_call"`
    // returns a LiveKit access_token + url instead of dialling a phone number,
    // so the phone fields aren't used here. The values the agent needs are
    // injected through prompt_dynamic_variables (full_name, business_type,
    // plus company_name / main_products_services / has_website_info when the
    // website lookup found something — Iris's prompt checks has_website_info
    // and adapts accordingly).
    payload = {
      type: 'web_call',
      agent_id: RAVAN_AGENT_ID,
      metadata: { source: 'winningvocal-website', full_name: fullName, business_type: businessType },
      prompt_dynamic_variables: {
        full_name: fullName,
        business_type: businessType,
        company_name,
        main_products_services,
        has_website_info: hasWebsiteInfo,
      },
    };
  }

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

// ---- SMS Consent Form submission (plain HTML form POST, no JS) -------------
app.post('/api/sms-consent', async (req, res) => {
  const body = {
    type: 'sms_consent',
    full_name: cleanStr(req.body?.full_name),
    company_name: cleanStr(req.body?.company_name),
    mobile_phone: cleanStr(req.body?.mobile_phone, 40),
    relationship: cleanStr(req.body?.relationship, 60),
    sms_consent: req.body?.sms_consent === 'yes',
    signature: cleanStr(req.body?.signature),
    sign_date: cleanStr(req.body?.sign_date, 20),
    submitted_at: new Date().toISOString(),
  };

  if (!body.full_name || !body.company_name || !body.mobile_phone || !body.relationship || !body.signature || !body.sign_date) {
    return res.status(400).send(
      'Missing required fields. Please go back and fill in every field (the SMS notifications checkbox is the only optional one).'
    );
  }

  try {
    const r = await fetch(MAKE_WEBHOOK_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(8000),
    });
    if (!r.ok) console.error('Make webhook (sms-consent) failed:', r.status, await r.text());
  } catch (err) {
    console.error('Make webhook (sms-consent) error:', err);
    // Don't block the user on a webhook hiccup — the form itself is the
    // compliance record; still show the confirmation below.
  }

  // Plain server-rendered confirmation — this is a normal (non-AJAX) form
  // submission, so the browser navigates here directly. No JS involved.
  res.send(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8" />
<meta name="viewport" content="width=device-width, initial-scale=1.0" />
<title>Thank you — WinningVocal</title>
<link rel="icon" href="/assets/logo-black.png" />
<link rel="stylesheet" href="/styles.css" />
</head>
<body>
<header class="legal__header">
  <div class="wrap legal__header-inner">
    <a href="/" class="legal__logo"><img src="/assets/logo-black.png" alt="WinningVocal" /></a>
    <a href="/" class="legal__back">&larr; Back to site</a>
  </div>
</header>
<main class="legal">
  <div class="wrap legal__thanks">
    <h1>Thank you, ${body.sms_consent ? 'your preference has been recorded' : 'your form has been submitted'}.</h1>
    <p>${body.sms_consent
      ? 'You will receive SMS account and service notifications at the number provided. Reply STOP at any time to opt out, or HELP for help.'
      : 'You have not opted in to SMS notifications. This does not affect your service, pricing, support, or job duties.'}</p>
    <p><a href="/sms-consent">&larr; Back to the SMS Consent Form</a> &nbsp;|&nbsp; <a href="/">Return to winningvocal.com</a></p>
  </div>
</main>
<footer class="footer">
  <div class="wrap">
    <div class="footer__bar"><span>&copy; 2026 WinningVocal. All rights reserved.</span></div>
    <div class="footer__legal">Winning Vocal is a registered DBA of World Services and Sales LLC.</div>
  </div>
</footer>
</body>
</html>`);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`WinningVocal site running on port ${PORT}`));
