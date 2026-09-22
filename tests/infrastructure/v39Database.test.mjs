import assert from 'node:assert/strict';

import {
    clearCommunicationBanterState,
    getCommunicationBanterState,
    getManualUpcomingEvents,
    purgeInvalidEventRecords,
    saveCommunicationBanterState,
    saveManualEvent,
} from '../../src/infrastructure/database/index.js';

const peerId = 939000001;
const targetUserId = 939000002;

clearCommunicationBanterState(peerId, targetUserId);
const savedState = saveCommunicationBanterState({
    peerId,
    targetUserId,
    platform: 'telegram',
    externalPeerId: '-100123',
    targetExternalUserId: '123',
    targetDisplayName: 'Тест',
    activeUntil: 9999999999,
    lastAttackAt: 10,
    lastReplyAt: 11,
    replyCount: 2,
    lastBotText: 'реплика',
});
assert.equal(savedState.targetUserId, targetUserId);
assert.equal(getCommunicationBanterState(peerId, targetUserId).replyCount, 2);
clearCommunicationBanterState(peerId, targetUserId);
assert.equal(getCommunicationBanterState(peerId, targetUserId).activeUntil, 0);

const suffix = Date.now();
saveManualEvent({
    title: `Концерт строгий ${suffix}`,
    eventDate: '2099-08-22',
    eventTime: '20:00',
    venue: 'Клуб «Дизель», Воронеж',
    description: 'Концерт группы в клубе.',
    sourceText: '22 августа концерт в клубе Дизель',
});
saveManualEvent({
    title: `Ложное событие ${suffix}`,
    eventDate: '2099-08-22',
    venue: '',
    description: 'Указано только время сообщения.',
});

const cleanup = purgeInvalidEventRecords();
assert.ok(cleanup.manualEvents >= 1);
const upcoming = getManualUpcomingEvents('2099-01-01', 500);
assert.ok(upcoming.some((event) => event.title === `Концерт строгий ${suffix}`));
assert.ok(!upcoming.some((event) => event.title === `Ложное событие ${suffix}`));

console.log('v39 database tests: OK');
