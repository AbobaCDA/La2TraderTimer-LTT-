const { app, BrowserWindow, ipcMain } = require('electron');
const { autoUpdater } = require('electron-updater');
const cloud = require('./cloud');
const fs = require('node:fs/promises');
const path = require('node:path');

const APP_DATA_FOLDER = 'ForgeCrafterManager';
const APP_ID = 'com.forge.craftermanager';
const gotSingleInstanceLock = app.requestSingleInstanceLock();

if (!gotSingleInstanceLock) {
  app.quit();
} else {
  // Keep user data in one stable location across portable and installed builds.
  try {
    app.setPath('userData', path.join(app.getPath('appData'), APP_DATA_FOLDER));
  } catch (_) {
    // Electron can still use its default profile path if the platform rejects this override.
  }
  app.setAppUserModelId(APP_ID);

  let mainWindow = null;
  let updateCheckPromise = null;
  let updateDownloaded = false;
  let characterSaveQueue = Promise.resolve();
  const charactersFile = () => path.join(app.getPath('userData'), 'characters.json');
  const offlineCharactersFile = () => path.join(app.getPath('userData'), 'characters-offline.json');
  const accountCharactersFile = (userId) => path.join(app.getPath('userData'), `characters-${String(userId).replace(/[^a-zA-Z0-9_-]/g, '')}.json`);
  const legacyOwnerFile = () => path.join(app.getPath('userData'), 'legacy-characters-owner.json');
  const supportsAutoUpdate = () => process.platform === 'win32' && app.isPackaged;

  function sendUpdateStatus(state, extra = {}) {
    if (!mainWindow || mainWindow.isDestroyed() || mainWindow.webContents.isDestroyed()) return;
    mainWindow.webContents.send('updates:status', { state, ...extra });
  }

  function updateErrorMessage(error) {
    const code = error && error.code;
    if (code === 'ERR_UPDATER_NO_PUBLISHED_VERSIONS') {
      return 'В GitHub пока нет опубликованных обновлений.';
    }
    return 'Не удалось проверить или скачать обновление. Попробуйте позже.';
  }

  async function checkForUpdates() {
    if (!supportsAutoUpdate()) {
      sendUpdateStatus('unsupported');
      return { supported: false };
    }
    if (updateCheckPromise) return updateCheckPromise;

    sendUpdateStatus('checking');
    updateCheckPromise = autoUpdater.checkForUpdates()
      .then(() => ({ supported: true }))
      .catch((error) => {
        sendUpdateStatus('error', { message: updateErrorMessage(error) });
        return { supported: true, error: true };
      })
      .finally(() => { updateCheckPromise = null; });
    return updateCheckPromise;
  }

  autoUpdater.autoDownload = true;
  autoUpdater.autoInstallOnAppQuit = true;
  autoUpdater.allowDowngrade = false;
  autoUpdater.on('checking-for-update', () => sendUpdateStatus('checking'));
  autoUpdater.on('update-available', (info) => {
    sendUpdateStatus('available', { version: info && info.version ? info.version : '' });
  });
  autoUpdater.on('update-not-available', (info) => {
    sendUpdateStatus('up-to-date', { version: info && info.version ? info.version : '' });
  });
  autoUpdater.on('download-progress', (progress) => {
    sendUpdateStatus('downloading', {
      percent: Number.isFinite(progress && progress.percent) ? Math.round(progress.percent) : 0
    });
  });
  autoUpdater.on('update-downloaded', (info) => {
    updateDownloaded = true;
    sendUpdateStatus('downloaded', { version: info && info.version ? info.version : '' });
  });
  autoUpdater.on('error', (error) => {
    sendUpdateStatus('error', { message: updateErrorMessage(error) });
  });

  function cleanCharacters(records) {
    if (!Array.isArray(records)) throw new TypeError('Ожидался список персонажей');
    return records.slice(0, 2000).flatMap((item) => {
      if (!item || typeof item.id !== 'string' || typeof item.name !== 'string') return [];
      const name = item.name.trim().slice(0, 32);
      if (!item.id || !name) return [];
      const startedAt = Number.isFinite(item.startedAt) ? item.startedAt : null;
      const endAt = Number.isFinite(item.endAt) ? item.endAt : null;
      const shiftHours = item.shiftHours === 12 || item.shiftHours === 24 ? item.shiftHours : null;
      return [{
        id: item.id.slice(0, 100),
        name,
        license: Boolean(item.license),
        startedAt,
        endAt,
        shiftHours
      }];
    });
  }

  async function readCharactersFile(file) {
    try {
      return cleanCharacters(JSON.parse(await fs.readFile(file, 'utf8')));
    } catch (error) {
      if (error && error.code === 'ENOENT') return null;
      throw error;
    }
  }

  async function readLegacyOwner() {
    try { return JSON.parse(await fs.readFile(legacyOwnerFile(), 'utf8')); }
    catch (error) { if (error && error.code === 'ENOENT') return null; throw error; }
  }

  async function writeLegacyOwner(userId) {
    const file = legacyOwnerFile();
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify({ userId, claimedAt: new Date().toISOString() }), 'utf8');
    await fs.rename(tempFile, file);
  }

  async function writeCharactersFile(file, characters) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tempFile = `${file}.${process.pid}.tmp`;
    await fs.writeFile(tempFile, JSON.stringify(characters, null, 2), 'utf8');
    await fs.rename(tempFile, file);
  }

  ipcMain.handle('characters:load', async () => {
    const state = await cloud.getLocalState();
    if (!state || !state.signedIn) {
      const legacyOwner = await readLegacyOwner();
      if (legacyOwner && legacyOwner.userId) return (await readCharactersFile(offlineCharactersFile())) || [];
      return readCharactersFile(charactersFile());
    }

    if (!state.userId) return [];
    const accountFile = accountCharactersFile(state.userId);
    const accountCharacters = await readCharactersFile(accountFile);

    if (state.profileReady && state.accessStatus === 'active' && state.role === 'owner') {
      const legacyOwner = await readLegacyOwner();
      if (!legacyOwner) {
        await writeLegacyOwner(state.userId);
        const legacyCharacters = (await readCharactersFile(charactersFile())) || [];
        if (!accountCharacters) return legacyCharacters;
        const combined = new Map(legacyCharacters.map((item) => [item.id, item]));
        for (const item of accountCharacters) combined.set(item.id, item);
        return [...combined.values()];
      }
      if (legacyOwner.userId === state.userId && !accountCharacters) {
        return (await readCharactersFile(charactersFile())) || [];
      }
    }
    return accountCharacters || [];
  });

  ipcMain.handle('characters:save', (_event, records) => {
    const characters = cleanCharacters(records);
    const operation = characterSaveQueue.then(async () => {
      const state = await cloud.getLocalState();
      let file = charactersFile();
      if (state && state.signedIn && state.userId) {
        file = accountCharactersFile(state.userId);
      } else {
        const legacyOwner = await readLegacyOwner();
        if (legacyOwner && legacyOwner.userId) file = offlineCharactersFile();
      }
      await writeCharactersFile(file, characters);
      return { saved: true };
    });
    characterSaveQueue = operation.catch(() => {});
    return operation;
  });

  ipcMain.handle('cloud:get-state', () => cloud.getState());
  ipcMain.handle('cloud:sign-up', (_event, email, password) => cloud.signUp(email, password));
  ipcMain.handle('cloud:sign-in', (_event, email, password) => cloud.signIn(email, password));
  ipcMain.handle('cloud:sign-out', async () => {
    await characterSaveQueue;
    return cloud.signOut();
  });
  ipcMain.handle('cloud:load-characters', () => cloud.loadCloudCharacters());
  ipcMain.handle('cloud:save-characters', (_event, records) => cloud.saveCharacters(records));
  ipcMain.handle('cloud:merge-local-characters', (_event, records) => cloud.mergeLocalCharacters(records));
  ipcMain.handle('cloud:link-telegram', (_event, code) => cloud.linkTelegram(code));

  function startupExecutablePath() {
    // NSIS portable runs the real app from a temporary folder; register its stable launcher instead.
    return process.env.PORTABLE_EXECUTABLE_FILE || process.execPath;
  }

  function startupState() {
    if (process.platform !== 'win32') {
      return { supported: false, enabled: false, reason: 'Автозапуск доступен только в Windows' };
    }
    if (!app.isPackaged) {
      return { supported: false, enabled: false, reason: 'Доступно после сборки Windows-приложения' };
    }
    const state = app.getLoginItemSettings({ path: startupExecutablePath(), args: [] });
    return { supported: true, enabled: Boolean(state.openAtLogin) };
  }

  ipcMain.handle('startup:get', () => startupState());
  ipcMain.handle('startup:set', (_event, enabled) => {
    if (process.platform !== 'win32' || !app.isPackaged) return startupState();
    app.setLoginItemSettings({
      openAtLogin: Boolean(enabled),
      path: startupExecutablePath(),
      args: [],
      name: APP_ID
    });
    return startupState();
  });

  ipcMain.handle('updates:check', () => checkForUpdates());
  ipcMain.handle('updates:install', () => {
    if (!supportsAutoUpdate() || !updateDownloaded) return { ok: false };
    autoUpdater.quitAndInstall();
    return { ok: true };
  });

  function createWindow() {
    mainWindow = new BrowserWindow({
      width: 1240,
      height: 920,
      minWidth: 780,
      minHeight: 680,
      show: false,
      backgroundColor: '#0b1112',
      title: 'Forge — менеджер крафтеров',
      autoHideMenuBar: true,
      icon: path.join(__dirname, '..', 'assets', 'icon.ico'),
      webPreferences: {
        preload: path.join(__dirname, 'preload.js'),
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        devTools: !app.isPackaged
      }
    });

    mainWindow.once('ready-to-show', () => mainWindow && mainWindow.show());
    mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));
    mainWindow.webContents.on('will-navigate', (event, url) => {
      if (!url.startsWith('file://')) event.preventDefault();
    });
    mainWindow.on('closed', () => { mainWindow = null; });
    mainWindow.webContents.once('did-finish-load', () => {
      if (supportsAutoUpdate()) {
        setTimeout(() => { checkForUpdates(); }, 1600);
      } else {
        sendUpdateStatus('unsupported');
      }
    });
    mainWindow.loadFile(path.join(__dirname, '..', 'crafter-management.html'));
  }

  app.whenReady().then(() => {
    cloud.initialize();
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('second-instance', () => {
    if (!mainWindow) return;
    if (mainWindow.isMinimized()) mainWindow.restore();
    mainWindow.show();
    mainWindow.focus();
  });

  app.on('window-all-closed', () => {
    if (process.platform !== 'darwin') app.quit();
  });
}
