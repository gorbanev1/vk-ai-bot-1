import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V154 owner-added event invalidates stale verified snapshot before next party query', () => {
    const saved = app.indexOf("'[MANUAL EVENTS SAVED]'");
    const invalidate = app.indexOf("invalidateVerifiedPartySnapshot('manual-owner-event-saved')", saved);
    const reply = app.indexOf('await rawContext.send(', invalidate);
    assert.ok(saved >= 0);
    assert.ok(invalidate > saved, 'manual save must invalidate old snapshot');
    assert.ok(reply > invalidate, 'snapshot must be invalidated before owner receives completion reply');
    assert.match(app.slice(invalidate, reply + 50), /void rebuildVerifiedPartySnapshotQueued/u);
});

test('V154 source refresh uses the same central snapshot invalidation helper', () => {
    assert.match(app, /function invalidateVerifiedPartySnapshot\(reason = 'data-changed'\)/u);
    assert.match(app, /invalidateVerifiedPartySnapshot\(`source-refresh:\$\{reason\}`\)/u);
});
