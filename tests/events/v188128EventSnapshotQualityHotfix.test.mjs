import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { eventPosterRevisionEvidence } from '../../src/features/events/eventSourceRevisionEvidence.js';
import { buildEventSnapshotQualityAudit } from '../../src/features/events/eventSnapshotQualityAudit.js';
import { readVerifiedEventSnapshot, writeVerifiedEventSnapshot } from '../../src/features/events/eventVerifiedSnapshot.js';

const photo = {
    index: 1,
    poster: true,
    imageType: 'poster',
    posterConfidence: 98,
    textReadability: 95,
    title: 'Весенний концерт',
    dates: '20 сентября 2026',
    participants: 'Группа Салют',
    venue: 'Зал Север',
    recognizedText: 'Весенний концерт 20 сентября 2026 Группа Салют',
    imagePath: 'posters/one.jpg',
};
const event = {
    id: 1,
    sourceType: 'vk',
    title: 'Весенний концерт',
    participants: 'Группа Салют',
    venue: 'Зал Север',
    eventDate: '2026-09-20',
    imagePaths: ['posters/one.jpg', 'posters/two.jpg'],
    verifiedImagePaths: ['posters/one.jpg'],
    posterVisionFacts: [photo],
    posterImageIndex: 1,
    posterMatchStatus: 'exact_poster_match',
};

function evidenceHash(value) {
    return createHash('sha256').update(JSON.stringify(eventPosterRevisionEvidence(value))).digest('hex');
}

test('updating Vision metadata without changing path/status changes snapshot freshness evidence', () => {
    const before = evidenceHash(event);
    const updated = evidenceHash({ ...event, posterVisionFacts: [{ ...photo, recognizedText: 'Исправленный текст афиши' }] });
    assert.notEqual(before, updated);
    assert.notEqual(before, evidenceHash({ ...event, verifiedImagePaths: ['posters/other.jpg'] }));
    assert.equal(before, evidenceHash({ ...event, posterVisionFacts: [photo], verifiedImagePaths: ['posters/one.jpg'] }));
    assert.equal(before, evidenceHash({ ...event, posterVisionFactsJson: JSON.stringify([photo]), posterVisionFacts: undefined }));
});

test('quality audit reports uncovered image and safe selected poster without hiding event', () => {
    const report = buildEventSnapshotQualityAudit({
        sourceRevision: 'test',
        rawCount: 1,
        canonicalCount: 1,
        items: [{ event, compactSummary: 'Тестовое описание', ticketLink: '' }],
    });
    assert.equal(report.stats.cards, 1);
    assert.equal(report.stats.storedImageCount, 2);
    assert.equal(report.stats.imagesWithPathBoundMetadata, 1);
    assert.equal(report.stats.imagesWithoutPathBoundMetadata, 1);
    assert.equal(report.stats.cardsWithSafePoster, 1);
    assert.equal(report.issues.length, 1);
    assert.equal(JSON.stringify(report).includes('Группа Салют'), false);
    assert.equal(JSON.stringify(report).includes('posters/one.jpg'), false);
    assert.equal(JSON.stringify(report).includes('Весенний концерт'), false);
});

test('audit records reason for unverified poster and does not modify card', () => {
    const mismatched = { ...event, posterVisionFacts: [{ ...photo, imagePath: 'posters/unknown.jpg' }] };
    const snapshot = { canonicalCount: 1, items: [{ event: mismatched }] };
    const original = JSON.stringify(snapshot);
    const report = buildEventSnapshotQualityAudit(snapshot);
    assert.equal(report.stats.cardsWithUnverifiedPoster, 1);
    assert.ok(report.posterFailureReasons['selected-poster-path-mismatch'] >= 1);
    assert.equal(JSON.stringify(snapshot), original);
});

test('writing snapshot leaves usual payload untouched and writes separate quality sidecar', () => {
    const folder = mkdtempSync(join(tmpdir(), 'event-qa-hotfix-'));
    const target = join(folder, 'event-verified-snapshot.json');
    writeVerifiedEventSnapshot({
        verifiedAt: 1234, reason: 'unit-test', sourceRevision: 'test', rawCount: 1,
        normalizedCount: 1, canonicalCount: 1, mergeCount: 0, ambiguousCount: 0,
        items: [{ event, compactSummary: 'Без изменений', ticketLink: '' }],
    }, target);
    const loaded = readVerifiedEventSnapshot(target);
    assert.equal(loaded.items[0].event.title, event.title);
    assert.equal(loaded.items[0].event.imagePaths.length, 2);
    const sidecar = `${target}.quality-audit.json`;
    assert.equal(existsSync(sidecar), true);
    const report = JSON.parse(readFileSync(sidecar, 'utf8'));
    assert.equal(report.stats.imagesWithoutPathBoundMetadata, 1);
    assert.equal(report.stats.remainingDuplicateCount, null); // historical snapshots do not track this metric
    assert.equal(Object.hasOwn(JSON.parse(readFileSync(target, 'utf8')), 'stats'), false);
});

test('orphan metadata fact alone does not make a wrong poster safe', () => {
    const report = buildEventSnapshotQualityAudit({
        canonicalCount: 1,
        remainingDuplicateCount: 2,
        items: [{ event: { ...event, imagePaths: ['posters/alien.jpg'], verifiedImagePaths: [] } }],
    });
    assert.equal(report.stats.cardsWithSafePoster, 0);
    assert.equal(report.stats.remainingDuplicateCount, 2);
    assert.equal(report.stats.imagesWithoutPathBoundMetadata, 1);
});

test('actual orchestrator revision includes verified paths and Vision metadata evidence', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const start = app.indexOf('function computeConfiguredEventSourceRevision(');
    const end = app.indexOf('let verifiedEventSnapshotMemory', start);
    assert.ok(start >= 0 && end > start);
    assert.match(app.slice(start, end), /\.\.\.eventPosterRevisionEvidence\(event\)/u);
});


test('read-only snapshot audit command works on a saved snapshot without database or AI', () => {
    const folder = mkdtempSync(join(tmpdir(), 'event-qa-cli-'));
    const file = join(folder, 'snapshot.json');
    writeVerifiedEventSnapshot({
        sourceRevision: 'cli-fixture', rawCount: 1, canonicalCount: 1,
        remainingDuplicateCount: 0, items: [{ event }],
    }, file);
    const command = new URL('../../scripts/audit-event-snapshot.mjs', import.meta.url);
    const result = spawnSync(process.execPath, [command.pathname, file], {
        encoding: 'utf8', timeout: 10000,
        env: { ...process.env, GIGORAVE_DATA_DIR: folder },
    });
    assert.equal(result.status, 0, result.stderr);
    const report = JSON.parse(result.stdout);
    assert.equal(report.stats.cards, 1);
    assert.equal(report.stats.imagesWithoutPathBoundMetadata, 1);
    assert.equal(report.stats.remainingDuplicateCount, 0);
    assert.equal(readVerifiedEventSnapshot(file).items.length, 1);
});
