import test from 'node:test';
import assert from 'node:assert/strict';
import { runManualParserPool } from '../../src/features/scrapers/manualProcessingPool.js';

test('priority is evaluated exactly once and preserved as zero', async () => {
    let calls = 0;
    const results = await runManualParserPool(['a'], async () => 42, {
        concurrency: 1,
        getPriority: () => { calls += 1; return 0; },
    });
    assert.equal(calls, 1);
    assert.deepEqual(results, [{ status: 'fulfilled', value: 42 }]);
});

test('priority exception rejects only its item while next item runs', async () => {
    const events = [];
    const executed = [];
    const results = await runManualParserPool([1, 2, 3], async (item) => {
        executed.push(item);
        return item * 10;
    }, {
        concurrency: 2,
        getPriority: (item) => { if (item === 2) throw new Error('priority failed'); return item; },
        onItemState: (event) => events.push(event),
    });
    assert.deepEqual(executed.sort(), [1, 3]);
    assert.equal(results[0].status, 'fulfilled');
    assert.equal(results[1].status, 'rejected');
    assert.match(results[1].reason.message, /priority failed/);
    assert.equal(results[2].status, 'fulfilled');
    assert.ok(events.some((event) => event.type === 'rejected' && event.item === 2));
});
