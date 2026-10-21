import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLatestParserAllRecovery, mergeParserAllCheckpoint, parserRecoveryCheckpointInputs, buildParserRecoveryNotice, dismissParserAllRecovery, claimParserAllRecovery, getParserPosterGateImage } from '../../src/features/scrapers/parserAllRecovery.js';
import { shouldSkipUnchangedCapturedItem } from '../../src/features/scrapers/manualParserCleanSkip.js';
import { parseScraperStartCommand } from '../../src/features/scrapers/scraperCommandRouting.js';
import { createManualParserDiagnostics } from '../../src/features/scrapers/manualParserDiagnostics.js';
import { loadLatestParserAllRecoveryAsync } from '../../src/features/scrapers/parserRecoveryAsync.js';

function fixture() {
    const root = mkdtempSync(join(tmpdir(), 'parser-resume-'));
    const directory = join(root, 'checkpoints');
    mkdirSync(directory);
    const cachePath = join(root, 'source.json');
    writeFileSync(cachePath, JSON.stringify({ sourceId: 'vk:venue', items: [{ postId: 1, text: 'Полный текст', imageUrls: ['https://example.org/poster.jpg'] }] }));
    const write = (id, startedAt, checkpoint = {}, extra = {}) => {
        writeFileSync(join(directory, `${id}.json`), JSON.stringify({
            savedAt: '2099-01-01T00:00:00Z', operation: { id, name: 'parser-all:primary', status: 'interrupted',
                startedAt, checkpoint: { phase: 'processing', captures: [{ sourceId: 'vk:venue', cachePath }], ...checkpoint }, ...extra },
        }));
    };
    return { root, directory, cachePath, write, load: (extra = {}) => loadLatestParserAllRecovery({ root, directory, ...extra }) };
}

test('repeated interruption preserves all trace generations and the explicit ordinary-ladder choice', async () => {
    const f = fixture();
    const request = { sourceId: 'vk:venue', itemId: '1', sourceUrl: 'https://vk.ru/wall-1_1', sourceText: 'Concert', visionPhase: 'phase2-date-free-image' };
    const traceA = join(f.root, 'original.jsonl');
    const traceB = join(f.root, 'resume.jsonl');
    const url = 'https://example.org/poster.jpg';
    const responseText = '[IMAGE 1]\nЭто афиша события: да';
    writeFileSync(traceA, [
        { stage: 'run.start', data: { runId: 'original' } },
        { stage: 'item.poster-gate.batch_start', data: { ...request, dateFreePhase: true, semanticBodyText: request.sourceText } },
        { stage: 'item.poster-gate.image', data: { ...request, imageNumber: 1, imageUrl: url, responseText } },
    ].map(row => JSON.stringify(row)).join('\n'));
    writeFileSync(traceB, JSON.stringify({ stage: 'run.start', data: { runId: 'resume' } }));
    const payload = JSON.parse(readFileSync(f.cachePath, 'utf8'));
    writeFileSync(f.cachePath, JSON.stringify({ ...payload, runId: 'original' }));
    const plan = { phaseOneComplete: true, captures: [{ sourceId: request.sourceId, cachePath: f.cachePath, itemIds: ['1'] }], reservedImageUrls: ['dated-image'] };
    f.write('first', '2026-10-01T00:00:00Z', { tracePath: traceA, dateFreePhasePlan: plan, phaseTwoModels: { stopped: true } }, { metadata: { incrementalOnly: false } });
    const first = f.load();
    assert.equal(buildParserRecoveryNotice(first).replyMarkup.inline_keyboard[0][0].callback_data, 'parser_ladder:first');
    const seed = parserRecoveryCheckpointInputs(first, { ordinaryPhaseTwo: true });
    const next = mergeParserAllCheckpoint(seed, { tracePath: traceB, phase: 'processing' });
    f.write('second', '2026-10-02T00:00:00Z', next, { metadata: { incrementalOnly: true } });
    const second = f.load();
    assert.equal(second.available, true);
    assert.equal(second.invalidCaches.length, 0);
    assert.equal(second.originalIncrementalOnly, false);
    assert.equal(second.startedAt, first.startedAt);
    assert.deepEqual(second.checkpoint.dateFreePhasePlan, plan);
    assert.equal(getParserPosterGateImage(second.posterGateImages, request, 1, url), responseText);
    assert.equal(buildParserRecoveryNotice(second).replyMarkup.inline_keyboard[0][0].callback_data, 'parser_resume:second');
    const thirdSeed = parserRecoveryCheckpointInputs(second);
    assert.equal(thirdSeed.ordinaryPhaseTwo, true);
    assert.deepEqual(thirdSeed.tracePaths, [traceA, traceB]);
    assert.equal(thirdSeed.phase, undefined);
    const workerResult = await loadLatestParserAllRecoveryAsync({ root: f.root, directory: f.directory });
    assert.equal(getParserPosterGateImage(workerResult.posterGateImages, request, 1, url), responseText);
    assert.deepEqual(parserRecoveryCheckpointInputs(null, { ordinaryPhaseTwo: true }), {});
    assert.equal(parserRecoveryCheckpointInputs(first).ordinaryPhaseTwo, false);
});

test('startup recovery runs off the event loop and preserves cache maps', async () => {
    const f = fixture();
    f.write('worker-test', '2026-10-05T00:00:00Z');
    let heartbeat = false;
    const pending = loadLatestParserAllRecoveryAsync({ root: f.root, directory: f.directory });
    await new Promise(resolve => setTimeout(() => { heartbeat = true; resolve(); }, 0));
    const result = await pending;
    assert.equal(heartbeat, true);
    assert.deepEqual(result, f.load());
    assert.ok(result.cacheRows instanceof Map);
});

test('latest invocation wins despite restart timestamp; successful run supersedes old failures', () => {
    const f = fixture();
    f.write('old', '2026-09-01T00:00:00Z');
    f.write('new', '2026-10-01T00:00:00Z');
    assert.equal(f.load().id, 'new');
    assert.equal(f.load({ expectedId: 'old' }).reason, 'superseded');
    f.write('success', '2026-10-02T00:00:00Z', { phase: 'completed' }, { status: 'completed' });
    assert.equal(f.load(), null);
});

test('partial completed run is recoverable, pools and dismissal remain independent', () => {
    const f = fixture();
    f.write('primary', '2026-10-01T00:00:00Z', { phase: 'completed-with-warnings' }, { status: 'completed' });
    f.write('secondary', '2026-10-02T00:00:00Z', {}, { name: 'parser-all-clean:secondary:auto', metadata: { partyPool: 'secondary' } });
    assert.equal(f.load().id, 'primary');
    assert.equal(f.load({ partyPool: 'secondary' }).id, 'secondary');
    const recovery = f.load();
    const notice = buildParserRecoveryNotice(recovery);
    assert.equal(notice.replyMarkup.inline_keyboard[0][0].callback_data, 'parser_resume:primary');
    dismissParserAllRecovery(recovery);
    assert.equal(f.load(), null);
});

test('trace recovers cache paths despite malformed JSONL; text and attachments stay together', () => {
    const f = fixture();
    const tracePath = join(f.root, 'trace.jsonl');
    writeFileSync(tracePath, '{truncated}\n' + JSON.stringify({ stage: 'source.cache.saved', data: { sourceId: 'vk:venue', path: f.cachePath } }) + '\n{');
    f.write('run', '2026-10-01T00:00:00Z', { captures: [], tracePath, sourceIds: ['vk:venue', 'chat:22'] });
    const recovery = f.load();
    assert.equal(recovery.available, true);
    assert.deepEqual(recovery.uncapturedSourceIds, ['chat:22']);
    assert.deepEqual(recovery.cacheRows.get('vk:venue').items[0], { postId: 1, text: 'Полный текст', imageUrls: ['https://example.org/poster.jpg'] });
});

test('corrupt or wrong-source cache is reported; no silent recapture or fallback to old run', () => {
    const f = fixture();
    f.write('run', '2026-10-01T00:00:00Z');
    writeFileSync(f.cachePath, '{bad');
    assert.equal(f.load().available, false);
    assert.equal(f.load().reason, 'invalid-cache');
    assert.equal(buildParserRecoveryNotice(f.load()).replyMarkup, null);
    writeFileSync(f.cachePath, JSON.stringify({ sourceId: 'vk:wrong', items: [] }));
    assert.equal(f.load().reason, 'invalid-cache');
});

test('raw-cache provenance must match the selected parser run trace', () => {
    const f = fixture();
    const tracePath = join(f.root, 'trace.jsonl');
    writeFileSync(tracePath, JSON.stringify({ stage: 'run.start', data: { runId: 'selected-run' } }) + '\n');
    f.write('run', '2026-10-01T00:00:00Z', { tracePath });

    // A cache with the same source identity but from another run must never be
    // silently mixed into this recovery. It is marked for recapture instead.
    writeFileSync(f.cachePath, JSON.stringify({
        sourceId: 'vk:venue', runId: 'stale-run', items: [{ postId: 1, text: 'stale' }],
    }));
    let recovery = f.load();
    assert.equal(recovery.available, false);
    assert.equal(recovery.reason, 'invalid-cache');
    assert.deepEqual(recovery.invalidCaches.map((row) => row.sourceId), ['vk:venue']);
    assert.deepEqual(recovery.uncapturedSourceIds, ['vk:venue']);

    // A cache produced by the selected run remains reusable.
    writeFileSync(f.cachePath, JSON.stringify({
        sourceId: 'vk:venue', runId: 'selected-run', items: [{ postId: 1, text: 'current' }],
    }));
    recovery = f.load();
    assert.equal(recovery.available, true);
    assert.equal(recovery.invalidCaches.length, 0);
    assert.equal(recovery.cacheRows.get('vk:venue').items[0].text, 'current');
});

test('provenance-bearing cache is rejected when checkpoint trace has no run identity', () => {
    const f = fixture();
    const tracePath = join(f.root, 'trace-without-start.jsonl');
    writeFileSync(tracePath, JSON.stringify({ stage: 'source.cache.saved', data: { sourceId: 'vk:venue', path: f.cachePath } }) + '\n');
    f.write('run', '2026-10-01T00:00:00Z', { tracePath });
    writeFileSync(f.cachePath, JSON.stringify({
        sourceId: 'vk:venue', runId: 'orphan-run', items: [{ postId: 1, text: 'orphan' }],
    }));
    const recovery = f.load();
    assert.equal(recovery.available, false);
    assert.equal(recovery.reason, 'invalid-cache');
    assert.match(recovery.invalidCaches[0].error, /provenance mismatch/u);
});

test('recovery replay accepts a prior-run cache when both trace lineages are checkpointed', () => {
    const f = fixture();
    const previousTrace = join(f.root, 'previous-trace.jsonl');
    const currentTrace = join(f.root, 'current-trace.jsonl');
    writeFileSync(previousTrace, JSON.stringify({ stage: 'run.start', data: { runId: 'prior-run' } }) + '\n');
    writeFileSync(currentTrace, JSON.stringify({ stage: 'run.start', data: { runId: 'recovery-run' } }) + '\n');
    f.write('run', '2026-10-01T00:00:00Z', {
        tracePath: currentTrace,
        recoveryTracePath: previousTrace,
    });
    writeFileSync(f.cachePath, JSON.stringify({
        sourceId: 'vk:venue', runId: 'prior-run', items: [{ postId: 1, text: 'captured before restart' }],
    }));
    const recovery = f.load();
    assert.equal(recovery.available, true);
    assert.equal(recovery.invalidCaches.length, 0);
    assert.equal(recovery.cacheRows.get('vk:venue').items[0].text, 'captured before restart');
});

test('one corrupt cache does not block healthy source caches and is marked for recapture', () => {
    const f = fixture();
    const brokenPath = join(f.root, 'broken.json');
    writeFileSync(brokenPath, '{bad');
    f.write('run', '2026-10-01T00:00:00Z', {
        sourceIds: ['vk:venue', 'vk:broken'],
        captures: [
            { sourceId: 'vk:venue', cachePath: f.cachePath },
            { sourceId: 'vk:broken', cachePath: brokenPath },
        ],
    });
    const recovery = f.load();
    assert.equal(recovery.available, true);
    assert.deepEqual([...recovery.cacheRows.keys()], ['vk:venue']);
    assert.deepEqual(recovery.uncapturedSourceIds, ['vk:broken']);
    assert.deepEqual(recovery.invalidCaches.map((row) => row.sourceId), ['vk:broken']);
    assert.match(buildParserRecoveryNotice(recovery).text, /Повреждённый кэш будет пересобран для: vk:broken/u);
});

test('failed empty capture is recaptured while successful source caches are reused', () => {
    const f = fixture();
    const failed = join(f.root, 'failed.json');
    writeFileSync(failed, JSON.stringify({ sourceId: 'vk:failed', items: [], metadata: { captureError: 'closed' } }));
    f.write('run', '2026-10-01T00:00:00Z', { captures: [{ sourceId: 'vk:venue', cachePath: f.cachePath }, { sourceId: 'vk:failed', cachePath: failed }] });
    assert.equal(f.load().available, true);
    assert.deepEqual(f.load().uncapturedSourceIds, ['vk:failed']);
});

test('capture manifests survive failure, stop and finalization checkpoint updates', () => {
    const prior = { phase: 'processing', tracePath: 'trace.jsonl', captures: [{ sourceId: 'vk:a', cachePath: 'a.json' }], recoveryStartedAt: 'start' };
    const result = mergeParserAllCheckpoint(prior, { phase: 'failed', tracePath: '', captures: [{ sourceId: 'vk:a', cachePath: '', error: 'failed' }] });
    assert.equal(result.tracePath, 'trace.jsonl');
    assert.equal(result.captures[0].cachePath, 'a.json');
    assert.equal(result.recoveryStartedAt, 'start');
});

test('full resume skips only finalized unchanged records from this pass', () => {
    const options = { incrementalOnly: true, resumeCompletedSince: 100, contentHash: 'same', isFinalStatus: (s) => s === 'processed_event' };
    const previous = { parseStatus: 'processed_event', contentHash: 'same', processedAt: 101 };
    assert.equal(shouldSkipUnchangedCapturedItem({ ...options, previous }), true);
    assert.equal(shouldSkipUnchangedCapturedItem({ ...options, previous: { ...previous, processedAt: 99 } }), false);
    assert.equal(shouldSkipUnchangedCapturedItem({ ...options, previous: { ...previous, parseStatus: 'processing' } }), false);
    assert.equal(shouldSkipUnchangedCapturedItem({ ...options, previous, contentHash: 'changed' }), false);
    assert.equal(shouldSkipUnchangedCapturedItem({ ...options, resumeCompletedSince: 0, previous: { ...previous, processedAt: 99 } }), true);
});

test('recovery command aliases include secondary pool', () => {
    for (const command of ['парсер всё восстановить', 'тусы парсер все восстановить', 'scraper all resume']) {
        assert.equal(parseScraperStartCommand(command).recover, true);
    }
    const secondary = parseScraperStartCommand('тусы второстепенные парсер все восстановить');
    assert.equal(secondary.recover, true);
    assert.equal(secondary.partyPool, 'secondary');
    assert.equal(parseScraperStartCommand('парсер все').cleanOnly, false);
});

test('short secondary recovery aliases cannot become source names or start a fresh pass', () => {
    for (const pool of ['быдлячьи', 'второстепенные']) {
        for (const prefix of [`парсер ${pool}`, `${pool} парсер`, `тусы ${pool} парсер`, `Гигорейв парсер ${pool}`]) {
            for (const tail of ['восстановить', 'все восстановить', 'восстановить фаза 2']) {
                const input = `${prefix} ${tail}`;
                const parsed = parseScraperStartCommand(input);
                assert.equal(parsed.recover, true, input);
                assert.equal(parsed.all, true, input);
                assert.equal(parsed.cleanOnly, true, input);
                assert.equal(parsed.partyPool, 'secondary', input);
                assert.equal(parsed.sourceId, '', input);
            }
            const source = parseScraperStartCommand(`${prefix} vk:venue`);
            assert.equal(source.recover, false);
            assert.equal(source.sourceId, 'vk:venue');
            assert.equal(parseScraperStartCommand(prefix).recover, false);
        }
    }
});

test('durable raw cache preserves shared attachments rather than serializing them as CIRCULAR', () => {
    const root = mkdtempSync(join(tmpdir(), 'parser-cache-'));
    const diagnostics = createManualParserDiagnostics({ dataDirectory: root });
    const images = ['https://example.org/poster.jpg'];
    const path = diagnostics.cacheSource({ sourceId: 'vk:shared', items: [{ postId: 1, imageUrls: images, attachments: { images } }, { postId: 2, imageUrls: images }] });
    const data = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(data.items[1].imageUrls, images);
    assert.deepEqual(data.items[0].attachments.images, images);
});

test('parser-all-clean uses the final-DOM-only diagnostics policy', () => {
    const root = mkdtempSync(join(tmpdir(), 'parser-clean-diagnostics-'));
    const diagnostics = createManualParserDiagnostics({ dataDirectory: root, label: 'parser-all-clean' });
    assert.equal(diagnostics.finalDomOnly, true);
});

test('automatic recovery is claimed only once across reloads, dismissal is respected', () => {
    const f = fixture();
    f.write('run', '2026-10-01T00:00:00Z');
    assert.equal(claimParserAllRecovery(f.load()), true);
    assert.equal(claimParserAllRecovery(f.load()), false);
    f.write('next', '2026-10-02T00:00:00Z');
    const next = f.load();
    dismissParserAllRecovery(next);
    assert.equal(claimParserAllRecovery(next), false);
});

test('recovery depth is preserved for the one automatic continuation limit', () => {
    const f = fixture();
    f.write('run', '2026-10-01T00:00:00Z', {}, { metadata: { partyPool: 'primary', autoRecoveryDepth: 1 } });
    assert.equal(f.load().autoRecoveryDepth, 1);
});

test('resume reuses each successful image, including partial batches; source and image identity must match', () => {
    const f = fixture();
    const tracePath = join(f.root, 'trace.jsonl');
    const request = { sourceId: 'vk:venue', itemId: '1', sourceUrl: 'https://vk.ru/wall-1_1', sourceText: 'Concert', secondaryJointGate: true };
    const url = 'https://example.org/poster.jpg';
    const responseText = '[IMAGE 1] Это афиша события: да';
    writeFileSync(tracePath, [
        { stage: 'item.poster-gate.batch_start', data: { ...request, semanticBodyText: request.sourceText } },
        { stage: 'item.poster-gate.image', data: { ...request, imageNumber: 1, imageUrl: url, responseText } },
        { stage: 'item.poster-gate.image_error', data: { ...request, imageNumber: 2, imageUrl: 'https://example.org/failed.jpg' } },
    ].map(row => JSON.stringify(row)).join('\n') + '\n{');
    f.write('run', '2026-10-01T00:00:00Z', { tracePath });
    const images = f.load().posterGateImages;
    assert.equal(getParserPosterGateImage(images, request, 1, url), responseText);
    assert.equal(getParserPosterGateImage(images, request, 2, url), '');
    assert.equal(getParserPosterGateImage(images, request, 1, 'https://example.org/changed.jpg'), '');
    assert.equal(getParserPosterGateImage(images, { ...request, sourceText: 'Changed' }, 1, url), '');
    assert.equal(getParserPosterGateImage(images, { ...request, sourceUrl: 'https://vk.ru/wall-2_1' }, 1, url), '');
});
