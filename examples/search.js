// Пример использования библиотеки.
// Запуск:
//   RUTRACKER_USERNAME=логин RUTRACKER_PASSWORD=пароль node examples/search.js "kingdom come"

import { GameLibrary } from '../src/index.js';

const query = process.argv.slice(2).join(' ') || 'ubuntu';

const client = new GameLibrary({
  // username / password можно не передавать — подхватятся из окружения.
  autoSwitch: true, // при недоступности зеркала переключится на следующее
  logger: (msg) => console.error(`[game-library] ${msg}`),
});

await client.login();
console.log(`Активное зеркало: ${client.activeMirror}\n`);

const results = await client.search(query);
console.log(`Найдено ${results.length} раздач по запросу «${query}»:\n`);

for (const r of results.slice(0, 10)) {
  console.log(`• ${r.title}`);
  console.log(`  ${r.size}, сидов: ${r.seeds}, id: ${r.topicId}`);
}

if (results.length) {
  const magnet = await client.getMagnet(results[0].topicId);
  console.log(`\nMagnet первой раздачи:\n${magnet}`);
}
