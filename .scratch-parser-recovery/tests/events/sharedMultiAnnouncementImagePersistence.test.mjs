import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('one source image persists on every child card with Vision failure facts intact', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'shared-multi-image-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dataDirectory;
    process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');
    const db = await import('../../src/infrastructure/database/index.js?shared-multi-image=' + Date.now());
    const now = Math.floor(Date.now() / 1000);
    const imagePath = 'vk_announcements/litera/8743-1.png';
    const absoluteImagePath = join(dataDirectory, imagePath);
    mkdirSync(join(absoluteImagePath, '..'), { recursive: true });
    const png = Buffer.alloc(1600, 9);
    png.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    png.writeUInt32BE(13, 8);
    png.write('IHDR', 12, 'ascii');
    png.writeUInt32BE(640, 16);
    png.writeUInt32BE(960, 20);
    writeFileSync(absoluteImagePath, png);

    db.upsertVkSourcePost({
        screenName: 'litera', ownerId: -135849070, postId: 8743,
        sourceUrl: 'https://vk.ru/wall-135849070_8743', publishedAt: now,
        rawText: '8 October Jam; 15 October Wine Casino; Halloween week from October 26',
        imageUrls: ['https://cdn.example.test/litera-8743.png'], imagePaths: [imagePath],
        imageVisionFacts: [{
            index: 1, poster: false, imageType: 'other', visionStatus: 'error',
            visionInspected: true, reason: 'empty response', imagePath,
        }],
        contentHash: 'litera-8743', parseStatus: 'events-found', fetchedAt: now,
    });
    db.replaceVkEventsForPost({
        screenName: 'litera', postId: 8743, sourceUrl: 'https://vk.ru/wall-135849070_8743',
        imagePaths: [imagePath], updatedAt: now,
        events: [
            { title: 'Джем', eventDate: '2026-10-08', isMultiAnnouncement: true },
            { title: 'Винное казино', eventDate: '2026-10-15', isMultiAnnouncement: true },
            { title: 'Хэллоуин неделя', eventDate: '2026-10-26', isMultiAnnouncement: true },
        ],
    });

    const sqlite = new DatabaseSync(join(dataDirectory, 'bot.sqlite'), { readOnly: true });
    try {
        const rows = sqlite.prepare('SELECT title, image_paths_json, poster_match_status, poster_match_reason, poster_image_index, poster_vision_facts_json FROM vk_events WHERE screen_name = \'litera\' AND post_id = 8743 ORDER BY event_index').all();
        assert.equal(rows.length, 3);
        for (const row of rows) {
            assert.deepEqual(JSON.parse(row.image_paths_json), [imagePath]);
            assert.equal(row.poster_match_status, 'shared_multi_event_source_image');
            assert.equal(row.poster_match_reason, 'multi-event-shared-source-image');
            assert.equal(row.poster_image_index, 1);
            const [fact] = JSON.parse(row.poster_vision_facts_json);
            assert.equal(fact.fallbackBinding, 'multi-event-shared-source-image');
            assert.equal(fact.poster, false);
            assert.equal(fact.visionStatus, 'error');
        }
    } finally {
        sqlite.close();
    }
});
