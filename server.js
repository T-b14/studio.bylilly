const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

// In-memory admin session tokens (reset on restart, fine for a personal site)
const validTokens = new Set();

// ── Uploads directory ─────────────────────────────────────────────────────────

const UPLOADS_DIR = process.env.UPLOADS_PATH || path.join(__dirname, 'data', 'uploads');
fs.mkdirSync(UPLOADS_DIR, { recursive: true });

const storage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, UPLOADS_DIR),
  filename: (req, file, cb) => {
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, `${Date.now()}-${Math.random().toString(36).slice(2)}${ext}`);
  },
});

const upload = multer({
  storage,
  limits: { fileSize: 30 * 1024 * 1024 }, // 30 MB
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.avif'];
    const ext = path.extname(file.originalname).toLowerCase();
    cb(null, allowed.includes(ext));
  },
});

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  if (!token || !validTokens.has(token)) {
    return res.status(401).json({ error: 'Unauthorized' });
  }
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  const correct = process.env.ADMIN_PASSWORD || 'lily2024';
  if (password !== correct) {
    return res.status(401).json({ error: 'Wrong password' });
  }
  const token =
    Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  validTokens.add(token);
  res.json({ token });
});

app.post('/api/admin/logout', (req, res) => {
  const auth = req.headers.authorization || '';
  const token = auth.replace('Bearer ', '').trim();
  validTokens.delete(token);
  res.json({ ok: true });
});

// ── Categories ────────────────────────────────────────────────────────────────

app.get('/api/categories', (req, res) => {
  res.json(db.getCategories());
});

app.post('/api/categories', requireAdmin, (req, res) => {
  const { name, color } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  try {
    const cat = db.createCategory(name, color);
    res.json(cat);
  } catch (err) {
    res.status(400).json({ error: 'Category already exists' });
  }
});

app.delete('/api/categories/:id', requireAdmin, (req, res) => {
  // Delete image files first
  const images = db.getImages(Number(req.params.id));
  for (const img of images) {
    const fp = path.join(UPLOADS_DIR, img.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  }
  db.deleteCategory(req.params.id);
  res.json({ ok: true });
});

// ── Images ────────────────────────────────────────────────────────────────────

app.get('/api/images', (req, res) => {
  const { category } = req.query;
  res.json(db.getImages(category ? Number(category) : null));
});

app.post('/api/images', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file' });
  const { category_id, caption } = req.body;
  if (!category_id) return res.status(400).json({ error: 'category_id required' });

  const image = db.createImage(
    Number(category_id),
    req.file.filename,
    req.file.originalname,
    caption || null
  );
  res.json(image);
});

app.patch('/api/images/:id', requireAdmin, (req, res) => {
  const { caption } = req.body || {};
  db.updateCaption(req.params.id, caption);
  res.json({ ok: true });
});

app.delete('/api/images/:id', requireAdmin, (req, res) => {
  const image = db.getImage(req.params.id);
  if (!image) return res.status(404).json({ error: 'Not found' });
  const fp = path.join(UPLOADS_DIR, image.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.deleteImage(req.params.id);
  res.json({ ok: true });
});

// ── Catch-all ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => console.log(`studio.bylilly running on port ${PORT}`));
