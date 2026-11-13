import assert from 'node:assert/strict';
import {
    getAllUpcomingEventRecordsForDedupe,
    getEventDedupeRegistryStats,
    listEventDedupeGroups,
    breakEventDedupeGroup,
    getManualUpcomingEvents,
    replaceEventDedupeRegistry,
    saveManualEvent,
} from '../../src/infrastructure/database/index.js';
import {
    EVENT_VERIFIED_SNAPSHOT_VERSION,
    normalizeVerifiedSnapshot,
} from '../../src/features/events/eventVerifiedSnapshot.js';
import { EVENT_DEDUPE_ALGORITHM_VERSION } from '../../src/features/events/eventDuplicateResolution.js';

assert.equal(EVENT_VERIFIED_SNAPSHOT_VERSION, 8);
assert.equal(normalizeVerifiedSnapshot({ version: 1, items: [] }), null);
assert.equal(normalizeVerifiedSnapshot({ version: 2, items: [] }), null);
assert.equal(normalizeVerifiedSnapshot({
    version: 8,
    dedupeAlgorithmVersion: EVENT_DEDUPE_ALGORITHM_VERSION,
    sourceRevision: 'test-revision',
    items: [],
})?.version, 8);

const suffix = `${Date.now()}-${Math.floor(Math.random() * 100000)}`;
const eventDate = '2099-08-22';
const firstId = saveManualEvent({
    title: `V103 REGISTRY ${suffix}`,
    eventDate,
    eventTime: '17:00',
    venue: 'Тестовая площадка',
    description: 'Первый источник.',
});
const secondId = saveManualEvent({
    title: `V103 REGISTRY ${suffix}`,
    eventDate,
    eventTime: '17:00',
    venue: 'Тестовая площадка',
    description: 'Второй источник с дополнительными фактами.',
});

const before = getAllUpcomingEventRecordsForDedupe({ fromDate: '2099-01-01' })
    .filter((event) => event.id === firstId || event.id === secondId);
assert.equal(before.length, 2);

const scope = `test-v103-${suffix}`;
const registry = replaceEventDedupeRegistry([{
    groupKey: `manual-${firstId}-${secondId}`,
    keepKey: `manual:${firstId}`,
    canonical: {
        title: `V103 REGISTRY ${suffix}`,
        eventDate,
        displayDate: '22 августа 2099',
        eventTime: '17:00',
        timeLabel: '17:00',
        venue: 'Тестовая площадка',
        participants: 'Группа А, Группа Б',
        description: 'Объединённая canonical-карточка.',
        eventDays: [{ date: eventDate, timeLabel: '17:00', venue: 'Тестовая площадка' }],
    },
    members: [
        { ref: { sourceType: 'manual', id: firstId } },
        { ref: { sourceType: 'manual', id: secondId } },
    ],
}], { scope });

assert.equal(registry.groups, 1);
assert.equal(registry.members, 2);
assert.equal(registry.duplicateMembers, 1);
assert.deepEqual(getEventDedupeRegistryStats(scope), {
    scope,
    groups: 1,
    members: 2,
    duplicateMembers: 1,
});
assert.equal(listEventDedupeGroups(scope)[0].groupKey, `manual-${firstId}-${secondId}`);

const after = getManualUpcomingEvents('2099-01-01', 500)
    .filter((event) => event.id === firstId || event.id === secondId);
assert.equal(after.length, 2, 'V103 registry must not destroy raw source evidence');

const purgeId = saveManualEvent({
    title: `V103 PURGE ${suffix}`,
    eventDate,
    eventTime: '17:00',
    venue: 'Тестовая площадка',
    description: 'Дубликат для hard purge.',
});
const purgeResult = replaceEventDedupeRegistry([{
    groupKey: `manual-purge-${firstId}-${purgeId}`,
    keepKey: `manual:${firstId}`,
    keep: { sourceType: 'manual', id: firstId },
    canonical: { title: `V103 REGISTRY ${suffix}`, eventDate, eventTime: '17:00', venue: 'Тестовая площадка' },
    members: [{ ref: { sourceType: 'manual', id: firstId } }, { ref: { sourceType: 'manual', id: purgeId } }],
    ignore: [{ sourceType: 'manual', id: purgeId }],
}], { purgeDuplicateRows: true, algorithmVersion: 'test-v103' });
assert.equal(purgeResult.purgedDuplicateRows, 1);
assert.equal(getManualUpcomingEvents('2099-01-01', 500).some((event) => event.id === purgeId), false);

console.log('eventDedupeRegistryV103.test.mjs: OK');
