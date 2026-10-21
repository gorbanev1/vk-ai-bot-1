import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { reconcileInterruptedOperationCheckpoints } from '../../src/runtime/operationSupervisor.js';

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
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
