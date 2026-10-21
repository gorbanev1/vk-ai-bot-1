import assert from 'node:assert/strict';
import {
  compareEventsDeterministic,
  deduplicateEventsTwoContour,
  deriveEventScheduleDays,
  getEventDateEvidence,
} from '../../src/features/events/eventDuplicateResolution.js';
import { getCompactSupportedTime } from '../../src/features/events/compactPartySummary.js';

// 1) Сырые посты могут содержать даты других событий. Это НЕ диапазон.
const singleWithForeignDates = {
  title: 'Двойной Кураж',
  eventDate: '2026-08-21',
  displayDate: '21 августа 2026',
  timeLabel: '19:00',
  venue: 'The Last of Vavilone',
  participants: 'ELIJAH GOOD, ТРИПП, Мера Беспорядка',
  _compactTimeSource: '21 августа 2026 начало 19:00. В соседнем сообщении упоминается 31.08.26.',
};
assert.deepEqual(getEventDateEvidence(singleWithForeignDates).dates, ['2026-08-21']);
assert.equal(deriveEventScheduleDays(singleWithForeignDates).length, 1);

// 2) Явный диапазон остаётся диапазоном, но не растягивается до случайной даты из raw.
const tattooA = {
  title: 'TATTOOMO 2026',
  eventDate: '2026-08-21',
  displayDate: '21.08.26–23.08.26',
  timeLabel: '10:00–21:30',
  venue: 'МТС Live Hall',
  participants: 'НРРТР',
  _compactTimeSource: 'TATTOOMO 21.08.26–23.08.26, ежедневно 10:00–21:30. Другая дата в ленте: 31.08.26.',
  sourceType: 'telegram', sourceName: '@kurazhcity', sourceUrl: 'https://t.me/kurazhcity/3960',
};
assert.deepEqual(getEventDateEvidence(tattooA).dates, ['2026-08-21', '2026-08-22', '2026-08-23']);
assert.equal(deriveEventScheduleDays(tattooA).length, 3);

// 3) 21.08.26 нельзя превращать в 21:08.
const tattooBadTime = {
  title: 'TATTOOMO 2026 — тату-фестиваль с мастер-классами и показом работ мастеров',
  eventDate: '2026-08-21',
  displayDate: '21.08.26–23.08.26',
  timeLabel: '21:08',
  venue: 'МТС Live Hall',
  participants: 'НРРТР',
  _compactTimeSource: 'TATTOOMO 2026. 21.08.26–23.08.26. МТС Live Hall.',
  sourceType: 'vk', sourceName: 'Беседа 22', sourceUrl: '',
};
assert.equal(getCompactSupportedTime(tattooBadTime), '');
assert.ok(deriveEventScheduleDays(tattooBadTime).every((day) => !day.timeLabel));

// Даже с фальшивым временем одинаковое событие должно схлопнуться в одну карточку.
const tattooMerged = await deduplicateEventsTwoContour([tattooA, tattooBadTime]);
assert.equal(tattooMerged.events.length, 1);
assert.deepEqual(tattooMerged.events[0].eventDays.map((d) => d.date), ['2026-08-21', '2026-08-22', '2026-08-23']);
assert.ok(tattooMerged.events[0].eventDays.every((d) => d.timeLabel !== '21:08'));
assert.equal(tattooMerged.events[0].mergedSources.length, 2);

// 4) Двухдневный ивент нельзя растягивать до конца месяца из-за чужих дат в raw.
const moto = {
  title: 'Мото Што-то!',
  eventDate: '2026-08-21',
  displayDate: '21.08.26–22.08.26',
  timeLabel: '17:00; 12:00',
  venue: 'турбаза Астра, Новая Усмань',
  participants: 'Такие Дела, РАДА ВЕЛЕС, Хижина Дядюшки Джо, ЛИАНА, Синергия, Eleanore Begin, Советское Барахло',
  _compactTimeSource: '21.08.26 в 17:00, 22.08.26 в 12:00. Следующий анонс 31.08.26.',
};
assert.deepEqual(deriveEventScheduleDays(moto).map((d) => [d.date, d.timeLabel]), [
  ['2026-08-21', '17:00'],
  ['2026-08-22', '12:00'],
]);

// 5) Разные концерты в одном клубе в один день не склеиваются только из-за venue/time.
const dieselA = {
  title: 'The Second-to-Last Saturday',
  eventDate: '2026-08-22', displayDate: '22 августа 2026', timeLabel: '19:00',
  venue: 'Diesel Bar',
  participants: 'Без Мрака, Переломный момент, Паническая защита',
  description: 'Три группы сыграют живой локальный гиг.',
};
const dieselB = {
  title: 'Котик 22.08.26',
  eventDate: '2026-08-22', displayDate: '22 августа 2026', timeLabel: '19:30',
  venue: 'DIESEL HALL, Воронеж',
  participants: 'Ночное отделение, Последняя Птчка, LISD',
  description: 'Вечер нишевых проектов с экспериментальным звучанием.',
};
assert.equal(compareEventsDeterministic(dieselA, dieselB).verdict, 'different');
let wrongAiCalls = 0;
const dieselResult = await deduplicateEventsTwoContour([dieselA, dieselB], {
  arbitrateAmbiguous: async () => {
    wrongAiCalls += 1;
    return new Map();
  },
});
assert.equal(dieselResult.events.length, 2);
assert.equal(wrongAiCalls, 0, 'obvious same-venue collision must not be delegated to AI');

// 6) Транзитивная карточка не должна склеить два напрямую разных события.
const bridge = {
  title: 'Локальный концерт',
  eventDate: '2026-08-22', displayDate: '22 августа 2026', timeLabel: '19:15',
  venue: 'DIESEL', participants: '', description: 'живой концерт в DIESEL',
};
const bridgeResult = await deduplicateEventsTwoContour([dieselA, bridge, dieselB], {
  arbitrateAmbiguous: async (pairs) => new Map(pairs.map((p) => [p.key, { verdict: 'same', confidence: 0.99, reason: 'forced test' }])),
});
assert.ok(bridgeResult.events.length >= 2, 'complete-link must prevent A-B-C false cluster');


// 7) Один двухдневный ивент с разными площадками должен объединяться после AI,
// а расписание обязано сохранить место каждого дня.
const movingDay1 = {
  title: 'Moving Festival', eventDate: '2026-08-24', displayDate: '24 августа 2026',
  timeLabel: '18:00', venue: 'Площадка А', participants: '',
  description: 'Первый день двухдневного Moving Festival. Завтра продолжение на другой площадке.',
  sourceType: 'telegram', sourceName: '@source1', sourceUrl: 'https://t.me/source1/1',
};
const movingDay2 = {
  title: 'Moving Festival', eventDate: '2026-08-25', displayDate: '25 августа 2026',
  timeLabel: '20:00', venue: 'Площадка Б', participants: '',
  description: 'Второй день двухдневного Moving Festival, продолжение программы.',
  sourceType: 'vk', sourceName: 'source2', sourceUrl: 'https://vk.ru/wall-1_1',
};
let movingAiCalls = 0;
const movingResult = await deduplicateEventsTwoContour([movingDay1, movingDay2], {
  arbitrateAmbiguous: async (pairs) => {
    movingAiCalls += 1;
    return new Map(pairs.map((p) => [p.key, { verdict: 'same', confidence: 0.96, reason: 'two days of one named festival' }]));
  },
  consolidateConfirmedGroup: async () => ({
    title: 'Moving Festival',
    description: 'Двухдневный фестиваль с программой на двух площадках.',
    eventDays: [
      { date: '2026-08-24', timeLabel: '18:00', venue: 'Площадка А' },
      { date: '2026-08-25', timeLabel: '20:00', venue: 'Площадка Б' },
    ],
  }),
});
assert.ok(movingAiCalls >= 1);
assert.equal(movingResult.events.length, 1);
assert.deepEqual(movingResult.events[0].eventDays.map((d) => [d.date, d.timeLabel, d.venue]), [
  ['2026-08-24', '18:00', 'Площадка А'],
  ['2026-08-25', '20:00', 'Площадка Б'],
]);
assert.equal(movingResult.events[0].mergedSources.length, 2);

console.log('eventDedupeRegressionV95.test.mjs: OK');
