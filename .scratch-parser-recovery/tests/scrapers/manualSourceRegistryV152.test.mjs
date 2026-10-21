import assert from 'node:assert/strict';
import {
    mergeSourceConfigurations,
    normalizePersistedManualScraperSources,
    parseManualScraperSource,
} from '../../src/features/scrapers/manualSourceRegistry.js';

for (const [input, expectedId] of [
    ['https://t.me/new_channel', 'tg:new_channel'],
    ['https://t.me/s/New_Channel/123', 'tg:new_channel'],
    ['@New_Channel', 'tg:new_channel'],
    ['tg:New_Channel', 'tg:new_channel'],
    ['https://vk.ru/OverlockBar', 'vk:overlockbar'],
    ['vk:OverlockBar', 'vk:overlockbar'],
    ['https://vk.com/wall-95062430_2705', 'vk:club95062430'],
]) {
    const parsed = parseManualScraperSource(input);
    assert.equal(parsed.ok, true, input);
    assert.equal(parsed.source.id, expectedId, input);
}

for (const input of [
    '',
    'https://t.me/+privateInvite',
    'https://t.me/c/123456/7',
    'https://vk.ru/im/convo/2000000001',
    'https://vk.com/wall123_456',
    'https://example.com/foo',
]) {
    assert.equal(parseManualScraperSource(input).ok, false, input);
}

assert.deepEqual(
    mergeSourceConfigurations(
        [{ source: 'One', initialCount: 20 }],
        [{ source: 'one', initialCount: 5 }, { source: 'Two', initialCount: 10 }],
    ),
    [
        { source: 'One', initialCount: 20 },
        { source: 'Two', initialCount: 10 },
    ],
);

const persisted = normalizePersistedManualScraperSources([
    { kind: 'telegram', source: 'New_Channel', initialCount: 20, addedAt: 100 },
    { kind: 'telegram', source: 'new_channel', initialCount: 10, addedAt: 200 },
    { kind: 'vk-public', source: 'OverlockBar', initialCount: 20, addedAt: 300 },
    { kind: 'bad', source: 'ignored' },
]);
assert.deepEqual(persisted.map((item) => item.id), ['tg:new_channel', 'vk:overlockbar']);
assert.equal(persisted[0].addedAt, 100);

console.log('manualSourceRegistryV152 tests: OK');
