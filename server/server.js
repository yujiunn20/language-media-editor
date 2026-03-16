const express = require("express");
const fs = require("fs");
const path = require("path");
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
    process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli"
  );

const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  path.join(__dirname, "..", "tools", "whisper", "models", "ggml-base.bin");

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
    const files = fs.readdirSync(MEDIA_DIR).sort((a, b) =>
      a.localeCompare(b, "zh-Hant")
    );

    res.json({
      ok: true,
      media: files
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
  try {
    const files = fs.readdirSync(LESSONS_DIR).sort((a, b) =>
      a.localeCompare(b, "zh-Hant")
    );

    res.json({
      ok: true,
      lessons: files
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/api/lessons/:filename", (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const filePath = path.join(LESSONS_DIR, filename);

    if (!fs.existsSync(filePath)) {
      return res.status(404).json({
        ok: false,
        error: "Lesson file not found"
      });
    }

    const text = fs.readFileSync(filePath, "utf-8");
    const data = JSON.parse(text);

    res.json(data);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/api/lessons", (req, res) => {
  try {
    const lesson = req.body;

    if (!lesson || !lesson.title) {
      return res.status(400).json({
        ok: false,
        error: "Lesson title is required"
      });
    }

    const safeTitle = sanitizeFilename(lesson.title).trim();
    const filename = getUniqueFilename(LESSONS_DIR, `${safeTitle}.json`);
    const filePath = path.join(LESSONS_DIR, filename);

    fs.writeFileSync(filePath, JSON.stringify(lesson, null, 2), "utf-8");

    res.json({
      ok: true,
      filename,
      path: filePath
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
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
        { cwd: path.join(__dirname, "..", "tools", "whisper") },
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

    res.json({
      ok: true,
      filename: req.file.filename
    });
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

    res.json({
      ok: true,
      filename: req.file.filename
    });
  });
});

app.listen(3000, "0.0.0.0", () => {
  console.log("server running on http://0.0.0.0:3000");
});