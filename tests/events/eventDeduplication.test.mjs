import assert from 'node:assert/strict';

import {
    compareEventsForDuplicate,
    deduplicateUpcomingEvents,
} from '../../src/features/events/eventDeduplication.js';

const insightOne = {
    id: 101,
    sourceType: 'vk_chat',
    sourceName: 'Беседа 1',
    sourceUrl: '',
    title: 'Инсайт Дэнс на Петровской набережной',
    eventDate: '2026-08-09',
    eventTime: '18:00',
    venue: 'Петровская набережная, пирс',
    participants: 'Елена Кобылтян, Insight Dance',
    price: 'Вход свободный',
    description:
        'Встреча проекта Инсайт Дэнс со спонтанным танцем на пирсе у воды. ' +
        '9 августа встречаемся на Петровской набережной, чтобы снова танцевать вместе.',
    imagePaths: ['insight-one.png'],
};

const insightTwo = {
    id: 102,
    sourceType: 'vk_chat',
    sourceName: 'Беседа 1',
    sourceUrl: '',
    title: 'Инсайт Дэнс на Петровской набережной',
    eventDate: '2026-08-09',
    eventTime: '18:00',
    venue: 'Петровская набережная, пирс',
    participants: 'проект Инсайт Дэнс',
    price: 'Вход свободный',
    description:
        'Встреча со спонтанным танцем у воды на Петровской набережной. ' +
        '9 августа встречаемся на Петровской набережной, чтобы снова танцевать вместе.',
    imagePaths: ['insight-two.png'],
};

const mausoleumSourceHeading = {
    id: 201,
    sourceType: 'vk',
    sourceName: 'rb_diesel',
    sourceUrl: 'https://vk.com/wall-227678037_46',
    title: 'Rock Bar DIESEL & DIESEL Hall',
    eventDate: '2026-08-28',
    eventTime: '19:00',
    venue: '',
    participants: '',
    price: '',
    description:
        'Панк-хардкор состав MAUSOLEUM на всех порах мчится в Воронеж, ' +
        'обещая костедробительное шоу и зубовышибательный мош! ' +
        'При поддержке: diZbadiX, Колхозная Самодеятельность. Двери: 19:00.',
    imagePaths: ['mausoleum-one.png'],
};

const mausoleumNamed = {
    id: 202,
    sourceType: 'vk',
    sourceName: 'rb_diesel',
    sourceUrl: 'https://vk.com/wall-117292629_13533',
    title: 'MAUSOLEUM — Воронеж',
    eventDate: '2026-08-28',
    eventTime: '19:00',
    venue: '',
    participants: '',
    price: '',
    description:
        '28 августа — MAUSOLEUM — Воронеж. Панк-хардкор состав MAUSOLEUM ' +
        'на всех порах мчится в Воронеж, обещая костедробительное шоу и ' +
        'зубовышибательный мош в честь 20-летия альбома. ' +
        'При поддержке: diZbadiX, Колхозная Самодеятельность. Двери: 19:00.',
    imagePaths: ['mausoleum-two.png'],
};

const dieselHall = {
    id: 301,
    sourceType: 'telegram',
    sourceName: '@kurazhcity',
    sourceUrl: 'https://t.me/kurazhcity/3914',
    title: 'mrmraum, noisebleedsuns., NGO, autodafe',
    eventDate: '2026-08-01',
    eventTime: '18:30',
    venue: 'Diesel Hall',
    participants: 'mrmraum, noisebleedsuns., NGO, autodafe',
    description: 'Шуморок-концерт с группами mrmraum, noisebleedsuns, NGO и autodafe.',
};

const dieselBar = {
    id: 302,
    sourceType: 'telegram',
    sourceName: '@kurazhcity',
    sourceUrl: 'https://t.me/kurazhcity/3918',
    title: 'E.V.A., грех!, Королевский Саботаж',
    eventDate: '2026-08-01',
    eventTime: '19:00',
    venue: 'Diesel Bar',
    participants: 'E.V.A., грех!, Королевский Саботаж',
    description: 'Выступление E.V.A., группы грех! и Королевского Саботажа.',
};

assert.equal(
    compareEventsForDuplicate(insightOne, insightTwo).duplicate,
    true,
    'почти одинаковые записи из беседы должны объединяться',
);

assert.equal(
    compareEventsForDuplicate(mausoleumSourceHeading, mausoleumNamed).duplicate,
    true,
    'один анонс с разными заголовками должен объединяться по описанию',
);

assert.equal(
    compareEventsForDuplicate(dieselHall, dieselBar).duplicate,
    false,
    'разные мероприятия в один день и почти в одно время нельзя объединять',
);


const samePostDifferentEvent = {
    ...dieselBar,
    id: 303,
    sourceUrl: dieselHall.sourceUrl,
};
assert.equal(
    compareEventsForDuplicate(dieselHall, samePostDifferentEvent).duplicate,
    false,
    'одна ссылка на пост не должна склеивать разные события без смыслового совпадения',
);

const result = deduplicateUpcomingEvents([
    insightOne,
    insightTwo,
    mausoleumSourceHeading,
    mausoleumNamed,
    dieselHall,
    dieselBar,
]);

assert.equal(result.inputCount, 6);
assert.equal(result.outputCount, 4);
assert.equal(result.mergedCount, 2);

const insight = result.events.find((event) => (
    event.title === 'Инсайт Дэнс на Петровской набережной'
));
assert.ok(insight);
assert.equal(insight.duplicateCount, 2);
assert.deepEqual(
    insight.imagePaths.sort(),
    ['insight-one.png', 'insight-two.png'],
);
assert.match(insight.participants, /Елена Кобылтян/u);
assert.match(insight.participants, /Инсайт Дэнс/iu);

const mausoleum = result.events.find((event) => (
    event.title === 'MAUSOLEUM — Воронеж'
));
assert.ok(mausoleum, 'должен выбираться содержательный заголовок события');
assert.equal(mausoleum.duplicateCount, 2);
assert.equal(mausoleum.mergedSources.length, 2);
assert.equal(mausoleum.imagePaths.length, 2);

const differentDate = {
    ...insightTwo,
    id: 103,
    eventDate: '2026-08-10',
};
assert.equal(
    compareEventsForDuplicate(insightOne, differentDate).duplicate,
    false,
    'разные даты никогда не объединяются',
);

console.log('eventDeduplication tests: OK');

const actualMausoleumPublic = {
    id: 401,
    sourceType: 'vk',
    sourceName: 'rb_diesel',
    sourceUrl: 'https://vk.com/wall-117292629_13533',
    title: 'MAUSOLEUM — Воронеж',
    eventDate: '2026-08-28',
    eventTime: '19:00',
    venue: '',
    participants: '',
    price: '',
    description:
        'Действия\nВ АВГУСТЕ - 28 августа — MAUSOLEUM — Воронеж\n' +
        'Панк-хардкор состав MAUSOLEUM на всех порах мчится в Воронеж, ' +
        'обещая костедробительное шоу и зубовышибательный мош в честь ' +
        '20-летия альбома. При поддержке: diZbadiX\n' +
        'Колхозная Самодеятельность\nДвери: 19:00\nБилеты: vk.cc/cZ34cW',
};

const actualMausoleumCrosspost = {
    id: 402,
    sourceType: 'vk',
    sourceName: 'rb_diesel',
    sourceUrl: 'https://vk.com/wall-227678037_46',
    title: 'Rock Bar DIESEL & DIESEL Hall',
    eventDate: '2026-08-28',
    eventTime: '19:00',
    venue: '',
    participants: '',
    price: '',
    description:
        'и ещё 4 автора Действия Панк-хардкор состав MAUSOLEUM на всех ' +
        'порах мчится в Воронеж, обещая костедробительное шоу и ' +
        'зубовышибательный мош! При поддержке: diZbadiX ' +
        'Колхозная Самодеятельность\nДвери: 19:00\nБилеты: vk.cc/cZ34cW',
};

const actualMausoleumChat = {
    ...actualMausoleumPublic,
    id: 403,
    sourceType: 'vk_chat',
    sourceName: 'Беседа 2000000022',
    sourceUrl: '',
    title: 'Панк-хардкор MAUSOLEUM',
};

const actualComparison = compareEventsForDuplicate(
    actualMausoleumPublic,
    actualMausoleumCrosspost,
);
assert.equal(
    actualComparison.duplicate,
    true,
    'реальные кросспосты MAUSOLEUM должны объединяться независимо от источника',
);
assert.ok(
    actualComparison.reasons.includes('shared-content-link') ||
        actualComparison.reasons.includes('description'),
    'совпадение должно подтверждаться общей билетной ссылкой или содержанием',
);

const crossSourceResult = deduplicateUpcomingEvents([
    actualMausoleumChat,
    actualMausoleumCrosspost,
    actualMausoleumPublic,
]);
assert.equal(crossSourceResult.outputCount, 1);
assert.equal(crossSourceResult.events[0].duplicateCount, 3);
assert.equal(
    crossSourceResult.events[0].sourceType,
    'vk',
    'публичный источник должен быть основным вместо беседы',
);
assert.match(
    crossSourceResult.events[0].sourceUrl,
    /^https:\/\/vk\.com\/wall/u,
);

console.log('eventDeduplication cross-source tests: OK');
