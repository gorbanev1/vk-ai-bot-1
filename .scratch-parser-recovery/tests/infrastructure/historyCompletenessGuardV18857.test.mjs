import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    createLocalHistoryCheckpointSignature,
    parseLocalHistoryCheckpointSignature,
    validateLocalHistoryCheckpoint,
} from '../../src/features/history/localHistoryCheckpoint.js';
import { parseVkHistoryPullCommand } from '../../src/features/history/vkHistoryPullPolicy.js';

const appSource = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const localRecoverySource = await readFile(new URL('../../src/features/history/localSqliteHistoryRecovery.js', import.meta.url), 'utf8');

const peerIds = [2000000002, 2000000006];
const storedSignature = createLocalHistoryCheckpointSignature({
    peerIds,
    sourceInventoryHash: 'inventory-a',
    coverageMaxCmid: 50000,
    coverageMessageCount: 49000,
    coverageHash: 'history-hash-a',
});

test('V188.57 rejects legacy count-only history checkpoints', () => {
    assert.equal(parseLocalHistoryCheckpointSignature(JSON.stringify(peerIds)), null);
    const result = validateLocalHistoryCheckpoint({
        storedSignature: JSON.stringify(peerIds),
        peerIds,
        sourceInventoryHash: 'inventory-a',
        currentMessageCount: 60000,
        targetMessageCount: 50000,
    });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'legacy-or-invalid-checkpoint');
});

test('V188.57 does not let newer tail rows hide an old history hole', () => {
    const valid = validateLocalHistoryCheckpoint({
        storedSignature,
        peerIds,
        sourceInventoryHash: 'inventory-a',
        currentMessageCount: 52000,
        targetMessageCount: 49000,
        currentCoverage: {
            maxCmid: 52000,
            coveredCount: 49000,
            coverageHash: 'history-hash-a',
        },
    });
    assert.equal(valid.valid, true);

    const hole = validateLocalHistoryCheckpoint({
        storedSignature,
        peerIds,
        sourceInventoryHash: 'inventory-a',
        currentMessageCount: 53000,
        targetMessageCount: 49000,
        currentCoverage: {
            maxCmid: 53000,
            coveredCount: 48999,
            coverageHash: 'history-hash-with-hole',
        },
    });
    assert.equal(hole.valid, false);
    assert.match(hole.reason, /^coverage-/u);
});

test('V188.69 treats monotonic coverage growth as healthy instead of forcing a 900k-row rescan', () => {
    const result = validateLocalHistoryCheckpoint({
        storedSignature,
        peerIds,
        sourceInventoryHash: 'inventory-a',
        currentMessageCount: 55587,
        targetMessageCount: 55483,
        currentCoverage: {
            maxCmid: 55587,
            coveredCount: 49104,
            coverageHash: 'different-because-new-rows-filled-old-range',
        },
    });
    assert.equal(result.valid, true);
    assert.equal(result.reason, 'checkpoint-valid-coverage-growth');
});

test('V188.57 rescans when a new healthy/corruption snapshot appears', () => {
    const result = validateLocalHistoryCheckpoint({
        storedSignature,
        peerIds,
        sourceInventoryHash: 'inventory-b',
        currentMessageCount: 52000,
        targetMessageCount: 49000,
        currentCoverage: {
            maxCmid: 52000,
            coveredCount: 49000,
            coverageHash: 'history-hash-a',
        },
    });
    assert.equal(result.valid, false);
    assert.equal(result.reason, 'source-inventory-changed');
});

test('V188.57 startup local history skip is fingerprint based, not count only', () => {
    assert.match(appSource, /validateLocalHistoryCheckpoint/u);
    assert.match(appSource, /\[VK HISTORY LOCAL SQLITE RESCAN\]/u);
    assert.match(appSource, /coverageMaxCmid=/u);
    assert.match(appSource, /checkpoint=v2/u);
    assert.match(localRecoverySource, /getLocalSqliteBackupInventoryFingerprint/u);
    assert.match(localRecoverySource, /getActiveMessageCoverageFingerprint/u);
    assert.match(localRecoverySource, /FROM messages NOT INDEXED/u);
});

test('V188.57 owner can request full VK history from the beginning', () => {
    const parsed = parseVkHistoryPullCommand('Гигорейв подтяни историю с самого начала');
    assert.equal(parsed.matched, true);
    assert.equal(parsed.valid, true);
    assert.equal(parsed.fullHistory, true);
    assert.equal(parsed.durationSeconds, 0);
    assert.match(parsed.durationLabel, /всю доступную историю/u);
});
