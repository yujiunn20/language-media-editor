const express = require("express");
const fs = require("fs");
const os = require("os");
const path = require("path");
const zlib = require("zlib");
const db = require("./db");
const multer = require("multer");
const mime = require("mime-types");
const { execFile } = require("child_process");
const ffmpegStaticPath = require("ffmpeg-static");

const app = express();

app.use(express.json());

const DATA_DIR =
  process.env.LANGUAGE_MEDIA_EDITOR_DATA_DIR ||
  path.join(__dirname, "..", "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const LESSONS_DIR = path.join(DATA_DIR, "lessons");
const SENTENCE_AUDIO_DIR = path.join(DATA_DIR, "sentence_audio");
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

function normalizeUniqueText(value = "") {
  return String(value || "")
    .trim()
    .replace(/\s+/g, " ")
    .toLocaleLowerCase();
}

function findDuplicateSentence(items = []) {
  const seen = new Set();

  for (const item of items) {
    const text = normalizeUniqueText(item?.jp);

    if (!text) {
      continue;
    }

    if (seen.has(text)) {
      return String(item.jp || "").trim();
    }

    seen.add(text);
  }

  return null;
}

function findExistingSentenceByJp(jp, excludeId = null) {
  const target = normalizeUniqueText(jp);

  if (!target) {
    return null;
  }

  const rows = db.prepare(`
    SELECT id, jp
    FROM sentence_items
    WHERE id != COALESCE(?, 0)
  `).all(excludeId);

  return rows.find((row) => normalizeUniqueText(row.jp) === target) || null;
}

function findExistingMediaName(name, excludeFilename = null) {
  const target = normalizeUniqueText(name);

  if (!target) {
    return null;
  }

  const rows = db.prepare(`
    SELECT filename, display_name
    FROM media_files
    WHERE filename != COALESCE(?, '')
  `).all(excludeFilename);

  return rows.find((row) =>
    normalizeUniqueText(row.filename) === target ||
    normalizeUniqueText(row.display_name || row.filename) === target
  ) || null;
}

function ensureDirExists(dir) {
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
}

ensureDirExists(DATA_DIR);
ensureDirExists(MEDIA_DIR);
ensureDirExists(LESSONS_DIR);
ensureDirExists(SENTENCE_AUDIO_DIR);

const allowedMediaExts = new Set([
  ".mp4", ".webm", ".mp3", ".wav", ".m4a", ".mov", ".mkv"
]);

const allowedLessonExts = new Set([
  ".json"
]);

function mediaFileFilter(req, file, cb) {
  const decodedName = decodeOriginalName(file.originalname);
  const safeName = sanitizeFilename(decodedName);
  const ext = path.extname(decodedName).toLowerCase();

  if (!allowedMediaExts.has(ext)) {
    return cb(new Error(`Unsupported media file type: ${ext || "(no extension)"}`));
  }

  if (fs.existsSync(path.join(MEDIA_DIR, safeName)) || findExistingMediaName(safeName)) {
    return cb(new Error(`已存在同名 media：${safeName}`));
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

function normalizeNullableId(value) {
  if (value === null || value === undefined || value === "") {
    return null;
  }

  const n = Number(value);
  if (!Number.isInteger(n) || n <= 0) {
    throw new Error("invalid id");
  }

  return n;
}

function getDescendantIds(folderId) {
  const allFolders = db.prepare(`
    SELECT id, parent_id FROM folders
  `).all();

  const childrenMap = new Map();

  for (const row of allFolders) {
    const key = row.parent_id ?? null;
    if (!childrenMap.has(key)) {
      childrenMap.set(key, []);
    }
    childrenMap.get(key).push(row.id);
  }

  const result = [];
  const stack = [...(childrenMap.get(folderId) || [])];

  while (stack.length > 0) {
    const current = stack.pop();
    result.push(current);

    const children = childrenMap.get(current) || [];
    stack.push(...children);
  }

  return result;
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

const zipUpload = multer({
  storage: multer.memoryStorage(),
  fileFilter: (req, file, cb) => {
    const decodedName = decodeOriginalName(file.originalname);
    const ext = path.extname(decodedName).toLowerCase();

    if (ext !== ".zip") {
      return cb(new Error("Unsupported import file type: .zip required"));
    }

    cb(null, true);
  },
  limits: {
    fileSize: 1024 * 1024 * 1024
  }
});

/* ================================
   external tools config
================================ */

const FFMPEG_PATH = process.env.FFMPEG_PATH || ffmpegStaticPath || "ffmpeg";

const WHISPER_DIR = path.join(__dirname, "..", "tools", "whisper");
const WHISPER_EXECUTABLE = process.platform === "win32" ? "whisper-cli.exe" : "whisper-cli";
const WHISPER_PATH =
  process.env.WHISPER_PATH ||
  path.join(WHISPER_DIR, WHISPER_EXECUTABLE);

const WHISPER_MODEL_PATH =
  process.env.WHISPER_MODEL_PATH ||
  path.join(WHISPER_DIR, "models", "ggml-base.bin");

function assertToolExists(toolPath, label) {
  if (!fs.existsSync(toolPath)) {
    throw new Error(`${label} not found: ${toolPath}`);
  }
}
  
function cleanWhisperText(raw = "") {
  return raw
    .replace(/\[[^\]]+\]\s*/g, "")
    .trim();
}

function normalizeWhisperLanguage(value) {
  const lang = String(value || "").trim().toLowerCase();
  if (!lang || lang === "auto") return "";
  if (!/^[a-z]{2,3}(?:-[a-z]{2,4})?$/.test(lang)) return "";
  return lang;
}

function cutSentenceAudio({ mediaFilename, start, end, sentenceId }) {
  return new Promise((resolve, reject) => {
    const safeMediaFilename = path.basename(String(mediaFilename || "").trim());
    const mediaPath = path.join(MEDIA_DIR, safeMediaFilename);

    if (!safeMediaFilename) {
      return reject(new Error("media_filename required for sentence audio"));
    }

    if (!fs.existsSync(mediaPath)) {
      return reject(new Error("source media file not found"));
    }

    if (!(Number.isFinite(start) && Number.isFinite(end)) || end <= start) {
      return reject(new Error("invalid start/end for sentence audio"));
    }

    const outputFilename = `sentence_${sentenceId}.mp3`;
    const outputPath = path.join(SENTENCE_AUDIO_DIR, outputFilename);

    execFile(
      FFMPEG_PATH,
      [
        "-y",
        "-ss", String(start),
        "-to", String(end),
        "-i", mediaPath,
        "-vn",
        "-acodec", "libmp3lame",
        "-ar", "44100",
        "-ac", "1",
        "-b:a", "128k",
        outputPath
      ],
      (err) => {
        if (err) {
          return reject(new Error(`ffmpeg cut sentence failed: ${err.message}`));
        }

        resolve(outputFilename);
      }
    );
  });
}

function escapeHtml(value = "") {
  return String(value)
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

function escapeJsonForHtml(data) {
  return JSON.stringify(data)
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026");
}

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);

  for (let i = 0; i < table.length; i += 1) {
    let value = i;

    for (let bit = 0; bit < 8; bit += 1) {
      value = value & 1 ? 0xedb88320 ^ (value >>> 1) : value >>> 1;
    }

    table[i] = value >>> 0;
  }

  return table;
})();

function crc32(buffer) {
  let crc = 0xffffffff;

  for (const byte of buffer) {
    crc = CRC32_TABLE[(crc ^ byte) & 0xff] ^ (crc >>> 8);
  }

  return (crc ^ 0xffffffff) >>> 0;
}

function getDosDateTime(date = new Date()) {
  const year = Math.max(date.getFullYear(), 1980);
  const dosTime =
    (date.getHours() << 11) |
    (date.getMinutes() << 5) |
    Math.floor(date.getSeconds() / 2);
  const dosDate =
    ((year - 1980) << 9) |
    ((date.getMonth() + 1) << 5) |
    date.getDate();

  return { dosDate, dosTime };
}

function listFilesForZip(sourceDir, currentDir = sourceDir) {
  return fs.readdirSync(currentDir, { withFileTypes: true })
    .flatMap((entry) => {
      const absolutePath = path.join(currentDir, entry.name);

      if (entry.isDirectory()) {
        return listFilesForZip(sourceDir, absolutePath);
      }

      if (!entry.isFile()) {
        return [];
      }

      return [{
        absolutePath,
        archivePath: path.relative(sourceDir, absolutePath).split(path.sep).join("/")
      }];
    })
    .sort((a, b) => a.archivePath.localeCompare(b.archivePath));
}

function zipDirectory(sourceDir, outputPath) {
  const files = listFilesForZip(sourceDir);
  const localParts = [];
  const centralParts = [];
  let offset = 0;

  for (const file of files) {
    const stat = fs.statSync(file.absolutePath);
    const sourceBuffer = fs.readFileSync(file.absolutePath);
    const compressedBuffer = zlib.deflateRawSync(sourceBuffer);
    const nameBuffer = Buffer.from(file.archivePath, "utf8");
    const checksum = crc32(sourceBuffer);
    const { dosDate, dosTime } = getDosDateTime(stat.mtime);

    const localHeader = Buffer.alloc(30);
    localHeader.writeUInt32LE(0x04034b50, 0);
    localHeader.writeUInt16LE(20, 4);
    localHeader.writeUInt16LE(0x0800, 6);
    localHeader.writeUInt16LE(8, 8);
    localHeader.writeUInt16LE(dosTime, 10);
    localHeader.writeUInt16LE(dosDate, 12);
    localHeader.writeUInt32LE(checksum, 14);
    localHeader.writeUInt32LE(compressedBuffer.length, 18);
    localHeader.writeUInt32LE(sourceBuffer.length, 22);
    localHeader.writeUInt16LE(nameBuffer.length, 26);
    localHeader.writeUInt16LE(0, 28);

    localParts.push(localHeader, nameBuffer, compressedBuffer);

    const centralHeader = Buffer.alloc(46);
    centralHeader.writeUInt32LE(0x02014b50, 0);
    centralHeader.writeUInt16LE(20, 4);
    centralHeader.writeUInt16LE(20, 6);
    centralHeader.writeUInt16LE(0x0800, 8);
    centralHeader.writeUInt16LE(8, 10);
    centralHeader.writeUInt16LE(dosTime, 12);
    centralHeader.writeUInt16LE(dosDate, 14);
    centralHeader.writeUInt32LE(checksum, 16);
    centralHeader.writeUInt32LE(compressedBuffer.length, 20);
    centralHeader.writeUInt32LE(sourceBuffer.length, 24);
    centralHeader.writeUInt16LE(nameBuffer.length, 28);
    centralHeader.writeUInt16LE(0, 30);
    centralHeader.writeUInt16LE(0, 32);
    centralHeader.writeUInt16LE(0, 34);
    centralHeader.writeUInt16LE(0, 36);
    centralHeader.writeUInt32LE(0, 38);
    centralHeader.writeUInt32LE(offset, 42);

    centralParts.push(centralHeader, nameBuffer);
    offset += localHeader.length + nameBuffer.length + compressedBuffer.length;
  }

  const centralSize = centralParts.reduce((sum, part) => sum + part.length, 0);
  const endHeader = Buffer.alloc(22);
  endHeader.writeUInt32LE(0x06054b50, 0);
  endHeader.writeUInt16LE(0, 4);
  endHeader.writeUInt16LE(0, 6);
  endHeader.writeUInt16LE(files.length, 8);
  endHeader.writeUInt16LE(files.length, 10);
  endHeader.writeUInt32LE(centralSize, 12);
  endHeader.writeUInt32LE(offset, 16);
  endHeader.writeUInt16LE(0, 20);

  fs.writeFileSync(outputPath, Buffer.concat([
    ...localParts,
    ...centralParts,
    endHeader
  ]));
}

function readZipEntries(buffer) {
  const minEndOffset = Math.max(0, buffer.length - 0xffff - 22);
  let endOffset = -1;

  for (let i = buffer.length - 22; i >= minEndOffset; i -= 1) {
    if (buffer.readUInt32LE(i) === 0x06054b50) {
      endOffset = i;
      break;
    }
  }

  if (endOffset < 0) {
    throw new Error("Invalid ZIP: end record not found");
  }

  const entryCount = buffer.readUInt16LE(endOffset + 10);
  const centralOffset = buffer.readUInt32LE(endOffset + 16);
  const entries = new Map();
  let cursor = centralOffset;

  for (let i = 0; i < entryCount; i += 1) {
    if (buffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new Error("Invalid ZIP: central directory is corrupt");
    }

    const flags = buffer.readUInt16LE(cursor + 8);
    const method = buffer.readUInt16LE(cursor + 10);
    const compressedSize = buffer.readUInt32LE(cursor + 20);
    const uncompressedSize = buffer.readUInt32LE(cursor + 24);
    const nameLength = buffer.readUInt16LE(cursor + 28);
    const extraLength = buffer.readUInt16LE(cursor + 30);
    const commentLength = buffer.readUInt16LE(cursor + 32);
    const localOffset = buffer.readUInt32LE(cursor + 42);
    const nameBuffer = buffer.subarray(cursor + 46, cursor + 46 + nameLength);
    const name = nameBuffer.toString(flags & 0x0800 ? "utf8" : "utf8").replace(/\\/g, "/");

    cursor += 46 + nameLength + extraLength + commentLength;

    if (!name || name.endsWith("/")) {
      continue;
    }

    if (name.includes("..") || path.posix.isAbsolute(name)) {
      throw new Error(`Unsafe ZIP entry path: ${name}`);
    }

    if (buffer.readUInt32LE(localOffset) !== 0x04034b50) {
      throw new Error(`Invalid ZIP: local header missing for ${name}`);
    }

    const localNameLength = buffer.readUInt16LE(localOffset + 26);
    const localExtraLength = buffer.readUInt16LE(localOffset + 28);
    const dataStart = localOffset + 30 + localNameLength + localExtraLength;
    const compressedData = buffer.subarray(dataStart, dataStart + compressedSize);

    let data;
    if (method === 0) {
      data = Buffer.from(compressedData);
    } else if (method === 8) {
      data = zlib.inflateRawSync(compressedData);
    } else {
      throw new Error(`Unsupported ZIP compression method ${method} for ${name}`);
    }

    if (data.length !== uncompressedSize) {
      throw new Error(`Invalid ZIP: size mismatch for ${name}`);
    }

    entries.set(name, data);
  }

  return entries;
}

function findZipEntry(entries, predicate) {
  for (const [name, data] of entries.entries()) {
    if (predicate(name)) {
      return { name, data };
    }
  }

  return null;
}

function getZipJsonManifest(entries, manifestName, scriptId) {
  const manifest = findZipEntry(entries, (name) => path.posix.basename(name) === manifestName);

  if (manifest) {
    return {
      baseDir: path.posix.dirname(manifest.name) === "." ? "" : path.posix.dirname(manifest.name),
      data: JSON.parse(manifest.data.toString("utf8"))
    };
  }

  const html = findZipEntry(entries, (name) => path.posix.basename(name) === "index.html");

  if (!html) {
    throw new Error(`${manifestName} not found in ZIP`);
  }

  const source = html.data.toString("utf8");
  const pattern = new RegExp(`<script[^>]+id=["']${scriptId}["'][^>]*>([\\s\\S]*?)<\\/script>`, "i");
  const match = source.match(pattern);

  if (!match) {
    throw new Error(`${manifestName} data not found in index.html`);
  }

  return {
    baseDir: path.posix.dirname(html.name) === "." ? "" : path.posix.dirname(html.name),
    data: JSON.parse(match[1])
  };
}

function resolveZipRelativeEntry(entries, baseDir, relativePath) {
  const decodedPath = decodeURIComponent(String(relativePath || ""));
  const normalized = path.posix.normalize(decodedPath).replace(/^\/+/, "");

  if (!normalized || normalized.startsWith("../") || normalized === "..") {
    return null;
  }

  const fullPath = baseDir ? path.posix.join(baseDir, normalized) : normalized;
  const data = entries.get(fullPath);

  return data ? { name: fullPath, data } : null;
}

function buildLessonExportHtml(exportLesson) {
  const title = escapeHtml(exportLesson.title || "Lesson");
  const dataJson = escapeJsonForHtml(exportLesson);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    body {
      font-family: Arial, "Microsoft JhengHei", sans-serif;
      margin: 24px;
      background: #f7f7f7;
      color: #222;
    }
    h1 {
      margin-top: 0;
    }
    video,
    audio {
      width: 100%;
      max-width: 960px;
      background: #000;
      border-radius: 8px;
      display: block;
      margin-bottom: 16px;
    }
    .clip {
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 10px;
    }
    .meta {
      color: #666;
      font-size: 14px;
      margin-bottom: 8px;
    }
    .jp {
      font-size: 18px;
      line-height: 1.6;
      white-space: pre-wrap;
      margin-bottom: 8px;
    }
    .zh {
      color: #444;
      line-height: 1.5;
      white-space: pre-wrap;
      margin-bottom: 8px;
    }
    button {
      padding: 6px 12px;
      cursor: pointer;
    }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div id="mediaHost"></div>
  <div id="clipList"></div>

  <script id="lesson-data" type="application/json">${dataJson}</script>
  <script>
    const lesson = JSON.parse(document.getElementById("lesson-data").textContent);
    const mediaHost = document.getElementById("mediaHost");
    const clipList = document.getElementById("clipList");
    const mediaPath = lesson.media_path || "";
    const isAudio = /\\.(mp3|wav|m4a|aac|ogg)$/i.test(mediaPath);
    const player = document.createElement(isAudio ? "audio" : "video");
    player.controls = true;
    player.src = mediaPath;
    mediaHost.appendChild(player);

    function formatTime(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(1) : "0.0";
    }

    let stopAtEnd = null;

    function playClip(clip) {
      if (stopAtEnd) {
        player.removeEventListener("timeupdate", stopAtEnd);
        stopAtEnd = null;
      }

      player.currentTime = Number(clip.start) || 0;
      player.play();

      stopAtEnd = () => {
        if (player.currentTime >= Number(clip.end) || player.ended) {
          player.pause();
          player.removeEventListener("timeupdate", stopAtEnd);
          stopAtEnd = null;
        }
      };

      player.addEventListener("timeupdate", stopAtEnd);
    }

    lesson.clips.forEach((clip, index) => {
      const card = document.createElement("div");
      card.className = "clip";

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = "#" + (index + 1) + " [" + formatTime(clip.start) + " - " + formatTime(clip.end) + "]" +
        (clip.category ? " | " + clip.category : "");

      const jp = document.createElement("div");
      jp.className = "jp";
      jp.textContent = clip.jp || "";

      const zh = document.createElement("div");
      zh.className = "zh";
      zh.textContent = clip.zh || "";

      const btn = document.createElement("button");
      btn.type = "button";
      btn.textContent = "Play Clip";
      btn.onclick = () => playClip(clip);

      card.append(meta, jp, zh, btn);
      clipList.appendChild(card);
    });
  </script>
</body>
</html>
`;
}

function buildSentenceExportHtml(exportData) {
  const title = escapeHtml(exportData.title || "Sentence Export");
  const dataJson = escapeJsonForHtml(exportData);

  return `<!DOCTYPE html>
<html>
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    body {
      font-family: Arial, "Microsoft JhengHei", sans-serif;
      margin: 24px;
      background: #f7f7f7;
      color: #222;
    }
    h1 {
      margin-top: 0;
    }
    .sentence {
      background: #fff;
      border: 1px solid #ddd;
      border-radius: 8px;
      padding: 12px 14px;
      margin-bottom: 12px;
    }
    .meta {
      color: #666;
      font-size: 14px;
      margin-bottom: 8px;
    }
    .jp {
      font-size: 18px;
      line-height: 1.6;
      white-space: pre-wrap;
      margin-bottom: 8px;
    }
    .zh {
      color: #444;
      line-height: 1.5;
      white-space: pre-wrap;
      margin-bottom: 8px;
    }
    audio {
      width: 100%;
      margin-top: 8px;
    }
  </style>
</head>
<body>
  <h1>${title}</h1>
  <div id="sentenceList"></div>

  <script id="export-data" type="application/json">${dataJson}</script>
  <script>
    const exportData = JSON.parse(document.getElementById("export-data").textContent);
    const sentenceList = document.getElementById("sentenceList");

    function formatTime(value) {
      const n = Number(value);
      return Number.isFinite(n) ? n.toFixed(1) : "0.0";
    }

    exportData.sentences.forEach((item, index) => {
      const card = document.createElement("div");
      card.className = "sentence";

      const meta = document.createElement("div");
      meta.className = "meta";
      meta.textContent = "#" + (index + 1) + " [" + formatTime(item.start) + " - " + formatTime(item.end) + "]" +
        (item.category ? " | " + item.category : "");

      const jp = document.createElement("div");
      jp.className = "jp";
      jp.textContent = item.jp || "";

      const zh = document.createElement("div");
      zh.className = "zh";
      zh.textContent = item.zh || "";

      card.append(meta, jp, zh);

      if (item.audio_path) {
        const audio = document.createElement("audio");
        audio.controls = true;
        audio.src = item.audio_path;
        card.appendChild(audio);
      }

      sentenceList.appendChild(card);
    });
  </script>
</body>
</html>
`;
}

app.use(express.static(SRC_DIR));

/* ================================
   folders
================================ */

app.get("/api/folders", (req, res) => {
  try {
    const kind = String(req.query.kind || "").trim();

    if (kind !== "media" && kind !== "lesson") {
      return res.status(400).json({
        ok: false,
        error: "kind must be media or lesson"
      });
    }

    const rows = db.prepare(`
      SELECT * FROM folders
      WHERE kind = ?
      ORDER BY
        CASE WHEN parent_id IS NULL THEN 0 ELSE 1 END,
        parent_id,
        name COLLATE NOCASE
    `).all(kind);

    res.json({
      ok: true,
      folders: rows
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/api/folders", (req, res) => {
  try {
    const { name, kind, parent_id } = req.body;

    const trimmedName = String(name || "").trim();

    if (!trimmedName) {
      return res.status(400).json({
        ok: false,
        error: "name required"
      });
    }

    if (kind !== "media" && kind !== "lesson") {
      return res.status(400).json({
        ok: false,
        error: "kind must be media or lesson"
      });
    }

    let normalizedParentId = null;

    if (parent_id !== null && parent_id !== undefined && parent_id !== "") {
      normalizedParentId = Number(parent_id);

      if (!Number.isInteger(normalizedParentId) || normalizedParentId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "invalid parent_id"
        });
      }

      const parent = db.prepare(`
        SELECT * FROM folders WHERE id = ?
      `).get(normalizedParentId);

      if (!parent) {
        return res.status(400).json({
          ok: false,
          error: "parent folder not found"
        });
      }

      if (parent.kind !== kind) {
        return res.status(400).json({
          ok: false,
          error: "parent folder kind mismatch"
        });
      }
    }

    const duplicate = db.prepare(`
      SELECT id
      FROM folders
      WHERE name = ?
        AND kind = ?
        AND (
          (parent_id IS NULL AND ? IS NULL)
          OR parent_id = ?
        )
    `).get(trimmedName, kind, normalizedParentId, normalizedParentId);

    if (duplicate) {
      return res.status(400).json({
        ok: false,
        error: "同一層已有同名資料夾"
      });
    }

    const result = db.prepare(`
      INSERT INTO folders (name, kind, parent_id, created_at)
      VALUES (?, ?, ?, ?)
    `).run(
      trimmedName,
      kind,
      normalizedParentId,
      new Date().toISOString()
    );

    res.json({
      ok: true,
      id: result.lastInsertRowid,
      name: trimmedName,
      kind,
      parent_id: normalizedParentId
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.delete("/api/folders/:id", (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid folder id"
      });
    }

    const folder = db.prepare(`
      SELECT * FROM folders WHERE id = ?
    `).get(id);

    if (!folder) {
      return res.status(404).json({
        ok: false,
        error: "Folder not found"
      });
    }

    const child = db.prepare(`
      SELECT id FROM folders WHERE parent_id = ? LIMIT 1
    `).get(id);

    if (child) {
      return res.status(400).json({
        ok: false,
        error: "資料夾內還有子資料夾，不能刪除"
      });
    }

    const mediaItem = db.prepare(`
      SELECT id FROM media_files WHERE folder_id = ? LIMIT 1
    `).get(id);

    if (mediaItem) {
      return res.status(400).json({
        ok: false,
        error: "資料夾內還有 media，不能刪除"
      });
    }

    const lessonItem = db.prepare(`
      SELECT id FROM lessons WHERE folder_id = ? LIMIT 1
    `).get(id);

    if (lessonItem) {
      return res.status(400).json({
        ok: false,
        error: "資料夾內還有 lesson，不能刪除"
      });
    }

    db.prepare(`
      DELETE FROM folders WHERE id = ?
    `).run(id);

    res.json({
      ok: true,
      id
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.patch("/api/folders/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const name = String(req.body.name || "").trim();

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid folder id"
      });
    }

    if (!name) {
      return res.status(400).json({
        ok: false,
        error: "name required"
      });
    }

    const folder = db.prepare(`
      SELECT * FROM folders WHERE id = ?
    `).get(id);

    if (!folder) {
      return res.status(404).json({
        ok: false,
        error: "Folder not found"
      });
    }

    const duplicate = db.prepare(`
      SELECT id
      FROM folders
      WHERE name = ?
        AND kind = ?
        AND id != ?
        AND (
          (parent_id IS NULL AND ? IS NULL)
          OR parent_id = ?
        )
    `).get(name, folder.kind, id, folder.parent_id, folder.parent_id);

    if (duplicate) {
      return res.status(400).json({
        ok: false,
        error: "同一層已有同名資料夾"
      });
    }

    db.prepare(`
      UPDATE folders
      SET name = ?
      WHERE id = ?
    `).run(name, id);

    res.json({
      ok: true,
      id,
      name
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.patch("/api/folders/:id/move", (req, res) => {
  try {
    const id = Number(req.params.id);
    const parent_id = normalizeNullableId(req.body.parent_id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid folder id"
      });
    }

    const folder = db.prepare(`
      SELECT * FROM folders WHERE id = ?
    `).get(id);

    if (!folder) {
      return res.status(404).json({
        ok: false,
        error: "Folder not found"
      });
    }

    if (parent_id === id) {
      return res.status(400).json({
        ok: false,
        error: "不能把資料夾移到自己底下"
      });
    }

    let parent = null;

    if (parent_id !== null) {
      parent = db.prepare(`
        SELECT * FROM folders WHERE id = ?
      `).get(parent_id);

      if (!parent) {
        return res.status(400).json({
          ok: false,
          error: "target parent folder not found"
        });
      }

      if (parent.kind !== folder.kind) {
        return res.status(400).json({
          ok: false,
          error: "target parent folder kind mismatch"
        });
      }

      const descendantIds = getDescendantIds(id);
      if (descendantIds.includes(parent_id)) {
        return res.status(400).json({
          ok: false,
          error: "不能移到自己的子資料夾底下"
        });
      }
    }

    const duplicate = db.prepare(`
      SELECT id
      FROM folders
      WHERE name = ?
        AND kind = ?
        AND id != ?
        AND (
          (parent_id IS NULL AND ? IS NULL)
          OR parent_id = ?
        )
    `).get(folder.name, folder.kind, id, parent_id, parent_id);

    if (duplicate) {
      return res.status(400).json({
        ok: false,
        error: "目標位置已有同名資料夾"
      });
    }

    db.prepare(`
      UPDATE folders
      SET parent_id = ?
      WHERE id = ?
    `).run(parent_id, id);

    res.json({
      ok: true,
      id,
      parent_id
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* ================================
   media
================================ */
app.get("/api/media", (req, res) => {
  try {
    const folderIdRaw = req.query.folder_id;

    let rows;
    if (folderIdRaw === undefined || folderIdRaw === null || folderIdRaw === "") {
      rows = db.prepare(`
        SELECT * FROM media_files
        WHERE folder_id IS NULL
        ORDER BY created_at DESC
      `).all();
    } else {
      const folderId = Number(folderIdRaw);

      if (!Number.isInteger(folderId) || folderId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "invalid folder_id"
        });
      }

      rows = db.prepare(`
        SELECT * FROM media_files
        WHERE folder_id = ?
        ORDER BY created_at DESC
      `).all(folderId);
    }

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

    const duplicate = findExistingMediaName(display_name, filename);

    if (duplicate) {
      return res.status(400).json({
        ok: false,
        error: `已有同名 media：${display_name.trim()}`
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

app.get("/sentence-audio/:filename", (req, res) => {
  const filename = path.basename(req.params.filename);
  const filePath = path.join(SENTENCE_AUDIO_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("Sentence audio not found");
  }

  return res.sendFile(filePath);
});

app.patch("/api/media/:filename/move", (req, res) => {
  try {
    const filename = path.basename(req.params.filename);
    const folder_id = normalizeNullableId(req.body.folder_id);

    const media = db.prepare(`
      SELECT * FROM media_files WHERE filename = ?
    `).get(filename);

    if (!media) {
      return res.status(404).json({
        ok: false,
        error: "Media not found"
      });
    }

    if (folder_id !== null) {
      const folder = db.prepare(`
        SELECT * FROM folders WHERE id = ?
      `).get(folder_id);

      if (!folder) {
        return res.status(400).json({
          ok: false,
          error: "target folder not found"
        });
      }

      if (folder.kind !== "media") {
        return res.status(400).json({
          ok: false,
          error: "target folder must be media"
        });
      }
    }

    db.prepare(`
      UPDATE media_files
      SET folder_id = ?
      WHERE filename = ?
    `).run(folder_id, filename);

    res.json({
      ok: true,
      filename,
      folder_id
    });

  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

/* ================================
   lessons
================================ */

app.get("/api/lessons", (req, res) => {
  try {
    const folderIdRaw = req.query.folder_id;

    let lessons;
    if (folderIdRaw === undefined || folderIdRaw === null || folderIdRaw === "") {
      lessons = db.prepare(`
        SELECT * FROM lessons
        WHERE folder_id IS NULL
        ORDER BY created_at DESC
      `).all();
    } else {
      const folderId = Number(folderIdRaw);

      if (!Number.isInteger(folderId) || folderId <= 0) {
        return res.status(400).json({
          ok: false,
          error: "invalid folder_id"
        });
      }

      lessons = db.prepare(`
        SELECT * FROM lessons
        WHERE folder_id = ?
        ORDER BY created_at DESC
      `).all(folderId);
    }

    res.json(lessons);
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
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

app.get("/api/lessons/:id/export", async (req, res) => {
  let exportRoot = null;

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

    exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "lesson-export-"));

    const clips = db.prepare(`
      SELECT start, end, jp, zh, category, sort_order
      FROM clips
      WHERE lesson_id = ?
      ORDER BY sort_order
    `).all(id);

    const exportTitle = lessonRow.title || `lesson-${id}`;
    const safeBaseName = sanitizeFilename(exportTitle).replace(/\s+/g, "_") || `lesson-${id}`;
    const packageDir = path.join(exportRoot, safeBaseName);
    const mediaDir = path.join(packageDir, "media");
    ensureDirExists(mediaDir);

    let mediaPath = "";

    if (lessonRow.media_filename) {
      const mediaFilename = path.basename(lessonRow.media_filename);
      const sourceMediaPath = path.join(MEDIA_DIR, mediaFilename);

      if (!fs.existsSync(sourceMediaPath)) {
        fs.rm(exportRoot, { recursive: true, force: true }, () => {});
        exportRoot = null;

        return res.status(404).json({
          ok: false,
          error: `Media file not found: ${mediaFilename}`
        });
      }

      fs.copyFileSync(sourceMediaPath, path.join(mediaDir, mediaFilename));
      mediaPath = `media/${encodeURIComponent(mediaFilename)}`;
    }

    const exportLesson = {
      title: exportTitle,
      media_path: mediaPath,
      clips: clips.map((clip) => ({
        start: clip.start,
        end: clip.end,
        jp: clip.jp || "",
        zh: clip.zh || "",
        category: clip.category || ""
      }))
    };

    fs.writeFileSync(
      path.join(packageDir, "index.html"),
      buildLessonExportHtml(exportLesson),
      "utf8"
    );

    fs.writeFileSync(
      path.join(packageDir, "lesson-export.json"),
      JSON.stringify({
        type: "lesson",
        version: 1,
        lesson: exportLesson
      }, null, 2),
      "utf8"
    );

    const zipPath = path.join(exportRoot, `${safeBaseName}.zip`);
    await zipDirectory(packageDir, zipPath);

    res.download(zipPath, `${safeBaseName}.zip`, (err) => {
      fs.rm(exportRoot, { recursive: true, force: true }, () => {});

      if (err && !res.headersSent) {
        res.status(500).json({
          ok: false,
          error: err.message
        });
      }
    });
  } catch (err) {
    if (exportRoot) {
      fs.rm(exportRoot, { recursive: true, force: true }, () => {});
    }

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
});

app.post("/api/lessons/import-export", (req, res) => {
  zipUpload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        ok: false,
        error: err.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No ZIP uploaded"
      });
    }

    try {
      const folder_id = req.body.folder_id ? normalizeNullableId(req.body.folder_id) : null;
      const entries = readZipEntries(req.file.buffer);
      const manifest = getZipJsonManifest(entries, "lesson-export.json", "lesson-data");
      const lessonData = manifest.data.lesson || manifest.data;
      const title = String(lessonData.title || "").trim();
      const clips = Array.isArray(lessonData.clips) ? lessonData.clips : [];

      if (!title) {
        return res.status(400).json({
          ok: false,
          error: "Lesson export 缺少 title"
        });
      }

      const existing = db.prepare(`
        SELECT id FROM lessons WHERE title = ?
      `).get(title);

      if (existing) {
        return res.status(409).json({
          ok: false,
          error: `已存在同名 lesson：${title}`
        });
      }

      const duplicateSentence = findDuplicateSentence(clips);

      if (duplicateSentence) {
        return res.status(400).json({
          ok: false,
          error: `Lesson 內已有重複 sentence：${duplicateSentence}`
        });
      }

      let mediaFilename = null;
      let mediaEntry = null;

      if (lessonData.media_path) {
        mediaEntry = resolveZipRelativeEntry(entries, manifest.baseDir, lessonData.media_path);

        if (!mediaEntry) {
          return res.status(400).json({
            ok: false,
            error: `Lesson ZIP 缺少 media：${lessonData.media_path}`
          });
        }

        mediaFilename = sanitizeFilename(path.posix.basename(decodeURIComponent(lessonData.media_path)));

        if (fs.existsSync(path.join(MEDIA_DIR, mediaFilename)) || findExistingMediaName(mediaFilename)) {
          return res.status(409).json({
            ok: false,
            error: `已存在同名 media：${mediaFilename}`
          });
        }
      }

      const now = new Date().toISOString();
      const importLesson = db.transaction(() => {
        if (mediaFilename && mediaEntry) {
          fs.writeFileSync(path.join(MEDIA_DIR, mediaFilename), mediaEntry.data);

          db.prepare(`
            INSERT INTO media_files (filename, display_name, folder_id, created_at)
            VALUES (?, ?, ?, ?)
          `).run(mediaFilename, mediaFilename, null, now);
        }

        const result = db.prepare(`
          INSERT INTO lessons (title, media_filename, folder_id, created_at, updated_at)
          VALUES (?, ?, ?, ?, ?)
        `).run(title, mediaFilename, folder_id, now, now);

        const lessonId = result.lastInsertRowid;
        const insertClip = db.prepare(`
          INSERT INTO clips
          (lesson_id, start, end, jp, zh, category, sort_order)
          VALUES (?, ?, ?, ?, ?, ?, ?)
        `);

        clips
          .map((clip) => ({
            start: Number(clip.start) || 0,
            end: Number(clip.end) || 0,
            jp: String(clip.jp || "").trim(),
            zh: String(clip.zh || "").trim(),
            category: String(clip.category || "").trim()
          }))
          .sort((a, b) => Number(a.start) - Number(b.start))
          .forEach((clip, index) => {
            insertClip.run(
              lessonId,
              clip.start,
              clip.end,
              clip.jp,
              clip.zh,
              clip.category,
              index
            );
          });

        return lessonId;
      });

      const lessonId = importLesson();

      return res.json({
        ok: true,
        id: lessonId,
        title,
        imported_clips: clips.length,
        media_filename: mediaFilename
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: `匯入 lesson export 失敗：${error.message}`
      });
    }
  });
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

    const deleteLesson = db.transaction(() => {
      db.prepare(`
        UPDATE sentence_items
        SET lesson_id = NULL, clip_index = NULL, updated_at = ?
        WHERE lesson_id = ?
      `).run(new Date().toISOString(), id);

      db.prepare(`DELETE FROM clips WHERE lesson_id = ?`).run(id);
      db.prepare(`DELETE FROM lessons WHERE id = ?`).run(id);
    });

    deleteLesson();

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
  const { id, title, media, clips, folder_id } = req.body;
  const now = new Date().toISOString();

  let lessonId = id;

  try {
    const trimmedTitle = String(title || "").trim();
    const lessonClips = Array.isArray(clips) ? clips : [];

    if (!trimmedTitle) {
      return res.status(400).json({
        ok: false,
        error: "title required"
      });
    }

    const duplicateTitle = db.prepare(`
      SELECT id FROM lessons
      WHERE title = ? AND id != COALESCE(?, 0)
    `).get(trimmedTitle, id || null);

    if (duplicateTitle) {
      return res.status(400).json({
        ok: false,
        error: `已有同名 lesson：${trimmedTitle}`
      });
    }

    const duplicateSentence = findDuplicateSentence(lessonClips);

    if (duplicateSentence) {
      return res.status(400).json({
        ok: false,
        error: `Lesson 內已有重複 sentence：${duplicateSentence}`
      });
    }

    if (id) {
      // ===== update =====
      db.prepare(`
        UPDATE lessons
        SET title = ?, media_filename = ?, folder_id = ?, updated_at = ?
        WHERE id = ?
      `).run(trimmedTitle, media, folder_id ?? null, now, id);

      // 刪舊 clips
      db.prepare(`DELETE FROM clips WHERE lesson_id = ?`).run(id);

    } else {
      // ===== create =====
      const result = db.prepare(`
        INSERT INTO lessons (title, media_filename, folder_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `).run(trimmedTitle, media, folder_id ?? null, now, now);

      lessonId = result.lastInsertRowid;
    }

    // ===== 插入 clips =====
    const insertClip = db.prepare(`
      INSERT INTO clips
      (lesson_id, start, end, jp, zh, category, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const sortedClips = [...lessonClips].sort(
      (a, b) => Number(a.start) - Number(b.start)
    );

    sortedClips.forEach((c, i) => {
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
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.patch("/api/lessons/:id/move", (req, res) => {
  try {
    const id = Number(req.params.id);
    const folder_id = normalizeNullableId(req.body.folder_id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "Invalid lesson id"
      });
    }

    const lesson = db.prepare(`
      SELECT * FROM lessons WHERE id = ?
    `).get(id);

    if (!lesson) {
      return res.status(404).json({
        ok: false,
        error: "Lesson not found"
      });
    }

    if (folder_id !== null) {
      const folder = db.prepare(`
        SELECT * FROM folders WHERE id = ?
      `).get(folder_id);

      if (!folder) {
        return res.status(400).json({
          ok: false,
          error: "target folder not found"
        });
      }

      if (folder.kind !== "lesson") {
        return res.status(400).json({
          ok: false,
          error: "target folder must be lesson"
        });
      }
    }

    db.prepare(`
      UPDATE lessons
      SET folder_id = ?, updated_at = ?
      WHERE id = ?
    `).run(folder_id, new Date().toISOString(), id);

    res.json({
      ok: true,
      id,
      folder_id
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

  try {
    assertToolExists(WHISPER_PATH, "whisper-cli");
    assertToolExists(WHISPER_MODEL_PATH, "Whisper model");
  } catch (err) {
    return res.status(500).json({
      ok: false,
      error: `${err.message}\n請確認下載的是新版 release，或設定 WHISPER_PATH / WHISPER_MODEL_PATH。`
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

      const whisperLang = normalizeWhisperLanguage(lang);
      const whisperArgs = [
        "-f", tempWavPath,
        "-m", WHISPER_MODEL_PATH,
        "-otxt"
      ];

      if (whisperLang) {
        whisperArgs.splice(2, 0, "-l", whisperLang);
      }

      execFile(
        WHISPER_PATH,
        whisperArgs,
        { cwd: path.dirname(WHISPER_PATH) },
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
   sentences
================================ */

app.get("/api/sentence-categories", (req, res) => {
  try {
    const rows = db.prepare(`
      SELECT DISTINCT category
      FROM sentence_items
      WHERE category IS NOT NULL
        AND TRIM(category) != ''
      ORDER BY category COLLATE NOCASE
    `).all();

    res.json({
      ok: true,
      categories: rows.map((row) => row.category)
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.get("/api/sentences", (req, res) => {
  try {
    const q = String(req.query.q || "").trim();
    const category = String(req.query.category || "").trim();

    let sql = `
      SELECT *
      FROM sentence_items
      WHERE 1 = 1
    `;
    const params = [];

    if (q) {
      sql += `
        AND (
          jp LIKE ?
          OR zh LIKE ?
          OR category LIKE ?
          OR note LIKE ?
        )
      `;
      const like = `%${q}%`;
      params.push(like, like, like, like);
    }

    if (category) {
      sql += ` AND category = ? `;
      params.push(category);
    }

    sql += ` ORDER BY created_at DESC, id DESC `;

    const rows = db.prepare(sql).all(...params);

    res.json({
      ok: true,
      items: rows
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/api/sentences", async (req, res) => {
  try {
    const {
      lesson_id = null,
      clip_index = null,
      media_filename = "",
      start = null,
      end = null,
      jp = "",
      zh = "",
      category = "",
      note = ""
    } = req.body || {};

    const trimmedJp = String(jp || "").trim();
    const trimmedZh = String(zh || "").trim();
    const trimmedCategory = String(category || "").trim();
    const trimmedNote = String(note || "").trim();
    const trimmedMediaFilename = String(media_filename || "").trim();

    const normalizedLessonId =
      lesson_id === null || lesson_id === undefined || lesson_id === ""
        ? null
        : Number(lesson_id);

    const normalizedClipIndex =
      clip_index === null || clip_index === undefined || clip_index === ""
        ? null
        : Number(clip_index);

    if (!trimmedJp) {
      return res.status(400).json({
        ok: false,
        error: "jp required"
      });
    }

    if (
      normalizedLessonId !== null &&
      (!Number.isInteger(normalizedLessonId) || normalizedLessonId <= 0)
    ) {
      return res.status(400).json({
        ok: false,
        error: "invalid lesson_id"
      });
    }

    if (
      normalizedClipIndex !== null &&
      (!Number.isInteger(normalizedClipIndex) || normalizedClipIndex < 0)
    ) {
      return res.status(400).json({
        ok: false,
        error: "invalid clip_index"
      });
    }

    const safeStart = Number.isFinite(Number(start)) ? Number(start) : null;
    const safeEnd = Number.isFinite(Number(end)) ? Number(end) : null;

    if (!(Number.isFinite(safeStart) && Number.isFinite(safeEnd)) || safeEnd <= safeStart) {
      return res.status(400).json({
        ok: false,
        error: "invalid start/end"
      });
    }

    if (!trimmedMediaFilename) {
      return res.status(400).json({
        ok: false,
        error: "media_filename required"
      });
    }

    const duplicate = findExistingSentenceByJp(trimmedJp);

    if (duplicate) {
      return res.status(400).json({
        ok: false,
        error: `Sentence Book 已有重複 sentence：${trimmedJp}`
      });
    }

    const now = new Date().toISOString();

    const result = db.prepare(`
      INSERT INTO sentence_items (
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
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(
      normalizedLessonId,
      normalizedClipIndex,
      trimmedMediaFilename,
      null,
      safeStart,
      safeEnd,
      trimmedJp,
      trimmedZh,
      trimmedCategory,
      trimmedNote,
      now,
      now
    );

    const sentenceId = Number(result.lastInsertRowid);

    let audioFilename = null;

    try {
      audioFilename = await cutSentenceAudio({
        mediaFilename: trimmedMediaFilename,
        start: safeStart,
        end: safeEnd,
        sentenceId
      });

      db.prepare(`
        UPDATE sentence_items
        SET audio_filename = ?, updated_at = ?
        WHERE id = ?
      `).run(audioFilename, new Date().toISOString(), sentenceId);
    } catch (cutErr) {
      db.prepare(`
        DELETE FROM sentence_items WHERE id = ?
      `).run(sentenceId);

      return res.status(500).json({
        ok: false,
        error: cutErr.message
      });
    }

    res.json({
      ok: true,
      id: sentenceId,
      audio_filename: audioFilename
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.post("/api/sentences/export", async (req, res) => {
  let exportRoot = null;

  try {
    const title = String(req.body?.title || "").trim();
    const ids = Array.isArray(req.body?.ids)
      ? req.body.ids.map((id) => Number(id))
      : [];

    if (!title) {
      return res.status(400).json({
        ok: false,
        error: "title required"
      });
    }

    if (ids.length === 0 || ids.some((id) => !Number.isInteger(id) || id <= 0)) {
      return res.status(400).json({
        ok: false,
        error: "valid sentence ids required"
      });
    }

    const placeholders = ids.map(() => "?").join(",");
    const rows = db.prepare(`
      SELECT *
      FROM sentence_items
      WHERE id IN (${placeholders})
    `).all(...ids);

    if (rows.length !== ids.length) {
      return res.status(404).json({
        ok: false,
        error: "Some sentences were not found"
      });
    }

    const byId = new Map(rows.map((row) => [row.id, row]));
    const orderedRows = ids.map((id) => byId.get(id));

    exportRoot = fs.mkdtempSync(path.join(os.tmpdir(), "sentence-export-"));

    const safeBaseName = sanitizeFilename(title).replace(/\s+/g, "_") || "sentence-export";
    const packageDir = path.join(exportRoot, safeBaseName);
    const audioDir = path.join(packageDir, "audio");
    ensureDirExists(audioDir);

    const exportSentences = orderedRows.map((item, index) => {
      let audioPath = "";

      if (item.audio_filename) {
        const audioFilename = path.basename(item.audio_filename);
        const sourceAudioPath = path.join(SENTENCE_AUDIO_DIR, audioFilename);

        if (!fs.existsSync(sourceAudioPath)) {
          throw new Error(`Sentence audio not found: ${audioFilename}`);
        }

        const outputAudioFilename = `sentence-${index + 1}${path.extname(audioFilename) || ".mp3"}`;
        fs.copyFileSync(sourceAudioPath, path.join(audioDir, outputAudioFilename));
        audioPath = `audio/${encodeURIComponent(outputAudioFilename)}`;
      }

      return {
        start: item.start,
        end: item.end,
        jp: item.jp || "",
        zh: item.zh || "",
        category: item.category || "",
        note: item.note || "",
        audio_path: audioPath
      };
    });

    fs.writeFileSync(
      path.join(packageDir, "index.html"),
      buildSentenceExportHtml({
        title,
        sentences: exportSentences
      }),
      "utf8"
    );

    fs.writeFileSync(
      path.join(packageDir, "sentence-export.json"),
      JSON.stringify({
        type: "sentence-book",
        version: 1,
        title,
        sentences: exportSentences
      }, null, 2),
      "utf8"
    );

    const zipPath = path.join(exportRoot, `${safeBaseName}.zip`);
    await zipDirectory(packageDir, zipPath);

    res.download(zipPath, `${safeBaseName}.zip`, (err) => {
      fs.rm(exportRoot, { recursive: true, force: true }, () => {});

      if (err && !res.headersSent) {
        res.status(500).json({
          ok: false,
          error: err.message
        });
      }
    });
  } catch (err) {
    if (exportRoot) {
      fs.rm(exportRoot, { recursive: true, force: true }, () => {});
    }

    if (!res.headersSent) {
      res.status(500).json({
        ok: false,
        error: err.message
      });
    }
  }
});

app.post("/api/sentences/import-export", (req, res) => {
  zipUpload.single("file")(req, res, (err) => {
    if (err) {
      return res.status(400).json({
        ok: false,
        error: err.message
      });
    }

    if (!req.file) {
      return res.status(400).json({
        ok: false,
        error: "No ZIP uploaded"
      });
    }

    try {
      const duplicateMode = String(req.body.duplicate_mode || "skip").trim();

      if (duplicateMode !== "skip" && duplicateMode !== "replace") {
        return res.status(400).json({
          ok: false,
          error: "duplicate_mode must be skip or replace"
        });
      }

      const entries = readZipEntries(req.file.buffer);
      const manifest = getZipJsonManifest(entries, "sentence-export.json", "export-data");
      const sentences = Array.isArray(manifest.data.sentences) ? manifest.data.sentences : [];

      if (sentences.length === 0) {
        return res.status(400).json({
          ok: false,
          error: "Sentence export 沒有 sentences"
        });
      }

      const seenInZip = new Set();
      const candidates = [];
      let duplicateInZipCount = 0;

      for (const item of sentences) {
        const jp = String(item.jp || "").trim();
        const key = normalizeUniqueText(jp);

        if (!jp) {
          continue;
        }

        if (seenInZip.has(key)) {
          duplicateInZipCount += 1;
          continue;
        }

        seenInZip.add(key);
        candidates.push({
          start: Number.isFinite(Number(item.start)) ? Number(item.start) : null,
          end: Number.isFinite(Number(item.end)) ? Number(item.end) : null,
          jp,
          zh: String(item.zh || "").trim(),
          category: String(item.category || "").trim(),
          note: String(item.note || "").trim(),
          audio_path: String(item.audio_path || "").trim()
        });
      }

      const now = new Date().toISOString();
      let importedCount = 0;
      let skippedCount = duplicateInZipCount;
      let replacedCount = 0;

      const importSentences = db.transaction(() => {
        const insertSentence = db.prepare(`
          INSERT INTO sentence_items (
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
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `);

        const allExisting = db.prepare(`
          SELECT id, jp, audio_filename
          FROM sentence_items
        `).all();

        for (const [index, item] of candidates.entries()) {
          const key = normalizeUniqueText(item.jp);
          const matchingRows = allExisting.filter((row) => normalizeUniqueText(row.jp) === key);

          if (matchingRows.length > 0 && duplicateMode === "skip") {
            skippedCount += 1;
            continue;
          }

          if (matchingRows.length > 0 && duplicateMode === "replace") {
            for (const row of matchingRows) {
              if (row.audio_filename) {
                const audioPath = path.join(SENTENCE_AUDIO_DIR, path.basename(row.audio_filename));
                if (fs.existsSync(audioPath)) {
                  fs.unlinkSync(audioPath);
                }
              }

              db.prepare(`
                DELETE FROM sentence_items WHERE id = ?
              `).run(row.id);
              replacedCount += 1;
            }
          }

          let audioFilename = null;

          if (item.audio_path) {
            const audioEntry = resolveZipRelativeEntry(entries, manifest.baseDir, item.audio_path);

            if (!audioEntry) {
              throw new Error(`Sentence ZIP 缺少 audio：${item.audio_path}`);
            }

            const ext = path.extname(path.posix.basename(decodeURIComponent(item.audio_path))) || ".mp3";
            audioFilename = getUniqueFilename(
              SENTENCE_AUDIO_DIR,
              `imported_sentence_${Date.now()}_${index}${ext}`
            );

            fs.writeFileSync(path.join(SENTENCE_AUDIO_DIR, audioFilename), audioEntry.data);
          }

          insertSentence.run(
            null,
            null,
            "",
            audioFilename,
            item.start,
            item.end,
            item.jp,
            item.zh,
            item.category,
            item.note,
            now,
            now
          );

          importedCount += 1;
        }
      });

      importSentences();

      return res.json({
        ok: true,
        imported: importedCount,
        skipped: skippedCount,
        replaced: replacedCount,
        duplicate_mode: duplicateMode
      });
    } catch (error) {
      return res.status(400).json({
        ok: false,
        error: `匯入 sentence export 失敗：${error.message}`
      });
    }
  });
});

app.put("/api/sentences/:id", (req, res) => {
  try {
    const id = Number(req.params.id);
    const {
      jp = "",
      zh = "",
      category = "",
      note = ""
    } = req.body || {};

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "invalid sentence id"
      });
    }

    const existing = db.prepare(`
      SELECT * FROM sentence_items WHERE id = ?
    `).get(id);

    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: "sentence not found"
      });
    }

    const trimmedJp = String(jp || "").trim();
    if (!trimmedJp) {
      return res.status(400).json({
        ok: false,
        error: "jp required"
      });
    }

    const duplicate = findExistingSentenceByJp(trimmedJp, id);

    if (duplicate) {
      return res.status(400).json({
        ok: false,
        error: `Sentence Book 已有重複 sentence：${trimmedJp}`
      });
    }

    db.prepare(`
      UPDATE sentence_items
      SET
        jp = ?,
        zh = ?,
        category = ?,
        note = ?,
        updated_at = ?
      WHERE id = ?
    `).run(
      trimmedJp,
      String(zh || "").trim(),
      String(category || "").trim(),
      String(note || "").trim(),
      new Date().toISOString(),
      id
    );

    res.json({
      ok: true,
      id
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
});

app.delete("/api/sentences/:id", (req, res) => {
  try {
    const id = Number(req.params.id);

    if (!Number.isInteger(id) || id <= 0) {
      return res.status(400).json({
        ok: false,
        error: "invalid sentence id"
      });
    }

    const existing = db.prepare(`
      SELECT * FROM sentence_items WHERE id = ?
    `).get(id);

    if (!existing) {
      return res.status(404).json({
        ok: false,
        error: "sentence not found"
      });
    }

    if (existing.audio_filename) {
      const audioPath = path.join(SENTENCE_AUDIO_DIR, path.basename(existing.audio_filename));
      if (fs.existsSync(audioPath)) {
        fs.unlinkSync(audioPath);
      }
    }

    db.prepare(`
      DELETE FROM sentence_items WHERE id = ?
    `).run(id);
    
    res.json({
      ok: true,
      id
    });
  } catch (err) {
    res.status(500).json({
      ok: false,
      error: err.message
    });
  }
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
      const folder_id = req.body.folder_id
        ? Number(req.body.folder_id)
        : null;

      db.prepare(`
        INSERT INTO media_files (filename, display_name, folder_id, created_at)
        VALUES (?, ?, ?, ?)
      `).run(
        filename,
        filename,
        folder_id,
        new Date().toISOString()
      );

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

    const folder_id = req.body.folder_id
      ? Number(req.body.folder_id)
      : null;

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

      const duplicateSentence = findDuplicateSentence(clips);

      if (duplicateSentence) {
        fs.unlinkSync(uploadedPath);
        return res.status(400).json({
          ok: false,
          error: `Lesson JSON 內有重複 sentence：${duplicateSentence}`
        });
      }

      const now = new Date().toISOString();

      const insertLesson = db.prepare(`
        INSERT INTO lessons (title, media_filename, folder_id, created_at, updated_at)
        VALUES (?, ?, ?, ?, ?)
      `);
      
      const result = insertLesson.run(title, media || null, folder_id, now, now);
      const lessonId = result.lastInsertRowid;

      const insertClip = db.prepare(`
        INSERT INTO clips
        (lesson_id, start, end, jp, zh, category, sort_order)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `);

      const sortedClips = [...clips].sort(
        (a, b) => Number(a.start) - Number(b.start)
      );
      
      sortedClips.forEach((clip, i) => {
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

function startServer(port = 3000, host = "0.0.0.0") {
  return app.listen(port, host, () => {
    console.log(`server running on http://${host}:${port}`);
  });
}

if (require.main === module) {
  startServer();
}

module.exports = {
  app,
  startServer,
  zipDirectory
};
