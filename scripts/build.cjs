#!/usr/bin/env node
const { mkdir, rm, cp, writeFile, chmod } = require('node:fs/promises');
const { join } = require('node:path');

const rootDir = join(__dirname, '..');
const outDir = join(rootDir, 'dist', 'game-library');

async function copyEntry(name) {
  await cp(join(rootDir, name), join(outDir, name), { recursive: true });
}

async function main() {
  await rm(join(rootDir, 'dist'), { recursive: true, force: true });
  await mkdir(outDir, { recursive: true });

  const entries = [
    'bin',
    'electron',
    'renderer',
    'scripts',
    'src',
    'README.md',
    'package.json',
    'package-lock.json',
    '.gitignore',
  ];

  for (const entry of entries) {
    await copyEntry(entry);
  }

  await cp(join(rootDir, 'node_modules'), join(outDir, 'node_modules'), {
    recursive: true,
  });

  const launcherPath = join(outDir, 'game-library');
  await writeFile(
    launcherPath,
    '#!/usr/bin/env sh\nset -e\ncd "$(dirname "$0")"\nnode scripts/launch.cjs "$@"\n'
  );
  await chmod(launcherPath, 0o755);

  console.log(`Сборка готова: ${outDir}`);
}

main().catch((err) => {
  console.error(`Ошибка сборки: ${err.message}`);
  process.exit(1);
});
