import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';

import {
    parseQticketsCommand,
    hasQticketsPriceLimit,
    qticketsEventHasConflictingCity,
    resolveQticketsWindowSpec,
} from '../../src/features/events/qticketsRouting.js';
import { createPublicEventRangeService } from '../../src/features/events/publicEventRange.js';

const applicationSource = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('recognizes public QTickets category aliases', () => {
    for (const input of ['qtickets', '/qtickets', 'qtickets события', 'qtickets events', 'события кутикетс', 'ивенты q-tickets']) {
        const result = parseQticketsCommand(input);
        assert.equal(result.matched, true, input);
        assert.equal(result.action, 'list', input);
    }
});

test('recognizes the owner-only refresh namespace separately', () => {
    for (const input of ['qtickets парсер', 'qtickets обновить', 'парсер qtickets', 'q tickets run']) {
        const result = parseQticketsCommand(input);
        assert.equal(result.matched, true, input);
        assert.equal(result.action, 'scrape', input);
    }
});

test('parses incremental and turbo4 QTickets runs regardless of modifier order', () => {
    for (const input of [
        'кутикетс парсер новые турбо4',
        'турбо4 новые парсер кутикетс',
        'q tickets run clean turbo4',
    ]) {
        const result = parseQticketsCommand(input);
        assert.equal(result.matched, true, input);
        assert.equal(result.action, 'scrape', input);
        assert.equal(result.cleanOnly, true, input);
        assert.equal(result.turboMode, 'turbo4', input);
    }
});

test('QTickets intent, listing modifiers, and range work in any word order', () => {
    for (const input of [
        'тусы тусы кутикетс все время кратко',
        'кратко все время кутикетс тусы',
        'кутикетс кратко тусы за все время',
        'turbo4 новые парсер кутикетс',
        'новые турбо4 кутикетс парсер',
    ]) {
        const result = parseQticketsCommand(input);
        assert.equal(result.matched, true, input);
        if (/парсер/u.test(input)) {
            assert.equal(result.action, 'scrape', input);
            assert.equal(result.cleanOnly, true, input);
            assert.equal(result.turboMode, 'turbo4', input);
        } else {
            assert.equal(result.action, 'list', input);
            assert.match(result.rangeText, /время/u, input);
            assert.equal(resolveQticketsWindowSpec(result).usePublicRange, true, input);
        }
    }
});

test('incoming scraper fast path dispatches QTickets before generic parser handling', () => {
    assert.match(applicationSource, /function resolveIncomingScraperFastPath\(value\)[\s\S]*?resolveIncomingCommandPriority\(value/u);
    assert.match(applicationSource, /if \(scraperFastPath\?\.route === 'qtickets-events'\)[\s\S]*?handleQticketsCommand\(context, scraperFastPath\.selected\.command\)/u);
    assert.equal(applicationSource.includes('const scraperFastMatch = parseIncomingCommand('), false);
});

test('keeps an optional public date range after the namespace', () => {
    const result = parseQticketsCommand('qtickets события на выходных');
    assert.equal(result.matched, true);
    assert.equal(result.action, 'list');
    assert.equal(result.rangeText, 'на выходных');
});

test('resolves an unqualified weekend request through the exact public calendar range', () => {
    const command = parseQticketsCommand('qtickets тусы выходные');
    assert.deepEqual(resolveQticketsWindowSpec(command), {
        dayCount: null,
        weekendsOnly: false,
        usePublicRange: true,
    });
    const service = createPublicEventRangeService({
        timeZone: 'Europe/Moscow',
        now: () => new Date('2026-10-06T12:00:00+03:00'),
    });
    const range = service.parsePublicEventsRangeCommand(`тусы ${command.rangeText}`);
    assert.equal(range.fromDate, '2026-10-09');
    assert.equal(range.toDate, '2026-10-11');
});

test('detects Moscow event identity despite a polluted Voronezh venue field', () => {
    assert.equal(qticketsEventHasConflictingCity({
        title: '09.10 | С.Т.А.Я. | МОСКВА',
        description: 'Клуб Свобода, Ленинградский проспект, 47с19, Москва.',
        venue: 'Клуб Свобода, Ленинградский проспект, 47с19, Воронеж, Россия',
    }), true);
    assert.equal(qticketsEventHasConflictingCity({
        title: 'Концерт',
        description: 'Площадка на Московском проспекте, Воронеж.',
    }), false);
    assert.equal(qticketsEventHasConflictingCity({
        title: 'Группа из Москвы в Воронеже',
        description: 'Концерт состоится в Воронеже.',
    }), false);
});

test('price filter stays optional unless a maximum is stated explicitly', () => {
    assert.equal(parseQticketsCommand('qtickets тусы выходные').maxPrice, null);
    assert.equal(hasQticketsPriceLimit(null), false);
    assert.equal(hasQticketsPriceLimit(''), false);
    assert.equal(hasQticketsPriceLimit(0), true);
    assert.equal(hasQticketsPriceLimit(700), true);
    assert.equal(parseQticketsCommand('qtickets тусы выходные до 700').maxPrice, 700);
});

test('one week means the current calendar week including the weekend, while two weeks is rolling', () => {
    const oneWeek = parseQticketsCommand('qtickets тусы на неделю');
    assert.equal(resolveQticketsWindowSpec(oneWeek).usePublicRange, true);
    const twoWeeks = parseQticketsCommand('qtickets тусы на две недели');
    assert.equal(resolveQticketsWindowSpec(twoWeeks).dayCount, 14);
});

test('bare QTickets command keeps its seven-day window without enabling a price cap', () => {
    const bare = parseQticketsCommand('qtickets');
    assert.equal(resolveQticketsWindowSpec(bare).dayCount, 7);
    assert.equal(bare.maxPrice, null);
});
