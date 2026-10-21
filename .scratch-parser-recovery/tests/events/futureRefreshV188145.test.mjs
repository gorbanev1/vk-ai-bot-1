import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { parseEventModerationCommand } from '../../src/features/events/eventModerationRouting.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

function loadMatchFunction() {
    const begin = app.indexOf('function futureEventReparseMatchIsSafeV188145(');
    const end = app.indexOf('\nasync function refreshConfiguredChat22ForUpcomingEventsV188145(', begin);
    assert.ok(begin >= 0 && end > begin, 'a standalone safety predicate is present');
    const context = vm.createContext({
        scoreReparsedEventForStoredRecord(record, event) {
            if (record.eventDate !== event.eventDate) return -1000;
            return event.title === record.title ? 78 : 30;
        },
        eventTitleSimilarity(a, b) { return a === b ? 1 : 0; },
        proposalEventTokenSimilarity(a, b) { return a && a === b ? 1 : 0; },
    });
    vm.runInContext(app.slice(begin, end), context);
    return (record, event, count) => vm.runInContext(
        `futureEventReparseMatchIsSafeV188145(${JSON.stringify(record)},${JSON.stringify(event)},${count})`, context,
    );
}

test('explicit future refresh owner command is distinct from existing batched reparse', () => {
    assert.equal(parseEventModerationCommand('тусы обновить будущие')?.action, 'refresh-upcoming-events');
    assert.equal(parseEventModerationCommand('тусы обновить все будущие тусы')?.action, 'refresh-upcoming-events');
    assert.equal(parseEventModerationCommand('тусы перепарсить ссылки')?.action, 'reparse-links');
});

test('future refresh never silently maps a different date, even for a single post', () => {
    const matches = loadMatchFunction();
    const september26 = { title: 'Провожаем лето', eventDate: '2026-09-26', venue: 'Винзавод' };
    assert.equal(matches(september26, { ...september26, eventDate: '2026-09-19' }, 1), false);
    assert.equal(matches(september26, september26, 1), true);
    assert.equal(matches(september26, { ...september26, title: 'Совсем другая вечеринка' }, 1), false);
});

test('future pass searches cached source media first, visits chat 22 then opens each source sequentially', () => {
    const start = app.indexOf('async function runStoredEventLinkRefreshV188145({ refreshUpcoming = false } = {})');
    const end = app.indexOf('async function reparseSingleStoredEventLink(', start);
    const body = app.slice(start, end);
    const preflight = body.indexOf('reconcileUpcomingPostersFromStoredSourceMediaV188145()');
    const chat22 = body.indexOf('refreshConfiguredChat22ForUpcomingEventsV188145()');
    const rawEvents = body.indexOf('const rawEvents = getAllUpcomingEventRecordsForDedupe(');
    assert.ok(preflight >= 0 && chat22 > preflight && rawEvents > chat22);
    assert.match(body, /const batchSize = refreshUpcoming \? 1 : EVENT_REPARSE_BROWSER_BATCH_SIZE/u);
    assert.match(body, /10_000 \+ Math\.floor\(Math\.random\(\) \* 5_001\)/u);
    assert.match(body, /const snapshot = complete \|\| !refreshUpcoming/u);
    assert.match(body, /unresolvedPosters\.length === 0/u);
    assert.match(body, /result\.reportPath/u);
});

test('new owner route does not alter durable Astra streaming', () => {
    assert.match(app, /if \(command\.action === 'refresh-upcoming-events'\) \{\s*if \(!await requireOwnerDm\(context\)\) return;/u);
    assert.match(app, /result\.storedPosterPreflight\?\.reviewRequired > 0/u);
    assert.match(app, /await sendNextPosterReviewV18893\(context\)/u);
});

test('offline future orchestration does database lookup, chat 22, staggered source opens and verified snapshot only on complete pass', async () => {
    const start = app.indexOf('async function runStoredEventLinkRefreshV188145({ refreshUpcoming = false } = {})');
    const end = app.indexOf('async function reparseSingleStoredEventLink(', start);
    const source = app.slice(start, end);
    const dates = ['2026-10-01', '2026-10-02'];
    const rows = dates.map((date, index) => ({
        id: index + 1, title: `Группа ${index + 1}`, eventDate: date,
        sourceType: 'vk', sourceUrl: `https://vk.ru/wall-17_${index + 1}`,
    }));
    const calls = [];
    const delays = [];
    const context = vm.createContext({
        createManualParserDiagnostics: () => ({ log() {}, finish() {}, relativeLogPath: 'data/parser-forensic-archives/future/trace.jsonl' }),
        acquireScraperBrowserActivityLease: () => { calls.push('lease'); return () => calls.push('release'); },
        reconcileUpcomingPostersFromStoredSourceMediaV188145: () => { calls.push('database-first'); return { checked: 2, errors: 0 }; },
        refreshConfiguredChat22ForUpcomingEventsV188145: async () => { calls.push('chat22'); return { ok: true }; },
        getAllUpcomingEventRecordsForDedupe: () => { calls.push('load-events'); return rows; },
        getLocalDateString: () => '2026-09-21', botTimeZone: 'Europe/Moscow',
        canonicalEventSourceUrl: (value) => value,
        EVENT_REPARSE_BROWSER_BATCH_SIZE: 10,
        reparseStoredEventSourceUrl: async (url, records) => { calls.push('open:' + url); return [{ ...records[0] }]; },
        scoreReparsedEventForStoredRecord: () => 75,
        futureEventReparseMatchIsSafeV188145: () => true,
        eventHasUsableMediaV18883: () => false,
        updateStoredEventRecordFromReparse: ({ onlyIfMissingPoster }) => {
            assert.equal(onlyIfMissingPoster, true);
            return 1;
        },
        getStartupPosterRepairGroupsV18877: () => [],
        resolve: (...parts) => parts.join('/'), mkdirSync: () => {}, writeFileSync: () => {},
        rebuildVerifiedPartySnapshotQueued: async () => { calls.push('snapshot'); return { canonicalCount: 2 }; },
        console: { log() {}, error() {} },
        formatPrivateError: (value) => String(value),
        Date, JSON, Math,
        setTimeout: (cb, ms) => { delays.push(ms); cb(); },
    });
    vm.runInContext(source, context);
    const result = await vm.runInContext('runStoredEventLinkRefreshV188145({ refreshUpcoming: true })', context);
    assert.deepEqual(calls.slice(0, 4), ['lease', 'database-first', 'chat22', 'load-events']);
    assert.deepEqual(calls.filter((value) => value.startsWith('open:')), rows.map((row) => 'open:' + row.sourceUrl));
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 10000 && delays[0] <= 15000);
    assert.equal(result.updatedRows, 2);
    assert.equal(result.tracePath, 'data/parser-forensic-archives/future/trace.jsonl');
    assert.equal(result.complete, true);
    assert.equal(result.snapshot.canonicalCount, 2);
    assert.equal(calls.at(-1), 'release');
});


test('future refresh opens EVERY future source but changes ONLY cards lacking a proven poster', async () => {
    const start = app.indexOf('async function runStoredEventLinkRefreshV188145({ refreshUpcoming = false } = {})');
    const end = app.indexOf('async function reparseSingleStoredEventLink(', start);
    const source = app.slice(start, end);
    const rows = [
        { id: 10, sourceType: 'vk', eventDate: '2026-10-01', title: 'With poster', imagePaths: ['data/poster-10.jpg'], sourceUrl: 'https://vk.ru/wall-3_1' },
        { id: 11, sourceType: 'vk', eventDate: '2026-10-01', title: 'Without poster', imagePaths: [], sourceUrl: 'https://vk.ru/wall-3_1' },
        { id: 12, sourceType: 'telegram', eventDate: '2026-10-02', title: 'Another with poster', imagePaths: ['data/poster-12.jpg'], sourceUrl: 'https://t.me/channel/7' },
    ];
    const opened = [];
    const writes = [];
    const delays = [];
    let rebuilt = 0;
    const ctx = vm.createContext({
        createManualParserDiagnostics: () => ({ log() {}, finish() {}, relativeLogPath: 'trace' }),
        acquireScraperBrowserActivityLease: () => () => {},
        reconcileUpcomingPostersFromStoredSourceMediaV188145: () => ({ errors: 0 }),
        refreshConfiguredChat22ForUpcomingEventsV188145: async () => ({ ok: true }),
        getAllUpcomingEventRecordsForDedupe: () => rows,
        getLocalDateString: () => '2026-09-21', botTimeZone: 'Europe/Moscow',
        canonicalEventSourceUrl: (url) => url,
        EVENT_REPARSE_BROWSER_BATCH_SIZE: 10,
        reparseStoredEventSourceUrl: async (url, records) => {
            opened.push(url);
            return records.map((row) => ({ ...row }));
        },
        eventHasUsableMediaV18883: (record) => record.imagePaths.length > 0,
        scoreReparsedEventForStoredRecord: (record, event) => record.id === event.id ? 100 : 0,
        futureEventReparseMatchIsSafeV188145: (record, event) => record.id === event.id,
        updateStoredEventRecordFromReparse: (args) => { writes.push(args); return 1; },
        getStartupPosterRepairGroupsV18877: () => [],
        resolve: (...parts) => parts.join('/'), mkdirSync: () => {}, writeFileSync: () => {},
        rebuildVerifiedPartySnapshotQueued: async () => { rebuilt += 1; return { canonicalCount: 3 }; },
        console: { log() {}, error() {}, warn() {} }, formatPrivateError: String,
        Date, JSON, Math,
        setTimeout: (cb, ms) => { delays.push(ms); cb(); },
    });
    vm.runInContext(source, ctx);
    const output = await vm.runInContext('runStoredEventLinkRefreshV188145({ refreshUpcoming: true })', ctx);
    assert.deepEqual(opened, ['https://vk.ru/wall-3_1', 'https://t.me/channel/7']);
    assert.deepEqual(writes.map((row) => row.id), [11]);
    assert.equal(writes[0].onlyIfMissingPoster, true);
    assert.equal(output.updatedRows, 1);
    assert.equal(output.preservedWithPoster, 2);
    assert.equal(output.startedLinks, 2);
    assert.equal(delays.length, 1);
    assert.ok(delays[0] >= 10000 && delays[0] <= 15000);
    assert.equal(rebuilt, 1);
});

test('ordinary reparse keeps its separate behavior; database guard protects concurrently confirmed posters', () => {
    const db = readFileSync(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');
    const start = db.indexOf('export function updateStoredEventRecordFromReparse({');
    const end = db.indexOf('\nexport function updateStoredEventSemanticFieldsByOwner(', start);
    const body = db.slice(start, end);
    assert.match(body, /onlyIfMissingPoster = false/u);
    assert.match(body, /if \(onlyIfMissingPoster\) \{/u);
    assert.match(body, /storedPosterStatusIsSafe\(previous\.poster_match_status, currentFacts\)/u);
    const mainStart = app.indexOf('async function runStoredEventLinkRefreshV188145(');
    const mainEnd = app.indexOf('async function reparseSingleStoredEventLink(', mainStart);
    assert.match(app.slice(mainStart, mainEnd), /onlyIfMissingPoster: refreshUpcoming/u);
});

test('future-only reparse can refresh confirmed text while poster proof is absent; legacy remains strict', () => {
    const beginning = app.indexOf('async function reparseStoredEventSourceUrl(');
    const end = app.indexOf('// Separate non-timeboxed owner operation.', beginning);
    const source = app.slice(beginning, end);
    assert.match(source, /allowMissingPoster = false/u);
    assert.match(source, /if \(!allowMissingPoster\) \{\s*throw new Error\('не удалось подтвердить и сохранить исходную афишу события'\)/u);
    assert.match(source, /return allowMissingPoster && publishable\.length === 0 \? withPosters : publishable/u);
    const flowStart = app.indexOf('async function runStoredEventLinkRefreshV188145(');
    const flowEnd = app.indexOf('async function reparseSingleStoredEventLink(', flowStart);
    assert.match(app.slice(flowStart, flowEnd), /allowMissingPoster: refreshUpcoming/u);
});

test('database guard preserves only the selected, existing, proven real poster', () => {
    const db = readFileSync(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');
    const start = db.indexOf('export function updateStoredEventRecordFromReparse({');
    const end = db.indexOf('\nexport function updateStoredEventSemanticFieldsByOwner(', start);
    const body = db.slice(start, end);
    assert.match(body, /selectedIndex = Number\(previous\.poster_image_index \|\| 0\)/u);
    assert.match(body, /sourceMediaIndexFromPathV18886\(path\) === selectedIndex/u);
    assert.match(body, /storedRowPosterBindingAudit\(previous, previous, currentFacts\)\.accepted/u);
    assert.match(body, /legacyPosterPathLooksClean\(selectedPath\)/u);
});
