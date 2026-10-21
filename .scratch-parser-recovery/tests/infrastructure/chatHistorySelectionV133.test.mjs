import assert from 'node:assert/strict';

import {
    getBestStoredGroupPeerForHistoryRebind,
    saveIncomingMessage,
} from '../../src/infrastructure/database/index.js';

const stamp = Date.now() % 1000000;
const oldPeerId = 8_133_000_000 + stamp * 100;
const plausibleSmallerPeerId = oldPeerId + 1;
const unrelatedAncientPeerId = oldPeerId + 2;
const targetPeerId = oldPeerId + 3;
const userA = 913300001;
const userB = 913300002;
const now = Math.floor(Date.now() / 1000);

function addMessages(peerId, count, {
    startAt,
    senderIds = [userA],
    cmidBase = 1,
} = {}) {
    for (let index = 0; index < count; index += 1) {
        saveIncomingMessage({
            peerId,
            senderId: senderIds[index % senderIds.length],
            conversationMessageId: cmidBase + index,
            text: `peer ${peerId} msg ${index}`,
            createdAt: startAt + index,
        });
    }
}

// Нужная старая беседа: большая история, оборвалась за час до новой.
addMessages(oldPeerId, 12, {
    startAt: now - 3700,
    senderIds: [userA, userB],
});

// Другой правдоподобный чат в том же временном окне, но заметно меньше.
addMessages(plausibleSmallerPeerId, 4, {
    startAt: now - 7200,
    senderIds: [userA],
});

// Очень большой, но древний чат. Он не должен перетянуть handoff на себя.
addMessages(unrelatedAncientPeerId, 30, {
    startAt: now - 40 * 24 * 3600,
    senderIds: [userA, userB],
});

// Новая беседа уже начала записываться; есть общий участник со старой.
addMessages(targetPeerId, 2, {
    startAt: now,
    senderIds: [userA],
});

const selected = getBestStoredGroupPeerForHistoryRebind({
    platform: 'vk',
    targetPeerId,
});

assert.ok(selected);
assert.equal(selected.peerId, oldPeerId);
assert.equal(selected.selectionStrategy, 'handoff-window-most-active');
assert.equal(selected.messageCount, 12);
assert.equal(selected.sharedParticipantCount, 1);
assert.ok(selected.handoffGapSeconds >= 0);
assert.ok(selected.handoffGapSeconds < 2 * 3600);
assert.ok(selected.plausibleCandidateCount >= 2);

console.log('chat history continuity selection V133: OK');
