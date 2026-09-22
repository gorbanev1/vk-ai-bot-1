/**
 * Public event ingest policy.
 *
 * A poster is source evidence, not an optional decoration. Even when the text
 * already contains title/date/venue, we still inspect eligible source images:
 * the poster can correct or complete the textual announcement and is required
 * for the final event card.
 */
import { explainStrictEventRecord } from './eventValidation.js';
import { isEventDateConsistentWithSource } from './publicPostDateEvidence.js';
import { imageFingerprintSetsReusable } from './sourcePostFingerprint.js';

export function textEventsAreComplete(events, {
    sourceText = '',
    publishedAt = 0,
    todayIso = '',
    timeZone = 'Europe/Moscow',
} = {}) {
    const list = Array.isArray(events) ? events : [];
    if (!list.length) return false;

    return list.every((event) => {
        const eventDate = String(event?.eventDate ?? '').trim();
        if (todayIso && eventDate && eventDate < todayIso) return false;
        if (!isEventDateConsistentWithSource({
            eventDate,
            sourceText,
            publishedAt,
            timeZone,
        })) return false;
        return explainStrictEventRecord(event, { sourceText }).ok;
    });
}

export function storedImageResultIsReusable({
    previousEventCount = 0,
    previousFingerprints = [],
    currentFingerprints = [],
} = {}) {
    return Number(previousEventCount) > 0 && imageFingerprintSetsReusable(
        previousFingerprints,
        currentFingerprints,
    );
}

export function visionSkipReason({
    textComplete = false,
    storedImageReusable = false,
    eligibleImageCount = 0,
    hasVision = false,
} = {}) {
    // Keep the argument for audit/backward-compatible callers, but deliberately
    // do not skip poster analysis merely because text parsing looks complete.
    void textComplete;
    if (storedImageReusable) return 'same-image-already-materialized-in-db';
    if (!eligibleImageCount) return 'no-large-poster-like-images';
    if (!hasVision) return 'vision-provider-unavailable';
    return '';
}
