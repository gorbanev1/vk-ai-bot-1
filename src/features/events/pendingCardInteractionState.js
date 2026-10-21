export const OWNER_CARD_INTERACTION_TTL_MS = 15 * 60 * 1000;

export function clearPendingCardInteractionState(key, stores = []) {
    let cleared = 0;
    for (const store of stores) {
        if (store?.delete(key)) cleared += 1;
    }
    return cleared;
}

export function isPendingCardInteractionExpired(pending, now = Date.now()) {
    return !Number.isFinite(Number(pending?.expiresAt)) || now >= Number(pending.expiresAt);
}
