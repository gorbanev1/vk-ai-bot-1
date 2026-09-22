import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { spawnSync } from 'node:child_process';

const root = resolve(new URL('../..', import.meta.url).pathname);
const productionDb = join(root, 'data', 'bot.sqlite');
const databaseModuleUrl = pathToFileURL(join(root, 'src', 'infrastructure', 'database', 'index.js')).href;
const importDatabaseCode = `await import(${JSON.stringify(databaseModuleUrl)})`;
const importDatabaseAndPrintCode = `const m=await import(${JSON.stringify(databaseModuleUrl)}); console.log(m.MAIN_DATABASE_PATH)`;
const before = existsSync(productionDb) ? statSync(productionDb).mtimeMs : null;
const baseEnv = { ...process.env, NODE_ENV: 'test' };
delete baseEnv.GIGORAVE_DATA_DIR;
delete baseEnv.GIGORAVE_DB_PATH;
delete baseEnv.BOT_DB_PATH;

const denied = spawnSync(process.execPath, ['--input-type=module', '-e', importDatabaseCode], {
    cwd: root,
    env: baseEnv,
    encoding: 'utf8',
});
assert.notEqual(denied.status, 0);
assert.match(`${denied.stdout}\n${denied.stderr}`, /Refusing to open the production data\/bot\.sqlite in NODE_ENV=test/u);
assert.equal(existsSync(productionDb) ? statSync(productionDb).mtimeMs : null, before);

const sandbox = mkdtempSync(join(tmpdir(), 'gigorave-db-guard-'));
try {
    const dataDir = join(sandbox, 'data');
    const isolated = spawnSync(process.execPath, ['--input-type=module', '-e', importDatabaseAndPrintCode], {
        cwd: root,
        env: {
            ...baseEnv,
            GIGORAVE_DATA_DIR: dataDir,
            GIGORAVE_DB_PATH: join(dataDir, 'bot.sqlite'),
            GIGORAVE_STATE_DIR: join(sandbox, 'state'),
        },
        encoding: 'utf8',
    });
    assert.equal(isolated.status, 0, isolated.stderr);
    assert.equal(existsSync(join(dataDir, 'bot.sqlite')), true);
    assert.match(isolated.stdout, /bot\.sqlite/u);
} finally {
    rmSync(sandbox, { recursive: true, force: true });
}
