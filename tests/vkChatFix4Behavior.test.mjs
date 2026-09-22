import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { runInNewContext } from 'node:vm';
import {
    mergeVkChatSnapshotMedia,
    stableVkChatMessageId,
    captureVkChatObservation,
    assertResolvedVkChatAiResult,
} from '../src/platforms/vk/vkChatIngestSafety.js';

const source = readFileSync(new URL('../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
function functionSource(name, nextName) {
    const start = source.indexOf(`async function ${name}(`);
    const end = source.indexOf(`async function ${nextName}(`, start + 1);
    assert.ok(start >= 0 && end > start, `${name} found in real source`);
    return source.slice(start, end);
}

function scheduledHarness({ messages, failedItems = 0, initialCompleted = true, rejectBatch = false, readError = false } = {}) {
    const runSource = functionSource('run', 'runIfDue');
    const stableMessages = messages ?? [{ conversationMessageId: 410, hasStableConversationMessageId: true }];
    const page = { closed: false, isClosed() { return this.closed; }, async close() { this.closed = true; } };
    const state = { lastMessageId: 400, lastSuccessAt: 1234, initialCompleted, messagesSeen: 0, candidatesChecked: 0, eventsFound: 0 };
    const script = `(() => {
        let manualSessionActive = false;
        const activeRuns = new Map();
        const peerId = 100; const conversationUrl = 'https://vk.com/im?sel=100';
        const safeName = 'test'; const liveMonitorEnabled = false;
        const livePage = page; const queuedFingerprints = new Map();
        const getVkChatScraperState = () => ({ ...state });
        const updateVkChatScraperState = (change) => { Object.assign(state, change); };
        const withPageOperation = (fn) => fn();
        const extractRenderedMessagesWithRetry = async () => { if (readError) throw Error('browser timeout'); return stableMessages; };
        const collectMessages = async () => ({ page, messages: stableMessages });
        const startLiveMonitor = () => { throw Error('live monitor must not start when disabled'); };
        const queueMessagesForProcessing = async (incoming) => {
            if (!manualSessionActive) throw Error('scheduled processing session was not enabled');
            if (rejectBatch) throw Error('processing queue rejected');
            if (incoming !== stableMessages) throw Error('unexpected messages');
            return { changedMessages: incoming.length, candidatesChecked: incoming.length,
                eventsFound: 0, failedItems, lastMessageId: Math.max(0, ...incoming.map(stableVkChatMessageId)) };
        };
        const sleep = async () => {};
        const console = { log() {} };
        ${runSource}
        return { run, getActive: () => manualSessionActive, state, page };
    })()`;
    return runInNewContext(script, { page, state, stableMessages, failedItems, rejectBatch, readError, stableVkChatMessageId });
}

test('scheduled liveMonitor:false activates processing only during batch', async () => {
    const fixture = scheduledHarness();
    const result = await fixture.run();
    assert.equal(result.ok, true);
    assert.equal(result.failedItems, 0);
    assert.equal(fixture.getActive(), false);
    assert.equal(fixture.page.closed, true);
    assert.equal(fixture.state.lastMessageId, 410);
});

test('scheduled partial processing failure preserves prior success and history frontier', async () => {
    const fixture = scheduledHarness({ failedItems: 1 });
    const result = await fixture.run();
    assert.equal(result.ok, false);
    assert.equal(result.failedItems, 1);
    assert.equal(fixture.state.lastSuccessAt, 1234);
    assert.equal(fixture.state.initialCompleted, true);
    assert.equal(fixture.state.lastMessageId, 400);
    assert.match(fixture.state.lastError, /scheduled-processing-failed:1/);
    assert.equal(fixture.getActive(), false);
});

test('scheduled synthetic id is not promoted to historical cursor', async () => {
    const fixture = scheduledHarness({ messages: [
        { conversationMessageId: 999999999, hasStableConversationMessageId: false },
        { conversationMessageId: 405, hasStableConversationMessageId: true },
    ] });
    const result = await fixture.run();
    assert.equal(result.ok, true);
    assert.equal(fixture.state.lastMessageId, 405); // worker-supplied stable cursor
    assert.notEqual(fixture.state.lastMessageId, 999999999);
});

test('empty scheduled batch records success with no synthetic cursor', async () => {
    const fixture = scheduledHarness({ messages: [] });
    const result = await fixture.run();
    assert.equal(result.fetchedMessages, 0);
    assert.equal(result.failedItems, 0);
    assert.equal(fixture.state.lastMessageId, 400); // no new stable CMID
});

test('stable cursor helper rejects synthetic, invalid and negative IDs', () => {
    assert.equal(stableVkChatMessageId({ conversationMessageId: 999, hasStableConversationMessageId: false }), 0);
    assert.equal(stableVkChatMessageId({ conversationMessageId: -4, hasStableConversationMessageId: true }), 0);
    assert.equal(stableVkChatMessageId({ conversationMessageId: 410, hasStableConversationMessageId: true }), 410);
});

test('snapshot merge appends late stable media, updates matched url and ignores unmatched avatar', () => {
    const exact = { imageMedia: [{ url: 'https://example.test/old', attachmentKey: 'PHOTO_1', origin: 'outer' }] };
    const adaptive = { imageMedia: [
        { url: 'https://example.test/new', attachmentKey: 'PHOTO_1', origin: 'outer' },
        { url: 'https://example.test/late', vkPhotoId: 'PHOTO_2', origin: 'outer' },
        { url: 'https://example.test/avatar' },
    ] };
    assert.deepEqual(mergeVkChatSnapshotMedia(exact, adaptive).map((m) => m.url), [
        'https://example.test/new', 'https://example.test/late',
    ]);
    assert.equal(exact.imageMedia[0].url, 'https://example.test/old');
});

test('repeat CMID late poster and date edit are kept distinct', () => {
    const byId = new Map();
    const first = { conversationMessageId: 15, hasStableConversationMessageId: true, contentText: '25 сентября', text: '25 сентября', imageUrls: [], imageMedia: [] };
    assert.equal(captureVkChatObservation(byId, first), true);
    assert.equal(captureVkChatObservation(byId, { ...first, contentText: '26 сентября', text: '26 сентября',
        imageUrls: ['https://example.test/poster'], imageMedia: [{ url: 'https://example.test/poster', attachmentKey: 'photo-5' }] }), false);
    assert.equal(first.text, '26 сентября');
    assert.deepEqual(first.imageUrls, ['https://example.test/poster']);
    assert.equal(first.captureObservations[0].text, '25 сентября');
});

test('AI timeout, null and unresolved are not legitimate empty results', () => {
    for (const invalid of [null, { error: 'timeout', events: [] }, { unresolved: true }]) {
        assert.throws(() => assertResolvedVkChatAiResult(invalid), { code: 'EVENT_AI_UNRESOLVED' });
    }
    assert.deepEqual(assertResolvedVkChatAiResult([]), []);
});

test('browser timeout is propagated instead of converting it into []', async () => {
    const extractSource = functionSource('extractRenderedMessagesWithRetry', 'collectMessages');
    const fn = runInNewContext(`(() => {
        const isConversationPage = () => true;
        const extractRenderedMessages = async () => { throw new Error('browser timeout'); };
        const isTransientBrowserError = () => true;
        const sleep = async () => {};
        ${extractSource}
        return extractRenderedMessagesWithRetry;
    })()`);
    await assert.rejects(fn({ isClosed: () => false }, 'https://vk.com/im', 2), /browser timeout/);
});


test('scheduled batch rejection closes its session and preserves previous success', async () => {
    const fixture = scheduledHarness({ rejectBatch: true });
    await assert.rejects(fixture.run(), /processing queue rejected/);
    assert.equal(fixture.getActive(), false);
    assert.equal(fixture.page.closed, true);
    assert.equal(fixture.state.lastSuccessAt, 1234);
    assert.equal(fixture.state.lastMessageId, 400);
});

test('scheduled browser timeout is not treated as a successful empty capture', async () => {
    const fixture = scheduledHarness({ readError: true });
    await assert.rejects(fixture.run(), /browser timeout/);
    assert.equal(fixture.state.lastSuccessAt, 1234);
    assert.equal(fixture.state.lastMessageId, 400);
    assert.match(fixture.state.lastError, /browser timeout/);
});
