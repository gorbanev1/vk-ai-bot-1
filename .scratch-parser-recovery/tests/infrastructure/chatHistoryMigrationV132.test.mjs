import assert from 'node:assert/strict';

import {
    getAllMessages,
    getCommunicationSettings,
    getExplicitMemories,
    getPeerHistoryMigration,
    getRecentCommunicationParticipants,
    getRecentInteractions,
    migrateStoredGroupHistory,
    saveCommunicationBanterState,
    getCommunicationBanterState,
    saveCommunicationSettings,
    saveExplicitMemory,
    saveIncomingMessage,
    saveInteraction,
    touchCommunicationParticipant,
} from '../../src/infrastructure/database/index.js';

const stamp = Date.now() % 1000000;
const sourcePeerId = 8_132_000_000 + stamp * 10;
const targetPeerId = sourcePeerId + 1;
const userId = 913200001;
const now = Math.floor(Date.now() / 1000);

saveIncomingMessage({ peerId: sourcePeerId, senderId: userId, conversationMessageId: 1, text: 'старое 1', createdAt: now - 100 });
saveIncomingMessage({ peerId: sourcePeerId, senderId: userId, conversationMessageId: 2, text: 'старое 2', createdAt: now - 90 });
saveIncomingMessage({ peerId: sourcePeerId, senderId: userId, conversationMessageId: 3, text: 'старое 3', createdAt: now - 80 });

// Новая беседа уже успела получить message_id=1 — он конфликтует со старой.
saveIncomingMessage({ peerId: targetPeerId, senderId: userId, conversationMessageId: 1, text: 'новая команда привязки', createdAt: now });
saveIncomingMessage({ peerId: targetPeerId, senderId: userId, conversationMessageId: 99, text: 'новая 99', createdAt: now });

saveExplicitMemory({
    peerId: sourcePeerId,
    authorId: userId,
    conversationMessageId: 1,
    rawMessage: 'Гигорейв запомни старое',
    memoryText: 'старое знание',
    normalizedText: 'старое знание',
    createdAt: now - 100,
});
saveInteraction({ peerId: sourcePeerId, userId, role: 'user', text: 'старый контекст', createdAt: now - 50 });

touchCommunicationParticipant({
    peerId: sourcePeerId,
    userId,
    platform: 'vk',
    externalUserId: String(userId),
    displayName: 'Старый участник',
    lastSeenAt: now - 10,
});

saveCommunicationSettings({
    peerId: sourcePeerId,
    platform: 'vk',
    externalPeerId: String(sourcePeerId),
    isGroup: true,
    warmth: 8,
    persona: 'durachila',
    activeChatEnabled: true,
    nextOutburstAt: now + 9999,
    activeChatMessageCount: 7,
    activeChatInterval: 100,
    activeChatTargetOffset: 63,
    updatedBy: userId,
    updatedAt: now - 5,
});
saveCommunicationBanterState({
    peerId: sourcePeerId,
    targetUserId: userId,
    platform: 'vk',
    externalPeerId: String(sourcePeerId),
    activeUntil: now + 1000,
    updatedAt: now - 5,
});

const result = migrateStoredGroupHistory({
    sourcePeerId,
    targetPeerId,
    platform: 'vk',
    targetExternalPeerId: String(targetPeerId),
    isGroup: true,
    createBackup: false,
    migratedAt: now,
});

assert.equal(result.migrated, true);
assert.equal(result.sourceMessageCount, 3);
assert.equal(result.targetMessageCountBefore, 2);
assert.equal(result.targetMessageCountAfter, 5);
assert.equal(result.remappedTargetMessageIds, 1);
assert.equal(getAllMessages(sourcePeerId).length, 0);

const targetMessages = getAllMessages(targetPeerId);
assert.equal(targetMessages.length, 5);
assert.ok(targetMessages.some((row) => row.text === 'старое 1' && row.conversationMessageId === 1));
assert.ok(targetMessages.some((row) => row.text === 'новая команда привязки' && row.conversationMessageId > 99));

const memories = getExplicitMemories(targetPeerId, 100);
assert.ok(memories.some((row) => row.memoryText === 'старое знание' && row.conversationMessageId === 1));
assert.equal(getExplicitMemories(sourcePeerId, 100).length, 0);

const interactions = getRecentInteractions(targetPeerId, userId, 20);
assert.ok(interactions.some((row) => row.text === 'старый контекст'));

const participants = getRecentCommunicationParticipants({
    peerId: targetPeerId,
    sinceTimestamp: 0,
    limit: 20,
});
assert.ok(participants.some((row) => row.userId === userId));

const settings = getCommunicationSettings(targetPeerId);
assert.equal(settings.externalPeerId, String(targetPeerId));
assert.equal(settings.warmth, 8);
assert.equal(settings.persona, 'durachila');
assert.equal(settings.activeChatEnabled, true);
assert.equal(settings.activeChatMessageCount, 7);
assert.equal(settings.activeChatInterval, 100);
assert.equal(settings.activeChatTargetOffset, 63);
assert.equal(settings.nextOutburstAt, now + 9999);
assert.equal(getCommunicationBanterState(sourcePeerId, userId).activeUntil, 0);

const migration = getPeerHistoryMigration({ platform: 'vk', targetPeerId });
assert.equal(migration.sourcePeerId, sourcePeerId);
assert.equal(migration.sourceMessageCount, 3);

const repeated = migrateStoredGroupHistory({
    sourcePeerId,
    targetPeerId,
    platform: 'vk',
    targetExternalPeerId: String(targetPeerId),
    createBackup: false,
});
assert.equal(repeated.migrated, false);
assert.equal(repeated.reason, 'already_migrated');

console.log('chat history migration V132: OK');
