// Торрент-движок: оборачивает WebTorrent и раздаёт наружу простые операции
// (start / pause / resume / remove) и снимки прогресса. WebTorrent v3 — ESM,
// поэтому клиент создаётся лениво через динамический import().
//
// Каждая загрузка хранится как «запись» (rec) с метаданными темы и ссылкой на
// живой объект torrent. Для возобновления после перезапуска приложения .torrent
// сохраняется на диск (userData/torrents/<id>.torrent) — клиент WebTorrent живёт
// только в памяти сессии, после рестарта раздачу нужно добавить заново.

const { EventEmitter } = require('node:events');
const { join } = require('node:path');
const { mkdirSync, writeFileSync, readFileSync, existsSync, unlinkSync } = require('node:fs');

class TorrentEngine extends EventEmitter {
  /** @param {{ torrentDir: string }} opts */
  constructor({ torrentDir }) {
    super();
    this.torrentDir = torrentDir; // куда складываем .torrent для возобновления
    this.client = null; // экземпляр WebTorrent (создаётся при первой загрузке)
    this.downloads = new Map(); // id -> rec
    this._ticker = null;
    try {
      mkdirSync(this.torrentDir, { recursive: true });
    } catch {
      /* каталог может уже существовать */
    }
  }

  async _ensureClient() {
    if (this.client) return this.client;
    const { default: WebTorrent } = await import('webtorrent');
    this.client = new WebTorrent();
    // Ошибки уровня клиента (а не отдельной раздачи) — наружу как событие.
    this.client.on('error', (err) => this.emit('engine-error', err?.message || String(err)));
    return this.client;
  }

  _torrentPath(id) {
    return join(this.torrentDir, `${id}.torrent`);
  }

  /**
   * Восстанавливает список загрузок из persisted-записей store без запуска
   * сети. Незавершённые помечаются 'paused' — пользователь сам решит, качать ли.
   */
  hydrate(records = []) {
    for (const r of records) {
      const rec = {
        ...r,
        state: r.state === 'done' ? 'done' : 'paused',
        downloadSpeed: 0,
        uploadSpeed: 0,
        peers: 0,
        timeRemaining: 0,
        torrent: null,
        error: null,
      };
      this.downloads.set(rec.id, rec);
    }
  }

  /**
   * Запускает новую загрузку.
   * @param {{id:string, topicId:(string|number), title:string, savePath:string, torrentBuffer:Buffer}} p
   */
  async start({ id, topicId, title, savePath, torrentBuffer }) {
    await this._ensureClient();
    try {
      writeFileSync(this._torrentPath(id), torrentBuffer);
    } catch {
      /* без сохранённого .torrent просто не будет возобновления после рестарта */
    }
    const rec = {
      id,
      topicId,
      title,
      savePath,
      infoHash: null,
      length: 0,
      downloaded: 0,
      progress: 0,
      downloadSpeed: 0,
      uploadSpeed: 0,
      peers: 0,
      timeRemaining: 0,
      state: 'downloading',
      error: null,
      files: [],
      addedAt: new Date().toISOString(),
      completedAt: null,
      torrent: null,
    };
    this.downloads.set(id, rec);
    this._attach(rec, torrentBuffer);
    this._startTicker();
    return this.snapshot(id);
  }

  /** Возобновляет приостановленную/после-рестартовую загрузку. */
  async resume(id) {
    const rec = this.downloads.get(id);
    if (!rec) return null;
    if (rec.state === 'done') return this.snapshot(id);

    // Раздача ещё жива в клиенте — просто снимаем паузу.
    if (rec.torrent && !rec.torrent.destroyed) {
      rec.torrent.resume();
      rec.state = 'downloading';
      this._startTicker();
      this._emitUpdate(rec);
      return this.snapshot(id);
    }

    // После рестарта объекта нет — добавляем заново из сохранённого .torrent.
    const tfile = this._torrentPath(id);
    if (!existsSync(tfile)) {
      rec.state = 'error';
      rec.error = 'Файл .torrent не найден — возобновление невозможно';
      this._emitUpdate(rec);
      return this.snapshot(id);
    }
    await this._ensureClient();
    rec.state = 'downloading';
    rec.error = null;
    this._attach(rec, readFileSync(tfile));
    this._startTicker();
    this._emitUpdate(rec);
    return this.snapshot(id);
  }

  pause(id) {
    const rec = this.downloads.get(id);
    if (!rec || rec.state === 'done') return this.snapshot(id);
    if (rec.torrent && !rec.torrent.destroyed) rec.torrent.pause();
    rec.state = 'paused';
    rec.downloadSpeed = 0;
    rec.uploadSpeed = 0;
    this._emitUpdate(rec);
    return this.snapshot(id);
  }

  /** Удаляет загрузку. deleteFiles — снести и скачанные данные с диска. */
  remove(id, { deleteFiles = false } = {}) {
    const rec = this.downloads.get(id);
    if (!rec) return false;
    if (rec.torrent && !rec.torrent.destroyed) {
      try {
        rec.torrent.destroy({ destroyStore: deleteFiles });
      } catch {
        /* раздача уже разрушена */
      }
    }
    try {
      const tfile = this._torrentPath(id);
      if (existsSync(tfile)) unlinkSync(tfile);
    } catch {
      /* ignore */
    }
    this.downloads.delete(id);
    if (![...this.downloads.values()].some((r) => r.state === 'downloading')) {
      this._stopTicker();
    }
    this.emit('removed', id);
    return true;
  }

  // Подписывает запись на события объекта torrent.
  _attach(rec, source) {
    const torrent = this.client.add(source, { path: rec.savePath });
    rec.torrent = torrent;

    const refreshMeta = () => {
      rec.infoHash = torrent.infoHash || rec.infoHash;
      rec.length = torrent.length || rec.length;
      rec.files = (torrent.files || []).map((f) => ({
        name: f.name,
        path: f.path, // относительный путь внутри savePath
        length: f.length,
      }));
    };

    torrent.on('infoHash', () => {
      rec.infoHash = torrent.infoHash;
    });
    torrent.on('metadata', () => {
      refreshMeta();
      this._emitUpdate(rec);
    });
    torrent.on('ready', () => {
      refreshMeta();
      this._emitUpdate(rec);
    });
    torrent.on('done', () => {
      refreshMeta();
      rec.state = 'done';
      rec.progress = 1;
      rec.downloaded = rec.length;
      rec.downloadSpeed = 0;
      rec.completedAt = new Date().toISOString();
      this.emit('done', this.snapshot(rec.id));
      this._emitUpdate(rec);
      if (![...this.downloads.values()].some((r) => r.state === 'downloading')) {
        this._stopTicker();
      }
    });
    torrent.on('error', (err) => {
      rec.state = 'error';
      rec.error = err?.message || String(err);
      rec.downloadSpeed = 0;
      this._emitUpdate(rec);
    });
  }

  // Раз в секунду шлём снимки активных раздач — для живого прогресс-бара.
  _startTicker() {
    if (this._ticker) return;
    this._ticker = setInterval(() => {
      const active = [...this.downloads.values()].filter((r) => r.state === 'downloading');
      if (!active.length) {
        this._stopTicker();
        return;
      }
      this.emit(
        'tick',
        active.map((r) => this.snapshot(r.id))
      );
    }, 1000);
    if (this._ticker.unref) this._ticker.unref();
  }

  _stopTicker() {
    if (this._ticker) {
      clearInterval(this._ticker);
      this._ticker = null;
    }
  }

  _emitUpdate(rec) {
    this.emit('update', this.snapshot(rec.id));
  }

  /** Сериализуемый снимок состояния загрузки (без живого объекта torrent). */
  snapshot(id) {
    const rec = this.downloads.get(id);
    if (!rec) return null;
    const t = rec.torrent && !rec.torrent.destroyed ? rec.torrent : null;
    const length = t ? t.length : rec.length;
    const downloaded = rec.state === 'done' ? length : t ? t.downloaded : rec.downloaded;
    return {
      id: rec.id,
      topicId: rec.topicId,
      title: rec.title,
      savePath: rec.savePath,
      infoHash: rec.infoHash,
      state: rec.state,
      error: rec.error,
      length,
      downloaded,
      progress: rec.state === 'done' ? 1 : t ? t.progress : rec.progress || 0,
      downloadSpeed: rec.state === 'downloading' && t ? t.downloadSpeed : 0,
      uploadSpeed: rec.state === 'downloading' && t ? t.uploadSpeed : 0,
      peers: t ? t.numPeers : 0,
      timeRemaining: rec.state === 'downloading' && t ? t.timeRemaining : 0,
      files: rec.files,
      addedAt: rec.addedAt,
      completedAt: rec.completedAt,
    };
  }

  /** Снимки всех загрузок (для первичного рендера списка). */
  list() {
    return [...this.downloads.keys()].map((id) => this.snapshot(id));
  }

  /** Облегчённая запись для сохранения в store (без скоростей/объекта). */
  persistable(id) {
    const s = this.snapshot(id);
    if (!s) return null;
    return {
      id: s.id,
      topicId: s.topicId,
      title: s.title,
      savePath: s.savePath,
      infoHash: s.infoHash,
      length: s.length,
      downloaded: s.downloaded,
      progress: s.progress,
      state: s.state === 'downloading' ? 'paused' : s.state, // в покое = пауза
      files: s.files,
      addedAt: s.addedAt,
      completedAt: s.completedAt,
    };
  }

  destroy(cb) {
    this._stopTicker();
    if (this.client) this.client.destroy(cb);
    else if (cb) cb();
  }
}

module.exports = { TorrentEngine };
