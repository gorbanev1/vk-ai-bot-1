import test from 'node:test';
import assert from 'node:assert/strict';
import {
  NVIDIA_VISUAL_AUDIT_CATALOG,
  getNvidiaGenerationModelIds,
} from '../../src/features/ai/nvidiaVisualAudit.js';

test('visual matrix starts with FLUX.2 Klein and includes all hosted generators from production list', () => {
  const ids = getNvidiaGenerationModelIds();
  assert.equal(ids[0], 'black-forest-labs/flux.2-klein-4b');
  assert.ok(ids.includes('black-forest-labs/flux.1-dev'));
  assert.ok(ids.includes('stabilityai/stable-diffusion-3-medium'));
  assert.ok(ids.includes('black-forest-labs/flux.1-schnell'));
  assert.ok(ids.includes('stabilityai/stable-diffusion-xl'));
});

test('editing matrix declares Flux2 Klein and Flux Kontext', () => {
  const editIds = NVIDIA_VISUAL_AUDIT_CATALOG.filter((item) => item.editing).map((item) => item.id);
  assert.deepEqual(editIds, ['black-forest-labs/flux.2-klein-4b', 'black-forest-labs/flux.1-kontext-dev']);
});
