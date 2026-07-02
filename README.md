# WinningVocal — website

Marketing site for WinningVocal with:

- A **live AI voice demo** — visitors talk to your Ravan (Agni) agent right in the browser (WebRTC via LiveKit). After **2 test calls**, a pop-up invites them to speak to a human.
- A **contact form** and the **"talk to a human"** pop-up, both forwarded to your **Make.com** webhook.
- A dedicated dark **Nightlife** section featuring **ClubLifter** and a rotating client-logo wall.

It's a tiny Node/Express app: it serves the static site and exposes two small API routes that keep your secrets on the server.

---

## Run locally

```bash
npm install
cp .env.example .env      # then fill in the values (see below)
npm start                 # http://localhost:3000
```

## Environment variables

Set these locally in `.env` (never committed) and in **Railway → your service → Variables**:

| Variable          | Required | What it is                                                        |
| ----------------- | -------- | ----------------------------------------------------------------- |
| `RAVAN_API_KEY`   | yes      | Your Ravan API key (**secret** — server-side only).               |
| `RAVAN_AGENT_ID`  | yes      | The agent that answers the demo calls.                            |
| `RAVAN_API_URL`   | no       | Defaults to `https://api.ravan.ai/api/v1/calling/create-call`.    |
| `MAKE_WEBHOOK_URL`| no       | Your Make.com webhook. Defaults to the hook already wired in.     |
| `PORT`            | no       | Railway sets this automatically.                                  |

> The live `.env` (with your real key) is git-ignored, so it will **not** be pushed to GitHub. Add the same variables in Railway so production works.

---

## Deploy to Railway via GitHub

1. **Create the GitHub repo and push:**
   ```bash
   git init
   git add .
   git commit -m "WinningVocal site"
   git branch -M main
   git remote add origin https://github.com/<you>/winningvocal-site.git
   git push -u origin main
   ```
2. In **Railway** → *New Project* → *Deploy from GitHub repo* → pick this repo.
3. In the service's **Variables**, add `RAVAN_API_KEY` and `RAVAN_AGENT_ID` (and `MAKE_WEBHOOK_URL` if you want to override the default).
4. Railway auto-detects Node and runs `npm start`. Once it's live, open the generated URL and add your custom domain if you like.

Nixpacks/`railway.json` are already configured, so no extra build settings are needed.

---

## Notes

- **Security:** the Ravan key is only read from an environment variable and is never sent to the browser. The browser only receives the short-lived LiveKit token needed to join a single call.
- **`web_call` phone fields:** Ravan's docs list `from_phone_number`/`to_phone_number` as required, but they aren't used for browser calls, so the server omits them. If Ravan ever rejects the request, the exact error is logged and returned — send empty strings for those fields in `server.js` if needed.
- **Test limit:** the "2 tests then talk-to-a-human" gate is tracked per browser session (`sessionStorage`). It's a soft nudge, not hard security.
- **Assets:** logos and images live in `public/assets/`.
