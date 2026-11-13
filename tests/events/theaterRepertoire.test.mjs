import test from 'node:test';
import assert from 'node:assert/strict';
import {
    validateTheaterRepertoireSchedule,
    getSharedEventSchedule,
    isTheaterRepertoireEvent,
    eventScheduleMatchesRange,
    nextSharedEventDate,
} from '../../src/features/events/sharedEventSchedule.js';
import { classifyEventPartyPool, PARTY_POOL_SECONDARY } from '../../src/features/events/partyPool.js';
import { validatePublicAiEvents, setPublicAiResponseMetadata } from '../../src/features/events/publicPostLocalParser.js';

const publishedAt = Date.parse('2026-01-10T12:00:00Z') / 1000;
const schedule = {
    dateMode: 'specific',
    startDate: '2026-05-01',
    endDate: '2026-05-31',
    dates: ['2026-05-01', '2026-05-31'],
};

test('theater repertoire is one secondary card with a grounded date/program map', () => {
    const event = {
        structureDecision: 'theater_repertoire',
        eventDate: schedule.startDate,
        eventSchedule: schedule,
        programItems: [
            { date: '2026-05-01', title: 'Спектакль Альфа', evidence: '1 мая — Спектакль Альфа' },
            { date: '2026-05-31', title: 'Спектакль Бета', evidence: '31 мая — Спектакль Бета' },
        ],
    };
    const result = validateTheaterRepertoireSchedule(event, {
        sourceText: 'Репертуар: 1 мая — Спектакль Альфа; 31 мая — Спектакль Бета.',
        publishedAt,
    });
    assert.equal(result.ok, true, result.reason);
    assert.equal(isTheaterRepertoireEvent(event), true);
    assert.ok(getSharedEventSchedule(event));
    assert.equal(classifyEventPartyPool({ ...event, sourceType: 'vk_public', sourceName: 'ordinary_main' }), PARTY_POOL_SECONDARY);
    assert.equal(eventScheduleMatchesRange(event, '2026-05-01', '2026-05-31'), true);
    assert.equal(nextSharedEventDate(event, '2026-05-02'), '2026-05-31');
});

test('theater repertoire rejects an incomplete date/program map', () => {
    const event = {
        structureDecision: 'theater_repertoire',
        eventDate: schedule.startDate,
        eventSchedule: schedule,
        programItems: [{ date: '2026-05-01', title: 'Спектакль Альфа', evidence: '1 мая — Спектакль Альфа' }],
    };
    const result = validateTheaterRepertoireSchedule(event, {
        sourceText: 'Репертуар: 1 мая — Спектакль Альфа; 31 мая — Спектакль Бета.',
        publishedAt,
    });
    assert.equal(result.ok, false);
    assert.equal(result.reason, 'theater-repertoire-program-items-missing');
});

test('public AI parser keeps one repertoire event and preserves every date/program row', () => {
    const sourceText = 'Культурное пространство Сцена: 1 мая — Спектакль Альфа; 31 мая — Спектакль Бета.';
    const input = setPublicAiResponseMetadata([{
        date: schedule.startDate,
        title: 'Репертуар театра',
        venue: 'Культурное пространство Сцена',
        announcement: 'Репертуар спектаклей площадки.',
        evidence: '1 мая — Спектакль Альфа',
        schedule,
        program_items: [
            { date: '2026-05-01', title: 'Спектакль Альфа', time: '19:00', evidence: '1 мая — Спектакль Альфа' },
            { date: '2026-05-31', title: 'Спектакль Бета', time: '18:00', evidence: '31 мая — Спектакль Бета' },
        ],
        _structure: 'theater_repertoire',
    }], { structure: 'theater_repertoire', valid: true });
    const result = validatePublicAiEvents(input, { text: sourceText, __sourceAnnouncementText: sourceText, publishedAt });
    assert.equal(result.aiResponseValid, true, JSON.stringify({ error: result.aiResponseError, failures: result.aiValidationFailures }));
    assert.equal(result.length, 1);
    assert.equal(result[0].structureDecision, 'theater_repertoire');
    assert.deepEqual(result[0].programItems.map(({ date, title, time }) => ({ date, title, time })), [
        { date: '2026-05-01', title: 'Спектакль Альфа', time: '19:00' },
        { date: '2026-05-31', title: 'Спектакль Бета', time: '18:00' },
    ]);
});

test('legacy multiple-events AI response is collapsed only for an explicit theatre repertoire', () => {
    const sourceText = 'НОЯБРЬСКИЙ РЕПЕРТУАР ТЕАТРА: 1 мая — Спектакль Альфа в ДК Железнодорожников; 31 мая — Спектакль Бета в ДК Железнодорожников.';
    const input = setPublicAiResponseMetadata([
        { date: '2026-05-01', title: 'Спектакль Альфа', time: '19:00', venue: 'ДК Железнодорожников', announcement: 'Спектакль Альфа.', evidence: '1 мая — Спектакль Альфа в ДК Железнодорожников' },
        { date: '2026-05-31', title: 'Спектакль Бета', time: '18:00', venue: 'ДК Железнодорожников', announcement: 'Спектакль Бета.', evidence: '31 мая — Спектакль Бета в ДК Железнодорожников' },
    ], { structure: 'multiple_events', reason: 'Два спектакля в афише театра.', valid: true });
    const result = validatePublicAiEvents(input, { text: sourceText, __sourceAnnouncementText: sourceText, publishedAt });
    assert.equal(result.aiResponseValid, true, JSON.stringify({ error: result.aiResponseError, failures: result.aiValidationFailures }));
    assert.equal(result.length, 1);
    assert.equal(result[0].structureDecision, 'theater_repertoire');
    assert.equal(result[0].title, 'Репертуар театра');
    assert.deepEqual(result[0].eventSchedule.dates, ['2026-05-01', '2026-05-31']);
    assert.deepEqual(result[0].programItems.map(item => item.title), ['Спектакль Альфа', 'Спектакль Бета']);
});
