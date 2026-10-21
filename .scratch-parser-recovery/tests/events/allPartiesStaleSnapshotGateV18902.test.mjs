import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('all-parties selection uses local dedupe fallback while verified snapshot repair is pending', () => {
    const start = app.indexOf('async function selectAllPartyCandidatesForRange');
    const end = app.indexOf('async function sendAllPartiesForRange', start);
    assert.ok(start >= 0 && end > start);
    const block = app.slice(start, end);

    assert.ok(block.includes('buildFastUnverifiedItemsForRange(range, limit, { partyPool })'));
    assert.ok(!block.includes('if (selection.verificationPending) return [];'));
});
