import { createHash } from 'node:crypto';


function canonicalizeImageUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        if (!/^https?:$/u.test(url.protocol)) return raw;
        // CDN signatures, cache-busters and resizing query parameters change
        // frequently while the underlying source image stays identical. They
        // must not invalidate the incremental parser ledger.
        url.hash = '';
        url.search = '';
        url.hostname = url.hostname.toLowerCase();
        return url.toString();
    } catch {
        return raw.replace(/[?#].*$/u, '');
    }
}

function normalizedPayload(post, parserVersion = '', reparseEpoch = '') {
    return {
        ...(parserVersion ? { parserVersion: String(parserVersion) } : {}),
        ...(reparseEpoch ? { reparseEpoch: String(reparseEpoch) } : {}),
        text: String(post?.text ?? ''),
        imageUrls: Array.isArray(post?.imageUrls)
            ? post.imageUrls.map((item) => canonicalizeImageUrl(item))
            : [],
        publishedAt: Number(post?.publishedAt ?? 0),
    };
}

function hashPayload(payload) {
    return createHash('sha256')
        .update(JSON.stringify(payload))
        .digest('hex');
}

export function getEventReparseEpoch(env = process.env) {
    return String(env?.GIGORAVE_EVENT_REPARSE_EPOCH ?? '').trim();
}

export function createStableSourceContentHash(post, {
    reparseEpoch = getEventReparseEpoch(),
} = {}) {
    return hashPayload(normalizedPayload(post, '', reparseEpoch));
}

export function createLegacyVersionedSourceContentHash(post, parserVersion) {
    return hashPayload(normalizedPayload(post, parserVersion, ''));
}

export function sourceContentHashMatches(previousHash, post, {
    legacyParserVersions = [],
    reparseEpoch = getEventReparseEpoch(),
} = {}) {
    const previous = String(previousHash ?? '').trim();
    if (!previous) return false;

    const stable = createStableSourceContentHash(post, { reparseEpoch });
    if (previous === stable) return true;

    // Full reparsing is now explicit. A release/version bump alone is never a
    // reason to spend AI tokens on identical source content again.
    if (reparseEpoch) return false;

    return legacyParserVersions.some((version) => (
        previous === createLegacyVersionedSourceContentHash(post, version)
    ));
}
