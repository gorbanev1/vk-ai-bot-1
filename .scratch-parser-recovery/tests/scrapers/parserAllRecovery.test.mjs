import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadLatestParserAllRecovery, mergeParserAllCheckpoint, buildParserRecoveryNotice, dismissParserAllRecovery } from '../../src/features/scrapers/parserAllRecovery.js';
import { shouldSkipUnchangedCapturedItem } from '../../src/features/scrapers/manualParserCleanSkip.js';
import { parseScraperStartCommand } from '../../src/features/scrapers/scraperCommandRouting.js';
import { createManualParserDiagnostics } from '../../src/features/scrapers/manualParserDiagnostics.js';

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

test('durable raw cache preserves shared attachments rather than serializing them as CIRCULAR', () => {
    const root = mkdtempSync(join(tmpdir(), 'parser-cache-'));
    const diagnostics = createManualParserDiagnostics({ dataDirectory: root });
    const images = ['https://example.org/poster.jpg'];
    const path = diagnostics.cacheSource({ sourceId: 'vk:shared', items: [{ postId: 1, imageUrls: images, attachments: { images } }, { postId: 2, imageUrls: images }] });
    const data = JSON.parse(readFileSync(path, 'utf8'));
    assert.deepEqual(data.items[1].imageUrls, images);
    assert.deepEqual(data.items[0].attachments.images, images);
});
