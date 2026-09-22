import assert from 'node:assert/strict';
import test from 'node:test';
import { resolveCommandPriority } from '../../src/features/routing/commandPriorityRouting.js';

test('V85 graphics matrix top-level command routes to provider before GPT', () => {
  const decision = resolveCommandPriority(
    'графика тест все ключи cinematic black cat on a rainy neon street, full body, no text',
    { parsePublicEventsRangeCommand: () => null, looksLikePublicEventsQuestion: () => false },
  );
  assert.equal(decision.route, 'provider');
  assert.equal(decision.selected.command.action, 'all_provider_visual_matrix');
  assert.equal(decision.selected.command.prompt, 'cinematic black cat on a rainy neon street, full body, no text');
});
