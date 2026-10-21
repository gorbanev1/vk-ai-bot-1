import assert from 'node:assert/strict';
import {
    compareEventsDeterministic,
    deduplicateEventsTwoContour,
    deriveEventScheduleDays,
    eventParticipantsSimilarity,
    eventVenueSimilarity,
    formatMergedEventSources,
} from '../../src/features/events/eventDuplicateResolution.js';

const telegram = {
    title: 'Вечеринка с грибным эмбиентом',
    eventDate: '2026-08-16',
    eventTime: '18:00',
    timeLabel: '18:00',
    venue: 'Тупик',
    participants: 'Omamori, Просторъ, zadushimenya., DJ Earectorr',
    description: 'В программе — грибной эмбиент от трёх исполнителей и виниловый сет после выступлений. Музыкальная часть вечера будет сопровождаться пивом и гренками.',
    sourceType: 'telegram',
    sourceName: '@kurazhcity',
    sourceUrl: 'https://t.me/kurazhcity/3945',
};
const vk = {
    title: 'BEERBIENT',
    eventDate: '2026-08-16',
    eventTime: '19:00',
    timeLabel: 'двери: 18:00, начало: 19:00',
    venue: 'Бар «Тупик», Проспект Революции 31а',
    participants: 'Omamori, Просторъ, zadushimenya., DJ Earectorr',
    price: 'свободный вход',
    description: 'Три музыкальных коллектива выступят в камерной обстановке под грибной эмбиент. Завершит программу более динамичный виниловый сет. Организатор — EMIVA.',
    sourceType: 'vk',
    sourceName: 'deadway36',
    sourceUrl: 'https://vk.ru/wall-234720249_131',
};

assert.ok(eventVenueSimilarity(telegram.venue, vk.venue) >= 0.95);
assert.ok(eventParticipantsSimilarity(telegram.participants, vk.participants) >= 0.99);
const deterministic = compareEventsDeterministic(telegram, vk);
assert.equal(deterministic.verdict, 'same');

const merged = await deduplicateEventsTwoContour([telegram, vk]);
assert.equal(merged.events.length, 1);
assert.equal(merged.events[0].title, 'BEERBIENT');
assert.match(merged.events[0].description, /пивом и гренками/iu);
assert.match(merged.events[0].description, /Организатор — EMIVA/iu);
assert.equal(merged.events[0].mergedSources.length, 2);
assert.equal(formatMergedEventSources(merged.events[0]).length, 2);
assert.match(merged.events[0].timeLabel, /18:00/iu);
assert.match(merged.events[0].timeLabel, /19:00/iu);

const mergedWithDbRefs = await deduplicateEventsTwoContour([
    { ...telegram, _dedupeRefs: [{ sourceType: 'telegram', id: 101 }] },
    { ...vk, _dedupeRefs: [{ sourceType: 'vk', id: 202 }] },
]);
assert.deepEqual(
    mergedWithDbRefs.events[0]._dedupeRefs,
    [
        { sourceType: 'telegram', id: 101 },
        { sourceType: 'vk', id: 202 },
    ],
    'V103 registry refs must survive every merge contour',
);

// V94 regression: одинаковое название с одним и тем же диапазоном дат не может
// остаться двумя строками, даже если исходный eventDate у источников указывает
// на разные дни диапазона.
const tattooTelegram = {
    title: 'TATTOOMO 2026',
    eventDate: '2026-08-21',
    displayDate: '21.08.26–23.08.26',
    timeLabel: '10:00–21:30',
    venue: 'МТС Live Hall',
    participants: 'НРРТР',
    price: 'Первый день бесплатно, второй и третий день — 1000р.',
    description: 'Тату-фестиваль с мастер-классами и показом работ мастеров.',
    sourceType: 'telegram', sourceName: '@kurazhcity', sourceUrl: 'https://t.me/kurazhcity/4000',
};
const tattooVk = {
    title: 'tattoomo 2026',
    eventDate: '2026-08-23',
    displayDate: '21.08.26–23.08.26',
    timeLabel: '10:00-21:30',
    venue: 'MTS LIVE HALL, Воронеж',
    participants: 'НРРТР',
    price: 'первый день - бесплатно; 2/3 день - 1000р.',
    description: 'Мастер-классы, выставочная и музыкальная части.',
    sourceType: 'vk', sourceName: 'event_source', sourceUrl: 'https://vk.ru/wall-1_2',
};
const tattooResult = await deduplicateEventsTwoContour([tattooTelegram, tattooVk]);
assert.equal(tattooResult.events.length, 1, 'TATTOOMO must never be duplicated');
assert.equal(tattooResult.events[0].mergedSources.length, 2);
assert.equal(deriveEventScheduleDays(tattooResult.events[0]).length, 3);

// V94 regression: двухдневный ивент с двумя временами превращается в один
// eventDays schedule, а не в две карточки.
const motoA = {
    title: 'Мото Што-то!',
    eventDate: '2026-08-21',
    displayDate: '21.08.26–22.08.26',
    timeLabel: '17:00; 12:00',
    venue: 'турбаза Астра, Новая Усмань',
    participants: 'Такие Дела, РАДА ВЕЛЕС, Хижина Дядюшки Джо',
    description: 'Двухдневный байкерский фестиваль с живой музыкой.',
    sourceType: 'telegram', sourceName: '@kurazhcity', sourceUrl: 'https://t.me/x/1',
};
const motoB = {
    ...motoA,
    eventDate: '2026-08-22',
    sourceType: 'vk', sourceName: 'vavilone_rb', sourceUrl: 'https://vk.ru/wall-2_3',
    description: 'Байкерский фестиваль: музыка, баня, маркеты мотоэкипировки.',
};
let mergeAiCalls = 0;
const motoResult = await deduplicateEventsTwoContour([motoA, motoB], {
    consolidateConfirmedGroup: async ({ members }) => {
        mergeAiCalls += 1;
        assert.equal(members.length, 2);
        return {
            title: 'Мото Што-то!',
            description: 'Двухдневный байкерский фестиваль с живой музыкой, баней и маркетами мотоэкипировки.',
            eventDays: [
                { date: '2026-08-21', timeLabel: '17:00', venue: 'турбаза Астра, Новая Усмань' },
                { date: '2026-08-22', timeLabel: '12:00', venue: 'турбаза Астра, Новая Усмань' },
            ],
        };
    },
});
assert.equal(mergeAiCalls, 1);
assert.equal(motoResult.events.length, 1);
assert.deepEqual(motoResult.events[0].eventDays.map((day) => day.timeLabel), ['17:00', '12:00']);
assert.match(motoResult.events[0].description, /баней/iu);

const different = compareEventsDeterministic(
    { ...vk, title: 'Другой концерт', participants: 'Band A', venue: 'Тупик', eventTime: '23:30', timeLabel: '23:30' },
    { ...vk, title: 'Совсем другое', participants: 'Band B', venue: 'Тупик', eventTime: '18:00', timeLabel: '18:00' },
);
assert.equal(different.verdict, 'different');

let aiCalled = 0;
const grayA = { title: 'Night Session', eventDate: '2026-09-01', timeLabel: '20:00', venue: 'Club X', participants: 'Alpha', description: 'ambient live' };
const grayB = { title: 'Осенняя сессия', eventDate: '2026-09-01', timeLabel: '20:30', venue: 'X', participants: 'Alpha, Beta', description: 'ambient show' };
const grayResult = await deduplicateEventsTwoContour([grayA, grayB], {
    arbitrateAmbiguous: async (pairs) => {
        aiCalled += 1;
        return new Map(pairs.map((pair) => [pair.key, { verdict: 'same', confidence: 0.9, reason: 'same lineup/place/time' }]));
    },
});
assert.equal(aiCalled, 1);
assert.equal(grayResult.events.length, 1);

console.log('eventDuplicateResolution.test.mjs: OK');
