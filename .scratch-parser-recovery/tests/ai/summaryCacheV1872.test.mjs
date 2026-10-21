import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { createSummaryStateStore } from '../../src/infrastructure/database/summaryStateStore.js';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V187.2 durable summary cache survives reopen', () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-v1872-summary-'));
    const dbPath = join(dir, 'summary.sqlite');
    try {
        const first = createSummaryStateStore({ databasePath: dbPath });
        first.save({ cacheKey: 'abc', stage: 'leaf', model: 'gpt-test', inputCount: 500, outputText: 'cached result' });
        first.close();
        const second = createSummaryStateStore({ databasePath: dbPath });
        assert.equal(second.get('abc')?.outputText, 'cached result');
        assert.equal(second.get('abc')?.inputCount, 500);
        second.close();
    } finally {
        rmSync(dir, { recursive: true, force: true });
    }
});

test('V188 explicit summary keeps durable cache and adaptive token-sized batches', () => {
    assert.match(source, /SUMMARY_COMMAND_BATCH_MESSAGES = 5_000/u);
    assert.match(source, /HIERARCHICAL_SUMMARY_CONTEXT_TOKENS/u);
    assert.match(source, /HIERARCHICAL_SUMMARY_INPUT_TOKEN_BUDGET/u);
    assert.match(source, /splitStableSummaryMessageBatches/u);
    assert.match(source, /getCachedSummaryStage/u);
    assert.match(source, /saveCachedSummaryStage/u);
    assert.match(source, /\[SUMMARY CACHE HIT\]/u);
    assert.match(source, /\[SUMMARY V188 COMPLETE\]/u);
    assert.doesNotMatch(source.slice(source.indexOf('async function createOpenAISummary'), source.indexOf('async function collectStoredChatParticipants')), /SUMMARY_CHUNK_SIZE/u);
});
