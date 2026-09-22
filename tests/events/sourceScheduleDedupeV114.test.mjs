import test from 'node:test';
import assert from 'node:assert/strict';
import {
  compareEventsDeterministic,
  deduplicateEventsTwoContour,
  EVENT_DEDUPE_ALGORITHM_VERSION,
} from '../../src/features/events/eventDuplicateResolution.js';

const base = {
  eventDate: '2026-08-29',
  eventTime: '11:00',
  timeLabel: '11:00',
  venue: 'Советская площадь',
  price: 'Вход свободный',
  sourceUrl: 'https://max.ru/channel_rusleto36',
  sourceType: 'manual',
  sourceName: 'MAX',
};

test('V114 identifies the reported Русское лето duplicate deterministically', async () => {
  const first = {
    ...base,
    title: 'Мультижанровый фестиваль «Русское лето»',
    description: 'Фестиваль с музыкой, встречами и мастер-классами. Место: Советская площадь. Начало в 11:00. Друзья, мы наконец-то объявляем программу фестиваля «Русское лето»! Впереди — музыка, встречи, мастер-классы, яркие события и тёплая атмосфера большого летнего праздника!',
  };
  const second = {
    ...base,
    title: 'Мультижанровый фестиваль «Русское лето 2026»',
    description: 'Музыка, встречи и мастер-классы в рамках большого летнего праздника. Место: Советская площадь. Начало в 11:00. Друзья, мы наконец-то объявляем программу фестиваля «Русское лето»! Впереди — музыка, встречи, мастер-классы, яркие события и тёплая атмосфера большого летнего праздника!',
  };

  const comparison = compareEventsDeterministic(first, second);
  assert.equal(comparison.verdict, 'same');
  assert.ok(comparison.reasons.includes('same-source-schedule-identity-rule'));

  const result = await deduplicateEventsTwoContour([first, second]);
  assert.equal(result.events.length, 1);
  assert.equal(result.merges.length, 1);
});

test('V114 does not merge unrelated events merely because source/date/time/venue match', async () => {
  const first = {
    ...base,
    title: 'Лекция по истории Воронежа',
    description: 'Открытая лекция краеведа об истории города и архитектуре центра.',
  };
  const second = {
    ...base,
    title: 'Детский мастер-класс по живописи',
    description: 'Практический мастер-класс для детей: рисуем акварелью летний пейзаж.',
  };

  const comparison = compareEventsDeterministic(first, second);
  assert.notEqual(comparison.verdict, 'same');
  const result = await deduplicateEventsTwoContour([first, second]);
  assert.equal(result.events.length, 2);
});

test('V114 invalidates pre-V114 verified snapshots through algorithm version', () => {
  assert.match(EVENT_DEDUPE_ALGORITHM_VERSION, /v(?:114|1[2-9]\d)/u);
});
