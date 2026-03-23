const { contextBridge, ipcRenderer } = require('electron');

// 暴露安全的API给渲染进程
contextBridge.exposeInMainWorld('electronAPI', {
  showOpenDialog: (options) => ipcRenderer.invoke('show-open-dialog', options),
  showSaveDialog: (options) => ipcRenderer.invoke('show-save-dialog', options),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),
  readFile: (filePath) => ipcRenderer.invoke('read-file', filePath)
});
