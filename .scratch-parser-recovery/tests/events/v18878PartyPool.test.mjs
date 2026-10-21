import test from 'node:test';
import assert from 'node:assert/strict';
import {
  PARTY_POOL_PRIMARY,
  PARTY_POOL_SECONDARY,
  SECONDARY_PARTY_INITIAL_SOURCES,
  classifyEventPartyPool,
  getDefaultSecondaryPartySourceKeys,
  parsePartyPoolRequest,
  partitionEventsByPartyPool,
} from '../../src/features/events/partyPool.js';

test('secondary source seed matches handoff and uses about 10 posts', () => {
  assert.equal(SECONDARY_PARTY_INITIAL_SOURCES.length, 25);
  assert.ok(SECONDARY_PARTY_INITIAL_SOURCES.every((item) => item.initialCount === 10));
  assert.ok(SECONDARY_PARTY_INITIAL_SOURCES.some((item) => item.source === 'arena_voronez'));
  assert.ok(SECONDARY_PARTY_INITIAL_SOURCES.some((item) => item.source === 'kommunavrn'));
  assert.ok(SECONDARY_PARTY_INITIAL_SOURCES.some((item) => item.kind === 'vk-public' && item.source === 'literabar'));
  assert.equal(SECONDARY_PARTY_INITIAL_SOURCES.some((item) => item.kind === 'telegram' && item.source.toLowerCase() === 'litera_vrn_restobar'), false);
});

test('event pool is classified from Telegram/VK provenance and partitioned before dedupe', () => {
  const keys = getDefaultSecondaryPartySourceKeys();
  assert.equal(classifyEventPartyPool({ sourceType: 'telegram', sourceName: '@xlam_bar' }, { secondarySourceKeys: keys }), PARTY_POOL_SECONDARY);
  assert.equal(classifyEventPartyPool({ sourceUrl: 'https://vk.com/arena_voronez?w=wall-1_2' }, { secondarySourceKeys: keys }), PARTY_POOL_SECONDARY);
  assert.equal(classifyEventPartyPool({ sourceType: 'vk_public', sourceName: 'rb_diesel' }, { secondarySourceKeys: keys }), PARTY_POOL_PRIMARY);
  const split = partitionEventsByPartyPool([
    { id: 1, sourceUrl: 'https://t.me/xlam_bar/10' },
    { id: 2, sourceUrl: 'https://vk.ru/rb_diesel' },
  ], { secondarySourceKeys: keys });
  assert.deepEqual(split.secondary.map((item) => item.id), [1]);
  assert.deepEqual(split.primary.map((item) => item.id), [2]);
});

test('canonical secondary request and alias select the secondary pool', () => {
  assert.deepEqual(parsePartyPoolRequest('второстепенные / быдлячьи тусы на месяц'), {
    partyPool: PARTY_POOL_SECONDARY,
    text: 'тусы на месяц',
  });
  assert.equal(parsePartyPoolRequest('быдлячьи тусы').partyPool, PARTY_POOL_SECONDARY);
  assert.equal(parsePartyPoolRequest('тусы на месяц').partyPool, PARTY_POOL_PRIMARY);
});
