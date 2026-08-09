/**
 * Описание: Безопасный мост между HTML-страницей и Electron.
 * Версия: 2.7.2
 * Автор: Новожилов Артем
 */

const { contextBridge, ipcRenderer } = require('electron');

// В интерфейс отдаем только нужные действия, чтобы работа с файлами шла через главный процесс.
contextBridge.exposeInMainWorld('asmApi', {
  ping: () => 'pong',
  getAppMeta: () => ipcRenderer.invoke('asm:get-app-meta'),
  getUserSettings: () => ipcRenderer.invoke('asm:get-user-settings'),
  saveUserSettings: (payload) => ipcRenderer.invoke('asm:save-user-settings', payload),
  inspectFolder: (folderPath) => ipcRenderer.invoke('asm:inspect-folder', folderPath),
  checkFolderWritable: (folderPath) => ipcRenderer.invoke('asm:check-folder-writable', folderPath),
  openFolder: (folderPath) => ipcRenderer.invoke('asm:open-folder', folderPath),
  saveProjectJson: (payload) => ipcRenderer.invoke('asm:save-project-json', payload),
  saveProjectState: (payload) => ipcRenderer.invoke('asm:save-project-state', payload),
  saveAoiFile: (payload) => ipcRenderer.invoke('asm:save-aoi-file', payload),
  createAoiProjectFromTxt: (payload) => ipcRenderer.invoke('asm:create-aoi-project-from-txt', payload),
  loadPr1Project: (payload) => ipcRenderer.invoke('asm:load-pr1-project', payload),
  loadWorkspaceData: (folderPath) => ipcRenderer.invoke('asm:load-workspace-data', folderPath),
  generateProjectFiles: (payload) => ipcRenderer.invoke('asm:generate-project-files', payload),
  checkForUpdates: (payload) => ipcRenderer.invoke('asm:check-for-updates', payload),
  downloadUpdate: () => ipcRenderer.invoke('asm:download-update'),
  installUpdate: () => ipcRenderer.invoke('asm:install-update'),
  onUpdateEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('asm:update-event', listener);

    return () => {
      ipcRenderer.removeListener('asm:update-event', listener);
    };
  }
});
