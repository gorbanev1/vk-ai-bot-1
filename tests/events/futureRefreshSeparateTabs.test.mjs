import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
const browser = readFileSync(new URL('../../src/infrastructure/browser/browserGrabber.js', import.meta.url), 'utf8');

const captureStart = app.indexOf('async function captureStoredEventSourceForReparseV188147(');
const captureEnd = app.indexOf('\nasync function reparseStoredEventSourceUrl(', captureStart);
const browserStart = browser.indexOf('export async function openEventLinkForReview(');
const nextBrowserExport = browser.indexOf('\nexport ', browserStart + 15);
const browserEnd = nextBrowserExport < 0 ? browser.length : nextBrowserExport;

test('бф forwards distinct-tab option through capture into Playwright newPage opener', () => {
  assert.ok(captureStart > 0 && captureEnd > captureStart);
  const capture = app.slice(captureStart, captureEnd);
  assert.match(capture, /separateTab = false/u);
  assert.match(capture, /keepPageOpen: false,\s*separateTab,/u);
  assert.ok(browserStart > 0 && browserEnd > browserStart);
  const review = browser.slice(browserStart, browserEnd);
  assert.match(review, /separateTab\s*\?\s*await openScraperTab\(/u);
  assert.match(review, /:\s*await openScraperPage\(/u);
  const openTab = browser.slice(browser.indexOf('export async function openScraperTab('), browserStart);
  assert.match(openTab, /const page = await context\.newPage\(\)/u);
  assert.doesNotMatch(openTab, /reusablePages\.(?:get|set)/u);
});

test('AI work does not keep browser capture slots occupied after capture completed', async () => {
  const begin = app.indexOf('async function runUpcomingEventRefreshPipelinedV188147(');
  const end = app.indexOf('\nasync function runStoredEventLinkRefreshV188145(', begin);
  const flow = app.slice(begin, end);
  assert.match(flow, /void tracked\.finally\(\(\) => openCaptures\.delete\(tracked\)\)/u);
  assert.doesNotMatch(flow, /finished\s*=\s*browserTask\.then[\s\S]*?\.finally\(\(\) => openCaptures\.delete\(tracked\)\)/u);
  let releaseFirstAnalysis;
  const firstAnalysisGate = new Promise((resolve) => { releaseFirstAnalysis = resolve; });
  const opened = [];
  const rows = Array.from({ length: 9 }, (_, i) => ({
    id: i + 1, sourceType: 'vk', eventDate: '2026-11-01', title: `Future ${i}`,
    sourceUrl: `https://vk.ru/wall-1_${i + 1}`, hasPoster: false,
  }));
  const cache = new Map();
  const ctx = vm.createContext({
    createManualParserDiagnostics: () => ({ log() {}, finish() {}, relativeLogPath: 'trace' }),
    acquireScraperBrowserActivityLease: () => () => {},
    reconcileUpcomingPostersFromStoredSourceMediaV188145: () => ({ errors: 0 }),
    getAllUpcomingEventRecordsForDedupe: () => rows,
    getStartupPosterRepairGroupsV18877: () => [],
    getLocalDateString: () => '2026-09-21', botTimeZone: 'Europe/Moscow',
    eventHasUsableMediaV18883: (event) => event.hasPoster === true,
    canonicalEventSourceUrl: (url) => url,
    captureStoredEventSourceForReparseV188147: async (url, _records, options) => {
      assert.equal(options.separateTab, true);
      opened.push(url);
      return { canonicalUrl: url, imageUrls: [], selectedPost: {} };
    },
    reparseStoredEventSourceUrl: async (_url, records) => {
      if (records[0].id === 1) await firstAnalysisGate;
      return records.map((record) => ({ ...record }));
    },
    scoreReparsedEventForStoredRecord: () => 100,
    futureEventReparseMatchIsSafeV188145: () => true,
    updateStoredEventRecordFromReparse: () => 1,
    rebuildVerifiedPartySnapshotQueued: async () => ({}),
    resolve: (...parts) => parts.join('/'), mkdirSync: () => {},
    writeFileSync: (path, data) => cache.set(path, data),
    renameSync: (source, target) => { cache.set(target, cache.get(source)); cache.delete(source); },
    readFileSync: (path) => cache.get(path),
    Buffer, createHash: (await import('node:crypto')).createHash,
    randomUUID: (await import('node:crypto')).randomUUID,
    Date, JSON, Promise, Math, setTimeout: (done) => done(),
    console: { log() {}, warn() {}, error() {} }, formatPrivateError: String,
  });
  vm.runInContext(flow, ctx);
  const run = vm.runInContext('runUpcomingEventRefreshPipelinedV188147({ onlyMissingPoster: true })', ctx);
  try {
    // If capture slots are only freed after AI completion, opening #9 blocks
    // behind the intentionally blocked first analysis task.
    for (let n = 0; n < 30 && opened.length < 9; n += 1) {
      await new Promise((resolve) => setImmediate(resolve));
    }
    assert.equal(opened.length, 9, 'the 9th tab must open before the first AI task completes');
  } finally {
    releaseFirstAnalysis();
    await run;
  }
});
