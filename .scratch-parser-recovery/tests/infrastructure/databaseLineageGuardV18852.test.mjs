import assert from 'node:assert/strict';
import {
    copyFileSync,
    existsSync,
    mkdirSync,
    mkdtempSync,
    readdirSync,
    rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
    buildHistoricalRecoveryCandidate,
    compareDatabaseLineage,
} from '../../src/infrastructure/database/databaseLineageGuard.js';
import {
    createHealthyBackupIfDue,
    HEALTHY_BACKUP_INTERVAL_MS,
    runDatabasePreflight,
} from '../../src/infrastructure/database/databasePreflight.js';

function silentLogger() {
    return { log() {}, warn() {}, error() {} };
}

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
    for (const row of rows) {
        insert.run(1, row.sender ?? 10, row.cmi, row.text, row.createdAt);
    }
    db.close();
}

function readCmis(path) {
    const db = new DatabaseSync(path, { readOnly: true });
    const values = db.prepare('SELECT conversation_message_id FROM messages ORDER BY conversation_message_id').all()
        .map((row) => Number(row.conversation_message_id));
    db.close();
    return values;
}

function makeOverwriteScenario() {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v18852-lineage-'));
    const databasePath = join(dataDirectory, 'bot.sqlite');
    const fullRows = [
        { cmi: 1, text: 'old-1', createdAt: 100 },
        { cmi: 2, text: 'old-2', createdAt: 200 },
        { cmi: 3, text: 'must-survive-3', createdAt: 300 },
        { cmi: 4, text: 'must-survive-4', createdAt: 400 },
    ];
    createMessageDb(databasePath, fullRows);

    const baseNow = Date.now() - (HEALTHY_BACKUP_INTERVAL_MS * 2);
    const initial = createHealthyBackupIfDue({ databasePath, dataDirectory, now: baseNow });
    assert.equal(initial.ok, true);
    assert.equal(initial.created, true);
    const backupPath = initial.path;

    rmSync(databasePath, { force: true });
    createMessageDb(databasePath, [
        { cmi: 1, text: 'old-1', createdAt: 100 },
        { cmi: 2, text: 'old-2', createdAt: 200 },
        // These arrived only AFTER an older DB was accidentally put in place.
        { cmi: 5, text: 'new-after-overwrite-5', createdAt: 500 },
        { cmi: 6, text: 'new-after-overwrite-6', createdAt: 600 },
    ]);

    return { dataDirectory, databasePath, backupPath, baseNow };
}

test('V188.52 lineage comparison does not let new tail hide missing backup history', () => {
    const { databasePath, backupPath } = makeOverwriteScenario();
    const report = compareDatabaseLineage({
        activeDatabasePath: databasePath,
        backupDatabasePath: backupPath,
    });

    assert.equal(report.regressed, true);
    assert.equal(report.verdict, 'ACTIVE_DB_MISSING_BACKUP_HISTORY');
    assert.equal(report.backupOnlyRows, 2);
    assert.equal(report.activeOnlyRows, 2);
    assert.equal(report.activeOnlyTailRows, 2);
    assert.equal(report.activeOnlyHistoricalRows, 0);

    const messages = report.tables.find((item) => item.table === 'messages');
    assert.equal(messages.backupOnlyRows, 2);
    assert.equal(messages.activeOnlyTailRows, 2);
});

test('V188.52 blocks a new healthy backup from blessing an overwritten-but-valid DB', () => {
    const { dataDirectory, databasePath, baseNow } = makeOverwriteScenario();
    const before = readdirSync(join(dataDirectory, 'healthy-backups')).length;

    const result = createHealthyBackupIfDue({
        databasePath,
        dataDirectory,
        now: baseNow + (HEALTHY_BACKUP_INTERVAL_MS * 3),
    });

    const after = readdirSync(join(dataDirectory, 'healthy-backups')).length;
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'lineage-regression');
    assert.equal(result.lineage.report.backupOnlyRows, 2);
    assert.equal(result.lineage.report.activeOnlyTailRows, 2);
    assert.equal(after, before, 'must not create a healthy backup from regressed active DB');
});

test('V188.52 preflight reports lineage regression without overwriting the live DB', () => {
    const { dataDirectory, databasePath } = makeOverwriteScenario();
    const result = runDatabasePreflight({
        databasePath,
        dataDirectory,
        now: Date.now(),
        logger: silentLogger(),
    });

    assert.equal(result.ok, true);
    assert.equal(result.action, 'healthy-lineage-regression');
    assert.deepEqual(readCmis(databasePath), [1, 2, 5, 6]);
});

test('V188.52 recovery candidate keeps new live tail and restores missing backup rows', () => {
    const { dataDirectory, databasePath, backupPath } = makeOverwriteScenario();
    const candidateDatabasePath = join(dataDirectory, 'recovery-candidates', 'candidate.sqlite');
    mkdirSync(join(dataDirectory, 'recovery-candidates'), { recursive: true });

    const result = buildHistoricalRecoveryCandidate({
        activeDatabasePath: databasePath,
        backupDatabasePath: backupPath,
        candidateDatabasePath,
    });

    assert.equal(existsSync(candidateDatabasePath), true);
    assert.equal(result.valid, true);
    assert.equal(result.lineage.backupOnlyRows, 0);
    assert.equal(result.lineage.activeOnlyTailRows, 2);
    assert.deepEqual(readCmis(candidateDatabasePath), [1, 2, 3, 4, 5, 6]);
    // Critical safety invariant: candidate generation never modifies the live DB.
    assert.deepEqual(readCmis(databasePath), [1, 2, 5, 6]);
});

test('V188.52 comparison works against an explicit copied healthy backup', () => {
    const { dataDirectory, databasePath, backupPath } = makeOverwriteScenario();
    const copied = join(dataDirectory, 'backup-copy.sqlite');
    copyFileSync(backupPath, copied);
    const report = compareDatabaseLineage({ activeDatabasePath: databasePath, backupDatabasePath: copied });
    assert.equal(report.backupOnlyRows, 2);
    assert.equal(report.activeOnlyTailRows, 2);
});
