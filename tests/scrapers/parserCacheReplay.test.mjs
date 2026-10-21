import assert from 'node:assert/strict';
import test from 'node:test';
import { createVkPublicScraper } from '../../src/platforms/vk/vkPublicScraper.js';
import { createTelegramHtmlScraper } from '../../src/platforms/telegram/telegramHtmlScraper.js';
import { createVkChatEventScraper } from '../../src/platforms/vk/vkChatEventScraper.js';
import { getManualParserSeenItem, markManualParserSeenItemFailed, finalizeManualParserSeenItem, isManualParserSeenItemFinalStatus } from '../../src/infrastructure/database/index.js';

const noNetwork = () => { throw new Error('Recovery unexpectedly requested network/AI'); };
for (const platform of ['vk', 'tg', 'chat']) {
    test(`${platform}: cached replay resumes failed item, skips completed item and is idempotent`, async () => {
        const dataDirectory = process.env.GIGORAVE_DATA_DIR;
        const name = `recovery_${platform}`;
        const peerId = 2000099922;
        const sourceId = platform === 'chat' ? `chat:${peerId}` : `${platform}:${name}`;
        const items = [1, 2].map((id) => ({
            postId: id, messageId: id, conversationMessageId: id, hasStableConversationMessageId: true,
            screenName: name, channel: name, text: 'Концерт 1 января 2000 года в 19:00. Архив.',
            sourceUrl: platform === 'vk' ? `https://vk.ru/wall-999_${id}` : platform === 'tg' ? `https://t.me/${name}/${id}` : '',
            links: [], repostUrls: [], attachmentLinks: [], imageUrls: [], publishedAt: 946684800, createdAt: 946684800,
        }));
        const scraper = platform === 'vk' ? createVkPublicScraper({ screenName: name, dataDirectory, downloadImages: false, hydratePostsWithApi: noNetwork, extractEventsWithAi: noNetwork })
            : platform === 'tg' ? createTelegramHtmlScraper({ channel: name, dataDirectory, downloadImages: false, extractEventsWithAi: noNetwork })
                : createVkChatEventScraper({ conversationUrl: `https://vk.ru/im?sel=c${peerId - 2000000000}`, dataDirectory, liveMonitor: false, analyzeMessageWithAi: noNetwork, hydrateMessageEvidence: noNetwork });
        const run = (options) => platform === 'chat' ? scraper.runFiniteManualPass(options) : scraper.run(options);
        let durableItems = items;
        const diagnostics = { cacheSource: ({ items: captured }) => { durableItems = JSON.parse(JSON.stringify(captured)); return ''; } };
        await run({ cachedItems: items, diagnostics, incrementalOnly: false });
        assert.equal(isManualParserSeenItemFinalStatus(getManualParserSeenItem({ sourceId, itemId: '1' }).parseStatus), true);
        const saved = getManualParserSeenItem({ sourceId, itemId: '1' });
        markManualParserSeenItemFailed({ sourceId, itemId: '2', error: 'simulated process crash' });
        const progress = [];
        const result = await run({ cachedItems: durableItems, diagnostics, incrementalOnly: true, onProcessingProgress: (event) => progress.push(event) });
        assert.equal(result.incrementalKnownSkippedCount, 1);
        assert.equal(isManualParserSeenItemFinalStatus(getManualParserSeenItem({ sourceId, itemId: '2' }).parseStatus), true);
        assert.equal(getManualParserSeenItem({ sourceId, itemId: '1' }).attemptCount, saved.attemptCount);
        assert.equal(progress.filter((event) => event.type === 'start').length, 1);
        const again = await run({ cachedItems: durableItems, diagnostics, incrementalOnly: true });
        assert.equal(again.incrementalKnownSkippedCount, 2);
        // Full reparse was interrupted before revisiting item 1: its old final
        // status cannot be confused with item 2 completed in the current pass.
        const passStartedAt = Math.floor(Date.now() / 1000) - 30;
        finalizeManualParserSeenItem({ sourceId, itemId: '1', parseStatus: 'processed_rejected', processedAt: passStartedAt - 100 });
        const fullResume = await run({ cachedItems: durableItems, diagnostics, incrementalOnly: true, resumeCompletedSince: passStartedAt });
        assert.equal(fullResume.incrementalKnownSkippedCount, 1);
        assert.ok(getManualParserSeenItem({ sourceId, itemId: '1' }).processedAt >= passStartedAt);
        const empty = await run({ cachedItems: [], incrementalOnly: true });
        assert.equal(empty.failedProcessingItems, 0);
    });
}
