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
