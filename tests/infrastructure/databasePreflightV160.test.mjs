import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync, existsSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
    checkSqliteHealth,
    runDatabasePreflight,
} from '../../src/infrastructure/database/databasePreflight.js';

function silentLogger() {
    return { log() {}, warn() {}, error() {} };
}

test('V160 keeps a healthy SQLite database intact', () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v160-healthy-'));
    const databasePath = join(dataDirectory, 'bot.sqlite');
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES (\'kept\')');
    db.close();

    const result = runDatabasePreflight({ databasePath, dataDirectory, now: 1_900_000_000_000, logger: silentLogger() });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'healthy');
    assert.equal(checkSqliteHealth(databasePath).ok, true);

    const check = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(check.prepare('SELECT value FROM sample').get().value, 'kept');
    check.close();
    assert.ok(existsSync(join(dataDirectory, 'healthy-backups')));
});

test('V160 quarantines a malformed bot.sqlite and leaves a bootable database', () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v160-corrupt-'));
    const databasePath = join(dataDirectory, 'bot.sqlite');
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES (\'before corruption\')');
    db.close();

    const bytes = readFileSync(databasePath);
    bytes.fill(0, 0, Math.min(128, bytes.length));
    writeFileSync(databasePath, bytes);
    assert.equal(checkSqliteHealth(databasePath).ok, false);

    const result = runDatabasePreflight({ databasePath, dataDirectory, now: 1_900_000_000_100, logger: silentLogger() });
    assert.equal(result.ok, true);
    assert.equal(result.action, 'salvaged-or-fresh');
    assert.equal(checkSqliteHealth(databasePath).ok, true);
    assert.ok(existsSync(result.corruptionDirectory));
    assert.ok(readdirSync(result.corruptionDirectory).some((name) => name === 'bot.sqlite'));

    const boot = new DatabaseSync(databasePath);
    boot.exec('CREATE TABLE IF NOT EXISTS startup_probe(id INTEGER PRIMARY KEY)');
    boot.close();
});

test('V160 uses the latest healthy backup when the active DB is malformed', () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v160-restore-'));
    const databasePath = join(dataDirectory, 'bot.sqlite');
    let db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES (\'backup value\')');
    db.close();

    runDatabasePreflight({ databasePath, dataDirectory, now: 1_900_000_000_000, logger: silentLogger() });

    const bytes = readFileSync(databasePath);
    bytes.fill(0, 0, Math.min(128, bytes.length));
    writeFileSync(databasePath, bytes);

    const result = runDatabasePreflight({ databasePath, dataDirectory, now: 1_900_000_100_000, logger: silentLogger() });
    assert.equal(result.action, 'restored-backup');
    db = new DatabaseSync(databasePath, { readOnly: true });
    assert.equal(db.prepare('SELECT value FROM sample').get().value, 'backup value');
    db.close();
});
