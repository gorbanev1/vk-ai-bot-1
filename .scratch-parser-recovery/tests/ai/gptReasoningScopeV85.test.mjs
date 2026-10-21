import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

test('V85 answerGptQuestion does not reference handleGptCommand local parsed variable', () => {
  const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
  const start = source.indexOf('async function answerGptQuestion(');
  const end = source.indexOf('\nasync function ', start + 1);
  assert.ok(start >= 0);
  const fn = source.slice(start, end > start ? end : source.length);
  assert.doesNotMatch(fn, /parsed\.reasoningEffort/u);
  assert.match(fn, /reasoningEffort:\s*reasoningEffort\s*\|\|\s*getDefaultReasoningEffortForMode\(mode\)/u);
});
