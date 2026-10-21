import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync, readFileSync, rmSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {readVerifiedEventSnapshot, writeVerifiedEventSnapshot} from '../../src/features/events/eventVerifiedSnapshot.js';

test('verified snapshot rejects missing/impossible event dates without replacing last good snapshot', () => {
    const folder = mkdtempSync(join(tmpdir(), 'gigorave-final-snapshot-date-'));
    const path = join(folder, 'event-verified-snapshot.json');
    try {
        writeVerifiedEventSnapshot({sourceRevision: 'before', items: [{event: {eventDate: '2028-02-29', title: 'Existing event'}}]}, path);
        const originalBytes = readFileSync(path);
        for (const eventDate of ['', null, '2027-02-29', '2026-13-20', '2026-09-31', '20-09-2026']) {
            assert.throws(() => writeVerifiedEventSnapshot({sourceRevision: 'after', items: [
                {event: {eventDate: '2026-09-24', title: 'Valid event'}},
                {event: {eventDate, publishedAt: 1789980000, title: 'Undated candidate'}},
            ]}, path), /without a confirmed calendar date/);
            assert.deepEqual(readFileSync(path), originalBytes);
            assert.equal(readVerifiedEventSnapshot(path)?.sourceRevision, 'before');
        }
    } finally {
        rmSync(folder, {recursive: true, force: true});
    }
});
