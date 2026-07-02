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

// ── Images ────────────────────────────────────────────────────────────────────

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

module.exports = {
  getCategories, getCategory, createCategory, deleteCategory,
  getImages, getImage, createImage, deleteImage, updateCaption,
};
