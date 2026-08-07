# Vack Voice 🎙️

Turn text into speech in seconds. AI Voice SaaS by **Storxie Nexus**.

## Features
- 5 natural voices including African accents: **Ryan 🇬🇧**, **Ezinne 🇳🇬**, **Chilemba 🇰🇪**, **Guy 🇺🇸**, **Sonia 🇺🇸**
- Free plan: 3,000 credits/month (1 credit = 1 word)
- Pro plan: ₦5,000/month = 100,000 credits + unlimited uploads
- Extra credits: ₦500 = 5,000 (never expire)
- MP3 output, no watermark
- Referral program: +500 credits per friend, +1,000 when they go Pro

## Tech Stack
- Node.js + Express backend
- Microsoft Edge neural TTS (free) via `edge-tts` Python package
- Vanilla JS frontend (no framework, fast)

## Run Locally
```bash
# 1. Install edge-tts
python3 -m venv ~/vv-venv
~/vv-venv/bin/pip install edge-tts

# 2. Install node deps
npm install

# 3. Start
npm start
# → http://localhost:3000
```

## API
- `GET /api/voices` — list available voices
- `GET /api/me` — current user credits/status
- `POST /api/tts` — body: `{ "text": "...", "voice": "ryan" }` → returns `{ audioUrl, words, creditsLeft }`

## Roadmap
- [ ] User accounts + auth
- [ ] Paystack integration (Pro subscriptions)
- [ ] Referral engine
- [ ] File upload (PDF/DOCX)
- [ ] Hostinger Cloud deployment

© 2026 Storxie Nexus
