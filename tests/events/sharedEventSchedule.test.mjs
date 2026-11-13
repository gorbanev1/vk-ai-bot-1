import test from 'node:test';
import assert from 'node:assert/strict';
import { readScheduleEvidence, validateSharedEventSchedule, getSharedEventSchedule, nextSharedEventDate, eventScheduleMatchesRange, sharedEventDateLabel } from '../../src/features/events/sharedEventSchedule.js';
import { buildEventCalendarIcs, buildGoogleCalendarUrl, buildOutlookCalendarUrl, eventCalendarAvailability } from '../../src/features/events/eventCalendar.js';
import { getEventDateEvidence, compareEventsDeterministic } from '../../src/features/events/eventDuplicateResolution.js';
import { validatePublicAiEvents, setPublicAiResponseMetadata } from '../../src/features/events/publicPostLocalParser.js';
const publishedAt = Date.parse('2026-09-28T12:00:00Z') / 1000;
const schedule = { dateMode: 'continuous', startDate: '2026-12-11', endDate: '2026-12-30', dates: [] };
const event = { title: 'Новогодние корпоративы', venue: 'Бар Понеслось', eventDate: schedule.startDate, structureDecision: 'shared_schedule_event', eventSchedule: schedule };
const fact = { index: 1, poster: true, dates: '11–30 декабря', recognizedText: 'Новогодние корпоративы. В Понеслось с 11 по 30 декабря. Праздничная программа и диджей.' };
const sourceText = 'Готовь сани летом! В программе: ведущий, Дед Мороз и DJ. Декабрьские даты уже можно бронировать.';
for (const raw of ['11–30 декабря', 'с 11 по 30 декабря', '11-30.12.2026', '11.12–30.12', '11.12.26 — 30.12.26', 'с 11 декабря по 30 декабря', 'с одиннадцатого по тридцатое декабря']) {
    test('range from Vision: ' + raw, () => {
        const result = readScheduleEvidence(raw, { publishedAt });
        assert.equal(result.dateMode, 'continuous'); assert.equal(result.startDate, schedule.startDate); assert.equal(result.endDate, schedule.endDate);
    });
}
test('Vision-only dates are validated with provenance', () => {
    const result = validateSharedEventSchedule(event, { sourceText, facts: [fact], publishedAt });
    assert.equal(result.ok, true); assert.equal(result.schedule.sourceDateEvidence.length, 2);
    assert.equal(result.schedule.sourceDateEvidence[1].source, 'poster_ocr');
    assert.equal(result.schedule.sourceDateEvidence[1].yearSource, 'published_at');
});
test('date field and OCR conflict is unresolved', () => assert.equal(validateSharedEventSchedule(event, { sourceText, facts: [{ ...fact, dates: '10–30 декабря' }], publishedAt }).ok, false));
test('source text conflict is unresolved', () => assert.equal(validateSharedEventSchedule(event, { sourceText: '10–30 декабря — DJ', facts: [fact], publishedAt }).ok, false));
test('generated event dates are never evidence', () => assert.equal(validateSharedEventSchedule(event, { sourceText, facts: [], publishedAt }).ok, false));
test('different posters cannot become a shared poster', () => assert.equal(validateSharedEventSchedule(event, { sourceText, facts: [fact, { ...fact, index: 2 }], publishedAt }).ok, false));
test('continuous card visible through last date', () => {
    for (const date of ['2026-12-11', '2026-12-28', '2026-12-30']) assert.equal(eventScheduleMatchesRange(event, date, date), true);
    assert.equal(eventScheduleMatchesRange(event, '2026-12-31', '2026-12-31'), false);
    assert.equal(nextSharedEventDate(event, '2026-12-28'), '2026-12-28');
    assert.equal(event.eventDate, '2026-12-11');
});
test('specific dates have gaps', () => {
    const parsed = readScheduleEvidence('11, 14 и 20 декабря', { publishedAt });
    const specific = { ...event, eventSchedule: parsed };
    assert.equal(parsed.dateMode, 'specific'); assert.deepEqual(parsed.dates, ['2026-12-11','2026-12-14','2026-12-20']);
    assert.equal(eventScheduleMatchesRange(specific,'2026-12-15','2026-12-19'), false);
    assert.equal(nextSharedEventDate(specific,'2026-12-15'), '2026-12-20');
});
test('permanent date blocks stay excluded', () => {
    const blocked = { ...event, eventSchedule: { ...schedule, excludedDates: ['2026-12-28','2026-12-29'] } };
    assert.equal(eventScheduleMatchesRange(blocked,'2026-12-28','2026-12-29'), false);
    assert.equal(nextSharedEventDate(blocked,'2026-12-28'), '2026-12-30');
    assert.match(sharedEventDateLabel(blocked), /кроме/);
});
test('calendar needs a visit date, never auto-selects first day', () => {
    assert.equal(eventCalendarAvailability(event),false); assert.equal(buildEventCalendarIcs(event),null);
    assert.equal(buildGoogleCalendarUrl(event),''); assert.equal(buildOutlookCalendarUrl(event),'');
    assert.equal(eventCalendarAvailability({eventDate:'2026-12-11'}),true);
});
test('shared range is not merged with a single evening', () => {
    assert.equal(getEventDateEvidence(event).end, '2026-12-30');
    assert.equal(compareEventsDeterministic(event, { ...event, structureDecision: 'single_event' }).verdict, 'different');
});
test('explicit shared AI contract creates one durable card from Vision', () => {
    const raw = setPublicAiResponseMetadata([{ date: '2026-12-11', title: event.title, venue: event.venue, schedule,
        _structure:'shared_schedule_event', image_indexes:[1], evidence:'с 11 по 30 декабря' }], { structure:'shared_schedule_event',valid:true });
    const facts = '[IMAGE 1]\nЭто афиша события: да\nТип изображения: poster\nДата: 11–30 декабря\nРаспознанный текст: '+fact.recognizedText;
    const cards = validatePublicAiEvents(raw, { text: sourceText+'\n'+facts, __sourceAnnouncementText:sourceText,
        __dateFreeVisionPhase:true, __posterGateFacts:facts, publishedAt });
    assert.equal(cards.aiResponseValid,true,cards.aiResponseError); assert.equal(cards.length,1);
    assert.ok(getSharedEventSchedule(cards[0])); assert.equal(cards[0].sourceSegment,sourceText);
});
test('ordinary monthly schedules retain independent dates', () => {
    const cards = setPublicAiResponseMetadata([
        { date:'2026-12-11',title:'Группа Альфа',venue:'Бар',evidence:'11 декабря',_structure:'multiple_events' },
        { date:'2026-12-20',title:'Группа Бета',venue:'Бар',evidence:'20 декабря',_structure:'multiple_events' },
    ], {structure:'multiple_events',valid:true});
    const result = validatePublicAiEvents(cards,{text:'11 декабря — концерт Группа Альфа, Бар.\n20 декабря — концерт Группа Бета, Бар.',publishedAt});
    assert.equal(result.length,2); assert.ok(result.every(e=>!getSharedEventSchedule(e)));
});

test('a mixed poster is not collapsed even when all dates fall inside the range', () => {
 const mixed = {...fact, recognizedText:'11–30 декабря — DJ и танцы\n20 декабря — отдельный концерт группы Бета'};
 assert.equal(validateSharedEventSchedule(event, {sourceText,facts:[mixed],publishedAt}).ok,false);
});
