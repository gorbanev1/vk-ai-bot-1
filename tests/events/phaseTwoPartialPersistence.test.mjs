import test from 'node:test';
import assert from 'node:assert/strict';
import { getSourceEventLedgerStatus, shouldRetryEntireEventBatchAfterValidation } from '../../src/features/events/sourceEventPersistence.js';
import { isManualParserSeenItemFinalStatus } from '../../src/infrastructure/database/index.js';
import { upsertVkSourcePost, replaceVkEventsForPost, getVkEventsForPostRefresh } from '../../src/infrastructure/database/index.js';

test('phase two retains complete future events when another poster event fails validation', () => {
    assert.equal(shouldRetryEntireEventBatchAfterValidation({
        aiRequired: true, confirmedPoster: true, parsedCount: 3, acceptedCount: 2,
    }), false);
});

test('a poster response that produced no parsed card is not classified by final card validation', () => {
    assert.equal(shouldRetryEntireEventBatchAfterValidation({
        aiRequired: true, confirmedPoster: true, parsedCount: 0, acceptedCount: 0,
    }), false);
});

test('poster events rejected by deterministic final validation are terminal, not unresolved', () => {
    assert.equal(shouldRetryEntireEventBatchAfterValidation({
        aiRequired: true, confirmedPoster: true, parsedCount: 2, acceptedCount: 0,
        rejectedReasons: ['event-date-before-today', 'event-date-before-today'],
    }), false);
});

test('phase-two poster does not retry when every parsed event fails final validation', () => {
    assert.equal(shouldRetryEntireEventBatchAfterValidation({
        aiRequired: true, confirmedPoster: true, parsedCount: 2, acceptedCount: 0,
        rejectedReasons: ['event-date-before-today', 'strict:missing-venue'],
    }), false);
});

test('a correctly parsed poster event rejected only because its date passed gets an explicit terminal ledger status', () => {
    assert.equal(getSourceEventLedgerStatus({
        events: [{ eventDate: '2026-10-13' }],
        rejectedEvents: [{ reason: 'event-date-before-today' }],
        acceptedEventCount: 0,
    }), 'processed_rejected');
});

test('an accepted sibling event keeps the source ledger status as processed_event', () => {
    assert.equal(getSourceEventLedgerStatus({
        events: [{ eventDate: '2026-10-13' }, { eventDate: '2026-10-25' }],
        rejectedEvents: [{ reason: 'event-date-before-today' }],
        acceptedEventCount: 1,
    }), 'processed_event');
});

test('phase one does not rerun deterministic final validation failures', () => {
    assert.equal(shouldRetryEntireEventBatchAfterValidation({
        aiRequired: true, confirmedPoster: false, parsedCount: 3, acceptedCount: 2,
        rejectedReasons: ['event-date-before-today'],
    }), false);
});

test('complete results and explicit non-events do not trigger retries', () => {
    assert.equal(shouldRetryEntireEventBatchAfterValidation({
        aiRequired: true, confirmedPoster: true, parsedCount: 2, acceptedCount: 2,
    }), false);
    assert.equal(shouldRetryEntireEventBatchAfterValidation({
        aiRequired: true, confirmedPoster: true, notEvent: true, parsedCount: 0, acceptedCount: 0,
    }), false);
});

test('exhausted unresolved items are not treated as clean-pass final records', () => {
    assert.equal(isManualParserSeenItemFinalStatus('processed_unresolved'), false);
    assert.equal(isManualParserSeenItemFinalStatus('processed_rejected'), true);
});

test('phase-two partial replacement stores the new card and retains unmatched full cards', () => {
    const screenName = 'phase_two_partial_persistence';
    const postId = 918274;
    const sourceUrl = 'https://vk.ru/wall-918274_918274';
    const now = Math.floor(Date.now() / 1000);
    const facts = [
        { index: 1, poster: true, posterConfidence: 98, imageType: 'poster', title: 'Old Full Event', dates: '24 October 2099', venue: 'Club' },
        { index: 2, poster: true, posterConfidence: 98, imageType: 'poster', title: 'New Full Event', dates: '25 October 2099', venue: 'Club' },
    ];
    upsertVkSourcePost({ screenName, postId, sourceUrl, publishedAt: now, rawText: 'supplemental body', imageUrls: [], imagePaths: [],
        contentHash: 'phase-two-partial-persistence', parseStatus: 'event', fetchedAt: now, imageVisionFacts: facts });
    const stored = { title: 'Old Full Event', eventDate: '2099-10-24', venue: 'Club', participants: 'Old artist', description: 'Old announcement', status: 'pending',
        posterImageIndex: 1, posterMatchStatus: 'verified_title_date_poster', posterVisionFacts: [facts[0]],
        sourceSegment: 'Old Full Event, 24 October 2099', isMultiAnnouncement: 1 };
    replaceVkEventsForPost({ screenName, postId, sourceUrl, imagePaths: [], events: [stored] });
    const recovered = { title: 'New Full Event', eventDate: '2099-10-25', venue: 'Club', participants: 'New artist', description: 'supplemental body', status: 'pending',
        posterImageIndex: 2, posterMatchStatus: 'verified_title_date_poster', posterVisionFacts: [facts[1]],
        sourceSegment: 'New Full Event, 25 October 2099', isMultiAnnouncement: 1 };
    replaceVkEventsForPost({ screenName, postId, sourceUrl, imagePaths: [], events: [recovered], preserveUnmatchedStoredEvents: true });
    const persisted = getVkEventsForPostRefresh({ screenName, postId });
    assert.deepEqual(persisted.map((event) => [event.title, event.eventDate]).sort(), [
        ['New Full Event', '2099-10-25'], ['Old Full Event', '2099-10-24'],
    ]);
});
