import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import { stripEventServiceArtifacts } from '../../src/features/events/eventAnnouncementNormalization.js';
import { stripKnownVenueNamesFromEventTitle } from '../../src/features/events/eventVenueInference.js';
import {
    compareEventsDeterministic,
    mergeDuplicateEvents,
} from '../../src/features/events/eventDuplicateResolution.js';
import { classifyVkSourcePageHealth } from '../../src/platforms/vk/vkSourcePageHealth.js';

const assets = readFileSync(new URL('../../src/features/events/eventAssets.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const vkPublic = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');

test('V188.86 public announcement never leaks poster audit or source/ticket URLs', () => {
    const dirty = [
        'Полезный текст анонса. Билеты: https://ticketscloud.com/v1/widgets/abc',
        'Подробнее vk.ru/club236726493',
        '[Факты с афиши]',
        '[IMAGE 1]',
        'Тип изображения: poster',
        'Это афиша события: да',
        'Название: Грай',
    ].join('\n');
    const clean = stripEventServiceArtifacts(dirty);
    assert.match(clean, /Полезный текст анонса/u);
    assert.doesNotMatch(clean, /https?:\/\//u);
    assert.doesNotMatch(clean, /ticketscloud|vk\.ru/u);
    assert.doesNotMatch(clean, /Факты с афиши|IMAGE 1|Тип изображения|Это афиша/u);
});

test('V188.86 venue names are removed from title identity and display title', () => {
    assert.equal(stripKnownVenueNamesFromEventTitle('STONEHAND (ВОРОНЕЖ) DIESEL HALL'), 'STONEHAND');
});

test('V188.86 same date + same title ignores conflicting start time and merge keeps earliest', () => {
    const a = { title: 'Фестиваль Ива', eventDate: '2026-09-26', eventTime: '18:00', timeLabel: '18:00', venue: 'Котельная' };
    const b = { title: 'Фестиваль ИВА', eventDate: '2026-09-26', eventTime: '19:30', timeLabel: '19:30', venue: 'Котельная' };
    const cmp = compareEventsDeterministic(a, b);
    assert.notEqual(cmp.verdict, 'different');
    const merged = mergeDuplicateEvents(a, b, { contour: 'regression' });
    assert.equal(merged.eventTime, '18:00');
    assert.equal(merged.timeLabel, '18:00');
});

test('V188.86 rendered VK content cancels false reload even when exact selectors miss', () => {
    assert.deepEqual(
        classifyVkSourcePageHealth({
            bodyText: 'Изменившийся DOM VK с уже загруженным содержимым постов',
            postCount: 0,
            wallAnchorCount: 0,
            mainTextChars: 900,
            contentImageCount: 3,
            readyState: 'complete',
        }),
        { ready: true, reload: false, reason: 'rendered-content-present' },
    );
});

test('V188.86 single event never inherits the whole source gallery and generated fallback is blocked', () => {
    assert.doesNotMatch(assets, /\.\.\.downloaded,[\s\S]{0,100}eventImagePaths/u);
    assert.match(assets, /one event card owns at most ONE proven real source image/u);
    assert.match(assets, /generated-fallback-blocked/u);
    assert.doesNotMatch(assets, /eventImagePaths = \[await createGeneratedCard/u);
});

test('V188.86 parser launch and reload windows match owner intervals', () => {
    assert.match(app, /const launchMinMs = 5_000;/u);
    assert.match(app, /const launchMaxMs = 20_000;/u);
    assert.match(app, /randomInt\(launchMinMs, launchMaxMs \+ 1\)/u);
    assert.match(vkPublic, /randomInt\(10_000, 20_001\)/u);
    assert.match(vkPublic, /pageReloadState = \{ count: 0, max: 3 \}/u);
    const wait = vkPublic.indexOf('setTimeout(resolveReloadBackoff, reloadBackoffMs)');
    const recheck = vkPublic.indexOf('const recheckedHealth = await inspectVkSourcePageHealth(page)', wait);
    const reload = vkPublic.indexOf('await page.reload({', recheck);
    assert.ok(wait >= 0 && recheck > wait && reload > recheck);
});

test('V188.86 startup repair has no unsafe one-image-is-poster shortcut', () => {
    assert.doesNotMatch(app, /candidates\.length === 1[\s\S]{0,220}single-source-image/u);
    assert.match(app, /one-image posts can be stickers, giveaway graphics or ordinary/iu);
    assert.match(app, /V18886 EXISTING POSTER NORMALIZED/u);
    assert.match(app, /imageSha256/u);
});
