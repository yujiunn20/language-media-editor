const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('electronAPI', {
  getLibraryPaths: () => ipcRenderer.invoke('get-library-paths'),
  listMediaFiles: () => ipcRenderer.invoke('list-media-files'),
  listLessonFiles: () => ipcRenderer.invoke('list-lesson-files'),
  readLessonFile: (filename) => ipcRenderer.invoke('read-lesson-file', filename),
  getMediaPath: (filename) => ipcRenderer.invoke('get-media-path', filename),
  saveLessonFile: (lesson) => ipcRenderer.invoke('save-lesson-file', lesson),
  importMediaFile: () => ipcRenderer.invoke('import-media-file'),
  importLessonFile: () => ipcRenderer.invoke('import-lesson-file')
});