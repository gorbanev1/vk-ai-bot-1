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

const TERMINAL_VISION_STATUSES = new Set(['metadata_found', 'metadata_not_found']);

function hasStructuredTerminalVisionOutcome(fact) {
    if (!fact || typeof fact !== 'object') return false;
    const status = String(fact.visionStatus || '').trim().toLowerCase();
    if (!TERMINAL_VISION_STATUSES.has(status)) return false;
    const hasMetadata = [
        fact.title, fact.dates, fact.time, fact.venue, fact.city, fact.locality,
        fact.address, fact.participants, fact.price, fact.age, fact.program,
        fact.tags, fact.recognizedText,
    ].some((value) => String(value ?? '').trim());
    if (status === 'metadata_found') return hasMetadata;

    // A no-metadata result is terminal only if Vision returned a structured
    // classification/OCR outcome. A status flag on its own can be left behind
    // by legacy or interrupted writes and must be retried.
    const text = String(fact.text || '');
    const fields = [...text.matchAll(
        /(?:^|[\n;])[ \t]*(?:Тип изображения|Тип|Image type|Это афиша события|Афиша|Poster|Распознанный текст|OCR|Текст на изображении|Причина|Почему|Reason)[ \t]*:/giu,
    )];
    const hasOutcome = /(?:^|[\n;])[ \t]*(?:Это афиша события|Афиша|Poster|Распознанный текст|OCR|Текст на изображении)[ \t]*:/iu.test(text);
    return fact.visionInspected === true && fields.length >= 2 && hasOutcome;
}

export function pendingVisionImageIndexes(imageCount, facts = []) {
    const count = Math.max(0, Math.min(1000, Number(imageCount) || 0));
    const terminal = new Set((Array.isArray(facts) ? facts : [])
        .filter(hasStructuredTerminalVisionOutcome)
        .map((fact) => Number(fact?.index || 0))
        .filter((index) => Number.isInteger(index) && index > 0));
    return Array.from({ length: count }, (_, offset) => offset + 1)
        .filter((index) => !terminal.has(index));
}

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
