import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('secondary automatic parser defers global verification for partial runs', () => {
    const start = appSource.indexOf('async function runSecondaryPartyAutoParserTick');
    const end = appSource.indexOf('async function runScheduledParserPools', start);
    assert.ok(start >= 0 && end > start, 'secondary auto parser block must remain discoverable');
    const block = appSource.slice(start, end);
    assert.match(block, /const partialRun = processingSummary\?\.ok !== true \|\| pendingBeforeVerification\.length > 0/u);
    assert.match(block, /const verification = partialRun \? null : await rebuildVerifiedPartySnapshotQueued/u);
    assert.match(block, /verificationSkipped: partialRun/u);
    assert.match(block, /status: summary\?\.verificationSkipped \|\| summary\?\.ok === false \? 'completed-with-warnings' : 'completed'/u);
});
