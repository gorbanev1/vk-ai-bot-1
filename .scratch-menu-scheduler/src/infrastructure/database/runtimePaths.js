import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const moduleDirectory = dirname(fileURLToPath(import.meta.url));
export const PROJECT_ROOT = resolve(moduleDirectory, '..', '..', '..');
export const DEFAULT_DATA_DIRECTORY = join(PROJECT_ROOT, 'data');
export const DEFAULT_DATABASE_PATH = join(DEFAULT_DATA_DIRECTORY, 'bot.sqlite');
export const DEFAULT_QTICKETS_DATABASE_PATH = join(DEFAULT_DATA_DIRECTORY, 'qtickets.sqlite');

export function resolveRuntimeDataDirectory(env = process.env) {
    const explicit = String(env?.GIGORAVE_DATA_DIR ?? '').trim();
    if (explicit) return resolve(explicit);
    const explicitDatabase = String(env?.GIGORAVE_DB_PATH ?? env?.BOT_DB_PATH ?? '').trim();
    if (explicitDatabase) return dirname(resolve(explicitDatabase));
    return DEFAULT_DATA_DIRECTORY;
}

export function resolveMainDatabasePath(env = process.env) {
    const explicit = String(env?.GIGORAVE_DB_PATH ?? env?.BOT_DB_PATH ?? '').trim();
    return explicit ? resolve(explicit) : join(resolveRuntimeDataDirectory(env), 'bot.sqlite');
}

export function resolveQticketsDatabasePath(env = process.env) {
    const explicit = String(env?.QTICKETS_DB_PATH ?? '').trim();
    return explicit ? resolve(explicit) : join(resolveRuntimeDataDirectory(env), 'qtickets.sqlite');
}

export function assertTestDatabaseIsolation({
    env = process.env,
    databasePath = resolveMainDatabasePath(env),
    productionPath = DEFAULT_DATABASE_PATH,
    argv = process.argv,
} = {}) {
    const likelyTestProcess = String(env?.NODE_ENV ?? '').trim().toLowerCase() === 'test'
        || Boolean(String(env?.NODE_TEST_CONTEXT ?? '').trim())
        || (Array.isArray(argv) && argv.some((value) => /(?:^|[\/])tests[\/]/u.test(String(value ?? ''))));
    if (!likelyTestProcess) return;
    const resolved = resolve(databasePath);
    const production = resolve(productionPath);
    const explicitIsolation = Boolean(
        String(env?.GIGORAVE_DB_PATH ?? env?.BOT_DB_PATH ?? '').trim()
        || String(env?.QTICKETS_DB_PATH ?? '').trim()
        || String(env?.GIGORAVE_DATA_DIR ?? '').trim(),
    );
    if (!explicitIsolation || resolved === production) {
        throw new Error(
            'Refusing to open the production data/bot.sqlite in NODE_ENV=test. ' +
            'Set GIGORAVE_DATA_DIR or GIGORAVE_DB_PATH to a temporary test location.',
        );
    }
}
