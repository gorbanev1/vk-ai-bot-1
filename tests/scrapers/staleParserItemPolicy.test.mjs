import test from 'node:test';
import assert from 'node:assert/strict';
import { buildStaleParserItemKeys, isStaleParserItem, isStaleParserPreview, isParserItemOlderThanMaxAge } from '../../src/features/scrapers/staleParserItemPolicy.js';

test('stale parser items are blocked from browser image recovery by source and item id', () => {
    const captures = [{
        sourceId: 'vk:meetbowling.club',
        prefilterPreviews: [
            { itemId: '14', aiAdmission: { rejectionReason: 'stale-post-outside-recent-window' } },
            { itemId: '15', aiAdmission: { rejectionReason: 'stale-post-outside-recent-window' } },
            { itemId: '16', aiAdmission: { rejectionReason: 'future-event' } },
        ],
    }];
    const stale = buildStaleParserItemKeys(captures);
    assert.equal(isStaleParserItem(stale, 'vk:meetbowling.club', { postId: 14 }), true);
    assert.equal(isStaleParserPreview(stale, 'vk:meetbowling.club', { itemId: '15' }), true);
    assert.equal(isStaleParserItem(stale, 'vk:meetbowling.club', { postId: 16 }), false);
    assert.equal(isStaleParserItem(stale, 'vk:other', { postId: 14 }), false);
});

test('six-month parser cutoff is also blocked from browser recovery', () => {
    const stale = buildStaleParserItemKeys([{
        sourceId: 'tg:example',
        prefilterPreviews: [{ itemId: '7', aiAdmission: { rejectionReason: 'parser-post-older-than-six-months' } }],
    }]);
    assert.equal(isStaleParserItem(stale, 'tg:example', { messageId: '7' }), true);
});

test('raw cache records older than six months are blocked without a future event date', () => {
    const now = new Date('2026-11-02T12:00:00+03:00');
    const old = Math.floor(new Date('2025-01-01T12:00:00+03:00').getTime() / 1000);
    assert.equal(isParserItemOlderThanMaxAge({ publishedAt: old, text: 'Старый пост без даты' }, now), true);
    assert.equal(isParserItemOlderThanMaxAge({ publishedAt: old, text: 'Концерт 12 ноября 2026' }, now), false);
});
