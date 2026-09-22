import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

import {
    EVENT_VERIFIED_SNAPSHOT_VERSION,
    readVerifiedEventSnapshot,
    writeVerifiedEventSnapshot,
} from '../../src/features/events/eventVerifiedSnapshot.js';

const dir = mkdtempSync(join(tmpdir(), 'vk-ai-v96-snapshot-'));
const file = join(dir, 'event-verified-snapshot.json');

const written = writeVerifiedEventSnapshot({
    verifiedAt: 123456,
    reason: 'test',
    sourceRevision: 'revision-test-123',
    rawCount: 3,
    normalizedCount: 3,
    canonicalCount: 2,
    mergeCount: 1,
    ambiguousCount: 1,
    items: [
        {
            event: {
                title: 'BEERBIENT',
                eventDate: '2026-08-16',
                mergedSources: [
                    { sourceType: 'telegram', sourceName: '@kurazhcity', sourceUrl: 'https://t.me/kurazhcity/3945' },
                    { sourceType: 'vk-public', sourceName: 'deadway36', sourceUrl: 'https://vk.ru/wall-234720249_131' },
                ],
            },
            compactSummary: 'Один объединённый анонс.',
            ticketLink: '',
        },
    ],
}, file);

assert.equal(written, file);
const raw = JSON.parse(readFileSync(file, 'utf8'));
assert.equal(raw.version, EVENT_VERIFIED_SNAPSHOT_VERSION);
assert.equal(raw.items.length, 1);

const loaded = readVerifiedEventSnapshot(file);
assert.equal(loaded.canonicalCount, 2);
assert.equal(loaded.sourceRevision, 'revision-test-123');
assert.equal(loaded.items[0].event.title, 'BEERBIENT');
assert.equal(loaded.items[0].event.mergedSources.length, 2);
assert.equal(loaded.items[0].compactSummary, 'Один объединённый анонс.');

console.log('eventVerifiedSnapshotV96.test.mjs: OK');
