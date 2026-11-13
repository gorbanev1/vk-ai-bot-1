import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const folder = mkdtempSync(join(tmpdir(), 'patrol-modules-isolation-'));
const oldDataDir = process.env.GIGORAVE_DATA_DIR;
const oldDbPath = process.env.GIGORAVE_DB_PATH;
const dbPath = join(folder, 'main.sqlite');
const corePath = join(folder, 'botApplication.js');
process.env.GIGORAVE_DATA_DIR = folder;
process.env.GIGORAVE_DB_PATH = dbPath;
writeFileSync(corePath, 'main bot source stays intact', 'utf8');
const seed = new DatabaseSync(dbPath);
seed.exec("CREATE TABLE messages (id INTEGER PRIMARY KEY, peer_id INTEGER, sender_id INTEGER, conversation_message_id INTEGER, text TEXT, created_at INTEGER); INSERT INTO messages VALUES (1, 2000000038, 17, 41, 'сообщение нужной беседы', 100); INSERT INTO messages VALUES (2, 2000000006, 29, 42, 'секрет другой беседы', 101);");
seed.close();
const runner = await import('../../src/features/ai/vkPatrolModuleRunner.js?isolation-20261111');

test('QuickJS modules can use bounded APIs but cannot access Node, core files, or the database file', async () => {
    const source = [
        'export async function run(api) {',
        "  const rows = await api.db.query('SELECT sender_id, text FROM messages WHERE peer_id = ? ORDER BY created_at DESC LIMIT 5', [2000000038]);",
        '  let nodeImportDenied = false;',
        "  try { await import('node:sqlite'); } catch { nodeImportDenied = true; }",
        '  let pathEscapeDenied = false;',
        "  try { await import('..\\..\\botApplication.js'); } catch { pathEscapeDenied = true; }",
        "  const created = await api.writeModule('created_by_module', 'export async function run() { return \"ready\"; }');",
        '  await Promise.resolve();',
        '  return { rows, nodeImportDenied, pathEscapeDenied, created, asyncWorked: true, processHidden: typeof process === "undefined" };',
        '}',
    ].join('\n');
    runner.writePatrolModule({ name: 'isolation_probe', source });
    const result = await runner.runPatrolModule('isolation_probe', {}, { timeoutMs: 20_000 });
    assert.equal(result.rows.length, 1);
    assert.equal(result.rows[0].text, 'сообщение нужной беседы');
    assert.equal(result.nodeImportDenied, true);
    assert.equal(result.pathEscapeDenied, true);
    assert.equal(result.asyncWorked, true);
    assert.equal(result.processHidden, true);
    assert.equal(readFileSync(corePath, 'utf8'), 'main bot source stays intact');
    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(check.prepare('SELECT count(*) AS n FROM messages').get().n, 2);
    check.close();
    assert.ok(runner.listPatrolModules().some((module) => module.name === 'created_by_module'));
});

test('modules can import sibling modules and replace them without leaving the sandbox directory', async () => {
    runner.writePatrolModule({ name: 'sibling_helper', source: 'export function value() { return 41; }' });
    runner.writePatrolModule({ name: 'sibling_import_probe', source: "import { value } from './sibling_helper.mjs'; export async function run(api) { await api.writeModule('sibling_helper', 'export function value() { return 42; }'); return value(); }" });
    const result = await runner.runPatrolModule('sibling_import_probe');
    assert.equal(result, 41);
    assert.match(readFileSync(join(runner.PATROL_MODULES_DIRECTORY, 'sibling_helper.mjs'), 'utf8'), /return 42/u);
});

test('read query API rejects writes and metadata access', async () => {
    runner.writePatrolModule({
        name: 'query_attack',
        source: String.raw`export async function run(api) { let writeDenied = false; try { await api.db.query("INSERT INTO messages VALUES (3, 2000000038, 1, 43, 'bad', 102)"); } catch { writeDenied = true; } let schemaDenied = false; try { await api.db.query('SELECT * FROM sqlite_master'); } catch { schemaDenied = true; } return { writeDenied, schemaDenied }; }`,
    });
    const result = await runner.runPatrolModule('query_attack', {}, { timeoutMs: 20_000 });
    assert.equal(result.writeDenied, true);
    assert.equal(result.schemaDenied, true);
    const check = new DatabaseSync(dbPath, { readOnly: true });
    assert.equal(check.prepare('SELECT count(*) AS n FROM messages').get().n, 2);
    check.close();
});

test('module names and source sizes are bounded to the isolated directory', () => {
    assert.throws(() => runner.writePatrolModule({ name: '../bot', source: 'export function run() { return 1; }' }), /Имя модуля/u);
    assert.throws(() => runner.writePatrolModule({ name: 'large', source: 'x'.repeat(256 * 1024 + 1) }), /Размер кода/u);
});

test.after(() => {
    if (oldDataDir === undefined) delete process.env.GIGORAVE_DATA_DIR;
    else process.env.GIGORAVE_DATA_DIR = oldDataDir;
    if (oldDbPath === undefined) delete process.env.GIGORAVE_DB_PATH;
    else process.env.GIGORAVE_DB_PATH = oldDbPath;
    rmSync(folder, { recursive: true, force: true });
});
