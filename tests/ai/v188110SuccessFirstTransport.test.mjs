import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bot = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const telegram = readFileSync(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');
const supervisor = readFileSync(new URL('../../src/runtime/operationSupervisor.js', import.meta.url), 'utf8');
const version = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');

test('V188.110 uses four-hour Telegram document timeout and stronger transfer retries', () => {
    assert.match(telegram, /TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS[\s\S]*4 \* 60 \* 60 \* 1000/u);
    assert.match(telegram, /TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS[\s\S]*\|\| 12/u);
    assert.match(bot, /TELEGRAM_MODEL_FILE_DOWNLOAD_IDLE_MS[\s\S]*30 \* 60 \* 1000/u);
    assert.match(bot, /TELEGRAM_MODEL_FILE_DOWNLOAD_ATTEMPTS[\s\S]*20,[\s\S]*10/u);
    assert.match(bot, /OPENAI_INPUT_FILE_UPLOAD_ATTEMPTS\) \|\| 8/u);
    assert.match(bot, /OPENAI_ARTIFACT_DOWNLOAD_ATTEMPTS\) \|\| 10/u);
    assert.match(bot, /OPENAI_STREAM_IDLE_TIMEOUT_MS[\s\S]*4 \* 60 \* 60 \* 1000/u);
});

test('V188.110 tolerates 1000 transient background polling failures', () => {
    assert.match(bot, /PROJECT_ARCHIVE_MAX_POLL_TRANSIENT_FAILURES\) \|\| 1000/u);
    assert.match(bot, /error\.responseId = responseId/u);
});

test('V188.110 removes hidden two-hour supervisor cap for explicitly long operations', () => {
    assert.match(supervisor, /MAX_OPERATION_TIMEOUT_MS/u);
    assert.match(supervisor, /OPERATION_MAX_TIMEOUT_HOURS/u);
    assert.match(supervisor, /Math\.min\(MAX_OPERATION_TIMEOUT_MS, Number\(timeoutMs\)/u);
    assert.doesNotMatch(supervisor, /Math\.min\(DEFAULT_OPERATION_TIMEOUT_MS, Number\(timeoutMs\)/u);
});

test('V188.110 bounded ambiguous re-POST is success-first but never re-POSTs a known responseId', () => {
    assert.match(bot, /PROJECT_ARCHIVE_AMBIGUOUS_REPOST_LIMIT/u);
    assert.match(bot, /PROJECT_ARCHIVE_SINGLE_RETRY_LIMIT/u);
    assert.match(bot, /ai-ambiguous-repost/u);
    assert.match(bot, /if \(error\?\.responseId\) \{[\s\S]*throw error/u);
    assert.match(bot, /same Idempotency-Key/u);
});

test('V188.110 transport guarantees remain present in successor build', () => {
    assert.ok(Number(version.match(/V188\.(\d+)/u)?.[1] ?? -1) >= 110);
});
