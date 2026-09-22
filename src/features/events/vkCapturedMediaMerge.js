const DEFAULT_MAX_IMAGES = 12;

function normalize(items) {
    return (Array.isArray(items) ? items : [])
        .map((item) => ({
            ...item,
            url: String(item?.url || '').trim(),
            attachmentKey: String(item?.attachmentKey || '').trim().toLowerCase(),
        }))
        .filter((item) => /^https?:\/\//iu.test(item.url));
}

/**
 * Merge immutable-snapshot media with live rendered media without losing the
 * attachment identity. VK occasionally serializes a stale thumbnail `src` for
 * one cell of a multi-photo grid while live `currentSrc` already points at the
 * correct photo. When both passes describe the same `photo<owner>_<id>`, the
 * live URL wins but snapshot ordering/provenance is retained.
 */
export function mergeVkCapturedImageMedia(exactMedia, renderedMedia, {
    limit = DEFAULT_MAX_IMAGES,
    strictIdentity = false,
} = {}) {
    const exact = normalize(exactMedia);
    const rendered = normalize(renderedMedia);
    const renderedByAttachment = new Map(
        rendered
            .filter((item) => item.attachmentKey)
            .map((item) => [item.attachmentKey, item]),
    );
    const output = [];
    const seen = new Set();
    const add = (item) => {
        if (!item?.url) return;
        const identity = item.attachmentKey
            ? `attachment:${item.attachmentKey}`
            : `url:${item.url}`;
        if (seen.has(identity)) return;
        seen.add(identity);
        output.push(item);
    };

    for (const item of exact) {
        add(item.attachmentKey && renderedByAttachment.has(item.attachmentKey)
            ? { ...item, ...renderedByAttachment.get(item.attachmentKey), snapshotUrl: item.url }
            : item);
    }
    // Immutable snapshot owns membership and order. Live DOM may only upgrade
    // currentSrc for the same stable photo identity. If exact saw no media,
    // rendered media remains the existing recovery fallback for that same item.
    if (!strictIdentity || exact.length === 0) {
        for (const item of rendered) add(item);
    }

    const safeLimit = Math.max(1, Math.min(
        DEFAULT_MAX_IMAGES,
        Number(limit) || DEFAULT_MAX_IMAGES,
    ));
    return output.slice(0, safeLimit);
}
