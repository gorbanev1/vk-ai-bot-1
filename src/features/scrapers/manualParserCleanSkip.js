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
}) {
    return Boolean(
        incrementalOnly &&
        previous &&
        typeof isFinalStatus === 'function' &&
        isFinalStatus(previous.parseStatus) &&
        String(previous.contentHash ?? '') !== '' &&
        String(previous.contentHash) === String(contentHash ?? '') &&
        String(contentHash ?? '') !== ''
    );
}
