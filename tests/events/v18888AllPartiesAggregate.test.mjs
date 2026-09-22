import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    buildAllPartyMetadataRecord,
    dedupeAllPartiesRealtime,
    findAllPartySharedTitleWord,
    normalizeAllPartyTitleTokens,
    parseAllPartiesRequest,
} from '../../src/features/events/allPartyDedupe.js';
import { createPublicEventRangeService } from '../../src/features/events/publicEventRange.js';

const rangeService = createPublicEventRangeService({
    timeZone: 'Europe/Moscow',
    now: () => new Date('2026-09-16T12:00:00.000Z'),
});

test('V188.88 aggregate dedupe uses same date plus standalone title word >3 and ignores venue mismatch', () => {
    const left = buildAllPartyMetadataRecord({
        id: 1,
        sourceType: 'vk',
        title: 'STONEHAND DIESEL HALL',
        eventDate: '2026-09-26',
        venue: 'Diesel Hall',
    });
    const right = buildAllPartyMetadataRecord({
        id: 2,
        sourceType: 'qtickets',
        title: 'STONEHAND — большой концерт',
        eventDate: '2026-09-26',
        venue: 'Совсем другое написание места',
    });
    assert.equal(findAllPartySharedTitleWord(left, right), 'stonehand');

    const dedupe = dedupeAllPartiesRealtime([
        { id: 1, sourceType: 'vk', partyPool: 'primary', title: left.title, eventDate: left.eventDate, venue: left.venue },
        { id: 2, sourceType: 'qtickets', partyPool: 'qtickets', title: right.title, eventDate: right.eventDate, venue: right.venue },
    ]);
    assert.equal(dedupe.events.length, 1);
    assert.equal(dedupe.events[0].sourceType, 'qtickets');
});

test('V188.88 aggregate dedupe does not merge by generic format word or different date', () => {
    assert.deepEqual(normalizeAllPartyTitleTokens('Концерт группы Альфа'), ['группы', 'альфа']);
    const genericA = buildAllPartyMetadataRecord({ id: 1, sourceType: 'vk', title: 'Концерт Альфа', eventDate: '2026-09-20' });
    const genericB = buildAllPartyMetadataRecord({ id: 2, sourceType: 'qtickets', title: 'Концерт Бета', eventDate: '2026-09-20' });
    assert.equal(findAllPartySharedTitleWord(genericA, genericB), '');
    const anotherDate = { ...genericA, eventDate: '2026-09-21' };
    assert.equal(findAllPartySharedTitleWord(genericA, anotherDate), '');
});

test('V188.88 all-party command parser recognizes aggregate section', () => {
    const parsed = parseAllPartiesRequest('вообще все тусы на этих выходных кратко');
    assert.equal(parsed.matched, true);
    assert.match(parsed.rangeText, /выходных/u);
});

test('V188.88 party date parser accepts weekday, numeric date and Russian month cases', () => {
    const friday = rangeService.parsePublicEventsRangeCommand('тусы в пятницу');
    assert.equal(friday?.fromDate, '2026-09-18');
    const numeric = rangeService.parsePublicEventsRangeCommand('тусы 22.09.2026');
    assert.equal(numeric?.fromDate, '2026-09-22');
    const words = rangeService.parsePublicEventsRangeCommand('тусы 22 сентября 2026');
    assert.equal(words?.fromDate, '2026-09-22');
    const instrumentalMonth = rangeService.parsePublicEventsRangeCommand('тусы сентябрем 2026');
    assert.equal(instrumentalMonth?.kind, 'month');
    assert.equal(instrumentalMonth?.toDate, '2026-09-30');
});

test('V188.88 QTickets listing root is globally rejected as a buy-ticket URL', () => {
    const source = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(source, /function isQticketsListingRootUrl/u);
    assert.match(source, /if \(isQticketsListingRootUrl\(ticket\)\) return false/u);
    assert.match(source, /if \(isUsefulEventTicketUrl\(ticketUrl, event\)\)/u);
});
