import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    AUTO_SUMMARY_MIN_CHARS,
    AUTO_SUMMARY_MAX_CHARS,
    AUTO_SUMMARY_MIN_PARAGRAPHS,
    AUTO_SUMMARY_MAX_PARAGRAPHS,
    clampAutoSummaryText,
} from '../../src/features/ai/autoSummaryRouting.js';

test('V141 autoresume target is phone-readable rather than a transcript wall', () => {
    assert.equal(AUTO_SUMMARY_MIN_CHARS, 1600);
    assert.equal(AUTO_SUMMARY_MAX_CHARS, 2400);
    assert.equal(AUTO_SUMMARY_MIN_PARAGRAPHS, 5);
    assert.equal(AUTO_SUMMARY_MAX_PARAGRAPHS, 7);
});

test('V141 hard cap trims at a complete sentence when possible', () => {
    const sentence = 'Это содержательное предложение про жизнь чата и заметную тему. ';
    const input = sentence.repeat(70);
    const output = clampAutoSummaryText(input);
    assert.ok(output.length >= 1600, `too short: ${output.length}`);
    assert.ok(output.length <= 2400, `too long: ${output.length}`);
    assert.match(output, /[.!?…]$/u);
});

test('V188 scheduled autoresume keeps V141 output clamps while using the shared hierarchical summarizer', () => {
    const source = readFileSync(
        new URL('../../src/app/botApplication.js', import.meta.url),
        'utf8',
    );
    assert.match(source, /AUTO_SUMMARY_MIN_CHARS/u);
    assert.match(source, /AUTO_SUMMARY_MAX_CHARS/u);
    assert.match(source, /AUTO_SUMMARY_MIN_PARAGRAPHS/u);
    assert.match(source, /AUTO_SUMMARY_MAX_PARAGRAPHS/u);
    assert.match(source, /async function createAutoSummaryText/u);
    assert.match(source, /return createOpenAISummary\(\{/u);
    assert.match(source, /summary = validateAutoSummaryForDelivery\(summary, messages\.length\)/u);
});
