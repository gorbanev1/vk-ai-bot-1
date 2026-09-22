import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const appSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const streamSource = readFileSync(new URL('../../src/features/ai/openAIStream.js', import.meta.url), 'utf8');
const telegramSource = readFileSync(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');
const versionSource = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');

test('V188.107+ project audit keeps multipass opt-in and successor builds keep bounded single-shot retries', () => {
    assert.match(appSource, /PROJECT_ARCHIVE_AUDIT_MULTIPASS_ENABLED/u);
    assert.match(appSource, /PROJECT_ARCHIVE_SINGLE_MAX_CHARS/u);
    assert.match(appSource, /if \(!useTextMultipass\)/u);
    assert.match(appSource, /stage: 'single-shot'/u);
    assert.match(appSource, /forceStream: true/u);
    assert.match(appSource, /PROJECT_ARCHIVE_SINGLE_RETRY_LIMIT/u);
    assert.match(appSource, /PROJECT_ARCHIVE_AMBIGUOUS_REPOST_LIMIT/u);
});

test('V188.107 Responses streaming uses an inactivity watchdog rather than the 15 minute request timeout', () => {
    assert.match(appSource, /OPENAI_STREAM_IDLE_TIMEOUT_MS/u);
    assert.match(appSource, /createIdleAbortWatchdog/u);
    assert.match(appSource, /const requestSignal = resolvedStreaming[\s\S]*?streamWatchdog\?\.signal[\s\S]*?getCurrentOperationSignal\(\)/u);
    assert.match(appSource, /onActivity\(\) \{[\s\S]*?streamWatchdog\?\.touch\(\)/u);
    assert.match(streamSource, /onActivity/u);
    assert.match(streamSource, /if \(value\?\.byteLength\) \{[\s\S]*?onActivity\?\./u);
});

test('V188.107 fixes AbortSignal fallback composition', () => {
    assert.match(appSource, /function combineAbortSignals\(signals\)/u);
    assert.match(appSource, /signal\.addEventListener\('abort'/u);
    assert.match(appSource, /return combineAbortSignals\(\[localSignal, getCurrentOperationSignal\(\)\]\)/u);
});

test('V188.107 Telegram document upload is not killed by the generic 15 second timeout and retries transient failures', () => {
    assert.match(telegramSource, /hasExplicitSignal/u);
    assert.match(telegramSource, /TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS/u);
    assert.match(telegramSource, /TELEGRAM DOCUMENT RETRY/u);
    assert.match(telegramSource, /TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS/u);
    assert.doesNotMatch(telegramSource, /sendDocument[\s\S]{0,1600}?AbortSignal\.timeout\(15_000\)/u);
});

test('V188.107 keeps useful V188.106 resilient multipass machinery behind explicit opt-in', () => {
    assert.match(appSource, /backgroundResponse: useBackground/u);
    assert.match(appSource, /auditProjectBatchResilient/u);
    assert.match(appSource, /writeProjectAuditCheckpoint/u);
    assert.match(appSource, /PROJECT_ARCHIVE_AUDIT_LEAF_RETRY_LIMIT/u);
    assert.match(appSource, /1,\s*8,\s*3,/u);
});

test('V188.107 multipass sends only the final ZIP attachment', () => {
    assert.doesNotMatch(appSource, /message: `📋 \$\{jobId\}: отчёт аудита`/u);
    assert.match(appSource, /ASTRA_AUDIT_REPORT\.md/u);
    assert.match(appSource, /attachment: zipAttachment/u);
});

test('V188.107 build version is bumped', () => {
    assert.ok(Number(versionSource.match(/V188\.(\d+)/u)?.[1] ?? -1) >= 107);
});
