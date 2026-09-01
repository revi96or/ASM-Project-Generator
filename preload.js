/**
 * Описание: Безопасный мост между HTML-страницей и Electron.
 * Версия: 3.6.4
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
  openFile: (filePath) => ipcRenderer.invoke('asm:open-file', filePath),
  openHelpPdf: () => ipcRenderer.invoke('asm:open-help-pdf'),
  openGeneratedFilesHistory: (payload) => ipcRenderer.invoke('asm:open-generated-files-history', payload),
  getGeneratedFilesHistory: (payload) => ipcRenderer.invoke('asm:get-generated-files-history', payload),
  saveGeneratedFilesHistory: (payload) => ipcRenderer.invoke('asm:save-generated-files-history', payload),
  openGeneratedFilesHistoryFile: (payload) => ipcRenderer.invoke('asm:open-generated-files-history-file', payload),
  clearGeneratedFilesHistory: (payload) => ipcRenderer.invoke('asm:clear-generated-files-history', payload),
  updateGeneratedFilesHistoryTheme: (payload) => ipcRenderer.invoke('asm:update-generated-files-history-theme', payload),
  onGeneratedFilesHistoryThemeChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('asm:generated-files-history-theme-changed', listener);

    return () => {
      ipcRenderer.removeListener('asm:generated-files-history-theme-changed', listener);
    };
  },
  saveProjectJson: (payload) => ipcRenderer.invoke('asm:save-project-json', payload),
  saveProjectState: (payload) => ipcRenderer.invoke('asm:save-project-state', payload),
  saveAoiFile: (payload) => ipcRenderer.invoke('asm:save-aoi-file', payload),
  createAoiProjectFromTxt: (payload) => ipcRenderer.invoke('asm:create-aoi-project-from-txt', payload),
  loadPr1Project: (payload) => ipcRenderer.invoke('asm:load-pr1-project', payload),
  loadWorkspaceData: (folderPath) => ipcRenderer.invoke('asm:load-workspace-data', folderPath),
  generateProjectFiles: (payload) => ipcRenderer.invoke('asm:generate-project-files', payload),
  requestOperationCancel: () => ipcRenderer.invoke('asm:request-operation-cancel'),
  pnpImportCsv: (payload) => ipcRenderer.invoke('asm:pnp-import-csv', payload),
  pnpLoadDict: (payload) => ipcRenderer.invoke('asm:pnp-load-dict', payload),
  pnpExportFiles: (payload) => ipcRenderer.invoke('asm:pnp-export-files', payload),
  pnpShowStatsWindow: (payload) => ipcRenderer.invoke('asm:pnp-show-stats-window', payload),
  pnpToggleStatsWindow: (payload) => ipcRenderer.invoke('asm:pnp-toggle-stats-window', payload),
  pnpRefreshStatsWindow: (payload) => ipcRenderer.invoke('asm:pnp-refresh-stats-window', payload),
  pnpExportTxtFiles: (payload) => ipcRenderer.invoke('asm:pnp-export-txt-files', payload),
  pnpFillSetColumn: (payload) => ipcRenderer.invoke('asm:pnp-fill-set-column', payload),
  pnpSaveState: (payload) => ipcRenderer.invoke('asm:pnp-save-state', payload),
  pnpLoadState: (payload) => ipcRenderer.invoke('asm:pnp-load-state', payload),
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
