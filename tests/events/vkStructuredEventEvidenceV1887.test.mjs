import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    extractVkStructuredEventsFromBootstrap,
    formatVkStructuredEventEvidence,
} from '../../src/features/events/vkStructuredEventEvidence.js';

const browserSource = readFileSync(
    new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url),
    'utf8',
);
const appSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

test('V188.7 extracts VK event start_date before relying on visual DOM', () => {
    const sources = [{
        method: 'groups.getById',
        response: {
            groups: [{
                id: 239795426,
                type: 'event',
                name: 'Соня / Марина, я умираю / 19.09 / Воронеж',
                start_date: 1789833600,
                cover: {
                    images: [
                        { url: 'https://example.test/poster.jpg?size=200x80' },
                        { url: 'https://example.test/poster.jpg?size=1920x768' },
                    ],
                },
            }],
        },
    }];

    const events = extractVkStructuredEventsFromBootstrap(sources);
    assert.equal(events.length, 1);
    assert.equal(events[0].startAt, 1789833600);
    assert.equal(events[0].title, 'Соня / Марина, я умираю / 19.09 / Воронеж');
    assert.deepEqual(events[0].imageUrls, ['https://example.test/poster.jpg?size=1920x768']);

    const evidence = formatVkStructuredEventEvidence(events[0], {
        timeZone: 'Europe/Moscow',
    });
    assert.equal(evidence.eventDate, '2026-09-19');
    assert.equal(evidence.eventTime, '19:00');
    assert.match(evidence.text, /Дата: 19\.09\.2026/u);
    assert.match(evidence.text, /Время: 19:00/u);
});

test('V188.7 structured event scan is key-shape tolerant instead of hardcoded to one VK snippet', () => {
    const sources = [{
        method: 'community.fetchThing',
        response: {
            payload: {
                eventId: 77,
                isEvent: true,
                eventName: 'Тестовое событие',
                startDate: 1789833600000,
                endDate: 1789840800000,
            },
        },
    }];

    const [event] = extractVkStructuredEventsFromBootstrap(sources);
    assert.ok(event);
    assert.equal(event.id, 77);
    assert.equal(event.startAt, 1789833600);
    assert.equal(event.finishAt, 1789840800);
    assert.equal(formatVkStructuredEventEvidence(event).eventDate, '2026-09-19');
});

test('V188.7 browser keeps generic whole-page fallback after VK structured first pass', () => {
    assert.match(browserSource, /vkStructuredBootstrapSources/u);
    assert.match(browserSource, /vk-structured-event-first-pass/u);
    assert.match(browserSource, /const text = cleanText\(document\.body\?\.innerText \?\? '', 100000\)/u);
    assert.match(browserSource, /const description = String\(/u);
    assert.match(appSource, /selectionMethod: 'vk-structured-event-first-pass'/u);
});
