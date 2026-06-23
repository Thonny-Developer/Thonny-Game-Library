#!/usr/bin/env node
// Простой CLI поверх библиотеки. Учётные данные берутся из переменных
// окружения RUTRACKER_USERNAME / RUTRACKER_PASSWORD (или флагов --user/--pass).
//
// Примеры:
//   RUTRACKER_USERNAME=... RUTRACKER_PASSWORD=... node bin/cli.js search "kingdom come"
//   node bin/cli.js topic 6543210
//   node bin/cli.js magnet 6543210
//   node bin/cli.js download 6543210 ./film.torrent
//   node bin/cli.js mirrors

import { writeFile } from 'node:fs/promises';
import { GameLibrary, pingMirrors } from '../src/index.js';

function parseArgs(argv) {
  const positional = [];
  const flags = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : true;
      flags[key] = val;
    } else {
      positional.push(a);
    }
  }
  return { positional, flags };
}

function help() {
  console.log(`game-library — Game Library с поиском и загрузками

Команды:
  search <запрос> [--forum N] [--start N]   поиск по библиотеке
  topic <id>                                детали темы (+ magnet)
  magnet <id>                               только magnet-ссылка
  download <id> [файл.torrent]              скачать .torrent
  mirrors                                   проверить доступность зеркал

Опции:
  --user <логин>     (или env RUTRACKER_USERNAME)
  --pass <пароль>    (или env RUTRACKER_PASSWORD)
  --no-switch        не переключаться на зеркала при сбое
`);
}

async function main() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0];

  if (!command || flags.help || command === 'help') {
    help();
    process.exit(command ? 0 : 1);
  }

  if (command === 'mirrors') {
    const results = await pingMirrors();
    for (const { mirror, available } of results) {
      console.log(`${available ? '✓ доступно ' : '✗ недоступно'}  ${mirror}`);
    }
    return;
  }

  const client = new GameLibrary({
    username: flags.user ?? process.env.RUTRACKER_USERNAME,
    password: flags.pass ?? process.env.RUTRACKER_PASSWORD,
    autoSwitch: flags.switch !== false && !flags['no-switch'],
    logger: (m) => console.error(`· ${m}`),
  });

  await client.login();

  switch (command) {
    case 'search': {
      const query = positional.slice(1).join(' ');
      if (!query) throw new Error('Укажите поисковый запрос');
      const results = await client.search(query, {
        forum: flags.forum,
        start: flags.start ? Number(flags.start) : undefined,
      });
      if (!results.length) {
        console.log('Ничего не найдено.');
        break;
      }
      console.log(`Найдено: ${results.length}\n`);
      for (const r of results) {
        console.log(`[${r.topicId}] ${r.title}`);
        console.log(`    ${r.size} | S:${r.seeds} L:${r.leeches} | скачали: ${r.downloads}`);
        console.log(`    раздел: ${r.forum} | ${r.url}\n`);
      }
      break;
    }

    case 'topic': {
      const id = positional[1];
      if (!id) throw new Error('Укажите id темы');
      const topic = await client.getTopic(id);
      console.log(JSON.stringify(topic, null, 2));
      break;
    }

    case 'magnet': {
      const id = positional[1];
      if (!id) throw new Error('Укажите id темы');
      console.log(await client.getMagnet(id));
      break;
    }

    case 'download': {
      const id = positional[1];
      if (!id) throw new Error('Укажите id темы');
      const out = positional[2] || `${id}.torrent`;
      const buf = await client.downloadTorrent(id);
      await writeFile(out, buf);
      console.log(`Сохранено: ${out} (${buf.length} байт)`);
      break;
    }

    default:
      console.error(`Неизвестная команда: ${command}`);
      help();
      process.exit(1);
  }
}

main().catch((err) => {
  console.error(`Ошибка: ${err.message}`);
  process.exit(1);
});
