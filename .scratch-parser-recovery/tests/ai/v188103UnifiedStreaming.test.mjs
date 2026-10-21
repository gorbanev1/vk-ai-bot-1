import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const telegramSource = readFileSync(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');
const versionSource = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');

test('V188.103 high/xhigh/max reasoning prefers stream for every text model', () => {
    assert.match(appSource, /HIGH_INTELLIGENCE_STREAM_EFFORTS = new Set\(\['high', 'xhigh', 'max'\]\)/u);
    assert.match(appSource, /isHighIntelligenceReasoningEffort\(reasoningLevel\)[\s\S]*?\? true/u);
    assert.doesNotMatch(appSource, /if \(isAstraModel\(model\)\) \{[\s\S]*?streamOverride: true/u);
});

test('V188.103 every model keeps opposite transport fallback before provider failover', () => {
    assert.match(appSource, /const fallbackStream = auditedFallbackStream === preferredStream[\s\S]*?!preferredStream/u);
    assert.match(appSource, /\[AI RUNTIME TRANSPORT FALLBACK\]/u);
    assert.match(appSource, /streamOutputStarted/u);
});

test('V188.103 both Responses and Chat Completions forward streaming text deltas', () => {
    assert.match(appSource, /response\.output_text\.delta[\s\S]*?safeFileResponseDelta\(delta/u);
    assert.match(appSource, /extractOpenAIIncrementalText\(payload\)[\s\S]*?onTextDelta\?\.\(incremental/u);
});

test('V188.103 Telegram progressively edits the visible answer with throttling', () => {
    assert.match(appSource, /createTelegramTextStreamSession/u);
    assert.match(appSource, /TELEGRAM_STREAM_EDIT_INTERVAL_MS/u);
    assert.match(appSource, /api\.editMessageText/u);
    assert.match(telegramSource, /editMessageText\(/u);
    assert.match(telegramSource, /deleteMessage\(/u);
});

test('V188.103 final answer reuses streamed Telegram messages instead of duplicating them', () => {
    assert.match(appSource, /telegramStreamObserved/u);
    assert.match(appSource, /telegramTextStreamSession\.finalize\(visibleAnswer\)/u);
    assert.match(appSource, /if \(!streamedTelegramAnswerHandled\) \{[\s\S]*?sendLong\(context, visibleAnswer\)/u);
});

test('V188.103 build version is bumped', () => {
    assert.ok(Number(versionSource.match(/V188\.(\d+)/u)?.[1] ?? -1) >= 103);
});
