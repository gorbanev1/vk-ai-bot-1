import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

const bot = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const telegram = readFileSync(new URL('../../src/platforms/telegram/telegramBot.js', import.meta.url), 'utf8');
const failover = readFileSync(new URL('../../src/features/ai/modelProviderFailover.js', import.meta.url), 'utf8');
const reporter = readFileSync(new URL('../../src/features/ai/attachmentFailureReporter.js', import.meta.url), 'utf8');
const providerAudit = readFileSync(new URL('../../src/features/ai/providerKeyAudit.js', import.meta.url), 'utf8');
const version = readFileSync(new URL('../../src/shared/buildVersion.js', import.meta.url), 'utf8');

test('V188.109 project input is durable before detached Astra and uses model file upload', () => {
    assert.match(bot, /downloadTelegramFileToPath/u);
    assert.match(bot, /status:\s*'source-persisted'/u);
    assert.match(bot, /context\.markDurableIntake/u);
    assert.match(bot, /sanitized-audit-input\.zip/u);
    assert.match(bot, /uploadOpenAIInputFile/u);
    assert.match(bot, /type:\s*'input_file',\s*file_id/u);
});

test('V188.109 checkpoints background response id and recovers without new inference', () => {
    assert.match(bot, /onBackgroundResponseCreated/u);
    assert.match(bot, /status:\s*'astra-running'/u);
    assert.match(bot, /responseId/u);
    assert.match(bot, /recoverProjectAuditJobs/u);
    assert.match(bot, /recoverRunningProjectAudit/u);
    assert.match(bot, /pollOpenAIBackgroundResponse/u);
});

test('V188.109+ keeps project failover at one and never re-POSTs a known responseId', () => {
    assert.match(bot, /failuresBeforeQuarantine:\s*1/u);
    assert.match(bot, /if \(error\?\.responseId\) \{[\s\S]*throw error/u);
    assert.match(bot, /PROJECT_ARCHIVE_AMBIGUOUS_REPOST_LIMIT/u);
    assert.match(failover, /error\?\.inferenceMayHaveStarted/u);
    assert.match(failover, /error\?\.streamOutputStarted/u);
    assert.match(failover, /error\?\.responseId/u);
    assert.match(bot, /BACKGROUND_RESPONSE_NOT_FOUND/u);
    assert.match(bot, /BACKGROUND_CAPABILITY_UNSUPPORTED/u);
});

test('V188.109 project artifacts are streamed to durable job storage before outbox delivery', () => {
    assert.match(bot, /persistDirectory/u);
    assert.match(bot, /'artifacts'/u);
    assert.match(bot, /await handle\.sync\(\)/u);
    assert.match(bot, /sha256:\s*hash\.digest\('hex'\)/u);
});

test('V188.109 uses stable idempotency and handles JSON returned to stream request', () => {
    assert.match(bot, /Idempotency-Key/u);
    assert.match(bot, /project-audit:\$\{jobId\}:single-shot/u);
    assert.match(bot, /responses-json-fallback/u);
    assert.match(bot, /content-type/u);
});

test('V188.109 Telegram large-document path uses filePath, bounded long timeout and abortable retry', () => {
    assert.match(telegram, /openAsBlob/u);
    assert.match(telegram, /document\.filePath/u);
    assert.match(telegram, /TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS/u);
    assert.match(telegram, /status === 408/u);
    assert.match(telegram, /status === 409/u);
    assert.match(telegram, /status === 425/u);
    assert.match(telegram, /waitTelegramRetry\(delayMs, signal\)/u);
    assert.match(telegram, /combineTelegramAbortSignals/u);
});

test('V188.109 atomically persists state/outbox and keeps Telegram offset behind durable intake', () => {
    assert.match(bot, /temporaryPath = `\$\{statePath\}\.\$\{process\.pid\}\.\$\{randomUUID\(\)\}\.tmp`/u);
    assert.match(bot, /fsyncSync\(descriptor\)/u);
    assert.match(bot, /renameSync\(temporaryPath, statePath\)/u);
    assert.match(bot, /ready-to-send/u);
    assert.match(bot, /delivery-failed/u);
    assert.match(telegram, /waitForDurableIntake/u);
    assert.match(telegram, /saveOffset/u);
});

test('V188.109 diagnostics do not serialize binary payloads and compat numbered keys are excluded from key audit', () => {
    assert.match(reporter, /buffer omitted/u);
    assert.match(reporter, /binary omitted/u);
    assert.match(providerAudit, /OPENAI_COMPAT_API_KEY\(\?:_\\d\+\)\?/u);
});

test('V188.109 version is bumped', () => {
    assert.ok(Number(version.match(/V188\.(\d+)/u)?.[1] ?? -1) >= 109);
});
