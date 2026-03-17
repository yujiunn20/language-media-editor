const Database = require("better-sqlite3");
const path = require("path");

const db = new Database(path.join(__dirname, "app.db"));

// ===== init =====
db.exec(`
CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  media_filename TEXT,
  created_at TEXT,
  updated_at TEXT
);

CREATE TABLE IF NOT EXISTS clips (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER,
  start REAL,
  end REAL,
  jp TEXT,
  zh TEXT,
  category TEXT,
  sort_order INTEGER,
  FOREIGN KEY (lesson_id) REFERENCES lessons(id)
);

CREATE TABLE IF NOT EXISTS media_files (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  filename TEXT NOT NULL UNIQUE,
  display_name TEXT,
  created_at TEXT
);
`);

module.exports = db;