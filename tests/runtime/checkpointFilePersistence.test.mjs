import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, readFile, writeFile, rename, rm, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { renameCheckpointWithRetry } from '../../src/runtime/checkpointFilePersistence.js';

for (const code of ['EPERM', 'EACCES', 'EBUSY']) {
    test(`transient ${code}: retains the previous checkpoint until replacement succeeds`, async () => {
        const directory = await mkdtemp(join(tmpdir(), 'checkpoint-retry-'));
        const target = join(directory, 'operation.json'), temporary = target + '.tmp-test';
        const previous = JSON.stringify({ status: 'running' }), next = JSON.stringify({ status: 'completed' });
        await writeFile(target, previous); await writeFile(temporary, next);
        let calls = 0; const delays = [];
        try {
            await renameCheckpointWithRetry(temporary, target, {
                renameFile: async (from, to) => {
                    calls += 1;
                    if (calls <= 2) throw Object.assign(new Error('Windows sharing violation'), { code });
                    await rename(from, to);
                },
                wait: async (ms) => {
                    delays.push(ms);
                    assert.equal(await readFile(target, 'utf8'), previous);
                    assert.equal(await readFile(temporary, 'utf8'), next);
                },
            });
            assert.equal(calls, 3); assert.deepEqual(delays, [50, 100]);
            assert.equal(await readFile(target, 'utf8'), next);
            assert.deepEqual(await readdir(directory), ['operation.json']);
        } finally { await rm(directory, { recursive: true, force: true }); }
    });
}
test('persistent denial is bounded and preserves both recoverable files', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'checkpoint-denied-'));
    const target = join(directory, 'operation.json'), temporary = target + '.tmp-test';
    await writeFile(target, 'old'); await writeFile(temporary, 'new');
    const failure = Object.assign(new Error('denied'), { code: 'EPERM' });
    let calls = 0; const delays = [];
    try {
        await assert.rejects(renameCheckpointWithRetry(temporary, target, {
            renameFile: async () => { calls += 1; throw failure; }, wait: async (ms) => delays.push(ms),
        }), (error) => error === failure);
        assert.equal(calls, 6); assert.equal(delays.reduce((a, b) => a + b), 1550);
        assert.equal(await readFile(target, 'utf8'), 'old'); assert.equal(await readFile(temporary, 'utf8'), 'new');
    } finally { await rm(directory, { recursive: true, force: true }); }
});
test('non-transient errors are not hidden or retried', async () => {
    for (const code of ['ENOENT', 'ENOSPC', 'EIO']) {
        let calls = 0; const error = Object.assign(new Error(code), { code });
        await assert.rejects(renameCheckpointWithRetry('temporary', 'target', {
            renameFile: async () => { calls += 1; throw error; },
            wait: async () => assert.fail('must not wait'),
        }), (actual) => actual === error);
        assert.equal(calls, 1);
    }
});
