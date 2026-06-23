// Работа с кодировкой windows-1251 — форум RuTracker отдаёт и принимает cp1251.

import iconv from 'iconv-lite';

/** Декодирует тело ответа (Buffer) из cp1251 в строку. */
export function decodeWin1251(buffer) {
  return iconv.decode(buffer, 'win1251');
}

// Незарезервированные символы по RFC 3986 — их не процентируем.
function isUnreserved(byte) {
  return (
    (byte >= 0x30 && byte <= 0x39) || // 0-9
    (byte >= 0x41 && byte <= 0x5a) || // A-Z
    (byte >= 0x61 && byte <= 0x7a) || // a-z
    byte === 0x2d || // -
    byte === 0x2e || // .
    byte === 0x5f || // _
    byte === 0x7e //   ~
  );
}

/**
 * Процентное кодирование строки в cp1251 (а не utf-8, как делает encodeURIComponent).
 * Нужно для поискового параметра nm и тела формы логина с кириллицей.
 */
export function encodeWin1251Component(str) {
  const buf = iconv.encode(String(str), 'win1251');
  let out = '';
  for (const byte of buf) {
    out += isUnreserved(byte)
      ? String.fromCharCode(byte)
      : '%' + byte.toString(16).toUpperCase().padStart(2, '0');
  }
  return out;
}

/** Собирает application/x-www-form-urlencoded строку с cp1251-кодированием. */
export function encodeForm(params) {
  return Object.entries(params)
    .filter(([, v]) => v !== undefined && v !== null)
    .map(([k, v]) => `${encodeWin1251Component(k)}=${encodeWin1251Component(v)}`)
    .join('&');
}
