import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

function envForTest() {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v18898-correction-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dataDirectory;
    process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');
    process.env.GIGORAVE_QTICKETS_DB_PATH = join(dataDirectory, 'qtickets.sqlite');
    return dataDirectory;
}

test('V188.98 owner semantic correction invalidates a now-unrelated poster without deleting its bytes/metadata', async () => {
    const dataDirectory = envForTest();
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18898=${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);
    const sourceUrl = 'https://vk.ru/wall-18898_1';
    const oldPoster = 'vk_announcements/fixture-1-1.jpg';
    const oldFacts = [{
        index: 1,
        title: 'Дивная Масленица',
        dates: '21 февраля 2099',
        poster: true,
        posterConfidence: 98,
    }];

    dbApi.upsertVkSourcePost({
        screenName: 'fixture98', ownerId: -18898, postId: 1, sourceUrl,
        publishedAt: now, rawText: 'старый текст', imageUrls: ['https://example.test/maslenitsa.jpg'],
        imagePaths: [oldPoster], imageVisionFacts: oldFacts,
        contentHash: 'v18898', parseStatus: 'events-found', fetchedAt: now,
    });
    dbApi.replaceVkEventsForPost({
        screenName: 'fixture98', postId: 1, sourceUrl,
        imagePaths: [oldPoster], imageVisionFacts: oldFacts, updatedAt: now,
        events: [{
            title: 'Дивная Масленица', eventDate: '2099-02-21', eventTime: '17:00', venue: 'Башня',
            participants: 'Дивные люди', description: 'старый анонс', status: 'approved', parseMethod: 'fixture',
            imagePaths: [oldPoster], posterImageIndex: 1,
            posterMatchStatus: 'exact_poster_match', posterMatchReason: 'date+title-majority',
            posterVisionFacts: oldFacts,
        }],
    });

    let check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    const id = Number(check.prepare(`SELECT id FROM vk_events WHERE screen_name='fixture98' AND post_id=1`).get().id);
    check.close();

    const changed = dbApi.updateStoredEventSemanticFieldsByOwner({
        sourceType: 'vk', id,
        event: {
            title: 'Праздник урожая', eventDate: '2099-09-20', eventTime: '17:00', venue: 'Башня, Винзавод',
            participants: 'Дивные люди, Из БЕРЛОГИ, Пахари Моря', description: 'новый анонс',
        },
        sourceText: 'Праздник урожая 20 сентября в 17:00',
        updatedAt: now + 1,
    });
    assert.equal(changed, 1);

    check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    const after = check.prepare(`
        SELECT title,event_date,image_paths_json,poster_vision_facts_json,poster_match_status,poster_match_reason
        FROM vk_events WHERE id=?
    `).get(id);
    check.close();

    assert.equal(after.title, 'Праздник урожая');
    assert.equal(after.event_date, '2099-09-20');
    assert.deepEqual(JSON.parse(after.image_paths_json), [oldPoster], 'source poster bytes/path stay durable for review');
    assert.deepEqual(JSON.parse(after.poster_vision_facts_json), oldFacts, 'Vision evidence stays durable for review');
    assert.equal(after.poster_match_status, 'poster_review_required');
    assert.match(after.poster_match_reason, /^owner-semantic-correction-invalidated-v18898:no-date-match/u);
});

test('V188.98 owner poster replacement overwrites event-level binding and records the new reason', async () => {
    const dataDirectory = envForTest();
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18898replace=${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);

    dbApi.saveManualEvent({
        title: 'Праздник урожая',
        eventDate: '2099-09-20',
        eventTime: '17:00',
        venue: 'Башня',
        participants: 'Пахари Моря',
        description: 'fixture',
        sourceUrl: '',
        sourceText: 'fixture',
        status: 'approved',
        ownerManual: true,
    });

    let check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    const id = Number(check.prepare(`SELECT id FROM manual_events ORDER BY id DESC LIMIT 1`).get().id);
    check.close();

    const newFacts = [{
        index: 1,
        title: 'Праздник урожая',
        dates: '20 сентября 2099',
        poster: true,
        posterConfidence: 99,
    }];
    const changed = dbApi.setStoredEventPosterChoiceV18893({
        sourceType: 'manual',
        id,
        imageIndex: 1,
        imagePath: 'owner_event_corrections/harvest-1.jpg',
        posterVisionFacts: newFacts,
        posterMatchReason: 'owner-replaced-poster-v18898',
        updatedAt: now + 1,
    });
    assert.equal(changed, 1);

    check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    const after = check.prepare(`SELECT image_paths_json,poster_match_status,poster_match_reason,poster_image_index,poster_vision_facts_json FROM manual_events WHERE id=?`).get(id);
    check.close();
    assert.deepEqual(JSON.parse(after.image_paths_json), ['owner_event_corrections/harvest-1.jpg']);
    assert.equal(after.poster_match_status, 'exact_poster_match');
    assert.equal(after.poster_match_reason, 'owner-replaced-poster-v18898');
    assert.equal(after.poster_image_index, 1);
    assert.equal(JSON.parse(after.poster_vision_facts_json)[0].title, 'Праздник урожая');
});
