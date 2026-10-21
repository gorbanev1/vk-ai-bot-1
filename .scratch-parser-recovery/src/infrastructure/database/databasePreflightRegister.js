import {
    runDatabasePreflight,
    startHealthyBackupScheduler,
} from './databasePreflight.js';

try {
    runDatabasePreflight();
    startHealthyBackupScheduler();
} catch (error) {
    // Last-resort guard: diagnostics must be visible, but the preflight itself
    // must not become a new reason for the bot to die before src/index.js.
    console.error('[DB PREFLIGHT FATAL]', error);
}
