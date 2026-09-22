import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    LOG_CLEANUP_BUILD_V18855,
    LOG_CLEANUP_MARKER_V18855,
    clearPreviouslyProcessedLogsV18855,
    removeRotatedLogsDetachedV18868,
} from '../../src/runtime/logMaintenanceV18855.js';

function put(path, text='x') {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, text, 'utf8');
}

test('V188.68 atomically rotates only volatile processed logs and preserves databases/backups/journals', async () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v18855-'));
    put(join(root, 'data/logs/operations/old.jsonl'));
    put(join(root, 'data/logs/manual-parser/run/trace.jsonl'));
    put(join(root, 'data/audit/media/op/errors.jsonl'));
    put(join(root, 'data/ai-token-usage/2026-09-13.jsonl'));
    put(join(root, 'data/event-ingest-audit.jsonl'));
    put(join(root, 'AI_FULL_AUDIT_RESULTS/old/result.json'));
    put(join(root, 'GRAPHICS_MATRIX_RESULTS/old/result.json'));

    // Never-delete state.
    put(join(root, 'data/bot.sqlite'), 'db');
    put(join(root, 'data/bot.sqlite-wal'), 'wal');
    put(join(root, 'data/live-message-journal.jsonl'), 'journal');
    put(join(root, 'data/vk-message-archive-journal.jsonl'), 'archive-journal');
    put(join(root, 'data/healthy-backups/bot-healthy.sqlite'), 'healthy');
    put(join(root, 'data/corruption-backups/bot-corrupt.sqlite'), 'corrupt');
    put(join(root, 'data/operation-checkpoints/op.json'), 'checkpoint');

    const result = clearPreviouslyProcessedLogsV18855({ root, logger: { log() {}, warn() {} } });
    assert.equal(result.skipped, false);
    assert.equal(result.errors.length, 0);

    assert.equal(existsSync(join(root, 'data/logs')), true, 'fresh active log root must exist immediately');
    assert.equal(existsSync(join(root, 'data/logs/operations/old.jsonl')), false);
    assert.equal(existsSync(join(root, 'data/audit/media')), false);
    assert.equal(existsSync(join(root, 'data/ai-token-usage')), false);
    assert.equal(existsSync(join(root, 'data/event-ingest-audit.jsonl')), false);
    assert.equal(existsSync(join(root, 'AI_FULL_AUDIT_RESULTS')), false);
    assert.equal(existsSync(join(root, 'GRAPHICS_MATRIX_RESULTS')), false);

    for (const rel of [
        'data/bot.sqlite',
        'data/bot.sqlite-wal',
        'data/live-message-journal.jsonl',
        'data/vk-message-archive-journal.jsonl',
        'data/healthy-backups/bot-healthy.sqlite',
        'data/corruption-backups/bot-corrupt.sqlite',
        'data/operation-checkpoints/op.json',
    ]) {
        assert.equal(existsSync(join(root, rel)), true, `${rel} must be preserved`);
    }

    assert.ok(result.rotated.length >= 1, 'old volatile paths should be rotated');
    for (const item of result.rotated) assert.equal(existsSync(item.path), true, `rotated path must exist before detached delete: ${item.relativePath}`);

    const detached = await removeRotatedLogsDetachedV18868({ rotated: result.rotated, logger: { log() {}, warn() {} } });
    assert.equal(detached.errors.length, 0);
    for (const item of result.rotated) assert.equal(existsSync(item.path), false, `rotated path must be deleted after readiness: ${item.relativePath}`);

    const markerPath = join(root, 'data', LOG_CLEANUP_MARKER_V18855);
    assert.equal(existsSync(markerPath), true);
    const marker = JSON.parse(readFileSync(markerPath, 'utf8'));
    assert.equal(marker.build, LOG_CLEANUP_BUILD_V18855);
});

test('V188.55 cleanup is one-time by default so restart keeps fresh logs', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v18855-restart-'));
    put(join(root, 'data/logs/operations/old.jsonl'));
    clearPreviouslyProcessedLogsV18855({ root, logger: { log() {}, warn() {} } });

    put(join(root, 'data/logs/operations/current.jsonl'), 'fresh');
    const second = clearPreviouslyProcessedLogsV18855({ root, logger: { log() {}, warn() {} } });
    assert.equal(second.skipped, true);
    assert.equal(readFileSync(join(root, 'data/logs/operations/current.jsonl'), 'utf8'), 'fresh');
});

test('V188.68 can be explicitly forced without touching state', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v18855-force-'));
    clearPreviouslyProcessedLogsV18855({ root, logger: { log() {}, warn() {} } });
    put(join(root, 'data/logs/operations/current.jsonl'), 'fresh');
    put(join(root, 'data/bot.sqlite'), 'db');
    const forced = clearPreviouslyProcessedLogsV18855({ root, force: true, logger: { log() {}, warn() {} } });
    assert.equal(forced.skipped, false);
    assert.equal(existsSync(join(root, 'data/logs/operations/current.jsonl')), false);
    assert.equal(existsSync(join(root, 'data/logs')), true);
    assert.equal(readFileSync(join(root, 'data/bot.sqlite'), 'utf8'), 'db');
});


test('build-scoped cleanup clears old logs again when release identity changes', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-build-log-boundary-'));
    put(join(root, 'data/logs/operations/old.jsonl'), 'old');
    clearPreviouslyProcessedLogsV18855({
        root,
        build: 'events-v18867-build-a',
        logger: { log() {}, warn() {} },
    });

    put(join(root, 'data/logs/operations/build-a.jsonl'), 'current-a');
    const sameBuild = clearPreviouslyProcessedLogsV18855({
        root,
        build: 'events-v18867-build-a',
        logger: { log() {}, warn() {} },
    });
    assert.equal(sameBuild.skipped, true);
    assert.equal(existsSync(join(root, 'data/logs/operations/build-a.jsonl')), true);

    const nextBuild = clearPreviouslyProcessedLogsV18855({
        root,
        build: 'events-v18868-build-b',
        logger: { log() {}, warn() {} },
    });
    assert.equal(nextBuild.skipped, false);
    assert.equal(existsSync(join(root, 'data/logs/operations/build-a.jsonl')), false);
    assert.equal(readFileSync(join(root, 'data', LOG_CLEANUP_MARKER_V18855), 'utf8').includes('events-v18868-build-b'), true);
});
