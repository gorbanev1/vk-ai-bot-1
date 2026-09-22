import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { parseEventModerationCommand } from '../../src/features/events/eventModerationRouting.js';
import { getEventPosterSafetyAssessment } from '../../src/features/events/eventProvenance.js';

test('owner-only full image review is a separate explicit command', () => {
    assert.equal(parseEventModerationCommand('тусы картинки полная проверка')?.action, 'image-metadata-full-audit');
    assert.equal(parseEventModerationCommand('тусы афиши все через ии')?.action, 'image-metadata-full-audit');
    assert.equal(parseEventModerationCommand('тусы метаданные картинок заполнить')?.action, 'image-metadata-backfill');
    assert.equal(parseEventModerationCommand('тусы исходники картинки через vision')?.action, 'source-image-vision-audit');
    assert.equal(parseEventModerationCommand('тусы источники восстановить')?.action, 'source-recovery');
});

test('explicit manual poster binding is exact event + image, not a global AI override', () => {
    const path = 'vk_announcements/festival/188100-1.jpg';
    const fact = { index: 1, imagePath: path, poster: true, title: 'Чужой концерт', dates: '1 января 2099',
        ownerConfirmedBinding: { eventId: 101, eventTitle: 'Своя туса', eventDate: '2099-02-02', imageIndex: 1,
            imagePath: path, decision: 'yes', at: 42 } };
    const event = { id: 101, title: 'Своя туса', eventDate: '2099-02-02', imagePaths: [path], posterImageIndex: 1,
        posterMatchStatus: 'exact_poster_match', posterVisionFacts: [fact] };
    const result = getEventPosterSafetyAssessment(event);
    assert.equal(result.accepted, true);
    assert.equal(result.ownerConfirmed, true);
    assert.equal(result.boundPath, path);
    assert.equal(getEventPosterSafetyAssessment({ ...event, id: 102 }).accepted, false);
    assert.equal(getEventPosterSafetyAssessment({ ...event, title: 'Другая туса' }).accepted, false);
    assert.equal(getEventPosterSafetyAssessment({ ...event, eventDate: '2099-02-03' }).accepted, false);
    assert.equal(getEventPosterSafetyAssessment({ ...event, imagePaths: ['vk_announcements/other.jpg'] }).accepted, false);
});

test('owner rejects all or approves one image without deleting source media; future auto-reconcile preserves decision', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'gigorave-owner-poster-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dir;
    process.env.GIGORAVE_DB_PATH = join(dir, 'bot.sqlite');
    process.env.QTICKETS_DB_PATH = join(dir, 'qtickets.sqlite');
    const db = await import(`../../src/infrastructure/database/index.js?ownerPoster=${Date.now()}`);
    const stamp = Math.floor(Date.now() / 1000);
    const path = 'vk_announcements/owner188100/1-1.jpg';
    const facts = [{ index: 1, poster: true, title: 'Чужой концерт', dates: '1 января 2099', imagePath: path,
        posterConfidence: 95 }];
    db.upsertVkSourcePost({ screenName: 'owner188100', ownerId: -188100, postId: 1,
        sourceUrl: 'https://vk.ru/wall-188100_1', publishedAt: stamp,
        rawText: 'Своя туса 2 февраля 2099', imageUrls: ['https://example.test/1.jpg'], imagePaths: [path],
        imageVisionFacts: facts, contentHash: 'owner188100', parseStatus: 'events-found', fetchedAt: stamp });
    db.replaceVkEventsForPost({ screenName: 'owner188100', postId: 1,
        sourceUrl: 'https://vk.ru/wall-188100_1', imagePaths: [path], imageVisionFacts: facts, updatedAt: stamp,
        events: [{ title: 'Своя туса', eventDate: '2099-02-02', venue: 'Котельная',
            participants: 'Группа', status: 'approved', parseMethod: 'fixture',
            imagePaths: [path], posterImageIndex: 1, posterMatchStatus: 'poster_review_required',
            posterMatchReason: 'fixture', posterVisionFacts: facts }] });
    const conn = new DatabaseSync(join(dir, 'bot.sqlite'));
    const id = Number(conn.prepare('SELECT id FROM vk_events WHERE post_id = 1').get().id);
    const reconcile = () => db.reconcileStoredEventPosterFromMetadataV18892({ sourceType: 'vk', id,
        sourceImagePaths: [path], sourceVisionFacts: facts });
    const proposed = reconcile();
    assert.equal(proposed.action.includes('review-required'), true);
    assert.equal(Number(conn.prepare('SELECT COUNT(*) AS n FROM vk_source_posts').get().n), 1);
    assert.equal(db.setStoredEventPosterChoiceV18893({ sourceType: 'vk', id, imageIndex: 1,
        imagePath: path, posterVisionFacts: facts,
        posterMatchReason: 'owner-confirmed-poster-for-this-event-v188100' }), 1);
    const approved = conn.prepare('SELECT poster_match_reason,poster_vision_facts_json,image_paths_json FROM vk_events WHERE id = ?').get(id);
    assert.match(approved.poster_match_reason, /^owner-confirmed-poster-/u);
    const boundFact = JSON.parse(approved.poster_vision_facts_json)[0];
    assert.equal(boundFact.ownerConfirmedBinding.eventId, id);
    assert.equal(boundFact.ownerConfirmedBinding.eventDate, '2099-02-02');
    assert.equal(getEventPosterSafetyAssessment({ id, title: 'Своя туса', eventDate: '2099-02-02',
        imagePaths: JSON.parse(approved.image_paths_json), posterImageIndex: 1,
        posterMatchStatus: 'exact_poster_match', posterVisionFacts: [boundFact] }).accepted, true);
    assert.equal(reconcile().action, 'owner-poster-decision-locked');
    conn.prepare("UPDATE vk_events SET poster_match_status = 'poster_review_required', poster_match_reason = 'fixture' WHERE id = ?").run(id);
    assert.equal(db.setStoredEventPosterReviewDeclinedV188100({ sourceType: 'vk', id }), 1);
    const rejected = conn.prepare('SELECT image_paths_json,poster_match_status,poster_match_reason FROM vk_events WHERE id = ?').get(id);
    assert.equal(rejected.poster_match_status, 'no_safe_poster');
    assert.match(rejected.poster_match_reason, /^owner-rejected-all-proposals-/u);
    assert.deepEqual(JSON.parse(rejected.image_paths_json), [path]);
    assert.equal(reconcile().action, 'owner-poster-decision-locked');
    assert.equal(Number(conn.prepare('SELECT COUNT(*) AS n FROM vk_source_posts').get().n), 1);
    db.upsertVkSourcePost({ screenName: 'raw-only188100', ownerId: -188100, postId: 2,
        sourceUrl: 'https://vk.ru/wall-188100_2', publishedAt: stamp, rawText: 'афиша на фото',
        imageUrls: ['https://example.test/raw-only.jpg'], imagePaths: ['vk_announcements/raw-only188100/2-1.jpg'],
        imageVisionFacts: [], contentHash: 'raw-only', parseStatus: 'captured', fetchedAt: stamp });
    const sourceGroups = db.getAllStoredSourceImageAuditGroupsV188100();
    const orphan = sourceGroups.find((group) => group.sourceType === 'vk' && group.sourceKey === 'raw-only188100:2');
    assert.ok(orphan, 'old raw-only source images must also be audited');
    assert.equal(orphan.events.length, 0, 'Vision metadata alone must not create an event');
    assert.equal(orphan.imagePaths.length, 1);
    conn.close();
});

test('a confirmed dedupe transfers owner-approved poster only to the same-date canonical event', async () => {
    const { mergeDuplicateEvents } = await import('../../src/features/events/eventDuplicateResolution.js');
    const path = 'vk_announcements/festival/188100-1.jpg';
    const fact = { index: 1, imagePath: path, poster: true, posterConfidence: 95,
        title: 'Чужой концерт', dates: '1 января 2099',
        ownerConfirmedBinding: { eventId: 101, eventTitle: 'Своя туса', eventDate: '2099-02-02',
            imageIndex: 1, imagePath: path, decision: 'yes', at: 42 } };
    const owner = { id: 101, sourceType: 'vk', title: 'Своя туса', eventDate: '2099-02-02',
        imagePaths: [path], posterImageIndex: 1, posterMatchStatus: 'exact_poster_match',
        posterVisionFacts: [fact], sourceUrl: 'https://vk.ru/wall-188100_1', venue: 'Бар Тупик' };
    const other = { id: 102, sourceType: 'telegram', title: 'Своя туса', eventDate: '2099-02-02',
        imagePaths: [], posterImageIndex: 0, posterMatchStatus: 'no_safe_poster',
        posterVisionFacts: [], sourceUrl: 'https://t.me/test/102', venue: 'Бар Тупик' };
    const merged = mergeDuplicateEvents(owner, other);
    const assessment = getEventPosterSafetyAssessment(merged);
    assert.equal(assessment.accepted, true);
    assert.equal(assessment.boundPath, path);
    assert.equal(assessment.ownerConfirmed, true);
    assert.equal(getEventPosterSafetyAssessment({ ...merged, eventDate: '2099-02-03' }).accepted, false);
});
