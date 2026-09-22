import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import { looksLikeVkChatEventCandidate } from '../../src/features/events/eventCandidateRouting.js';

const chat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const pub = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const pool = readFileSync(new URL('../../src/features/scrapers/manualProcessingPool.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('chat cheap gate ignores interface-like chatter but admits real event date', () => {
    assert.equal(looksLikeVkChatEventCandidate({ text: 'Ник Море\n17:19\n8', links: [] }), false);
    assert.equal(looksLikeVkChatEventCandidate({ text: 'Да, почитала уже..', links: [] }), false);
    assert.equal(looksLikeVkChatEventCandidate({ text: '11 сентября, Liverpool, начало 22:00', links: [] }), true);
});

test('current VK chat exact pass separates body, repost and owned poster media', () => {
    assert.match(chat, /AttachWallNew__message/u);
    assert.match(chat, /PhotoItem|photoitem/u);
    assert.match(chat, /contentText:\s*primaryText/u);
    assert.match(chat, /repostText:\s*embeddedText/u);
    assert.match(chat, /raw-before-exact/u);
    assert.match(chat, /uiMarker/u);
    assert.doesNotMatch(chat, /const fullText\s*=\s*clean\(root\.textContent/u);
});

test('current VK public exact pass uses immutable structural post fields and ownership', () => {
    assert.match(pub, /\[data-testid="post"\]\[data-post-id\]/u);
    assert.match(pub, /post-content-container/u);
    assert.match(pub, /primary-attachment-image-content/u);
    assert.match(pub, /post_date_block_preview/u);
    assert.match(pub, /imageOrigin/u);
    assert.match(pub, /outer-primary/u);
    assert.match(pub, /nested-repost/u);
    assert.match(pub, /raw-before-exact/u);
});

test('processing trace distinguishes queue, global slot and real processing start', () => {
    assert.match(pool, /type:\s*'queued'/u);
    assert.match(pool, /type:\s*'slot'/u);
    assert.match(pool, /queueWaitMs/u);
    assert.match(pool, /limiterActive/u);
    assert.match(pool, /await limiter\.run\(execute, \{ priority \}\)/u);
});

test('parser AI failover emits sanitized model diagnostics', () => {
    assert.match(app, /onFailoverEvent/u);
    assert.match(app, /keyName/u);
    assert.match(app, /retryable/u);
    assert.match(app, /vision\.model/u);
    assert.match(app, /text\.model/u);
});
