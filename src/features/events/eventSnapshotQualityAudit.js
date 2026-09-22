import { getEventPosterSafetyAssessment } from './eventProvenance.js';

function cleanPath(value) {
    return String(value ?? '').trim().replace(/\\+/gu, '/').replace(/^\.\/+/u, '');
}

function factsForEvent(event) {
    if (Array.isArray(event?.posterVisionFacts)) return event.posterVisionFacts;
    try {
        const raw = event?.posterVisionFactsJson ?? event?.poster_vision_facts_json;
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

/**
 * Read-only quality report for the ACTUAL final snapshot. Never removes cards,
 * changes AI output, patches missing metadata or merges ambiguous events.
 * No titles, source URLs, text, image URLs or paths are written to the report.
 */
export function buildEventSnapshotQualityAudit(snapshot, { maxIssues = 500 } = {}) {
    const items = Array.isArray(snapshot?.items) ? snapshot.items : [];
    const issues = [];
    let totalIssueCards = 0;
    const stats = {
        cards: items.length,
        rawCount: Number(snapshot?.rawCount || 0),
        declaredCanonicalCount: Number(snapshot?.canonicalCount || 0),
        cardsWithImages: 0,
        cardsWithSafePoster: 0,
        cardsWithUnverifiedPoster: 0,
        cardsWithMissingImageMetadata: 0,
        storedImageCount: 0,
        imagesWithPathBoundMetadata: 0,
        imagesWithoutPathBoundMetadata: 0,
        remainingDuplicateCount: snapshot?.remainingDuplicateCount == null ? null
            : (Number.isFinite(Number(snapshot.remainingDuplicateCount))
                ? Math.max(0, Math.trunc(Number(snapshot.remainingDuplicateCount))) : null),
    };
    const posterFailureReasons = {};
    const addIssue = (issue) => {
        if (issues.length < Math.max(0, Number(maxIssues) || 0)) issues.push(issue);
    };
    items.forEach((item, snapshotIndex) => {
        const event = item?.event;
        if (!event || typeof event !== 'object') return;
        const paths = [...new Set([
            ...(Array.isArray(event.imagePaths) ? event.imagePaths : []),
            ...(Array.isArray(event.verifiedImagePaths) ? event.verifiedImagePaths : []),
        ].map(cleanPath).filter(Boolean))];
        const facts = factsForEvent(event);
        const metadataPaths = new Set(facts.map((fact) => cleanPath(fact?.imagePath)).filter(Boolean));
        const noMetadata = paths.filter((path) => !metadataPaths.has(path));
        const poster = getEventPosterSafetyAssessment(event);
        if (paths.length) stats.cardsWithImages += 1;
        stats.storedImageCount += paths.length;
        stats.imagesWithPathBoundMetadata += paths.length - noMetadata.length;
        stats.imagesWithoutPathBoundMetadata += noMetadata.length;
        if (noMetadata.length) stats.cardsWithMissingImageMetadata += 1;
        if (poster.accepted) stats.cardsWithSafePoster += 1;
        else if (paths.length) {
            stats.cardsWithUnverifiedPoster += 1;
            const reason = String(poster.reason || 'unknown');
            posterFailureReasons[reason] = (posterFailureReasons[reason] || 0) + 1;
        }
        if (noMetadata.length || (paths.length && !poster.accepted)) {
            totalIssueCards += 1;
            addIssue({
                snapshotIndex,
                sourceType: String(event.sourceType || '').slice(0, 50),
                eventId: Number(event.id) || null,
                eventDate: String(event.eventDate || '').slice(0, 20),
                imageCount: paths.length,
                imagesMissingMetadata: noMetadata.length,
                posterStatus: poster.accepted ? 'verified' : String(poster.reason || 'unverified').slice(0, 100),
            });
        }
    });
    if (stats.declaredCanonicalCount !== stats.cards) {
        addIssue({ type: 'snapshot-card-count-mismatch', expected: stats.declaredCanonicalCount, actual: stats.cards });
    }
    return {
        version: 1,
        sourceRevision: String(snapshot?.sourceRevision || ''),
        verifiedAt: Number(snapshot?.verifiedAt || 0),
        stats,
        posterFailureReasons,
        issuesTruncated: Math.max(0, totalIssueCards + (stats.declaredCanonicalCount !== stats.cards ? 1 : 0) - issues.length),
        issues,
    };
}
