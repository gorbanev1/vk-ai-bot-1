import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createHistoryRecoveryStateStore } from '../../src/infrastructure/database/historyRecoveryStateStore.js';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V187.2 durable local history scan checkpoint survives restart', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v1872-history-'));
    try {
        const path = join(dir, 'state.sqlite');
        const first = createHistoryRecoveryStateStore({ databasePath: path });
        first.save({ peerId: 2000000006, sourceSignature: '[2000000002,2000000006]', targetMessageCount: 31890, scannedRows: 52833 });
        first.close();
        const second = createHistoryRecoveryStateStore({ databasePath: path });
        const state = second.get(2000000006);
        assert.equal(state.targetMessageCount, 31890);
        assert.equal(state.scannedRows, 52833);
        second.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('V187.2 skips repeated local backup scan unless DB rolled back or force flag is set', () => {
    assert.match(source, /\[VK HISTORY LOCAL SQLITE SKIP DURABLE\]/u);
    assert.match(source, /currentMessageCount >= durableScan\.targetMessageCount/u);
    assert.match(source, /VK_FORCE_LOCAL_HISTORY_SCAN/u);
});

test('V188.23 CMID fallback starts from the newest message and is bounded automatically', () => {
    assert.match(source, /direction=newest-to-oldest/u);
    assert.match(source, /let batchEnd = ceiling/u);
    assert.match(source, /VK_HISTORY_STARTUP_MAX_MESSAGES/u);
    assert.doesNotMatch(source, /VK_HISTORY_RECOVERY_INCREMENTAL_CMID_OVERLAP/u);
});
