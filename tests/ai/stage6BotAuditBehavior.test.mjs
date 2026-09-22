import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { runInNewContext } from 'node:vm';

const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
function extract(name, following, context = {}) {
    const start = source.indexOf(name);
    const end = source.indexOf(following, start + name.length);
    assert.ok(start >= 0 && end > start, `missing ${name}/${following}`);
    return runInNewContext(`${source.slice(start, end)}\n;(${name.match(/(?:async )?function\s+(\w+)/u)?.[1]})`, context);
}
const message = ({sourcePeerId = 2_000_000_101, cmid = 1} = {}) => ({
    sourcePeerId, peerId: 2_000_000_101, conversationMessageId: cmid,
    senderId: 7, createdAt: 1_000, text: 'Повторяем объявление',
});

test('summary history preserves two identical native CMIDs from one source, but aliases recovered cross-source copy', () => {
    const archive = [message({cmid: 1}), message({cmid: 2}), message({sourcePeerId: 2_000_000_102, cmid: 50})];
    const primary = [message({cmid: 1}), message({cmid: 3})];
    const fn = extract('function loadLinkedSummaryHistory(', '\nasync function buildSummaryEntries(', {
        getVkMessageArchiveMessages: () => archive,
        getAllMessages: () => primary,
        summaryMessageDuplicateFingerprint: (row) => createHash('sha256').update(JSON.stringify([
            Number(row.senderId || 0), Number(row.createdAt || 0), String(row.text || '').replace(/\s+/gu, ' ').trim(),
        ])).digest('hex'),
    });
    const result = fn(2_000_000_101);
    assert.deepEqual(Array.from(result, (row) => row.conversationMessageId), [1, 2, 3]);
});

test('hierarchical scan does not discard a distinct native CMID with matching paid content hash', async () => {
    const history = [message({cmid: 1}), message({cmid: 2})];
    const contentHash = createHash('sha256').update(JSON.stringify([7, 1000, 'Повторяем объявление'])).digest('hex');
    const fn = extract('async function ensureHierarchicalChatMemory(', '\nfunction getHierarchicalSummaryPeers(', {
        getHierarchyPeerState: () => ({ bootstrapComplete: true, rootNodeKey: 'root' }),
        filterSummaryMessages: (messages) => messages,
        loadLinkedSummaryHistory: () => history,
        getHierarchyMessageStates: () => [{
            messageKey: '2000000101:1', contentHash, sourcePeerId: 2_000_000_101, conversationMessageId: 1,
        }],
        hierarchyMessageKey: (row) => `${row.sourcePeerId}:${row.conversationMessageId}`,
        hierarchyMessageContentHash: () => contentHash,
        recoveredMessageCanAliasPaidState: (row, states) => states.some((state) =>
            row.sourcePeerId !== state.sourcePeerId || row.conversationMessageId <= 0 || state.conversationMessageId <= 0),
        buildSummaryEntries: async (rows) => rows,
        splitStableSummaryMessageBatches: () => [],
        saveHierarchyPeerState: () => {},
        console: {log() {}},
    });
    const result = await fn(2_000_000_101, 'test-model');
    assert.equal(result.pending, 1);
});

test('secondary source without persisted semantic text is not published', () => {
    const event = { sourceType: 'telegram', channel: 'one', messageId: 5, eventDate: '2026-09-25' };
    let rawText = '';
    const fn = extract('function getRawUpcomingEventsForModeration(', '\nfunction normalizeEventDedupeRef(', {
        getLocalDateString: () => '2026-09-21',
        botTimeZone: 'Europe/Vilnius',
        telegramHtmlScrapers: [{channel: 'one'}], secondaryTelegramHtmlScrapers: [],
        vkPublicScrapers: [], secondaryVkPublicScrapers: [], vkChatEventScrapers: [],
        getSecondaryPartySourceKeys: () => new Set(),
        getAllUpcomingEventRecordsForDedupe: () => [event],
        classifyEventPartyPool: () => 'secondary', PARTY_POOL_SECONDARY: 'secondary',
        getTelegramPostMeta: () => ({ rawText, publishedAt: 0 }),
        getVkPostMeta: () => null,
        isEventDateConsistentWithSource: ({sourceText}) => /25\.09/u.test(sourceText),
    });
    assert.equal(fn().length, 0);
    rawText = 'Концерт состоится 25.09';
    assert.equal(fn().length, 1);
});

test('compact public list contains only title, date/time, venue, price, without source or description', () => {
    const fn = extract('function buildCompactPublicEventsMessage(', '\nasync function sendCompactPublicEventList(', {
        compactPartyHeading: () => 'Афиша',
        cleanEventTitle: (value) => value,
        stripKnownVenueNamesFromEventTitle: (value) => value,
        cleanVkEventText: (value) => String(value),
        formatIsoEventDate: (value) => value,
        getCompactSupportedTime: (value) => value.eventTime,
    });
    const rendered = fn([{event: {
        title: 'Событие', eventDate: '2026-09-25', eventTime: '19:00', venue: 'Клуб', price: '100',
        participants: 'СЕКРЕТНЫЕ УЧАСТНИКИ', description: 'СЕКРЕТНОЕ ОПИСАНИЕ', sourceUrl: 'https://do-not-include.test',
    }}], {});
    assert.match(rendered, /Событие/u);
    assert.match(rendered, /Клуб/u);
    assert.match(rendered, /100/u);
    assert.doesNotMatch(rendered, /СЕКРЕТ|https:\/\//u);
});

test('Vision HTTP rejection reports provider status, not missing watchdog reference', async () => {
    const fn = extract('async function generateOpenAIVisionTextCore(', '\nfunction ', {
        normalizeOpenAIBaseUrl: () => 'https://router.example/v1',
        openAIBaseUrl: 'https://router.example/v1', openAIApiKey: 'dummy',
        OPENAI_REQUEST_TIMEOUT_MS: 1000,
        inferAiTokenOperation: () => 'vision',
        buildOperationAbortSignal: () => undefined,
        fetch: async () => ({ok: false, status: 400, text: async () => '{"error":{"message":"invalid image"}}'}),
    });
    await assert.rejects(fn({model:'vision',systemPrompt:'s',userPrompt:'u',imageUrls: []}), /GPT vision API 400: invalid image/u);
});

test('all recursive compatibility retries preserve durable callbacks and idempotency', () => {
    for (const [name, next, count] of [
        ['async function generateOpenAITextWithFilesAttempt(', 'async function generateOpenAITextCoreAttempt(', 1],
        ['async function generateOpenAITextCoreAttempt(', '\nasync function ', 2],
    ]) {
        const start = source.indexOf(name);
        const end = source.indexOf(next, start + name.length);
        const body = source.slice(start, end);
        const pattern = /return generateOpenAIText(?:WithFilesAttempt|CoreAttempt)\(\{([\s\S]*?)\}\);/gu;
        const calls = [...body.matchAll(pattern)].filter(([all]) => all.includes('requestTimeoutMs'));
        assert.equal(calls.length, count + (name.includes('CoreAttempt') ? 1 : 0));
        for (const [, args] of calls) {
            for (const field of ['backgroundResponse','inferenceIdempotencyKey','onBackgroundResponseCreated','onInputFileUploaded','textJobAbortSignal']) {
                assert.match(args, new RegExp(`\\b${field}\\b`, 'u'), `${field} missing in ${name}`);
            }
        }
    }
});

test('image generation legacy fallback retains token usage context', () => {
    const start = source.indexOf('async function generateOpenAIImageNonStream(');
    const end = source.indexOf('\nasync function generateOpenAIImageLegacyChat(', start);
    const method = source.slice(start, end);
    assert.match(method, /return generateOpenAIImageLegacyChat\(\{[\s\S]*?tokenUsageOperation,[\s\S]*?tokenUsageMetadata,[\s\S]*?streamOverride: legacyStreamOverride/su);
});

test('private memory separates VK and Telegram with same numeric sender', () => {
    const fn = extract('function privateMemoryKey(', '\nfunction getPrivateConversationMemory(', {getRawContext: (context) => context});
    assert.notEqual(fn({platform: 'vk', senderId: 12}), fn({platform:'telegram', senderId: 12}));
    assert.equal(fn({platform: 'vk', senderId: 12}), fn({platform:'vk', externalSenderId: 12, senderId: 999}));
});

test('splitLines preserves entire long content and enforces max chunk size', () => {
    const fn = extract('function splitLines(', '\nfunction pluralize(', {});
    const original = 'начало' + ' x'.repeat(205) + ' конец';
    const chunks = fn([original], 23);
    assert.ok(chunks.length > 10);
    assert.ok(chunks.every((chunk) => chunk.length <= 23));
    assert.equal(chunks.join(''), original);
    const short = fn(['aaa','bbb'], 50);
    assert.equal(short.join(''), 'aaa\nbbb');
    assert.throws(() => fn(['x'], 0), /maxLength/u);
});
