import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V187 removes daily dossier/style GPT backfill', () => {
    assert.equal(source.includes('runDailyPersonalizationJobs'), false);
    assert.equal(source.includes('[DAILY PERSONALIZATION]'), false);
    assert.equal(source.includes('updateParticipantFromDay'), false);
});

test('V187 makes dossier command-only and style 500-message batched', () => {
    assert.match(source, /dossier=command-only/u);
    assert.match(source, /STYLE_PERSONALIZATION_BATCH_MESSAGES/u);
    assert.match(source, /pending\.length < STYLE_PERSONALIZATION_BATCH_MESSAGES/u);
    assert.match(source, /pending\.slice\(0, STYLE_PERSONALIZATION_BATCH_MESSAGES\)/u);
    assert.match(source, /startupBackfill=disabled/u);
    assert.doesNotMatch(source, /INITIAL STYLE PERSONALIZATION/u);
    assert.match(source, /gptCallsThisRun >= 1/u);
    assert.match(source, /global-one-call-per-cycle/u);
});

test('V187 dossier checkpoints every successful paid batch', () => {
    assert.match(source, /saveDossierCommandState\(\{/u);
    assert.match(source, /\[DOSSIER COMMAND CHECKPOINT\]/u);
    assert.match(source, /if \(!pendingMessages\.length\)/u);
    assert.match(source, /gptCalls: 0/u);
});
