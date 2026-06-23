// Список зеркал RuTracker и проверка доступности.

/**
 * Официальные зеркала. Контент и аккаунты общие — отличается только домен,
 * поэтому при недоступности одного можно прозрачно перейти на другое.
 */
export const DEFAULT_MIRRORS = [
  'https://rutracker.org',
  'https://rutracker.net',
  'https://rutracker.nl',
];

/**
 * Быстрая проверка живости зеркала: запрашиваем главную форума.
 * Возвращает true, если получили осмысленный ответ (2xx/3xx).
 */
export async function checkMirror(base, { timeout = 8000, userAgent } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const res = await fetch(`${base}/forum/index.php`, {
      method: 'GET',
      redirect: 'manual',
      signal: controller.signal,
      headers: userAgent ? { 'User-Agent': userAgent } : {},
    });
    return res.status > 0 && res.status < 500;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Пингует все зеркала параллельно. Возвращает массив
 * { mirror, available } в исходном порядке.
 */
export async function pingMirrors(mirrors = DEFAULT_MIRRORS, opts = {}) {
  const results = await Promise.all(
    mirrors.map(async (mirror) => ({
      mirror,
      available: await checkMirror(mirror, opts),
    }))
  );
  return results;
}
