import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import {
    MAIN_DATABASE_PATH, getTelegramPostMeta, getVkPostMeta,
    upsertManualParserSeenItem, getManualParserSeenItem,
    persistTelegramSourceAndEvents, persistVkSourceAndEvents,
} from '../../src/infrastructure/database/index.js';

const timestamp = Math.floor(Date.now() / 1000);
const sourceTelegram = (rawText, messageId) => ({
    channel: 'stage5-test-channel', messageId, sourceUrl: `https://t.me/stage5-test-channel/${messageId}`,
    publishedAt: timestamp, rawText, imageUrls: [], imagePaths: [], contentHash: rawText,
    textFingerprint: rawText, imageFingerprints: [], imageVisionFacts: [], parseStatus: 'event', fetchedAt: timestamp,
});
const sourceVk = (rawText, postId) => ({
    screenName: 'stage5-test-public', ownerId: -100001, postId,
    sourceUrl: `https://vk.com/wall-100001_${postId}`,
    publishedAt: timestamp, rawText, imageUrls: [], imagePaths: [], imageMedia: [], contentHash: rawText,
    textFingerprint: rawText, imageFingerprints: [], imageVisionFacts: [], parseStatus: 'event', fetchedAt: timestamp,
});

// A throwing event field fails inside the event writer, AFTER the source
// row has been upserted. Both writes must roll back together.
const failingEvent = () => Object.defineProperty({eventDate: '2099-02-22'}, 'title', {
    enumerable: true, get() { throw new Error('INJECTED_EVENT_WRITER_FAILURE'); },
});
test('Telegram: event-writer failure rolls back the source row', () => {
    const id = 918000001;
    persistTelegramSourceAndEvents({ source: sourceTelegram('before', id), replacement: {
        channel: 'stage5-test-channel', messageId: id, sourceUrl: `https://t.me/stage5-test-channel/${id}`,
        imagePaths: [], events: [{title: 'Before event', eventDate: '2099-02-22', imagePaths: []}], updatedAt: timestamp,
    } });
    const db = new DatabaseSync(MAIN_DATABASE_PATH);
    const before = db.prepare('SELECT title, event_date FROM telegram_events WHERE channel = ? AND message_id = ?').all('stage5-test-channel', id);
    assert.equal(before.length, 1);
    assert.throws(() => persistTelegramSourceAndEvents({
        source: sourceTelegram('after', id),
        replacement: {channel: 'stage5-test-channel', messageId: id, sourceUrl: 'https://t.me/stage5-test-channel/918000001', imagePaths: [], events: [failingEvent()], updatedAt: timestamp},
    }));
    assert.equal(getTelegramPostMeta({channel: 'stage5-test-channel', messageId: id}).rawText, 'before');
    const after = db.prepare('SELECT title, event_date FROM telegram_events WHERE channel = ? AND message_id = ?').all('stage5-test-channel', id);
    assert.deepEqual(after, before);
    db.close();
});

test('VK Public: event-writer failure rolls back the source row', () => {
    const id = 918000002;
    persistVkSourceAndEvents({ source: sourceVk('before', id), replacement: {
        screenName: 'stage5-test-public', postId: id, sourceUrl: `https://vk.com/wall-100001_${id}`,
        imagePaths: [], events: [{title: 'Before event', eventDate: '2099-02-22', imagePaths: []}], updatedAt: timestamp,
    } });
    const db = new DatabaseSync(MAIN_DATABASE_PATH);
    const before = db.prepare('SELECT title, event_date FROM vk_events WHERE screen_name = ? AND post_id = ?').all('stage5-test-public', id);
    assert.equal(before.length, 1);
    assert.throws(() => persistVkSourceAndEvents({
        source: sourceVk('after', id),
        replacement: {screenName: 'stage5-test-public', postId: id, sourceUrl: 'https://vk.com/wall-100001_918000002', imagePaths: [], events: [failingEvent()], updatedAt: timestamp},
    }));
    assert.equal(getVkPostMeta({screenName: 'stage5-test-public', postId: id}).rawText, 'before');
    const after = db.prepare('SELECT title, event_date FROM vk_events WHERE screen_name = ? AND post_id = ?').all('stage5-test-public', id);
    assert.deepEqual(after, before);
    db.close();
});

test('Telegram: ledger final status commits with source and events', () => {
    const id = 918000003;
    upsertManualParserSeenItem({sourceId: 'stage5:tg', itemId: String(id),
        sourceKind: 'telegram', parseStatus: 'processing', contentHash: 'new'});
    persistTelegramSourceAndEvents({
        source: sourceTelegram('new', id),
        replacement: {channel: 'stage5-test-channel', messageId: id,
            sourceUrl: `https://t.me/stage5-test-channel/${id}`, imagePaths: [], events: [], updatedAt: timestamp},
        ledger: {sourceId: 'stage5:tg', itemId: String(id), runId: 'stage5', parseStatus: 'processed_not_event'},
    });
    assert.equal(getManualParserSeenItem({sourceId: 'stage5:tg', itemId: String(id)}).parseStatus, 'processed_not_event');
});

test('VK Public: rejected replacement leaves retryable ledger and old source/event intact', () => {
    const id = 918000004;
    const sourceId = 'stage5:vk';
    const itemId = String(id);
    persistVkSourceAndEvents({source: sourceVk('before', id), replacement: {
        screenName: 'stage5-test-public', postId: id, sourceUrl: `https://vk.com/wall-100001_${id}`,
        imagePaths: [], events: [{title: 'Before event', eventDate: '2099-02-22'}], updatedAt: timestamp,
    }});
    upsertManualParserSeenItem({sourceId, itemId, sourceKind: 'vk-public', parseStatus: 'failed_retryable', contentHash: 'new'});
    const db = new DatabaseSync(MAIN_DATABASE_PATH);
    const before = db.prepare('SELECT title, event_date FROM vk_events WHERE screen_name = ? AND post_id = ?').all('stage5-test-public', id);
    assert.equal(before.length, 1);
    assert.throws(() => persistVkSourceAndEvents({
        source: sourceVk('after', id), replacement: {
            screenName: 'stage5-test-public', postId: id, sourceUrl: `https://vk.com/wall-100001_${id}`,
            imagePaths: [], events: [failingEvent()], updatedAt: timestamp,
        }, ledger: {sourceId, itemId, runId: 'stage5', parseStatus: 'processed_not_event'},
    }), /INJECTED_EVENT_WRITER_FAILURE/);
    assert.equal(getManualParserSeenItem({sourceId, itemId}).parseStatus, 'failed_retryable');
    assert.equal(getVkPostMeta({screenName: 'stage5-test-public', postId: id}).rawText, 'before');
    assert.deepEqual(db.prepare('SELECT title, event_date FROM vk_events WHERE screen_name = ? AND post_id = ?').all('stage5-test-public', id), before);
    db.close();
});
