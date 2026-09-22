import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    extractVkExactWallPostsFromBootstrap,
    extractVkStructuredBootstrapSourcesFromHtml,
} from '../../src/features/events/vkStructuredEventEvidence.js';
import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const browserSource = readFileSync(
    new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url),
    'utf8',
);
const appSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

const wallText = [
    'Раз в год и 40NOG booking работает.',
    '',
    '- соня',
    '- Марина, я умираю!',
    '- Последняя Птичка',
    '- ГРИН',
    '',
    'КОТЕЛЬНАЯ, 19 сентября в 19:00.',
    'Билеты: https://example.test/tickets',
].join('\n');

const html = `<!doctype html><html><body><script>
window.cur.apiPrefetchCache = ${JSON.stringify([{
    method: 'wall.getById',
    response: {
        items: [{
            owner_id: -239795426,
            id: 2,
            date: 1785234561,
            text: wallText,
            attachments: [{
                type: 'photo',
                photo: {
                    sizes: [
                        { width: 240, height: 339, url: 'https://sun.example/small.jpg' },
                        { width: 905, height: 1280, url: 'https://sun.example/poster.jpg' },
                    ],
                },
            }],
        }],
        groups: [{
            id: 239795426,
            type: 'event',
            name: 'Соня / Марина, я умираю / 19.09 / Воронеж',
            screen_name: 'club239795426',
            url: '/event239795426',
        }],
    },
}])};
</script></body></html>`;

test('V188.11 recovers exact VK wall timestamp/poster from raw apiPrefetchCache', () => {
    const sources = extractVkStructuredBootstrapSourcesFromHtml(html, { maximum: 120 });
    const posts = extractVkExactWallPostsFromBootstrap(sources, {
        sourceUrl: 'https://vk.ru/wall-239795426_2',
        maximum: 4,
    });

    assert.equal(posts.length, 1);
    const post = posts[0];
    assert.equal(post.publishedAt, 1785234561);
    assert.equal(post.publishedAtSource, 'vk-raw-html-prefetch-wall-date-v18811');
    assert.equal(post.sourceUrl, 'https://vk.ru/wall-239795426_2');
    assert.equal(post.eventPageUrl, 'https://vk.ru/event239795426');
    assert.deepEqual(post.imageUrls, ['https://sun.example/poster.jpg']);
    assert.equal(post.eventTitle, 'Соня / Марина, я умираю / 19.09 / Воронеж');
});

test('V188.11 local parser uses recovered publication year and bullet lineup without AI', () => {
    const [post] = extractVkExactWallPostsFromBootstrap(
        extractVkStructuredBootstrapSourcesFromHtml(html),
        { sourceUrl: 'https://vk.ru/wall-239795426_2' },
    );
    const [event] = parsePublicPostLocally(post);

    assert.ok(event);
    assert.equal(event.eventDate, '2026-09-19');
    assert.equal(event.eventTime, '19:00');
    assert.equal(event.venue, 'КОТЕЛЬНАЯ');
    assert.equal(event.title, 'Соня / Марина, я умираю / 19.09 / Воронеж');
    assert.match(event.participants, /соня/u);
    assert.match(event.participants, /Марина, я умираю/u);
    assert.match(event.participants, /Последняя Птичка/u);
    assert.match(event.participants, /ГРИН/u);
});

test('V188.11 browser keeps exact raw-wall evidence and optionally hydrates related VK event page', () => {
    assert.match(browserSource, /extractVkExactWallPostsFromBootstrap/u);
    assert.match(browserSource, /browser\.vk_exact_bootstrap\.posts/u);
    assert.match(browserSource, /browser\.vk_exact_bootstrap\.merged/u);
    assert.match(browserSource, /browser\.vk_related_event\.begin/u);
    assert.match(browserSource, /page\.context\(\)\.request\.get\(eventPageUrl/u);
    assert.match(browserSource, /earlyVkExactWallPosts/u);
});

test('V188.11 exact links do not ask GPT to select duplicate DOM containers and proposal AI is bounded', () => {
    assert.match(appSource, /direct-link-match-ranked/u);
    assert.match(appSource, /proposal\.primary_post\.ai_plan/u);
    assert.match(appSource, /proposal\.primary_post\.image_facts\.begin/u);
    assert.match(appSource, /failoverMaxRounds:\s*1/u);
    assert.match(appSource, /failuresBeforeQuarantine:\s*1/u);
    assert.match(appSource, /maxCandidates:\s*2/u);
    assert.match(appSource, /\['time', 'title', 'participants'\]\.includes\(field\)/u);
});
