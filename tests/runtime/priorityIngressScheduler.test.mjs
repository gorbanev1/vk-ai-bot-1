import test from 'node:test';
import assert from 'node:assert/strict';
import { createPriorityIngressScheduler } from '../../src/runtime/priorityIngressScheduler.js';

test('interactive ingress preempts queued background work and bounds concurrency', async () => {
    const scheduler = createPriorityIngressScheduler({ interactiveConcurrency: 1, backgroundConcurrency: 1 });
    const started = [];
    let releaseBackground;
    const backgroundGate = new Promise(resolve => { releaseBackground = resolve; });
    const background = scheduler.enqueue(async () => {
        started.push('background-1');
        await backgroundGate;
        started.push('background-1-done');
    });
    const queuedBackground = scheduler.enqueue(async () => { started.push('background-2'); }, { interactive: false });
    await new Promise(resolve => setImmediate(resolve));
    const interactive = scheduler.enqueue(async () => { started.push('interactive'); }, { interactive: true });
    await new Promise(resolve => setImmediate(resolve));
    assert.deepEqual(started, ['background-1', 'interactive']);
    releaseBackground();
    await Promise.all([background, queuedBackground, interactive]);
    await scheduler.idle();
    assert.deepEqual(started, ['background-1', 'interactive', 'background-1-done', 'background-2']);
});

test('scheduler reports task errors without stranding the lane', async () => {
    const errors = [];
    const scheduler = createPriorityIngressScheduler({
        onError: error => errors.push(error.message),
    });
    await assert.rejects(scheduler.enqueue(async () => { throw new Error('boom'); }, { interactive: true }), /boom/u);
    const result = await scheduler.enqueue(async () => 42, { interactive: true });
    assert.equal(result, 42);
    assert.deepEqual(errors, ['boom']);
});
