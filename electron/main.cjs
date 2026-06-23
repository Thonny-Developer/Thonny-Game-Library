// Главный процесс Electron (CommonJS — самый надёжный способ подключить модуль
// electron). Библиотека из src/ написана на ESM, поэтому подключается через
// динамический import().

const { app, BrowserWindow, ipcMain, dialog, shell, clipboard } = require('electron');
const { join } = require('node:path');
const { writeFile } = require('node:fs/promises');
const { Store } = require('./store.cjs');
const { TorrentEngine } = require('./torrents.cjs');

let win = null;
let store = null;
let client = null;
let engine = null;
let currentUsername = null;

// Подгружаются динамически (ESM-библиотека).
let GameLibrary = null;
let pingMirrors = null;
let AuthError = null;

async function loadLibrary() {
  const lib = await import('../src/index.js');
  const mirrors = await import('../src/mirrors.js');
  const errors = await import('../src/errors.js');
  GameLibrary = lib.GameLibrary;
  pingMirrors = mirrors.pingMirrors;
  AuthError = errors.AuthError;
}

function createWindow() {
  win = new BrowserWindow({
    width: 1160,
    height: 760,
    minWidth: 900,
    minHeight: 560,
    backgroundColor: '#1a1613',
    title: 'Game Library',
    frame: false, // кастомный титлбар в стиле терминала
    autoHideMenuBar: true,
    webPreferences: {
      preload: join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  win.removeMenu();
  win.loadFile(join(__dirname, '..', 'renderer', 'index.html'));
}

function makeClient(username, password) {
  return new GameLibrary({
    username,
    password,
    autoSwitch: true,
    logger: (m) => win?.webContents.send('log', m),
  });
}

function accountInfo() {
  return {
    username: currentUsername,
    mirror: client?.activeMirror ?? null,
    authenticated: !!client?.isAuthenticated,
  };
}

function requireClient() {
  if (!client || !client.isAuthenticated) {
    throw new Error('Нет активной сессии — войдите заново');
  }
}

// Корень содержимого раздачи: если все файлы лежат в одной общей папке —
// открываем именно её, иначе — выбранную папку загрузки.
function contentRoot(snap) {
  const files = snap.files || [];
  if (!files.length) return snap.savePath;
  const tops = new Set(files.map((f) => String(f.path).split(/[\\/]/)[0]));
  if (tops.size === 1) {
    const [top] = tops;
    // у одиночного файла верхний сегмент — это сам файл, открываем папку
    if (files.length === 1 && files[0].path === top) return snap.savePath;
    return join(snap.savePath, top);
  }
  return snap.savePath;
}

function registerIpc() {
  // Старт приложения: пробуем войти по сохранённым кредам.
  ipcMain.handle('auth:bootstrap', async () => {
    const creds = store.getCredentials();
    if (!creds) return { state: 'need-login' };
    try {
      client = makeClient(creds.username, creds.password);
      await client.login();
      currentUsername = creds.username;
      store.setStat('lastMirror', client.activeMirror);
      store.setStat('lastLogin', new Date().toISOString());
      return { state: 'ready', account: accountInfo() };
    } catch (err) {
      if (err instanceof AuthError) {
        // Сохранённые креды больше не подходят — чистим и просим заново.
        store.clearCredentials();
        return { state: 'need-login', error: err.message };
      }
      // Сеть/зеркала недоступны — креды оставляем.
      return { state: 'error', error: err.message };
    }
  });

  ipcMain.handle('auth:login', async (_e, { username, password, remember }) => {
    try {
      client = makeClient(username, password);
      await client.login();
      currentUsername = username;
      if (remember) store.setCredentials(username, password);
      else store.clearCredentials();
      store.setSettings({ rememberLogin: !!remember, lastUsername: username });
      store.setStat('lastMirror', client.activeMirror);
      store.setStat('lastLogin', new Date().toISOString());
      return { ok: true, account: accountInfo() };
    } catch (err) {
      // Разделяем ошибку логина/пароля и сетевую — UI реагирует по-разному.
      if (err instanceof AuthError) {
        return { ok: false, code: 'auth', error: err.message };
      }
      return { ok: false, code: 'network', error: err.message };
    }
  });

  ipcMain.handle('auth:logout', async () => {
    store.clearCredentials();
    client = null;
    currentUsername = null;
    return { ok: true };
  });

  ipcMain.handle('account:info', () => accountInfo());

  ipcMain.handle('search', async (_e, { query, opts }) => {
    requireClient();
    const results = await client.search(query, opts || {});
    store.bumpStat('searches');
    store.setStat('lastMirror', client.activeMirror);
    return { results, mirror: client.activeMirror };
  });

  ipcMain.handle('topic:get', async (_e, id) => {
    requireClient();
    return client.getTopic(id);
  });

  ipcMain.handle('topic:magnet', async (_e, { id, title }) => {
    requireClient();
    const magnet = await client.getMagnet(id);
    clipboard.writeText(magnet);
    store.bumpStat('magnets');
    store.addLibrary({ topicId: id, title, type: 'magnet', magnet });
    return magnet;
  });

  ipcMain.handle('torrent:download', async (_e, { id, title }) => {
    requireClient();
    const safe = String(title || id)
      .replace(/[\\/:*?"<>|]+/g, '_')
      .slice(0, 120);
    const res = await dialog.showSaveDialog(win, {
      defaultPath: `${safe}.torrent`,
      filters: [{ name: 'Torrent', extensions: ['torrent'] }],
    });
    if (res.canceled || !res.filePath) return { canceled: true };
    const buf = await client.downloadTorrent(id);
    await writeFile(res.filePath, buf);
    store.bumpStat('downloads');
    store.addLibrary({ topicId: id, title, type: 'torrent', path: res.filePath, size: buf.length });
    return { path: res.filePath };
  });

  // --- Загрузки содержимого раздач (BitTorrent) ---

  // Скачать и сохранить в выбранную папку. Спрашиваем папку, тянем .torrent,
  // отдаём его движку. Возвращаем снимок состояния новой загрузки.
  ipcMain.handle('download:start', async (_e, { id, title }) => {
    requireClient();

    // Раздача из этой темы уже качается/скачана — не дублируем.
    const existing = store.getDownloads().find((d) => String(d.topicId) === String(id));
    const live = existing && engine.downloads.get(existing.id);
    if (live && (live.state === 'downloading' || live.state === 'done')) {
      return { already: true, snapshot: engine.snapshot(existing.id) };
    }

    const settings = store.getSettings();
    const res = await dialog.showOpenDialog(win, {
      title: 'Куда скачать',
      defaultPath: settings.downloadDir || app.getPath('downloads'),
      properties: ['openDirectory', 'createDirectory'],
      buttonLabel: 'Скачать сюда',
    });
    if (res.canceled || !res.filePaths?.length) return { canceled: true };
    const savePath = res.filePaths[0];
    store.setSettings({ downloadDir: savePath });

    const buf = await client.downloadTorrent(id);
    const dlId = `dl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const snap = await engine.start({
      id: dlId,
      topicId: id,
      title,
      savePath,
      torrentBuffer: buf,
    });
    store.bumpStat('torrents');
    store.upsertDownload(engine.persistable(dlId));
    return { snapshot: snap };
  });

  ipcMain.handle('download:list', () => engine.list());
  ipcMain.handle('download:pause', (_e, id) => engine.pause(id));
  ipcMain.handle('download:resume', (_e, id) => engine.resume(id));

  ipcMain.handle('download:remove', (_e, { id, deleteFiles }) => {
    engine.remove(id, { deleteFiles: !!deleteFiles });
    store.removeDownload(id);
    return { ok: true };
  });

  // Открыть папку с загрузкой в файловом менеджере.
  ipcMain.handle('download:openFolder', (_e, id) => {
    const snap = engine.snapshot(id);
    if (!snap) return { ok: false };
    shell.openPath(contentRoot(snap));
    return { ok: true };
  });

  // Открыть/запустить главный файл раздачи (например, установщик).
  ipcMain.handle('download:openFile', (_e, id) => {
    const snap = engine.snapshot(id);
    if (!snap || !snap.files?.length) return { ok: false };
    const biggest = snap.files.reduce((a, b) => (b.length > a.length ? b : a));
    shell.openPath(join(snap.savePath, biggest.path));
    return { ok: true };
  });

  ipcMain.handle('settings:get', () => store.getSettings());
  ipcMain.handle('settings:set', (_e, patch) => store.setSettings(patch));
  ipcMain.handle('stats:get', () => store.getStats());
  ipcMain.handle('library:list', () => store.getLibrary());
  ipcMain.handle('library:remove', (_e, { topicId, type }) => store.removeLibrary(topicId, type));
  ipcMain.handle('mirrors:ping', () => pingMirrors());
  ipcMain.handle('app:version', () => app.getVersion());
  ipcMain.handle('shell:open', (_e, url) => {
    if (/^https?:\/\//i.test(url)) shell.openExternal(url);
  });

  // Управление безрамочным окном.
  ipcMain.handle('win:minimize', () => win?.minimize());
  ipcMain.handle('win:maximize', () => {
    if (!win) return false;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
    return win.isMaximized();
  });
  ipcMain.handle('win:close', () => win?.close());
}

// Создаёт движок загрузок и связывает его события с persist + отправкой в UI.
function setupEngine() {
  engine = new TorrentEngine({ torrentDir: join(app.getPath('userData'), 'torrents') });
  engine.hydrate(store.getDownloads());

  engine.on('update', (snap) => {
    store.upsertDownload(engine.persistable(snap.id));
    win?.webContents.send('download:update', snap);
  });
  engine.on('tick', (list) => win?.webContents.send('download:tick', list));
  engine.on('done', (snap) => {
    store.upsertDownload(engine.persistable(snap.id));
    win?.webContents.send('download:done', snap);
  });
  engine.on('removed', (id) => win?.webContents.send('download:removed', id));
  engine.on('engine-error', (msg) => win?.webContents.send('log', `torrent: ${msg}`));
}

app.whenReady().then(async () => {
  await loadLibrary();
  store = new Store();
  setupEngine();
  registerIpc();
  createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Корректно гасим торрент-клиент перед выходом, чтобы освободить порты/сокеты.
app.on('before-quit', (e) => {
  if (engine && !engine._quitting) {
    engine._quitting = true;
    e.preventDefault();
    engine.destroy(() => app.quit());
  }
});
