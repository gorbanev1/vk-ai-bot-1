import test from 'node:test';
import assert from 'node:assert/strict';
import { parseVkPublicHtml } from '../../src/platforms/vk/vkPublicScraper.js';

test('public VK parser keeps equal numeric post ids from different walls separate', () => {
    const html = [
        '<article data-post-id="-241363728_5"><a href="/wall-241363728_5">5 авг 2026</a><div>Первый текст события</div></article>',
        '<article data-post-id="-241527692_5"><a href="/wall-241527692_5">6 авг 2026</a><div>Второй текст события</div></article>',
    ].join('');
    const posts = parseVkPublicHtml(html, '');
    assert.equal(posts.length, 2);
    assert.deepEqual(posts.map((post) => post.ownerId), [-241363728, -241527692]);
    assert.deepEqual(posts.map((post) => post.sourceUrl), [
        'https://vk.ru/wall-241363728_5',
        'https://vk.ru/wall-241527692_5',
    ]);
});

test('public VK parser excludes embedded walls owned by another community when page owner is known', () => {
    const html = [
        '<script>window.__BOOTSTRAP__={"screenName":"current_source","entityId":241363728,"screenType":"group"}</script>',
        '<article data-post-id="-241363728_5"><a href="/wall-241363728_5">5 авг 2026</a><div>Текст текущего сообщества</div></article>',
        '<article data-post-id="-241527692_5"><a href="/wall-241527692_5">6 авг 2026</a><div>Текст вложенного репоста</div></article>',
    ].join('');
    const posts = parseVkPublicHtml(html, 'current_source');
    assert.equal(posts.length, 1);
    assert.equal(posts[0].ownerId, -241363728);
    assert.equal(posts[0].sourceUrl, 'https://vk.ru/wall-241363728_5');
});
