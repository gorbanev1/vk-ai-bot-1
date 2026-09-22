import assert from 'node:assert/strict';
import test from 'node:test';
import { assignEventImageIndexesFromFacts, parseIndexedImageFacts } from '../../src/features/events/eventPosterMatching.js';
import { readFileSync } from 'node:fs';

test('V188.73 binds CWT and STONEHAND by event identity, not shared Diesel venue/date', () => {
    const facts = `
[IMAGE 1]
Тип изображения: poster
Это афиша события: да
Уверенность афиши: 98
Читаемость текста: 95
Название: CWT — Презентация альбома
Дата: 26 сентября 2026
Время: 20:00
Место: Diesel Rock Bar
Участники: CWT
Причина: на изображении напечатаны название и дата события

[IMAGE 2]
Тип изображения: poster
Это афиша события: да
Уверенность афиши: 97
Читаемость текста: 92
Название: STONEHAND
Дата: 26 сентября 2026
Время: 19:00
Место: DIESEL HALL
Участники: STONEHAND
Причина: афиша выступления STONEHAND
`;
    const events = assignEventImageIndexesFromFacts([
        { eventDate: '2026-09-26', title: '26 сентября | CWT | Воронеж - Презентация альбома', venue: 'Diesel Rock Bar', participants: 'CWT' },
        { eventDate: '2026-09-26', title: 'STONEHAND (ВОРОНЕЖ) DIESEL HALL', venue: 'Diesel Hall', participants: 'STONEHAND' },
    ], facts);
    assert.equal(events[0].posterImageIndex, 1);
    assert.equal(events[1].posterImageIndex, 2);
    assert.equal(events[0].posterMatchStatus, 'exact_poster_match');
    assert.equal(events[1].posterMatchStatus, 'exact_poster_match');
});

test('V188.73 never binds ordinary photos, covers or logos even if context/date coincides', () => {
    const facts = `
[IMAGE 1]
Тип изображения: ordinary-photo
Это афиша события: нет
Уверенность афиши: 99
Читаемость текста: 0
Название: Юбилейная 5-я вылазка-знакомство
Дата: 20 сентября 2026
Место:
Участники:
Причина: обычная фотография людей без визуального анонса

[IMAGE 2]
Тип изображения: album-cover
Это афиша события: нет
Уверенность афиши: 97
Читаемость текста: 40
Название: Юбилейная 5-я вылазка-знакомство
Дата: 20 сентября 2026
Причина: обложка, а не афиша
`;
    const [event] = assignEventImageIndexesFromFacts([
        { eventDate: '2026-09-20', title: 'Юбилейная 5-я вылазка-знакомство', venue: '' },
    ], facts);
    assert.equal(event.posterImageIndex, 0);
    assert.deepEqual(event.imageIndexes, []);
    assert.equal(event.posterMatchStatus, 'no_safe_poster');
});

test('V188.73 parser stores image type/confidence/readability for DB audit', () => {
    const [fact] = parseIndexedImageFacts(`
[IMAGE 7]
Тип изображения: poster
Это афиша события: да
Уверенность афиши: 93
Читаемость текста: 81
Название: STONEHAND
Дата: 26.09.2026
Причина: текстовая афиша
`);
    assert.equal(fact.index, 7);
    assert.equal(fact.imageType, 'poster');
    assert.equal(fact.poster, true);
    assert.equal(fact.posterConfidence, 93);
    assert.equal(fact.textReadability, 81);
    assert.match(fact.reason, /текстовая/u);
});

test('V188.73 source media is retained separately but never auto-attached as event media', () => {
    const source = readFileSync(new URL('../../src/features/events/eventAssets.js', import.meta.url), 'utf8');
    assert.match(source, /shareSourceImagesAcrossEvents is intentionally ignored/u);
    assert.doesNotMatch(source, /eventImagePaths = \[\.\.\.downloaded\]/u);
    assert.match(source, /tinyUiImage/u);
    assert.match(source, /Math\.max\(dimensions\.width, dimensions\.height\) < 48/u);
});

test('V188.73 date/month/year words never count as event identity and one poster cannot bind two child events', () => {
    const facts = `
[IMAGE 1]
Тип изображения: poster
Это афиша события: да
Уверенность афиши: 98
Читаемость текста: 95
Название: CWT — Презентация альбома
Дата: 26 сентября 2026
Место: Diesel Hall
Участники: CWT
Причина: афиша CWT
`;
    const audit = [];
    const events = assignEventImageIndexesFromFacts([
        { eventDate: '2026-09-26', title: '26 сентября 2026 | CWT | Воронеж — презентация альбома', venue: 'Diesel Rock Bar', participants: 'CWT' },
        { eventDate: '2026-09-26', title: '26 сентября 2026 | STONEHAND | Воронеж', venue: 'Diesel Hall', participants: 'STONEHAND' },
    ], facts, { onAudit: (row) => audit.push(row) });
    assert.equal(events[0].posterImageIndex, 1);
    assert.equal(events[1].posterImageIndex, 0);
    assert.equal(events[1].posterMatchStatus, 'no_safe_poster');
    const stonehandCandidate = audit.find((row) => String(row.event?.title || '').includes('STONEHAND') && row.imageIndex === 1);
    assert.equal(stonehandCandidate?.accepted, false);
    assert.match(String(stonehandCandidate?.reason), /date-without-event-identity|identity-too-weak/u);
});
