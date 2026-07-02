const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const DB_PATH = process.env.DB_PATH || path.join(__dirname, 'data', 'data.db');
fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });

const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');

db.exec(`
  CREATE TABLE IF NOT EXISTS categories (
    id         INTEGER PRIMARY KEY AUTOINCREMENT,
    name       TEXT NOT NULL UNIQUE,
    color      TEXT NOT NULL DEFAULT '#b8a9ff',
    created_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS images (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    category_id   INTEGER NOT NULL REFERENCES categories(id) ON DELETE CASCADE,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    caption       TEXT,
    created_at    INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS pricing (
    id          INTEGER PRIMARY KEY AUTOINCREMENT,
    title       TEXT NOT NULL,
    description TEXT,
    price       TEXT NOT NULL,
    created_at  INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS page_content (
    key        TEXT PRIMARY KEY,
    value      TEXT NOT NULL,
    updated_at INTEGER NOT NULL
  );

  CREATE TABLE IF NOT EXISTS order_photos (
    id            INTEGER PRIMARY KEY AUTOINCREMENT,
    filename      TEXT NOT NULL,
    original_name TEXT NOT NULL,
    caption       TEXT,
    created_at    INTEGER NOT NULL
  );
`);

// ── Categories ────────────────────────────────────────────────────────────────

const getCategories = () =>
  db.prepare('SELECT * FROM categories ORDER BY created_at ASC').all();

const getCategory = (id) =>
  db.prepare('SELECT * FROM categories WHERE id = ?').get(id);

const createCategory = (name, color) => {
  const result = db
    .prepare('INSERT INTO categories (name, color, created_at) VALUES (?, ?, ?)')
    .run(name.trim(), color || '#b8a9ff', Date.now());
  return getCategory(result.lastInsertRowid);
};

const deleteCategory = (id) =>
  db.prepare('DELETE FROM categories WHERE id = ?').run(id);

// ── Gallery Images ────────────────────────────────────────────────────────────

const getImages = (categoryId) => {
  if (categoryId) {
    return db
      .prepare('SELECT * FROM images WHERE category_id = ? ORDER BY created_at DESC')
      .all(categoryId);
  }
  return db.prepare('SELECT * FROM images ORDER BY created_at DESC').all();
};

const getImage = (id) =>
  db.prepare('SELECT * FROM images WHERE id = ?').get(id);

const createImage = (categoryId, filename, originalName, caption) => {
  const result = db
    .prepare(
      'INSERT INTO images (category_id, filename, original_name, caption, created_at) VALUES (?, ?, ?, ?, ?)'
    )
    .run(categoryId, filename, originalName, caption || null, Date.now());
  return getImage(result.lastInsertRowid);
};

const deleteImage = (id) =>
  db.prepare('DELETE FROM images WHERE id = ?').run(id);

const updateCaption = (id, caption) =>
  db.prepare('UPDATE images SET caption = ? WHERE id = ?').run(caption, id);

// ── Page Content (About bio, contact info, etc.) ──────────────────────────────

const getContent = (key, fallback = '') => {
  const row = db.prepare('SELECT value FROM page_content WHERE key = ?').get(key);
  return row ? row.value : fallback;
};

const setContent = (key, value) => {
  db.prepare(
    'INSERT OR REPLACE INTO page_content (key, value, updated_at) VALUES (?, ?, ?)'
  ).run(key, value, Date.now());
};

const getAllContent = () => {
  const rows = db.prepare('SELECT key, value FROM page_content').all();
  return Object.fromEntries(rows.map(r => [r.key, r.value]));
};

// ── Pricing ───────────────────────────────────────────────────────────────────

const getPricing = () =>
  db.prepare('SELECT * FROM pricing ORDER BY created_at ASC').all();

const getPricingItem = (id) =>
  db.prepare('SELECT * FROM pricing WHERE id = ?').get(id);

const createPricingItem = (title, price, description) => {
  const result = db
    .prepare('INSERT INTO pricing (title, price, description, created_at) VALUES (?, ?, ?, ?)')
    .run(title.trim(), price.trim(), description || null, Date.now());
  return getPricingItem(result.lastInsertRowid);
};

const updatePricingItem = (id, title, price, description) =>
  db.prepare('UPDATE pricing SET title = ?, price = ?, description = ? WHERE id = ?')
    .run(title, price, description || null, id);

const deletePricingItem = (id) =>
  db.prepare('DELETE FROM pricing WHERE id = ?').run(id);

// ── Order Photos ──────────────────────────────────────────────────────────────

const getOrderPhotos = () =>
  db.prepare('SELECT * FROM order_photos ORDER BY created_at DESC').all();

const getOrderPhoto = (id) =>
  db.prepare('SELECT * FROM order_photos WHERE id = ?').get(id);

const createOrderPhoto = (filename, originalName, caption) => {
  const result = db
    .prepare('INSERT INTO order_photos (filename, original_name, caption, created_at) VALUES (?, ?, ?, ?)')
    .run(filename, originalName, caption || null, Date.now());
  return getOrderPhoto(result.lastInsertRowid);
};

const deleteOrderPhoto = (id) =>
  db.prepare('DELETE FROM order_photos WHERE id = ?').run(id);

module.exports = {
  // categories
  getCategories, getCategory, createCategory, deleteCategory,
  // gallery images
  getImages, getImage, createImage, deleteImage, updateCaption,
  // page content
  getContent, setContent, getAllContent,
  // pricing
  getPricing, getPricingItem, createPricingItem, updatePricingItem, deletePricingItem,
  // order photos
  getOrderPhotos, getOrderPhoto, createOrderPhoto, deleteOrderPhoto,
};
