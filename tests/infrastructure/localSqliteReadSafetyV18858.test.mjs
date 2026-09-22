import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

test('V188.58: forensic SQLite snapshots are never reopened writable in place', async () => {
    const source = await readFile(new URL('../../src/features/history/localSqliteHistoryRecovery.js', import.meta.url), 'utf8');
    assert.match(source, /new DatabaseSync\(path, \{ readOnly: true \}\)/u);
    assert.match(source, /copySqliteFamilyToTemporaryDirectory/u);
    assert.match(source, /for \(const suffix of \['-wal', '-shm'\]\)/u);
    assert.match(source, /new DatabaseSync\(temporary\.destinationPath\)/u);
    assert.match(source, /rmSync\(temporary\.directory, \{ recursive: true, force: true \}\)/u);
    assert.match(source, /PRAGMA query_only = ON; PRAGMA temp_store = MEMORY/u);
});

test('V188.58: local history merge query avoids unnecessary ORDER BY temp writes', async () => {
    const source = await readFile(new URL('../../src/features/history/localSqliteHistoryRecovery.js', import.meta.url), 'utf8');
    const start = Math.max(
        source.indexOf('export async function recoverHistoryFromLocalSqliteBackups'),
        source.indexOf('export function recoverHistoryFromLocalSqliteBackups'),
    );
    const end = source.indexOf('export function getLocalSqlitePeerCmidBounds', start);
    const recovery = source.slice(start, end);
    assert.doesNotMatch(recovery, /ORDER BY created_at ASC, id ASC/u);
    assert.match(recovery, /FROM messages NOT INDEXED/u);
});
