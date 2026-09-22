import test from 'node:test';
import assert from 'node:assert/strict';
import {extractRawDateMentions, isCalendarIsoDate} from '../../src/features/events/publicPostDateEvidence.js';
import {extractEventDate, extractEventTime} from '../../src/features/events/eventMetadata.js';
import {buildSequentialAnnouncementBlocks} from '../../src/features/events/eventMultiAnnouncementBlocks.js';
import {isStrictEventRecord} from '../../src/features/events/eventValidation.js';
import {explainVkChatEventCandidate} from '../../src/features/events/eventCandidateRouting.js';

const referenceDate = new Date('2026-01-10T12:00:00Z');
const dates = (text) => extractRawDateMentions(text).map((item) => item.raw);

test('visible event dates are dot-delimited or explicit month names', () => {
    for (const sample of ['19.04', '7 февраля', 'седьмое февраля', 'двадцать первое марта 2027', '25.09.2026', '20.09.26']) {
        assert.ok(dates(sample).length, sample);
    }
    for (const sample of ['19.00', '19-00', '20-09', '2026-09-20', '20/09', '20:09', 'завтра', 'в пятницу']) {
        assert.deepEqual(dates(sample), [], sample);
    }
});

test('a raw numeric year is inferred correctly and internal ISO remains valid', () => {
    assert.equal(extractEventDate('7 февраля', {referenceDate}), '2026-02-07');
    assert.equal(extractEventDate('седьмое февраля', {referenceDate}), '2026-02-07');
    assert.equal(extractEventDate('20.09.26', {referenceDate}), '2026-09-20');
    assert.equal(extractEventDate('2026-09-20', {referenceDate}), '');
    assert.equal(isCalendarIsoDate('2026-09-20'), true);
    assert.equal(extractEventDate('не указано', {referenceDate, existingDate:'2026-09-20'}), '2026-09-20');
});

test('only colon time or a hyphen with explicit clock context is extracted', () => {
    assert.equal(extractEventTime('19:00'), '19:00');
    assert.equal(extractEventTime('Начало 19-00'), '19:00');
    assert.equal(extractEventTime('Группа X - 19-00'), '');
    assert.equal(extractEventTime('Начало 19.00'), '');
    assert.equal(extractEventTime('19.04'), '');
});

test('date-led multi-announcement text keeps separate blocks', () => {
    const result = buildSequentialAnnouncementBlocks('седьмое февраля — Группа А\nвосьмое февраля — Группа Б');
    assert.equal(result.blocks.length, 2);
});

test('a date-less event cannot pass strict event validation', () => {
    const event = {title: 'Концерт Группа А', eventDate: '', eventTime: '19:00', venue:'Клуб',description:'Концерт группы А'};
    assert.equal(isStrictEventRecord(event), false);
    assert.equal(explainVkChatEventCandidate({contentText:'Концерт группы А 19.00'}).evidence.hasDate, false);
});
