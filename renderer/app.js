// Контроллер интерфейса. Общается с main-процессом только через window.api.

const api = window.api;
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

// Шаблоны тем. Палитры описаны в renderer/styles.css ([data-theme='id']);
// здесь — метаданные и цвета для мини-превью в настройках.
const THEMES = [
  { id: 'dark', name: 'Dark', group: 'dark', bg: '#1a1613', panel: '#221d18', accent: '#e0822e', text: '#e6dfd3', border: '#352e25' },
  { id: 'oled', name: 'OLED', group: 'dark', bg: '#000000', panel: '#0a0a0a', accent: '#e8842e', text: '#ededed', border: '#262626' },
  { id: 'dim', name: 'Dim', group: 'dark', bg: '#22272e', panel: '#2d333b', accent: '#539bf5', text: '#adbac7', border: '#444c56' },
  { id: 'gruvbox', name: 'Gruvbox', group: 'dark', bg: '#282828', panel: '#3c3836', accent: '#fe8019', text: '#ebdbb2', border: '#504945' },
  { id: 'nord', name: 'Nord', group: 'dark', bg: '#2e3440', panel: '#3b4252', accent: '#88c0d0', text: '#eceff4', border: '#4c566a' },
  { id: 'mocha', name: 'Catppuccin Mocha', group: 'dark', bg: '#1e1e2e', panel: '#313244', accent: '#cba6f7', text: '#cdd6f4', border: '#45475a' },
  { id: 'rose-pine', name: 'Rosé Pine', group: 'dark', bg: '#191724', panel: '#26233a', accent: '#ebbcba', text: '#e0def4', border: '#403d52' },
  { id: 'solarized-light', name: 'Solarized Light', group: 'light', bg: '#fdf6e3', panel: '#eee8d5', accent: '#268bd2', text: '#586e75', border: '#ddd6c1' },
  { id: 'textual-light', name: 'Textual Light', group: 'light', bg: '#f4f4f7', panel: '#e9e9ef', accent: '#0178d4', text: '#1f1f28', border: '#d2d2dd' },
  { id: 'rose-pine-dawn', name: 'Rosé Pine Dawn', group: 'light', bg: '#faf4ed', panel: '#f2e9e1', accent: '#d7827e', text: '#575279', border: '#dfdad9' },
  { id: 'latte', name: 'Catppuccin Latte', group: 'light', bg: '#eff1f5', panel: '#e6e9ef', accent: '#8839ef', text: '#4c4f69', border: '#ccd0da' },
  { id: 'atom-one-light', name: 'Atom One Light', group: 'light', bg: '#fafafa', panel: '#eaeaeb', accent: '#4078f2', text: '#383a42', border: '#d4d4d6' },
];
const THEME_IDS = new Set(THEMES.map((t) => t.id));

const VIEW_TITLES = { home: 'Главная', downloads: 'Загрузки', library: 'Библиотека' };
const SETTINGS_META = {
  account: { title: 'Аккаунт', sub: 'Профиль и сессия' },
  stats: { title: 'Статистика', sub: 'Активность в приложении' },
  interface: { title: 'Интерфейс', sub: 'Тема и оформление' },
  about: { title: 'О приложении', sub: 'Версия и зеркала' },
};

const state = {
  account: null,
  view: 'home',
  settings: { theme: 'dark', rememberLogin: true, lastUsername: '' },
  downloads: new Map(), // id -> снимок загрузки (живёт между ре-рендерами)
  speed: new Map(), // id -> { down:number[], up:number[], peakDown } — история для графика
};

const SPEED_WINDOW = 60; // сколько секунд скорости держим в графике (как в Steam)

// ---------- утилиты ----------
function fmtBytes(n) {
  if (!n || n < 0) return '';
  const u = ['Б', 'КБ', 'МБ', 'ГБ', 'ТБ'];
  let i = 0;
  let v = n;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(v < 10 && i > 0 ? 1 : 0)} ${u[i]}`;
}

function fmtSpeed(n) {
  if (!n || n < 1) return '0 Б/с';
  return `${fmtBytes(n)}/с`;
}

function fmtEta(ms) {
  if (!ms || ms === Infinity || ms < 0) return '—';
  let s = Math.round(ms / 1000);
  const h = Math.floor(s / 3600);
  s -= h * 3600;
  const m = Math.floor(s / 60);
  s -= m * 60;
  if (h) return `${h} ч ${m} мин`;
  if (m) return `${m} мин ${s} с`;
  return `${s} с`;
}

function fmtDate(iso) {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'medium', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"']/g, (c) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c])
  );
}

function initials(name) {
  if (!name) return '?';
  return name.trim().slice(0, 2).toUpperCase();
}

let toastTimer;
function toast(msg) {
  const el = $('#toast');
  el.textContent = msg;
  el.classList.remove('hidden');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => el.classList.add('hidden'), 2600);
}

function applyTheme() {
  // Незнакомая/устаревшая тема (например, старая 'light') → откат на Dark.
  const theme = THEME_IDS.has(state.settings.theme) ? state.settings.theme : 'dark';
  document.documentElement.dataset.theme = theme;
}

// ---------- титлбар ----------
function setTitlebar(section, { back = false } = {}) {
  $('#tb-section').textContent = section;
  $('#tb-back').classList.toggle('hidden', !back);
}

// ---------- авторизация / экраны ----------
function showLogin({ error, allowRetry } = {}) {
  $('#app').classList.add('hidden');
  $('#settings').classList.add('hidden');
  $('#login').classList.remove('hidden');
  setTitlebar('Вход', { back: false });

  const errEl = $('#login-error');
  if (error) {
    errEl.textContent = error;
    errEl.classList.remove('hidden');
  } else {
    errEl.classList.add('hidden');
  }
  $('#login-retry').classList.toggle('hidden', !allowRetry);

  // подставляем прошлый логин для удобства
  if (state.settings.lastUsername && !$('#login-username').value) {
    $('#login-username').value = state.settings.lastUsername;
    $('#login-password').focus();
  } else {
    $('#login-username').focus();
  }
}

function showApp(account) {
  state.account = account;
  $('#login').classList.add('hidden');
  $('#app').classList.remove('hidden');
  renderAccountBadge();
  switchView('home');
  loadDownloads(); // подтянуть прежние загрузки и бейдж сразу после входа
}

function renderAccountBadge() {
  const name = state.account?.username || '—';
  $('#avatar').textContent = initials(state.account?.username);
  $('#avatar-name').textContent = name;
  $('#avatar-mirror').textContent = state.account?.mirror
    ? state.account.mirror.replace(/^https?:\/\//, '')
    : 'не в сети';
}

async function doLogin(e) {
  e?.preventDefault();
  const username = $('#login-username').value.trim();
  const password = $('#login-password').value;
  const remember = $('#login-remember').checked;
  if (!username || !password) return;

  const btn = $('#login-submit');
  btn.disabled = true;
  btn.textContent = 'Вход…';
  try {
    const res = await api.login(username, password, remember);
    if (res.ok) {
      state.settings.lastUsername = username;
      $('#login-password').value = '';
      showApp(res.account);
    } else if (res.code === 'auth') {
      // Ошибка из-за логина/пароля — окно входа остаётся, показываем причину.
      showLogin({ error: res.error || 'Неверный логин или пароль' });
      $('#login-password').select();
    } else {
      showLogin({ error: res.error || 'Не удалось подключиться к зеркалам' });
    }
  } catch (err) {
    showLogin({ error: err.message });
  } finally {
    btn.disabled = false;
    btn.textContent = 'Войти';
  }
}

// ---------- сплеш-экран загрузки ----------
const BOOT_MIN = 650; // минимальная длительность стадии для плавной анимации, мс
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function setBootStep(name, status, note) {
  const el = $(`.boot-step[data-step="${name}"]`);
  if (!el) return;
  el.classList.remove('pending', 'active', 'done', 'error');
  el.classList.add(status);
  if (note !== undefined) $('.boot-note', el).textContent = note;
}

function setBootProgress(frac) {
  $('#boot-bar-fill').style.width = `${Math.round(frac * 100)}%`;
}

// Показывает спиннер стадии не короче BOOT_MIN, затем фиксирует итог (done/error).
// work() возвращает { status, note } — финальное состояние стадии.
async function runStep(name, work) {
  setBootStep(name, 'active', '');
  const started = performance.now();
  let outcome;
  try {
    outcome = await work();
  } catch (err) {
    outcome = { status: 'error', note: 'ошибка' };
  }
  const elapsed = performance.now() - started;
  if (elapsed < BOOT_MIN) await wait(BOOT_MIN - elapsed);
  setBootStep(name, outcome.status, outcome.note);
  return outcome;
}

function showSplash() {
  const sp = $('#splash');
  sp.classList.remove('hidden', 'splash-out');
  $('#login').classList.add('hidden');
  $('#app').classList.add('hidden');
  $('#settings').classList.add('hidden');
  ['mirrors', 'user', 'ui'].forEach((n) => setBootStep(n, 'pending', ''));
  setBootProgress(0);
}

async function hideSplash() {
  const sp = $('#splash');
  sp.classList.add('splash-out');
  await wait(460);
  sp.classList.add('hidden');
}

async function bootstrap() {
  // Тему применяем до показа стадий — сплеш должен совпадать с оформлением.
  state.settings = await api.getSettings();
  applyTheme();

  showSplash();
  setTitlebar('Загрузка', { back: false });
  await wait(140); // даём стадиям проявиться

  // Стадия 1 — доступность зеркал.
  await runStep('mirrors', async () => {
    const list = await api.pingMirrors();
    const up = list.filter((m) => m.available);
    if (!up.length) return { status: 'error', note: 'зеркала недоступны' };
    const best = up[0].mirror.replace(/^https?:\/\//, '');
    return { status: 'done', note: `${up.length}/${list.length} в сети · ${best}` };
  });
  setBootProgress(1 / 3);

  // Стадия 2 — вход по сохранённой сессии.
  let res = { state: 'need-login' };
  await runStep('user', async () => {
    res = await api.bootstrap();
    if (res.state === 'ready') {
      return { status: 'done', note: res.account?.username || 'сессия восстановлена' };
    }
    if (res.state === 'error') {
      return { status: 'error', note: 'сеть недоступна' };
    }
    return { status: 'done', note: 'требуется вход' };
  });
  setBootProgress(2 / 3);

  // Стадия 3 — подготовка интерфейса.
  await runStep('ui', async () => ({ status: 'done', note: 'готово' }));
  setBootProgress(1);

  await wait(300);
  await hideSplash();

  if (res.state === 'ready') {
    showApp(res.account);
  } else if (res.state === 'error') {
    // Креды есть, но сеть/зеркала недоступны — даём повторить.
    showLogin({ error: res.error || 'Зеркала недоступны', allowRetry: true });
  } else {
    showLogin({ error: res.error });
  }
}

async function doLogout() {
  await api.logout();
  closeAvatarMenu();
  state.account = null;
  $('#search-input').value = '';
  $('#results').innerHTML = '';
  showLogin({});
}

// ---------- навигация по вкладкам ----------
function switchView(name) {
  state.view = name;
  $$('.nav-item').forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  $('#view-home').classList.toggle('hidden', name !== 'home');
  $('#view-downloads').classList.toggle('hidden', name !== 'downloads');
  $('#view-library').classList.toggle('hidden', name !== 'library');
  setTitlebar(VIEW_TITLES[name] || 'Главная', { back: false });
  if (name === 'downloads') renderDownloads();
  if (name === 'library') renderLibrary();
}

// ---------- меню аватара ----------
function toggleAvatarMenu() {
  $('#avatar-menu').classList.toggle('hidden');
}
function closeAvatarMenu() {
  $('#avatar-menu').classList.add('hidden');
}

// ---------- поиск ----------
async function doSearch(e) {
  e?.preventDefault();
  const query = $('#search-input').value.trim();
  if (!query) return;

  const stateEl = $('#search-state');
  const resultsEl = $('#results');
  resultsEl.innerHTML = '';
  stateEl.classList.remove('hidden');
  stateEl.innerHTML = '<div class="spinner"></div>Ищу на трекере…';

  try {
    const { results, mirror } = await api.search(query);
    $('#home-mirror').textContent = mirror ? mirror.replace(/^https?:\/\//, '') : '';
    if (state.account) {
      state.account.mirror = mirror;
      renderAccountBadge();
    }
    stateEl.classList.add('hidden');
    if (!results.length) {
      stateEl.classList.remove('hidden');
      stateEl.textContent = 'Ничего не найдено';
      return;
    }
    resultsEl.innerHTML = results.map(resultCard).join('');
  } catch (err) {
    stateEl.classList.remove('hidden');
    stateEl.textContent = `Ошибка: ${err.message}`;
  }
}

function resultCard(r) {
  const size = r.size || fmtBytes(r.sizeBytes);
  return `
    <div class="card" data-id="${r.topicId}" data-title="${escapeHtml(r.title)}">
      <p class="card-title">${escapeHtml(r.title)}</p>
      <div class="card-meta">
        ${r.forum ? `<span class="tag">${escapeHtml(r.forum)}</span>` : ''}
        ${size ? `<span><b>${escapeHtml(size)}</b></span>` : ''}
        <span class="s-up">▲ ${r.seeds}</span>
        <span class="s-down">▼ ${r.leeches}</span>
        <span>↓ ${r.downloads}</span>
        ${r.author ? `<span>${escapeHtml(r.author)}</span>` : ''}
      </div>
      <div class="card-actions">
        <button class="btn btn-primary btn-sm" data-act="get">Скачать ↓</button>
        <button class="btn btn-sm" data-act="magnet">Копировать magnet</button>
        <button class="btn btn-ghost btn-sm" data-act="download">Сохранить .torrent</button>
        <button class="btn btn-ghost btn-sm" data-act="open">Открыть тему</button>
      </div>
    </div>`;
}

async function onResultClick(e) {
  const btn = e.target.closest('[data-act]');
  if (!btn) return;
  const card = e.target.closest('.card');
  const id = card.dataset.id;
  const title = card.dataset.title;
  const act = btn.dataset.act;

  if (act === 'open') {
    api.openExternal(`${state.account.mirror}/forum/viewtopic.php?t=${id}`);
    return;
  }

  btn.disabled = true;
  try {
    if (act === 'magnet') {
      await api.copyMagnet(id, title);
      toast('Magnet-ссылка скопирована');
    } else if (act === 'download') {
      const res = await api.downloadTorrent(id, title);
      if (!res.canceled) toast(`Сохранено: ${res.path}`);
    } else if (act === 'get') {
      const res = await api.startDownload(id, title);
      if (res.canceled) {
        // папку не выбрали — ничего не делаем
      } else if (res.already) {
        toast('Эта раздача уже в загрузках');
        switchView('downloads');
      } else if (res.snapshot) {
        state.downloads.set(res.snapshot.id, res.snapshot);
        toast('Загрузка началась');
        switchView('downloads');
      }
    }
  } catch (err) {
    toast(`Ошибка: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- загрузки ----------
// Первичная подгрузка из main (например, после входа) — наполняет state и бейдж.
async function loadDownloads() {
  try {
    const list = await api.downloadList();
    state.downloads = new Map(list.map((d) => [d.id, d]));
  } catch {
    state.downloads = new Map();
  }
  paintDownloads();
}

async function renderDownloads() {
  await loadDownloads();
}

// Текстовая статистика карточки — пересобирается каждый тик (без canvas внутри).
function statsHtml(dl) {
  const pct = Math.round((dl.progress || 0) * 100);
  const total = dl.length ? fmtBytes(dl.length) : '';
  const size = `${fmtBytes(dl.downloaded || 0)}${total ? ` / ${total}` : ''}`;

  if (dl.state === 'downloading') {
    const peak = state.speed.get(dl.id)?.peakDown || 0;
    return `
      <span><b>${pct}%</b></span>
      <span>${size}</span>
      <span class="s-up">▼ ${fmtSpeed(dl.downloadSpeed)}</span>
      <span class="dl-up">▲ ${fmtSpeed(dl.uploadSpeed)}</span>
      ${peak ? `<span class="muted">пик ${fmtSpeed(peak)}</span>` : ''}
      <span>${dl.peers || 0} пиров</span>
      <span>осталось ${fmtEta(dl.timeRemaining)}</span>`;
  }
  if (dl.state === 'paused') {
    return `<span><b>${pct}%</b></span><span>${size}</span><span class="muted">На паузе</span>`;
  }
  if (dl.state === 'done') {
    return `<span><b>100%</b></span><span>${total || size}</span><span class="s-up">✓ Готово</span>`;
  }
  return `<span><b>${pct}%</b></span><span>${size}</span><span class="s-down">Ошибка: ${escapeHtml(dl.error || 'неизвестно')}</span>`;
}

// Кнопки зависят только от состояния — меняются вместе с полной пересборкой.
function actionsHtml(dl) {
  if (dl.state === 'downloading') {
    return `
      <button class="btn btn-sm" data-dl-act="pause">Пауза</button>
      <button class="btn btn-ghost btn-sm" data-dl-act="remove">Удалить</button>`;
  }
  if (dl.state === 'paused') {
    return `
      <button class="btn btn-primary btn-sm" data-dl-act="resume">Продолжить</button>
      <button class="btn btn-ghost btn-sm" data-dl-act="remove">Удалить</button>`;
  }
  if (dl.state === 'done') {
    return `
      <button class="btn btn-primary btn-sm" data-dl-act="open-file">Открыть файл</button>
      <button class="btn btn-sm" data-dl-act="open-folder">Открыть папку</button>
      <button class="btn btn-ghost btn-sm" data-dl-act="remove">Убрать</button>`;
  }
  return `
    <button class="btn btn-sm" data-dl-act="resume">Повторить</button>
    <button class="btn btn-ghost btn-sm" data-dl-act="remove">Убрать</button>`;
}

function downloadCard(dl) {
  const pct = Math.round((dl.progress || 0) * 100);
  const barClass = dl.state === 'done' ? ' done' : dl.state === 'error' ? ' error' : '';
  // График скорости показываем только у активной загрузки (как в Steam).
  const graph = dl.state === 'downloading' ? '<canvas class="dl-graph"></canvas>' : '';
  return `
    <div class="card" data-dl="${dl.id}">
      <p class="card-title">${escapeHtml(dl.title || 'Без названия')}</p>
      ${graph}
      <div class="dl-bar${barClass}"><span class="dl-bar-fill" style="width:${pct}%"></span></div>
      <div class="card-meta dl-meta">
        <span class="dl-stats">${statsHtml(dl)}</span>
        <span class="muted dl-path">${escapeHtml(dl.savePath || '')}</span>
      </div>
      <div class="card-actions">${actionsHtml(dl)}</div>
    </div>`;
}

// Точечное обновление карточки: прогресс-бар, статистика и перерисовка графика.
// Не трогает сам узел canvas, поэтому история на нём не сбрасывается каждую секунду.
function updateDownloadCard(card, dl) {
  const fill = card.querySelector('.dl-bar-fill');
  if (fill) fill.style.width = `${Math.round((dl.progress || 0) * 100)}%`;
  const stats = card.querySelector('.dl-stats');
  if (stats) stats.innerHTML = statsHtml(dl);
  const canvas = card.querySelector('.dl-graph');
  if (canvas) drawSpeedGraph(canvas, dl);
}

// Кладёт очередной замер скорости в кольцевую историю на SPEED_WINDOW отсчётов.
function sampleSpeed(dl) {
  let h = state.speed.get(dl.id);
  if (!h) {
    h = { down: [], up: [], peakDown: 0 };
    state.speed.set(dl.id, h);
  }
  if (dl.state !== 'downloading') return h;
  const d = Math.max(0, dl.downloadSpeed || 0);
  const u = Math.max(0, dl.uploadSpeed || 0);
  h.down.push(d);
  h.up.push(u);
  if (h.down.length > SPEED_WINDOW) h.down.shift();
  if (h.up.length > SPEED_WINDOW) h.up.shift();
  if (d > h.peakDown) h.peakDown = d;
  return h;
}

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}
function hexToRgb(hex) {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex || '');
  if (!m) return [224, 130, 46];
  const n = parseInt(m[1], 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

// Рисует график скорости: заливка+линия загрузки (акцент) и линия отдачи (синяя),
// с подписью текущего максимума шкалы справа — оформление в духе Steam.
function drawSpeedGraph(canvas, dl) {
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  const dpr = window.devicePixelRatio || 1;
  const cssW = canvas.clientWidth || canvas.parentElement?.clientWidth || 320;
  const cssH = 48;
  if (canvas.width !== Math.round(cssW * dpr) || canvas.height !== Math.round(cssH * dpr)) {
    canvas.width = Math.round(cssW * dpr);
    canvas.height = Math.round(cssH * dpr);
  }
  ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  ctx.clearRect(0, 0, cssW, cssH);

  const h = state.speed.get(dl.id);
  if (!h || !h.down.length) return;
  const { down, up } = h;
  const n = down.length;
  const windowMax = Math.max(0, ...down, ...up);
  const max = windowMax * 1.18 || 1; // запас сверху, чтобы пик не упирался в край
  const pad = 5;
  const usable = cssH - pad;
  const step = cssW / (SPEED_WINDOW - 1); // новые отсчёты прижаты к правому краю
  const xAt = (i) => cssW - (n - 1 - i) * step;
  const yAt = (v) => cssH - (v / max) * usable;

  const [ar, ag, ab] = hexToRgb(cssVar('--accent') || '#e0822e');
  const [br, bg, bb] = hexToRgb(cssVar('--blue') || '#5b9dff');

  // Заливка области загрузки — вертикальный градиент.
  const grad = ctx.createLinearGradient(0, 0, 0, cssH);
  grad.addColorStop(0, `rgba(${ar},${ag},${ab},0.32)`);
  grad.addColorStop(1, `rgba(${ar},${ag},${ab},0.02)`);
  ctx.beginPath();
  ctx.moveTo(xAt(0), cssH);
  for (let i = 0; i < n; i++) ctx.lineTo(xAt(i), yAt(down[i]));
  ctx.lineTo(xAt(n - 1), cssH);
  ctx.closePath();
  ctx.fillStyle = grad;
  ctx.fill();

  // Линия загрузки.
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(i);
    const y = yAt(down[i]);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = `rgba(${ar},${ag},${ab},0.95)`;
  ctx.lineWidth = 1.5;
  ctx.lineJoin = 'round';
  ctx.stroke();

  // Линия отдачи.
  ctx.beginPath();
  for (let i = 0; i < n; i++) {
    const x = xAt(i);
    const y = yAt(up[i]);
    i ? ctx.lineTo(x, y) : ctx.moveTo(x, y);
  }
  ctx.strokeStyle = `rgba(${br},${bg},${bb},0.85)`;
  ctx.lineWidth = 1.25;
  ctx.stroke();

  // Подпись максимума шкалы.
  if (windowMax > 0) {
    ctx.font = '10px ui-monospace, SFMono-Regular, Menlo, monospace';
    ctx.textAlign = 'right';
    ctx.textBaseline = 'top';
    ctx.fillStyle = `rgba(${ar},${ag},${ab},0.7)`;
    ctx.fillText(fmtSpeed(windowMax), cssW - 6, 4);
  }
}

function updateDlBadge() {
  const n = [...state.downloads.values()].filter((d) => d.state === 'downloading').length;
  const b = $('#dl-badge');
  if (!b) return;
  b.textContent = n;
  b.classList.toggle('hidden', n === 0);
}

function paintDownloads() {
  updateDlBadge();
  if (state.view !== 'downloads') return; // вне вкладки обновляем только бейдж
  const el = $('#downloads-list');
  const list = [...state.downloads.values()].sort((a, b) =>
    String(b.addedAt || '').localeCompare(String(a.addedAt || ''))
  );
  if (!list.length) {
    el.innerHTML =
      '<div class="state">Пока пусто. Нажмите «Скачать» у любой раздачи на вкладке «Главная».</div>';
    el.dataset.sig = '';
    return;
  }
  // Полностью пересобираем список только когда меняется набор карточек или их
  // состояния. В остальные тики обновляем динамику на месте — иначе canvas
  // графика и анимация прогресс-бара сбрасывались бы каждую секунду.
  const sig = list.map((d) => `${d.id}:${d.state}`).join('|');
  if (el.dataset.sig !== sig) {
    el.innerHTML = list.map(downloadCard).join('');
    el.dataset.sig = sig;
  }
  for (const dl of list) {
    const card = el.querySelector(`[data-dl="${CSS.escape(dl.id)}"]`);
    if (card) updateDownloadCard(card, dl);
  }
}

async function onDownloadsClick(e) {
  const btn = e.target.closest('[data-dl-act]');
  if (!btn) return;
  const card = e.target.closest('[data-dl]');
  const id = card.dataset.dl;
  const act = btn.dataset.dlAct;

  btn.disabled = true;
  try {
    if (act === 'pause') {
      const s = await api.pauseDownload(id);
      if (s) state.downloads.set(id, s);
      paintDownloads();
    } else if (act === 'resume') {
      const s = await api.resumeDownload(id);
      if (s) state.downloads.set(id, s);
      paintDownloads();
    } else if (act === 'open-folder') {
      await api.openDownloadFolder(id);
    } else if (act === 'open-file') {
      await api.openDownloadFile(id);
    } else if (act === 'remove') {
      await api.removeDownload(id, false);
      state.downloads.delete(id);
      state.speed.delete(id);
      paintDownloads();
    }
  } catch (err) {
    toast(`Ошибка: ${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

// ---------- библиотека ----------
async function renderLibrary() {
  const list = await api.library();
  const el = $('#library-list');
  if (!list.length) {
    el.innerHTML = '<div class="state">Пока пусто. Скачайте .torrent или скопируйте magnet на вкладке «Главная».</div>';
    return;
  }
  el.innerHTML = list.map(libCard).join('');
}

function libCard(item) {
  const badge = item.type === 'torrent' ? '.torrent' : 'magnet';
  const extra =
    item.type === 'torrent'
      ? `<span>${escapeHtml(item.path || '')}</span>`
      : `<span class="muted">${escapeHtml((item.magnet || '').slice(0, 60))}…</span>`;
  return `
    <div class="card" data-id="${item.topicId}" data-type="${item.type}" data-title="${escapeHtml(item.title)}">
      <p class="card-title">${escapeHtml(item.title || 'Без названия')}</p>
      <div class="card-meta">
        <span class="tag">${badge}</span>
        <span>${fmtDate(item.addedAt)}</span>
        ${extra}
      </div>
      <div class="card-actions">
        ${item.type === 'magnet' ? '<button class="btn btn-sm" data-lib="copy">Копировать снова</button>' : ''}
        <button class="btn btn-ghost btn-sm" data-lib="open">Открыть тему</button>
        <button class="btn btn-ghost btn-sm" data-lib="remove">Убрать</button>
      </div>
    </div>`;
}

async function onLibraryClick(e) {
  const btn = e.target.closest('[data-lib]');
  if (!btn) return;
  const card = e.target.closest('.card');
  const id = card.dataset.id;
  const type = card.dataset.type;
  const act = btn.dataset.lib;

  if (act === 'open') {
    api.openExternal(`${state.account.mirror}/forum/viewtopic.php?t=${id}`);
  } else if (act === 'copy') {
    try {
      await api.copyMagnet(id, card.dataset.title);
      toast('Magnet-ссылка скопирована');
    } catch (err) {
      toast(`Ошибка: ${err.message}`);
    }
  } else if (act === 'remove') {
    await api.removeLibrary(id, type);
    renderLibrary();
  }
}

// ---------- настройки ----------
function openSettings() {
  closeAvatarMenu();
  if (!state.account) return; // настройки доступны только после входа
  $('#settings').classList.remove('hidden');
  setTitlebar('Настройки', { back: true });
  switchSettings('account');
}
function closeSettings() {
  if ($('#settings').classList.contains('hidden')) return;
  $('#settings').classList.add('hidden');
  setTitlebar(VIEW_TITLES[state.view] || 'Главная', { back: false });
}
function switchSettings(section) {
  $$('.settings-tab').forEach((t) => t.classList.toggle('active', t.dataset.section === section));
  $$('.settings-section').forEach((s) =>
    s.classList.toggle('hidden', s.dataset.section !== section)
  );
  const meta = SETTINGS_META[section] || { title: '', sub: '' };
  $('#set-title').textContent = meta.title;
  $('#set-sub').textContent = meta.sub;
  if (section === 'account') renderAccountSection();
  if (section === 'stats') renderStatsSection();
  if (section === 'interface') renderInterfaceSection();
  if (section === 'about') renderAboutSection();
}

function renderAccountSection() {
  const el = $('.settings-section[data-section="account"]');
  const a = state.account || {};
  el.innerHTML = `
    <div class="account-head">
      <span class="avatar">${initials(a.username)}</span>
      <div>
        <div style="font-weight:600;font-size:16px">${escapeHtml(a.username || '—')}</div>
        <div class="muted" style="font-size:12.5px">${a.authenticated ? 'В сети' : 'Не в сети'}</div>
      </div>
    </div>
    <div class="set-row">
      <div><div class="label">Активное зеркало</div><div class="desc">Используется для запросов</div></div>
      <code class="muted">${escapeHtml(a.mirror || '—')}</code>
    </div>
    <div class="set-row">
      <div><div class="label">Запоминать вход</div><div class="desc">Хранить логин зашифрованным на этом устройстве</div></div>
      <label class="checkbox"><input id="set-remember" type="checkbox" ${state.settings.rememberLogin ? 'checked' : ''}><span></span></label>
    </div>
    <div class="set-row">
      <div><div class="label">Сеанс</div><div class="desc">Выйти и удалить сохранённые данные входа</div></div>
      <button class="btn btn-sm" id="set-logout">Выйти из аккаунта</button>
    </div>`;

  $('#set-remember').addEventListener('change', async (e) => {
    state.settings = await api.setSettings({ rememberLogin: e.target.checked });
  });
  $('#set-logout').addEventListener('click', () => {
    closeSettings();
    doLogout();
  });
}

async function renderStatsSection() {
  const el = $('.settings-section[data-section="stats"]');
  const s = await api.getStats();
  el.innerHTML = `
    <div class="stat-grid">
      <div class="stat-box"><div class="num">${s.searches || 0}</div><div class="cap">Поисков</div></div>
      <div class="stat-box"><div class="num">${s.torrents || 0}</div><div class="cap">Закачано раздач</div></div>
      <div class="stat-box"><div class="num">${s.downloads || 0}</div><div class="cap">Скачано .torrent</div></div>
      <div class="stat-box"><div class="num">${s.magnets || 0}</div><div class="cap">Magnet скопировано</div></div>
      <div class="stat-box"><div class="num" style="font-size:14px;padding-top:6px">${(s.lastMirror || '—').replace(/^https?:\/\//, '')}</div><div class="cap">Последнее зеркало</div></div>
    </div>
    <div class="set-row"><div class="label">Первый запуск</div><span class="muted">${fmtDate(s.firstRun)}</span></div>
    <div class="set-row"><div class="label">Последний вход</div><span class="muted">${fmtDate(s.lastLogin)}</span></div>`;
}

function themeCard(t) {
  const active = state.settings.theme === t.id ? ' active' : '';
  return `
    <button class="theme-card${active}" data-theme="${t.id}"
      style="--c-bg:${t.bg};--c-panel:${t.panel};--c-accent:${t.accent};--c-text:${t.text};--c-border:${t.border}">
      <span class="theme-prev"><span class="l l1"></span><span class="l l2"></span></span>
      <span class="theme-name">${escapeHtml(t.name)}</span>
    </button>`;
}

function renderInterfaceSection() {
  const el = $('.settings-section[data-section="interface"]');
  const groups = [
    { key: 'dark', label: 'Тёмные' },
    { key: 'light', label: 'Светлые' },
  ];
  el.innerHTML = groups
    .map(
      (g) => `
    <div class="theme-group">
      <div class="theme-group-title">${g.label}</div>
      <div class="theme-grid">
        ${THEMES.filter((t) => t.group === g.key).map(themeCard).join('')}
      </div>
    </div>`
    )
    .join('');

  // onclick (а не addEventListener) — секция-контейнер переживает ре-рендеры,
  // присваивание свойства не плодит дублирующиеся обработчики.
  el.onclick = async (e) => {
    const card = e.target.closest('[data-theme]');
    if (!card) return;
    state.settings = await api.setSettings({ theme: card.dataset.theme });
    applyTheme();
    $$('.theme-card', el).forEach((c) => c.classList.toggle('active', c === card));
  };
}

async function renderAboutSection() {
  const el = $('.settings-section[data-section="about"]');
  const version = await api.version();
  el.innerHTML = `
    <p class="about-meta">
      <b style="color:var(--text)">Game Library</b> · версия ${escapeHtml(version)}<br/>
      Библиотека игр с авторизацией, поиском и загрузками.
    </p>
    <div class="set-row">
      <div class="label">Доступность зеркал</div>
      <button class="btn btn-sm" id="ping-btn">Проверить</button>
    </div>
    <div id="mirror-status"></div>
    <div class="set-row">
      <div class="label">Ссылки</div>
      <div>
        <span class="link" data-ext="https://rutracker.net">Источник библиотеки</span>
      </div>
    </div>`;

  $('#ping-btn').addEventListener('click', async (e) => {
    e.target.disabled = true;
    e.target.textContent = 'Проверяю…';
    const list = await api.pingMirrors();
    $('#mirror-status').innerHTML = list
      .map(
        (m) =>
          `<div class="mirror-row"><span class="dot ${m.available ? 'ok' : 'bad'}"></span>${escapeHtml(
            m.mirror.replace(/^https?:\/\//, '')
          )} — ${m.available ? 'доступно' : 'недоступно'}</div>`
      )
      .join('');
    e.target.disabled = false;
    e.target.textContent = 'Проверить';
  });
  el.querySelectorAll('[data-ext]').forEach((n) =>
    n.addEventListener('click', () => api.openExternal(n.dataset.ext))
  );
}

// ---------- инициализация ----------
function bindEvents() {
  $('#login-form').addEventListener('submit', doLogin);
  $('#login-retry').addEventListener('click', bootstrap);

  $$('.nav-item').forEach((b) =>
    b.addEventListener('click', () => switchView(b.dataset.view))
  );

  $('#avatar-btn').addEventListener('click', (e) => {
    e.stopPropagation();
    toggleAvatarMenu();
  });
  $('#avatar-menu').addEventListener('click', (e) => {
    const item = e.target.closest('[data-action]');
    if (!item) return;
    if (item.dataset.action === 'settings') openSettings();
    if (item.dataset.action === 'logout') doLogout();
  });
  document.addEventListener('click', closeAvatarMenu);

  $('#search-form').addEventListener('submit', doSearch);
  $('#results').addEventListener('click', onResultClick);
  $('#downloads-list').addEventListener('click', onDownloadsClick);
  $('#library-list').addEventListener('click', onLibraryClick);

  $('#tb-back').addEventListener('click', closeSettings);
  $$('.settings-tab').forEach((t) =>
    t.addEventListener('click', () => switchSettings(t.dataset.section))
  );

  // Кнопки управления окном.
  $('#win-min').addEventListener('click', () => api.winMinimize());
  $('#win-max').addEventListener('click', () => api.winMaximize());
  $('#win-close').addEventListener('click', () => api.winClose());

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') closeSettings();
    // Ctrl+K — быстрый переход к поиску.
    if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
      e.preventDefault();
      if (!state.account) return;
      closeSettings();
      switchView('home');
      $('#search-input').focus();
    }
  });

  api.onLog((m) => console.log('[main]', m));

  // Живые обновления загрузок из main-процесса.
  api.onDownloadTick((items) => {
    for (const s of items) {
      state.downloads.set(s.id, s);
      sampleSpeed(s); // копим историю скорости для графика (раз в секунду)
    }
    paintDownloads();
  });
  api.onDownloadUpdate((snap) => {
    if (snap) state.downloads.set(snap.id, snap);
    paintDownloads();
  });
  api.onDownloadDone((snap) => {
    if (snap) {
      state.downloads.set(snap.id, snap);
      paintDownloads();
      toast(`Скачано: ${snap.title}`);
    }
  });
  api.onDownloadRemoved((id) => {
    state.downloads.delete(id);
    state.speed.delete(id);
    paintDownloads();
  });
}

bindEvents();
bootstrap();
