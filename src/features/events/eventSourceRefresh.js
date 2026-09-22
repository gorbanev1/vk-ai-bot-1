import { getEventPosterSafetyAssessment } from './eventProvenance.js';
import { evaluatePosterFactForEvent, scorePosterFactMetadataQuality } from './eventPosterMatching.js';

/**
 * Pure helpers for refreshing a stored event from a newer copy of the same source.
 * The caller is responsible for proving source identity (usually canonical URL equality).
 */
function clean(value, maximum = 6000) {
    return String(value ?? '')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, maximum);
}

function tokenSet(value) {
    return new Set(clean(value, 5000)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/u)
        .filter((token) => token.length >= 3)
        .slice(0, 100));
}

export function sourceRefreshTokenSimilarity(left, right) {
    const a = tokenSet(left);
    const b = tokenSet(right);
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const token of a) {
        if (b.has(token)) intersection += 1;
    }
    return intersection / Math.max(1, Math.min(a.size, b.size));
}

function sourceRefreshStartMinute(value) {
    const match = String(value ?? '').match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u);
    return match ? Number(match[1]) * 60 + Number(match[2]) : null;
}

export function selectFreshEventForStoredEvent(existing, freshEvents) {
    const candidates = Array.isArray(freshEvents) ? freshEvents.filter(Boolean) : [];
    if (!candidates.length) return null;

    const existingDate = clean(existing?.eventDate, 32);
    const existingTitle = clean(existing?.title || existing?.participants, 1200);
    const existingMinute = sourceRefreshStartMinute(
        [existing?.eventTime, existing?.timeLabel].filter(Boolean).join(' '),
    );
    const scored = candidates.map((event, index) => {
        const eventDate = clean(event?.eventDate, 32);
        const title = clean(event?.title || event?.participants, 1200);
        const sameDate = Boolean(existingDate && eventDate && existingDate === eventDate);
        const titleSimilarity = sourceRefreshTokenSimilarity(existingTitle, title);
        const venueSimilarity = sourceRefreshTokenSimilarity(existing?.venue, event?.venue);
        const eventMinute = sourceRefreshStartMinute(
            [event?.eventTime, event?.timeLabel].filter(Boolean).join(' '),
        );
        const timeKnownBoth = existingMinute !== null && eventMinute !== null;
        const timeDelta = timeKnownBoth ? Math.abs(existingMinute - eventMinute) : null;
        const timeCompatible = !timeKnownBoth || timeDelta <= 30;
        const score = (sameDate ? 10 : 0) +
            titleSimilarity * 6 +
            venueSimilarity * 2 +
            (timeKnownBoth && timeCompatible ? 2 : 0);
        return {
            event,
            index,
            score,
            sameDate,
            titleSimilarity,
            venueSimilarity,
            timeKnownBoth,
            timeCompatible,
        };
    }).sort((left, right) => right.score - left.score || left.index - right.index);

    const best = scored[0];
    const runnerUp = scored[1];
    if (!best) return null;

    /*
     * V147: source URL can be a monthly digest containing many events. A single
     * fresh candidate must never be blindly written into every row that shares
     * that parent URL. Require actual event identity.
     */
    const strongTitle = best.titleSimilarity >= 0.55;
    const scheduleIdentity = best.sameDate &&
        best.timeCompatible &&
        best.venueSimilarity >= 0.60 &&
        best.titleSimilarity >= 0.20;
    if (!strongTitle && !scheduleIdentity) return null;
    if (!best.sameDate && best.titleSimilarity < 0.72) return null;
    if (best.timeKnownBoth && !best.timeCompatible && best.titleSimilarity < 0.90) return null;
    if (runnerUp && best.score - runnerUp.score < 0.35 && !strongTitle) return null;
    return best.event;
}

function isGeneratedFallbackPath(value) {
    const path = clean(value, 2000).replace(/\\+/gu, '/').toLowerCase();
    return /(?:^|\/)event_message_cards\//u.test(path) || /-event-\d+\.(?:png|jpe?g|webp)$/u.test(path);
}

function posterPathIsGenerated(value) {
    const path = clean(value, 2000).replace(/\\+/gu, '/').toLowerCase();
    return /(?:^|\/)event_message_cards\//u.test(path) ||
        /(?:^|\/)event_generated_fallbacks\//u.test(path) ||
        /-event-\d+\.(?:png|jpe?g|webp)$/u.test(path);
}

/**
 * Rank a concrete source image without making an unverified image publishable.
 * A path-bound, metadata-compatible poster gets a large safety bonus. Metadata
 * on an otherwise unverified candidate still lets it repair an empty/weak
 * stored image, while an unverified candidate can never evict a confirmed one.
 */
function posterPathQuality(event, path) {
    const candidatePath = clean(path, 2000);
    if (!candidatePath || posterPathIsGenerated(candidatePath)) return -Infinity;

    const safety = getEventPosterSafetyAssessment(event);
    const selectedIndex = Number(event?.posterImageIndex || 0);
    const facts = Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : [];
    const selectedFact = facts.find((fact) => Number(fact?.index || 0) === selectedIndex) || null;
    const pathMatchesFact = selectedFact && clean(selectedFact.imagePath, 2000) === candidatePath;
    const metadataQuality = selectedFact ? scorePosterFactMetadataQuality(selectedFact) : 0;
    const match = selectedFact ? evaluatePosterFactForEvent(event, selectedFact) : null;

    if (safety.accepted && (!safety.boundPath || safety.boundPath === candidatePath)) {
        return 1000 + Number(safety.metadataQuality || metadataQuality || 0) +
            Math.max(0, Number(safety.match?.score || match?.score || 0)) / 10;
    }
    if (pathMatchesFact) {
        return metadataQuality + (match?.accepted ? Math.max(0, Number(match.score || 0)) / 10 : 0);
    }
    // A real image with no Vision facts remains a valid refresh candidate for a
    // text-only/legacy card. It is deliberately weaker than any fact-backed
    // candidate and cannot displace a safe poster.
    return 1;
}

function posterFields(event) {
    if (!event || typeof event !== 'object') return {};
    const fields = {};
    for (const key of [
        'imageIndexes', 'posterImageIndex', 'posterMatchStatus', 'posterMatchReason',
        'posterVisionFacts', 'posterReviewCandidates', 'verifiedImagePaths',
    ]) {
        if (Object.prototype.hasOwnProperty.call(event, key)) fields[key] = event[key];
    }
    return fields;
}

function mergePaths(fresh, existing, freshEvent = {}, existingEvent = {}) {
    const freshPaths = [...new Set(
        (Array.isArray(fresh) ? fresh : [])
            .map((value) => clean(value, 2000))
            .filter(Boolean),
    )];
    const verifiedFreshPaths = freshPaths.filter((path) => !isGeneratedFallbackPath(path));
    const storedPaths = [...new Set(
        (Array.isArray(existing) ? existing : [])
            .map((value) => clean(value, 2000))
            .filter(Boolean),
    )].slice(0, 10);
    if (!verifiedFreshPaths.length) return storedPaths;
    if (!storedPaths.length) return verifiedFreshPaths.slice(0, 10);

    const freshPath = verifiedFreshPaths[0];
    const existingPath = storedPaths.find((path) => !posterPathIsGenerated(path)) || storedPaths[0];
    const freshQuality = posterPathQuality(freshEvent, freshPath);
    const existingQuality = posterPathQuality(existingEvent, existingPath);

    // A confirmed/path-bound poster is durable until a fresh candidate is also
    // confirmed and materially stronger. This prevents a weak reparse from
    // making a previously correct card lose its image.
    if (existingQuality >= 1000 && freshQuality < 1000) return [existingPath];
    if (existingQuality >= 1000 && freshQuality < existingQuality + 5) return [existingPath];
    // For an unverified card, prefer the candidate carrying more Vision facts;
    // equal-quality fresh media keeps the historical refresh behaviour.
    if (freshQuality >= existingQuality) return [freshPath];
    return [existingPath];
}

function preferFresh(fresh, existing, maximum = 6000) {
    const next = clean(fresh, maximum);
    return next || clean(existing, maximum);
}

export function mergeStoredEventWithFreshSource(existing = {}, fresh = {}, {
    sourceUrl = '',
    parseMethod = 'source_refresh_v140',
} = {}) {
    const freshTime = clean(fresh?.eventTime, 32);
    const existingTime = clean(existing?.eventTime, 32);
    const mergedImagePaths = mergePaths(fresh?.imagePaths, existing?.imagePaths, fresh, existing);
    const freshPath = (Array.isArray(fresh?.imagePaths) ? fresh.imagePaths : [])
        .map((value) => clean(value, 2000)).find((value) => value && !posterPathIsGenerated(value)) || '';
    const existingPath = (Array.isArray(existing?.imagePaths) ? existing.imagePaths : [])
        .map((value) => clean(value, 2000)).find((value) => value && !posterPathIsGenerated(value)) || '';
    const selectedPosterFields = mergedImagePaths[0] && mergedImagePaths[0] === existingPath
        ? posterFields(existing)
        : mergedImagePaths[0] && mergedImagePaths[0] === freshPath
            ? posterFields(fresh)
            : {};
    return {
        ...existing,
        ...fresh,
        ...selectedPosterFields,
        title: preferFresh(fresh?.title, existing?.title, 500),
        eventDate: preferFresh(fresh?.eventDate, existing?.eventDate, 32),
        eventTime: freshTime || existingTime || null,
        venue: preferFresh(fresh?.venue, existing?.venue, 500),
        participants: preferFresh(fresh?.participants, existing?.participants, 2000),
        price: preferFresh(fresh?.price, existing?.price, 700),
        description: preferFresh(fresh?.description, existing?.description, 6000),
        evidence: preferFresh(fresh?.evidence, existing?.evidence, 1000),
        sourceUrl: clean(sourceUrl || fresh?.sourceUrl || existing?.sourceUrl, 2000),
        imagePaths: mergedImagePaths,
        parseMethod: clean(fresh?.parseMethod || parseMethod, 200) || parseMethod,
        status: 'approved',
    };
}
