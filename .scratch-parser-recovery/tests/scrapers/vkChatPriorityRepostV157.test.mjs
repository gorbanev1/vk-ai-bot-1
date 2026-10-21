import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    hasVkChatRepostEvidence,
} from '../../src/features/events/eventCandidateRouting.js';
import {
    parseVkChatConfigurations,
} from '../../src/features/scrapers/sourceConfiguration.js';

const special = parseVkChatConfigurations(
    'Главная|https://vk.ru/im/convo/2000000022|300',
)[0];
const manual = parseVkChatConfigurations(
    'Ручная|https://vk.ru/im/convo/2000000014|300',
)[0];

assert.equal(special.autoScrollMessages, 50);
assert.equal(manual.autoScrollMessages, 0);

assert.equal(hasVkChatRepostEvidence({
    text: '[Репост/вложенный пост VK — API]\nКороткий анонс без слова концерт',
    links: [],
}), true);
assert.equal(hasVkChatRepostEvidence({
    text: 'смотри',
    links: ['https://vk.ru/wall-123_456'],
}), true);
assert.equal(hasVkChatRepostEvidence({
    text: 'обычная болтовня',
    links: [],
}), false);

const scraper = readFileSync(
    new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url),
    'utf8',
);
const app = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);
const imageTargets = readFileSync(
    new URL('../../src/features/ai/incomingImageTargets.js', import.meta.url),
    'utf8',
);

assert.match(scraper, /safeAutoScrollMessages/u);
assert.match(scraper, /historyBackfilledMessages/u);
assert.match(scraper, /initialMinCmid/u);
assert.match(scraper, /hasStableConversationMessageId/u);
assert.match(scraper, /hasVkChatRepostEvidence\(message\)/u);
assert.match(scraper, /message\?\.hasRepostEvidence/u);
assert.match(app, /hasRepostEvidence = Boolean/u);
assert.match(scraper, /!textCandidate && !hasVisualEvidence/u);
assert.match(scraper, /repost-hydrated-without-event-date-or-poster/u);
assert.match(app, /autoScrollMessages:\s*configuration\.autoScrollMessages/u);
assert.match(app, /включён history-backfill/u);
assert.match(app, /картинки внутри них проверяются/u);
assert.match(app, /\.slice\(0, 12\)/u);
assert.match(imageTargets, /uniquePush\(urls, value, 12\)/u);

console.log('vkChatPriorityRepostV157.test.mjs: OK');
