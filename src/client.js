import { CookieJar } from './cookieJar.js';
import { DEFAULT_MIRRORS } from './mirrors.js';
import { decodeWin1251, encodeForm } from './encoding.js';
import {
  parseSearchResults,
  parseTopic,
  isLoggedIn,
  detectCaptcha,
  detectLoginError,
} from './parser.js';
import {
  RutrackerError,
  AuthError,
  NotAuthenticated,
  AllMirrorsDown,
} from './errors.js';

const DEFAULT_USER_AGENT =
  'Mozilla/5.0 (X11; Linux x86_64; rv:128.0) Gecko/20100101 Firefox/128.0';

/**
 * Клиент RuTracker: авторизация, поиск, получение magnet/.torrent.
 * При недоступности активного зеркала прозрачно переключается на следующее
 * и при необходимости заново выполняет вход.
 */
export class RutrackerClient {
  /**
   * @param {object} [opts]
   * @param {string} [opts.username]
   * @param {string} [opts.password]
   * @param {string[]} [opts.mirrors] — список зеркал в порядке приоритета.
   * @param {boolean} [opts.autoSwitch=true] — переключаться на зеркала при сбое.
   * @param {number} [opts.timeout=15000] — таймаут запроса, мс.
   * @param {string} [opts.userAgent]
   * @param {(msg: string) => void} [opts.logger] — куда писать диагностику.
   */
  constructor(opts = {}) {
    this.username = opts.username ?? process.env.RUTRACKER_USERNAME ?? null;
    this.password = opts.password ?? process.env.RUTRACKER_PASSWORD ?? null;
    this.mirrors = (opts.mirrors ?? DEFAULT_MIRRORS).slice();
    this.autoSwitch = opts.autoSwitch ?? true;
    this.timeout = opts.timeout ?? 15000;
    this.userAgent = opts.userAgent ?? DEFAULT_USER_AGENT;
    this.logger = opts.logger ?? (() => {});

    this.jar = new CookieJar();
    this.activeIndex = 0;
    this._authenticated = false;
    this._credentials = null;
  }

  get activeMirror() {
    return this.mirrors[this.activeIndex];
  }

  get isAuthenticated() {
    return this._authenticated;
  }

  _log(msg) {
    try {
      this.logger(msg);
    } catch {
      /* логгер не должен ронять клиент */
    }
  }

  // Зеркала, начиная с текущего активного (для перебора при логине).
  _mirrorOrder() {
    return [
      ...this.mirrors.slice(this.activeIndex),
      ...this.mirrors.slice(0, this.activeIndex),
    ];
  }

  /**
   * Один сетевой запрос к конкретному зеркалу. Сам обрабатывает cookie и
   * редиректы (встроенный fetch не переносит cookie между хопами).
   * Бросает исключение при сетевой ошибке/таймауте.
   */
  async _fetchOnce(base, path, { method = 'GET', body = null, headers = {}, raw = false } = {}) {
    let url = path.startsWith('http') ? path : base + path;
    let curMethod = method;
    let curBody = body;
    const reqHeaders = {
      'User-Agent': this.userAgent,
      Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'ru,en;q=0.8',
      ...headers,
    };

    for (let hop = 0; hop < 10; hop++) {
      const cookie = this.jar.header();
      if (cookie) reqHeaders.Cookie = cookie;
      else delete reqHeaders.Cookie;

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), this.timeout);
      let res;
      try {
        res = await fetch(url, {
          method: curMethod,
          body: curBody,
          headers: reqHeaders,
          redirect: 'manual',
          signal: controller.signal,
        });
      } finally {
        clearTimeout(timer);
      }

      const setCookies = res.headers.getSetCookie?.() ?? [];
      if (setCookies.length) this.jar.setFromHeaders(setCookies);

      // Ручное следование редиректам — переносим cookie, переключаемся на GET.
      if (res.status >= 300 && res.status < 400 && res.headers.get('location')) {
        url = new URL(res.headers.get('location'), url).toString();
        curMethod = 'GET';
        curBody = null;
        delete reqHeaders['Content-Type'];
        continue;
      }

      const buffer = Buffer.from(await res.arrayBuffer());
      return {
        status: res.status,
        contentType: res.headers.get('content-type') || '',
        buffer,
        finalUrl: url,
        html: raw ? null : decodeWin1251(buffer),
      };
    }
    throw new RutrackerError('Слишком много редиректов');
  }

  /**
   * Запрос с перебором зеркал. При сбое активного зеркала переключается на
   * следующее и (если есть учётка) повторно логинится перед ретраем.
   */
  async _request(path, opts = {}) {
    const maxAttempts = this.autoSwitch ? this.mirrors.length : 1;
    let lastErr;

    for (let attempt = 0; attempt < maxAttempts; attempt++) {
      const base = this.activeMirror;
      try {
        const res = await this._fetchOnce(base, path, opts);
        if (res.status >= 500) {
          throw new RutrackerError(`HTTP ${res.status} от ${base}`);
        }
        return res;
      } catch (err) {
        lastErr = err;
        this._log(`Зеркало ${base} недоступно: ${err.message}`);
        if (attempt + 1 >= maxAttempts) break;

        this.activeIndex = (this.activeIndex + 1) % this.mirrors.length;
        this._log(`Переключаюсь на ${this.activeMirror}`);

        // На новом домене своя сессия — переавторизуемся, если есть учётка.
        if (this._credentials) {
          try {
            await this._loginOn(
              this.activeMirror,
              this._credentials.username,
              this._credentials.password
            );
          } catch (e) {
            if (e instanceof AuthError) throw e; // плохие креды — перебор бессмыслен
            lastErr = e; // сетевая проблема на новом зеркале — идём дальше
          }
        }
      }
    }
    throw new AllMirrorsDown(
      `Все зеркала недоступны. Последняя ошибка: ${lastErr?.message ?? 'нет данных'}`
    );
  }

  /** Логин на конкретном зеркале. Бросает AuthError при неверных кредах. */
  async _loginOn(base, username, password) {
    const body = encodeForm({
      login_username: username,
      login_password: password,
      login: 'вход',
    });

    const res = await this._fetchOnce(base, '/forum/login.php', {
      method: 'POST',
      body,
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
    });

    let html = res.html;
    if (!isLoggedIn(html)) {
      // Иногда после POST нужен контрольный GET, чтобы увидеть статус.
      const check = await this._fetchOnce(base, '/forum/index.php');
      html = check.html;
    }

    if (isLoggedIn(html)) {
      const idx = this.mirrors.indexOf(base);
      if (idx >= 0) this.activeIndex = idx;
      this._authenticated = true;
      return;
    }

    if (detectCaptcha(html)) {
      throw new AuthError('Требуется ввод капчи — войдите в браузере и повторите позже');
    }
    if (detectLoginError(html)) {
      throw new AuthError('Неверный логин или пароль');
    }
    // Не залогинены, но и явной ошибки нет — вероятно, проблема зеркала.
    throw new RutrackerError(`Зеркало ${base} вернуло неожиданную страницу входа`);
  }

  /**
   * Вход в аккаунт. Перебирает зеркала по приоритету; при неверных кредах
   * сразу бросает AuthError (нет смысла пробовать другие зеркала).
   */
  async login(username = this.username, password = this.password) {
    if (!username || !password) {
      throw new AuthError('Не заданы логин и пароль');
    }
    this._credentials = { username, password };

    let lastErr;
    for (const base of this._mirrorOrder()) {
      try {
        await this._loginOn(base, username, password);
        this._log(`Вход выполнен через ${base}`);
        return true;
      } catch (err) {
        if (err instanceof AuthError) throw err;
        lastErr = err;
        this._log(`Не удалось подключиться к ${base}: ${err.message}`);
        if (!this.autoSwitch) break;
      }
    }
    throw new AllMirrorsDown(
      `Не удалось войти ни через одно зеркало: ${lastErr?.message ?? 'нет данных'}`
    );
  }

  _ensureAuth() {
    if (!this._authenticated) {
      throw new NotAuthenticated('Сначала выполните login()');
    }
  }

  /**
   * Поиск по трекеру.
   * @param {string} query — поисковая фраза.
   * @param {object} [opts]
   * @param {number|string} [opts.forum] — id раздела (фильтр).
   * @param {number} [opts.start] — смещение пагинации (кратно 50).
   * @param {number} [opts.sort] — поле сортировки (параметр o).
   * @param {number} [opts.order] — направление (параметр s).
   * @returns {Promise<Array>} массив результатов.
   */
  async search(query, opts = {}) {
    this._ensureAuth();
    const qs = encodeForm({
      nm: query,
      f: opts.forum,
      start: opts.start,
      o: opts.sort,
      s: opts.order,
    });
    const path = `/forum/tracker.php?${qs}`;

    let res = await this._request(path);
    if (!isLoggedIn(res.html)) {
      // Сессия истекла — один раз перелогиниваемся и повторяем.
      this._log('Сессия истекла, повторный вход…');
      await this.login();
      res = await this._request(path);
    }
    return parseSearchResults(res.html, this.activeMirror);
  }

  /** Детали темы (включая magnet-ссылку). */
  async getTopic(topicId) {
    this._ensureAuth();
    const res = await this._request(`/forum/viewtopic.php?t=${encodeURIComponent(topicId)}`);
    return parseTopic(res.html, this.activeMirror, topicId);
  }

  /** Только magnet-ссылку темы. */
  async getMagnet(topicId) {
    const topic = await this.getTopic(topicId);
    if (!topic.magnet) {
      throw new RutrackerError(`Magnet-ссылка не найдена для темы ${topicId}`);
    }
    return topic.magnet;
  }

  /**
   * Скачивает .torrent-файл. Возвращает Buffer с содержимым файла.
   */
  async downloadTorrent(topicId) {
    this._ensureAuth();
    const path = `/forum/dl.php?t=${encodeURIComponent(topicId)}`;

    let res = await this._request(path, { method: 'GET', raw: true });
    if (!res.contentType.includes('bittorrent')) {
      // Возможно, истекла сессия — пробуем перелогиниться и повторить.
      this._log('dl.php вернул не .torrent, пробую перелогиниться…');
      await this.login();
      res = await this._request(path, { method: 'GET', raw: true });
    }
    if (!res.contentType.includes('bittorrent')) {
      throw new RutrackerError(
        `Не удалось скачать .torrent для темы ${topicId} (нет доступа или тема не существует)`
      );
    }
    return res.buffer;
  }

  // --- Сохранение/восстановление сессии (пригодится в Electron) ---

  /** Сериализует сессию (cookie + активное зеркало). */
  dumpSession() {
    return {
      cookies: this.jar.toJSON(),
      activeIndex: this.activeIndex,
      authenticated: this._authenticated,
    };
  }

  /** Восстанавливает сессию из dumpSession(). */
  loadSession(data) {
    if (!data) return;
    this.jar = CookieJar.fromJSON(data.cookies);
    if (typeof data.activeIndex === 'number') this.activeIndex = data.activeIndex;
    this._authenticated = !!data.authenticated;
    if (this.username && this.password) {
      this._credentials = { username: this.username, password: this.password };
    }
  }
}
