import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

function envForTest() {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v18897-correction-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dataDirectory;
    process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');
    process.env.GIGORAVE_QTICKETS_DB_PATH = join(dataDirectory, 'qtickets.sqlite');
    return dataDirectory;
}

test('V188.97 owner text correction changes semantic fields but preserves poster path and Vision metadata', async () => {
    const dataDirectory = envForTest();
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18897=${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);
    const sourceUrl = 'https://vk.ru/wall-18897_1';
    dbApi.upsertVkSourcePost({
        screenName: 'fixture', ownerId: -18897, postId: 1, sourceUrl,
        publishedAt: now, rawText: 'старый текст', imageUrls: ['https://example.test/poster.jpg'],
        imagePaths: ['vk_announcements/fixture-1-1.jpg'], imageVisionFacts: [{ index: 1, title: 'OLD POSTER', dates: '18 сентября', poster: true }],
        contentHash: 'v18897', parseStatus: 'events-found', fetchedAt: now,
    });
    dbApi.replaceVkEventsForPost({
        screenName: 'fixture', postId: 1, sourceUrl,
        imagePaths: ['vk_announcements/fixture-1-1.jpg'],
        imageVisionFacts: [{ index: 1, title: 'OLD POSTER', dates: '18 сентября', poster: true }],
        updatedAt: now,
        events: [{
            title: 'Старое название', eventDate: '2099-09-18', eventTime: '20:00', venue: 'Старое место',
            participants: 'Old Artist', price: '100 ₽', description: 'старый анонс', status: 'approved', parseMethod: 'fixture',
            imagePaths: ['vk_announcements/fixture-1-1.jpg'], posterImageIndex: 1,
            posterMatchStatus: 'verified_title_date_poster', posterMatchReason: 'fixture',
            posterVisionFacts: [{ index: 1, title: 'OLD POSTER', dates: '18 сентября', poster: true }],
            eventTags: ['rock'],
        }],
    });

    let check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    const id = Number(check.prepare(`SELECT id FROM vk_events WHERE screen_name='fixture' AND post_id=1`).get().id);
    const before = check.prepare(`SELECT image_paths_json, poster_vision_facts_json FROM vk_events WHERE id=?`).get(id);
    check.close();

    const changed = dbApi.updateStoredEventSemanticFieldsByOwner({
        sourceType: 'vk', id,
        event: {
            title: 'Новое название', eventDate: '2099-09-18', eventTime: '21:00', venue: 'Тупик',
            participants: 'New Artist', price: '500 ₽', description: 'новый анонс', evidence: 'owner text',
            eventTags: ['punk-rock', 'live'],
        },
        sourceText: 'Новый текст анонса',
        updatedAt: now + 1,
    });
    assert.equal(changed, 1);

    check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    const after = check.prepare(`SELECT title,event_date,event_time,venue,participants,price,description,image_paths_json,poster_vision_facts_json,event_tags_json FROM vk_events WHERE id=?`).get(id);
    check.close();
    assert.equal(after.title, 'Новое название');
    assert.equal(after.event_time, '21:00');
    assert.equal(after.venue, 'Тупик');
    assert.equal(after.image_paths_json, before.image_paths_json);
    assert.equal(after.poster_vision_facts_json, before.poster_vision_facts_json);
    assert.deepEqual(JSON.parse(after.event_tags_json), ['punk-rock', 'live']);
});
