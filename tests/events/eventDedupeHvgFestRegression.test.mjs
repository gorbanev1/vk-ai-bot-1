import assert from 'node:assert/strict';
import { compareEventsDeterministic, deduplicateEventsTwoContour, normalizeEventIdentityTitle } from '../../src/features/events/eventDuplicateResolution.js';

const dieselPost = {
    title: 'Первый ХВГ-Фест',
    eventDate: '2026-10-17',
    eventTime: '19:00',
    venue: 'Diesel Hall, Воронеж',
    participants: 'Tony Tyler, Озвучено Бульвар Эмили, Редкость, Тип привязанности, Спецгость, Озвучено',
    description: 'Фестиваль участников проекта «Хочу В Группу» разных лет. В программе — шоу выпускников проекта.',
    sourceUrl: 'https://vk.ru/wall-117292629_13824',
};
const peselPost = {
    title: 'ХВГ',
    eventDate: '2026-10-17',
    eventTime: '19:00',
    venue: 'PESEL HALL',
    participants: 'TONY TYLER; Озвучено; Бульвар Эмили; Редкость; Тип привязанности; спецгость',
    description: 'Билеты на входе: 500р.',
    sourceUrl: 'https://vk.ru/wall-117292629_13891',
};

assert.equal(normalizeEventIdentityTitle('ХВГ-Фест'), 'хвг');
assert.equal(normalizeEventIdentityTitle('ХВГ'), 'хвг');

const comparison = compareEventsDeterministic(dieselPost, peselPost);
assert.equal(comparison.verdict, 'ambiguous');
assert.ok(comparison.reasons.includes('venue-conflict'));

const result = await deduplicateEventsTwoContour([dieselPost, peselPost], {
    arbitrateAmbiguous: async (pairs) => new Map(pairs.map((pair) => [pair.key, {
        verdict: 'same', confidence: 0.97, reason: 'OCR venue variant; same date, time and lineup',
    }])),
});
assert.equal(result.events.length, 1);
assert.equal(result.events[0].mergedSources.length, 2);

console.log('eventDedupeHvgFestRegression.test.mjs: OK');
