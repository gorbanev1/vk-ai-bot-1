/**
 * Минимальный entrypoint: загружает .env, ставит lock и запускает главный orchestrator.
 */
import 'dotenv/config';

import { acquireSingleInstanceLock } from './runtime/singleInstanceLock.js';
import { formatError } from './shared/errors.js';

// Входной файл намеренно маленький. Вся логика приложения находится в
// src/app и тематических модулях, чтобы запуск не превращался в новый монолит.
acquireSingleInstanceLock();

const { startApplication } = await import('./app/botApplication.js');

startApplication().catch((error) => {
    console.error('[STARTUP ERROR]', formatError(error));
    process.exitCode = 1;
});
