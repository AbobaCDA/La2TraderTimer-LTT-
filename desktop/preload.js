const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crafterApp', Object.freeze({
  loadCharacters: () => ipcRenderer.invoke('characters:load'),
  saveCharacters: (characters) => ipcRenderer.invoke('characters:save', characters),
  getStartupState: () => ipcRenderer.invoke('startup:get'),
  setStartup: (enabled) => ipcRenderer.invoke('startup:set', Boolean(enabled)),
  checkForUpdates: () => ipcRenderer.invoke('updates:check'),
  installUpdate: () => ipcRenderer.invoke('updates:install'),
  onUpdateStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('updates:status', listener);
    return () => ipcRenderer.removeListener('updates:status', listener);
  }
}));
