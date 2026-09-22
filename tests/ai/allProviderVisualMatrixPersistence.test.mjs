import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { runAllProviderVisualMatrixAudit } from '../../src/features/ai/allProviderVisualMatrixAudit.js';

test('matrix audit creates durable generation and delivery journals even with zero keys', async () => {
  const dir = await mkdtemp(join(tmpdir(), 'graphics-matrix-v85-'));
  try {
    const result = await runAllProviderVisualMatrixAudit({ env: {}, directory: dir, prompt: 'same prompt' });
    assert.equal(result.attempts, 0);
    assert.equal(await readFile(result.jsonlPath, 'utf8'), '');
    assert.equal(await readFile(result.deliveryPath, 'utf8'), '');
    const summary = await readFile(result.summaryPath, 'utf8');
    assert.match(summary, /delivery_failed=0/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
