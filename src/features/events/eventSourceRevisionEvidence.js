import { createHash } from 'node:crypto';

/**
 * Snapshot freshness must react to a Vision backfill even when image paths,
 * event text and posterMatchStatus remain unchanged. Values are returned for
 * hashing only; metadata, private source text and URLs are never logged here.
 */
export function eventPosterRevisionEvidence(event = {}) {
    const paths = Array.isArray(event?.verifiedImagePaths) ? event.verifiedImagePaths : [];
    let facts = Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : null;
    if (!facts) {
        const stored = event?.posterVisionFactsJson ?? event?.poster_vision_facts_json;
        try {
            const parsed = typeof stored === 'string' ? JSON.parse(stored) : stored;
            facts = Array.isArray(parsed) ? parsed : [];
        } catch {
            facts = [];
        }
    }
    // DB order changes alone must not trigger an unnecessary full AI rebuild.
    const normalizedFacts = facts.map((fact) => JSON.stringify(fact) ?? 'null')
        .sort((left, right) => left.localeCompare(right, 'en'));
    const metadataHash = normalizedFacts.length
        ? createHash('sha256').update(JSON.stringify(normalizedFacts)).digest('hex')
        : '';
    return {
        verifiedImagePaths: paths.map((path) => String(path ?? '')).sort(),
        posterVisionMetadataHash: metadataHash,
    };
}
