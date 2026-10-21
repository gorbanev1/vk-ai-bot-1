import assert from 'node:assert/strict';
import {
    buildCompactPartyPayload,
    extractTicketLink,
    isCompactPartyRequest,
    normalizeCompactSummary,
    isCompactSummaryUsable,
    getCompactSupportedTime,
} from '../../src/features/events/compactPartySummary.js';

assert.equal(isCompactPartyRequest('Гигорейв тусы на неделю кратко'), true);
assert.equal(isCompactPartyRequest('коротко тусы на выходных'), true);
assert.equal(isCompactPartyRequest('тусы на месяц'), false);

const ticket = extractTicketLink({
    description: 'Билеты здесь: https://tickets.example/event/42 Остальное в посте https://vk.ru/wall-1_2',
});
assert.equal(ticket, 'https://tickets.example/event/42');

const payload = buildCompactPartyPayload([{
    title: 'Тест',
    eventDate: '2026-08-12',
    description: 'Купить билет: https://tickets.example/e/1. Две сцены и DJ-сеты.',
}]);
assert.equal(payload.length, 1);
assert.equal(payload[0].ticketLink, 'https://tickets.example/e/1');
assert.match(payload[0].sourceText, /Две сцены/u);
assert.doesNotMatch(payload[0].sourceText, /https?:/u);

const qticketsRootPayload = buildCompactPartyPayload([{
    detailUrl: 'https://voronezh.qtickets.events/259022-dima-vagin-kontsert-2809-kopiya',
    sourceUrl: 'https://voronezh.qtickets.events/259022-dima-vagin-kontsert-2809-kopiya',
    ticketUrl: 'https://voronezh.qtickets.events/',
    description: 'Дима Вагин. Купить билет на странице события.',
}]);
assert.equal(qticketsRootPayload[0].ticketLink, '');

const summary = normalizeCompactSummary('Первая фраза. Вторая фраза! Третья? Четвёртая.', 300);
assert.equal(summary, 'Первая фраза. Вторая фраза! Третья? Четвёртая.');
assert.equal(isCompactSummaryUsable(summary), true);
assert.equal(isCompactSummaryUsable('Вечер живой музыки.'), false);
assert.equal(isCompactSummaryUsable('Фестиваль выпускников музыкального проекта. На сцене выступят участники прошлых сезонов с живой программой.'), true);
assert.equal(isCompactSummaryUsable('ДействияСегодня выступит группа. Показать ещё 5Ответить Поделиться'), false);

console.log('compactPartySummary tests: OK');


const dirtyGiveaway = normalizeCompactSummary('Для этого нужно: вступить во встречу, нажать "Точно пойду". Итоги конкурса будут 15 августа! Тяжёлый концерт с новым материалом.', 300);
assert.equal(dirtyGiveaway, 'Тяжёлый концерт с новым материалом.');

assert.equal(getCompactSupportedTime({
    eventTime: '09:26',
    description: 'STONEHAND — 26.09.2026, DIESEL HALL',
}), '');
assert.equal(getCompactSupportedTime({
    eventTime: '19:30',
    description: '14 августа, начало 19:30, Rock Bar DIESEL',
}), '19:30');
