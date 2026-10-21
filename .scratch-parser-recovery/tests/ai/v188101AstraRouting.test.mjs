import test from 'node:test';
import assert from 'node:assert/strict';
import { extractExplicitGptMode } from '../../src/features/ai/gptModeRouting.js';
import { extractReasoningEffortModifier, getDefaultReasoningEffortForMode } from '../../src/features/ai/reasoningEffortRouting.js';
import { getVisionModeChain } from '../../src/features/ai/visionRouting.js';
import { resolveProviderModel } from '../../src/features/ai/modelProviderFailover.js';

test('astra max => GPT-6 Astra mode + maximum reasoning', () => {
  const mode = extractExplicitGptMode('астра max разберись в коде');
  assert.equal(mode.mode, 'astra');
  assert.equal(mode.body, 'max разберись в коде');
  const reasoning = extractReasoningEffortModifier(mode.body);
  assert.equal(reasoning.effort, 'max');
  assert.equal(reasoning.body, 'разберись в коде');
});

test('strongest aliases select Astra but sol still selects pro3', () => {
  assert.equal(extractExplicitGptMode('самая продвинутая модель проверь код').mode, 'astra');
  assert.equal(extractExplicitGptMode('max проверь код').mode, 'astra');
  assert.equal(extractExplicitGptMode('sol проверь код').mode, 'pro3');
});

test('Astra defaults to max and is final vision ladder step', () => {
  assert.equal(getDefaultReasoningEffortForMode('astra'), 'max');
  assert.deepEqual(getVisionModeChain('pro3'), ['pro3', 'astra']);
  assert.deepEqual(getVisionModeChain('astra'), ['astra']);
});

test('Astra is not silently substituted with xAI/Grok', () => {
  assert.equal(resolveProviderModel({ credential: { provider: 'xai' }, capability: 'text', mode: 'astra', requestedModel: 'gpt-6-astra', env: {} }), '');
});
