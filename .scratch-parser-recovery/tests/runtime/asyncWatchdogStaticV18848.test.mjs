import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const supervisor = await readFile(new URL('../../src/runtime/operationSupervisor.js', import.meta.url), 'utf8');
const modelProvider = await readFile(new URL('../../src/features/ai/modelProviderFailover.js', import.meta.url), 'utf8');

test('V188.48: user ingress, parser detached work, and schedulers use the supervisor', () => {
    assert.match(app, /name: 'vk-message'[\s\S]{0,300}timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS/u);
    assert.match(app, /name: 'telegram-message'[\s\S]{0,300}timeoutMs: DEFAULT_OPERATION_TIMEOUT_MS/u);
    assert.match(app, /name: 'parser-all'/u);
    assert.match(app, /summary-hierarchy:maintenance/u);
    assert.match(app, /vk-history-recovery:periodic/u);
    assert.doesNotMatch(app, /void \(async \(\) =>/u);
});

test('V188.48: main OpenAI/image/network abort signals are chained to the current operation', () => {
    assert.match(app, /function buildOperationAbortSignal/u);
    assert.match(app, /signal: buildOperationAbortSignal\(/u);
    const rawAbortTimeouts = [...app.matchAll(/AbortSignal\.timeout\(/gu)];
    assert.equal(rawAbortTimeouts.length, 1, 'only the central buildOperationAbortSignal helper may create raw AbortSignal.timeout');
});

test('V188.48: parser writes resumable diagnostics/checkpoints and model ladder logs retries/timeouts/escalation', () => {
    assert.match(app, /parser\.checkpoint\.candidate/u);
    assert.match(app, /completedCandidates/u);
    assert.match(app, /pendingCandidates/u);
    assert.match(app, /registerParserOperationStopHandler/u);
    assert.match(app, /ladderStep/u);
    assert.match(app, /timeoutFailure/u);
    assert.match(app, /ai\.model\.\$\{failoverRecord\.type/u);
    assert.match(supervisor, /operation\.timeout/u);
    assert.match(supervisor, /operation\.complete/u);
    assert.match(supervisor, /process\.unhandled-rejection/u);
    assert.match(modelProvider, /getCurrentOperationSignal/u);
    assert.match(modelProvider, /sleepWithSignal/u);
});
