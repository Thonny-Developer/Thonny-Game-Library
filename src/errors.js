// Иерархия ошибок клиента RuTracker.

export class RutrackerError extends Error {
  constructor(message) {
    super(message);
    this.name = this.constructor.name;
  }
}

/** Неверный логин/пароль или требуется капча. */
export class AuthError extends RutrackerError {}

/** Действие требует выполненного входа. */
export class NotAuthenticated extends RutrackerError {}

/** Ни одно зеркало не ответило. */
export class AllMirrorsDown extends RutrackerError {}

/** Не удалось разобрать ответ сервера. */
export class ParseError extends RutrackerError {}
