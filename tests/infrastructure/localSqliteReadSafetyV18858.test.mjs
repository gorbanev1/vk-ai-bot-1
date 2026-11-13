import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import {DatabaseSync} from 'node:sqlite';
import {performance} from 'node:perf_hooks';
import {createRecoveredVkMessageBatchWriter} from '../../src/features/history/recoveredVkMessageBatch.js';
import {getLocalSqliteBackupInventoryFingerprintAsync} from '../../src/features/history/localSqliteHistoryRecovery.js';

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

test('startup local SQLite inventory and coverage helpers yield while preserving fingerprint values', async () => {
    const source = await readFile(new URL('../../src/features/history/localSqliteHistoryRecovery.js', import.meta.url), 'utf8');
    assert.match(source, /getLocalSqliteBackupInventoryFingerprintAsync/u);
    assert.match(source, /getActiveMessageCoverageFingerprintAsync/u);
    assert.match(source, /await yieldToEventLoop()/u);
});

test('recovered VK message pages write both stores transactionally and roll back together', () => {
    const database = new DatabaseSync(':memory:');
    database.exec('CREATE TABLE messages (peer_id INTEGER, source_peer_id INTEGER, cmid INTEGER, sender_id INTEGER, created_at INTEGER, text TEXT); CREATE TABLE archive (peer_id INTEGER, source_peer_id INTEGER, cmid INTEGER, sender_id INTEGER, created_at INTEGER, text TEXT);');
    const insert = database.prepare('INSERT INTO messages VALUES (?, ?, ?, ?, ?, ?)');
    const archive = database.prepare('INSERT INTO archive VALUES (?, ?, ?, ?, ?, ?)');
    const writer = createRecoveredVkMessageBatchWriter({
        database,
        insertMessage(row) { assert.equal(database.isTransaction, true); insert.run(row.peerId,row.sourcePeerId,row.conversationMessageId,row.senderId,row.createdAt,row.text); },
        saveArchive(row) { if (row.text === 'fail') throw new Error('simulated archive failure'); archive.run(row.peerId,row.sourcePeerId,row.conversationMessageId,row.senderId,row.createdAt,row.text); },
    });
    const rows=[
        {peerId:2000000006,sourcePeerId:2000000006,conversationMessageId:81,senderId:7,createdAt:1700000001,text:'recover one'},
        {peerId:2000000006,sourcePeerId:2000000002,conversationMessageId:82,senderId:8,createdAt:1700000002,text:'recover two'},
    ];
    assert.equal(writer(rows),2);
    assert.equal(database.prepare('SELECT count(*) AS n FROM messages').get().n,2);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archive').get().n,2);
    assert.throws(()=>writer([{...rows[0],conversationMessageId:83,text:'fail'}]),/simulated archive failure/u);
    assert.equal(database.prepare('SELECT count(*) AS n FROM messages').get().n,2);
    assert.equal(database.prepare('SELECT count(*) AS n FROM archive').get().n,2);
    database.close();
});

test('async SQLite inventory streams very large directories without blocking timer turns', async () => {
    const originalDir = await import('../../src/features/history/localSqliteHistoryRecovery.js');
    // The repository's runtime data directory contains a very large checkpoint
    // folder. Measure the exact startup fingerprint helper against that real tree.
    let last = performance.now();
    let maxGap = 0;
    const timer = setInterval(() => {
        const now = performance.now();
        maxGap = Math.max(maxGap, now - last);
        last = now;
    }, 10);
    try {
        const result = await originalDir.getLocalSqliteBackupInventoryFingerprintAsync();
        assert.ok(result.files > 0);
        const source = await readFile(new URL('../../src/features/history/localSqliteHistoryRecovery.js', import.meta.url), 'utf8');
        assert.ok(source.includes('excludedDirectoryNames.includes(entry.name)'));
        assert.ok(source.includes("excludedDirectoryNames = ['operation-checkpoints']"));
        assert.ok(maxGap < 250, 'directory inventory should yield within a few scheduler turns');
    } finally {
        clearInterval(timer);
    }
});
