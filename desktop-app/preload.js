/** Preload script: exposes safe Electron IPC bridge to the renderer process. */
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('electronAPI', {
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath)
});
