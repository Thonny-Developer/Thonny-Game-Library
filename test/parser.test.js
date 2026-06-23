import { test } from 'node:test';
import assert from 'node:assert/strict';

import { parseSearchResults, parseTopic, isLoggedIn } from '../src/parser.js';
import { encodeWin1251Component, encodeForm } from '../src/encoding.js';

const BASE = 'https://rutracker.org';

// Фрагмент выдачи tracker.php (упрощённый, но со структурой реальной вёрстки).
const SEARCH_HTML = `
<table id="tor-tbl"><tbody>
  <tr class="tCenter hl-tr" data-topic_id="6543210">
    <td class="row1 t-ico"></td>
    <td class="row1 f-name-col"><div class="f-name"><a class="gen f" href="tracker.php?f=123">Кино</a></div></td>
    <td class="row4 med tLeft t-title-col tt"><div class="wbr t-title">
      <a class="med tLink bold" data-topic_id="6543210" href="viewtopic.php?t=6543210">Фильм 2024 BDRemux</a>
    </div></td>
    <td class="row1 u-name-col"><div class="u-name"><a class="med" href="tracker.php?rid=1">uploader</a></div></td>
    <td class="row4 small nowrap tor-size" data-ts_text="32212254720">
      <a href="dl.php?t=6543210" class="small tr-dl dl-stub">30&nbsp;GB&nbsp;↓</a></td>
    <td class="row4 nowrap" data-ts_text="42"><b class="seedmed">42</b></td>
    <td class="row4 leechmed bold" data-ts_text="7">7</td>
    <td class="row4 small number-format" data-ts_text="123">123</td>
    <td class="row4 small nowrap" data-ts_text="1700000000"><p>дата</p></td>
  </tr>
</tbody></table>`;

const TOPIC_HTML = `
<html><head><title>Фильм 2024 BDRemux :: RuTracker.org</title></head><body>
  <a id="logged-in-username" href="profile.php?mode=viewprofile&u=1">myuser</a>
  <h1 class="maintitle"><a href="viewtopic.php?t=6543210">Фильм 2024 BDRemux</a></h1>
  <span class="seed"><b>42</b></span><span class="leech"><b>7</b></span>
  <span>Размер: 30 GB</span>
  <a class="magnet-link" href="magnet:?xt=urn:btih:ABCDEF0123456789&dn=film">magnet</a>
</body></html>`;

test('parseSearchResults достаёт поля строки', () => {
  const rows = parseSearchResults(SEARCH_HTML, BASE);
  assert.equal(rows.length, 1);
  const r = rows[0];
  assert.equal(r.topicId, 6543210);
  assert.equal(r.title, 'Фильм 2024 BDRemux');
  assert.equal(r.forum, 'Кино');
  assert.equal(r.author, 'uploader');
  assert.equal(r.seeds, 42);
  assert.equal(r.leeches, 7);
  assert.equal(r.downloads, 123);
  assert.equal(r.sizeBytes, 32212254720);
  assert.match(r.size, /30\s*GB/);
  assert.equal(r.url, 'https://rutracker.org/forum/viewtopic.php?t=6543210');
  assert.equal(r.downloadUrl, 'https://rutracker.org/forum/dl.php?t=6543210');
});

test('parseTopic находит magnet и метаданные', () => {
  const t = parseTopic(TOPIC_HTML, BASE, 6543210);
  assert.equal(t.title, 'Фильм 2024 BDRemux');
  assert.equal(t.magnet, 'magnet:?xt=urn:btih:ABCDEF0123456789&dn=film');
  assert.equal(t.seeds, 42);
  assert.equal(t.leeches, 7);
  assert.match(t.size, /30\s*GB/);
});

test('isLoggedIn определяет вход', () => {
  assert.equal(isLoggedIn(TOPIC_HTML), true);
  assert.equal(isLoggedIn('<html><body>гость</body></html>'), false);
});

test('cp1251: кириллица кодируется однобайтно', () => {
  // «привет» в cp1251 — по одному байту на букву.
  assert.equal(encodeWin1251Component('привет'), '%EF%F0%E8%E2%E5%F2');
  // ASCII не трогается.
  assert.equal(encodeWin1251Component('ubuntu 24'), 'ubuntu%2024');
  const form = encodeForm({ nm: 'кино', f: 123 });
  assert.equal(form, 'nm=%EA%E8%ED%EE&f=123');
});
