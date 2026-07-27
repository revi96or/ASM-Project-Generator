/**
 * Описание: Безопасный мост между HTML-страницей и Electron.
 * Версия: 2.0.1
 * Автор: Новожилов Артем
 */

const { contextBridge, ipcRenderer } = require('electron');

// В интерфейс отдаем только нужные действия, чтобы работа с файлами шла через главный процесс.
contextBridge.exposeInMainWorld('asmApi', {
  ping: () => 'pong',
  getAppMeta: () => ipcRenderer.invoke('asm:get-app-meta'),
  inspectFolder: (folderPath) => ipcRenderer.invoke('asm:inspect-folder', folderPath),
  checkFolderWritable: (folderPath) => ipcRenderer.invoke('asm:check-folder-writable', folderPath),
  openFolder: (folderPath) => ipcRenderer.invoke('asm:open-folder', folderPath),
  saveProjectJson: (payload) => ipcRenderer.invoke('asm:save-project-json', payload),
  saveAoiFile: (payload) => ipcRenderer.invoke('asm:save-aoi-file', payload),
  loadWorkspaceData: (folderPath) => ipcRenderer.invoke('asm:load-workspace-data', folderPath),
  generateProjectFiles: (payload) => ipcRenderer.invoke('asm:generate-project-files', payload)
});
