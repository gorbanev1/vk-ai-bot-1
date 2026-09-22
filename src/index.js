/**
 * Minimal entrypoint: deletes obsolete parsed_secrets files without parsing them,
 * loads .env, acquires the single-instance lock and starts the orchestrator.
 */
import { removeLegacyAiSecretFiles } from './features/ai/legacySecretCleanup.js';
import { acquireSingleInstanceLock } from './runtime/singleInstanceLock.js';
import { formatError } from './shared/errors.js';
import { clearPreviouslyProcessedLogsV18855, removeRotatedLogsDetachedV18868 } from './runtime/logMaintenanceV18855.js';
import { PROJECT_ROOT } from './infrastructure/database/runtimePaths.js';

try {
    removeLegacyAiSecretFiles({ directory: process.cwd(), logger: console });
} catch (error) {
    // Legacy-file cleanup must not prevent startup; the file is never parsed.
    console.error('[AI LEGACY SECRETS CLEANUP ERROR]', formatError(error));
}

await import('dotenv/config');

acquireSingleInstanceLock();

// Every shipped build establishes a fresh diagnostics boundary on its first
// startup. Same-build restarts keep the new logs. The single-instance lock is
// acquired first so a second process can never erase logs of the live bot.
let logCleanupResult = { rotated: [] };
try {
    logCleanupResult = clearPreviouslyProcessedLogsV18855({ root: PROJECT_ROOT, logger: console });
} catch (error) {
    console.error('[BUILD LOG CLEANUP ERROR]', formatError(error));
}

const { startApplication } = await import('./app/botApplication.js');

startApplication()
    .then(() => {
        // Physical deletion is intentionally detached from readiness. A very
        // large previous log tree must never delay VK/Telegram handlers.
        void removeRotatedLogsDetachedV18868({
            rotated: logCleanupResult?.rotated || [],
            logger: console,
        });
    })
    .catch((error) => {
        console.error('[STARTUP ERROR]', formatError(error));
        process.exitCode = 1;
    });
