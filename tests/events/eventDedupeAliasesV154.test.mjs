import assert from 'node:assert/strict';
import {
    compareEventsDeterministic,
    deduplicateEventsTwoContour,
    eventTitleEvidenceSimilarity,
    eventVenueSimilarity,
    normalizeEventIdentityTitle,
} from '../../src/features/events/eventDuplicateResolution.js';

const sameParty = {
    title: 'ГРАНИ',
    eventDate: '2026-09-05',
    eventTime: '19:30',
    timeLabel: '19:30',
    venue: 'Rock Bar DIESEL, Воронеж',
    participants: 'саутсайд, ледяная ложь, Апирия, АРГУМЕНТ',
    sourceType: 'vk',
    sourceName: 'rb_diesel',
    sourceUrl: 'https://vk.ru/wall-117292629_13693',
};
const samePartyOwner = {
    title: 'ГРАНИ гиг',
    eventDate: '2026-09-05',
    eventTime: '19:30',
    timeLabel: '19:30',
    venue: 'Дизель бар, ул. Генерала Лизюкова, 4',
    participants: 'саутсайд, ледяная ложь, Апирия, АРГУМЕНТ',
    sourceType: 'manual',
    sourceName: 'добавлено владельцем',
    sourceUrl: 'https://vk.ru/club241006949',
};

assert.equal(normalizeEventIdentityTitle('ГРАНИ'), 'грани');
for (const variant of [
    'ГРАНИ гиг',
    'ГРАНИ gig',
    'ГРАНИ пати',
    'ГРАНИ party',
    'ГРАНИ концерт',
    'ГРАНИ concert',
    'ГРАНИ live show',
    'ГРАНИ лайв шоу',
]) {
    assert.equal(normalizeEventIdentityTitle(variant), 'грани', variant);
    assert.equal(eventTitleEvidenceSimilarity('ГРАНИ', variant), 1, variant);
}

for (const variant of [
    'Diesel bar',
    'DIESEL BAR',
    'Дизель бар',
    'Dizel bar',
    'Rock Bar DIESEL, Воронеж',
    'Rock Bar Дизель',
]) {
    assert.ok(eventVenueSimilarity('Diesel bar', variant) >= 0.95, variant);
}

for (const variant of [
    'Diesel Hall',
    'DIESEL HALL',
    'Дизель Холл',
    'Diesel холл',
]) {
    assert.ok(eventVenueSimilarity('Diesel Hall', variant) >= 0.95, variant);
}

assert.ok(eventVenueSimilarity('Diesel bar', 'Diesel Hall') <= 0.18);
assert.ok(eventVenueSimilarity('Дизель бар', 'Дизель Холл') <= 0.18);

const deterministic = compareEventsDeterministic(sameParty, samePartyOwner);
assert.equal(deterministic.verdict, 'same');
assert.ok(deterministic.reasons.includes('exact-title-date-absolute-rule'));

const merged = await deduplicateEventsTwoContour([sameParty, samePartyOwner]);
assert.equal(merged.events.length, 1, 'ГРАНИ / ГРАНИ гиг at Diesel Bar must be one event');
assert.equal(merged.events[0].mergedSources.length, 2);

const hallVariant = {
    ...samePartyOwner,
    title: 'ГРАНИ концерт',
    venue: 'Дизель Холл',
    sourceUrl: 'https://vk.ru/wall-1_2',
};
const hallCmp = compareEventsDeterministic(sameParty, hallVariant);
assert.equal(hallCmp.verdict, 'different', 'Diesel Hall must stay separate from Diesel Bar');
assert.ok(hallCmp.hardConflicts.includes('different-venue'));
assert.equal((await deduplicateEventsTwoContour([sameParty, hallVariant])).events.length, 2);

// One shared content word + same strong venue/date/time is a gray-zone candidate,
// not an immediate "different" just because descriptive tails differ.
const partialA = {
    title: 'Грани ночи', eventDate: '2026-09-12', timeLabel: '20:00', venue: 'Дизель бар',
};
const partialB = {
    title: 'Грани света party', eventDate: '2026-09-12', timeLabel: '20:00', venue: 'Diesel Bar',
};
const partialCmp = compareEventsDeterministic(partialA, partialB);
assert.equal(partialCmp.verdict, 'ambiguous');
let aiCalls = 0;
const partialMerged = await deduplicateEventsTwoContour([partialA, partialB], {
    arbitrateAmbiguous: async (pairs) => {
        aiCalls += 1;
        return new Map(pairs.map((pair) => [pair.key, {
            verdict: 'same', confidence: 0.96, reason: 'same venue/date/time and shared distinctive title token',
        }]));
    },
});
assert.equal(aiCalls, 1);
assert.equal(partialMerged.events.length, 1);

console.log('eventDedupeAliasesV154.test.mjs: OK');
