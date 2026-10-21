import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { explainVkChatEventCandidate } from '../../src/features/events/eventCandidateRouting.js';
import { explainPublicPostEventCandidate } from '../../src/features/events/publicPostLocalParser.js';
import { explainEventAiAdmission } from '../../src/features/events/eventAiAdmission.js';
import { extractRawDateMentions } from '../../src/features/events/publicPostDateEvidence.js';

const NOW = new Date('2026-09-13T12:00:00Z');

test('V188.62: publication metadata alone can never create AI date evidence', () => {
    const decision = explainPublicPostEventCandidate({
        text: 'Большой концерт группы Test Band в Diesel Bar, начало 19:00',
        publishedAt: Math.floor(new Date('2026-09-13T09:00:00Z').getTime() / 1000),
        publishedLabel: '13 сен в 12:00',
        imageUrls: ['poster.jpg'],
        referenceNow: NOW,
    });

    assert.equal(decision.candidate, true, 'broad structural detector may keep the item for diagnostics');
    assert.equal(decision.aiEligible, false, 'strict gate must block it before AI');
    assert.equal(decision.aiAdmission.rejectionReason, 'no-calendar-date-in-body');
    assert.equal(decision.aiAdmission.dateSource, 'body-text-only');
});

test('V188.62: a named old event stays structural but does not enter AI', () => {
    const decision = explainVkChatEventCandidate({
        contentText: 'Summer Sound Fest — 8 августа 2026, 16:00. Концерт на пляже Пески.',
        imageUrls: ['poster.jpg'],
        referenceNow: NOW,
    });

    assert.equal(decision.candidate, true);
    assert.equal(decision.aiEligible, false);
    assert.equal(decision.aiAdmission.rejectionReason, 'all-body-event-dates-are-past');
});

test('V188.62: actual body date plus event title plus non-past date enters AI', () => {
    const decision = explainPublicPostEventCandidate({
        text: 'Placebo & MCR Tribute 19.09 — Воронеж / Diesel. Начало 19:00.',
        publishedAt: Math.floor(new Date('2026-09-10T10:00:00Z').getTime() / 1000),
        imageUrls: ['poster.jpg'],
        referenceNow: NOW,
    });

    assert.equal(decision.aiEligible, true);
    assert.match(decision.aiAdmission.titleEvidence, /Placebo/u);
    assert.equal(decision.aiAdmission.admittedDateEvidence[0].date, '2026-09-19');
    assert.equal(decision.aiAdmission.admittedDateEvidence[0].yearInferenceSource, 'published-at-for-year-only');
});

test('V188.62: price suffix is not swallowed as a fake 3-digit year', () => {
    const mentions = extractRawDateMentions('Цена: до 4.09-800₽, после 1000₽');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].raw, '4.09');
    assert.equal(mentions[0].explicitYear, null);
});

test('V188.62: next-line time is not swallowed as a fake year', () => {
    const mentions = extractRawDateMentions('Ospa 1959 — 27 сентября\n19:00\nDiesel Bar');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].raw, '27 сентября');
    assert.equal(mentions[0].explicitYear, null);
});

test('V188.62: colloquial 26го сентября counts as body date evidence', () => {
    const mentions = extractRawDateMentions('Фестиваль ИВА 26го сентября в 19:00');
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].day, 26);
    assert.equal(mentions[0].month, 9);
});

test('V188.62: giveaway/deadline date is classified as administrative, not event date', () => {
    const admission = explainEventAiAdmission({
        text: 'Розыгрыш билетов. Дата розыгрыша: 19:30, 16.09.2026',
        publishedAt: Math.floor(new Date('2026-09-13T09:00:00Z').getTime() / 1000),
        referenceNow: NOW,
    });

    assert.equal(admission.eligible, false);
    assert.equal(admission.rejectionReason, 'only-administrative-dates-in-body');
    assert.equal(admission.dateEvidence[0].role, 'administrative-date');
});

test('V188.62: parser-all exposes human-readable why-in-AI report and queue preview', async () => {
    const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const diagnostics = await readFile(new URL('../../src/features/scrapers/manualParserDiagnostics.js', import.meta.url), 'utf8');

    assert.match(app, /run-ai-queue\.audit\.txt/u);
    assert.match(app, /Что сейчас идёт в AI/u);
    assert.match(app, /Читаемый отчёт «что\/почему в AI»/u);
    assert.match(app, /publishedAt используется только для определения года/u);
    assert.match(diagnostics, /function saveTextReport/u);
});
