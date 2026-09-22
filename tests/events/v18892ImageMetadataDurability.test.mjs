import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    evaluatePosterFactForEvent,
    parseIndexedImageFacts,
    selectBestCompatiblePosterFact,
} from '../../src/features/events/eventPosterMatching.js';
import {
    buildSequentialAnnouncementBlocks,
} from '../../src/features/events/eventMultiAnnouncementBlocks.js';
import { parseEventModerationCommand } from '../../src/features/events/eventModerationRouting.js';

test('V18892 rejects an old gallery poster for a newer event and accepts the real poster', () => {
    const event = {
        title: 'Праздник урожая в Башне',
        eventDate: '2026-09-20',
        eventTime: '17:00',
        venue: 'Башня',
        participants: 'Дивные люди',
    };
    const wrong = {
        index: 1,
        poster: true,
        posterConfidence: 99,
        title: 'Дивная Масленица',
        dates: '21 февраля',
        venue: 'Дивногорье',
        participants: 'Дивные люди',
    };
    const right = {
        index: 2,
        poster: true,
        posterConfidence: 100,
        title: 'Праздник урожая в Башне',
        dates: '20 сентября',
        time: '17:00',
        venue: 'Башня, Винзавод, Воронеж',
    };
    assert.equal(evaluatePosterFactForEvent(event, wrong).accepted, false);
    assert.equal(evaluatePosterFactForEvent(event, wrong).reason, 'no-date-match');
    const accepted = evaluatePosterFactForEvent(event, right);
    assert.equal(accepted.accepted, true);
    assert.equal(selectBestCompatiblePosterFact(event, [wrong, right])?.fact?.index, 2);
});

test('V18892 parses extended poster metadata', () => {
    const facts = parseIndexedImageFacts(`[IMAGE 3]\nТип изображения: poster\nЭто афиша события: да\nУверенность афиши: 98\nЧитаемость текста: 91\nНазвание: Ночь музыки\nДата: 19 сентября\nНачало: 21:00\nОкончание: 02:00\nМесто: Балаган Сити\nГород: Воронеж\nАдрес: Плехановская, 10\nУчастники: 36 Пятниц\nЦена: 500 ₽\nВозраст: 18+\nПрограмма: квартирник, DJ\nРаспознанный текст: 19 сентября 21:00 36 Пятниц\nПричина: афиша`);
    assert.equal(facts.length, 1);
    assert.equal(facts[0].startTime, '21:00');
    assert.equal(facts[0].endTime, '02:00');
    assert.equal(facts[0].city, 'Воронеж');
    assert.equal(facts[0].address, 'Плехановская, 10');
    assert.match(facts[0].recognizedText, /36 Пятниц/u);
});

test('V18892 sequential text blocks are split by date and ignore Vision fact lines', () => {
    const parsed = buildSequentialAnnouncementBlocks(`Афиша на выходные\n18 сентября\n21:00 Квартирник\n23:00 DJ Арч\n[IMAGE 1]\nДата: 20 сентября\nНазвание: чужая афиша\n19 сентября\n21:00 36 Пятниц\n23:00 DJ Декстер`);
    assert.equal(parsed.blocks.length, 2);
    assert.match(parsed.blocks[0].text, /18 сентября[\s\S]*DJ Арч/u);
    assert.match(parsed.blocks[1].text, /19 сентября[\s\S]*DJ Декстер/u);
    assert.doesNotMatch(parsed.blocks[0].text, /IMAGE|чужая афиша/u);
});

test('V18892 owner routes expose metadata review and explicit backfill', () => {
    assert.equal(parseEventModerationCommand('тусы метаданные картинок')?.action, 'image-metadata-report');
    assert.equal(parseEventModerationCommand('тусы метаданные картинок заполнить')?.action, 'image-metadata-backfill');
});

test('V18892 startup no longer schedules legacy media repair or import-time backfill', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const db = readFileSync(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');
    const startApplicationTail = app.slice(app.indexOf('async function startApplication'));
    assert.doesNotMatch(startApplicationTail, /event-media-repair:v18883-startup/u);
    assert.match(startApplicationTail, /LEGACY EVENT STARTUP REPAIRS/u);
    assert.doesNotMatch(db, /\nbackfillCleanLegacyPosterBindingsV18868\(\);\n/u);
});

test('V18892 interactive image OCR uses bounded failover instead of 120s full ladder', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const begin = app.indexOf('async function analyzeIncomingMediaImage');
    const end = app.indexOf('\nasync function processIncomingMediaContext', begin);
    const source = app.slice(begin, end > begin ? end : begin + 12000);
    assert.match(source, /INCOMING_MEDIA_VISION_TIMEOUT_MS/u);
    assert.match(source, /INCOMING_MEDIA_VISION_MAX_CANDIDATES/u);
    assert.match(source, /failuresBeforeQuarantine:\s*1/u);
    assert.match(source, /oneCandidatePerMode:\s*true/u);
    assert.doesNotMatch(source, /maxCandidates:\s*0/u);
});
