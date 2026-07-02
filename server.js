const express = require('express');
const path = require('path');
const fs = require('fs');
const multer = require('multer');
const db = require('./db');

require('dotenv').config();

const app = express();
const PORT = process.env.PORT || 3000;

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
  limits: { fileSize: 30 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowed = ['.jpg', '.jpeg', '.png', '.gif', '.webp', '.heic', '.avif'];
    cb(null, allowed.includes(path.extname(file.originalname).toLowerCase()));
  },
});

// ── Middleware ─────────────────────────────────────────────────────────────────

app.use(express.json());
app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// ── Auth ──────────────────────────────────────────────────────────────────────

function requireAdmin(req, res, next) {
  const token = (req.headers.authorization || '').replace('Bearer ', '').trim();
  if (!token || !validTokens.has(token)) return res.status(401).json({ error: 'Unauthorized' });
  next();
}

app.post('/api/admin/login', (req, res) => {
  const { password } = req.body || {};
  if (password !== (process.env.ADMIN_PASSWORD || 'lily2024'))
    return res.status(401).json({ error: 'Wrong password' });
  const token = Math.random().toString(36).slice(2) + Math.random().toString(36).slice(2);
  validTokens.add(token);
  res.json({ token });
});

app.post('/api/admin/logout', (req, res) => {
  validTokens.delete((req.headers.authorization || '').replace('Bearer ', '').trim());
  res.json({ ok: true });
});

// ── Categories ────────────────────────────────────────────────────────────────

app.get('/api/categories', (req, res) => res.json(db.getCategories()));

app.post('/api/categories', requireAdmin, (req, res) => {
  const { name, color } = req.body || {};
  if (!name) return res.status(400).json({ error: 'Name required' });
  try { res.json(db.createCategory(name, color)); }
  catch (e) { res.status(400).json({ error: 'Category already exists' }); }
});

app.delete('/api/categories/:id', requireAdmin, (req, res) => {
  db.getImages(Number(req.params.id)).forEach(img => {
    const fp = path.join(UPLOADS_DIR, img.filename);
    if (fs.existsSync(fp)) fs.unlinkSync(fp);
  });
  db.deleteCategory(req.params.id);
  res.json({ ok: true });
});

// ── Gallery Images ────────────────────────────────────────────────────────────

app.get('/api/images', (req, res) => {
  res.json(db.getImages(req.query.category ? Number(req.query.category) : null));
});

app.post('/api/images', requireAdmin, upload.single('image'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No image file' });
  const { category_id, caption } = req.body;
  if (!category_id) return res.status(400).json({ error: 'category_id required' });
  res.json(db.createImage(Number(category_id), req.file.filename, req.file.originalname, caption));
});

app.patch('/api/images/:id', requireAdmin, (req, res) => {
  db.updateCaption(req.params.id, req.body.caption);
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

// ── Page Content (About, Contact info, etc.) ──────────────────────────────────

app.get('/api/content', (req, res) => res.json(db.getAllContent()));

// About photo upload — must be before the generic :key route
app.post('/api/content/about-photo', requireAdmin, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  db.setContent('about_photo', req.file.filename);
  res.json({ filename: req.file.filename });
});

app.post('/api/content/:key', requireAdmin, (req, res) => {
  const { value } = req.body || {};
  if (value === undefined) return res.status(400).json({ error: 'value required' });
  db.setContent(req.params.key, value);
  res.json({ ok: true });
});

// ── Pricing ───────────────────────────────────────────────────────────────────

app.get('/api/pricing', (req, res) => res.json(db.getPricing()));

app.post('/api/pricing', requireAdmin, (req, res) => {
  const { title, price, description } = req.body || {};
  if (!title || !price) return res.status(400).json({ error: 'title and price required' });
  res.json(db.createPricingItem(title, price, description));
});

app.patch('/api/pricing/:id', requireAdmin, (req, res) => {
  const { title, price, description } = req.body || {};
  db.updatePricingItem(req.params.id, title, price, description);
  res.json({ ok: true });
});

app.delete('/api/pricing/:id', requireAdmin, (req, res) => {
  db.deletePricingItem(req.params.id);
  res.json({ ok: true });
});

// ── Order Photos ──────────────────────────────────────────────────────────────

app.get('/api/order-photos', (req, res) => res.json(db.getOrderPhotos()));

app.post('/api/order-photos', requireAdmin, upload.single('photo'), (req, res) => {
  if (!req.file) return res.status(400).json({ error: 'No file' });
  res.json(db.createOrderPhoto(req.file.filename, req.file.originalname, req.body.caption));
});

app.delete('/api/order-photos/:id', requireAdmin, (req, res) => {
  const photo = db.getOrderPhoto(req.params.id);
  if (!photo) return res.status(404).json({ error: 'Not found' });
  const fp = path.join(UPLOADS_DIR, photo.filename);
  if (fs.existsSync(fp)) fs.unlinkSync(fp);
  db.deleteOrderPhoto(req.params.id);
  res.json({ ok: true });
});

// ── Catch-all ─────────────────────────────────────────────────────────────────

app.get('*', (req, res) => res.sendFile(path.join(__dirname, 'public', 'index.html')));

app.listen(PORT, () => console.log(`studio.bylilly running on port ${PORT}`));
