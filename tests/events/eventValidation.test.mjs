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


const pastPrompt = buildStrictEventExtractionPrompt({
    sourceKind: 'ручной страницы',
    referenceDate: '2026-07-29',
    allowPast: true,
});
assert.match(pastPrompt, /прошедшие события/u);
assert.match(pastPrompt, /символами \|\|/u);

console.log('eventValidation tests: OK');
