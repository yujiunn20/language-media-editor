const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const { spawn } = require('node:child_process');
const http = require('node:http');


let mainWindow = null;
let serverProcess = null;

const mediaFolderPath = path.join(__dirname, 'media');
const lessonsFolderPath = path.join(__dirname, 'lessons');
const ffmpegPath = 'ffmpeg'; // 目前先吃環境變數
const whisperCliPath = path.join(__dirname, 'tools', 'whisper', 'whisper-cli.exe');
const whisperModelPath = path.join(__dirname, 'tools', 'whisper', 'models', 'ggml-base.bin');
const tempFolderPath = path.join(os.tmpdir(), 'language-media-editor-temp');

function ensureAppFolders() {
  if (!fs.existsSync(mediaFolderPath)) {
    fs.mkdirSync(mediaFolderPath, { recursive: true });
  }
  if (!fs.existsSync(lessonsFolderPath)) {
    fs.mkdirSync(lessonsFolderPath, { recursive: true });
  }
  if (!fs.existsSync(tempFolderPath)) {
    fs.mkdirSync(tempFolderPath, { recursive: true });
  }
}

function safeUnlink(filePath) {
  try {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
    }
  } catch (err) {
    console.warn('safeUnlink failed:', filePath, err);
  }
}

function runProcess(exePath, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(exePath, args, { windowsHide: true });

    let stdout = '';
    let stderr = '';

    child.stdout.on('data', (data) => {
      stdout += data.toString();
    });

    child.stderr.on('data', (data) => {
      stderr += data.toString();
    });

    child.on('error', (err) => {
      reject(err);
    });

    child.on('close', (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
      } else {
        reject(new Error(`Process failed with code ${code}\n${stderr || stdout}`));
      }
    });
  });
}

function parseWhisperText(output) {
  const lines = output.split(/\r?\n/);

  const textLines = lines
    .map(line => line.trim())
    .filter(line => /^\[\d{2}:\d{2}:\d{2}\.\d{3}\s+-->/.test(line))
    .map(line => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter(Boolean);

  return textLines.join(' ').trim();
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1200,
    height: 800,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false
    }
  });

  mainWindow.loadURL('http://127.0.0.1:3000');
}

function waitForServer(url, timeoutMs = 8000) {
  const startedAt = Date.now();

  return new Promise((resolve, reject) => {
    const check = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });

      req.on('error', () => {
        if (Date.now() - startedAt > timeoutMs) {
          reject(new Error(`Server did not start in time: ${url}`));
          return;
        }

        setTimeout(check, 250);
      });

      req.setTimeout(1000, () => {
        req.destroy();
      });
    };

    check();
  });
}

function startServer() {
  const nodePath = process.env.npm_node_execpath || 'node';

  serverProcess = spawn(nodePath, [path.join(__dirname, 'server', 'server.js')], {
    cwd: __dirname,
    stdio: 'inherit'
  });

  serverProcess.on('exit', () => {
    serverProcess = null;
  });
}

app.whenReady().then(async () => {
  ensureAppFolders();
  startServer();
  await waitForServer('http://127.0.0.1:3000');
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

app.on('before-quit', () => {
  if (serverProcess) {
    serverProcess.kill();
    serverProcess = null;
  }
});

ipcMain.handle('get-library-paths', async () => {
  return {
    mediaFolderPath,
    lessonsFolderPath
  };
});

ipcMain.handle('list-media-files', async () => {
  const files = fs.readdirSync(mediaFolderPath);
  return files.filter(name => /\.(mp3|mp4|wav|m4a|webm|ogg)$/i.test(name));
});

ipcMain.handle('list-lesson-files', async () => {
  const files = fs.readdirSync(lessonsFolderPath);
  return files.filter(name => /\.json$/i.test(name));
});

ipcMain.handle('read-lesson-file', async (_, filename) => {
  const fullPath = path.join(lessonsFolderPath, filename);
  const text = fs.readFileSync(fullPath, 'utf-8');
  return JSON.parse(text);
});

ipcMain.handle('get-media-path', async (_, filename) => {
  return path.join(mediaFolderPath, filename);
});

ipcMain.handle('save-lesson-file', async (_, lesson) => {
  const safeTitle = (lesson.title || 'Untitled Lesson')
    .replace(/[<>:"/\\|?*]+/g, '_')
    .trim();

  const filename = `${safeTitle}.json`;
  const fullPath = path.join(lessonsFolderPath, filename);

  fs.writeFileSync(fullPath, JSON.stringify(lesson, null, 2), 'utf-8');
  return fullPath;
});

// 匯入 media 檔到固定 media 資料夾
ipcMain.handle('import-media-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Media Files', extensions: ['mp3', 'mp4', 'wav', 'm4a', 'webm', 'ogg'] }
    ]
  });

  if (result.canceled || !result.filePaths[0]) return null;

  const sourcePath = result.filePaths[0];
  const filename = path.basename(sourcePath);
  const targetPath = path.join(mediaFolderPath, filename);

  fs.copyFileSync(sourcePath, targetPath);
  return filename;
});

// 匯入 lesson json 到固定 lessons 資料夾
ipcMain.handle('import-lesson-file', async () => {
  const result = await dialog.showOpenDialog(mainWindow, {
    properties: ['openFile'],
    filters: [
      { name: 'Lesson JSON', extensions: ['json'] }
    ]
  });

  if (result.canceled || !result.filePaths[0]) return null;

  const sourcePath = result.filePaths[0];
  const filename = path.basename(sourcePath);
  const targetPath = path.join(lessonsFolderPath, filename);

  fs.copyFileSync(sourcePath, targetPath);
  return filename;
});

ipcMain.handle('transcribe-clip', async (_, payload) => {
  const { mediaFilename, start, end, lang = 'ja' } = payload || {};

  if (!mediaFilename) {
    throw new Error('mediaFilename is required');
  }

  const startNum = Number(start);
  const endNum = Number(end);

  if (!Number.isFinite(startNum) || !Number.isFinite(endNum) || endNum <= startNum) {
    throw new Error('Invalid start/end time');
  }

  if (!fs.existsSync(whisperCliPath)) {
    throw new Error(`whisper-cli.exe not found: ${whisperCliPath}`);
  }

  if (!fs.existsSync(whisperModelPath)) {
    throw new Error(`Whisper model not found: ${whisperModelPath}`);
  }

  const mediaPath = path.join(mediaFolderPath, mediaFilename);

  if (!fs.existsSync(mediaPath)) {
    throw new Error(`Media file not found: ${mediaPath}`);
  }

  ensureAppFolders();

  const tempWavPath = path.join(
    tempFolderPath,
    `clip-${Date.now()}-${Math.random().toString(36).slice(2)}.wav`
  );

  try {
    // 1) ffmpeg 切 clip -> wav
    await runProcess(ffmpegPath, [
      '-y',
      '-i', mediaPath,
      '-ss', String(startNum),
      '-t', String(endNum - startNum),
      '-vn',
      '-ac', '1',
      '-ar', '16000',
      '-c:a', 'pcm_s16le',
      tempWavPath
    ]);

    // 2) whisper 辨識
    const whisperResult = await runProcess(whisperCliPath, [
      '-m', whisperModelPath,
      '-f', tempWavPath,
      '-l', lang
    ]);

    const transcript = parseWhisperText(
      `${whisperResult.stdout}\n${whisperResult.stderr}`
    );

    return {
      ok: true,
      text: transcript,
      tempWavPath
    };
  } finally {
    safeUnlink(tempWavPath);
  }
});
