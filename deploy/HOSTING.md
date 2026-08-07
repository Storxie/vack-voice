# Vack Voice — Hosting Guide (Hostinger Cloud / any Node host)

Vack Voice is a Node.js (Express) app. It uses:
- **Edge TTS** (free Microsoft neural voices) via the local `~/vv-venv` Python venv
- A JSON database at `data/db.json` (fine for beta; swap to MongoDB/Postgres at scale)

## 1. Requirements
- Node.js >= 18
- Python 3 + a venv with `edge-tts` installed:
  ```bash
  python3 -m venv ~/vv-venv
  ~/vv-venv/bin/pip install edge-tts
  ```
  (The server calls `~/vv-venv/bin/python -m edge_tts ...` — adjust the path in `server/index.js` if you deploy elsewhere.)

## 2. Install & run
```bash
cd /home/ubuntu/vack-voice
npm install
cp deploy/.env.example .env    # then fill in SITE_URL + Paystack keys
PORT=3001 node server/index.js
```

## 3. Run as a service (systemd, Linux)
```bash
sudo cp deploy/vack-voice.service /etc/systemd/system/
sudo systemctl daemon-reload
sudo systemctl enable --now vack-voice
sudo systemctl status vack-voice
```

## 4. Hostinger Cloud deployment
1. Push this repo to GitHub (see below).
2. Hostinger Cloud → create a Node.js app → point it at the repo.
3. Set env vars (PORT, SITE_URL, PAYSTACK_SECRET_KEY, PAYSTACK_PUBLIC_KEY) in the Hostinger dashboard.
4. Buy the ~$1 domain (e.g. `vackvoice.com`) and point its DNS A record to your Hostinger Cloud IP.
5. HTTPS is automatic with Hostinger's free SSL.

## 5. Pushing code to GitHub (this machine)
The repo is `github.com/Storxie/vack-voice` (public, main). The PAT is read-only, so push via Composio:

```bash
# Build a payload with the changed files, then:
composio execute GITHUB_COMMIT_MULTIPLE_FILES -d @payload.json
```

## 6. Paystack
- Create keys at https://dashboard.paystack.com/#/settings/developers (test first)
- For **Pro subscription** recurring billing, create a Paystack **Plan** in the dashboard and pass its `plan_code` in `/api/pay/initialize` (currently the code charges a one-time ₦5,000 and grants 100K credits for the month — swap to `plan` in the Paystack payload when you want true auto-renewal).
- Test cards: `4084 0840 8408 4081`, any future expiry, any CVV, PIN `0000`, OTP `123456`.

## 7. Test URLs
- App: `http://localhost:3001` (or your domain)
- Public share pages: `/s/<shareId>`
