#!/usr/bin/env node
// Запуск приложения. Находит бинарь Electron (из node_modules или системный)
// и стартует его, сбрасывая ELECTRON_RUN_AS_NODE — иначе Electron запускается
// как обычный Node и не предоставляет модуль 'electron'.

const { spawnSync } = require('node:child_process');
const { existsSync } = require('node:fs');
const path = require('node:path');

// 1) Electron, установленный в node_modules (если бинарь докачался корректно).
function fromNodeModules() {
  try {
    const p = require('electron'); // при корректной установке вернёт путь к бинарю
    if (typeof p === 'string' && existsSync(p)) return p;
  } catch {
    /* битый/недокачанный пакет — пробуем системный */
  }
  return null;
}

// 2) Системный Electron (pacman/AUR и т.п.).
function fromSystem() {
  const candidates = [
    'electron39',
    'electron',
    '/usr/bin/electron39',
    '/usr/lib/electron39/electron',
  ];
  for (const c of candidates) {
    if (c.includes('/')) {
      if (existsSync(c)) return c;
    } else {
      const r = spawnSync('sh', ['-c', `command -v ${c}`], { encoding: 'utf8' });
      const out = (r.stdout || '').trim();
      if (out) return out;
    }
  }
  return null;
}

const bin = fromNodeModules() || fromSystem();
if (!bin) {
  console.error(
    'Не найден бинарь Electron.\n' +
      'Установите его одним из способов:\n' +
      '  • npm install electron        (скачает бинарь, нужен доступ к github)\n' +
      '  • системный пакет electron     (например, pacman -S electron на Arch/CachyOS)'
  );
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const appDir = path.resolve(__dirname, '..');
const child = spawnSync(bin, [appDir, ...process.argv.slice(2)], {
  stdio: 'inherit',
  env,
});
process.exit(child.status ?? 0);
