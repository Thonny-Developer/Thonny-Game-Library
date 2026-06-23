// Публичный API библиотеки.

export { RutrackerClient, RutrackerClient as GameLibrary } from './client.js';
export { DEFAULT_MIRRORS, checkMirror, pingMirrors } from './mirrors.js';
export {
  RutrackerError,
  AuthError,
  NotAuthenticated,
  AllMirrorsDown,
  ParseError,
} from './errors.js';
export {
  parseSearchResults,
  parseTopic,
  isLoggedIn,
} from './parser.js';
