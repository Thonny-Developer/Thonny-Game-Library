// Минимальная «банка» для cookie. Встроенный fetch не хранит cookie между
// запросами и не переносит их через редиректы — делаем это вручную.
// Все запросы клиента в каждый момент идут на одно зеркало, поэтому плоское
// хранилище name -> value достаточно (при смене зеркала выполняется повторный
// вход, который перезапишет bb_session).

export class CookieJar {
  constructor(initial = {}) {
    this.cookies = new Map(Object.entries(initial));
  }

  /** Разбирает массив заголовков Set-Cookie и обновляет хранилище. */
  setFromHeaders(setCookieHeaders = []) {
    for (const raw of setCookieHeaders) {
      const firstPart = raw.split(';')[0];
      const eq = firstPart.indexOf('=');
      if (eq === -1) continue;
      const name = firstPart.slice(0, eq).trim();
      const value = firstPart.slice(eq + 1).trim();
      // Сервер удаляет cookie, выставляя пустое/служебное значение.
      if (value === '' || value === 'deleted') {
        this.cookies.delete(name);
      } else {
        this.cookies.set(name, value);
      }
    }
  }

  /** Значение заголовка Cookie для исходящего запроса. */
  header() {
    return [...this.cookies.entries()].map(([k, v]) => `${k}=${v}`).join('; ');
  }

  get(name) {
    return this.cookies.get(name);
  }

  clear() {
    this.cookies.clear();
  }

  toJSON() {
    return Object.fromEntries(this.cookies);
  }

  static fromJSON(obj) {
    return new CookieJar(obj || {});
  }
}
