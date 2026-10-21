import assert from 'node:assert/strict';
import { mkdtempSync, readdirSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

import {
    checkSqliteHealth,
    createHealthyBackupIfDue,
    HEALTHY_BACKUP_INTERVAL_MS,
    HEALTHY_BACKUP_LIMIT,
    startHealthyBackupScheduler,
} from '../../src/infrastructure/database/databasePreflight.js';

function makeDatabase() {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v18826-backup-'));
    const databasePath = join(dataDirectory, 'bot.sqlite');
    const db = new DatabaseSync(databasePath);
    db.exec('CREATE TABLE sample(id INTEGER PRIMARY KEY, value TEXT); INSERT INTO sample(value) VALUES (\'initial\')');
    db.close();
    return { dataDirectory, databasePath };
}

test('V18826 keeps exactly 15 verified healthy SQLite backups', () => {
    const { dataDirectory, databasePath } = makeDatabase();
    const baseNow = Date.now() - (20 * HEALTHY_BACKUP_INTERVAL_MS);

    for (let i = 0; i < 17; i += 1) {
        const db = new DatabaseSync(databasePath);
        db.prepare('INSERT INTO sample(value) VALUES (?)').run(`row-${i}`);
        db.close();

        const result = createHealthyBackupIfDue({
            databasePath,
            dataDirectory,
            now: baseNow + i * (HEALTHY_BACKUP_INTERVAL_MS + 1_000),
        });
        assert.equal(result.ok, true);
        assert.equal(result.created, true);
        assert.equal(checkSqliteHealth(result.path).ok, true);
    }

    const names = readdirSync(join(dataDirectory, 'healthy-backups'))
        .filter((name) => /^bot-(?:startup|healthy)-.*\.sqlite$/u.test(name));
    assert.equal(HEALTHY_BACKUP_LIMIT, 15);
    assert.equal(names.length, 15);
    for (const name of names) {
        assert.equal(checkSqliteHealth(join(dataDirectory, 'healthy-backups', name)).ok, true);
    }
});

test('V18826 scheduler targets the next backup six hours after the latest healthy snapshot', () => {
    const { dataDirectory, databasePath } = makeDatabase();
    let nowValue = Date.now();
    const initial = createHealthyBackupIfDue({ databasePath, dataDirectory, now: nowValue });
    assert.equal(initial.created, true);

    const scheduled = [];
    const cleared = [];
    const fakeSetTimeout = (callback, delay) => {
        const token = { callback, delay, unref() {} };
        scheduled.push(token);
        return token;
    };
    const fakeClearTimeout = (token) => cleared.push(token);
    const logs = [];
    const logger = {
        log: (...args) => logs.push(args.join(' ')),
        error: (...args) => logs.push(args.join(' ')),
    };

    const scheduler = startHealthyBackupScheduler({
        databasePath,
        dataDirectory,
        logger,
        now: () => nowValue,
        setTimeoutFn: fakeSetTimeout,
        clearTimeoutFn: fakeClearTimeout,
    });

    assert.equal(scheduled.length, 1);
    assert.ok(Math.abs(scheduled[0].delay - HEALTHY_BACKUP_INTERVAL_MS) <= 2_000);

    nowValue += HEALTHY_BACKUP_INTERVAL_MS + 1_000;
    scheduled[0].callback();

    const backups = readdirSync(join(dataDirectory, 'healthy-backups'))
        .filter((name) => /^bot-(?:startup|healthy)-.*\.sqlite$/u.test(name));
    assert.equal(backups.length, 2);
    assert.equal(scheduled.length, 2);
    assert.ok(Math.abs(scheduled[1].delay - HEALTHY_BACKUP_INTERVAL_MS) <= 2_000);
    assert.ok(logs.some((line) => line.includes('retained=15')));

    scheduler.stop();
    assert.equal(cleared.length, 1);
});
