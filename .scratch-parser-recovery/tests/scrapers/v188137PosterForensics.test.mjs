import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createParserPosterForensics, appendPosterDeliveryForensic } from '../../src/features/scrapers/parserPosterForensics.js';

const readJsonl = (path) => readFileSync(path, 'utf8').trim().split('\n').filter(Boolean).map(JSON.parse);

function fixture() {
    const base = mkdtempSync(join(tmpdir(), 'gigorave-poster-forensics-'));
    const dataDirectory = join(base, 'data');
    const runDirectory = join(dataDirectory, 'logs', 'manual-parser', 'test-run');
    mkdirSync(join(dataDirectory, 'vk_announcements'), { recursive: true });
    // Valid 1x1 PNG (actual image bytes, not a reserialized URL).
    const imageBytes = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScL/nwAAAABJRU5ErkJggg==', 'base64');
    const imagePath = 'vk_announcements/post-1.png';
    writeFileSync(join(dataDirectory, imagePath), imageBytes);
    return { dataDirectory, runDirectory, imagePath, imageBytes, journal: createParserPosterForensics({ dataDirectory, runDirectory }) };
}

test('V188.137 preserves complete source text, all source media metadata, event reasons and actual image bytes', () => {
    const { journal, dataDirectory, imagePath, imageBytes } = fixture();
    const originalText = 'ВК: афиша, исходный текст без усечения.\n'.repeat(600);
    const post = { postId: 333, screenName: 'example', sourceUrl: 'https://vk.ru/wall-4_333', text: originalText,
        imageUrls: ['https://sun.example/photo/first.jpg', 'https://sun.example/photo/second.jpg'],
        imageMedia: [{ url: 'https://sun.example/photo/first.jpg', selectorPath: '#post > img', domContext: { source: 'vk-DOM', width: 800, height: 1000 }, localPath: imagePath }],
        domAudit: { selectorPath: '.Post', imageCount: 2 } };
    const event = { id: 55, eventDate: '2026-09-28', title: 'Вечеринка', imagePaths: [imagePath],
        posterImageIndex: 1, posterMatchStatus: 'exact_poster_match', posterMatchReason: 'source-confirmed',
        posterVisionFacts: [{ index: 1, poster: true, posterConfidence: 1, imagePath: 'vk_announcements/DIFFERENT.png' }] };
    journal.recordPost('vk.forensics.before-db-write', { sourceId: 'vk:example', itemId: '333', post, events: [event],
        decision: { reason: 'source-date-compatible' }, previous: { imagePathsJson: JSON.stringify([imagePath]) },
        rejectedEvents: [{ event: { title: 'Другое', eventDate: '2026-09-01' }, reason: 'event-date-before-today' }] });
    const rows = readJsonl(journal.logPath);
    const actual = rows.find((row) => row.stage === 'vk.forensics.before-db-write');
    assert.equal(actual.originalText, originalText);
    assert.deepEqual(actual.allSourceImageUrls, post.imageUrls);
    assert.equal(actual.allSourceImageMedia[0].domContext.width, 800);
    assert.equal(actual.rejectedEvents[0].reason, 'event-date-before-today');
    assert.equal(actual.posterDecisions.length, 1);
    assert.equal(actual.posterDecisions[0].displaySafety.accepted, false);
    assert.ok(actual.posterDecisions[0].displaySafety.reason);
    const file = actual.mediaFiles.find((item) => item?.sourcePath === imagePath);
    assert.equal(file.state, 'copied');
    assert.equal(file.bytes, imageBytes.length);
    assert.deepEqual(readFileSync(file.preservedPath), imageBytes);
    assert.equal(readJsonl(journal.imagesPath)[0].itemId, '333');
    assert.ok(existsSync(join(dataDirectory, imagePath)), 'forensic logging must not remove source image');
});

test('V188.137 records missing local files, all final snapshot events and actual delivery outcome separately', () => {
    const { journal, dataDirectory, imagePath } = fixture();
    const missing = 'vk_announcements/removed.png';
    const event = { id: 5, title: 'Афиша без файла', eventDate: '2026-09-28', sourceType: 'vk',
        sourceUrl: 'https://vk.ru/wall-4_333', imagePaths: [missing], posterVisionFacts: [], posterImageIndex: 1 };
    const other = { id: 6, title: 'Афиша с файлом', eventDate: '2026-09-29', sourceType: 'vk', imagePaths: [imagePath] };
    const snapshot = journal.recordFinalSnapshot({ items: [{ event }, { event: other, compactSummary: 'Пример' }] },
        { rawCount: 3, representedCount: 2, posterless: [{ id: 5, reason: 'metadata-missing' }] });
    const cards = readJsonl(snapshot.filePath);
    assert.equal(snapshot.count, 2);
    assert.equal(cards[0].posterDecision.displaySafety.accepted, false);
    assert.equal(cards[0].mediaFiles[0].state, 'missing-on-disk');
    assert.equal(cards[1].mediaFiles[0].state, 'copied');
    assert.equal(JSON.parse(readFileSync(snapshot.visibilityPath, 'utf8')).visibilityAudit.rawCount, 3);
    appendPosterDeliveryForensic({ dataDirectory, stage: 'card-sent-text-only', event, platform: 'vk', reason: 'missing-on-disk' });
    const delivered = readJsonl(join(dataDirectory, 'event-poster-delivery-archives', `${new Date().toISOString().slice(0, 10)}.jsonl`));
    assert.equal(delivered[0].stage, 'card-sent-text-only');
    assert.equal(delivered[0].event.title, event.title);
    assert.equal(delivered[0].reason, 'missing-on-disk');
});

test('V188.137 parser entry and final delivery are wired into the production code', () => {
    const root = new URL('../../src/', import.meta.url);
    const scraper = readFileSync(new URL('platforms/vk/vkPublicScraper.js', root), 'utf8');
    const app = readFileSync(new URL('app/botApplication.js', root), 'utf8');
    const diag = readFileSync(new URL('features/scrapers/manualParserDiagnostics.js', root), 'utf8');
    for (const stage of ['vk.dom-post-captured', 'vk.post-after-hydration', 'vk.prefilter-decision',
        'vk.post-skipped', 'forensics.before-db-write', 'forensics.after-db-write']) assert.ok(scraper.includes(stage), stage);
    assert.match(diag, /recordFinalPosterSnapshot/);
    assert.match(app, /savePosterForensicsFinal\?\.\(verification/);
    assert.match(app, /card-sent-with-poster/);
    assert.match(app, /card-sent-text-only/);
    assert.match(app, /card-withheld-upload-failed/);
});

test('V188.137 records exact before/after changes, including an image lost on reparse', () => {
    const { journal, imagePath } = fixture();
    const before = { id: 42, title: 'Анонс', eventDate: '2026-09-28', imagePaths: [imagePath],
        posterMatchStatus: 'exact_poster_match', posterImageIndex: 1 };
    const after = { id: 42, title: 'Анонс', eventDate: '2026-09-28', imagePaths: [],
        posterMatchStatus: 'no_safe_poster', posterMatchReason: 'missing-vision-facts', posterImageIndex: 0 };
    const oldPost = { imagePathsJson: JSON.stringify([imagePath]), contentHash: 'old' };
    const newPost = { imagePathsJson: '[]', contentHash: 'new' };
    journal.recordPost('vk.forensics.after-db-write', { sourceId: 'vk:example', itemId: '333',
        post: { text: 'Исходный текст анонса' }, previousSource: oldPost, previous: newPost,
        previousEvents: [before], events: [after] });
    const row = readJsonl(journal.logPath).find((entry) => entry.stage === 'vk.forensics.after-db-write');
    assert.deepEqual(row.changes.sourceBefore, oldPost);
    assert.deepEqual(row.changes.sourceAfter, newPost);
    assert.equal(row.changes.events[0].type, 'updated');
    assert.deepEqual(row.changes.events[0].differences.imagePaths.before, [imagePath]);
    assert.deepEqual(row.changes.events[0].differences.imagePaths.after, []);
    assert.equal(row.changes.events[0].differences.posterMatchReason.after, 'missing-vision-facts');
});

test('V188.137 complete parser audit survives build-scoped cleanup of volatile data/logs', async () => {
    const { mkdtempSync } = await import('node:fs');
    const { createManualParserDiagnostics } = await import('../../src/features/scrapers/manualParserDiagnostics.js');
    const { clearPreviouslyProcessedLogsV18855 } = await import('../../src/runtime/logMaintenanceV18855.js');
    const root = mkdtempSync(join(tmpdir(), 'gigorave-poster-durable-'));
    const dataDirectory = join(root, 'data');
    const diag = createManualParserDiagnostics({ dataDirectory, label: 'vk-poster-audit' });
    diag.cacheSource({ sourceId: 'vk:test', kind: 'vk-public', items: [{ postId: 1, text: 'Полный текст тестового анонса', imageUrls: ['https://example.com/image.jpg'] }] });
    diag.recordFinalPosterSnapshot({ items: [{ event: { id: 1, title: 'Анонс', imagePaths: [] } }] }, { rawCount: 1 });
    diag.finish({ ok: true });
    const stable = diag.directory;
    assert.match(stable, /parser-forensic-archives/);
    assert.equal(readJsonl(join(stable, 'poster-forensics', 'events.jsonl')).some((row) => row.stage === 'source.raw-captured'), true);
    clearPreviouslyProcessedLogsV18855({ root, build: 'test-next-release', logger: { log() {}, warn() {} } });
    assert.ok(existsSync(join(stable, 'poster-forensics', 'final-announcement-cards.jsonl')));
    assert.ok(existsSync(diag.logPath));
    assert.ok(existsSync(join(stable, 'vk-test.raw-cache.json')));
});
