import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileInterruptedOperationCheckpoints } from '../../src/runtime/operationSupervisor.js';
import { classifyInterruptedOperation } from '../../src/runtime/operationRecoveryPolicy.js';

test('restart policy explains built-in startup jobs without requesting owner action', () => {
    for (const operation of [
        { name: 'startup-telegram-connect', category: 'startup', expected: 'retry-by-connection-manager' },
        { name: 'vk-history-recovery:startup', category: 'maintenance', expected: 'retry-idempotent-window' },
        { name: 'summary-hierarchy:bootstrap', category: 'summary', expected: 'resume-from-durable-calendar-state' },
        { name: 'parser-all-recovery:primary', category: 'parser', metadata: { autoRecoveryDepth: 0 }, expected: 'managed-parser-recovery' },
    ]) {
        const result = classifyInterruptedOperation(operation);
        assert.equal(result.policy, operation.expected);
        assert.equal(result.ownerActionRequired, false);
        assert.ok(result.action);
        assert.ok(result.explanation);
    }
});

test('unknown interrupted work is reported for review rather than replayed', () => {
    const result = classifyInterruptedOperation({ name: 'unregistered-side-effect', category: 'maintenance' });
    assert.equal(result.policy, 'owner-review-required');
    assert.equal(result.ownerActionRequired, true);
});

test('test checkpoints are abandoned without owner notification on production restart', () => {
    const result = classifyInterruptedOperation({ name: 'v18848-test-noncooperative', category: 'test' });
    assert.equal(result.policy, 'ignore-test-artifact');
    assert.equal(result.ownerActionRequired, false);
});

test('parser recovery at its automatic retry cap asks the owner to resume explicitly', () => {
    const result = classifyInterruptedOperation({
        name: 'parser-all-recovery:primary', category: 'parser', metadata: { autoRecoveryDepth: 5 },
    });
    assert.equal(result.policy, 'managed-parser-recovery-limit-reached');
    assert.equal(result.ownerActionRequired, true);
    assert.match(result.action, /owner/u);
});

test('startup recovery marks active checkpoints interrupted and preserves their resume payload', () => {
    const directory = mkdtempSync(join(tmpdir(), 'operation-checkpoint-recovery-'));
    try {
        const path = join(directory, 'parser-run.json');
        writeFileSync(path, JSON.stringify({
            version: 1,
            reason: 'parser.checkpoint.poster-gate-progress',
            operation: {
                id: 'parser-run', name: 'parser-all:primary', category: 'parser', status: 'running',
                startedAt: '2026-10-02T06:00:00.000Z', deadlineAt: '2026-10-02T09:00:00.000Z',
                checkpoint: { phase: 'poster-gate', completedPosterGateRequests: 8, unfinishedPosterGateRequests: 3, tracePath: 'trace.jsonl' },
                progress: { phase: 'parser-poster-gate' },
            },
        }), 'utf8');

        const recovered = reconcileInterruptedOperationCheckpoints({
            directory, now: new Date('2026-10-02T08:30:00.000Z'), writeAudit: false,
        });
        const saved = JSON.parse(readFileSync(path, 'utf8'));

        assert.equal(recovered.length, 1);
        assert.equal(recovered[0].id, 'parser-run');
        assert.equal(saved.operation.status, 'interrupted');
        assert.equal(saved.operation.finishedAt, '2026-10-02T08:30:00.000Z');
        assert.equal(saved.operation.checkpoint.unfinishedPosterGateRequests, 3);
        assert.equal(saved.operation.checkpoint.tracePath, 'trace.jsonl');
        assert.equal(saved.reason, 'process-restarted');
        assert.equal(saved.version, 2);
        assert.equal(saved.recovery.policy, 'managed-parser-recovery');
        assert.equal(recovered[0].recovery.ownerActionRequired, false);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('startup recovery does not report short vk-message handlers as resumable work', () => {
    const directory = mkdtempSync(join(tmpdir(), 'operation-checkpoint-vk-message-'));
    try {
        const path = join(directory, 'vk-message.json');
        writeFileSync(path, JSON.stringify({ version: 1, operation: {
            id: 'vk-message-run', name: 'vk-message', category: 'user-request', status: 'running',
            startedAt: '2026-10-02T06:00:00.000Z', checkpoint: {}, progress: {},
        } }), 'utf8');
        const recovered = reconcileInterruptedOperationCheckpoints({ directory, now: new Date('2026-10-02T08:30:00.000Z'), writeAudit: false });
        const saved = JSON.parse(readFileSync(path, 'utf8'));
        assert.equal(recovered.length, 0);
        assert.equal(saved.operation.status, 'abandoned');
        assert.equal(saved.reason, 'ignored-non-resumable-request');
    } finally { rmSync(directory, { recursive: true, force: true }); }
});
