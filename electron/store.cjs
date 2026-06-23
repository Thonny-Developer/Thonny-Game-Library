// Постоянное хранилище приложения: настройки, статистика, библиотека и
// учётные данные. Пароль шифруется через safeStorage (ключница ОС); если
// шифрование недоступно — откатываемся на base64 (с пометкой), чтобы приложение
// не падало на системах без keyring.

const { app, safeStorage } = require('electron');
const { join } = require('node:path');
const {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} = require('node:fs');

const DEFAULT_SETTINGS = {
  theme: 'dark', // id темы оформления (см. THEMES в renderer/app.js)
  rememberLogin: true,
  lastUsername: '',
  downloadDir: '', // последняя выбранная папка для закачек (пусто = спросить заново)
};

const DEFAULT_STATS = {
  searches: 0,
  downloads: 0, // сохранено .torrent-файлов
  torrents: 0, // запущено закачек содержимого
  magnets: 0,
  firstRun: null,
  lastLogin: null,
  lastMirror: null,
};

class Store {
  constructor() {
    this.dir = app.getPath('userData');
    this.configPath = join(this.dir, 'config.json');
    this.credPath = join(this.dir, 'creds.bin');
    this.data = this._load();
  }

  _load() {
    try {
      const parsed = JSON.parse(readFileSync(this.configPath, 'utf8'));
      return {
        settings: { ...DEFAULT_SETTINGS, ...(parsed.settings || {}) },
        stats: { ...DEFAULT_STATS, ...(parsed.stats || {}) },
        library: Array.isArray(parsed.library) ? parsed.library : [],
        downloads: Array.isArray(parsed.downloads) ? parsed.downloads : [],
      };
    } catch {
      return {
        settings: { ...DEFAULT_SETTINGS },
        stats: { ...DEFAULT_STATS, firstRun: new Date().toISOString() },
        library: [],
        downloads: [],
      };
    }
  }

  _save() {
    try {
      if (!existsSync(this.dir)) mkdirSync(this.dir, { recursive: true });
      writeFileSync(this.configPath, JSON.stringify(this.data, null, 2));
    } catch {
      /* запись настроек не должна ронять приложение */
    }
  }

  // --- Настройки ---
  getSettings() {
    return { ...this.data.settings };
  }

  setSettings(patch) {
    this.data.settings = { ...this.data.settings, ...patch };
    this._save();
    return this.getSettings();
  }

  // --- Статистика ---
  getStats() {
    return { ...this.data.stats };
  }

  bumpStat(key, n = 1) {
    this.data.stats[key] = (this.data.stats[key] || 0) + n;
    this._save();
  }

  setStat(key, value) {
    this.data.stats[key] = value;
    this._save();
  }

  // --- Библиотека (скачанные .torrent и сохранённые magnet) ---
  getLibrary() {
    return [...this.data.library];
  }

  addLibrary(item) {
    this.data.library = this.data.library.filter(
      (x) => !(x.topicId === item.topicId && x.type === item.type)
    );
    this.data.library.unshift({ ...item, addedAt: new Date().toISOString() });
    this._save();
    return this.getLibrary();
  }

  removeLibrary(topicId, type) {
    this.data.library = this.data.library.filter(
      (x) => !(String(x.topicId) === String(topicId) && (!type || x.type === type))
    );
    this._save();
    return this.getLibrary();
  }

  // --- Загрузки (содержимое раздач через BitTorrent) ---
  getDownloads() {
    return [...this.data.downloads];
  }

  // Создаёт или обновляет запись по id (movePath/прогресс/статус и т.п.).
  upsertDownload(rec) {
    if (!rec || !rec.id) return;
    const idx = this.data.downloads.findIndex((x) => x.id === rec.id);
    if (idx >= 0) this.data.downloads[idx] = { ...this.data.downloads[idx], ...rec };
    else this.data.downloads.unshift(rec);
    this._save();
  }

  removeDownload(id) {
    this.data.downloads = this.data.downloads.filter((x) => x.id !== id);
    this._save();
    return this.getDownloads();
  }

  // --- Учётные данные ---
  setCredentials(username, password) {
    const payload = JSON.stringify({ username, password });
    let buf;
    if (safeStorage.isEncryptionAvailable()) {
      buf = safeStorage.encryptString(payload);
    } else {
      buf = Buffer.concat([
        Buffer.from('b64:'),
        Buffer.from(Buffer.from(payload).toString('base64')),
      ]);
    }
    writeFileSync(this.credPath, buf);
  }

  getCredentials() {
    try {
      if (!existsSync(this.credPath)) return null;
      const buf = readFileSync(this.credPath);
      let json;
      if (buf.subarray(0, 4).toString() === 'b64:') {
        json = Buffer.from(buf.subarray(4).toString(), 'base64').toString();
      } else {
        json = safeStorage.decryptString(buf);
      }
      return JSON.parse(json);
    } catch {
      return null;
    }
  }

  hasCredentials() {
    return existsSync(this.credPath);
  }

  clearCredentials() {
    try {
      if (existsSync(this.credPath)) unlinkSync(this.credPath);
    } catch {
      /* ignore */
    }
  }
}

module.exports = { Store };
