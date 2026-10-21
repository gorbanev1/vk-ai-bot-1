import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
    evaluatePosterFactForEvent,
    parseIndexedImageFacts,
    serializeIndexedImageFacts,
    selectBestCompatiblePosterFact,
} from '../../src/features/events/eventPosterMatching.js';
import {
    buildSequentialAnnouncementBlocks,
} from '../../src/features/events/eventMultiAnnouncementBlocks.js';
import { parseEventModerationCommand } from '../../src/features/events/eventModerationRouting.js';
import { pendingVisionImageIndexes } from '../../src/features/events/eventVisionPolicy.js';

test('Vision retries only images without a successful metadata outcome', () => {
    const facts = [
        { index: 1, visionStatus: 'metadata_found', title: 'Event' },
        { index: 2, visionStatus: 'metadata_not_found', visionInspected: true, text: '[IMAGE 2]\nТип изображения: ordinary-photo\nЭто афиша события: нет\nРаспознанный текст: Текст на изображении отсутствует' },
        { index: 3, visionStatus: 'error' },
        { index: 4, visionStatus: 'not_run' },
    ];
    assert.deepEqual(pendingVisionImageIndexes(5, facts), [3, 4, 5]);
    assert.deepEqual(pendingVisionImageIndexes(3, facts.slice(0, 2)), [3]);
    assert.deepEqual(pendingVisionImageIndexes(2, [
        { index: 1, visionStatus: 'metadata_found' },
        { index: 2, visionStatus: 'metadata_not_found' },
    ]), [1, 2]);
});

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
    const noText = parseIndexedImageFacts('[IMAGE 1]\nЭто афиша события: нет\nРаспознанный текст: Текст на изображении отсутствует');
    assert.equal(noText[0].visionInspected, true);
    assert.equal(noText[0].visionStatus, 'metadata_not_found');
    const markerOnly = parseIndexedImageFacts('[IMAGE 2]');
    assert.deepEqual(markerOnly, []);
    const malformed = parseIndexedImageFacts('[IMAGE 3]\nНазвание:');
    assert.equal(malformed[0].visionStatus, 'error');
    const explicitFailure = parseIndexedImageFacts('[IMAGE 4]\nТип изображения: other\nПричина: Vision error: upstream timeout');
    assert.equal(explicitFailure[0].visionStatus, 'error');
});

test('V18892 durable Vision facts keep image markers when replayed', () => {
    const stored = [{
        index: 2,
        text: 'Тип изображения: poster\nЭто афиша события: да\nНазвание: Replay me',
        visionStatus: 'metadata_found',
        visionInspected: true,
    }];
    const replay = serializeIndexedImageFacts(stored);
    assert.match(replay, /^\[IMAGE 2\]/u);
    assert.equal(parseIndexedImageFacts(replay)[0].index, 2);
    assert.equal(parseIndexedImageFacts(replay)[0].title, 'Replay me');
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

test('V18892 full image audit really rechecks the archived/source-only inventory', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const begin = app.indexOf("if (command.action === 'image-metadata-full-audit')");
    const end = app.indexOf("if (command.action === 'source-image-vision-audit')", begin);
    assert.ok(begin >= 0 && end > begin);
    const branch = app.slice(begin, end);
    assert.match(branch, /recheckEveryImage:\s*true/u);
    assert.match(branch, /архивные события и source-only/u);
});

test('V18892 source Vision command forces a fresh pass for stored future images', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const begin = app.indexOf("if (command.action === 'source-image-vision-audit')");
    const end = app.indexOf("if (command.action === 'image-metadata-backfill')", begin);
    assert.ok(begin >= 0 && end > begin);
    const branch = app.slice(begin, end);
    assert.match(branch, /forceVision:\s*true/u);
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
