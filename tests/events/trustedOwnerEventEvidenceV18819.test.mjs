import test from 'node:test';
import assert from 'node:assert/strict';

import { buildTrustedOwnerEventEvidence } from '../../src/features/events/trustedOwnerEventEvidence.js';
import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const structured = {
    id: 'vk-event-231705804',
    eventTitle: '03.10 | Shoegaze Fall Night 2',
    eventDate: '2026-10-03',
    eventTime: '18:00',
    text: `Название: 03.10 | Shoegaze Fall Night 2\nДата: 03.10.2026\nВремя: 18:00\nМесто: Котельная\nОписание: Dog Silent\ngoodnight kisses\nмуссон\nобъект под видеонаблюдением\nДвери: 18:00`,
    extractionMethod: 'vk-structured-event-first-pass',
    imageUrls: ['https://example.test/cover.jpg'],
};

const visibleAnnouncement = {
    id: 'wall-231705804_24',
    text: `Лето закончилось и наступает время для анонса Shoegaze Fall Night 2!\nУже знакомые вам чарующие Dog Silent (Москва), гранж-гейзовые goodnight kisses (Санкт-Петербург).\nЛокальную поддержку окажут ребята из Муссон и юные дарования - объект под видеонаблюдением.\nГде: КОТЕЛЬНАЯ\nКогда: 3 октября\nСколько: 600 с репостом / 800 с респектом`,
    extractionMethod: 'exact-visible-vk-wall',
    imageUrls: ['https://example.test/poster.jpg'],
};

const unrelated = {
    id: 'wall-231705804_99',
    text: 'Фотоотчёт с другого концерта в июле. Спасибо всем, кто пришёл!',
    extractionMethod: 'visible-vk-wall',
};

test('V188.19 trusted owner deep evidence keeps structured anchor and fuses only related announcement', () => {
    const merged = buildTrustedOwnerEventEvidence({
        selectedPost: structured,
        linkData: { posts: [structured, unrelated, visibleAnnouncement] },
        ownerText: '',
        directImageUrls: ['https://example.test/owner.jpg'],
    });

    assert.match(merged.text, /Shoegaze Fall Night 2/u);
    assert.match(merged.text, /600 с репостом \/ 800 с респектом/u);
    assert.doesNotMatch(merged.text, /Фотоотчёт с другого концерта/u);
    assert.deepEqual(merged.imageUrls.slice(0, 3), [
        'https://example.test/owner.jpg',
        'https://example.test/cover.jpg',
        'https://example.test/poster.jpg',
    ]);
    assert.equal(merged.relatedEvidence.length, 1);
});

test('V188.19 fused owner evidence is enough for deterministic full event fields without AI', () => {
    const merged = buildTrustedOwnerEventEvidence({
        selectedPost: structured,
        linkData: { posts: [structured, visibleAnnouncement] },
    });
    const [event] = parsePublicPostLocally({
        ...merged,
        text: merged.text,
        publishedAt: 1788950000,
        screenName: 'shoegaze_fall_night',
    });

    assert.ok(event);
    assert.equal(event.eventDate, '2026-10-03');
    assert.equal(event.eventTime, '18:00');
    assert.equal(event.venue, 'Котельная');
    assert.equal(event.participants, 'Dog Silent; goodnight kisses; муссон; объект под видеонаблюдением');
    assert.equal(event.price, '600 с репостом / 800 с респектом');
    assert.match(event.description, /Лето закончилось/u);
});
