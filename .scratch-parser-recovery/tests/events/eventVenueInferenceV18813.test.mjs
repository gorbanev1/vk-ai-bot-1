import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    collectVenueContextCandidates,
    inferEventVenueFromText,
    knownVenueCatalog,
} from '../../src/features/events/eventVenueInference.js';
import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const appSource = readFileSync(
    new URL('../../src/app/botApplication.js', import.meta.url),
    'utf8',
);

const vavilonePost = [
    '11.09 НОЧНАЯ СМЕНА gothic party',
    '',
    'Соскучились по упырятникам? Точим клыки, прокачиваем мётлы GPRS навигатором,',
    'совершенствуем проклятья через AI... Ну а с нас вечная и не подверженная влиянию',
    'времени музыка. Никакой имитации, только трушная готика. Отпрашиваемся с работы,',
    'ломимся с пар, и запасаемся солнцезащитными плащами чтобы встретить утро',
    'в Тупике (Пр-т Революции 31а, Воронеж).',
    'Зажгём мини-маркетом (KILL ZOO, 4U, Фарфоровый Кролик, GRAVE GENERATION) в 18:00',
    '',
    'BAVARSKY ZAGON',
    'post-punk, gothic-rock, shoegaze',
    '',
    'SCELERA (Бельмо)',
    'deathrock, dark-punk',
].join('\n');

test('V188.13 hard-coded venue catalog recognizes requested clubs/bars and inflections', () => {
    const cases = [
        ['в Тупике', 'Тупик'],
        ['туса в Сто Ручьёв', 'Сто Ручьёв'],
        ['встретимся у Ста Ручьях, потом концерт', 'Сто Ручьёв'],
        ['ночь в The Last of Vavilone', 'The Last of Vavilone'],
        ['концерт в Дизель холле', 'DIESEL HALL'],
        ['вечеринка в diesel bar', 'Rock Bar DIESEL'],
        ['танцы в Оверлоке', 'Overlock Bar'],
        ['играем в мит боулинге', 'Meet Bowling'],
        ['концерт в Маме Анархии', 'Паб Мама Анархия'],
        ['14 сентября в Liverpool Bar', 'Liverpool Pub'],
        ['14 сентября в Ливерпуль бар', 'Liverpool Pub'],
        ['вечером в бар Ливерпуль', 'Liverpool Pub'],
    ];

    for (const [text, expected] of cases) {
        assert.equal(inferEventVenueFromText(text).canonical, expected, text);
    }

    const catalog = knownVenueCatalog().map((item) => item.canonical);
    for (const expected of [
        'Тупик',
        'Сто Ручьёв',
        'The Last of Vavilone',
        'DIESEL HALL',
        'Rock Bar DIESEL',
        'Overlock Bar',
        'Meet Bowling',
        'Паб Мама Анархия',
        'Liverpool Pub',
    ]) {
        assert.ok(catalog.includes(expected), expected);
    }
});

test('V188.13 exact Vavilone announcement resolves Tupik plus nearby address locally', () => {
    const inference = inferEventVenueFromText(vavilonePost);
    assert.equal(inference.canonical, 'Тупик');
    assert.match(inference.venue, /Тупик/u);
    assert.match(inference.venue, /Революции 31а/u);
    assert.match(inference.venue, /Воронеж/u);

    const [event] = parsePublicPostLocally({
        text: vavilonePost,
        publishedAt: Math.floor(new Date('2026-09-09T00:00:00+03:00').getTime() / 1000),
    });
    assert.ok(event);
    assert.equal(event.eventDate, '2026-09-11');
    assert.equal(event.eventTime, '18:00');
    assert.match(event.venue, /Тупик/u);
    assert.match(event.venue, /Революции 31а/u);
});

test('V188.13 preposition candidates are semantic hints, not blindly accepted as venues', () => {
    const candidates = collectVenueContextCandidates(
        'Собираемся в ночь, пишем в комментариях, а потом увидимся в пабе Черная Роза.',
    );
    assert.ok(candidates.some((item) => /пабе Черная Роза/iu.test(item.text) && item.hasVenueType));
    assert.ok(!candidates.some((item) => /^ночь$/iu.test(item.text)));
    assert.ok(!candidates.some((item) => /^комментариях$/iu.test(item.text)));

    const inferred = inferEventVenueFromText('Вечеринка в пабе Черная Роза, начало 20:00');
    assert.match(inferred.venue, /пабе Черная Роза/iu);
    assert.ok(inferred.confidence >= 0.8);
});

test('V188.13 unresolved venue triggers focused semantic AI audit with poster facts', () => {
    assert.match(appSource, /auditProposalVenuesSemantically/u);
    assert.match(appSource, /proposal\.venue_audit\.deterministic/u);
    assert.match(appSource, /proposal\.venue_audit\.ai_result/u);
    assert.match(appSource, /EVENT PROPOSAL VENUE SEMANTIC AUDIT/u);
    assert.match(appSource, /Факты с изображения\/афиши равноправны тексту/u);
    assert.match(appSource, /posterFacts/u);
    assert.match(appSource, /readManualEventImageFacts/u);
    assert.match(appSource, /confidence < 0\.55/u);
});
