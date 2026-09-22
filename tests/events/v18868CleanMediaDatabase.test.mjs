import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

function fakePng(width, height, bytes = 13_500) {
    const buffer = Buffer.alloc(Math.max(24, bytes));
    buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

function putImage(root, relativePath, width, height, bytes) {
    const absolute = join(root, relativePath);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, fakePng(width, height, bytes));
}

test('V188.86 single-event source media is never promoted without positive Vision poster proof', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v18868-db-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dataDirectory;
    process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');

    const dbApi = await import(`../../src/infrastructure/database/index.js?v18868=${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);

    const poster = 'vk_announcements/vavilone_rb/7-1.jpg';
    const ui = 'vk_announcements/vavilone_rb/7-2.jpg';
    putImage(dataDirectory, poster, 640, 960, 16_000);
    // Large VK avatars can look like a valid poster by dimensions alone. The
    // source URL role (`ava=1`) must remove them before ambiguity counting.
    putImage(dataDirectory, ui, 1080, 1080, 360_000);

    dbApi.upsertVkSourcePost({
        screenName: 'vavilone_rb', ownerId: -240444315, postId: 7,
        sourceUrl: 'https://vk.ru/wall-240444315_7', publishedAt: now,
        rawText: 'SENAMIRHA 11 октября', imageUrls: ['https://img/poster?cs=640x0', 'https://img/ui?ava=1&cs=100x100'],
        imagePaths: [poster, ui], imageMedia: [
            { url: 'https://img/poster', origin: 'outer-message', repostDepth: 0 },
            { url: 'https://img/ui', origin: 'outer-message', repostDepth: 0 },
        ],
        contentHash: 'public-clean-media', parseStatus: 'events-found', fetchedAt: now,
    });
    dbApi.replaceVkEventsForPost({
        screenName: 'vavilone_rb', postId: 7, sourceUrl: 'https://vk.ru/wall-240444315_7',
        imagePaths: [poster, ui], updatedAt: now,
        events: [{
            title: 'SENAMIRHA', eventDate: '2099-10-11', venue: 'Vavilon',
            imagePaths: [poster], posterMatchStatus: 'no_safe_poster', posterMatchReason: 'legacy-ambiguous',
            posterImageIndex: 0, parseMethod: 'fixture', status: 'approved',
        }],
    });

    // V188.70: this must happen at ingest time too, not only during a
    // one-shot startup migration. Otherwise every later parser run recreates
    // the exact same posterless card until the next release/backfill.
    {
        const immediateCheck = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
        try {
            const publicRow = immediateCheck.prepare(`SELECT poster_match_status, poster_match_reason, poster_image_index FROM vk_events WHERE screen_name = ? AND post_id = ?`).get('vavilone_rb', 7);
            assert.equal(publicRow.poster_match_status, 'no_safe_poster');
            assert.match(publicRow.poster_match_reason, /no-safe-poster|legacy-ambiguous|not-confirmed-as-poster/u);
            assert.equal(Number(publicRow.poster_image_index), 0);
        } finally {
            immediateCheck.close();
        }
    }

    const chatPhoto1 = 'vk_chat_announcements/vk-chat-22/4928-1.jpg';
    const chatPhoto2 = 'vk_chat_announcements/vk-chat-22/4928-2.jpg';
    putImage(dataDirectory, chatPhoto1, 640, 960, 16_000);
    putImage(dataDirectory, chatPhoto2, 800, 800, 16_000);
    dbApi.upsertVkChatSourceMessage({
        peerId: 22, conversationMessageId: 4928,
        conversationUrl: 'https://vk.com/im?sel=c22', conversationName: 'Беседа 22',
        senderId: 1, createdAt: now, rawText: 'Юбилейная 5-я вылазка-знакомство',
        links: ['https://vk.ru/wall34296976_8093'], repostUrls: ['https://vk.ru/wall34296976_8093'],
        imageUrls: ['https://img/photo1', 'https://img/photo2'], imagePaths: [chatPhoto1],
        imageMedia: [
            { url: 'https://img/photo1', origin: 'repost-wall', repostDepth: 1 },
            { url: 'https://img/photo2', origin: 'repost-wall', repostDepth: 1 },
        ],
        provenance: { canonicalPostUrl: 'https://vk.ru/wall34296976_8093', canonicalOrigin: 'repost-wall' },
        contentHash: 'chat-two-photos', parseStatus: 'events-found', fetchedAt: now,
    });
    dbApi.replaceVkChatEventsForMessage({
        peerId: 22, conversationMessageId: 4928, sourceUrl: 'https://vk.ru/wall34296976_8093',
        imagePaths: [chatPhoto1, chatPhoto2], updatedAt: now,
        provenance: { canonicalPostUrl: 'https://vk.ru/wall34296976_8093', canonicalOrigin: 'repost-wall', sourceChatName: 'Беседа 22' },
        events: [{
            title: 'Юбилейная 5-я вылазка-знакомство', eventDate: '2099-09-20', venue: 'Лес',
            // Simulate the unsafe interim V188.68 v1 migration: only the first
            // local path was persisted, so it was wrongly grandfathered.
            imagePaths: [chatPhoto1], posterMatchStatus: 'legacy_clean_single_repost_poster', posterMatchReason: 'interim-v1-wrong',
            posterImageIndex: 1, parseMethod: 'fixture', status: 'approved',
        }],
    });

    dbApi.backfillCleanLegacyPosterBindingsV18868({ force: true });

    const check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    try {
        const publicRow = check.prepare(`SELECT poster_match_status, poster_image_index FROM vk_events WHERE screen_name = ? AND post_id = ?`).get('vavilone_rb', 7);
        assert.equal(publicRow.poster_match_status, 'no_safe_poster');
        assert.equal(Number(publicRow.poster_image_index), 0);

        const chatRow = check.prepare(`SELECT poster_match_status, poster_match_reason, poster_image_index, image_paths_json FROM vk_chat_events WHERE peer_id = ? AND conversation_message_id = ?`).get(22, 4928);
        assert.equal(chatRow.poster_match_status, 'no_safe_poster');
        assert.match(chatRow.poster_match_reason, /no-safe-poster|unsafe|legacy|not-confirmed-as-poster/u);
        assert.equal(Number(chatRow.poster_image_index), 0);
        assert.deepEqual(JSON.parse(chatRow.image_paths_json), []);
        const repairedChatPaths = JSON.parse(check.prepare(`SELECT image_paths_json FROM vk_chat_source_messages WHERE peer_id = ? AND conversation_message_id = ?`).get(22, 4928).image_paths_json);
        assert.deepEqual(repairedChatPaths, [chatPhoto1, chatPhoto2]);

        const publicMedia = JSON.parse(check.prepare(`SELECT image_media_json FROM vk_source_posts WHERE screen_name = ? AND post_id = ?`).get('vavilone_rb', 7).image_media_json);
        assert.equal(publicMedia.length, 2);
        const chatMedia = JSON.parse(check.prepare(`SELECT image_media_json FROM vk_chat_source_messages WHERE peer_id = ? AND conversation_message_id = ?`).get(22, 4928).image_media_json);
        assert.equal(chatMedia[0].origin, 'repost-wall');
    } finally {
        check.close();
    }
});
