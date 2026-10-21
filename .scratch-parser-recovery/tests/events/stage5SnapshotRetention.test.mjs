import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
    writeVerifiedEventSnapshot,
    readVerifiedEventSnapshot,
} from '../../src/features/events/eventVerifiedSnapshot.js';

test('failed snapshot write preserves the previously verified disk snapshot', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gigorave-stage5-snapshot-'));
    const file = join(directory, 'verified.json');
    try {
        writeVerifiedEventSnapshot({
            reason: 'old-success', sourceRevision: 'old-revision', verifiedAt: 1,
            items: [{event: {title: 'Old verified event', eventDate: '2099-09-21'}}],
        }, file);
        const beforeBytes = readFileSync(file);
        assert.throws(() => writeVerifiedEventSnapshot({
            reason: 'new-failed', sourceRevision: 'new-revision', verifiedAt: 2,
            items: [{event: {title: 'Invalid', eventDate: '2099-09-22', invalid: 1n}}],
        }, file), /BigInt/);
        assert.deepEqual(readFileSync(file), beforeBytes);
        assert.equal(readVerifiedEventSnapshot(file)?.reason, 'old-success');
    } finally {
        rmSync(directory, {recursive: true, force: true});
    }
});
