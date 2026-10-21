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
