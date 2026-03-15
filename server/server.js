const express = require("express");
const fs = require("fs");
const path = require("path");

const app = express();

app.use(express.json());

const DATA_DIR = path.join(__dirname, "..", "data");
const MEDIA_DIR = path.join(DATA_DIR, "media");
const LESSONS_DIR = path.join(DATA_DIR, "lessons");
const SRC_DIR = path.join(__dirname, "..", "src");

const { execFile } = require("child_process");
const FFMPEG_PATH = process.env.FFMPEG_PATH || "ffmpeg";
const WHISPER_PATH = path.join(__dirname, "..", "tools", "whisper", "whisper-cli.exe");

function cleanWhisperText(raw = "") {
  return raw
    .replace(/\[[^\]]+\]\s*/g, "")
    .trim();
}

app.use(express.static(SRC_DIR));

app.get("/api/media", (req, res) => {
  try {
    const files = fs.readdirSync(MEDIA_DIR);

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
  const filename = req.params.filename;
  const filePath = path.join(MEDIA_DIR, filename);

  if (!fs.existsSync(filePath)) {
    return res.status(404).send("File not found");
  }

  const stat = fs.statSync(filePath);
  const fileSize = stat.size;
  const range = req.headers.range;

  if (!range) {
    res.writeHead(200, {
      "Content-Length": fileSize,
      "Content-Type": "video/mp4",
    });
    fs.createReadStream(filePath).pipe(res);
    return;
  }

  const parts = range.replace(/bytes=/, "").split("-");
  const start = parseInt(parts[0], 10);
  const end = parts[1] ? parseInt(parts[1], 10) : fileSize - 1;

  const chunkSize = end - start + 1;

  const stream = fs.createReadStream(filePath, { start, end });

  res.writeHead(206, {
    "Content-Range": `bytes ${start}-${end}/${fileSize}`,
    "Accept-Ranges": "bytes",
    "Content-Length": chunkSize,
    "Content-Type": "video/mp4",
  });

  stream.pipe(res);
});

app.get("/api/lessons", (req, res) => {
  try {
    const files = fs.readdirSync(LESSONS_DIR);

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
    const filename = req.params.filename;
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

    const safeTitle = lesson.title.replace(/[\\/:*?"<>|]/g, "_").trim();
    const filename = `${safeTitle}.json`;
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

  const mediaPath = path.join(MEDIA_DIR, mediaFilename);

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
          "-m", path.join(__dirname, "..", "tools", "whisper", "models", "ggml-base.bin"),
          "-otxt"
        ],      
        { cwd: path.join(__dirname, "..", "tools", "whisper") },
        (whisperErr, stdout, stderr) => {
          try {
            const txtPath = path.join(
              path.dirname(tempWavPath),
              path.basename(tempWavPath, ".wav") + ".txt"
            );
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

app.listen(3000, () => {
  console.log("server running on http://localhost:3000");
});