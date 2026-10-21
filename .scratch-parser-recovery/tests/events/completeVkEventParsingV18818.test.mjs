import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';
import { mergeNormalizedEvent } from '../../src/features/events/eventAnnouncementNormalization.js';

const shoegazeStructured = `Название: 03.10 | Shoegaze Fall Night 2
Дата: 03.10.2026
Время: 18:00
Место: Воронеж
Описание: Dog Silent
goodnight kisses
муссон
объект под видеонаблюдением

Место: Котельная (https://t.me/kotelnaya_inc)
Двери: 18:00`;

const shoegazeVisible = `Лето закончилось и наступает время для анонса Shoegaze Fall Night 2!
Уже знакомые вам чарующие Dog Silent (Москва), гранж-гейзовые goodnight kisses (Санкт-Петербург).
Локальную поддержку окажут ребята из Муссон и юные дарования - объект под видеонаблюдением.
Где: КОТЕЛЬНАЯ
Когда: 3 октября
Сколько: 600 с репостом / 800 с респектом`;

test('V188.18 parses the Shoegaze event from merged structured + visible VK evidence', () => {
    const [event] = parsePublicPostLocally({
        text: `${shoegazeStructured}\n\n${shoegazeVisible}`,
        publishedAt: 1788950000,
        eventTitle: '03.10 | Shoegaze Fall Night 2',
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

test('V188.18 extracts compact participants from structured VK event description without bullets', () => {
    const [event] = parsePublicPostLocally({
        text: shoegazeStructured,
        publishedAt: 1788950000,
        eventTitle: '03.10 | Shoegaze Fall Night 2',
    });

    assert.ok(event);
    assert.equal(event.venue, 'Котельная');
    assert.equal(event.participants, 'Dog Silent; goodnight kisses; муссон; объект под видеонаблюдением');
});

test('V188.18 display normalization cannot erase deterministic participants/price with empty AI fields', () => {
    const original = {
        title: '03.10 | Shoegaze Fall Night 2',
        eventDate: '2026-10-03',
        eventTime: '18:00',
        venue: 'Котельная',
        participants: 'Dog Silent; goodnight kisses; муссон; объект под видеонаблюдением',
        price: '600 с репостом / 800 с респектом',
        description: `${shoegazeStructured}\n\n${shoegazeVisible}`,
    };
    const merged = mergeNormalizedEvent(original, {
        key: '0',
        title: original.title,
        venue: 'Котельная',
        participants: '',
        price: '',
        announcement: 'Двери: 18:00',
    });

    assert.equal(merged.participants, original.participants);
    assert.equal(merged.price, original.price);
    assert.match(merged.description, /Dog Silent/u);
    assert.match(merged.description, /Лето закончилось/u);
    assert.notEqual(merged.description, 'Двери: 18:00');
});

test('V188.18 exact VK structured-only API result is forced through bounded page enrichment', async () => {
    const source = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(source, /exactVkStructuredOnly/u);
    assert.match(source, /structured-date-without-rich-wall-text/u);
    assert.match(source, /exactVkPost && exactVkHasDateEvidence && !exactVkStructuredOnly/u);
});
