import assert from 'node:assert/strict';

import {
    cleanupDisabledCommunicationAutonomy,
    clearCommunicationBanterStatesForPeer,
    getCommunicationBanterState,
    getCommunicationSettings,
    getDueCommunicationSettings,
    getRecentCommunicationParticipants,
    saveCommunicationBanterState,
    saveCommunicationSettings,
    rescheduleCommunicationOutburstsWithinWindow,
    touchCommunicationParticipant,
    updateCommunicationOutburstSchedule,
    updateActiveCommunicationState,
} from '../../src/infrastructure/database/index.js';

const peerId = 8_800_000_038;
const now = Math.floor(Date.now() / 1000);

let saved = saveCommunicationSettings({
    peerId,
    platform: 'telegram',
    externalPeerId: '-1001234567890',
    isGroup: true,
    warmth: 9,
    persona: 'durachila',
    nextOutburstAt: now - 1,
    activeChatEnabled: true,
    updatedBy: 123,
    updatedAt: now,
});

assert.equal(saved.warmth, 9);
assert.equal(saved.persona, 'durachila');
assert.equal(saved.isGroup, true);
assert.equal(saved.externalPeerId, '-1001234567890');

const loaded = getCommunicationSettings(peerId);
assert.equal(loaded.platform, 'telegram');
assert.equal(loaded.nextOutburstAt, now - 1);

const due = getDueCommunicationSettings(now, 100)
    .find((item) => item.peerId === peerId);
assert.ok(due);

const inactivePeerId = peerId + 10;
saveCommunicationSettings({
    peerId: inactivePeerId,
    platform: 'vk',
    externalPeerId: String(inactivePeerId),
    isGroup: true,
    warmth: 5,
    persona: 'bydlo',
    nextOutburstAt: now - 1,
    activeChatEnabled: false,
    updatedBy: 123,
    updatedAt: now,
});
assert.equal(
    getDueCommunicationSettings(now, 100)
        .some((item) => item.peerId === inactivePeerId),
    false,
);

touchCommunicationParticipant({
    peerId,
    userId: 9001,
    platform: 'telegram',
    externalUserId: '9001',
    displayName: '@tester',
    lastSeenAt: now,
});

const participants = getRecentCommunicationParticipants({
    peerId,
    sinceTimestamp: now - 60,
    limit: 10,
});
assert.equal(participants.length >= 1, true);
assert.equal(participants[0].displayName, '@tester');

saved = updateCommunicationOutburstSchedule({
    peerId,
    nextOutburstAt: now + 3600,
    lastOutburstAt: now,
    lastTargetUserId: 9001,
    updatedAt: now,
});
assert.equal(saved.lastTargetUserId, 9001);
assert.equal(saved.nextOutburstAt, now + 3600);


saved = updateActiveCommunicationState({
    peerId,
    enabled: true,
    messageCount: 7,
    interval: 100,
    targetOffset: 63,
    lastReplyAt: now - 5,
    updatedBy: 777,
    updatedAt: now,
});
assert.equal(saved.activeChatEnabled, true);
assert.equal(saved.activeChatMessageCount, 7);
assert.equal(saved.activeChatInterval, 100);
assert.equal(saved.activeChatTargetOffset, 63);
assert.equal(saved.activeChatLastReplyAt, now - 5);

saved = saveCommunicationSettings({
    peerId,
    platform: saved.platform,
    externalPeerId: saved.externalPeerId,
    isGroup: saved.isGroup,
    warmth: 2,
    persona: saved.persona,
    nextOutburstAt: saved.nextOutburstAt,
    lastOutburstAt: saved.lastOutburstAt,
    lastTargetUserId: saved.lastTargetUserId,
    updatedBy: 778,
    updatedAt: now,
});
assert.equal(saved.activeChatEnabled, true);
assert.equal(saved.activeChatMessageCount, 7);
assert.equal(saved.activeChatInterval, 100);
assert.equal(saved.activeChatTargetOffset, 63);


const inactiveLongPeerId = peerId + 2;
saveCommunicationSettings({
    peerId: inactiveLongPeerId,
    platform: 'vk',
    externalPeerId: String(inactiveLongPeerId),
    isGroup: true,
    warmth: 5,
    persona: 'bydlo',
    nextOutburstAt: now + 3 * 60 * 60,
    activeChatEnabled: false,
    activeChatMessageCount: 6,
    activeChatLastReplyAt: now - 10,
    updatedBy: 123,
    updatedAt: now,
});
saveCommunicationBanterState({
    peerId: inactiveLongPeerId,
    targetUserId: 9901,
    platform: 'vk',
    externalPeerId: String(inactiveLongPeerId),
    activeUntil: now + 600,
    updatedAt: now,
});

const longPeerId = peerId + 1;
saveCommunicationSettings({
    peerId: longPeerId,
    platform: 'vk',
    externalPeerId: String(longPeerId),
    isGroup: true,
    warmth: 5,
    persona: 'bydlo',
    nextOutburstAt: now + 3 * 60 * 60,
    activeChatEnabled: true,
    updatedBy: 123,
    updatedAt: now,
});
const rescheduledCount = rescheduleCommunicationOutburstsWithinWindow({
    now,
    minDelaySeconds: 60,
    maxDelaySeconds: 60 * 60,
});
assert.equal(rescheduledCount >= 1, true);
const rescheduled = getCommunicationSettings(longPeerId);
assert.equal(rescheduled.nextOutburstAt >= now + 60, true);
assert.equal(rescheduled.nextOutburstAt <= now + 60 * 60, true);
assert.equal(
    getCommunicationSettings(inactiveLongPeerId).nextOutburstAt,
    now + 3 * 60 * 60,
);

const cleanup = cleanupDisabledCommunicationAutonomy({ updatedAt: now + 1 });
assert.equal(cleanup.settings >= 1, true);
assert.equal(cleanup.banter >= 1, true);
const inactiveCleaned = getCommunicationSettings(inactiveLongPeerId);
assert.equal(inactiveCleaned.nextOutburstAt, 0);
assert.equal(inactiveCleaned.activeChatMessageCount, 0);
assert.equal(inactiveCleaned.activeChatLastReplyAt, 0);
assert.equal(
    getCommunicationBanterState(inactiveLongPeerId, 9901).activeUntil,
    0,
);

saveCommunicationBanterState({
    peerId,
    targetUserId: 9001,
    platform: 'telegram',
    externalPeerId: '-1001234567890',
    activeUntil: now + 600,
    updatedAt: now,
});
saveCommunicationBanterState({
    peerId,
    targetUserId: 9002,
    platform: 'telegram',
    externalPeerId: '-1001234567890',
    activeUntil: now + 600,
    updatedAt: now,
});
assert.equal(getCommunicationBanterState(peerId, 9001).activeUntil > 0, true);
assert.equal(clearCommunicationBanterStatesForPeer(peerId), 2);
assert.equal(getCommunicationBanterState(peerId, 9001).activeUntil, 0);
assert.equal(getCommunicationBanterState(peerId, 9002).activeUntil, 0);

console.log('communicationStyle database tests: OK');
