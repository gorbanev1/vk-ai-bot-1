import assert from 'node:assert/strict';
import test from 'node:test';

import {
    compareEventsDeterministic,
    deduplicateEventsTwoContour,
} from '../../src/features/events/eventDuplicateResolution.js';
import {
    compareEventsForDuplicate,
    deduplicateUpcomingEvents,
} from '../../src/features/events/eventDeduplication.js';

const base = {
    sourceType: 'vk',
    sourceName: 'liverpool_pub_vrn',
    eventDate: '2026-08-27',
    eventTime: '20:00',
    venue: 'Liverpool Pub, Воронеж',
};

const stub = {
    ...base,
    sourceUrl: 'https://vk.ru/wall-95062430_2698',
    title: '27 августа, 20.00',
    participants: '',
    description: 'Билеты тут - ticketscloud.com/v1/widgets... 13',
};

const rich = {
    ...base,
    sourceUrl: 'https://vk.ru/wall-95062430_2705',
    title: 'Кошка Сашка',
    participants: 'Кошка Сашка',
    description: '27 августа, 20.00 - Кошка Сашка, билеты ticketscloud.com/v1/widgets...',
};

test('V131 merges weak schedule stub with rich event from another post by the same publisher', async () => {
    const deep = compareEventsDeterministic(stub, rich);
    assert.equal(deep.verdict, 'same');
    assert.ok(deep.reasons.includes('same-publisher-schedule-stub-rule'));

    const deepResult = await deduplicateEventsTwoContour([stub, rich], { useAi: false });
    assert.equal(deepResult.events.length, 1);
    assert.equal(deepResult.events[0].title, 'Кошка Сашка');

    const legacy = compareEventsForDuplicate(stub, rich);
    assert.equal(legacy.duplicate, true);
    assert.ok(legacy.reasons.includes('same-publisher-schedule-stub'));
    assert.equal(deduplicateUpcomingEvents([stub, rich]).events.length, 1);
});

test('V131 does not merge two strongly identified events merely because publisher/date/time/venue match', async () => {
    const first = {
        ...base,
        sourceUrl: 'https://vk.ru/wall-95062430_3001',
        title: 'Кошка Сашка',
        participants: 'Кошка Сашка',
        description: 'Большой сольный концерт Кошки Сашки.',
    };
    const second = {
        ...base,
        sourceUrl: 'https://vk.ru/wall-95062430_3002',
        title: 'Stout Band',
        participants: 'Stout Band',
        description: 'Отдельный концерт Stout Band в тот же вечер.',
    };

    assert.notEqual(compareEventsDeterministic(first, second).verdict, 'same');
    assert.equal(compareEventsForDuplicate(first, second).duplicate, false);
    assert.equal((await deduplicateEventsTwoContour([first, second], { useAi: false })).events.length, 2);
    assert.equal(deduplicateUpcomingEvents([first, second]).events.length, 2);
});
