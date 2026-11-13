import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { extractExplicitDates, extractEventDateRanges } from '../../src/features/events/publicPostDateEvidence.js';
import { setPublicAiResponseMetadata, validatePublicAiEvents, selectPublicAiEventsForPersistence } from '../../src/features/events/publicPostLocalParser.js';
import { explainStrictEventRecord } from '../../src/features/events/eventValidation.js';
import { runManualParserPoolUntilSettled } from '../../src/features/scrapers/manualProcessingPool.js';

const fixtures = JSON.parse(readFileSync(new URL('../fixtures/parserUnresolved20261025.json', import.meta.url), 'utf8'));
const now = new Date('2026-10-25T20:16:55Z');
const publication = fixtures[0].publishedAt;
const dates = (text, publishedAt = publication) => extractExplicitDates(text, publishedAt, { referenceNow: now });
function replay(fixture, { body = fixture.body, vision = fixture.vision, response = fixture.response } = {}) {
    const post = { text: `${body}\n\n${vision}`, publishedAt: fixture.publishedAt, referenceNow: now,
        __dateFreeVisionPhase: true, __sourceAnnouncementText: body, __posterGateFacts: vision };
    const ai = setPublicAiResponseMetadata(structuredClone(response.events), {
        structure: response.structure, reason: response.structure_reason, valid: true,
    });
    const validated = validatePublicAiEvents(ai, post);
    return { validated, outcome: selectPublicAiEventsForPersistence({ aiEvents: ai,
        validatedEvents: validated, aiRequired: true, aiCalled: true, post }) };
}

for (const text of ['MAY 16 [FRIDAY]', 'May 16 (Friday)', '16 May', 'May 16th, 2025', '16th May 2025', 'May\n16']) {
    test(`English date: ${JSON.stringify(text)}`, () => assert.deepEqual(dates(text), ['2025-05-16']));
}
test('full and abbreviated English month names use explicit years', () => {
    for (const [i, names] of ['January Jan', 'February Feb', 'March Mar', 'April Apr', 'May', 'June Jun', 'July Jul', 'August Aug', 'September Sept Sep', 'October Oct', 'November Nov', 'December Dec'].entries()) {
        for (const name of names.split(' ')) assert.deepEqual(dates(`${name} 16, 2027`), [`2027-${String(i + 1).padStart(2, '0')}-16`]);
    }
});
test('comma spacing preserves explicit English years and malformed years are not inferred', () => {
    assert.deepEqual(dates('May 16,2027'), ['2027-05-16']);
    assert.deepEqual(dates('16 May,2027'), ['2027-05-16']);
    assert.deepEqual(dates('May 16, 20270'), []);
    assert.deepEqual(dates('16 May 20270'), []);
});
test('year inference uses the source publication, never the current year for historical posts', () => {
    assert.deepEqual(dates('May 16'), ['2025-05-16']);
    assert.deepEqual(dates('January 2', Date.parse('2026-12-29T12:00:00Z') / 1000), ['2027-01-02']);
});
test('English ranges retain the future end and do not resolve as past-only', () => {
    for (const text of ['October 24–30, 2026', '24–30 October 2026']) {
        assert.deepEqual(dates(text), ['2026-10-24', '2026-10-30']);
        const [range] = extractEventDateRanges(text, publication);
        assert.equal(range.startDate, '2026-10-24');
        assert.equal(range.endDate, '2026-10-30');
        const response = { structure: 'single_event', structure_reason: 'Test', events: [{ date: '2026-10-24', title: 'Test event', venue: '' }] };
        assert.equal(replay(fixtures[0], { vision: fixtures[0].vision.replaceAll('May 16', text).replaceAll('MAY 16', text), response }).outcome.unresolved, true);
    }
});
for (const text of ['Mayday 16', 'XMay 16', 'May 160', 'May 16x', 'February 30, 2026', 'February 29, 2025', 'April 31, 2026', 'May 0', 'May 32', 'May 20-16', '20-16 May', 'version May 16', '19:00', '2026-05-16', 'Friday']) {
    test(`not a supported date: ${text}`, () => assert.deepEqual(dates(text), []));
}
test('valid leap day and Russian dates remain supported', () => {
    assert.deepEqual(dates('February 29, 2028'), ['2028-02-29']);
    assert.deepEqual(dates('16 мая 2025'), ['2025-05-16']);
});
test('Overlock archived response resolves as past-only without creating a card', () => {
    const { outcome } = replay(fixtures[0]);
    assert.equal(outcome.reason, 'all-supported-event-dates-are-past');
    assert.equal(outcome.unresolved, false);
    assert.deepEqual(outcome.events, []);
});
test('Divludi archived response resolves as confirmed poster without an event date', () => {
    assert.equal(replay(fixtures[1]).outcome.reason, 'confirmed-poster-has-no-event-date');
});
test('blank date values accept spaces, tabs, NBSP and CRLF without consuming the next field', () => {
    for (const blank of ['', ' ', '\t', '\u00a0', '  \t ']) {
        const vision = `[IMAGE 1]\r\nЭто афиша события: да\r\nДата:${blank}\r\nМесто: Rock Bar\r\n`;
        assert.equal(replay(fixtures[1], { vision }).outcome.reason, 'confirmed-poster-has-no-event-date');
    }
});
test('nonblank unrecognized date values remain unresolved', () => {
    for (const value of ['не удалось прочитать', '24/10/2026', 'TBA']) {
        assert.equal(replay(fixtures[1], { vision: `[IMAGE 1]\nЭто афиша события: да\nДата: ${value}\n` }).outcome.unresolved, true);
    }
});
test('a date in OCR or announcement prevents the no-date shortcut', () => {
    assert.equal(replay(fixtures[1], { body: 'Концерт 30 октября 2026 в баре' }).outcome.unresolved, true);
    assert.equal(replay(fixtures[1], { vision: `${fixtures[1].vision}\nOctober 30, 2026` }).outcome.unresolved, true);
});
test('future event without a venue remains unresolved with the exact validation reason', () => {
    const response = structuredClone(fixtures[0].response);
    response.events[0].date = '2027-05-16';
    const { validated, outcome } = replay(fixtures[0], { response, vision: fixtures[0].vision.replaceAll('May 16', 'May 16, 2027').replaceAll('MAY 16', 'MAY 16, 2027') });
    assert.equal(outcome.unresolved, true);
    assert.equal(outcome.validationFailures[0].reason, 'missing-venue');
    assert.equal(validated.aiValidationFailures[0].eventIndex, 0);
    assert.equal(JSON.stringify(validated), '[]');
});
test('strict text validation recognizes English date evidence but still requires a venue', () => {
    const event = { title: 'Test concert', eventDate: '2027-05-16', venue: 'Rock Bar' };
    assert.equal(explainStrictEventRecord(event, { sourceText: 'Концерт Test concert May 16, 2027 at Rock Bar' }).ok, true);
    assert.equal(explainStrictEventRecord({ ...event, venue: '' }).reason, 'missing-venue');
});
test('real fixture outcomes settle in one cycle while genuine uncertainty carries its cause', async () => {
    let calls = 0;
    const settled = await runManualParserPoolUntilSettled(fixtures, async (fixture) => {
        calls += 1; return replay(fixture).outcome;
    }, { maxRetryCycles: 2 });
    assert.equal(calls, 2);
    assert.ok(settled.every((item) => item.status === 'fulfilled' && !item.value.unresolved));
    const [failed] = await runManualParserPoolUntilSettled([1], async () => ({ unresolved: true,
        unresolvedReason: 'event-failed-validation', validationFailures: [{ reason: 'missing-venue' }] }), { maxRetryCycles: 1 });
    assert.equal(failed.status, 'rejected');
    assert.equal(failed.reason.code, 'MANUAL_PARSER_RETRY_EXHAUSTED');
    assert.match(failed.reason.message, /event-failed-validation; missing-venue/);
});
