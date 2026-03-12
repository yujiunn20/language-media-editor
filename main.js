const { app, BrowserWindow, ipcMain, dialog } = require('electron');
const path = require('node:path');
const fs = require('node:fs');

let mainWindow = null;

const mediaFolderPath = path.join(__dirname, 'media');
const lessonsFolderPath = path.join(__dirname, 'lessons');

function ensureAppFolders() {
  if (!fs.existsSync(mediaFolderPath)) {
    fs.mkdirSync(mediaFolderPath, { recursive: true });
  }
  if (!fs.existsSync(lessonsFolderPath)) {
    fs.mkdirSync(lessonsFolderPath, { recursive: true });
  }
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

  mainWindow.loadFile(path.join(__dirname, 'src', 'index.html'));
}

app.whenReady().then(() => {
  ensureAppFolders();
  createWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
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