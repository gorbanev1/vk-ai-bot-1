import assert from 'node:assert/strict';
import test from 'node:test';

import {
    explainEventAiAdmission,
    explainEventAiAdmissionWithPosterFacts,
} from '../../src/features/events/eventAiAdmission.js';
import {
    explainPublicPostEventCandidate,
    parsePublicPostLocally,
} from '../../src/features/events/publicPostLocalParser.js';

const NOW = new Date('2026-09-17T12:00:00Z');
const PUBLISHED_AT = Math.floor(new Date('2026-09-17T09:00:00Z').getTime() / 1000);

const servicePost = [
    'По техническим причинам Бар сегодня не работает!',
    'Завтра ждём вас на концерт Кавер-бэнда Станция 3.14',
    'Билеты: https://example.test/tickets',
].join('\n');

test('V188.91 operational venue status with only a forwarded event mention is not an announcement', () => {
    const admission = explainEventAiAdmission({
        text: servicePost,
        publishedAt: PUBLISHED_AT,
        referenceNow: NOW,
    });
    assert.equal(admission.eligible, false);
    assert.equal(admission.rejectionReason, 'service-status-not-event-announcement');
    assert.equal(admission.operationalStatusRejected, true);

    const decision = explainPublicPostEventCandidate({
        text: servicePost,
        publishedAt: PUBLISHED_AT,
        referenceNow: NOW,
        imageUrls: ['https://example.test/bar-photo.jpg'],
    });
    assert.equal(decision.candidate, true, 'keep structural candidate so poster gate may inspect media');
    assert.equal(decision.aiEligible, false, 'body text alone must not enter main event AI');
    assert.deepEqual(parsePublicPostLocally({
        text: servicePost,
        publishedAt: PUBLISHED_AT,
        referenceNow: NOW,
    }), []);
});

test('V188.91 a genuine poster can rescue an operational post, ordinary venue photo cannot', () => {
    const ordinaryPhotoFacts = [
        '[IMAGE 1]',
        'Тип изображения: ordinary-photo',
        'Это афиша события: нет',
        'Название:',
        'Дата:',
    ].join('\n');
    const rejected = explainEventAiAdmissionWithPosterFacts({
        text: servicePost,
        posterFacts: ordinaryPhotoFacts,
        posterVisionAttempted: true,
        publishedAt: PUBLISHED_AT,
        referenceNow: NOW,
    });
    assert.equal(rejected.eligible, false);
    assert.equal(rejected.bodyRejectionReason, 'service-status-not-event-announcement');

    const posterFacts = [
        '[IMAGE 1]',
        'Тип изображения: poster',
        'Это афиша события: да',
        'Название: Станция 3.14',
        'Дата: 18.09.2026',
        'Время: 20:00',
        'Место: The Last of Vavilone',
    ].join('\n');
    const rescued = explainEventAiAdmissionWithPosterFacts({
        text: servicePost,
        posterFacts,
        posterVisionAttempted: true,
        publishedAt: PUBLISHED_AT,
        referenceNow: NOW,
    });
    assert.equal(rescued.eligible, true);
    assert.equal(rescued.admissionPath, 'poster-vision-rescue');
    assert.equal(rescued.bodyRejectionReason, 'service-status-not-event-announcement');
});

test('V188.91 actual self-contained concert announcement remains eligible', () => {
    const announcement = [
        '18 сентября 2026 — концерт кавер-бэнда Станция 3.14',
        'Начало в 20:00',
        'The Last of Vavilone',
        'Билеты по ссылке',
    ].join('\n');
    const admission = explainEventAiAdmission({
        text: announcement,
        publishedAt: PUBLISHED_AT,
        referenceNow: NOW,
    });
    assert.equal(admission.eligible, true);
    assert.equal(admission.operationalStatusRejected, false);
});
