import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bot = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const telegram = readFileSync(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');
const audit = readFileSync(new URL('../../src/features/audit/projectArchiveAudit.js', import.meta.url), 'utf8');
const version = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');

test('V188.108 single-shot auto transport prefers same-response background and retains SSE fallback', () => {
    assert.match(bot, /PROJECT_ARCHIVE_SINGLE_TRANSPORT/u);
    assert.match(bot, /background-auto/u);
    assert.match(bot, /stream-auto-fallback/u);
    assert.match(bot, /PROJECT_ARCHIVE_SINGLE_RETRY_LIMIT/u);
    assert.match(bot, /disableTransportFallback:\s*true/u);
});

test('V188.108 project single-shot permits enough Astra reasoning budget without enabling multipass', () => {
    assert.match(bot, /PROJECT_ARCHIVE_SINGLE_MAX_OUTPUT_TOKENS/u);
    assert.match(bot, /64_000/u);
    assert.match(bot, /PROJECT_ARCHIVE_AUDIT_MULTIPASS_ENABLED/u);
    assert.match(bot, /process\.env\.PROJECT_ARCHIVE_AUDIT_MULTIPASS/u);
});

test('V188.108 Telegram document delivery has no generic 15 second cutoff, retries and verifies reported bytes', () => {
    assert.match(telegram, /TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS/u);
    assert.match(telegram, /TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS/u);
    assert.match(telegram, /response size mismatch/u);
    assert.match(telegram, /TELEGRAM_BOT_API_BASE_URL/u);
    assert.match(telegram, /TELEGRAM_BOT_FILE_BASE_URL/u);
});

test('V188.108 incoming Telegram files use idle watchdog and resilient retries', () => {
    assert.match(bot, /TELEGRAM_MODEL_FILE_DOWNLOAD_IDLE_MS/u);
    assert.match(bot, /downloadTelegramFileBuffer/u);
    assert.match(bot, /TELEGRAM FILE DOWNLOAD RETRY/u);
    assert.match(bot, /TELEGRAM_MODEL_FILE_MAX_MB/u);
});

test('V188.108 validates ZIP paths and CRC before expensive Astra work and before delivery', () => {
    assert.match(audit, /duplicate ZIP path/u);
    assert.match(audit, /ZIP CRC32 mismatch/u);
    assert.match(audit, /local\/central filename mismatch/u);
    assert.match(bot, /output-persisted/u);
    assert.match(bot, /outputSha256/u);
    assert.match(bot, /ready-to-send/u);
});

test('V188.108 always has a ZIP fallback and keeps a durable outbox copy', () => {
    assert.match(bot, /ASTRA_RESULT\/ASTRA_RESPONSE\.md/u);
    assert.match(bot, /ASTRA_RESULT\/ARTIFACT_FAILURES\.json/u);
    assert.match(bot, /data\/audit-jobs/u);
    assert.match(bot, /outbox/u);
    assert.match(bot, /delivery-failed/u);
});

test('V188.108 version is bumped', () => {
    assert.ok(Number(version.match(/V188\.(\d+)/u)?.[1] ?? -1) >= 108);
});
