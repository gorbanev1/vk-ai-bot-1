function parserItemId(item) {
    return String(
        item?.itemId ?? item?.postId ?? item?.conversationMessageId ?? item?.messageId ?? item?.id ?? '',
    ).trim();
}

/**
 * Browser image recovery navigates back to source posts when captured image
 * bytes are missing. Restrict those navigations to items that were admitted
 * to model processing or explicitly queued for the poster gate.
 */
export function buildAdmittedParserImageRecoveryIds(captureRows = []) {
    const result = new Map();
    for (const row of Array.isArray(captureRows) ? captureRows : []) {
        const sourceId = String(row?.sourceId || '');
        if (!sourceId) continue;
        const ids = result.get(sourceId) || new Set();
        for (const request of Array.isArray(row?.posterGateRequests) ? row.posterGateRequests : []) {
            const id = parserItemId(request);
            if (id) ids.add(id);
        }
        for (const preview of Array.isArray(row?.prefilterPreviews) ? row.prefilterPreviews : []) {
            // aiEligible alone can still be suppressed by incremental-mode
            // dedupe. Only queued work (or an explicit media refresh) needs
            // browser bytes.
            if (!preview?.aiCandidate && !preview?.refreshKnownMediaCandidate) continue;
            const id = parserItemId(preview);
            if (id) ids.add(id);
        }
        result.set(sourceId, ids);
    }
    return result;
}

export function isAdmittedParserImageRecoveryItem(item, admittedIds) {
    const id = parserItemId(item);
    return Boolean(id && admittedIds instanceof Set && admittedIds.has(id));
}
