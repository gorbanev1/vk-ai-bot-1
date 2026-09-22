import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const snapshotModule = readFileSync(new URL('../../src/features/events/eventVerifiedSnapshot.js', import.meta.url), 'utf8');

test('V184 verified snapshot stores a fingerprint of configured SQLite event rows', () => {
    assert.match(app, /function computeConfiguredEventSourceRevision\(events = null\)/u);
    assert.match(app, /sourceRevision: computeConfiguredEventSourceRevision\(rawEvents\)/u);
    assert.match(app, /posterMatchStatus: String\(event\?\.posterMatchStatus/u);
    assert.match(app, /posterMatchReason: String\(event\?\.posterMatchReason/u);
    assert.match(app, /posterImageIndex: Number\(event\?\.posterImageIndex/u);
    assert.match(snapshotModule, /EVENT_VERIFIED_SNAPSHOT_VERSION = 7/u);
    assert.match(snapshotModule, /sourceRevision: String\(source\.sourceRevision/u);
});

test('V184 stale snapshot falls back to SQLite instead of returning false empty events', () => {
    const selectStart = app.indexOf('function selectVerifiedEventSnapshotItems');
    const selectEnd = app.indexOf('async function rebuildVerifiedPartySnapshot', selectStart);
    assert.ok(selectStart >= 0 && selectEnd > selectStart);
    const block = app.slice(selectStart, selectEnd);
    assert.match(block, /snapshot\.sourceRevision !== currentSourceRevision/u);
    assert.match(block, /\[EVENT VERIFIED SNAPSHOT STALE\]/u);
    assert.match(block, /fallback=sqlite/u);
    assert.match(block, /snapshot: null/u);
});

test('V184 stale snapshot schedules a single background cache repair', () => {
    assert.match(app, /scheduledVerifiedSnapshotRepairRevision/u);
    assert.match(app, /reason: 'stale-snapshot-auto-repair-v184'/u);
});
