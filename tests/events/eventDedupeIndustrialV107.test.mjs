import assert from 'node:assert/strict';
import {
    EVENT_DEDUPE_ALGORITHM_VERSION,
    buildEventDuplicateAiSystemPrompt,
    compareEventsDeterministic,
    deduplicateEventsTwoContour,
    eventParticipantsSimilarity,
    eventTitleEvidenceSimilarity,
    eventVenueSimilarity,
} from '../../src/features/events/eventDuplicateResolution.js';

assert.equal(EVENT_DEDUPE_ALGORITHM_VERSION, 'event-dedupe-v154-title-kind-low-weight-translit-venue-1');

// 1) V154 contract: exact title+date merges unless venue is explicitly a different
// physical space of the same brand. Diesel Bar !== Diesel Hall.
assert.ok(eventVenueSimilarity('DIESEL HALL, Воронеж', 'Diesel Bar') <= 0.18);
const dieselHall = {
    title: 'Одинаковое название', eventDate: '2026-08-22', timeLabel: '19:00',
    venue: 'DIESEL HALL, Воронеж', participants: 'Группа А',
};
const dieselBar = {
    title: 'Одинаковое название', eventDate: '2026-08-22', timeLabel: '19:00',
    venue: 'Diesel Bar', participants: 'Группа А',
};
const dieselConflict = compareEventsDeterministic(dieselHall, dieselBar);
assert.equal(dieselConflict.verdict, 'different');
assert.ok(dieselConflict.hardConflicts.includes('different-venue'));
let hardConflictAiCalls = 0;
const dieselOut = await deduplicateEventsTwoContour([dieselHall, dieselBar], {
    arbitrateAmbiguous: async () => {
        hardConflictAiCalls += 1;
        return new Map([['0:1', { verdict: 'same', confidence: 1, reason: 'forced' }]]);
    },
});
assert.equal(dieselOut.events.length, 2);
assert.equal(hardConflictAiCalls, 0, 'explicit Bar/Hall conflict must stay deterministic different');

// 2) Venue ambiguity cannot be auto-merged by exact title alone.
assert.ok(eventVenueSimilarity('DIESEL', 'DIESEL HALL') <= 0.55);
const dieselShort = {
    title: 'Ночная сцена', eventDate: '2026-08-22', timeLabel: '20:00', venue: 'DIESEL',
};
const dieselHallSparse = {
    title: 'Ночная сцена', eventDate: '2026-08-22', timeLabel: '20:00', venue: 'DIESEL HALL',
};
assert.notEqual(compareEventsDeterministic(dieselShort, dieselHallSparse).verdict, 'same');

// 3) Родовые названия не являются идентификатором.
assert.equal(eventTitleEvidenceSimilarity('Концерт', 'Концерт'), 0);
const genericA = {
    title: 'Концерт', eventDate: '2026-08-22', timeLabel: '19:00', venue: 'Клуб Альфа', participants: 'Band A',
};
const genericB = {
    title: 'Концерт', eventDate: '2026-08-22', timeLabel: '19:00', venue: 'Клуб Альфа', participants: 'Band B',
};
assert.equal(compareEventsDeterministic(genericA, genericB).verdict, 'different');

// 4) Different time also cannot preserve an exact title+date duplicate.
const timeA = {
    title: 'Open Mic Special', eventDate: '2026-08-22', timeLabel: '18:00', venue: 'Club Alpha', participants: 'Host A',
};
const timeB = {
    title: 'Open Mic Special', eventDate: '2026-08-22', timeLabel: '23:30', venue: 'Club Alpha', participants: 'Host A',
};
const timeConflict = compareEventsDeterministic(timeA, timeB);
assert.equal(timeConflict.verdict, 'same');
assert.equal(timeConflict.hardConflicts.length, 0);
assert.ok(timeConflict.reasons.includes('exact-title-date-absolute-rule'));

// 5) Официальное короткое имя + описательный хвост сохраняют recall настоящих дублей.
assert.ok(eventTitleEvidenceSimilarity(
    'TATTOOMO 2026',
    'TATTOOMO 2026 — тату-фестиваль с мастер-классами и показом работ мастеров',
) >= 0.94);
const tattooA = {
    title: 'TATTOOMO 2026', eventDate: '2026-08-21', displayDate: '21.08.26–23.08.26',
    timeLabel: '10:00–21:30', venue: 'МТС Live Hall', participants: 'НРРТР',
    sourceType: 'telegram', sourceUrl: 'https://t.me/source/1',
};
const tattooB = {
    title: 'TATTOOMO 2026 — тату-фестиваль с мастер-классами и показом работ мастеров',
    eventDate: '2026-08-21', displayDate: '21.08.26–23.08.26', timeLabel: '',
    venue: 'МТС Live Hall', participants: 'НРРТР', sourceType: 'vk', sourceUrl: 'https://vk.ru/wall-1_1',
};
assert.equal((await deduplicateEventsTwoContour([tattooA, tattooB])).events.length, 1);

// 6) Один совпавший артист из большого лайнапа не считается полным совпадением.
const subsetSimilarity = eventParticipantsSimilarity('Band A', 'Band A, Band B, Band C, Band D');
assert.ok(subsetSimilarity < 0.80);
const subsetA = {
    title: 'Band A live', eventDate: '2026-08-22', timeLabel: '19:00', venue: 'Club Alpha',
    participants: 'Band A', description: 'solo show',
};
const subsetB = {
    title: 'Festival Night', eventDate: '2026-08-22', timeLabel: '19:00', venue: 'Club Alpha',
    participants: 'Band A, Band B, Band C, Band D', description: 'festival show',
};
const forcedSubset = await deduplicateEventsTwoContour([subsetA, subsetB], {
    arbitrateAmbiguous: async (pairs) => new Map(pairs.map((pair) => [pair.key, {
        verdict: 'same', confidence: 1, reason: 'forced false-positive',
    }])),
});
assert.equal(forcedSubset.events.length, 2, 'weak subset identity must reject even a forced AI same');

// 7) Повторяющаяся серия на соседних датах — разные события без явной многодневности.
const seriesDay1 = {
    title: 'Open Mic Wednesday', eventDate: '2026-08-21', timeLabel: '19:00', venue: 'Club Alpha',
};
const seriesDay2 = {
    title: 'Open Mic Wednesday', eventDate: '2026-08-22', timeLabel: '19:00', venue: 'Club Alpha',
};
assert.equal(compareEventsDeterministic(seriesDay1, seriesDay2).verdict, 'different');

// 8) Настоящий многодневник допускает AI merge между днями/площадками только при явном evidence.
const movingDay1 = {
    title: 'Moving Festival', eventDate: '2026-08-24', displayDate: '24 августа 2026',
    timeLabel: '18:00', venue: 'Площадка А', description: 'Первый день двухдневного Moving Festival.',
};
const movingDay2 = {
    title: 'Moving Festival', eventDate: '2026-08-25', displayDate: '25 августа 2026',
    timeLabel: '20:00', venue: 'Площадка Б', description: 'Второй день двухдневного Moving Festival.',
};
const movingCmp = compareEventsDeterministic(movingDay1, movingDay2);
assert.equal(movingCmp.verdict, 'ambiguous');
const movingMerged = await deduplicateEventsTwoContour([movingDay1, movingDay2], {
    arbitrateAmbiguous: async (pairs) => new Map(pairs.map((pair) => [pair.key, {
        verdict: 'same', confidence: 0.99, reason: 'explicit two-day event',
    }])),
});
assert.equal(movingMerged.events.length, 1);

// 9) AI prompt treats event content as untrusted; hard conflicts remain final for non-exact pairs.
const prompt = buildEventDuplicateAiSystemPrompt();
assert.match(prompt, /недоверенн/iu);
assert.match(prompt, /Hard conflicts/iu);
assert.match(prompt, /DIESEL HALL.*Diesel Bar/iu);

// 10) Идемпотентность: второй проход не создаёт новых merge/дубликатов.
const firstPass = await deduplicateEventsTwoContour([tattooA, tattooB, dieselHall, dieselBar]);
const secondPass = await deduplicateEventsTwoContour(firstPass.events);
assert.equal(secondPass.events.length, firstPass.events.length);

// 11) Blocking обязан сокращать число сравнений на разреженной выборке.
const synthetic = Array.from({ length: 240 }, (_, index) => ({
    title: `Уникальное событие ${index}`,
    eventDate: `2026-09-${String((index % 28) + 1).padStart(2, '0')}`,
    timeLabel: `${String(10 + (index % 10)).padStart(2, '0')}:00`,
    venue: `Площадка ${index}`,
    participants: `Артист ${index}`,
}));
const syntheticResult = await deduplicateEventsTwoContour(synthetic);
assert.equal(syntheticResult.events.length, synthetic.length);
assert.ok(syntheticResult.candidatePairCount < syntheticResult.totalPossiblePairCount * 0.15,
    `blocking ineffective: ${syntheticResult.candidatePairCount}/${syntheticResult.totalPossiblePairCount}`);

console.log('eventDedupeIndustrialV107.test.mjs: OK');
