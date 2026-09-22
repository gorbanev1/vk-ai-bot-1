import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    collectVkPhotoApiIdsFromMedia,
    normalizeVkPhotoAttachmentKey,
    resolveVkPhotoMediaByAttachmentKey,
    vkApiPhotoIdFromAttachmentKey,
} from '../../src/platforms/vk/vkPhotoIdentityMedia.js';
import {
    classifyVkSourcePageHealth,
} from '../../src/platforms/vk/vkSourcePageHealth.js';

test('V188.72 resolves two virtualized gallery cells by stable photo identity, not stale currentSrc', () => {
    const staleCwtUrl = 'https://cdn.example/cwt-stale.jpg';
    const media = [
        { attachmentKey: 'photo-117292629_457263994', url: staleCwtUrl, order: 9 },
        { attachmentKey: 'photo-117292629_457263995', url: staleCwtUrl, order: 10 },
    ];
    const apiPhotos = [
        {
            owner_id: -117292629,
            id: 457263994,
            sizes: [{ url: 'https://cdn.example/cwt-real.jpg', width: 1080, height: 1440 }],
        },
        {
            owner_id: -117292629,
            id: 457263995,
            sizes: [{ url: 'https://cdn.example/stonehand-real.jpg', width: 1080, height: 1440 }],
        },
    ];

    const result = resolveVkPhotoMediaByAttachmentKey(media, apiPhotos);
    assert.equal(result.resolvedCount, 2);
    assert.deepEqual(result.media.map((item) => item.url), [
        'https://cdn.example/cwt-real.jpg',
        'https://cdn.example/stonehand-real.jpg',
    ]);
    assert.deepEqual(result.media.map((item) => item.attachmentKey), [
        'photo-117292629_457263994',
        'photo-117292629_457263995',
    ]);
    assert.notEqual(result.media[0].url, result.media[1].url);
});

test('V188.72 produces VK photos.getById ids from captured anchors', () => {
    assert.equal(normalizeVkPhotoAttachmentKey('/photo-117292629_457263995'), 'photo-117292629_457263995');
    assert.equal(vkApiPhotoIdFromAttachmentKey('photo-117292629_457263995'), '-117292629_457263995');
    assert.deepEqual(collectVkPhotoApiIdsFromMedia([
        { attachmentKey: 'photo-117292629_457263994' },
        { attachmentKey: 'PHOTO-117292629_457263995' },
        { attachmentKey: 'photo-117292629_457263995' },
    ]), ['-117292629_457263994', '-117292629_457263995']);
});

test('V188.72 reloads transient VK load errors and a completed empty DOM', () => {
    assert.deepEqual(
        classifyVkSourcePageHealth({ bodyText: 'Произошла ошибка загрузки. Попробуйте ещё раз', readyState: 'complete' }),
        { ready: false, reload: true, reason: 'load-error-text' },
    );
    assert.deepEqual(
        classifyVkSourcePageHealth({ bodyText: 'VK', postCount: 0, wallAnchorCount: 0, readyState: 'complete' }),
        { ready: false, reload: true, reason: 'empty-wall-dom' },
    );
    assert.deepEqual(
        classifyVkSourcePageHealth({ bodyText: 'normal wall', postCount: 3, wallAnchorCount: 5, readyState: 'complete' }),
        { ready: true, reload: false, reason: 'wall-content-present' },
    );
});

test('V188.72 leaves login/captcha to manual access flow instead of reload loop', () => {
    assert.deepEqual(
        classifyVkSourcePageHealth({ bodyText: 'Войдите ВКонтакте для продолжения', readyState: 'complete' }),
        { ready: false, reload: false, reason: 'access-gate' },
    );
});

test('V188.72 runtime integrates photo-id API hydration and bounded page.reload', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const scraper = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    assert.match(app, /vk\.api\.photos\.getById/u);
    assert.match(app, /resolveVkPhotoMediaByAttachmentKey/u);
    assert.match(app, /\[VK PHOTO-ID POST MEDIA\]/u);
    assert.match(scraper, /\[VK SOURCE PAGE RELOAD\]/u);
    assert.match(scraper, /page\.reload\(\{/u);
    assert.match(scraper, /max:\s*2/u);
});
