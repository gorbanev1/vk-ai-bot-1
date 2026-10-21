import test from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseEventModerationCommand } from '../../src/features/events/eventModerationRouting.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const begin = app.indexOf('async function runUpcomingEventRefreshPipelinedV188147(');
const end = app.indexOf('\nasync function runStoredEventLinkRefreshV188145(', begin);
assert.ok(begin >= 0 && end > begin);

const rows = [
    { id: 1, sourceType: 'vk', eventDate: '2026-10-03', title: 'With poster', hasPoster: true, sourceUrl: 'https://vk.ru/wall-1_1' },
    { id: 2, sourceType: 'telegram', eventDate: '2026-10-03', title: 'No poster', hasPoster: false, sourceUrl: 'https://t.me/events/112' },
    { id: 3, sourceType: 'vk_chat', eventDate: '2026-10-04', title: 'No poster in shared post', hasPoster: false, sourceUrl: 'https://vk.ru/wall-1_1' },
    { id: 4, sourceType: 'vk', eventDate: '2026-10-05', title: 'No poster and no source', hasPoster: false, sourceUrl: '' },
];

async function execute(onlyMissingPoster) {
    const opened = [], updated = [], delays = [], actions = [], tabFlags = [];
    const cache = new Map();
    const ctx = vm.createContext({
        createManualParserDiagnostics: () => ({ log() {}, finish() {}, relativeLogPath: 'trace' }),
        acquireScraperBrowserActivityLease: () => { actions.push('lease'); return () => actions.push('release'); },
        reconcileUpcomingPostersFromStoredSourceMediaV188145: () => { actions.push('db-check'); return { checked: 2, errors: 0 }; },
        refreshConfiguredChat22ForUpcomingEventsV188145: async () => { actions.push('chat22'); return { ok: true, message: 'done' }; },
        getAllUpcomingEventRecordsForDedupe: () => { actions.push('inventory'); return rows; },
        getStartupPosterRepairGroupsV18877: () => [],
        getLocalDateString: () => '2026-09-21', botTimeZone: 'Europe/Moscow',
        eventHasUsableMediaV18883: (event) => event.hasPoster === true,
        canonicalEventSourceUrl: (url) => url,
        captureStoredEventSourceForReparseV188147: async (url, _records, options) => {
            opened.push(url); tabFlags.push(options.separateTab); return { canonicalUrl: url, imageUrls: [], selectedPost: {} };
        },
        reparseStoredEventSourceUrl: async (_url, records) => records.map((r) => ({ ...r })),
        scoreReparsedEventForStoredRecord: (record, candidate) => record.id === candidate.id ? 100 : 0,
        futureEventReparseMatchIsSafeV188145: (record, candidate) => record.id === candidate?.id,
        updateStoredEventRecordFromReparse: (args) => { updated.push(args); return 1; },
        rebuildVerifiedPartySnapshotQueued: async () => { actions.push('snapshot'); return { canonicalCount: 4 }; },
        resolve: (...parts) => parts.join('/'), mkdirSync: () => {},
        writeFileSync: (path, data) => cache.set(path, data),
        renameSync: (source, target) => { cache.set(target, cache.get(source)); cache.delete(source); },
        readFileSync: (path) => cache.get(path),
        Buffer, createHash, randomUUID, Date, JSON, Promise, Math,
        setTimeout: (callback, ms) => { delays.push(ms); callback(); },
        console: { log() {}, error() {}, warn() {} }, formatPrivateError: String,
    });
    vm.runInContext(app.slice(begin, end), ctx);
    const result = await vm.runInContext(`runUpcomingEventRefreshPipelinedV188147({ onlyMissingPoster: ${Boolean(onlyMissingPoster)} })`, ctx);
    return { result, opened, updated, delays, actions, tabFlags };
}

test('бф opens only source links of future cards without an attached poster; never sweeps chat 22', async () => {
    assert.equal(parseEventModerationCommand('тусы обновить будущие бф')?.onlyMissingPoster, true);
    const { result, opened, updated, delays, actions, tabFlags } = await execute(true);
    assert.deepEqual(opened, ['https://t.me/events/112', 'https://vk.ru/wall-1_1']);
    assert.deepEqual(tabFlags, [true, true], 'each бф target must open in a distinct tab');
    assert.deepEqual(updated.map((r) => r.id), [2, 3]);
    assert.ok(updated.every((r) => r.onlyIfMissingPoster === true));
    assert.equal(result.targetCards, 3);
    assert.equal(result.skippedCardsWithPoster, 1);
    assert.equal(result.noLinkCards.length, 1);
    assert.equal(result.links, 2);
    assert.equal(result.complete, false);
    assert.equal(actions.includes('chat22'), false);
    assert.equal(actions.includes('snapshot'), false);
    assert.ok(delays.length === 1 && delays[0] >= 5_000 && delays[0] <= 16_000);
});

test('full future refresh still scans chat 22 and opens all linked future cards', async () => {
    const { result, opened, updated, actions, tabFlags } = await execute(false);
    assert.deepEqual(opened, ['https://vk.ru/wall-1_1', 'https://t.me/events/112']);
    assert.deepEqual(tabFlags, [false, false], 'full mode keeps original tab policy');
    assert.deepEqual(updated.map((r) => r.id), [1, 3, 2]);
    assert.ok(updated.every((r) => r.onlyIfMissingPoster === false));
    assert.equal(result.skippedCardsWithPoster, 0);
    assert.equal(actions.includes('chat22'), true);
});
