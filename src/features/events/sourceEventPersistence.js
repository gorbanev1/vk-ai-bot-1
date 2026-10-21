/**
 * Conservative persistence policy for already accepted source events.
 *
 * A repeat scrape can temporarily lose lazy-loaded media, hit a network/AI
 * failure or receive a partial DOM/API payload. An empty parse from a source
 * that previously produced accepted events is therefore not evidence that the
 * event disappeared. Expiry/moderation are the destructive paths; routine
 * reparsing is intentionally non-destructive on an empty result.
 */
export function shouldPreserveStoredEventsOnEmptyReparse({
    previousEventCount = 0,
    acceptedEventCount = 0,
} = {}) {
    return Number(previousEventCount) > 0 && Number(acceptedEventCount) === 0;
}

/** A poster-led phase-two response has already made an explicit event decision.
 * Final field validation is deterministic, so rejected cards are terminal; only
 * an invalid/missing AI response (zero parsed events) should be retried. Phase 1
 * keeps its all-or-nothing cardinality retry contract. */
export function shouldRetryEntireEventBatchAfterValidation({
    aiRequired = false,
    notEvent = false,
    confirmedPoster = false,
    parsedCount = 0,
    acceptedCount = 0,
    rejectedReasons = [],
} = {}) {
    const parsed = Number(parsedCount);
    const accepted = Number(acceptedCount);
    // At this point parsedCount contains structurally valid AI cards. Any
    // reduction is caused by deterministic final validation, so replaying the
    // same model call cannot fix it. Transport/structure failures are handled
    // earlier by selectPublicAiEventsForPersistence as unresolved.
    if (parsed > 0 && accepted < parsed) return false;
    return Boolean(aiRequired && !notEvent && Number(parsedCount) !== Number(acceptedCount) &&
        (!confirmedPoster || Number(acceptedCount) === 0));
}

export function getSourceEventLedgerStatus({ events = [], rejectedEvents = [], acceptedEventCount = 0 } = {}) {
    if (Number(acceptedEventCount) > 0) return 'processed_event';
    const parsedCount = Array.isArray(events) ? events.length : 0;
    const rejected = Array.isArray(rejectedEvents) ? rejectedEvents : [];
    if (parsedCount > 0 && rejected.length >= parsedCount) {
        return 'processed_rejected';
    }
    return 'processed_not_event';
}

/**
 * A phase-two pass may return fewer cards than an earlier complete pass when
 * the model emits an incomplete schedule or a poster binding is transiently
 * unavailable.  A non-empty but smaller result must not erase the source's
 * remaining verified cards.  This predicate is intentionally independent of
 * the model/provider so it applies equally to VK, Telegram and chats.
 */
export function shouldPreserveStoredEventsOnPartialReparse({
    previousEventCount = 0,
    acceptedEventCount = 0,
    phaseTwo = false,
} = {}) {
    return Boolean(phaseTwo) && Number(previousEventCount) > 0 &&
        Number(acceptedEventCount) > 0 &&
        Number(acceptedEventCount) < Number(previousEventCount);
}
