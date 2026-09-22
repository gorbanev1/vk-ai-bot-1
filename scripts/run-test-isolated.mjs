import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const files = process.argv.slice(2);
if (!files.length) {
    console.error('Usage: node scripts/run-test-isolated.mjs <test-file> [...]');
    process.exit(2);
}

const sandbox = mkdtempSync(join(tmpdir(), 'gigorave-test-'));
const dataDir = join(sandbox, 'data');
const stateDir = join(sandbox, 'state');
const env = {
    ...process.env,
    NODE_ENV: 'test',
    GIGORAVE_DATA_DIR: dataDir,
    GIGORAVE_TEXT_DATA_DIR: dataDir,
    GIGORAVE_DB_PATH: join(dataDir, 'bot.sqlite'),
    GIGORAVE_STATE_DIR: stateDir,
};

console.log(`[TEST ISOLATION] data=${dataDir}`);
const result = spawnSync(process.execPath, ['--test', '--test-concurrency=1', ...files], {
    cwd: root,
    env,
    stdio: 'inherit',
});

if (!process.env.GIGORAVE_KEEP_TEST_DATA) {
    rmSync(sandbox, { recursive: true, force: true });
} else {
    console.log(`[TEST ISOLATION] kept=${sandbox}`);
}
process.exit(result.status ?? 1);
