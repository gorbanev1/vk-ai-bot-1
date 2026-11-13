/**
 * A migrated chat may have legacy paid state under the same canonical
 * (sourcePeerId, conversationMessageId) as an unrelated later native message.
 * Preserve the immutable paid row and version only a genuinely reused ID.
 * Content-only edits of the same timestamp remain paid (no double billing).
 */
export function resolveHierarchyMessageStateKey(legacyKey, createdAt, contentHash, paidState) {
    const key=String(legacyKey || '');
    const time=Number(createdAt || 0);
    const oldTime=Number(paidState?.createdAt || 0);
    if (!paidState || !Number.isSafeInteger(time) || time<=0 ||
        !Number.isSafeInteger(oldTime) || oldTime<=0 ||
        Math.abs(time-oldTime)<300 ||
        String(paidState.contentHash || '')===String(contentHash || '')) return key;
    // A different original message with a reused conversation ID.
    // Stable across text edits: the original VK creation timestamp is fixed.
    // Content hash is used to detect legacy collisions, not as a volatile key.
    return key + ':reused:' + time;
}
