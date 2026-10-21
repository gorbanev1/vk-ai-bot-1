import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = await mkdtemp(join(tmpdir(), 'ai-channel-mode-'));
process.env.AI_CHANNEL_MODE_STATE_PATH = join(root, 'mode.json');
const mode = await import('../../src/runtime/aiChannelMode.js');

test('a characteristic source-channel 503 does not switch before the full ladder is exhausted', async () => {
    mode.setAiChannelMode('ordinary');
    const unavailable = new Error('GPT API 503: No providers are available for this model right now. Try changing model source/channel.');
    assert.equal(mode.observeAiModelEvent({ model: 'gpt-6-luna', eventType: 'failure', error: unavailable }), null);
    assert.equal(mode.isAstraChannelMode(), false);
    const transition = mode.observeAiModelEvent({ model: 'gpt-6-luna', eventType: 'all-unavailable', error: unavailable, ladderExhausted: true });
    assert.equal(transition?.transition, 'astra');
    assert.equal(mode.isAstraChannelMode(), true);
});

test('a generic provider 503 without a source-channel signature does not switch modes', async () => {
    mode.setAiChannelMode('ordinary');
    const unavailable = new Error('GPT API 503: No providers are available for this model right now. Please retry later.');
    assert.equal(mode.observeAiModelEvent({ model: 'gpt-6-luna', eventType: 'failure', error: unavailable }), null);
    assert.equal(mode.isAstraChannelMode(), false);
});

test('ordinary network failures do not change channel mode', async () => {
    mode.setAiChannelMode('ordinary');
    const transition = mode.observeAiModelEvent({ model: 'gpt-6-luna', eventType: 'failure', error: Object.assign(new Error('fetch failed'), { code: 'ETIMEDOUT' }) });
    assert.equal(transition, null);
    assert.equal(mode.isAstraChannelMode(), false);
});

test('a Terra success after Luna source-channel failure keeps the ordinary channel', () => {
    mode.setAiChannelMode('ordinary');
    const error = new Error('GPT API 503: Try changing model source/channel.');
    mode.observeAiModelEvent({ model: 'gpt-5.6-luna', eventType: 'failure', error });
    mode.observeAiModelEvent({ model: 'gpt-5.6-terra', eventType: 'success' });
    assert.equal(mode.readAiChannelMode().mode, 'ordinary');
    assert.equal(mode.readAiChannelMode().probeFailures, 0);
});

test('a successful junior-model health response automatically returns to ordinary mode', async () => {
    mode.setAiChannelMode('astra', { modeSource: 'auto', detectedModel: 'gpt-6-astra' });
    const transition = mode.observeAiModelEvent({ model: 'gpt-6-luna', eventType: 'success' });
    assert.equal(transition?.transition, 'ordinary');
    assert.equal(mode.isAstraChannelMode(), false);
});

test('manual Astra mode is not undone by passive junior-model successes', async () => {
    mode.setAiChannelMode('astra', { modeSource: 'manual' });
    const transition = mode.observeAiModelEvent({ model: 'gpt-6-luna', eventType: 'success' });
    assert.equal(transition, null);
    assert.equal(mode.isAstraChannelMode(), true);
});

test('Astra channel routing is limited to user-request AI calls, never event parsing', async () => {
    assert.equal(mode.shouldRouteChatAiToAstra({ channelMode: 'astra', operationCategory: 'user-request', tokenUsageOperation: 'chat' }), true);
    assert.equal(mode.shouldRouteChatAiToAstra({ channelMode: 'astra', operationCategory: 'parser', tokenUsageOperation: 'event-parser:public-text' }), false);
    assert.equal(mode.shouldRouteChatAiToAstra({ channelMode: 'astra', operationCategory: 'ai-channel-probe', tokenUsageOperation: 'ai-channel-health-probe' }), false);
    assert.equal(mode.shouldRouteChatAiToAstra({ channelMode: 'ordinary', operationCategory: 'user-request', tokenUsageOperation: 'chat' }), false);
});

test('deferred operations are acknowledged individually and keep the rest queued', async () => {
    mode.setAiChannelMode('ordinary');
    mode.enqueueDeferredAiOperation({ id: 'one', type: 'parser-command' });
    mode.enqueueDeferredAiOperation({ id: 'two', type: 'summary-command' });
    assert.equal(mode.peekDeferredAiOperation().id, 'one');
    assert.equal(mode.removeDeferredAiOperation('one').id, 'one');
    assert.equal(mode.peekDeferredAiOperation().id, 'two');
});

test.after(async () => { await rm(root, { recursive: true, force: true }); });
