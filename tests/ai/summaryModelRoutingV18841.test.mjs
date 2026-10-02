import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

import {
    SUMMARY_MODEL_MODE_ORDER,
    getSummaryModelFailoverOptions,
    resolveSummaryStartMode,
} from '../../src/features/ai/summaryModelRouting.js';

test('summaries use the canonical GPT-6 ladder', () => {
    assert.deepEqual(SUMMARY_MODEL_MODE_ORDER, [
        'default',
        'pro3',
        'astra',
    ]);
    assert.equal(resolveSummaryStartMode(), 'default');
});

test('summary requests use the shared finite retry policy', () => {
    assert.deepEqual(getSummaryModelFailoverOptions(), {
        escalateToAdvanced: true,
        failoverMaxRounds: 1,
        failuresBeforeQuarantine: 4,
        useCredentialHealth: false,
        oneCandidatePerMode: true,
    });
});

test('V188.41 auto and hierarchical summaries cannot start from pro3/Sol', async () => {
    const source = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

    assert.match(source, /const AUTO_SUMMARY_MODEL_RETRY_MODES = SUMMARY_MODEL_MODE_ORDER;/u);
    assert.match(source, /const mode = resolveSummaryStartMode\(\);/u);
    assert.doesNotMatch(source, /AUTO_SUMMARY_MODEL_RETRY_MODES\[failures % AUTO_SUMMARY_MODEL_RETRY_MODES\.length\]/u);

    const leafStart = source.indexOf("'Ты строишь долговременную иерархическую память живого группового чата.'");
    const hierarchyMergeStart = source.indexOf("'Объедини узлы иерархической памяти одного группового чата в более высокий уровень.'");
    const summaryLeafStart = source.indexOf("'Составь плотное фактическое резюме этого фрагмента групповой беседы.'");
    const summaryMergeStart = source.indexOf("'Объедини частичные резюме одной групповой беседы.'");
    assert.ok(leafStart > 0 && hierarchyMergeStart > 0 && summaryLeafStart > 0 && summaryMergeStart > 0);

    for (const position of [leafStart, hierarchyMergeStart]) {
        const window = source.slice(Math.max(0, position - 500), position + 100);
        assert.match(window, /getSummaryModelFailoverOptions\(\)/u);
    }
    for (const position of [summaryLeafStart, summaryMergeStart]) {
        const window = source.slice(Math.max(0, position - 500), position + 100);
        assert.match(window, /generateSummaryTextWithQualityGuard\(/u);
    }

    const qualityGuardStart = source.indexOf('async function generateSummaryTextWithQualityGuard(');
    const qualityGuardEnd = source.indexOf('async function createOpenAISummary(', qualityGuardStart);
    const qualityGuard = source.slice(qualityGuardStart, qualityGuardEnd);
    assert.match(qualityGuard, /getSummaryModelFailoverOptions\(\)/u);
    assert.match(qualityGuard, /policy=same-model-once/u);
    assert.match(qualityGuard, /escalateToAdvanced:\s*false/u);
});
