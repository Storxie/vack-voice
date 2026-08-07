#!/usr/bin/env node
/**
 * Vack Voice - AI Voice SaaS
 * Server: Express + edge-tts (Microsoft Edge neural voices, free)
 * Credit system: 1 credit = 1 word. Free 3,000/mo. Pro ₦5,000/mo = 100K.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;
const AUDIO_DIR = path.join(os.tmpdir(), 'vack-voice-audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

// ---------- VOICES ----------
// Key: voice id shown in UI -> edge-tts voice name
const VOICES = {
  ryan:     { name: 'Ryan',     edge: 'en-GB-RyanNeural',      flag: '🇬🇧', desc: 'British, clear, professional' },
  ezinne:   { name: 'Ezinne',   edge: 'en-NG-EzinneNeural',    flag: '🇳🇬', desc: 'Nigerian English, warm' },
  chilemba: { name: 'Chilemba', edge: 'en-KE-ChilembaNeural',  flag: '🇰🇪', desc: 'Kenyan English, upbeat' },
  guy:      { name: 'Guy',      edge: 'en-US-GuyNeural',       flag: '🇺🇸', desc: 'American, friendly' },
  sonia:    { name: 'Sonia',    edge: 'en-US-SoniaNeural',     flag: '🇺🇸', desc: 'American, soft' },
};

// ---------- CREDITS (simple JSON store for v0.1) ----------
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
const DB_DIR = path.dirname(DB_FILE);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

function loadDb() {
  try { return JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { return { users: {} }; }
}
function saveDb(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// Demo user so Cornelius can test without signup
function ensureDemoUser(db) {
  const uid = 'demo';
  if (!db.users[uid]) {
    db.users[uid] = {
      name: 'Demo User',
      plan: 'free',
      credits: 3000,
      creditsUsed: 0,
      month: monthKey(),
      referrals: 0,
      referralCode: 'Demo_7Xk2',
    };
    saveDb(db);
  }
  // Reset monthly credits
  if (db.users[uid].month !== monthKey()) {
    if (db.users[uid].plan === 'free') {
      db.users[uid].credits = 3000;
      db.users[uid].creditsUsed = 0;
    }
    db.users[uid].month = monthKey();
    saveDb(db);
  }
  return db.users[uid];
}
function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- TTS via edge-tts (python) ----------
function runTts(text, voiceEdge, outFile) {
  return new Promise((resolve, reject) => {
    const py = '/home/ubuntu/vv-venv/bin/python';
    const args = ['-m', 'edge_tts', '--voice', voiceEdge, '--text', text, '--write-media', outFile];
    execFile(py, args, { timeout: 60000, maxBuffer: 10 * 1024 * 1024 }, (err, stdout, stderr) => {
      if (err) return reject(new Error(stderr || err.message));
      resolve(outFile);
    });
  });
}

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: '2mb' }));

// ---------- API ----------
// Voices list
app.get('/api/voices', (req, res) => {
  res.json({ voices: Object.entries(VOICES).map(([id, v]) => ({ id, ...v })) });
});

// User status (demo for now)
app.get('/api/me', (req, res) => {
  const db = loadDb();
  const user = ensureDemoUser(db);
  res.json({
    name: user.name,
    plan: user.plan,
    credits: user.credits,
    creditsUsed: user.creditsUsed,
    freeLimit: 3000,
    referralCode: user.referralCode,
    referrals: user.referrals,
  });
});

// Generate speech
app.post('/api/tts', async (req, res) => {
  const { text, voice = 'ryan' } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required' });
  const words = text.trim().split(/\s+/).length;
  if (words > 5000) return res.status(400).json({ error: 'Too long. Max 5,000 words per request. Use Pro for longer.' });

  const v = VOICES[voice];
  if (!v) return res.status(400).json({ error: 'Unknown voice' });

  const db = loadDb();
  const user = ensureDemoUser(db);
  if (user.credits < words) {
    return res.status(402).json({
      error: 'Not enough credits',
      needed: words,
      have: user.credits,
      upgrade: true,
    });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const outFile = path.join(AUDIO_DIR, `${id}.mp3`);
  try {
    await runTts(text, v.edge, outFile);
    // Deduct credits AFTER successful generation
    user.credits -= words;
    user.creditsUsed += words;
    saveDb(db);
    res.json({
      audioUrl: `/audio/${id}.mp3`,
      words,
      creditsLeft: user.credits,
      creditsUsed: user.creditsUsed,
      voice: v.name,
    });
  } catch (e) {
    console.error('TTS error:', e.message);
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

// Serve generated audio
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1h' }));

// ---------- FRONTEND ----------
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`🚀 Vack Voice running on http://localhost:${PORT}`);
  console.log(`Voices: ${Object.values(VOICES).map(v => v.name).join(', ')}`);
});
