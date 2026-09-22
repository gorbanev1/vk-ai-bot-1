import test from 'node:test';
import assert from 'node:assert/strict';
import {
  extractReasoningEffortModifier,
  getDefaultReasoningEffortForMode,
} from '../../src/features/ai/reasoningEffortRouting.js';

test('defaults use medium for cheap models and high for GPT-5.6 family', () => {
  assert.equal(getDefaultReasoningEffortForMode('default', {}), 'medium');
  assert.equal(getDefaultReasoningEffortForMode('gpt54', {}), 'medium');
  assert.equal(getDefaultReasoningEffortForMode('gpt55', {}), 'medium');
  assert.equal(getDefaultReasoningEffortForMode('pro', {}), 'high');
  assert.equal(getDefaultReasoningEffortForMode('pro2', {}), 'high');
  assert.equal(getDefaultReasoningEffortForMode('pro3', {}), 'high');
});

test('parses xhigh/max at prefix or suffix and labelled form', () => {
  assert.deepEqual(extractReasoningEffortModifier('x-high разберись').effort, 'xhigh');
  assert.equal(extractReasoningEffortModifier('разберись max').effort, 'max');
  assert.equal(extractReasoningEffortModifier('разберись интеллект high подробно').effort, 'high');
});

test('does not consume a bare high from the middle of normal prompt', () => {
  const result = extractReasoningEffortModifier('compare high school and college');
  assert.equal(result.effort, '');
  assert.equal(result.body, 'compare high school and college');
});
