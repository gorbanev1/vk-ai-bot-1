import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    createAutoSummaryStateStore,
    resolveAutoSummaryStateDirectory,
} from '../../src/infrastructure/database/autoSummaryStateStore.js';

test('V155 auto-summary state lives outside release directory and survives release replacement', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v155-state-'));
    const durableDirectory = join(root, 'user-state');

    const first = createAutoSummaryStateStore({ directory: durableDirectory });
    first.saveSettings({
        peerId: 2_000_000_123,
        platform: 'vk',
        endpointKey: 'vk:primary',
        externalPeerId: '2000000123',
        mode: 'evening',
        enabled: true,
        nextRunAt: 1_800_000_000,
        updatedBy: 42,
        updatedAt: 1_700_000_000,
    });
    first.saveRun({
        peerId: 2_000_000_123,
        summaryDate: '2026-09-05',
        slotLabel: '18:00',
        scheduledAt: 1_799_999_000,
        startedAt: 1_799_999_010,
        finishedAt: 1_799_999_020,
        messageCount: 77,
        summaryText: 'done',
    });
    const databasePath = first.databasePath;
    first.close();

    // Opening the same user-level state from a "new release" sees the exact
    // enabled setting and completed-slot history without any release files.
    const second = createAutoSummaryStateStore({ directory: durableDirectory });
    assert.equal(second.databasePath, databasePath);
    assert.deepEqual(second.getSettings(2_000_000_123), {
        peerId: 2_000_000_123,
        platform: 'vk',
        endpointKey: 'vk:primary',
        externalPeerId: '2000000123',
        mode: 'evening',
        enabled: true,
        nextRunAt: 1_800_000_000,
        updatedBy: 42,
        updatedAt: 1_700_000_000,
    });
    assert.equal(second.getRun(2_000_000_123, '2026-09-05', '18:00')?.finishedAt, 1_799_999_020);
    second.close();
    rmSync(root, { recursive: true, force: true });
});

test('V155 migrates legacy auto-summary state once and stale legacy rows cannot overwrite newer durable state', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-v155-migrate-'));
    const store = createAutoSummaryStateStore({ directory: root });

    const migrated = store.importLegacy({
        settings: [{
            peer_id: 321,
            platform: 'telegram',
            endpoint_key: 'telegram',
            external_peer_id: '-100777',
            mode: 'full',
            enabled: 1,
            next_run_at: 1000,
            updated_by: 1,
            updated_at: 100,
        }],
        runs: [],
    });
    assert.equal(migrated.settingsImported, 1);
    assert.equal(store.getSettings(321)?.enabled, true);

    store.saveSettings({
        peerId: 321,
        platform: 'telegram',
        endpointKey: 'telegram',
        externalPeerId: '-100777',
        mode: 'day',
        enabled: false,
        nextRunAt: 0,
        updatedBy: 2,
        updatedAt: 200,
    });

    store.importLegacy({
        settings: [{
            peer_id: 321,
            platform: 'telegram',
            endpoint_key: 'telegram',
            external_peer_id: '-100777',
            mode: 'full',
            enabled: 1,
            next_run_at: 1000,
            updated_by: 1,
            updated_at: 100,
        }],
    });

    const current = store.getSettings(321);
    assert.equal(current.enabled, false);
    assert.equal(current.mode, 'day');
    assert.equal(current.updatedAt, 200);

    store.close();
    rmSync(root, { recursive: true, force: true });
});

test('V155 default persistent directory is user-level and configurable', () => {
    assert.equal(
        resolveAutoSummaryStateDirectory({
            env: { GIGORAVE_STATE_DIR: '/tmp/custom-gigorave-state' },
            platform: 'linux',
            homeDirectory: '/home/tester',
        }),
        '/tmp/custom-gigorave-state',
    );

    assert.equal(
        resolveAutoSummaryStateDirectory({
            env: { XDG_STATE_HOME: '/home/tester/.state' },
            platform: 'linux',
            homeDirectory: '/home/tester',
        }),
        '/home/tester/.state/gigorave',
    );

    const windowsPath = resolveAutoSummaryStateDirectory({
        env: { LOCALAPPDATA: 'C:\\Users\\Tester\\AppData\\Local' },
        platform: 'win32',
        homeDirectory: 'C:\\Users\\Tester',
    });
    assert.match(windowsPath.replaceAll('\\', '/'), /Gigorave\/state$/u);
});
