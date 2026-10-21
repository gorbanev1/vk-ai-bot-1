/**
 * A near-duplicate from another occurrence or a stale/failed ledger record
 * is never enough to skip a source record. The caller supplies the actual
 * database's final-status predicate to avoid diverging status definitions.
 */
export function shouldSkipUnchangedCapturedItem({
    incrementalOnly,
    previous,
    contentHash,
    isFinalStatus,
    current = null,
    previousRows = null,
    similarityThreshold = 1,
    findProcessedNearDuplicate = null,
}) {
    if (!incrementalOnly || typeof isFinalStatus !== 'function') return false;
    if (previous && isFinalStatus(previous.parseStatus) && String(previous.contentHash ?? '') !== '' &&
        String(previous.contentHash) === String(contentHash ?? '') && String(contentHash ?? '') !== '') return true;
    const threshold = Math.max(0, Math.min(1, Number(similarityThreshold) || 1));
    if (threshold >= 1 || typeof findProcessedNearDuplicate !== 'function' || !current || !Array.isArray(previousRows)) return false;
    return Boolean(findProcessedNearDuplicate(current, previousRows, { threshold }));
}
