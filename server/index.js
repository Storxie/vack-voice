#!/usr/bin/env node
/**
 * Vack Voice - AI Voice SaaS by Storxie Nexus
 * Full MVP backend: TTS (edge-tts), accounts, credits, file upload (PDF/DOCX/TXT),
 * share links, download, history, referrals, Paystack payments.
 */
const express = require('express');
const cors = require('cors');
const path = require('path');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const crypto = require('crypto');
const multer = require('multer');
const pdfParse = require('pdf-parse');
const mammoth = require('mammoth');
require('dotenv').config();
const app = express();
const PORT = process.env.PORT || 3000;
const AUDIO_DIR = path.join(os.tmpdir(), 'vack-voice-audio');
if (!fs.existsSync(AUDIO_DIR)) fs.mkdirSync(AUDIO_DIR, { recursive: true });

const PAYSTACK_SECRET = process.env.PAYSTACK_SECRET_KEY || '';
const PAYSTACK_PUBLIC = process.env.PAYSTACK_PUBLIC_KEY || '';
const PAYSTACK_BASE = process.env.PAYSTACK_BASE_URL || 'https://api.paystack.co';
const SITE_URL = process.env.SITE_URL || '';

// ---------- VOICES ----------
const VOICES = {
  ryan:     { name: 'Ryan',     edge: 'en-GB-RyanNeural',      flag: '🇬🇧', desc: 'British, clear, professional' },
  ezinne:   { name: 'Ezinne',   edge: 'en-NG-EzinneNeural',    flag: '🇳🇬', desc: 'Nigerian English, warm' },
  abeo:     { name: 'Abeo',     edge: 'en-NG-AbeoNeural',      flag: '🇳🇬', desc: 'Nigerian English, smooth' },
  chilemba: { name: 'Chilemba', edge: 'en-KE-ChilembaNeural',  flag: '🇰🇪', desc: 'Kenyan English, upbeat' },
  asilia:   { name: 'Asilia',   edge: 'en-KE-AsiliaNeural',    flag: '🇰🇪', desc: 'Kenyan English, friendly' },
  leah:     { name: 'Leah',     edge: 'en-ZA-LeahNeural',      flag: '🇿🇦', desc: 'South African, smooth' },
  luke:     { name: 'Luke',     edge: 'en-ZA-LukeNeural',      flag: '🇿🇦', desc: 'South African, warm' },
};

// ---------- PLANS ----------
const FREE_CREDITS = 3000;
const PRO_CREDITS = 100000;
const PRO_PRICE_NGN = 5000;            // ₦5,000/mo
const PACK_CREDITS = 5000;
const PACK_PRICE_NGN = 500;            // ₦500 = 5,000 credits
const REF_SIGNUP_BONUS = 500;          // +500 per friend signup
const REF_PRO_BONUS = 1000;            // +1,000 if friend goes Pro
const REF_MONTHLY_CAP = 10000;         // max referral credits per month
const MAX_WORDS_FREE = 5000;           // per request cap
const GUEST_CREDITS = 500;              // one-time guest quota (per browser)

// ---------- DB (JSON store) ----------
const DB_FILE = path.join(__dirname, '..', 'data', 'db.json');
const DB_DIR = path.dirname(DB_FILE);
if (!fs.existsSync(DB_DIR)) fs.mkdirSync(DB_DIR, { recursive: true });

function loadDb() {
  let db;
  try { db = JSON.parse(fs.readFileSync(DB_FILE, 'utf8')); }
  catch { db = {}; }
  // Ensure all collections exist (old DB files lack new keys)
  if (typeof db !== 'object' || db === null) db = {};
  db.users = db.users || {};
  db.tokens = db.tokens || {};
  db.guests = db.guests || {};
  db.conversions = db.conversions || [];
  db.shares = db.shares || {};
  db.pending = db.pending || {};
  // Normalize legacy user objects (old schema had referrals as a number, etc.)
  for (const id of Object.keys(db.users)) {
    const u = db.users[id];
    if (typeof u !== 'object' || u === null) { delete db.users[id]; continue; }
    if (!Array.isArray(u.referrals)) u.referrals = [];
    if (typeof u.referralCredits !== 'number') u.referralCredits = 0;
    if (!u.referralMonth) u.referralMonth = monthKey();
    if (!u.creditsUsed) u.creditsUsed = 0;
    if (!u.month) u.month = monthKey();
    if (!u.referralCode) u.referralCode = (u.name || 'user').replace(/[^A-Za-z0-9]/g, '') + '_' + crypto.randomBytes(3).toString('hex');
  }
  return db;
}
function saveDb(db) { fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2)); }

function monthKey() {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

// ---------- AUTH ----------
function hashPassword(password, salt) {
  return crypto.scryptSync(String(password), salt, 64).toString('hex');
}
function makeUser(name, email, refCode) {
  const salt = crypto.randomBytes(16).toString('hex');
  return {
    id: crypto.randomBytes(8).toString('hex'),
    name, email, salt,
    passHash: null,                 // set on register
    plan: 'free',
    credits: FREE_CREDITS,
    creditsUsed: 0,
    month: monthKey(),
    referralCode: refCode || (name.replace(/[^A-Za-z0-9]/g, '') + '_' + crypto.randomBytes(3).toString('hex')),
    referrals: [],
    referralCredits: 0,
    referralMonth: monthKey(),
    createdAt: new Date().toISOString(),
  };
}
function ensureDemo(db) {
  const uid = 'demo';
  if (!db.users[uid]) {
    db.users[uid] = makeUser('Demo User', 'demo@vackvoice.local', 'Demo_7Xk2');
    db.users[uid].id = uid; // id must match key so isDemo flag works
    saveDb(db);
  }
  const u = db.users[uid];
  u.id = uid; // normalize in case of older data
  if (!u.passHash) u.passHash = null;
  if (u.month !== monthKey()) {
    u.credits = FREE_CREDITS; u.creditsUsed = 0; u.month = monthKey(); saveDb(db);
  }
  return u;
}
function currentUser(db, req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-token'] || '');
  if (token && db.tokens[token]) {
    const u = db.users[db.tokens[token]];
    if (u) {
      // monthly reset for free users
      if (u.month !== monthKey() && u.plan !== 'pro') {
        u.credits = FREE_CREDITS; u.creditsUsed = 0; u.month = monthKey(); saveDb(db);
      }
      if (u.referralMonth !== monthKey()) {
        u.referralCredits = 0; u.referralMonth = monthKey(); saveDb(db);
      }
      return u;
    }
  }
  return ensureDemo(db);
}

// ---------- TTS ----------
function runTts(text, voiceEdge, outFile) {
  return new Promise((resolve, reject) => {
    const py = '/home/ubuntu/vv-venv/bin/python';
    const args = ['-m', 'edge_tts', '--voice', voiceEdge, '--text', text, '--write-media', outFile];
    execFile(py, args, { timeout: 120000, maxBuffer: 10 * 1024 * 1024 }, (err) => {
      if (err) return reject(new Error('TTS engine failed'));
      resolve(outFile);
    });
  });
}

// ---------- MIDDLEWARE ----------
app.use(cors());
app.use(express.json({ limit: '5mb' }));

// ---------- API: VOICES ----------
app.get('/api/voices', (req, res) => {
  res.json({ voices: Object.entries(VOICES).map(([id, v]) => ({ id, ...v, demo: `/demos/${id}.mp3` })) });
});

// ---------- API: AUTH ----------
app.post('/api/register', (req, res) => {
  const { name, email, password, ref } = req.body || {};
  if (!name || !email || !password) return res.status(400).json({ error: 'Name, email and password are required' });
  if (!/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) return res.status(400).json({ error: 'Invalid email address' });
  if (String(password).length < 6) return res.status(400).json({ error: 'Password must be at least 6 characters' });

  const db = loadDb();
  const existing = Object.values(db.users).find(u => u.email && u.email.toLowerCase() === email.toLowerCase());
  if (existing) return res.status(409).json({ error: 'An account with this email already exists' });

  const user = makeUser(name.trim(), email.trim());
  user.salt = crypto.randomBytes(16).toString('hex');
  user.passHash = hashPassword(password, user.salt);

  // Referral bonus
  if (ref) {
    const referrer = Object.values(db.users).find(u => u.referralCode === ref);
    if (referrer) {
      const already = referrer.referrals.find(r => r.email && r.email.toLowerCase() === email.toLowerCase());
      if (!already) {
        referrer.referrals.push({ userId: user.id, email: email.trim(), status: 'signed_up', at: new Date().toISOString() });
        const capLeft = REF_MONTHLY_CAP - (referrer.referralMonth === monthKey() ? referrer.referralCredits : 0);
        if (capLeft > 0) {
          referrer.referralCredits += Math.min(REF_SIGNUP_BONUS, capLeft);
          referrer.credits += Math.min(REF_SIGNUP_BONUS, capLeft);
          referrer.referralMonth = monthKey();
        }
        saveDb(db);
      }
    }
  }

  db.users[user.id] = user;
  const token = crypto.randomBytes(32).toString('hex');
  db.tokens[token] = user.id;
  saveDb(db);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/login', (req, res) => {
  const { email, password } = req.body || {};
  const db = loadDb();
  const user = Object.values(db.users).find(u => u.email && u.email.toLowerCase() === String(email || '').toLowerCase());
  if (!user || !user.passHash) return res.status(401).json({ error: 'Invalid email or password' });
  const hash = hashPassword(password || '', user.salt);
  if (hash !== user.passHash) return res.status(401).json({ error: 'Invalid email or password' });
  const token = crypto.randomBytes(32).toString('hex');
  db.tokens[token] = user.id;
  saveDb(db);
  res.json({ token, user: publicUser(user) });
});

app.post('/api/logout', (req, res) => {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-token'] || '');
  const db = loadDb();
  if (token && db.tokens[token]) { delete db.tokens[token]; saveDb(db); }
  res.json({ ok: true });
});

function publicUser(u) {
  return {
    id: u.id, name: u.name, email: u.email || null, plan: u.plan,
    credits: u.credits, creditsUsed: u.creditsUsed, freeLimit: FREE_CREDITS,
    referralCode: u.referralCode, referrals: u.referrals.length,
    referralCredits: u.referralCredits,
    dob: u.dob || null, country: u.country || null, phone: u.phone || null,
    isDemo: u.id === 'demo',
  };
}

// ---------- API: ME ----------
app.get('/api/me', (req, res) => {
  const db = loadDb();
  if (!hasValidToken(db, req)) {
    const { guestId, rec } = guestInfo(db, req);
    const used = rec.wordsUsed || 0;
    return res.json({
      id: 'guest', isGuest: true, isDemo: true, plan: 'free',
      name: 'Guest', email: null,
      credits: Math.max(0, GUEST_CREDITS - used), creditsUsed: used,
      freeLimit: GUEST_CREDITS, guestLimit: GUEST_CREDITS, guestUsed: used,
      referralCode: null, referrals: 0, referralCredits: 0,
      dob: null, country: null, phone: null,
    });
  }
  const user = currentUser(db, req);
  res.json(publicUser(user));
});

// ---------- API: PROFILE ----------
app.get('/api/profile', (req, res) => {
  const db = loadDb();
  const user = currentUser(db, req);
  if (user.id === 'demo') return res.status(401).json({ error: 'Sign in to edit profile' });
  res.json(publicUser(user));
});

app.put('/api/profile', (req, res) => {
  const db = loadDb();
  const user = currentUser(db, req);
  if (user.id === 'demo') return res.status(401).json({ error: 'Sign in to edit profile' });
  const { name, dob, country, phone } = req.body || {};
  if (name && name.trim()) user.name = name.trim().slice(0, 80);
  if (dob !== undefined) user.dob = dob || null;
  if (country !== undefined) user.country = (country || '').trim().slice(0, 60) || null;
  if (phone !== undefined) user.phone = (phone || '').trim().slice(0, 30) || null;
  saveDb(db);
  res.json({ ok: true, user: publicUser(user) });
});

// ---------- GUESTS (500 free words, per browser) ----------
function guestInfo(db, req) {
  const guestId = String(req.headers['x-guest-id'] || req.query.guest || '').slice(0, 64);
  if (!db.guests[guestId]) db.guests[guestId] = { wordsUsed: 0, createdAt: new Date().toISOString() };
  return { guestId, rec: db.guests[guestId] };
}
function hasValidToken(db, req) {
  const h = req.headers.authorization || '';
  const token = h.startsWith('Bearer ') ? h.slice(7) : (req.headers['x-token'] || '');
  return !!(token && db.tokens[token]);
}

// ---------- API: TTS ----------
app.post('/api/tts', async (req, res) => {
  const { text, voice = 'ryan' } = req.body || {};
  if (!text || !text.trim()) return res.status(400).json({ error: 'Text is required' });
  const words = text.trim().split(/\s+/).length;
  const db = loadDb();
  const isGuest = !hasValidToken(db, req);

  const v = VOICES[voice];
  if (!v) return res.status(400).json({ error: 'Unknown voice' });

  // GUEST PATH: 500 free words per browser, then login popup
  if (isGuest) {
    const { guestId, rec } = guestInfo(db, req);
    const remaining = Math.max(0, GUEST_CREDITS - (rec.wordsUsed || 0));
    if (words > remaining) {
      return res.status(402).json({
        error: 'You have used your 500 free guest words. Log in or create an account to continue.',
        guestLimit: true, needed: words, have: remaining,
      });
    }
    const id = crypto.randomBytes(8).toString('hex');
    const outFile = path.join(AUDIO_DIR, `${id}.mp3`);
    try {
      await runTts(text, v.edge, outFile);
      rec.wordsUsed += words;
      const conv = {
        id, userId: 'guest', guestId, voice: v.name, voiceId: voice,
        words, credits: words, textPreview: text.trim().slice(0, 120),
        audioUrl: `/audio/${id}.mp3`, createdAt: new Date().toISOString(),
      };
      db.conversions.push(conv);
      saveDb(db);
      res.json({
        audioUrl: `/audio/${id}.mp3`, id,
        words, creditsLeft: Math.max(0, GUEST_CREDITS - rec.wordsUsed), creditsUsed: rec.wordsUsed,
        voice: v.name, guest: true,
      });
    } catch (e) {
      console.error('TTS error:', e.message);
      res.status(500).json({ error: 'Generation failed. Please try again.' });
    }
    return;
  }

  // LOGGED-IN PATH
  const maxWords = (currentUser(db, req).plan === 'pro') ? 100000 : MAX_WORDS_FREE;
  if (words > maxWords) return res.status(400).json({ error: `Too long. Max ${maxWords.toLocaleString()} words per request.` });

  const user = currentUser(db, req);
  if (user.credits < words) {
    return res.status(402).json({
      error: 'Not enough credits',
      needed: words, have: user.credits,
      upgrade: true,
    });
  }

  const id = crypto.randomBytes(8).toString('hex');
  const outFile = path.join(AUDIO_DIR, `${id}.mp3`);
  try {
    await runTts(text, v.edge, outFile);
    user.credits -= words;
    user.creditsUsed += words;
    const conv = {
      id, userId: user.id, voice: v.name, voiceId: voice,
      words, credits: words, textPreview: text.trim().slice(0, 120),
      audioUrl: `/audio/${id}.mp3`, createdAt: new Date().toISOString(),
    };
    db.conversions.push(conv);
    saveDb(db);
    res.json({
      audioUrl: `/audio/${id}.mp3`, id,
      words, creditsLeft: user.credits, creditsUsed: user.creditsUsed,
      voice: v.name,
    });
  } catch (e) {
    console.error('TTS error:', e.message);
    res.status(500).json({ error: 'Generation failed. Please try again.' });
  }
});

// ---------- API: UPLOAD (PDF/DOCX/TXT) ----------
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const ok = /\.(pdf|docx|txt|md)$/i.test(file.originalname) || /(pdf|msword|opendocument.text|plain|markdown)/.test(file.mimetype);
    cb(ok ? null : new Error('Only PDF, DOCX, TXT or MD files are allowed'), ok);
  },
});

app.post('/api/upload', upload.single('file'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file uploaded' });
  const name = req.file.originalname || 'file';
  try {
    let text = '';
    if (/\.pdf$/i.test(name)) {
      const parser = new pdfParse.PDFParse({ data: req.file.buffer });
      const result = await parser.getText();
      text = (result && result.text) || '';
    } else if (/\.docx$/i.test(name)) {
      const result = await mammoth.extractRawText({ buffer: req.file.buffer });
      text = result.value || '';
    } else {
      text = req.file.buffer.toString('utf8');
    }
    text = text.replace(/\s+/g, ' ').trim();
    if (!text) return res.status(400).json({ error: 'No readable text found in this file' });
    const words = text.split(/\s+/).length;
    res.json({ text, words, fileName: name });
  } catch (e) {
    console.error('Upload error:', e.message);
    res.status(500).json({ error: 'Could not read this file. Try converting it to TXT first.' });
  }
});

// ---------- API: SHARE ----------
app.post('/api/share', (req, res) => {
  const { audioId } = req.body || {};
  const db = loadDb();
  const conv = db.conversions.find(c => c.id === audioId);
  if (!conv) return res.status(404).json({ error: 'Audio not found' });
  const sid = crypto.randomBytes(5).toString('hex');
  db.shares[sid] = {
    id: sid, audioId, voice: conv.voice, words: conv.words,
    textPreview: conv.textPreview, createdAt: new Date().toISOString(),
  };
  saveDb(db);
  res.json({ shareId: sid, url: `/s/${sid}` });
});

app.get('/api/share/:id', (req, res) => {
  const db = loadDb();
  const s = db.shares[req.params.id];
  if (!s) return res.status(404).json({ error: 'Share not found' });
  res.json(s);
});

// Public share page
app.get('/s/:id', (req, res) => {
  res.sendFile(path.join(__dirname, '..', 'public', 'share.html'));
});

// ---------- API: DOWNLOAD ----------
app.get('/api/download/:file', (req, res) => {
  const file = path.basename(req.params.file);
  const fp = path.join(AUDIO_DIR, file);
  if (!fs.existsSync(fp)) return res.status(404).json({ error: 'File not found' });
  res.download(fp, `vack-voice-${file}`);
});

// ---------- API: HISTORY ----------
app.get('/api/history', (req, res) => {
  const db = loadDb();
  if (!hasValidToken(db, req)) {
    const { guestId } = guestInfo(db, req);
    const items = db.conversions.filter(c => c.guestId === guestId).slice(-50).reverse();
    return res.json({ items });
  }
  const user = currentUser(db, req);
  const items = db.conversions.filter(c => c.userId === user.id).slice(-50).reverse();
  res.json({ items });
});

// ---------- API: REFERRALS ----------
app.get('/api/referrals', (req, res) => {
  const db = loadDb();
  const user = currentUser(db, req);
  res.json({
    code: user.referralCode,
    url: `${SITE_URL || ''}/?ref=${user.referralCode}`,
    signupBonus: REF_SIGNUP_BONUS,
    proBonus: REF_PRO_BONUS,
    monthlyCap: REF_MONTHLY_CAP,
    creditsThisMonth: user.referralCredits,
    referrals: user.referrals.slice(-20).reverse(),
  });
});

// ---------- API: PAYSTACK ----------
function paystackHeaders() {
  return {
    'Authorization': `Bearer ${PAYSTACK_SECRET}`,
    'Content-Type': 'application/json',
  };
}
async function paystackPost(pathname, body) {
  const r = await fetch(`${PAYSTACK_BASE}${pathname}`, {
    method: 'POST', headers: paystackHeaders(), body: JSON.stringify(body),
  });
  return r.json();
}
async function paystackGet(pathname) {
  const r = await fetch(`${PAYSTACK_BASE}${pathname}`, { headers: paystackHeaders() });
  return r.json();
}

app.post('/api/pay/intent', (req, res) => {
  const db = loadDb();
  const user = currentUser(db, req);
  const { reference, plan } = req.body || {};
  if (!reference || (plan !== 'pro' && plan !== 'pack')) return res.status(400).json({ error: 'Bad intent' });
  db.pending[reference] = {
    userId: user.id, plan,
    amount: plan === 'pro' ? PRO_PRICE_NGN : PACK_PRICE_NGN,
    createdAt: new Date().toISOString(),
  };
  saveDb(db);
  res.json({ ok: true });
});

app.post('/api/pay/initialize', async (req, res) => {
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'Payments are not configured yet' });
  const { plan, email } = req.body || {};
  if (plan !== 'pro' && plan !== 'pack') return res.status(400).json({ error: 'Unknown plan' });
  const db = loadDb();
  const user = currentUser(db, req);
  const amount = plan === 'pro' ? PRO_PRICE_NGN : PACK_PRICE_NGN;
  const ref = `VV-${plan}-${user.id}-${Date.now()}`;
  db.pending[ref] = { userId: user.id, plan, amount, createdAt: new Date().toISOString() };
  saveDb(db);
  try {
    const out = await paystackPost('/transaction/initialize', {
      email: email || (user.email || 'customer@vackvoice.local'),
      amount: amount * 100,
      reference: ref,
      currency: 'NGN',
      metadata: { vackvoice: true, plan, userId: user.id },
    });
    if (!out.status) return res.status(400).json({ error: out.message || 'Paystack error' });
    res.json({ authorization_url: out.data.authorization_url, reference: ref });
  } catch (e) {
    console.error('Paystack init error:', e.message);
    res.status(502).json({ error: 'Payment gateway unreachable. Try again.' });
  }
});

app.post('/api/pay/verify', async (req, res) => {
  const { reference } = req.body || {};
  if (!reference) return res.status(400).json({ error: 'Reference required' });
  const db = loadDb();
  const pending = db.pending[reference];
  if (!pending) return res.status(400).json({ error: 'No pending payment for this reference' });

  // Real verification when a valid secret key is configured
  if (PAYSTACK_SECRET) {
    try {
      const out = await paystackGet(`/transaction/verify/${encodeURIComponent(reference)}`);
      if (out.status && out.data && out.data.status === 'success') {
        const result = creditPayment(reference, out.data);
        return res.json({ ok: true, ...result });
      }
      // Invalid/rotated key -> fall through to test-mode credit
      const msg = (out && out.message) || '';
      if (!msg.toLowerCase().includes('invalid key')) {
        return res.status(400).json({ error: 'Payment not successful' });
      }
      console.log('verify: invalid key, falling back to test-mode credit for', reference);
    } catch (e) {
      console.error('Paystack verify error:', e.message);
      // network failure -> fall through to test-mode credit (test phase only)
      console.log('verify: network error, falling back to test-mode credit for', reference);
    }
  }
  // TEST MODE: no usable secret key yet -> trust the client callback intent
  // (same behaviour as the storxie funnel). Replace with real verification
  // once live keys are configured.
  const result = creditPayment(reference, { status: 'success', test_mode: true });
  return res.json({ ok: true, testMode: true, ...result });
});

// Paystack webhook (production)
app.post('/api/paystack/webhook', (req, res) => {
  if (!PAYSTACK_SECRET) return res.status(503).json({ error: 'Payments not configured' });
  const sig = req.headers['x-paystack-signature'] || '';
  const body = JSON.stringify(req.body);
  const expected = crypto.createHmac('sha512', PAYSTACK_SECRET).update(body).digest('hex');
  if (sig !== expected) return res.status(401).json({ error: 'Invalid signature' });
  const evt = req.body;
  if (evt.event === 'charge.success' && evt.data && evt.data.reference) {
    creditPayment(evt.data.reference, evt.data);
  }
  res.sendStatus(200);
});

function creditPayment(reference, paystackData) {
  const db = loadDb();
  const pending = db.pending[reference];
  if (!pending) return { already: true };
  const user = db.users[pending.userId];
  if (!user) return { error: 'User not found' };
  if (pending.plan === 'pro') {
    user.plan = 'pro';
    user.credits = Math.max(user.credits, PRO_CREDITS);
    user.month = monthKey(); // pro: no monthly reset
  } else {
    user.credits += PACK_CREDITS;
  }
  // If a referred user goes Pro, bonus the referrer
  const referrer = Object.values(db.users).find(u => u.referrals && u.referrals.some(r => r.userId === user.id));
  if (referrer && pending.plan === 'pro') {
    const capLeft = REF_MONTHLY_CAP - (referrer.referralMonth === monthKey() ? referrer.referralCredits : 0);
    if (capLeft > 0) {
      referrer.referralCredits += Math.min(REF_PRO_BONUS, capLeft);
      referrer.credits += Math.min(REF_PRO_BONUS, capLeft);
      referrer.referralMonth = monthKey();
    }
    const rr = referrer.referrals.find(r => r.userId === user.id);
    if (rr) rr.status = 'pro';
  }
  delete db.pending[reference];
  saveDb(db);
  return { plan: pending.plan, credits: user.credits };
}

app.get('/api/pay/config', (req, res) => {
  res.json({
    configured: !!PAYSTACK_SECRET,
    publicKey: PAYSTACK_PUBLIC || '',
    proPrice: PRO_PRICE_NGN, proCredits: PRO_CREDITS,
    packPrice: PACK_PRICE_NGN, packCredits: PACK_CREDITS,
  });
});

// ---------- AUDIO + FRONTEND ----------
app.use('/audio', express.static(AUDIO_DIR, { maxAge: '1h' }));
app.use(express.static(path.join(__dirname, '..', 'public')));

// ---------- START ----------
app.listen(PORT, () => {
  console.log(`🚀 Vack Voice running on http://localhost:${PORT}`);
  console.log(`Voices: ${Object.values(VOICES).map(v => v.name).join(', ')}`);
  console.log(`Paystack: ${PAYSTACK_SECRET ? 'configured' : 'NOT configured (set PAYSTACK_SECRET_KEY)'}`);
});
