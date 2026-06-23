// Разбор HTML-страниц RuTracker. Селекторы написаны защитно: вёрстка
// форума иногда меняется, поэтому есть запасные варианты и безопасные дефолты.

import * as cheerio from 'cheerio';

/** Достаёт первое целое число из строки. */
function toInt(text, fallback = 0) {
  if (text == null) return fallback;
  const m = String(text).replace(/[\s ]/g, '').match(/-?\d+/);
  return m ? parseInt(m[0], 10) : fallback;
}

/** Залогинен ли пользователь — по наличию имени/ссылки выхода. */
export function isLoggedIn(html) {
  if (!html) return false;
  const $ = cheerio.load(html);
  if ($('#logged-in-username').length) return true;
  if ($('a[href*="logout=1"]').length) return true;
  // На некоторых страницах вместо id есть ссылка на профиль с logout рядом.
  return /logout=1/.test(html);
}

/** Похоже ли, что страница требует капчу. */
export function detectCaptcha(html) {
  if (!html) return false;
  return /cap_sid|name=["']cap_code|captcha/i.test(html);
}

/** Явная ошибка «неверный логин/пароль». */
export function detectLoginError(html) {
  if (!html) return false;
  return /(неверн\w+).{0,40}(парол|имя поль)|(парол|имя поль).{0,40}(неверн)/i.test(html);
}

/**
 * Разбирает выдачу tracker.php в массив TorrentResult.
 * @param {string} html
 * @param {string} base — базовый URL активного зеркала (для абсолютных ссылок).
 */
export function parseSearchResults(html, base) {
  const $ = cheerio.load(html);
  const forumBase = `${base}/forum`;
  const results = [];

  let rows = $('#tor-tbl tbody tr');
  if (!rows.length) rows = $('tr.tCenter.hl-tr');

  rows.each((_, el) => {
    const row = $(el);

    // topic_id: атрибут строки или ссылка заголовка.
    let topicId = toInt(row.attr('data-topic_id'), 0);
    const titleLink = row.find('.t-title a, .t-title-col a').first();
    if (!topicId) topicId = toInt(titleLink.attr('href')?.match(/t=(\d+)/)?.[1], 0);
    if (!topicId) return; // строка-заголовок или мусор

    const title = titleLink.text().trim();
    const forum = row.find('.f-name a, .f-name-col a').first().text().trim();
    const author = row.find('.u-name a, .u-name-col a').first().text().trim();

    const sizeCell = row.find('td.tor-size').first();
    const sizeBytes = sizeCell.attr('data-ts_text')
      ? toInt(sizeCell.attr('data-ts_text'), null)
      : null;
    const size = sizeCell
      .text()
      .replace(/[↓ ]/g, ' ') // стрелка скачивания + неразрывный пробел
      .trim();

    const seeds = toInt(
      row.find('b.seedmed').first().text() || row.find('.seedmed').first().attr('data-ts_text'),
      0
    );
    const leeches = toInt(
      row.find('td.leechmed, .leechmed').first().attr('data-ts_text') ||
        row.find('td.leechmed, .leechmed').first().text(),
      0
    );
    const downloads = toInt(
      row.find('td.number-format, .number-format').first().attr('data-ts_text') ||
        row.find('td.number-format, .number-format').first().text(),
      0
    );

    // Дата добавления — последняя ячейка с временной меткой.
    let added = '';
    const dateCell = row.find('td[data-ts_text]').last();
    const ts = toInt(dateCell.attr('data-ts_text'), 0);
    if (ts > 1000000000) added = new Date(ts * 1000).toISOString();

    results.push({
      topicId,
      title,
      forum,
      size,
      sizeBytes,
      seeds,
      leeches,
      downloads,
      author,
      added,
      url: `${forumBase}/viewtopic.php?t=${topicId}`,
      downloadUrl: `${forumBase}/dl.php?t=${topicId}`,
    });
  });

  return results;
}

/** Разбирает страницу темы viewtopic.php. */
export function parseTopic(html, base, topicId) {
  const $ = cheerio.load(html);
  const forumBase = `${base}/forum`;

  const magnet =
    $('a.magnet-link').attr('href') ||
    $('a[href^="magnet:"]').attr('href') ||
    (html.match(/magnet:\?[^"'\s<>]+/) || [])[0] ||
    null;

  const title =
    $('h1.maintitle a').first().text().trim() ||
    $('h1.maintitle').first().text().trim() ||
    $('title').text().replace(/\s*::.*$/, '').trim();

  const seeds = $('.seed b, #seeders').first().length
    ? toInt($('.seed b, #seeders').first().text(), null)
    : null;
  const leeches = $('.leech b, #leechers').first().length
    ? toInt($('.leech b, #leechers').first().text(), null)
    : null;

  // Размер: строка «Размер:» в шапке вложения.
  let size = null;
  const sizeText = $('*:contains("Размер:")')
    .filter((_, e) => /Размер:/.test($(e).clone().children().remove().end().text()))
    .first()
    .parent()
    .text();
  const sizeMatch = sizeText?.match(/Размер:\s*([\d.,]+\s*[КМГKMGTБBA-Za-z]+)/);
  if (sizeMatch) size = sizeMatch[1].trim();

  return {
    topicId: Number(topicId),
    title,
    magnet,
    size,
    seeds,
    leeches,
    url: `${forumBase}/viewtopic.php?t=${topicId}`,
  };
}
