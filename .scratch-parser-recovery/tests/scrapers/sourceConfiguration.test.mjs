import assert from 'node:assert/strict';

import {
    parseSourceCountList,
    parseVkChatConfigurations,
} from '../../src/features/scrapers/sourceConfiguration.js';

assert.deepEqual(
    parseSourceCountList('alpha:35,beta:100'),
    [
        { source: 'alpha', initialCount: 20 },
        { source: 'beta', initialCount: 20 },
    ],
);
assert.equal(parseSourceCountList('alpha:99999')[0].initialCount, 20);
assert.equal(parseSourceCountList('alpha:7')[0].initialCount, 7);
assert.deepEqual(
    parseVkChatConfigurations('Test|https://vk.ru/im/convo/2000000001|450'),
    [{
        name: 'Test',
        url: 'https://vk.ru/im?sel=c1',
        initialMessages: 450,
        autoScrollMessages: 0,
    }],
);
assert.equal(
    parseVkChatConfigurations('Priority|https://vk.ru/im/convo/2000000022|300')[0].autoScrollMessages,
    50,
);

assert.equal(
    parseVkChatConfigurations('PriorityOldEnv|https://vk.ru/im/convo/2000000022|300|25')[0].autoScrollMessages,
    50,
);

assert.equal(
    parseVkChatConfigurations('Manual|https://vk.ru/im/convo/2000000014|300')[0].autoScrollMessages,
    0,
);
assert.equal(
    parseVkChatConfigurations('Custom|https://vk.ru/im/convo/2000000014|300|40')[0].autoScrollMessages,
    50,
);


assert.equal(
    parseVkChatConfigurations('Stable|https://vk.ru/im?sel=c22|300')[0].url,
    'https://vk.ru/im?sel=c22',
);

console.log('sourceConfiguration tests: OK');
