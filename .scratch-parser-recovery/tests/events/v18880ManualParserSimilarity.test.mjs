import test from 'node:test';
import assert from 'node:assert/strict';
import {
  findProcessedNearDuplicate,
  scoreManualParserSeenSimilarity,
} from '../../src/features/events/manualParserSimilarity.js';

const previous = {
  sourceId: 'vk:xlam',
  itemId: '100',
  sourceUrl: 'https://vk.ru/wall-1_100?from=feed',
  observedAt: 1_700_000_000,
  rawText: '19 сентября 20:00 — вечеринка STONEHAND. Ждём всех!',
  attachmentsJson: JSON.stringify(['https://img.example/a.jpg?x=1']),
  parseStatus: 'processed_event',
};

test('97 percent clean-mode ledger match skips effectively identical processed content', () => {
  const current = {
    ...previous,
    sourceUrl: 'https://vk.ru/wall-1_100?new=1',
    attachments: ['https://img.example/a.jpg?another=2'],
  };
  const score = scoreManualParserSeenSimilarity(current, previous);
  assert.ok(score.similarity >= 0.97, JSON.stringify(score));
  assert.ok(findProcessedNearDuplicate(current, [previous], { threshold: 0.97 }));
});

test('meaningfully changed post is not skipped merely because source/id metadata match', () => {
  const current = {
    ...previous,
    rawText: 'Новая акция ресторана: бизнес-ланч и доставка каждый день.',
    attachments: ['https://img.example/new.jpg'],
  };
  const score = scoreManualParserSeenSimilarity(current, previous);
  assert.ok(score.similarity < 0.97, JSON.stringify(score));
  assert.equal(findProcessedNearDuplicate(current, [previous], { threshold: 0.97 }), null);
});
