import test from 'node:test';
import assert from 'node:assert/strict';
import {
  collectConfiguredAiCredentials,
  classifyModelCapabilities,
} from '../../src/features/ai/providerKeyAudit.js';

test('collects only supported AI env slots and deduplicates identical provider secrets', () => {
  const rows = collectConfiguredAiCredentials({
    OPENAI_API_KEY_1: 'sk-one-secret-123456',
    OPENAI_API_KEY_2: 'sk-one-secret-123456',
    GEMINI_API_KEY_1: 'AIza-example-abcdef',
    STRIPE_API_KEY: 'sk_live_ignore_me',
  });
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map((row) => row.provider).sort(), ['gemini', 'openai']);
  assert.ok(rows.every((row) => !row.masked.includes(row.secret)));
});

test('classifies image/code/embedding models without executing them', () => {
  assert.ok(classifyModelCapabilities('openai', { id: 'gpt-image-2' }).includes('image'));
  assert.ok(classifyModelCapabilities('openai', { id: 'gpt-5.6-sol' }).includes('text'));
  assert.ok(classifyModelCapabilities('nvidia', { id: 'nvidia/nv-embed-v1' }).includes('embedding'));
});
