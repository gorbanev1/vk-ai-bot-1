import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    DEFAULT_AUTO_SUMMARY_LIMITS,
    formatAutoSummaryLimits,
    normalizeAutoSummaryLimits,
    parseAutoSummaryLimits,
} from '../../src/features/ai/autoSummaryLimits.js';
import { createAutoSummaryStateStore } from '../../src/infrastructure/database/autoSummaryStateStore.js';

test('auto-summary limits round-trip the complete editable list', () => {
    const formatted = formatAutoSummaryLimits(DEFAULT_AUTO_SUMMARY_LIMITS);
    const parsed = parseAutoSummaryLimits(formatted);
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.updates, DEFAULT_AUTO_SUMMARY_LIMITS);

    const flattened = formatted.replace(/\n/gu, ' ');
    const flattenedParsed = parseAutoSummaryLimits(flattened);
    assert.deepEqual(flattenedParsed.errors, []);
    assert.deepEqual(flattenedParsed.updates, DEFAULT_AUTO_SUMMARY_LIMITS);
});

test('auto-summary limits accept Russian aliases and partial edits', () => {
    const parsed = parseAutoSummaryLimits('батч 1200; абзацы 6; рабочая неделя 4320');
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.updates, {
        intraday_chars: 1200,
        intraday_paragraphs: 6,
        workweek_chars: 4320,
    });
    assert.equal(normalizeAutoSummaryLimits(parsed.updates).intraday_chars, 1200);
});

test('season length is configurable and appears in the owner-editable limits list', () => {
    const parsed = parseAutoSummaryLimits('сезон 7200');
    assert.deepEqual(parsed.errors, []);
    assert.deepEqual(parsed.updates, { season_chars: 7200 });
    assert.equal(normalizeAutoSummaryLimits(parsed.updates).season_chars, 7200);
    assert.match(formatAutoSummaryLimits(DEFAULT_AUTO_SUMMARY_LIMITS), /season_chars = 6000/u);
});

test('auto-summary limits metadata survives store reopen', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gigorave-summary-limits-'));
    const first = createAutoSummaryStateStore({ directory });
    first.saveMeta('summary_limits', JSON.stringify({ intraday_chars: 1400, intraday_paragraphs: 7 }));
    first.close();

    const second = createAutoSummaryStateStore({ directory });
    assert.deepEqual(JSON.parse(second.getMeta('summary_limits', '{}')), {
        intraday_chars: 1400,
        intraday_paragraphs: 7,
    });
    second.close();
});
