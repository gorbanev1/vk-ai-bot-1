import test from 'node:test';
import assert from 'node:assert/strict';
import {
    eventScheduleMatchesRange,
    getSharedEventSchedule,
    isTheaterRepertoireEvent,
    nextSharedEventDate,
    validateTheaterRepertoireSchedule,
} from '../../src/features/events/sharedEventSchedule.js';
import { classifyEventPartyPool, PARTY_POOL_SECONDARY } from '../../src/features/events/partyPool.js';
import { validatePublicAiEvents, setPublicAiResponseMetadata } from '../../src/features/events/publicPostLocalParser.js';

const publishedAt = Date.parse('2026-11-01T12:00:00Z') / 1000;
const dates = ['2026-11-18', '2026-11-20', '2026-11-27'];
const schedule = {
    dateMode: 'specific',
    startDate: dates[0],
    endDate: dates.at(-1),
    dates,
};
const sourceText = [
    'Культурное пространство «Сцена». Репертуар театра.',
    '18 ноября — Спектакль «Альфа».',
    '20 ноября — Спектакль «Бета».',
    '27 ноября — Спектакль «Гамма».',
].join('\n');

function repertoireEvent(overrides = {}) {
    return {
        title: 'Культурное пространство «Сцена» — репертуар',
        venue: 'Культурное пространство «Сцена»',
        eventDate: dates[0],
        structureDecision: 'theater_repertoire',
        eventSchedule: schedule,
        programItems: [
            { date: '18 ноября', title: 'Спектакль «Альфа»', text: 'Спектакль «Альфа»', evidence: '18 ноября — Спектакль «Альфа».' },
            { date: '20 ноября', title: 'Спектакль «Бета»', text: 'Спектакль «Бета»', evidence: '20 ноября — Спектакль «Бета».' },
            { date: '27 ноября', title: 'Спектакль «Гамма»', text: 'Спектакль «Гамма»', evidence: '27 ноября — Спектакль «Гамма».' },
        ],
        ...overrides,
    };
}

test('theater repertoire validates one card with several date/program entries', () => {
    const result = validateTheaterRepertoireSchedule(repertoireEvent(), { sourceText, publishedAt });
    assert.equal(result.ok, true, result.reason);
    assert.deepEqual(result.schedule.dates, dates);
});

test('theater repertoire rejects a single date', () => {
    const result = validateTheaterRepertoireSchedule(repertoireEvent({
        eventSchedule: { dateMode: 'specific', startDate: dates[0], endDate: dates[0], dates: [dates[0]] },
    }), { sourceText: '18 ноября — Спектакль «Альфа».', publishedAt });
    assert.equal(result.ok, false);
    assert.match(result.reason, /invalid-theater-repertoire-schedule|theater-repertoire-needs-multiple-dates/u);
});

test('theater repertoire uses the next not-yet-passed date for visibility and order', () => {
    const event = repertoireEvent();
    assert.equal(isTheaterRepertoireEvent(event), true);
    assert.deepEqual(getSharedEventSchedule(event).dates, dates);
    assert.equal(nextSharedEventDate(event, '2026-11-18'), '2026-11-18');
    assert.equal(nextSharedEventDate(event, '2026-11-19'), '2026-11-20');
    assert.equal(nextSharedEventDate(event, '2026-11-21'), '2026-11-27');
    assert.equal(nextSharedEventDate(event, '2026-11-28'), '');
    assert.equal(eventScheduleMatchesRange(event, '2026-11-19', '2026-11-20'), true);
    assert.equal(eventScheduleMatchesRange(event, '2026-11-21', '2026-11-26'), false);
});

test('theater repertoire is always classified into the secondary pool', () => {
    const event = repertoireEvent({ sourceType: 'vk-public', sourceName: 'a-primary-source' });
    assert.equal(classifyEventPartyPool(event), PARTY_POOL_SECONDARY);
});

test('legacy split theatre repertoire cards are kept out of the primary pool', () => {
    const result = classifyEventPartyPool({
        structureDecision: 'multiple_events',
        sourceText: 'НОЯБРЬСКИЙ РЕПЕРТУАР ТЕАТРА: 17.11 19:00 Спектакль Альфа; 19.11 19:00 Спектакль Бета.',
        sourceSegment: '17 ноября | Спектакль Альфа',
        eventDate: '2026-11-17',
    });
    assert.equal(result, PARTY_POOL_SECONDARY);
});

test('public parser keeps a repertoire as one card with date-specific programs', () => {
    const aiEvents = setPublicAiResponseMetadata([{
        date: dates[0],
        title: 'Культурное пространство «Сцена» — репертуар',
        venue: 'Культурное пространство «Сцена»',
        schedule,
        program_items: repertoireEvent().programItems,
        evidence: '18 ноября — Спектакль «Альфа».',
        announcement: sourceText,
        source_segment: sourceText,
        _structure: 'theater_repertoire',
    }], { structure: 'theater_repertoire', valid: true });
    const parsed = validatePublicAiEvents(aiEvents, { text: sourceText, publishedAt });
    assert.equal(parsed.aiResponseValid, true, parsed.aiResponseError);
    assert.equal(parsed.length, 1);
    assert.equal(parsed[0].structureDecision, 'theater_repertoire');
    assert.equal(parsed[0].programItems.length, 3);
    assert.deepEqual(parsed[0].eventSchedule.dates, dates);
});
