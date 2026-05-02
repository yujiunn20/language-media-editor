const Database = require("better-sqlite3");
const path = require("path");

const dbPath =
  process.env.LANGUAGE_MEDIA_EDITOR_DB_PATH ||
  path.join(__dirname, "app.db");

const db = new Database(dbPath);

// ===== init =====
db.exec(`
CREATE TABLE IF NOT EXISTS folders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  kind TEXT NOT NULL,
  parent_id INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS lessons (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  title TEXT NOT NULL,
  media_filename TEXT,
  folder_id INTEGER,
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
  folder_id INTEGER,
  created_at TEXT
);

CREATE TABLE IF NOT EXISTS sentence_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lesson_id INTEGER,
  clip_index INTEGER,
  media_filename TEXT,
  audio_filename TEXT,
  start REAL,
  end REAL,
  jp TEXT NOT NULL,
  zh TEXT,
  category TEXT,
  note TEXT,
  created_at TEXT,
  updated_at TEXT,
  FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL
);

`);

// ===== migration for old existing DB =====
const lessonCols = db.prepare("PRAGMA table_info(lessons)").all();
if (!lessonCols.some(col => col.name === "folder_id")) {
  db.exec("ALTER TABLE lessons ADD COLUMN folder_id INTEGER");
}

const mediaCols = db.prepare("PRAGMA table_info(media_files)").all();
if (!mediaCols.some(col => col.name === "folder_id")) {
  db.exec("ALTER TABLE media_files ADD COLUMN folder_id INTEGER");
}

const sentenceCols = db.prepare("PRAGMA table_info(sentence_items)").all();

if (sentenceCols.length > 0 && !sentenceCols.some(col => col.name === "note")) {
  db.exec("ALTER TABLE sentence_items ADD COLUMN note TEXT");
}

if (sentenceCols.length > 0 && !sentenceCols.some(col => col.name === "audio_filename")) {
  db.exec("ALTER TABLE sentence_items ADD COLUMN audio_filename TEXT");
}

const sentenceForeignKeys = db.prepare("PRAGMA foreign_key_list(sentence_items)").all();
const sentenceLessonForeignKey = sentenceForeignKeys.find(
  (fk) => fk.from === "lesson_id" && fk.table === "lessons"
);

if (
  sentenceCols.length > 0 &&
  sentenceLessonForeignKey &&
  sentenceLessonForeignKey.on_delete !== "SET NULL"
) {
  db.pragma("foreign_keys = OFF");

  try {
    db.transaction(() => {
      db.exec(`
        ALTER TABLE sentence_items RENAME TO sentence_items_old;

        CREATE TABLE sentence_items (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          lesson_id INTEGER,
          clip_index INTEGER,
          media_filename TEXT,
          audio_filename TEXT,
          start REAL,
          end REAL,
          jp TEXT NOT NULL,
          zh TEXT,
          category TEXT,
          note TEXT,
          created_at TEXT,
          updated_at TEXT,
          FOREIGN KEY (lesson_id) REFERENCES lessons(id) ON DELETE SET NULL
        );

        INSERT INTO sentence_items (
          id,
          lesson_id,
          clip_index,
          media_filename,
          audio_filename,
          start,
          end,
          jp,
          zh,
          category,
          note,
          created_at,
          updated_at
        )
        SELECT
          id,
          lesson_id,
          clip_index,
          media_filename,
          audio_filename,
          start,
          end,
          jp,
          zh,
          category,
          note,
          created_at,
          updated_at
        FROM sentence_items_old;

        DROP TABLE sentence_items_old;
      `);
    })();
  } finally {
    db.pragma("foreign_keys = ON");
  }
}

module.exports = db;
