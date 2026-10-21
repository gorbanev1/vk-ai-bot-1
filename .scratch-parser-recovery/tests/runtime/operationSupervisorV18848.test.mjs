import assert from 'node:assert/strict';
import test from 'node:test';

import {
    DEFAULT_OPERATION_TIMEOUT_MS,
    STOP_HANDLER_TIMEOUT_MS,
    getOperation,
    listActiveOperations,
    requestOperationStop,
    runSupervisedOperation,
} from '../../src/runtime/operationSupervisor.js';
import { parseProcessControlCommand } from '../../src/features/runtime/processControlRouting.js';

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('V188.48: global hard algorithm ceiling is exactly two hours', () => {
    assert.equal(DEFAULT_OPERATION_TIMEOUT_MS, 2 * 60 * 60 * 1000);
});


test('V188.48: stop handlers have their own finite deadline so stop command cannot hang forever', () => {
    assert.equal(STOP_HANDLER_TIMEOUT_MS, 15_000);
});

test('V188.48: manual stop aborts a cooperative operation and preserves checkpoint/progress', async () => {
    const task = runSupervisedOperation({
        name: 'v18848-test-manual-stop',
        category: 'test',
        timeoutMs: 60_000,
        metadata: { platform: 'telegram', senderId: 42 },
    }, async ({ signal, updateProgress, saveCheckpoint, onStop }) => {
        updateProgress({ total: 20, completed: 10 });
        saveCheckpoint({ processed: 10, total: 20, ids: ['a', 'b'] });
        onStop(({ checkpoint, progress }) => {
            saveCheckpoint({
                ...checkpoint,
                phase: 'stopping',
                preservedCompleted: progress.completed,
            });
        });
        await new Promise((resolve, reject) => {
            signal.addEventListener('abort', () => reject(signal.reason), { once: true });
        });
        return 'unreachable';
    });

    await sleep(25);
    const active = listActiveOperations().find((row) => row.name === 'v18848-test-manual-stop');
    assert.ok(active, 'operation should be discoverable');
    assert.equal(active.progress.completed, 10);
    assert.equal(active.checkpoint.processed, 10);

    const stop = await requestOperationStop(active.id, { reason: 'test-owner-stop' });
    assert.equal(stop.ok, true);
    assert.match(stop.operation.status, /stopping|cancelled/u);
    assert.equal(stop.operation.checkpoint.processed, 10);
    assert.equal(stop.operation.checkpoint.phase, 'stopping');
    assert.equal(stop.operation.checkpoint.preservedCompleted, 10);

    await assert.rejects(task, (error) => error?.code === 'OPERATION_CANCELLED');
    await sleep(10);
    assert.equal(getOperation(active.id), null);
});

test('V188.48: hard deadline aborts a cooperative operation instead of waiting forever', async () => {
    const started = Date.now();
    const keepAlive = setInterval(() => {}, 100);
    try {
        await assert.rejects(
            runSupervisedOperation({ name: 'v18848-test-timeout', category: 'test', timeoutMs: 1_000 }, async ({ signal }) => {
                await new Promise((resolve, reject) => {
                    signal.addEventListener('abort', () => reject(signal.reason), { once: true });
                });
            }),
            (error) => error?.code === 'OPERATION_TIMEOUT',
        );
    } finally {
        clearInterval(keepAlive);
    }
    assert.ok(Date.now() - started < 3_000, 'timeout should return promptly');
});

test('V188.48: manual stop returns promptly even when underlying third-party promise ignores abort', async () => {
    const never = new Promise(() => {});
    const task = runSupervisedOperation({
        name: 'v18848-test-noncooperative',
        category: 'test',
        timeoutMs: 60_000,
    }, async ({ saveCheckpoint }) => {
        saveCheckpoint({ processed: 10, total: 20, phase: 'external-sdk' });
        await never;
    });

    await sleep(20);
    const active = listActiveOperations().find((row) => row.name === 'v18848-test-noncooperative');
    assert.ok(active);
    const started = Date.now();
    const stop = await requestOperationStop(active.id, { reason: 'test-noncooperative-stop' });
    assert.equal(stop.ok, true);
    await assert.rejects(task, (error) => error?.code === 'OPERATION_CANCELLED');
    assert.ok(Date.now() - started < 500, 'logical operation stop must not wait for an uncooperative SDK promise');
    const stopping = getOperation(active.id);
    assert.ok(stopping, 'underlying uncooperative work remains visible instead of being falsely reported as gone');
    assert.match(stopping.status, /stopping/u);
    assert.equal(stopping.checkpoint.processed, 10);
});



test('V188.48: manually cancelled task is removed after an SDK eventually settles late', async () => {
    let resolveExternal;
    const external = new Promise((resolve) => { resolveExternal = resolve; });
    const task = runSupervisedOperation({
        name: 'v18848-test-late-complete-after-cancel',
        category: 'test',
        timeoutMs: 60_000,
    }, async ({ saveCheckpoint }) => {
        saveCheckpoint({ processed: 4, total: 9, phase: 'external-sdk' });
        return external;
    });

    await sleep(20);
    const active = listActiveOperations().find((row) => row.name === 'v18848-test-late-complete-after-cancel');
    assert.ok(active);
    await requestOperationStop(active.id, { reason: 'test-late-complete' });
    await assert.rejects(task, (error) => error?.code === 'OPERATION_CANCELLED');
    assert.ok(getOperation(active.id), 'late SDK remains discoverable while still unresolved');
    resolveExternal('late-result');
    await sleep(20);
    assert.equal(getOperation(active.id), null, 'late completion must retire cancelled operation');
});

test('V188.48: process control commands discover/details/stop unfinished work', () => {
    assert.deepEqual(parseProcessControlCommand('процессы'), { action: 'list' });
    assert.deepEqual(parseProcessControlCommand('Гигорейв, незавершенные процессы'), { action: 'list' });
    assert.deepEqual(parseProcessControlCommand('процесс abc-123'), { action: 'details', id: 'abc-123' });
    assert.deepEqual(parseProcessControlCommand('прервать процесс abc-123'), { action: 'stop-one', id: 'abc-123' });
    assert.deepEqual(parseProcessControlCommand('остановить все процессы'), { action: 'stop-all' });
});
