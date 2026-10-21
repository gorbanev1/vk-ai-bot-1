import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import {
    compareEventsDeterministic,
    deduplicateEventsTwoContour,
} from '../../src/features/events/eventDuplicateResolution.js';

const fullPosterPost = {
    title: 'NO PLACE FOR OLD PADS — авторская ритмичная электронная музыка в тяжелых стилях',
    eventDate: '2026-09-19',
    eventTime: '18:30',
    venue: 'DIESEL Bar, ул. Лизюкова, 4, Воронеж',
    participants: 'Re-Feel, радиоАвгуст, Dekonstrukt, Fungalmind, 3Gear',
    price: '500 рублей',
    description: 'NO PLACE FOR OLD PADS — вечер авторской ритмичной электронной музыки в тяжелых стилях в DIESEL Bar. Начало в 18:30.',
    sourceType: 'vk_chat',
    sourceName: '2000000022',
    sourceUrl: 'https://vk.ru/wall-240648015_4',
    imagePaths: ['poster.jpg'],
    _dedupeRefs: [{ sourceType: 'vk_chat', id: 15 }],
};

const teaserPost = {
    title: 'NO PLACE FOR OLD PADS — выступление дуэта с электронной музыкой и гитарными риффами',
    eventDate: '2026-09-19',
    eventTime: null,
    venue: 'Diesel Bar Dekonstrukt',
    participants: 'Александр Власов (гитара), Дмитрий Лебедев (электроника)',
    description: 'NO PLACE FOR OLD PADS 19.09 в Diesel Bar. Молодой дуэт из опытных ребят; сочетание электронной музыки и гитарных риффов.',
    sourceType: 'vk_chat',
    sourceName: '2000000022',
    sourceUrl: 'https://vk.ru/oldpads',
    imagePaths: ['duo.jpg'],
    _dedupeRefs: [{ sourceType: 'vk_chat', id: 8 }],
};

test('V188.61: same named event in two different posts is merged on the same date', async () => {
    const decision = compareEventsDeterministic(fullPosterPost, teaserPost);
    assert.equal(decision.verdict, 'same');
    assert.ok(decision.reasons.includes('title-lead-identity'));
    assert.ok(decision.reasons.includes('same-named-lead-calendar-rule'));

    const result = await deduplicateEventsTwoContour([fullPosterPost, teaserPost]);
    assert.equal(result.events.length, 1);
    assert.equal(result.merges.length, 1);
    const merged = result.events[0];
    assert.equal(merged.eventDate, '2026-09-19');
    assert.equal(merged.eventTime, '18:30');
    assert.match(merged.participants, /Re-Feel/u);
    assert.match(merged.participants, /Александр Власов/u);
    assert.deepEqual(new Set(merged.imagePaths || []), new Set());
    assert.deepEqual(new Set(merged.verifiedImagePaths || []), new Set());
    assert.equal(merged._dedupeRefs.length, 2);
});

test('V188.86: same date/title identity ignores start-time conflict and keeps earliest time', async () => {
    const first = { ...fullPosterPost, eventTime: '18:00', timeLabel: '18:00' };
    const second = { ...teaserPost, eventTime: '22:00', timeLabel: '22:00' };
    const decision = compareEventsDeterministic(first, second);
    assert.notEqual(decision.verdict, 'different');
    assert.ok(!decision.hardConflicts.some((item) => String(item).startsWith('time-conflict')));
    const result = await deduplicateEventsTwoContour([first, second]);
    assert.equal(result.events.length, 1);
    assert.equal(result.events[0].eventTime, '18:00');
});

test('V188.75: DIESEL Bar and DIESEL Hall stay separate despite same core/date/title', () => {
    const first = { ...fullPosterPost, venue: 'DIESEL Bar', eventTime: null, timeLabel: '' };
    const second = { ...teaserPost, venue: 'DIESEL HALL', eventTime: null, timeLabel: '' };
    const decision = compareEventsDeterministic(first, second);
    assert.equal(decision.verdict, 'different');
    assert.ok(decision.hardConflicts.includes('different-venue'));
});

test('V188.61: parser-all finalization explicitly rebuilds canonical dedupe registry', async () => {
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(app, /run\.final-dedupe\.start/u);
    assert.match(app, /rebuildVerifiedPartySnapshotQueued\(\{[\s\S]{0,180}?reason:\s*'parser-all-processing-complete'/u);
    assert.match(app, /run\.final-dedupe\.complete/u);
    assert.match(app, /duplicateMembers/u);
    assert.match(app, /events-v18861-parser-final-dedupe-poster-repair/u);
});
