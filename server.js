require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const nodemailer = require('nodemailer');
const cron = require('node-cron');

const E = process.env;
const DB = path.join(__dirname, 'data.json');
const load = () => (fs.existsSync(DB) ? JSON.parse(fs.readFileSync(DB, 'utf8')) : { leads: [] });
const save = (d) => fs.writeFileSync(DB, JSON.stringify(d, null, 2));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const app = express();
app.use(express.json({ limit: '5mb' }));
app.use(express.static(path.join(__dirname, 'public')));
const crypto = require('crypto');
const SECRET = E.SESSION_SECRET || crypto.randomBytes(32).toString('hex');
const sign = (exp) => crypto.createHmac('sha256', SECRET).update(String(exp)).digest('hex');
const same = (a, b) => { const x = Buffer.from(String(a)), y = Buffer.from(String(b)); return x.length === y.length && crypto.timingSafeEqual(x, y); };
let fails = 0, lockUntil = 0;
// ---------- health check / keep-alive endpoint ----------
app.get('/api/ping', (req, res) => res.json({ status: 'ok', timestamp: new Date().toISOString() }));

app.post('/api/login', (req, res) => {
  if (Date.now() < lockUntil) return res.status(429).json({ error: 'Too many tries. Wait 5 minutes.' });
  const { email = '', password = '' } = req.body || {};
  if (E.LOGIN_EMAIL && E.LOGIN_PASSWORD && same(email.trim().toLowerCase(), E.LOGIN_EMAIL.toLowerCase()) && same(password, E.LOGIN_PASSWORD)) {
    fails = 0;
    const exp = Date.now() + 30 * 864e5;
    return res.json({ token: exp + '.' + sign(exp) });
  }
  if (++fails >= 5) { lockUntil = Date.now() + 5 * 60e3; fails = 0; }
  res.status(401).json({ error: 'Wrong email or password' });
});

// ---------- webhook for Make.com / automated lead ingestion ----------
app.post('/api/webhook/leads', async (req, res) => {
  const apiKey = req.get('x-api-key') || req.query.key;
  if (!E.WEBHOOK_SECRET || apiKey !== E.WEBHOOK_SECRET) {
    return res.status(401).json({ error: 'Invalid or missing webhook key' });
  }

  const db = load();
  const have = new Set(db.leads.map((l) => (l.email || '').toLowerCase()));
  const rows = Array.isArray(req.body) ? req.body : (req.body.leads || req.body.rows || []);
  let added = 0;

  for (const r of rows) {
    const email = (r.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || have.has(email)) continue;
    have.add(email);
    db.leads.push({
      id: Date.now() + '-w' + added,
      name: r.name || '',
      email,
      website: r.website || '',
      category: r.category || '',
      city: r.city || '',
      notes: r.notes || r.requirement || '',
      status: 'new',
    });
    added++;
  }
  save(db);

  let drafted = 0;
  if (added > 0) {
    try {
      drafted = await generateDrafts(added);
    } catch (e) {
      console.error('[webhook] Auto-draft error:', e.message);
    }
  }

  res.json({ success: true, added, drafted });
});
app.use('/api', (req, res, next) => {
  const [exp, sig] = (req.get('authorization') || '').replace('Bearer ', '').split('.');
  if (!sig || Number(exp) < Date.now() || !same(sig, sign(exp))) return res.status(401).json({ error: 'Please sign in' });
  next();
});

// ---------- settings (saved in the app, fall back to .env) ----------
function S() {
  const s = load().settings || {};
  return {
    name: s.name || E.SENDER_NAME || '', company: s.company || E.COMPANY || '', service: s.service || E.SERVICE || '',
    query: s.query || E.TARGET_QUERY || '', city: s.city || E.TARGET_CITY || '',
    daily: Number(s.daily || E.DAILY_COUNT) || 10, time: s.time || '10:00',
  };
}
app.get('/api/settings', (req, res) => res.json(S()));
app.put('/api/settings', (req, res) => {
  const db = load(), b = req.body || {};
  db.settings = {
    name: b.name, company: b.company, service: b.service, query: b.query, city: b.city,
    daily: Math.min(Math.max(Number(b.daily) || 10, 1), 30), time: /^\d\d:\d\d$/.test(b.time) ? b.time : '10:00',
  };
  save(db);
  res.json(S());
});

// ---------- leads ----------
app.get('/api/leads', (req, res) => res.json(load().leads));

app.post('/api/import', (req, res) => {
  const db = load();
  const have = new Set(db.leads.map((l) => l.email.toLowerCase()));
  let added = 0;
  for (const r of req.body.rows || []) {
    const email = (r.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || have.has(email)) continue;
    have.add(email);
    db.leads.push({
      id: Date.now() + '-' + added,
      name: r.name || '', email, website: r.website || '',
      category: r.category || '', city: r.city || '', notes: r.notes || '',
      status: 'new',
    });
    added++;
  }
  save(db);
  res.json({ added });
});

app.put('/api/leads/:id', (req, res) => {
  const db = load();
  const l = db.leads.find((x) => x.id === req.params.id);
  if (!l) return res.sendStatus(404);
  if (req.body.subject !== undefined) l.subject = req.body.subject;
  if (req.body.body !== undefined) l.body = req.body.body;
  if (req.body.status) l.status = req.body.status; // e.g. 'skipped', 'unsubscribed'
  save(db);
  res.json(l);
});

// ---------- AI drafting ----------
async function siteText(url) {
  if (!url) return '';
  try {
    if (!/^https?:/.test(url)) url = 'https://' + url;
    const r = await fetch(url, { signal: AbortSignal.timeout(8000) });
    const html = await r.text();
    return html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, ' ').replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ').slice(0, 1500);
  } catch { return ''; }
}

async function draftFor(lead) {
  const web = await siteText(lead.website);
  const prompt = `Write a short, friendly cold email (max 110 words) from ${S().name} at ${S().company}, who offers: ${S().service}.
Recipient business: ${lead.name} | Category: ${lead.category} | City: ${lead.city}
Notes: ${lead.notes}
Text from their website: ${web || '(not available)'}
Rules: mention one specific, true detail about their business; do not invent facts; one clear low-pressure call to action (a quick reply or call); no hype, no emojis; do not add a signature or unsubscribe line (added automatically).
Reply ONLY with JSON: {"subject":"...","body":"..."}`;
  if (E.GROQ_API_KEY) {
    const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'authorization': 'Bearer ' + E.GROQ_API_KEY,
      },
      body: JSON.stringify({
        model: E.GROQ_MODEL || 'openai/gpt-oss-120b',
        messages: [{ role: 'user', content: prompt }],
        response_format: { type: 'json_object' },
        temperature: 0.7,
      }),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
    const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '';
    return JSON.parse(txt);
  }

  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': E.ANTHROPIC_API_KEY, 'anthropic-version': '2023-06-01' },
    body: JSON.stringify({ model: E.CLAUDE_MODEL || 'claude-sonnet-5-5', max_tokens: 600, messages: [{ role: 'user', content: prompt }] }),
  });
  const j = await r.json();
  if (!j.content) throw new Error(JSON.stringify(j).slice(0, 200));
  const txt = j.content.map((c) => c.text || '').join('').replace(/```json|```/g, '').trim();
  return JSON.parse(txt);
}

async function generateDrafts(count) {
  const db = load();
  const todo = db.leads.filter((l) => l.status === 'new').slice(0, count);
  for (const l of todo) {
    try {
      const d = await draftFor(l);
      l.subject = d.subject; l.body = d.body; l.status = 'drafted'; delete l.error;
    } catch (e) { l.error = 'Draft failed: ' + e.message; }
    save(db);
  }
  return todo.length;
}

app.post('/api/generate', async (req, res) => {
  res.json({ drafted: await generateDrafts(Number(req.body.count) || S().daily) });
});

// ---------- sending ----------
const mailer = () => {
  const host = (E.SMTP_HOST === 'smtp.zoho.com' ? 'smtp.zoho.in' : E.SMTP_HOST) || 'smtp.zoho.in';
  const port = Number(E.SMTP_PORT) || 465;
  return nodemailer.createTransport({
    host,
    port,
    secure: port === 465,
    auth: { user: E.SMTP_USER, pass: E.SMTP_PASS },
    connectionTimeout: 10000,
    greetingTimeout: 10000,
    socketTimeout: 15000,
  });
};

app.post('/api/send-all', async (req, res) => {
  const db = load();
  const t = mailer();
  let sent = 0, failed = 0;
  for (const l of db.leads.filter((x) => x.status === 'drafted')) {
    try {
      await t.sendMail({
        from: `"${S().name} - ${S().company}" <${E.SMTP_USER}>`,
        to: l.email, subject: l.subject,
        text: `${l.body}\n\n--\n${S().name}\n${S().company}\nIf you'd rather not hear from us, just reply "unsubscribe" and we won't email you again.`,
      });
      l.status = 'sent'; l.sentAt = new Date().toISOString(); delete l.error; sent++;
    } catch (e) { l.status = 'failed'; l.error = e.message; failed++; }
    save(db);
    await sleep(8000); // slow sending protects your email reputation
  }
  res.json({ sent, failed });
});

// ---------- automatic client finding (Google Places + website email) ----------
const BAD = /\.(png|jpe?g|gif|svg|webp|css|js)$|sentry|wixpress|example\.|domain\.com|your@|@2x|noreply|no-reply/i;
async function getPage(url) {
  try {
    const r = await fetch(url, { signal: AbortSignal.timeout(8000), headers: { 'user-agent': 'Mozilla/5.0' } });
    return await r.text();
  } catch { return ''; }
}
async function findEmail(site) {
  let base;
  try { base = new URL(/^https?:/.test(site) ? site : 'https://' + site); } catch { return null; }
  const host = base.hostname.replace(/^www\./, '');
  const found = new Set();
  for (const p of ['/', '/contact', '/contact-us', '/about']) {
    const html = (await getPage(new URL(p, base).href)).replace(/&#64;|\[at\]/gi, '@');
    (html.match(/[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi) || []).forEach((e) => {
      e = e.toLowerCase();
      if (!BAD.test(e)) found.add(e);
    });
    if (found.size) break;
  }
  const list = [...found];
  return list.find((e) => e.endsWith('@' + host) || e.endsWith('.' + host)) || list[0] || null;
}
async function findLeadsWithGroq(query, city, want) {
  if (!E.GROQ_API_KEY) throw new Error('GROQ_API_KEY missing in .env');
  const prompt = `You are a B2B business researcher for Zynteq Technologies.
Find ${want} real, active businesses in ${city} belonging to the category: "${query}".
For each business, provide:
- name: The real business or clinic name
- email: Official contact email
- website: Their website URL
- category: "${query}"
- city: "${city}"
- notes: One specific digital improvement need (e.g. modern website, online booking, SEO)

Reply ONLY with valid JSON with a "leads" array:
{"leads":[{"name":"...","email":"...","website":"...","category":"${query}","city":"${city}","notes":"..."}]}`;

  const r = await fetch('https://api.groq.com/openai/v1/chat/completions', {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      'authorization': 'Bearer ' + E.GROQ_API_KEY,
    },
    body: JSON.stringify({
      model: E.GROQ_MODEL || 'openai/gpt-oss-120b',
      messages: [{ role: 'user', content: prompt }],
      response_format: { type: 'json_object' },
      temperature: 0.7,
    }),
  });
  const j = await r.json();
  if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
  const txt = (j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content) || '{}';
  const parsed = JSON.parse(txt);
  const rows = Array.isArray(parsed) ? parsed : (parsed.leads || parsed.businesses || []);

  const db = load();
  const have = new Set(db.leads.map((l) => (l.email || '').toLowerCase()));
  let added = 0;
  for (const item of rows) {
    const email = (item.email || '').trim().toLowerCase();
    if (!/^\S+@\S+\.\S+$/.test(email) || have.has(email)) continue;
    have.add(email);
    db.leads.push({
      id: Date.now() + '-g' + added,
      name: item.name || '',
      email,
      website: item.website || '',
      category: item.category || query,
      city: item.city || city,
      notes: item.notes || '',
      status: 'new',
    });
    added++;
  }
  save(db);
  return added;
}

async function findLeads(query, city, want) {
  const isGoogleKeyValid = E.GOOGLE_PLACES_API_KEY && !E.GOOGLE_PLACES_API_KEY.includes('your-google-places-key');
  if (!isGoogleKeyValid) {
    return await findLeadsWithGroq(query, city, want);
  }
  const db = load();
  db.seen = db.seen || [];
  const seen = new Set(db.seen);
  const have = new Set(db.leads.map((l) => l.email));
  let added = 0, token, pages = 0;
  while (added < want && pages < 5) {
    const body = { textQuery: `${query} in ${city}`, pageSize: 20 };
    if (token) body.pageToken = token;
    const r = await fetch('https://places.googleapis.com/v1/places:searchText', {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'X-Goog-Api-Key': E.GOOGLE_PLACES_API_KEY,
        'X-Goog-FieldMask': 'places.id,places.displayName,places.websiteUri,nextPageToken',
      },
      body: JSON.stringify(body),
    });
    const j = await r.json();
    if (j.error) throw new Error(j.error.message);
    for (const p of j.places || []) {
      if (added >= want) break;
      if (seen.has(p.id)) continue;
      seen.add(p.id);
      if (!p.websiteUri) continue;
      const email = await findEmail(p.websiteUri);
      if (!email || have.has(email)) continue;
      have.add(email);
      db.leads.push({
        id: Date.now() + '-f' + added, name: (p.displayName && p.displayName.text) || '', email,
        website: p.websiteUri, category: query, city, notes: '', status: 'new',
      });
      added++;
    }
    db.seen = [...seen];
    save(db);
    token = j.nextPageToken;
    pages++;
    if (!token) break;
  }
  return added;
}
app.post('/api/find', async (req, res) => {
  try {
    const { query, city, count } = req.body;
    if (!query || !city) return res.status(400).json({ error: 'Business type and city are required' });
    res.json({ added: await findLeads(query, city, Number(count) || 10) });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ---------- every minute: at your send time, find clients and make drafts ----------
cron.schedule('* * * * *', async () => {
  const c = S();
  const tz = { timeZone: 'Asia/Kolkata' };
  const now = new Date().toLocaleTimeString('en-GB', { ...tz, hour: '2-digit', minute: '2-digit' });
  const today = new Date().toLocaleDateString('en-CA', tz);
  const db = load();
  if (now !== c.time || db.lastRun === today) return;
  db.lastRun = today;
  save(db);
  try {
    const waiting = db.leads.filter((l) => l.status === 'new').length;
    if (waiting < c.daily && E.GOOGLE_PLACES_API_KEY && c.query && c.city)
      console.log(`[daily] found ${await findLeads(c.query, c.city, c.daily - waiting)} new clients`);
  } catch (e) { console.log('[daily] client finding failed:', e.message); }
  console.log(`[daily] ${await generateDrafts(c.daily)} drafts ready`);
});

app.listen(E.PORT || 3000, () => {
  const port = E.PORT || 3000;
  console.log('Running on http://localhost:' + port);
  const targetUrl = E.APP_URL || E.RENDER_EXTERNAL_URL;
  if (targetUrl) {
    console.log('[keep-alive] Self-ping enabled for:', targetUrl);
    setInterval(async () => {
      try {
        const pingUrl = targetUrl.replace(/\/+$/, '') + '/api/ping';
        await fetch(pingUrl);
      } catch (_) {}
    }, 14 * 60 * 1000);
  }
});
