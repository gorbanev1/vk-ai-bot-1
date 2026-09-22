import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { explainEventAiAdmissionWithPosterFacts } from '../../src/features/events/eventAiAdmission.js';
import { explainPublicPostEventCandidate } from '../../src/features/events/publicPostLocalParser.js';
import { explainVkChatEventCandidate } from '../../src/features/events/eventCandidateRouting.js';

const NOW = new Date('2026-09-13T12:00:00Z');
const FUTURE_POSTER = [
    '[IMAGE 1]',
    'Это афиша события: да',
    'Название: PLACEBO tribute',
    'Дата: 19 сентября 2026',
    'Время: 20:00',
].join('\n');

test('V188.63: poster vision rescues a body with no date/title', () => {
    const admission = explainEventAiAdmissionWithPosterFacts({
        text: 'Ждём всех 🔥',
        posterFacts: FUTURE_POSTER,
        posterVisionAttempted: true,
        referenceNow: NOW,
    });
    assert.equal(admission.eligible, true);
    assert.equal(admission.dateSource, 'poster-vision');
    assert.equal(admission.admissionPath, 'poster-vision-rescue');
    assert.equal(admission.titleEvidence, 'PLACEBO tribute');
    assert.equal(admission.admittedDateEvidence[0]?.date, '2026-09-19');
    assert.equal(admission.bodyRejectionReason, 'no-calendar-date-in-body');
});

test('V188.63: old poster date cannot rescue the post', () => {
    const admission = explainEventAiAdmissionWithPosterFacts({
        text: 'Ждём всех 🔥',
        posterFacts: '[IMAGE 1]\nЭто афиша события: да\nНазвание: Summer Sound\nДата: 8 августа 2026\nВремя: 20:00',
        posterVisionAttempted: true,
        referenceNow: NOW,
    });
    assert.equal(admission.eligible, false);
    assert.equal(admission.posterVisionRejectionReason, 'all-body-event-dates-are-past');
});

test('V188.63: title and date from different images cannot be combined into one fake event', () => {
    const admission = explainEventAiAdmissionWithPosterFacts({
        text: '🔥',
        posterFacts: [
            '[IMAGE 1]',
            'Это афиша события: да',
            'Название: EVENT ONE',
            'Дата:',
            '',
            '[IMAGE 2]',
            'Это афиша события: да',
            'Название:',
            'Дата: 19 сентября 2026',
        ].join('\n'),
        posterVisionAttempted: true,
        referenceNow: NOW,
    });
    assert.equal(admission.eligible, false);
});

test('V188.63: explicit not-an-event poster result cannot rescue even with OCR-like title/date', () => {
    const admission = explainEventAiAdmissionWithPosterFacts({
        text: 'картинка',
        posterFacts: '[IMAGE 1]\nЭто афиша события: нет\nНазвание: PLACEBO\nДата: 19 сентября 2026',
        posterVisionAttempted: true,
        referenceNow: NOW,
    });
    assert.equal(admission.eligible, false);
    assert.equal(admission.posterVisionRejectionReason, 'poster-vision-says-not-event');
});

test('V188.63: pure image public post can become a structural/main-AI candidate only after poster rescue', () => {
    const before = explainPublicPostEventCandidate({
        text: 'Ждём всех 🔥',
        imageUrls: ['https://example.test/poster.jpg'],
        referenceNow: NOW,
    });
    assert.equal(before.candidate, false);
    assert.equal(before.aiEligible, false);

    const after = explainPublicPostEventCandidate({
        text: 'Ждём всех 🔥',
        imageUrls: ['https://example.test/poster.jpg'],
        __posterGateVisionAttempted: true,
        __posterGateFacts: FUTURE_POSTER,
        referenceNow: NOW,
    });
    assert.equal(after.candidate, true);
    assert.equal(after.aiEligible, true);
    assert.equal(after.aiAdmission.dateSource, 'poster-vision');
    assert.ok(after.reasons.includes('poster-vision-event'));
});

test('V188.63: pure image VK chat message can be rescued from poster vision', () => {
    const result = explainVkChatEventCandidate({
        text: '🔥',
        imageUrls: ['https://example.test/poster.jpg'],
        __posterGateVisionAttempted: true,
        __posterGateFacts: FUTURE_POSTER,
        referenceNow: NOW,
    });
    assert.equal(result.candidate, true);
    assert.equal(result.aiEligible, true);
    assert.equal(result.aiAdmission.admissionPath, 'poster-vision-rescue');
});

test('V188.63: poster gate runs only after global raw-cache barrier and before main processing gate', async () => {
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const captureBarrier = app.indexOf('await Promise.all(captureWaiters.map((item) => item.promise))');
    const posterGateStart = app.indexOf("diagnostics.log('run.poster-gate.start'");
    const posterRelease = app.indexOf('releasePosterGateGate?.()');
    const admissionBarrier = app.indexOf('await Promise.all(admissionWaiters.map((item) => item.promise))');
    assert.ok(captureBarrier >= 0 && posterGateStart > captureBarrier);
    assert.ok(posterRelease > posterGateStart && admissionBarrier > posterRelease);
    assert.match(app, /event-parser:poster-gate-vision/u);
    assert.match(app, /Смотри ТОЛЬКО на изображение/u);
    assert.match(app, /Дата публикации\/интерфейса сама по себе не засчитывается/u);
});

test('V188.63: all three finite source types expose poster gate requests and final admission callbacks', async () => {
    for (const relative of [
        '../../src/platforms/vk/vkPublicScraper.js',
        '../../src/platforms/telegram/telegramHtmlScraper.js',
        '../../src/platforms/vk/vkChatEventScraper.js',
    ]) {
        const source = await readFile(new URL(relative, import.meta.url), 'utf8');
        assert.match(source, /posterGateRequests/u, relative);
        assert.match(source, /posterGateGate/u, relative);
        assert.match(source, /getPosterGateResult/u, relative);
        assert.match(source, /onAdmissionComplete/u, relative);
        assert.match(source, /posterGateRescuedCount/u, relative);
    }
});
