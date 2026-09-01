/**
 * Minimal entrypoint: deletes obsolete parsed_secrets files without parsing them,
 * loads .env, acquires the single-instance lock and starts the orchestrator.
 */
import { removeLegacyAiSecretFiles } from './features/ai/legacySecretCleanup.js';
import { acquireSingleInstanceLock } from './runtime/singleInstanceLock.js';
import { formatError } from './shared/errors.js';

try {
    removeLegacyAiSecretFiles({ directory: process.cwd(), logger: console });
} catch (error) {
    // Legacy-file cleanup must not prevent startup; the file is never parsed.
    console.error('[AI LEGACY SECRETS CLEANUP ERROR]', formatError(error));
}

await import('dotenv/config');

acquireSingleInstanceLock();

const { startApplication } = await import('./app/botApplication.js');

startApplication().catch((error) => {
    console.error('[STARTUP ERROR]', formatError(error));
    process.exitCode = 1;
});
