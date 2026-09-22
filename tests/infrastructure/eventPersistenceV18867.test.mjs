import assert from 'node:assert/strict';
import test from 'node:test';
import { DatabaseSync } from 'node:sqlite';

const dbModule = await import('../../src/infrastructure/database/index.js');
const {
    MAIN_DATABASE_PATH,
    saveManualEvent,
    updateStoredEventRecordFromReparse,
    upsertVkChatSourceMessage,
    replaceVkChatEventsForMessage,
} = dbModule;

function readOne(sql, ...args) {
    const db = new DatabaseSync(MAIN_DATABASE_PATH, { readOnly: true });
    try { return db.prepare(sql).get(...args); } finally { db.close(); }
}

test('reparse cannot erase good venue, provenance, title/date or verified poster metadata', () => {
    const id = saveManualEvent({
        title: 'Noise Night',
        eventDate: '2099-09-19',
        eventTime: '20:00',
        venue: 'Liverpool Pub',
        sourceUrl: 'https://vk.ru/wall-10_20',
        canonicalPostUrl: 'https://vk.ru/wall-10_20',
        provenanceSourceType: 'manual',
        sourceItemId: 'manual-test',
        canonicalOrigin: 'manual-linked-post',
        imagePaths: ['manual_event_announcements/noise.jpg'],
        posterMatchStatus: 'exact_poster_match',
        posterMatchReason: 'date+title',
        posterImageIndex: 1,
        posterVisionFacts: [{ index: 1, title: 'Noise Night', dates: '19 сентября 2099' }],
        status: 'approved',
    });
    updateStoredEventRecordFromReparse({
        sourceType: 'manual',
        id,
        event: {
            title: '', eventDate: '', eventTime: null, venue: '', sourceUrl: '', imagePaths: [],
            canonicalPostUrl: '', posterMatchStatus: '', posterMatchReason: '', posterImageIndex: 0,
        },
    });
    const row = readOne('SELECT * FROM manual_events WHERE id = ?', id);
    assert.equal(row.title, 'Noise Night');
    assert.equal(row.event_date, '2099-09-19');
    assert.equal(row.venue, 'Liverpool Pub');
    assert.equal(row.canonical_post_url, 'https://vk.ru/wall-10_20');
    assert.equal(row.poster_match_status, 'exact_poster_match');
    assert.equal(row.poster_match_reason, 'date+title');
    assert.equal(row.poster_image_index, 1);
    assert.match(row.image_paths_json, /noise\.jpg/u);
});

test('blank venue persists explicitly as место не указано', () => {
    const id = saveManualEvent({
        title: 'Без места', eventDate: '2099-10-01', venue: '', status: 'approved',
    });
    assert.equal(readOne('SELECT venue FROM manual_events WHERE id = ?', id).venue, 'место не указано');
});

test('VK chat event stores chat origin and canonical wall post separately', () => {
    const peerId = 2000000999;
    const cmid = 1234;
    const provenance = {
        canonicalPostUrl: 'https://vk.ru/wall-99_777',
        sourceType: 'vk_chat',
        sourceChatId: peerId,
        sourceChatName: 'Liverpool Crew',
        sourceMessageId: cmid,
        sourceItemId: `${peerId}:${cmid}`,
        sourceOriginalUrl: 'https://vk.ru/im/convo/999',
        canonicalOrigin: 'chat-repost',
    };
    upsertVkChatSourceMessage({
        peerId, conversationMessageId: cmid, conversationUrl: provenance.sourceOriginalUrl,
        conversationName: provenance.sourceChatName, senderId: 1, createdAt: 1,
        rawText: 'репост', links: ['https://vk.ru/wall-99_777'], repostUrls: ['https://vk.ru/wall-99_777'],
        attachmentLinks: [], imageUrls: [], imagePaths: [], imageVisionFacts: [], provenance,
        contentHash: 'hash', parseStatus: 'event', fetchedAt: 1,
    });
    replaceVkChatEventsForMessage({
        peerId, conversationMessageId: cmid, sourceUrl: provenance.canonicalPostUrl,
        imagePaths: [], updatedAt: 1, provenance,
        events: [{ title: 'Репост-событие', eventDate: '2099-11-11', venue: '' }],
    });
    const row = readOne('SELECT * FROM vk_chat_events WHERE peer_id = ? AND conversation_message_id = ?', peerId, cmid);
    assert.equal(row.canonical_post_url, provenance.canonicalPostUrl);
    assert.equal(row.source_type, 'vk_chat');
    assert.equal(row.source_chat_name, 'Liverpool Crew');
    assert.equal(row.source_message_id, cmid);
    assert.equal(row.canonical_origin, 'chat-repost');
    assert.equal(row.venue, 'место не указано');
});

test('VK chat child event keeps AI structure and its own source segment', () => {
    const peerId = 2000000998;
    const cmid = 1235;
    upsertVkChatSourceMessage({
        peerId, conversationMessageId: cmid,
        conversationUrl: 'https://vk.ru/im/convo/998', conversationName: 'Liverpool Crew',
        senderId: 1, createdAt: 1, rawText: '12.12 гиг и afterparty', links: [],
        imageUrls: [], imagePaths: [], imageVisionFacts: [], provenance: {},
        contentHash: 'hash-structure', parseStatus: 'event', fetchedAt: 1,
    });
    replaceVkChatEventsForMessage({
        peerId, conversationMessageId: cmid, sourceUrl: '', imagePaths: [], updatedAt: 1,
        events: [{
            title: 'Гиг', eventDate: '2099-12-12', venue: 'Liverpool Pub',
            announcement: 'Гиг в Liverpool Pub 12.12',
            sourceSegment: '12.12 — Гиг в Liverpool Pub',
            structureDecision: 'multiple_events',
            structureReason: 'concert and afterparty have separate calls to attend',
            programItems: [{ time: '20:00', text: 'Гиг' }],
            isMultiAnnouncement: 1,
        }],
    });
    const row = readOne('SELECT structure_decision, structure_reason, source_segment_text, program_items_json, is_multi_announcement, description FROM vk_chat_events WHERE peer_id = ? AND conversation_message_id = ?', peerId, cmid);
    assert.equal(row.structure_decision, 'multiple_events');
    assert.match(row.structure_reason, /afterparty/u);
    assert.equal(row.source_segment_text, '12.12 — Гиг в Liverpool Pub');
    assert.deepEqual(JSON.parse(row.program_items_json), [{ time: '20:00', text: 'Гиг' }]);
    assert.equal(row.is_multi_announcement, 1);
    assert.match(row.description, /Гиг в Liverpool Pub/u);
    assert.doesNotMatch(row.description, /afterparty/u);
});

test('migrated database passes quick_check and foreign_key_check', () => {
    const db = new DatabaseSync(MAIN_DATABASE_PATH);
    try {
        assert.equal(db.prepare('PRAGMA quick_check').get().quick_check, 'ok');
        assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    } finally { db.close(); }
});
