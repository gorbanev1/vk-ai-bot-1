import assert from 'node:assert/strict';
import { resolveVkChatProvenance } from '../../src/features/events/eventProvenance.js';

const result = resolveVkChatProvenance({
    peerId: 2000000003,
    conversationMessageId: 117872,
    text: 'исходный пост события',
    repostUrls: [
        { url: 'https://vk.ru/wall-194912446_23062', depth: 1 },
        { url: 'https://vk.ru/wall-12_102', depth: 3 },
    ],
});
assert.equal(result.canonicalPostUrl, 'https://vk.ru/wall-12_102');
assert.equal(result.canonicalOrigin, 'chat-repost');
console.log('vkChatProvenanceDeepest.test.mjs: OK');
