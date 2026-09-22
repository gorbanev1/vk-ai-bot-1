import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';
import { tmpdir } from 'node:os';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('..', import.meta.url).pathname);
const testRoot = join(root, 'tests');

function collect(directory) {
    const output = [];
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
        const absolute = join(directory, entry.name);
        if (entry.isDirectory()) output.push(...collect(absolute));
        else if (/\.test\.(?:mjs|js|cjs)$/u.test(entry.name)) output.push(absolute);
    }
    return output;
}

const files = collect(testRoot).sort((a, b) => a.localeCompare(b, 'en'));
let failed = 0;
const startedAt = Date.now();
console.log(`[ALL TESTS] files=${files.length} mode=sequential`);

for (let index = 0; index < files.length; index += 1) {
    const file = files[index];
    const label = relative(root, file).replaceAll('\\', '/');
    console.log(`\n[ALL TESTS ${index + 1}/${files.length}] ${label}`);
    const sandbox = mkdtempSync(join(tmpdir(), 'gigorave-legacy-test-'));
    const dataDir = join(sandbox, 'data');
    const stateDir = join(sandbox, 'state');
    const result = spawnSync(process.execPath, ['--test', file], {
        cwd: root,
        env: {
            ...process.env,
            NODE_ENV: 'test',
            GIGORAVE_DATA_DIR: dataDir,
            GIGORAVE_DB_PATH: join(dataDir, 'bot.sqlite'),
            GIGORAVE_STATE_DIR: stateDir,
        },
        stdio: 'inherit',
    });
    if (!process.env.GIGORAVE_KEEP_TEST_DATA) {
        rmSync(sandbox, { recursive: true, force: true });
    }
    if (result.status !== 0) {
        failed += 1;
        console.error(`[ALL TESTS FAILED] ${label} exit=${result.status ?? 'signal'}`);
    }
}

const durationSeconds = ((Date.now() - startedAt) / 1000).toFixed(1);
console.log(`\n[ALL TESTS SUMMARY] files=${files.length} failed=${failed} duration=${durationSeconds}s`);
if (failed) process.exitCode = 1;
