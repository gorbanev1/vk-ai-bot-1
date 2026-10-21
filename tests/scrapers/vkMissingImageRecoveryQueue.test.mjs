import test from 'node:test';
import assert from 'node:assert/strict';

import { createVkMissingImageRecoveryQueue } from '../../src/features/scrapers/vkMissingImageRecoveryQueue.js';

const wall = (id) => 'https://vk.ru/wall-12345_' + id;

test('queues VK wall sources once and spaces browser openings by 7-15 seconds', async () => {
    const opened = [];
    const sleeps = [];
    const queue = createVkMissingImageRecoveryQueue({
        processSource: async (item) => { opened.push(item.sourceUrl); },
        sleep: async (ms) => { sleeps.push(ms); },
        random: () => 0,
        minDelayMs: 7_000,
        maxDelayMs: 15_000,
    });

    assert.equal(queue.schedule({ sourceUrl: wall(1) }).scheduled, true);
    assert.equal(queue.schedule({ sourceUrl: wall(1) + '?utm=1' }).scheduled, false);
    assert.equal(queue.schedule({ sourceUrl: wall(2) }).scheduled, true);
    await queue.waitForIdle();

    assert.deepEqual(opened, [wall(1), wall(2)]);
    assert.deepEqual(sleeps, [7_000]);
});

test('rejects non-VK links and stops repeated browser attempts after the limit', async () => {
    let calls = 0;
    const queue = createVkMissingImageRecoveryQueue({
        processSource: async () => { calls += 1; },
        sleep: async () => {},
        maxAttemptsPerSource: 1,
    });

    assert.equal(queue.schedule({ sourceUrl: 'https://example.com/wall-1_2' }).reason, 'not-vk-wall');
    assert.equal(queue.schedule({ sourceUrl: wall(3) }).scheduled, true);
    await queue.waitForIdle();
    assert.equal(queue.schedule({ sourceUrl: wall(3) }).reason, 'attempt-limit');
    assert.equal(calls, 1);
});
