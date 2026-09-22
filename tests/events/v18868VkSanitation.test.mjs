import assert from 'node:assert/strict';
import test from 'node:test';

import { sanitizeEventBodyText } from '../../src/features/events/eventTextSanitation.js';
import { extractRawDateMentions } from '../../src/features/events/publicPostDateEvidence.js';
import { explainEventAiAdmission } from '../../src/features/events/eventAiAdmission.js';
import { parsePublicPostLocally } from '../../src/features/events/publicPostLocalParser.js';

const REFERENCE_NOW = new Date('2026-09-14T12:00:00Z');
const PUBLISHED_AT = Math.floor(new Date('2026-09-01T12:00:00Z').getTime() / 1000);

test('VK carousel counter 1/10 next-slide is removed before date parsing', () => {
    const text = 'Как мы провожали лето\n1/10\nСледующий слайд\nСпасибо всем, было круто!';
    const clean = sanitizeEventBodyText(text);
    assert.doesNotMatch(clean, /1\s*\/\s*10/u);
    assert.doesNotMatch(clean, /следующий\s+слайд/iu);
    assert.deepEqual(extractRawDateMentions(text), []);

    const admission = explainEventAiAdmission({
        text,
        publishedAt: PUBLISHED_AT,
        referenceNow: REFERENCE_NOW,
    });
    assert.equal(admission.eligible, false);
    assert.equal(admission.rejectionReason, 'retrospective-post');
    assert.equal(admission.retrospectiveRejected, true);
});

test('same-node VK carousel counter is never admitted as 1 October', () => {
    const text = 'Как это было\n1/10 Следующий слайд\nФотоотчёт';
    assert.deepEqual(extractRawDateMentions(text), []);
    assert.deepEqual(parsePublicPostLocally({
        text,
        publishedAt: PUBLISHED_AT,
        referenceNow: REFERENCE_NOW,
        screenName: 'vavilone_rb',
    }), []);
});

test('normal prose slash date remains valid when it is not VK carousel UI', () => {
    const text = 'SENAMIRHA — концерт 11/10\nНачало в 19:00\nThe Last of Vavilone';
    const mentions = extractRawDateMentions(text);
    assert.equal(mentions.length, 1);
    assert.equal(mentions[0].day, 11);
    assert.equal(mentions[0].month, 10);
});

test('retrospective wording does not hide a separately proven future announcement', () => {
    const text = 'Как это было — спасибо всем!\nСледующий концерт SENAMIRHA — 20 октября\nНачало в 19:00';
    const admission = explainEventAiAdmission({
        text,
        publishedAt: PUBLISHED_AT,
        referenceNow: REFERENCE_NOW,
    });
    assert.equal(admission.retrospectiveRejected, false);
    assert.equal(admission.hasNonPastDate, true);
    assert.notEqual(admission.rejectionReason, 'retrospective-post');
});
