import assert from 'node:assert/strict';
import { test } from 'node:test';
import { OWNER_CARD_INTERACTION_TTL_MS, clearPendingCardInteractionState, isPendingCardInteractionExpired } from '../../src/features/events/pendingCardInteractionState.js';

test('owner card actions expire after fifteen minutes', () => {
    const startedAt = 10_000;
    const pending = { expiresAt: startedAt + OWNER_CARD_INTERACTION_TTL_MS };

    assert.equal(isPendingCardInteractionExpired(pending, pending.expiresAt - 1), false);
    assert.equal(isPendingCardInteractionExpired(pending, pending.expiresAt), true);
    assert.equal(isPendingCardInteractionExpired({}, startedAt), true);
});

test('a new menu command clears all transient card states for that owner', () => {
    const ownerKey = 'telegram:peer:user';
    const otherOwnerKey = 'telegram:other:user';
    const stores = Array.from({ length: 5 }, () => new Map([[ownerKey, { expiresAt: 20_000 }], [otherOwnerKey, {}]]));

    assert.equal(clearPendingCardInteractionState(ownerKey, stores), 5);
    assert.ok(stores.every((store) => !store.has(ownerKey)));
    assert.ok(stores.every((store) => store.has(otherOwnerKey)));
});
