import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
    mergeReadableHistoryIntoRestoredBackup,
} from '../../src/infrastructure/database/databasePreflight.js';

function createMessageDb(path, rows) {
    const db = new DatabaseSync(path);
    db.exec(`
        PRAGMA journal_mode = DELETE;
        CREATE TABLE messages (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            peer_id INTEGER NOT NULL,
            sender_id INTEGER NOT NULL,
            conversation_message_id INTEGER NOT NULL,
            text TEXT NOT NULL,
            created_at INTEGER NOT NULL,
            UNIQUE (peer_id, conversation_message_id)
        );
    `);
    const insert = db.prepare(`
        INSERT INTO messages(peer_id, sender_id, conversation_message_id, text, created_at)
        VALUES (?, ?, ?, ?, ?)
    `);
    for (const row of rows) insert.run(row.peer ?? 1, 10, row.cmi, row.text, row.createdAt);
    db.close();
}

function readRows(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    const rows = db.prepare(`
        SELECT peer_id, conversation_message_id, text
        FROM messages
        ORDER BY peer_id, conversation_message_id
    `).all();
    db.close();
    return rows.map((row) => ({
        peer: Number(row.peer_id),
        cmi: Number(row.conversation_message_id),
        text: String(row.text),
    }));
}

function quietLogger() {
    return { log() {}, warn() {}, error() {} };
}

test('V188.53 restored backup keeps its rows and merges readable quarantine-only history', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v18853-restore-merge-'));
    const restored = join(root, 'bot.sqlite');
    const quarantined = join(root, 'quarantined.sqlite');
    const work = join(root, 'work');
    mkdirSync(work, { recursive: true });

    createMessageDb(restored, [
        { cmi: 1, text: 'backup authoritative 1', createdAt: 100 },
        { cmi: 2, text: 'backup authoritative 2', createdAt: 200 },
    ]);
    createMessageDb(quarantined, [
        { cmi: 1, text: 'older/conflicting copy must not overwrite backup', createdAt: 100 },
        { cmi: 2, text: 'same key', createdAt: 200 },
        { cmi: 3, text: 'readable tail 3', createdAt: 300 },
        { cmi: 4, text: 'readable tail 4', createdAt: 400 },
    ]);

    const result = mergeReadableHistoryIntoRestoredBackup({
        databasePath: restored,
        quarantinedDatabasePath: quarantined,
        workingDirectory: work,
        logger: quietLogger(),
    });

    assert.equal(result.merged, true);
    assert.deepEqual(readRows(restored), [
        { peer: 1, cmi: 1, text: 'backup authoritative 1' },
        { peer: 1, cmi: 2, text: 'backup authoritative 2' },
        { peer: 1, cmi: 3, text: 'readable tail 3' },
        { peer: 1, cmi: 4, text: 'readable tail 4' },
    ]);
    assert.deepEqual(readRows(quarantined).map((row) => row.cmi), [1, 2, 3, 4], 'quarantine must stay untouched');
});

test('V188.53 full-history audit detects rows missing from active across older local snapshots', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v18853-history-audit-'));
    const data = join(root, 'data');
    const healthy = join(data, 'healthy-backups');
    const corruption = join(data, 'corruption-backups', 'old');
    mkdirSync(healthy, { recursive: true });
    mkdirSync(corruption, { recursive: true });

    createMessageDb(join(data, 'bot.sqlite'), [
        { cmi: 1, text: 'active 1', createdAt: 100 },
        { cmi: 4, text: 'active tail 4', createdAt: 400 },
    ]);
    createMessageDb(join(healthy, 'bot-healthy-old.sqlite'), [
        { cmi: 1, text: 'old 1', createdAt: 100 },
        { cmi: 2, text: 'missing old 2', createdAt: 200 },
    ]);
    createMessageDb(join(corruption, 'bot.sqlite'), [
        { cmi: 1, text: 'old 1', createdAt: 100 },
        { cmi: 2, text: 'missing old 2', createdAt: 200 },
        { cmi: 3, text: 'missing old 3 only here', createdAt: 300 },
    ]);

    const script = resolve('scripts/audit-db-history-coverage.mjs');
    const run = spawnSync(process.execPath, [script, data], {
        cwd: resolve('.'),
        encoding: 'utf8',
    });
    assert.equal(run.status, 2, `${run.stdout}\n${run.stderr}`);
    assert.match(run.stdout, /ACTIVE_MISSING_READABLE_LOCAL_HISTORY/u);
    assert.match(run.stdout, /missingUnique=2/u);

    const auditRoot = join(data, 'recovery-audit');
    const latest = readdirSync(auditRoot).sort().at(-1);
    const report = JSON.parse(readFileSync(join(auditRoot, latest, 'history-coverage.json'), 'utf8'));
    assert.equal(report.totalMissingUniqueRows, 2);
    const messages = report.tables.find((table) => table.table === 'messages');
    assert.equal(messages.missingUniqueRows, 2);
    assert.deepEqual(messages.missingByPeer, { 1: 2 });
});
