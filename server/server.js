const express = require("express");
const fs = require("fs");
const path = require("path");
const db = require("./db");
const multer = require("multer");
const mime = require("mime-types");
const { execFile } = require("child_process");

const app = express();

app.use(express.json());

const DATA_DIR = path.join(__dirname, "..", "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const LESSONS_DIR = path.join(DATA_DIR, "lessons");
const SRC_DIR = path.join(__dirname, "..", "src");

/* ================================
   helpers
================================ */

function decodeOriginalName(name = "") {
  try {
    return Buffer.from(name, "latin1").toString("utf8");
  } catch {
    return name;
  }
}

function sanitizeFilename(name = "") {
  return path.basename(name).replace(/[\\/:*?"<>|]/g, "_");
}

function getUniqueFilename(dir, originalName) {
  const safeName = sanitizeFilename(originalName);
  const ext = path.extname(safeName);
  const base = path.basename(safeName, ext);

  let candidate = safeName;
  let counter = 1;

  while (fs.existsSync(path.join(dir, candidate))) {
    candidate = `${base} (${counter})${ext}`;
    counter++;
  }

  return candidate;
}

function ensureDirExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDirExists(DATA_DIR);
ensureDirExists(MEDIA_DIR);
ensureDirExists(LESSONS_DIR);

const allowedMediaExts = new Set([
  ".mp4", ".webm", ".mp3", ".wav", ".m4a", ".mov", ".mkv"
]);

const allowedLessonExts = new Set([
  ".json"
]);

function mediaFileFilter(req, file, cb) {
  const decodedName = decodeOriginalName(file.originalname);
  const ext = path.extname(decodedName).toLowerCase();

  if (!allowedMediaExts.has(ext)) {
    return cb(new Error(`Unsupported media file type: ${ext || "(no extension)"}`));
  }

  cb(null, true);
}

function lessonFileFilter(req, file, cb) {
  const decodedName = decodeOriginalName(file.originalname);
  const ext = path.extname(decodedName).toLowerCase();

  if (!allowedLessonExts.has(ext)) {
    return cb(new Error(`Unsupported lesson file type: ${ext || "(no extension)"}`));
  }

  cb(null, true);
}

const mediaStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, MEDIA_DIR),
  filename: (req, file, cb) => {
    const decodedName = decodeOriginalName(file.originalname);
    cb(null, getUniqueFilename(MEDIA_DIR, decodedName));
  }
});

const lessonStorage = multer.diskStorage({
  destination: (req, file, cb) => cb(null, LESSONS_DIR),
  filename: (req, file, cb) => {
    const decodedName = decodeOriginalName(file.originalname);
    cb(null, getUniqueFilename(LESSONS_DIR, decodedName));
  }
});

const mediaUpload = multer({
  storage: mediaStorage,
  fileFilter: mediaFileFilter
});

const lessonUpload = multer({
  storage: lessonStorage,
  fileFilter: lessonFileFilter
});

/* ================================
   external tools config
================================ */

const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";

const WHISPER_PATH =
  process.env.WHISPER_PATH ||
  path.join(
    __dirname,
    "..",
    "tools",
    "whisper",
    "whisper",
    "build",
    "bin",
    process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"
  );

const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  path.join(
    __dirname,
    "..",
    "tools",
    "whisper",
    "whisper",
    "models",
    "ggml-base.bin"
  );
  
function cleanWhisperText(raw = "") {
  return raw
    .replace(/\[[^\]]+\]\s*/g, "")
    .trim();
}

app.use(express.static(SRC_DIR));

/* ================================
   media
================================ */

app.get("/api/media", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT * FROM media_files ORDER BY created_at DESC
    `).all();

    const existingRows = rows.filter((row) => {
      const filePath = path.join(MEDIA_DIR, row.filename);
      return fs.existsSync(filePath);
    });

    res.json({
      ok: true,
      media: existingRows
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.delete("/api/media/:filename", (req, res) => {
  try {
    const filename = path.basename(req.params.filename);

    const mediaRow = db.prepare(`
      SELECT * FROM media_files WHERE filename = ?
    `).get(filename);

    if (!mediaRow) {
      return res.status(404).json({
        ok: false,
        error: "Media not found in database"
      });
    }

    const usedLesson = db.prepare(`
      SELECT id, title FROM lessons WHERE media_filename = ? LIMIT 1
    `).get(filename);

    if (usedLesson) {
      return res.status(400).json({
        ok: false,
        error: `此 media 正被 lesson 使用中：${usedLesson.title}`
      });
    }

    const filePath = path.join(MEDIA_DIR, filename);

    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }

    db.prepare(`
      DELETE FROM media_files WHERE filename = ?
    `).run(filename);

    return res.json({
      ok: true,
      filename
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.patch("/api/media/:filename", (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const { display_name } = req.body;

    if (!display_name || !display_name.trim()) {
      return res.status(400).json({
        ok: false,
        error: "display_name required"
      });
    }

    const row = db.prepare(`
      SELECT * FROM media_files WHERE filename = ?
    `).get(filename);

    if (!row) {
      return res.status(404).json({
        ok: false,
        error: "Media not found"
      });
    }

    db.prepare(`
      UPDATE media_files
      SET display_name = ?
      WHERE filename = ?
    `).run(display_name.trim(), filename);

    res.json({
      ok: true,
      filename,
      display_name
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/media/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(MEDIA_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;
  const contentType = mime.lookup(filePath) || "application/octet-stream";

  if (!range) {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": contentType,
      "Accept-Ranges": "bytes"
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

  if (Number.isNaN(start) || start < 0 || start >= fileSize) {
    return res.status(416).send("Requested range not satisfiable");
  }

  const safeEnd = Number.isNaN(end) || end >= fileSize ? fileSize - 1 : end;

  if (safeEnd < start) {
    return res.status(416).send("Requested range not satisfiable");
  }

  const chunkSize = safeEnd - start + 1;
  const stream = fs.createReadStream(filePath, { start, end: safeEnd });

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${safeEnd}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": contentType
  });

  stream.pipe(res);
});

/* ================================
   lessons
================================ */

app.get("/api/lessons", (req, res) => {
  const lessons = db.prepare(`
    SELECT * FROM lessons ORDER BY created_at DESC
  `).all();

  res.json(lessons);
});

app.get("/api/lessons/:id", (req, res) => {
  const { id } = req.params;

  const lesson = db.prepare(`
    SELECT * FROM lessons WHERE id = ?
  `).get(id);

  if (!lesson) return res.status(404).send("Not found");

  const clips = db.prepare(`
    SELECT * FROM clips WHERE lesson_id = ? ORDER BY sort_order
  `).all(id);

  lesson.clips = clips;

  res.json(lesson);
});

app.delete("/api/lessons/:id", (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid lesson id"
      });
    }

    const lessonRow = db.prepare(`
      SELECT * FROM lessons WHERE id = ?
    `).get(id);

    if (!lessonRow) {
      return res.status(404).json({
        ok: false,
        error: "Lesson not found"
      });
    }

    db.prepare(`DELETE FROM clips WHERE lesson_id = ?`).run(id);
    db.prepare(`DELETE FROM lessons WHERE id = ?`).run(id);

    return res.json({
      ok: true,
      id,
      title: lessonRow.title
    });
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.patch("/api/lessons/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const { title } = req.body;

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid lesson id"
      });
    }

    if (!title || !title.trim()) {
      return res.status(400).json({
        ok: false,
        error: "title required"
      });
    }

    const existing = db.prepare(`
      SELECT * FROM lessons WHERE id = ?
    `).get(id);

    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: "Lesson not found"
      });
    }

    // 👉 檢查重名（避免衝突）
    const duplicate = db.prepare(`
      SELECT id FROM lessons WHERE title = ? AND id != ?
    `).get(title.trim(), id);

    if (duplicate) {
      return res.status(400).json({
        ok: false,
        error: `已有同名 lesson：${title}`
      });
    }

    db.prepare(`
      UPDATE lessons
      SET title = ?, updated_at = ?
      WHERE id = ?
    `).run(title.trim(), new Date().toISOString(), id);

    res.json({
      ok: true,
      id,
      title: title.trim()
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/api/lessons", (req, res) => {
  const { id, title, media, clips } = req.body;
  const now = new Date().toISOString();

  let lessonId = id;

  if (id) {
    // ===== update =====
    db.prepare(`
      UPDATE lessons
      SET title = ?, media_filename = ?, updated_at = ?
      WHERE id = ?
    `).run(title, media, now, id);

    // 刪舊 clips
    db.prepare(`DELETE FROM clips WHERE lesson_id = ?`).run(id);

  } else {
    // ===== create =====
    const result = db.prepare(`
      INSERT INTO lessons (title, media_filename, created_at, updated_at)
      VALUES (?, ?, ?, ?)
    `).run(title, media, now, now);

    lessonId = result.lastInsertRowid;
  }

  // ===== 插入 clips =====
  const insertClip = db.prepare(`
    INSERT INTO clips
    (lesson_id, start, end, jp, zh, category, sort_order)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  clips.forEach((c, i) => {
    insertClip.run(
      lessonId,
      c.start,
      c.end,
      c.jp,
      c.zh,
      c.category,
      i
    );
  });

  res.json({ success: true, id: lessonId });
});

/* ================================
   transcribe
================================ */

app.post("/api/transcribe", (req, res) => {
  const { mediaFilename, start, end, lang } = req.body || {};

  if (!mediaFilename) {
    return res.status(400).json({
      ok: false,
      error: "mediaFilename is required"
    });
  }

  if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) {
    return res.status(400).json({
      ok: false,
      error: "Invalid start/end time"
    });
  }

  const safeMediaFilename = path.basename(mediaFilename);
  const mediaPath = path.join(MEDIA_DIR, safeMediaFilename);

  if (!fs.existsSync(mediaPath)) {
    return res.status(404).json({
      ok: false,
      error: "Media file not found"
    });
  }

  const tempWavPath = path.join(DATA_DIR, `temp-${Date.now()}.wav`);

  execFile(
    FFMPEG_PATH,
    [
      "-y",
      "-ss", String(start),
      "-to", String(end),
      "-i", mediaPath,
      "-vn",
      "-ac", "1",
      "-ar", "16000",
      "-c:a", "pcm_s16le",
      tempWavPath
    ],
    (ffmpegErr) => {
      if (ffmpegErr) {
        if (fs.existsSync(tempWavPath)) {
          fs.unlinkSync(tempWavPath);
        }

        return res.status(500).json({
          ok: false,
          error: `ffmpeg failed: ${ffmpegErr.message}`
        });
      }

      execFile(
        WHISPER_PATH,
        [
          "-f", tempWavPath,
          "-l", lang || "ja",
          "-m", WHISPER_MODEL_PATH,
          "-otxt"
        ],
        { cwd: path.join(__dirname, "..", "tools", "whisper", "whisper") },
        (whisperErr, stdout, stderr) => {
          try {
            const txtPath = `${tempWavPath}.txt`;
            let text = "";

            if (fs.existsSync(txtPath)) {
              text = cleanWhisperText(fs.readFileSync(txtPath, "utf-8"));
              fs.unlinkSync(txtPath);
            } else {
              text = cleanWhisperText(stdout || "");
            }

            if (fs.existsSync(tempWavPath)) {
              fs.unlinkSync(tempWavPath);
            }

            if (whisperErr) {
              return res.status(500).json({
                ok: false,
                error: `whisper failed: ${whisperErr.message}\n${stderr || ""}`
              });
            }

            res.json({
              ok: true,
              text
            });
          } catch (err) {
            if (fs.existsSync(tempWavPath)) {
              fs.unlinkSync(tempWavPath);
            }

            res.status(500).json({
              ok: false,
              error: err.message
            });
          }
        }
      );
    }
  );
});

/* ================================
   uploads
================================ */

app.post("/api/upload-media", (req, res) => {
  mediaUpload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        ok: false,
        error: err.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No file uploaded"
      });
    }

    const filename = req.file.filename;
    const now = new Date().toISOString();

    try {
      db.prepare(`
        INSERT INTO media_files (filename, display_name, created_at)
        VALUES (?, ?, ?)
      `).run(filename, filename, now);

      res.json({
        ok: true,
        filename
      });
    } catch (e) {
      return res.status(500).json({
        ok: false,
        error: e.message
      });
    }
  });
});

app.post("/api/upload-lesson", (req, res) => {
  lessonUpload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        ok: false,
        error: err.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No file uploaded"
      });
    }

    const uploadedPath = req.file.path;

    try {
      const raw = fs.readFileSync(uploadedPath, "utf-8");
      const parsed = JSON.parse(raw);

      const title = String(parsed.title || "").trim();
      const media = String(parsed.media || "").trim();
      const clips = Array.isArray(parsed.clips) ? parsed.clips : [];

      if (!title) {
        fs.unlinkSync(uploadedPath);
        return res.status(400).json({
          ok: false,
          error: "Lesson JSON 缺少 title"
        });
      }

      const existing = db.prepare(`
        SELECT id FROM lessons WHERE title = ?
      `).get(title);

      if (existing) {
        fs.unlinkSync(uploadedPath);
        return res.status(409).json({
          ok: false,
          error: `已存在同名 lesson：${title}`
        });
      }

      const now = new Date().toISOString();

      const insertLesson = db.prepare(`
        INSERT INTO lessons (title, media_filename, created_at, updated_at)
        VALUES (?, ?, ?, ?)
      `);

      const result = insertLesson.run(title, media || null, now, now);
      const lessonId = result.lastInsertRowid;

      const insertClip = db.prepare(`
        INSERT INTO clips
        (lesson_id, start, end, jp, zh, category, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      clips.forEach((clip, i) => {
        insertClip.run(
          lessonId,
          Number(clip.start) || 0,
          Number(clip.end) || 0,
          clip.jp || "",
          clip.zh || "",
          clip.category || "",
          i
        );
      });

      fs.unlinkSync(uploadedPath);

      return res.json({
        ok: true,
        id: lessonId,
        title
      });
    } catch (error) {
      if (fs.existsSync(uploadedPath)) {
        fs.unlinkSync(uploadedPath);
      }

      return res.status(400).json({
        ok: false,
        error: `匯入 lesson 失敗：${error.message}`
      });
    }
  });
});

app.listen(3000, "0.0.0.0", () => {
  console.log("server running on http://0.0.0.0:3000");
});