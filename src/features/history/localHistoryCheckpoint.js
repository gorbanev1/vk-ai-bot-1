export const LOCAL_HISTORY_CHECKPOINT_VERSION = 2;

function normalizePeerIds(peerIds) {
    return [...new Set((Array.isArray(peerIds) ? peerIds : [peerIds])
        .map(Number)
        .filter((value) => Number.isSafeInteger(value)))]
        .sort((left, right) => left - right);
}

export function createLocalHistoryCheckpointSignature({
    peerIds = [],
    sourceInventoryHash = '',
    coverageMaxCmid = 0,
    coverageMessageCount = 0,
    coverageHash = '',
} = {}) {
    return JSON.stringify({
        version: LOCAL_HISTORY_CHECKPOINT_VERSION,
        peerIds: normalizePeerIds(peerIds),
        sourceInventoryHash: String(sourceInventoryHash || ''),
        coverageMaxCmid: Math.max(0, Number(coverageMaxCmid) || 0),
        coverageMessageCount: Math.max(0, Number(coverageMessageCount) || 0),
        coverageHash: String(coverageHash || ''),
    });
}

export function parseLocalHistoryCheckpointSignature(value) {
    if (!value) return null;
    try {
        const parsed = JSON.parse(String(value));
        if (Number(parsed?.version) !== LOCAL_HISTORY_CHECKPOINT_VERSION) return null;
        if (!Array.isArray(parsed?.peerIds)) return null;
        if (!String(parsed?.sourceInventoryHash || '')) return null;
        if (!String(parsed?.coverageHash || '')) return null;
        return {
            version: LOCAL_HISTORY_CHECKPOINT_VERSION,
            peerIds: normalizePeerIds(parsed.peerIds),
            sourceInventoryHash: String(parsed.sourceInventoryHash || ''),
            coverageMaxCmid: Math.max(0, Number(parsed.coverageMaxCmid) || 0),
            coverageMessageCount: Math.max(0, Number(parsed.coverageMessageCount) || 0),
            coverageHash: String(parsed.coverageHash || ''),
        };
    } catch {
        return null;
    }
}

export function validateLocalHistoryCheckpoint({
    storedSignature = '',
    peerIds = [],
    sourceInventoryHash = '',
    currentCoverage = null,
    currentMessageCount = 0,
    targetMessageCount = 0,
    force = false,
} = {}) {
    if (force) return { valid: false, reason: 'forced' };
    const stored = parseLocalHistoryCheckpointSignature(storedSignature);
    if (!stored) return { valid: false, reason: 'legacy-or-invalid-checkpoint' };

    const normalizedPeers = normalizePeerIds(peerIds);
    if (JSON.stringify(stored.peerIds) !== JSON.stringify(normalizedPeers)) {
        return { valid: false, reason: 'peer-map-changed', stored };
    }
    if (stored.sourceInventoryHash !== String(sourceInventoryHash || '')) {
        return { valid: false, reason: 'source-inventory-changed', stored };
    }
    if (Number(currentMessageCount || 0) < Number(targetMessageCount || 0)) {
        return { valid: false, reason: 'message-count-regressed', stored };
    }

    const coverage = currentCoverage || {};
    if (Number(coverage.maxCmid || 0) < Number(stored.coverageMaxCmid || 0)) {
        return { valid: false, reason: 'coverage-ceiling-regressed', stored };
    }
    const currentCoveredCount = Number(coverage.coveredCount || 0);
    const storedCoveredCount = Number(stored.coverageMessageCount || 0);
    if (currentCoveredCount < storedCoveredCount) {
        return { valid: false, reason: 'coverage-count-regressed', stored };
    }
    if (
        currentCoveredCount === storedCoveredCount &&
        String(coverage.coverageHash || '') !== stored.coverageHash
    ) {
        return { valid: false, reason: 'coverage-hash-mismatch', stored };
    }

    // Filling previously missing rows below the stored CMID ceiling is an
    // improvement, not evidence that all immutable backup snapshots must be
    // rescanned again. Source inventory is checked above; if it did not change
    // and coverage only grew, the previous backup scan remains valid.
    return {
        valid: true,
        reason: currentCoveredCount > storedCoveredCount
            ? 'checkpoint-valid-coverage-growth'
            : 'checkpoint-valid',
        stored,
    };
}
