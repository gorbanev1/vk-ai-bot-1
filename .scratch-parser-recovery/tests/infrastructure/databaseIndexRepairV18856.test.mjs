import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import {
    checkSqliteHealth,
    isIndexOnlySqliteHealthFailure,
    tryRepairIndexOnlyCorruption,
} from '../../src/infrastructure/database/databasePreflight.js';

test('V188.56 classifies only narrow quick_check index diagnostics as index-only', () => {
    assert.equal(isIndexOnlySqliteHealthFailure('wrong # of entries in index sqlite_autoindex_maintenance_state_1; wrong # of entries in index communication_settings_due_idx'), true);
    assert.equal(isIndexOnlySqliteHealthFailure('row 17 missing from index communication_settings_due_idx'), true);
    assert.equal(isIndexOnlySqliteHealthFailure('database disk image is malformed'), false);
    assert.equal(isIndexOnlySqliteHealthFailure('wrong # of entries in index idx; database disk image is malformed'), false);
    assert.equal(isIndexOnlySqliteHealthFailure('non-unique entry in index idx'), false);
});

test('V188.56 does not touch an already healthy database', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v18856-index-'));
    const dbPath = join(root, 'bot.sqlite');
    try {
        const db = new DatabaseSync(dbPath);
        db.exec(`
            CREATE TABLE maintenance_state(key TEXT PRIMARY KEY, value TEXT);
            CREATE TABLE communication_settings(id INTEGER PRIMARY KEY, due_at INTEGER, enabled INTEGER);
            CREATE INDEX communication_settings_due_idx ON communication_settings(due_at, enabled);
            INSERT INTO maintenance_state VALUES ('a', 'b');
            INSERT INTO communication_settings(due_at, enabled) VALUES (1, 1), (2, 0);
        `);
        db.close();
        const before = checkSqliteHealth(dbPath);
        assert.equal(before.ok, true);
        const result = tryRepairIndexOnlyCorruption({ databasePath: dbPath, health: before, logger: { warn() {} } });
        assert.equal(result.attempted, false);
        assert.equal(result.repaired, false);
        assert.equal(checkSqliteHealth(dbPath).ok, true);
    } finally {
        rmSync(root, { recursive: true, force: true });
    }
});
