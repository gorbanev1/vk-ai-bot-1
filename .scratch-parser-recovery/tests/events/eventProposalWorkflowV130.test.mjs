import assert from 'node:assert/strict';
import test from 'node:test';

import {
    analyzeEventProposalDraft,
    analyzeEventProposalDrafts,
    applyEventProposalCorrections,
    parseEventProposalCorrections,
} from '../../src/features/events/eventProposalWorkflow.js';

test('V130 proposal hard requirements: date and venue are mandatory, time is optional', () => {
    const ok = analyzeEventProposalDraft({
        title: 'Туса',
        eventDate: '2026-09-05',
        eventTime: null,
        venue: 'DIESEL HALL, Воронеж',
    }, { referenceDate: '2026-08-25' });
    assert.equal(ok.canSubmit, true);
    assert.deepEqual(ok.missingRequired, []);
    assert.ok(ok.missingOptional.includes('time'));

    const noDate = analyzeEventProposalDraft({ venue: 'Тупик' }, { referenceDate: '2026-08-25' });
    assert.equal(noDate.canSubmit, false);
    assert.ok(noDate.missingRequired.includes('date'));

    const noVenue = analyzeEventProposalDraft({ eventDate: '2026-09-05' }, { referenceDate: '2026-08-25' });
    assert.equal(noVenue.canSubmit, false);
    assert.ok(noVenue.missingRequired.includes('venue'));
});

test('V130 explicitly deferred venue is valid and still allows missing time', () => {
    const analysis = analyzeEventProposalDraft({
        title: 'Секретный рейв',
        eventDate: '2026-09-05',
        venue: 'Локацию сообщим в день мероприятия',
    }, { referenceDate: '2026-08-25' });

    assert.equal(analysis.canSubmit, true);
    assert.equal(analysis.venueDeferred, true);
    assert.ok(analysis.missingOptional.includes('time'));
});

test('V130 past dates never submit', () => {
    const analysis = analyzeEventProposalDraft({
        eventDate: '2024-11-22',
        venue: 'Overlock Bar',
    }, { referenceDate: '2026-08-25' });
    assert.equal(analysis.canSubmit, false);
    assert.ok(analysis.blocking.includes('past_date'));
});

test('V130 corrections can fill required and optional fields', () => {
    const corrections = parseEventProposalCorrections([
        'дата: 5 сентября 2026',
        'место: DIESEL HALL',
        'время: 19:00',
    ].join('\n'), { referenceTimestampSeconds: 1787670000 });

    const [updated] = applyEventProposalCorrections([{
        title: 'Гиг',
        eventDate: '',
        venue: '',
    }], corrections);

    assert.equal(updated.eventDate, '2026-09-05');
    assert.equal(updated.venue, 'DIESEL HALL');
    assert.equal(updated.eventTime, '19:00');
    assert.equal(analyzeEventProposalDrafts([updated], { referenceDate: '2026-08-25' }).canSubmit, true);
});
