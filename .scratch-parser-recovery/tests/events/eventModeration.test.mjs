import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import {
    addEventBlockRule,
    deduplicateEventsStrict,
    eventTitleSimilarity,
    eventTitleSmartMatch,
    filterBlockedEvents,
    findDuplicateEventGroups,
    readEventBlocklist,
    removeEventBlockRule,
} from '../../src/features/events/eventModeration.js';

assert.equal(eventTitleSmartMatch('GHOST GIG', 'Ghost Gig'), true);
assert.equal(eventTitleSmartMatch('STONEHAND live in Voronezh', 'STONEHAND'), true);
assert.ok(eventTitleSimilarity('Solar Systo Togathering ОСЕНЬ', 'Solar Systo Togathering. ОСЕНЬ') >= 0.9);

const deduped = deduplicateEventsStrict([
    {
        title: 'GHOST GIG',
        eventDate: '2026-08-14',
        eventTime: '19:30',
        venue: 'Rock Bar DIESEL, Воронеж',
        description: 'Концертный вечер.',
    },
    {
        title: 'Ghost Gig',
        eventDate: '2026-08-14',
        eventTime: '19:30',
        venue: 'Diesel Bar',
        participants: 'Thestrals, AzAAlium, саутсайд',
        description: 'Мистический концерт. Акцент на мрачной подаче.',
    },
]);
assert.equal(deduped.events.length, 1);
assert.equal(deduped.merges.length, 1);
assert.match(deduped.events[0].participants, /Thestrals/u);

const dir = mkdtempSync(join(tmpdir(), 'event-blocklist-'));
const filePath = join(dir, 'event-blacklist.json');
try {
    const added = addEventBlockRule('STONEHAND', { filePath });
    assert.equal(added.added, true);
    assert.equal(readEventBlocklist(filePath).length, 1);
    const filtered = filterBlockedEvents([
        { title: 'STONEHAND — концерт', eventDate: '2026-09-26' },
        { title: 'Septory', eventDate: '2026-09-03' },
    ], readEventBlocklist(filePath));
    assert.equal(filtered.events.length, 1);
    assert.equal(filtered.events[0].title, 'Septory');
    assert.equal(filtered.blocked.length, 1);
    assert.match(readFileSync(filePath, 'utf8'), /STONEHAND/u);

    const removed = removeEventBlockRule('stonehand', { filePath });
    assert.equal(removed.removed.length, 1);
    assert.equal(readEventBlocklist(filePath).length, 0);
} finally {
    rmSync(dir, { recursive: true, force: true });
}


const duplicateGroups = findDuplicateEventGroups([
    { title: 'GHOST GIG', eventDate: '2026-08-14', eventTime: '19:30', venue: 'Rock Bar DIESEL', sourceName: 'vk:one' },
    { title: 'Ghost Gig', eventDate: '2026-08-14', eventTime: '19:30', venue: 'Diesel Bar', sourceName: 'vk:two' },
    { title: 'Ghost Gig afterparty', eventDate: '2026-08-14', eventTime: '23:30', venue: 'Elsewhere', sourceName: 'tg:three' },
    { title: 'STONEHAND', eventDate: '2026-09-26', eventTime: '', venue: 'DIESEL HALL', sourceName: 'vk:four' },
    { title: 'STONEHAND — Воронеж', eventDate: '2026-09-26', eventTime: '', venue: 'DIESEL HALL', sourceName: 'tg:five' },
]);
assert.equal(duplicateGroups.length, 2);
assert.equal(duplicateGroups[0].members.length, 2);
assert.equal(duplicateGroups[1].members.length, 2);
assert.ok(duplicateGroups.every((group) => group.bestSimilarity >= 0.9));

console.log('event moderation tests: OK');
