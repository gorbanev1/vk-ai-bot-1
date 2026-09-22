import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    isExplicitTelegramNonImageCommand,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V162 scheduler has no global lock that can freeze every chat', () => {
    assert.doesNotMatch(appSource, /let\s+autoSummaryTickRunning\s*=\s*false/u);
    assert.match(appSource, /const\s+autoSummaryPeerRuns\s*=\s*new Map\(\)/u);
    assert.match(appSource, /AUTO SUMMARY WATCHDOG RELEASE/u);
    assert.match(appSource, /void processDueAutoSummarySetting/u);
});

test('V162 scheduler uses bounded external calls and a five-second due poll', () => {
    assert.match(appSource, /const AUTO_SUMMARY_TIMER_MS = 5 \* 1000;/u);
    assert.match(appSource, /withAutoSummaryTimeout\(/u);
    assert.match(appSource, /AUTO_SUMMARY_CLOCK_SYNC_TIMEOUT_MS/u);
    assert.match(appSource, /AUTO_SUMMARY_HISTORY_REQUEST_TIMEOUT_MS/u);
    assert.match(appSource, /OPENAI_REQUEST_TIMEOUT_MS/u);
    assert.match(appSource, /AUTO_SUMMARY_RETRY_SECONDS/u);
    assert.match(appSource, /AUTO_SUMMARY_SEND_TIMEOUT_MS/u);
});

test('V162 Telegram scheduled summary uses TelegramBotApi object signature', () => {
    assert.match(appSource, /telegramBot\.api\.sendMessage\(\{\s*chatId,\s*text:\s*chunk\s*\}\)/u);
    assert.doesNotMatch(appSource, /telegramBot\.api\.sendMessage\(chatId,\s*chunk\)/u);
});

test('V162 author-summary commands escape pending Telegram menu modes', () => {
    assert.equal(isExplicitTelegramNonImageCommand('авторезюме статус'), true);
    assert.equal(isExplicitTelegramNonImageCommand('Гигорейв авторезюме сейчас'), true);

    const result = resolveTelegramMenuInput(
        'авторезюме https://vk.ru/im/convo/2000000027 статус',
        { pendingAction: 'document_pdf', pendingModel: 'pro' },
        { isOwner: true, now: new Date('2026-09-06T12:00:00Z'), hasImageAttachment: false },
    );
    assert.equal(result.type, 'command');
    assert.equal(result.text, 'авторезюме https://vk.ru/im/convo/2000000027 статус');
});
