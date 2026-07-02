require('dotenv').config();
const express = require('express');
const cors = require('cors');
const multer = require('multer');
const fs = require('fs');
const path = require('path');
const OpenAI = require('openai');
const db = require('./db');
const { initScheduler } = require('./scheduler');

const app = express();
const upload = multer({ dest: '/tmp/uploads/' });
const openai = new OpenAI({ apiKey: process.env.OPENAI_API_KEY });

app.use(cors({ origin: process.env.ALLOWED_ORIGIN || '*' }));
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ── Utilities ─────────────────────────────────────────────────────────────────

function todayString() {
  return new Date().toISOString().slice(0, 10);
}

function tomorrowString() {
  const d = new Date();
  d.setDate(d.getDate() + 1);
  return d.toISOString().slice(0, 10);
}

function buildSystemPrompt(context = {}) {
  const checkinStreak = db.getCheckinStreak();
  const { streak: liftStreak, recentSkips } = db.getLiftStreak();
  const weightTrend = db.getWeightTrend();

  let patterns = [];
  if (checkinStreak > 2) patterns.push(`${checkinStreak}-day check-in streak — keep it going`);
  if (liftStreak > 1) patterns.push(`${liftStreak} verified lifts in a row`);
  if (recentSkips.length >= 2) patterns.push(`missed lifts on: ${recentSkips.slice(0, 3).join(', ')}`);
  if (weightTrend && weightTrend.direction === 'up' && weightTrend.diff > 1) {
    patterns.push(`weight has trended up ${weightTrend.diff} lbs over the last ${weightTrend.entries.length} days`);
  }

  return `You are Tanner's personal accountability coach built into his Daily Accountability App.

PERSONA: Direct, honest, zero fluff. Think personal trainer who actually calls you out, not a wellness app that gives gold stars for breathing. You know Tanner personally — sophomore at KU studying business analytics and supply chain, chasing a summer 2027 internship, building side projects. When something's slipping, name it.

RULES:
- No filler phrases ("Great job!", "That's awesome!", "Of course!")
- Be conversational — casual but direct
- If data shows a pattern, call it out unprompted
- Keep responses short and punchy unless you're walking through a full check-in
- For the night check-in: you are structured (collect weight, plan, workout confirmation, pet care, school/job tasks) but natural, not robotic
- Never let a bad trend slide without at least a brief callout

CURRENT PATTERNS:
${patterns.length ? patterns.map(p => `- ${p}`).join('\n') : '- No notable patterns yet'}

${context.mode ? `MODE: ${context.mode}` : ''}
${context.date ? `DATE: ${context.date}` : ''}
${context.plan ? `TODAY'S PLAN: ${JSON.stringify(context.plan)}` : ''}
${context.workout ? `WORKOUT LOGGED TODAY: ${JSON.stringify(context.workout)}` : ''}`;
}

// ── Routes ────────────────────────────────────────────────────────────────────

// Health check
app.get('/api/health', (req, res) => res.json({ ok: true }));

// VAPID public key (needed by frontend to subscribe to push)
app.get('/api/vapid-public-key', (req, res) => {
  res.json({ key: process.env.VAPID_PUBLIC_KEY || null });
});

// Push subscription registration
app.post('/api/subscribe', (req, res) => {
  const { endpoint, keys } = req.body;
  if (!endpoint || !keys) return res.status(400).json({ error: 'Missing endpoint or keys' });
  db.saveSubscription(endpoint, keys);
  res.json({ ok: true });
});

// Settings read/write
app.get('/api/settings', (req, res) => {
  const settings = {
    night_checkin_deadline: db.get('night_checkin_deadline', '23:00'),
    lift_days: db.get('lift_days', 'mon,wed,fri'),
  };
  res.json(settings);
});

app.post('/api/settings', (req, res) => {
  const { key, value } = req.body;
  if (!key) return res.status(400).json({ error: 'Missing key' });
  db.set(key, value);
  res.json({ ok: true });
});

// Today's data summary (used by frontend on load)
app.get('/api/today', (req, res) => {
  const today = todayString();
  const tomorrow = tomorrowString();
  const morningDone = !!db.getCheckin('morning', today);
  const nightDone = !!db.getCheckin('night', today);
  const plan = db.getPlan(tomorrow) || db.getPlan(today);
  const workout = db.getWorkout(today);
  const weights = db.getRecentWeights(7);
  const weightTrend = db.getWeightTrend();
  const { streak: liftStreak } = db.getLiftStreak();
  const checkinStreak = db.getCheckinStreak();

  res.json({
    today,
    morningDone,
    nightDone,
    plan,
    workout,
    weights,
    weightTrend,
    liftStreak,
    checkinStreak
  });
});

// ── Voice: transcribe audio ───────────────────────────────────────────────────
app.post('/api/transcribe', upload.single('audio'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No audio file' });

  try {
    // Rename to give it a proper extension for Whisper
    const ext = req.file.mimetype.includes('mp4') ? 'mp4' : 'webm';
    const renamedPath = `${req.file.path}.${ext}`;
    fs.renameSync(req.file.path, renamedPath);

    const transcription = await openai.audio.transcriptions.create({
      file: fs.createReadStream(renamedPath),
      model: 'whisper-1',
      language: 'en'
    });

    fs.unlinkSync(renamedPath);
    res.json({ text: transcription.text });
  } catch (err) {
    console.error('Transcription error:', err);
    res.status(500).json({ error: 'Transcription failed' });
  }
});

// ── Chat: AI response ─────────────────────────────────────────────────────────
app.post('/api/chat', async (req, res) => {
  const { messages, mode, extractData } = req.body;
  if (!messages || !Array.isArray(messages)) {
    return res.status(400).json({ error: 'Missing messages' });
  }

  const today = todayString();
  const todayPlan = db.getPlan(today);
  const workout = db.getWorkout(today);

  const systemPrompt = buildSystemPrompt({
    mode,
    date: today,
    plan: todayPlan?.plan,
    workout
  });

  try {
    // If extractData requested, add extraction instruction
    const finalMessages = [...messages];
    if (extractData) {
      finalMessages.push({
        role: 'user',
        content: `Based on everything discussed in this check-in, extract and return ONLY a JSON object with these fields (omit any you don't have data for):
{
  "weight": <number or null>,
  "plan": [{ "time": "HH:MM-HH:MM", "activity": "..." }],
  "petFed": <true|false|null>,
  "liftedToday": <true|false|null>,
  "wakeTime": "HH:MM or null",
  "sleepTime": "HH:MM or null",
  "schoolTasks": ["..."],
  "jobTasks": ["..."]
}
Return ONLY the JSON, no explanation.`
      });
    }

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{ role: 'system', content: systemPrompt }, ...finalMessages],
      temperature: 0.7,
      max_tokens: extractData ? 500 : 400
    });

    const text = completion.choices[0].message.content;

    if (extractData) {
      try {
        const jsonMatch = text.match(/\{[\s\S]*\}/);
        const data = jsonMatch ? JSON.parse(jsonMatch[0]) : {};
        res.json({ text: null, data });
      } catch {
        res.json({ text: null, data: {} });
      }
    } else {
      res.json({ text });
    }
  } catch (err) {
    console.error('Chat error:', err);
    res.status(500).json({ error: 'AI response failed' });
  }
});

// ── TTS: text to speech ───────────────────────────────────────────────────────
app.post('/api/tts', async (req, res) => {
  const { text } = req.body;
  if (!text) return res.status(400).json({ error: 'No text' });

  try {
    const mp3 = await openai.audio.speech.create({
      model: 'tts-1',
      voice: 'onyx',   // deep, direct — fits the persona
      input: text.slice(0, 4096)
    });
    const buffer = Buffer.from(await mp3.arrayBuffer());
    res.set('Content-Type', 'audio/mpeg');
    res.send(buffer);
  } catch (err) {
    console.error('TTS error:', err);
    res.status(500).json({ error: 'TTS failed' });
  }
});

// ── Workout screenshot analysis ───────────────────────────────────────────────
app.post('/api/analyze-workout', upload.single('screenshot'), async (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No screenshot' });

  try {
    const imageData = fs.readFileSync(req.file.path);
    const base64 = imageData.toString('base64');
    const mimeType = req.file.mimetype || 'image/png';

    const response = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [{
        role: 'user',
        content: [
          {
            type: 'text',
            text: `This is a screenshot from the Hevy workout app. Extract the workout data and return ONLY a JSON object:
{
  "isWorkout": true/false,
  "date": "YYYY-MM-DD or null",
  "duration": "e.g. 1h 12m or null",
  "exercises": [
    { "name": "Exercise Name", "sets": [{ "weight": 135, "reps": 8 }] }
  ],
  "summary": "One sentence description of the workout"
}
If this is not a Hevy workout screenshot, set isWorkout to false. Return ONLY JSON.`
          },
          {
            type: 'image_url',
            image_url: { url: `data:${mimeType};base64,${base64}` }
          }
        ]
      }],
      max_tokens: 1000
    });

    fs.unlinkSync(req.file.path);

    const text = response.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) return res.status(422).json({ error: 'Could not parse workout data' });

    const data = JSON.parse(jsonMatch[0]);
    res.json(data);
  } catch (err) {
    console.error('Workout analysis error:', err);
    if (req.file?.path) fs.unlinkSync(req.file.path).catch?.(() => {});
    res.status(500).json({ error: 'Analysis failed' });
  }
});

// ── Save check-in data ────────────────────────────────────────────────────────
app.post('/api/checkin', (req, res) => {
  const { type, date, data } = req.body;
  if (!type || !date || !data) return res.status(400).json({ error: 'Missing fields' });

  const today = todayString();
  const tomorrow = tomorrowString();

  try {
    db.logCheckin(type, date, data);

    // Extract and persist structured data
    if (data.weight != null) db.logWeight(date, data.weight);
    if (data.plan && Array.isArray(data.plan) && data.plan.length) {
      db.savePlan(tomorrow, data.plan);
    }
    if (data.liftedToday != null) {
      const existing = db.getWorkout(date);
      if (!existing || !existing.verified) {
        db.logWorkout(date, false, null); // will be overwritten if screenshot uploaded
      }
    }

    res.json({ ok: true });
  } catch (err) {
    console.error('Checkin save error:', err);
    res.status(500).json({ error: 'Save failed' });
  }
});

// ── Save workout from analyzed screenshot ─────────────────────────────────────
app.post('/api/log-workout', (req, res) => {
  const { date, verified, details } = req.body;
  if (!date) return res.status(400).json({ error: 'Missing date' });
  db.logWorkout(date, verified !== false, details || null);
  res.json({ ok: true });
});

// ── Quick weight log ──────────────────────────────────────────────────────────
app.post('/api/log-weight', (req, res) => {
  const { weight } = req.body;
  if (!weight) return res.status(400).json({ error: 'Missing weight' });
  db.logWeight(todayString(), parseFloat(weight));
  res.json({ ok: true });
});

// ── Quick lift log (self-reported, no screenshot) ─────────────────────────────
app.post('/api/log-lift', (req, res) => {
  const date = req.body.date || todayString();
  db.logWorkout(date, true, null); // verified=true (self-reported)
  res.json({ ok: true });
});

// ── AI Digest ─────────────────────────────────────────────────────────────────
app.get('/api/ai-digest', async (req, res) => {
  const today = todayString();
  const forceRefresh = req.query.refresh === '1';

  if (!forceRefresh) {
    const cached = db.getDigest(today);
    if (cached) return res.json(cached);
  }

  try {
    // Fetch from two angles: recent AI stories + top AI stories
    const [recentRes, topRes] = await Promise.all([
      fetch('https://hn.algolia.com/api/v1/search_by_date?query=AI+LLM+GPT+Claude+Gemini+machine+learning+model&tags=story&hitsPerPage=30'),
      fetch('https://hn.algolia.com/api/v1/search?query=artificial+intelligence+AI+agent+model+release&tags=story&hitsPerPage=20')
    ]);
    const [recentData, topData] = await Promise.all([recentRes.json(), topRes.json()]);

    // Merge + dedupe by URL
    const seen = new Set();
    const allStories = [...(recentData.hits || []), ...(topData.hits || [])]
      .filter(h => h.url && h.title && !seen.has(h.url) && seen.add(h.url))
      .slice(0, 30);

    if (!allStories.length) {
      const empty = { articles: [], overview: 'No AI news found in the last 24 hours.' };
      db.saveDigest(today, [], empty.overview);
      return res.json(empty);
    }

    const storiesList = allStories.map((s, i) => `${i + 1}. ${s.title} — ${s.url}`).join('\n');

    const completion = await openai.chat.completions.create({
      model: 'gpt-4o',
      messages: [
        {
          role: 'system',
          content: `You are an AI news curator for Tanner Brock, a 20-year-old sophomore at the University of Kansas studying business analytics and supply chain management. He wants to stay ahead of AI before it goes mainstream — understanding what's coming and what skills he needs to develop.

PRIORITIZE stories about:
- New AI model releases (GPT-5, Claude 4, Gemini updates, Llama, etc.) — these are always top priority
- AI agents doing real-world business tasks
- AI tools for data analysts, business intelligence, and productivity
- AI in logistics, supply chain, demand forecasting, operations
- Skills/tools college students and early-career people need to learn NOW
- AI replacing or augmenting white-collar knowledge work
- Practical "learn this before everyone else does" type developments

DEPRIORITIZE: pure academic papers with no practical angle, niche hardware, crypto/blockchain AI, AI image generation drama, funding announcements with no product news.`
        },
        {
          role: 'user',
          content: `Here are today's AI stories from Hacker News:\n\n${storiesList}\n\nPick the 5 most important stories for Tanner. For each, write a detailed 3-4 sentence summary explaining: what it is, why it's a big deal, and what it means for someone trying to get ahead in business analytics and supply chain. Also write a detailed 4-5 sentence overview of today's AI landscape — what's the big picture, what should Tanner pay attention to, and what does he need to start learning or doing based on what's happening today.\n\nReturn ONLY this JSON (no explanation):\n{\n  "articles": [\n    { "title": "...", "url": "...", "summary": "3-4 sentences: what it is, why it matters, what Tanner should take away" }\n  ],\n  "overview": "4-5 sentence big picture analysis of today in AI, with specific callouts for what Tanner should be learning or paying attention to"\n}`
        }
      ],
      temperature: 0.4,
      max_tokens: 1500
    });

    const text = completion.choices[0].message.content;
    const jsonMatch = text.match(/\{[\s\S]*\}/);
    if (!jsonMatch) {
      return res.json({ articles: [], overview: 'Could not parse digest today.' });
    }

    const digest = JSON.parse(jsonMatch[0]);
    db.saveDigest(today, digest.articles || [], digest.overview || '');
    res.json(digest);
  } catch (err) {
    console.error('Digest error:', err);
    res.status(500).json({ error: 'Could not fetch digest', articles: [], overview: '' });
  }
});

// ── Stats / patterns ──────────────────────────────────────────────────────────
app.get('/api/stats', (req, res) => {
  const { streak: liftStreak, recentSkips } = db.getLiftStreak();
  res.json({
    checkinStreak: db.getCheckinStreak(),
    liftStreak,
    recentSkips,
    weightTrend: db.getWeightTrend(),
    recentWeights: db.getRecentWeights(10),
    recentWorkouts: db.getRecentWorkouts(14)
  });
});

// ── Catch-all → serve PWA ─────────────────────────────────────────────────────
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start ─────────────────────────────────────────────────────────────────────
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
  initScheduler();
});
