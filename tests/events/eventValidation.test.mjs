import assert from 'node:assert/strict';

import {
    buildStrictEventExtractionPrompt,
    isStrictEventRecord,
    partitionEventsByReferenceDate,
    sourceContainsEvidence,
    sourceSupportsVenue,
} from '../../src/features/events/eventValidation.js';
import {
    looksLikeVkChatEventCandidate,
} from '../../src/features/events/eventCandidateRouting.js';
import {
    validatePublicAiEvents,
    selectPublicAiEventsForPersistence,
    setPublicAiResponseMetadata,
} from '../../src/features/events/publicPostLocalParser.js';

const valid = {
    title: 'Концерт группы «Шум»',
    eventDate: '2099-08-22',
    eventTime: '20:00',
    venue: 'Клуб «Дизель», Воронеж',
    description: 'Концерт состоится 22 августа в клубе «Дизель».',
    evidence: '22 августа концерт в клубе «Дизель»',
};

assert.equal(isStrictEventRecord(valid), true);
assert.equal(isStrictEventRecord({ ...valid, venue: '' }), false);

assert.equal(isStrictEventRecord({
    ...valid,
    venue: '',
}, {
    requireVenue: false,
}), true);
const ownerPrompt = buildStrictEventExtractionPrompt({
    sourceKind: 'ручного сообщения владельца',
    referenceDate: '2099-08-01',
    allowPast: true,
    requireVenue: false,
});
assert.match(ownerPrompt, /место.*может отсутствовать/iu);

assert.equal(isStrictEventRecord({ ...valid, title: 'T' }), false);
assert.equal(isStrictEventRecord({
    ...valid,
    description: 'Нельзя однозначно определить, является ли это мероприятием.',
}), false);
assert.equal(isStrictEventRecord({
    title: 'Александр Дэ',
    eventDate: '2099-08-22',
    eventTime: '16:20',
    venue: '',
    description: 'Указано только время сообщения.',
}), false);
assert.equal(isStrictEventRecord({
    title: 'Предпродажа футболок',
    eventDate: '2099-08-22',
    venue: 'Интернет-магазин',
    description: 'Предпродажа заканчивается в четверг.',
}), false);


assert.equal(sourceContainsEvidence(
    'DIRTY PARTY 3 || Дата: 26.07 || Rock Bar DIESEL',
    `DIRTY PARTY 3
Дата: 26.07
Rock Bar DIESEL`,
), true);
assert.equal(sourceContainsEvidence(
    'DIRTY PARTY 3 || Дата: 26.07 || Другой бар',
    `DIRTY PARTY 3
Дата: 26.07
Rock Bar DIESEL`,
), false);
assert.equal(sourceContainsEvidence('Концерт … 24 октября', 'Концерт группы состоится 24 октября'), true);
assert.equal(sourceContainsEvidence('24 октября … Концерт', 'Концерт группы состоится 24 октября'), false);
assert.equal(sourceContainsEvidence('Концерт … 25 октября', 'Концерт группы состоится 24 октября'), false);
assert.equal(sourceContainsEvidence('Концерт … 24 октября', 'Концерт группы состоится 24 ноября, затем в октябре'), false);


const dirtyPartySource = `Спустя два месяца томного молчания и попыток вести себя прилично наконец пришло время снова поднять пыль, ведь заключительная часть трилогии гигосов DIRTY PARTY уже на горизонте!
26 июля на сцене Rock Bar DIESEL будут греметь Downbreakers и другие группы.
Rock Bar DIESEL
Дата: 26.07
Время: 18:00`;
const dirtyPartyEvent = {
    title: 'DIRTY PARTY 3 — концерт',
    eventDate: '2026-07-26',
    eventTime: '18:00',
    venue: 'Rock Bar DIESEL',
    description: 'Заключительная часть концертной трилогии DIRTY PARTY.',
    evidence: 'DIRTY PARTY уже на горизонте || 26 июля на сцене Rock Bar DIESEL || Дата: 26.07',
};
assert.equal(isStrictEventRecord(dirtyPartyEvent, {
    sourceText: dirtyPartySource,
    requireEvidence: true,
}), true);
const dirtyPartition = partitionEventsByReferenceDate(
    [dirtyPartyEvent, { ...dirtyPartyEvent, eventDate: '2026-08-26' }],
    '2026-07-29',
);
assert.equal(dirtyPartition.pastEvents.length, 1);
assert.equal(dirtyPartition.futureEvents.length, 1);

assert.equal(sourceSupportsVenue('Клуб «Дизель», Воронеж', '22 августа концерт в клубе Дизель'), true);
assert.equal(sourceSupportsVenue('Клуб «Дизель», Воронеж', '22 августа концерт в клубе Хлам'), false);
assert.equal(isStrictEventRecord(valid, {
    sourceText: '22 августа концерт группы «Шум» в клубе «Дизель», Воронеж',
}), true);
assert.equal(isStrictEventRecord(valid, {
    sourceText: '22 августа концерт группы «Шум» в клубе «Хлам», Москва',
}), false);


assert.equal(
    looksLikeVkChatEventCandidate({ text: 'Александр Дэ 14:16' }),
    false,
);
assert.equal(
    looksLikeVkChatEventCandidate({ text: '16:16' }),
    false,
);
assert.equal(
    looksLikeVkChatEventCandidate({
        text: '22 августа концерт группы Шум в 20:00',
    }),
    true,
);
assert.equal(
    looksLikeVkChatEventCandidate({
        text: '14 сентября, Liverpool, 20:00, 500₽',
    }),
    true,
);

const prompt = buildStrictEventExtractionPrompt({
    sourceKind: 'теста',
    referenceDate: '2099-08-01',
});
assert.match(prompt, /суть события/u);
assert.match(prompt, /календарная дата/u);
assert.match(prompt, /конкретное место/u);
assert.match(prompt, /пустой список/u);
assert.match(prompt, /participants.*выступающих/u);
assert.match(prompt, /DJs/u);
assert.match(prompt, /price.*стоимость/u);
assert.match(prompt, /обязательный AI-этап/u);
assert.match(prompt, /одно событие, программу одного события или несколько самостоятельных событий/u);
assert.match(prompt, /концерт и отдельная ночная дискотека/u);
assert.match(prompt, /Время между разными постами\/сообщениями не участвует/u);
assert.match(prompt, /дата.*подтверждается точками/u);
assert.match(prompt, /несколько дат.*сами по себе.*НЕ доказывают/u);
assert.doesNotMatch(prompt, /каждая различающаяся календарная дата.*отдельная карточка/u);

const typoSource = 'В посте была ошибка: сначала указали 24 октября. Исправление: концерт 26 октября в The Last of Vavilone.';
const localSplit = [
    { title: 'Концерт', eventDate: '2026-10-24' },
    { title: 'Концерт', eventDate: '2026-10-26' },
];
const aiSingle = setPublicAiResponseMetadata([{
    _structure: 'single_event',
    _structureReason: 'Первая дата прямо исправлена следующей фразой.',
    date: '2026-10-26',
    time: null,
    title: 'Концерт',
    venue: 'The Last of Vavilone',
    announcement: 'Концерт состоится 26 октября в The Last of Vavilone.',
    source_segment: 'концерт 26 октября в The Last of Vavilone',
    evidence: 'Исправление: концерт 26 октября в The Last of Vavilone.',
}], { structure: 'single_event', reason: 'Первая дата исправлена.', valid: true });
const validatedSingle = validatePublicAiEvents(aiSingle, { text: typoSource, publishedAt: 0 });
assert.equal(validatedSingle.aiResponseValid, true);
assert.equal(validatedSingle.length, 1);
assert.equal(validatedSingle[0].eventDate, '2026-10-26');
const selectedSingle = selectPublicAiEventsForPersistence({
    localEvents: localSplit,
    aiEvents: aiSingle,
    validatedEvents: validatedSingle,
    aiRequired: true,
    aiCalled: true,
});
assert.equal(selectedSingle.unresolved, false);
assert.equal(selectedSingle.events.length, 1);
assert.equal(selectedSingle.events[0].eventDate, '2026-10-26');

const pastSingle = setPublicAiResponseMetadata([{
    _structure: 'single_event',
    date: '2025-04-24',
    time: '21:30',
    title: 'Родион Дьяков',
    venue: 'Бар',
    participants: 'Родион Дьяков',
    evidence: '24 апреля, четверг',
}], { structure: 'single_event', valid: true });
const pastOnly = selectPublicAiEventsForPersistence({
    aiEvents: pastSingle,
    validatedEvents: [],
    aiRequired: true,
    aiCalled: true,
    post: {
        text: 'Сегодня у нас выступает Родион Дьяков. 24 апреля, четверг',
        publishedAt: Math.floor(new Date('2025-04-24T10:00:00Z').getTime() / 1000),
        referenceNow: new Date('2026-10-19T12:00:00Z'),
    },
    timeZone: 'Europe/Moscow',
});
assert.equal(pastOnly.resolved, true);
assert.equal(pastOnly.unresolved, false);
assert.equal(pastOnly.pastOnly, true);
assert.equal(pastOnly.reason, 'all-supported-event-dates-are-past');

const mixedPastAndFuture = selectPublicAiEventsForPersistence({
    aiEvents: setPublicAiResponseMetadata([
        { date: '2025-04-24' },
        { date: '2026-10-24' },
    ], { structure: 'multiple_events', valid: true }),
    aiRequired: true,
    aiCalled: true,
    post: {
        text: '24 апреля 2025 концерт. 24 октября 2026 концерт.',
        publishedAt: 0,
        referenceNow: new Date('2026-10-19T12:00:00Z'),
    },
});
assert.equal(mixedPastAndFuture.unresolved, true);
assert.equal(mixedPastAndFuture.pastOnly, undefined);

const unsupportedPastDate = selectPublicAiEventsForPersistence({
    aiEvents: pastSingle,
    aiRequired: true,
    aiCalled: true,
    post: {
        text: 'Сегодня у нас выступает Родион Дьяков.',
        publishedAt: Math.floor(new Date('2025-04-24T10:00:00Z').getTime() / 1000),
        referenceNow: new Date('2026-10-19T12:00:00Z'),
    },
});
assert.equal(unsupportedPastDate.unresolved, true);

const pastEventFromPosterFacts = selectPublicAiEventsForPersistence({
    aiEvents: pastSingle,
    aiRequired: true,
    aiCalled: true,
    post: {
        text: 'Сегодня у нас выступает Родион Дьяков. Открываем двери в 19:00, а с 21:30 начнем программу.\n[Факты с афиши]\nДата: 24 апреля, четверг; год не указан\nРаспознанный текст: четверг • 24 апреля',
        publishedAt: Math.floor(new Date('2025-04-24T10:00:00Z').getTime() / 1000),
        referenceNow: new Date('2026-10-19T12:00:00Z'),
    },
});
assert.equal(pastEventFromPosterFacts.resolved, true);
assert.equal(pastEventFromPosterFacts.unresolved, false);
assert.equal(pastEventFromPosterFacts.pastOnly, true);

const bookingEvents = setPublicAiResponseMetadata(
    Array.from({ length: 13 }, (_, index) => ({
        date: `2026-12-${String(18 + index).padStart(2, '0')}`,
        venue: 'Коптильня (еда и музыка)',
        price: 'от 4000 ₽',
    })),
    { structure: 'multiple_events', valid: true },
);
const bookingOffer = selectPublicAiEventsForPersistence({
    aiEvents: bookingEvents,
    aiRequired: true,
    aiCalled: true,
    post: {
        text: 'Открываем бронирование на новогодние корпоративы. 18–30 декабря. От 4000 ₽. Праздничная программа.',
        publishedAt: Math.floor(new Date('2026-10-19T10:00:00Z').getTime() / 1000),
        referenceNow: new Date('2026-10-19T12:00:00Z'),
    },
});
assert.equal(bookingOffer.resolved, true);
assert.equal(bookingOffer.unresolved, false);
assert.equal(bookingOffer.notEvent, true);
assert.equal(bookingOffer.reason, 'booking-window-offer-not-a-dated-event');

const emptyBookingRangeResponse = selectPublicAiEventsForPersistence({
    aiEvents: setPublicAiResponseMetadata([], {
        structure: 'multiple_events',
        reason: 'Даты корпоративов указаны диапазоном; отдельных мероприятий не названо.',
        valid: true,
    }),
    validatedEvents: setPublicAiResponseMetadata([], {
        structure: 'multiple_events',
        reason: 'Даты корпоративов указаны диапазоном; отдельных мероприятий не названо.',
        valid: false,
        error: 'structure-event-count-mismatch',
    }),
    aiRequired: true,
    aiCalled: true,
    post: {
        text: 'КОПТИЛЬНЯ. Открываем бронирование на новогодние корпоративы. 18–30 декабря.',
        publishedAt: Math.floor(new Date('2026-09-25T10:00:00Z').getTime() / 1000),
        referenceNow: new Date('2026-10-19T12:00:00Z'),
    },
});
assert.equal(emptyBookingRangeResponse.resolved, true);
assert.equal(emptyBookingRangeResponse.unresolved, false);
assert.equal(emptyBookingRangeResponse.notEvent, true);
assert.equal(emptyBookingRangeResponse.reason, 'booking-window-offer-not-a-dated-event');

const missingDatePoster = selectPublicAiEventsForPersistence({
    aiEvents: setPublicAiResponseMetadata([], {
        structure: 'uncertain', reason: 'на афише нет календарной даты', valid: true,
    }),
    aiRequired: true,
    aiCalled: true,
    post: {
        text: 'party bar & jigger house \"ХЛАМ\"',
        __dateFreeVisionPhase: true,
        __posterGateFacts: '[IMAGE 1]\nЭто афиша события: да\nТип изображения: poster\nНазвание: ХДМ\nДата:\nВремя:\nМесто:',
        publishedAt: 0,
        referenceNow: new Date('2026-10-19T12:00:00Z'),
    },
});
assert.equal(missingDatePoster.resolved, true);
assert.equal(missingDatePoster.unresolved, false);
assert.equal(missingDatePoster.reason, 'confirmed-poster-has-no-event-date');

const undatedAnnouncementOffer = selectPublicAiEventsForPersistence({
    aiEvents: setPublicAiResponseMetadata([], {
        structure: 'uncertain', reason: 'no event date', valid: true,
    }),
    aiRequired: true,
    aiCalled: true,
    post: { text: 'Анонс мероприятия без даты и афиши.' },
});
assert.equal(undatedAnnouncementOffer.unresolved, true);

// A poster-only calendar date is valid only when it is carried in the
// explicit Vision facts block; publication timestamps still never become
// event dates.
const posterRescueSource = [
    'Впервые в Воронеже! Кавер-трибьют проект «RammPage» приглашает на Rammstein-шоу.',
    '[Факты с афиши]',
    'Название: RammPage',
    'Дата: 24 октября',
    'Место: DIESEL HALL',
    'Город: Воронеж',
    'Адрес: ул. Генерала Лизюкова, 8',
].join('\n');
const posterRescue = setPublicAiResponseMetadata([{
    date: '2026-10-24', time: '19:00', title: 'RammPage',
    venue: 'DIESEL HALL, Воронеж, ул. Генерала Лизюкова, 8', participants: 'RammPage',
    description: 'Концерт-трибьют Rammstein-шоу.',
    announcement: '24 октября состоится концерт-трибьют Rammstein-шоу проекта RammPage.',
    evidence: 'проект RammPage ... приглашает на Rammstein-шоу || 24 ОКТЯБРЯ || DIESEL HALL',
}], { structure: 'single_event', valid: true });
const validatedPosterRescue = validatePublicAiEvents(posterRescue, {
    text: posterRescueSource, publishedAt: 0, referenceNow: new Date('2026-10-09T00:00:00Z'),
});
assert.equal(validatedPosterRescue.aiResponseValid, true);
assert.equal(validatedPosterRescue.length, 1);
assert.equal(validatedPosterRescue[0].eventDate, '2026-10-24');

// Vision-enriched posters may provide the only date and AI may shorten a long
// exact quote with an ellipsis. Ordered fragments still constitute source
// evidence and must not leave the event unresolved.
const posterOnlyDateSource = [
    'Команда музыкантов приглашает на свое уникальное Rammstein-шоу.',
    '[Факты с афиши]',
    '[IMAGE 1]',
    'Название: RammPage',
    'Дата: 24 октября',
    'Место: DIESEL HALL',
].join('\n');
const posterOnlyDateEvents = setPublicAiResponseMetadata([{
    _structure: 'single_event',
    date: '2026-10-24',
    time: '19:00',
    title: 'RammPage',
    venue: 'DIESEL HALL, Воронеж',
    participants: 'RammPage',
    announcement: '24 октября концерт-трибьют RammPage в DIESEL HALL.',
    evidence: 'Команда музыкантов ... приглашает на свое уникальное Rammstein-шоу || «24 октября» || «DIESEL HALL»',
}], { structure: 'single_event', reason: 'poster supplied date', valid: true });
const validatedPosterOnlyDate = validatePublicAiEvents(posterOnlyDateEvents, {
    text: posterOnlyDateSource,
    publishedAt: 0,
});
assert.equal(validatedPosterOnlyDate.aiResponseValid, true);
assert.equal(validatedPosterOnlyDate.length, 1);
assert.equal(validatedPosterOnlyDate[0].eventDate, '2026-10-24');

const phaseTwoPosterEvents = setPublicAiResponseMetadata([{
    _structure: 'single_event',
    date: '2026-11-07',
    time: '19:00',
    title: 'Живи',
    venue: 'паб «Мама Анархия»',
    participants: 'Космодемьянский',
    announcement: 'Творческий вечер Космодемьянского.',
    evidence: '7 НОЯБРЯ 2026 || ПАБ МАМА АНАРХИЯ',
}], { structure: 'single_event', valid: true });
const phaseTwoSourceText = 'Билеты: voronezh.qtickets.events/258468-yuriy-kosmodemyanskiy';
const validatedPhaseTwoPoster = validatePublicAiEvents(phaseTwoPosterEvents, {
    text: [
        '[IMAGE 1]',
        'Это афиша события: да',
        'Название: Живи',
        'Дата: 7 ноября 2026',
        'Место: паб «Мама Анархия»',
        'Город: Воронеж',
        'Адрес: Платонова, 25',
    ].join('\n'),
    __dateFreeVisionPhase: true,
    referenceNow: new Date('2026-10-13T12:00:00Z'),
    publishedAt: 0,
});
assert.equal(validatedPhaseTwoPoster.aiResponseValid, true);
assert.equal(validatedPhaseTwoPoster.length, 1);
assert.equal(validatedPhaseTwoPoster[0].description, 'Творческий вечер Космодемьянского.');
assert.equal(validatedPhaseTwoPoster[0].sourceSegment, '');

const validatedRegularPhasePoster = validatePublicAiEvents(phaseTwoPosterEvents, {
    text: '[IMAGE 1]\nДата: 7 ноября 2026\nМесто: паб «Мама Анархия»',
    publishedAt: 0,
});
assert.equal(validatedRegularPhasePoster.aiResponseValid, true);
const mismatchedEvidenceEvents = setPublicAiResponseMetadata([{
    ...phaseTwoPosterEvents[0],
    evidence: 'Случайный текст без совпадений',
}], { structure: 'single_event', valid: true });
const rejectedRegularEvidence = validatePublicAiEvents(mismatchedEvidenceEvents, {
    text: '[IMAGE 1]\nДата: 7 ноября 2026\nМесто: паб «Мама Анархия»',
    publishedAt: 0,
});
assert.equal(rejectedRegularEvidence.aiResponseValid, false);

const validatedPhaseTwoImageOnly = validatePublicAiEvents(phaseTwoPosterEvents, {
    text: '[IMAGE 1]\nЭто афиша события: да\nДата: 7 ноября 2026\nМесто: паб «Мама Анархия»',
    __dateFreeVisionPhase: true,
    __sourceAnnouncementText: '',
    referenceNow: new Date('2026-10-13T12:00:00Z'),
    publishedAt: 0,
});
assert.equal(validatedPhaseTwoImageOnly.aiResponseValid, true);
assert.equal(validatedPhaseTwoImageOnly.length, 1);
assert.equal(validatedPhaseTwoImageOnly[0].description, 'Творческий вечер Космодемьянского.');

const invalidMulti = setPublicAiResponseMetadata([
    { date: '2026-10-24', title: 'Концерт', venue: 'The Last of Vavilone', evidence: 'ошибка была 24 октября' },
    { date: '2026-10-26', title: 'Концерт', venue: 'The Last of Vavilone', evidence: 'концерт 26 октября в The Last of Vavilone' },
], { structure: 'multiple_events', reason: 'two dates', valid: true });
const rejectedMulti = validatePublicAiEvents(invalidMulti, { text: typoSource, publishedAt: 0 });
assert.equal(rejectedMulti.aiResponseValid, false);
const unresolvedMulti = selectPublicAiEventsForPersistence({
    localEvents: localSplit,
    aiEvents: invalidMulti,
    validatedEvents: rejectedMulti,
    aiRequired: true,
    aiCalled: true,
});
assert.equal(unresolvedMulti.unresolved, true);
assert.deepEqual(unresolvedMulti.events, []);

const unanswered = selectPublicAiEventsForPersistence({ localEvents: localSplit, aiRequired: true, aiCalled: false });
assert.equal(unanswered.unresolved, true);
assert.deepEqual(unanswered.events, []);

// An unresolved one-date/multiple-time decision must not silently fall back to
// a local card. The source remains available for a later AI repair pass.
assert.deepEqual(validatePublicAiEvents([
    {
        _structure: 'uncertain',
        date: '2099-08-22',
        time: '18:00',
        title: 'Концерт и afterparty',
        venue: 'Клуб «Дизель»',
        announcement: '22.08 концерт и afterparty в клубе «Дизель»',
        source_segment: '22.08 концерт и afterparty в клубе «Дизель»',
        evidence: '22.08 концерт и afterparty в клубе «Дизель»',
    },
], {
    text: '22.08 концерт и afterparty в клубе «Дизель»',
    publishedAt: 0,
}), []);


const pastPrompt = buildStrictEventExtractionPrompt({
    sourceKind: 'ручной страницы',
    referenceDate: '2026-07-29',
    allowPast: true,
});
assert.match(pastPrompt, /прошедшие события/u);
assert.match(pastPrompt, /символами \|\|/u);

console.log('eventValidation tests: OK');
