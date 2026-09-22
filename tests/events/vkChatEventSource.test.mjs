import assert from 'node:assert/strict';

import {
    filterVkChatPublicMessageLinks,
    formatVkChatEventSourceBlock,
    isVkConversationUrl,
    selectVkChatPublicSourceUrl,
} from '../../src/platforms/vk/vkChatEventSource.js';

assert.equal(
    isVkConversationUrl('https://vk.ru/im/convo/2000000022?cmid=8'),
    true,
);
assert.equal(
    isVkConversationUrl('https://vk.com/im?sel=c22'),
    true,
);
assert.equal(
    isVkConversationUrl('https://vk.ru/wall-123_456'),
    false,
);

assert.deepEqual(
    filterVkChatPublicMessageLinks([
        'https://vk.ru/im/convo/2000000022?cmid=8',
        'https://tickets.example/event/42',
        'https://vk.ru/wall-123_456',
    ]),
    [
        'https://tickets.example/event/42',
        'https://vk.ru/wall-123_456',
    ],
);

assert.equal(
    selectVkChatPublicSourceUrl([
        'https://vk.ru/im/convo/2000000022?cmid=8',
        'https://tickets.example/event/42',
    ]),
    'https://tickets.example/event/42',
);
assert.equal(
    selectVkChatPublicSourceUrl(
        ['https://vk.ru/id123', 'https://other.example/preview'],
        'Билеты: https://tickets.example/event/99',
    ),
    'https://tickets.example/event/99',
);
assert.equal(
    selectVkChatPublicSourceUrl([
        'https://vk.ru/im/convo/2000000022?cmid=8',
    ]),
    '',
);
assert.equal(
    formatVkChatEventSourceBlock('https://vk.ru/im/convo/2000000022?cmid=8'),
    'Информация с беседы',
);
assert.equal(
    formatVkChatEventSourceBlock('https://tickets.example/event/42'),
    'Источник:\nhttps://tickets.example/event/42',
);

console.log('vkChatEventSource tests: OK');
