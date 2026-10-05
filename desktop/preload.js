const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('crafterApp', Object.freeze({
  loadCharacters: () => ipcRenderer.invoke('characters:load'),
  saveCharacters: (characters) => ipcRenderer.invoke('characters:save', characters),
  getCloudState: () => ipcRenderer.invoke('cloud:get-state'),
  cloudSignUp: (email, password) => ipcRenderer.invoke('cloud:sign-up', email, password),
  cloudSignIn: (email, password) => ipcRenderer.invoke('cloud:sign-in', email, password),
  cloudSignOut: () => ipcRenderer.invoke('cloud:sign-out'),
  loadCloudCharacters: () => ipcRenderer.invoke('cloud:load-characters'),
  saveCloudCharacters: (characters) => ipcRenderer.invoke('cloud:save-characters', characters),
  mergeLocalCharacters: (characters) => ipcRenderer.invoke('cloud:merge-local-characters', characters),
  linkTelegram: (code) => ipcRenderer.invoke('cloud:link-telegram', code),
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
