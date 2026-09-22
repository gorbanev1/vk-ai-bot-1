import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

import { parseIndexedImageFacts } from '../../src/features/events/eventPosterMatching.js';
import { compareEventsDeterministic, mergeDuplicateEvents } from '../../src/features/events/eventDuplicateResolution.js';

const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('task: semicolon Vision facts keep poster/title/date/venue fields', () => {
    const [fact] = parseIndexedImageFacts('[IMAGE 9] Это афиша события: да; Название: CWT; Дата: 18 сентября; Время: 19:00; Место: Diesel Hall; Участники: CWT');
    assert.equal(fact.index, 9);
    assert.equal(fact.poster, true);
    assert.equal(fact.title, 'CWT');
    assert.equal(fact.dates, '18 сентября');
    assert.equal(fact.venue, 'Diesel Hall');
    assert.equal(fact.participants, 'CWT');
});

test('task: dedupe uses exact calendar day, venue is auxiliary, Diesel Bar/Hall stay distinct', () => {
    const base = { title: 'PEREGRUZ techno party', eventDate: '2026-09-20', eventTime: '18:00', venue: 'Клуб X', participants: 'PEREGRUZ' };
    const nextDay = { ...base, eventDate: '2026-09-21' };
    assert.equal(compareEventsDeterministic(base, nextDay).verdict, 'different');

    const venueVariant = { ...base, venue: 'Другая площадка', eventTime: '23:00' };
    const venueVariantResult = compareEventsDeterministic(base, venueVariant);
    assert.equal(venueVariantResult.verdict, 'ambiguous');
    assert.notEqual(venueVariantResult.hardConflicts?.includes('different-venue'), true);

    const dieselBar = { ...base, venue: 'Diesel Bar' };
    const dieselHall = { ...base, venue: 'Diesel Hall' };
    const diesel = compareEventsDeterministic(dieselBar, dieselHall);
    assert.equal(diesel.verdict, 'different');
    assert.ok(diesel.hardConflicts.includes('different-venue'));
});

test('task: owner-manual merge is asymmetric and keeps owner content/media', () => {
    const old = {
        title: 'Старое название', eventDate: '2026-09-20', eventTime: '17:00', venue: 'Старое место',
        participants: 'old', description: 'old', imagePaths: ['old.jpg'], sourceUrl: 'https://vk.ru/wall-1_1',
        sourceType: 'vk', sourceName: 'old',
    };
    const owner = {
        ownerManual: true,
        title: 'Ручное название', eventDate: '2026-09-20', eventTime: '20:00', venue: 'Ручное место',
        participants: 'owner', description: 'owner', imagePaths: ['owner.jpg'], posterVisionFacts: [{ index: 1, poster: true }],
        sourceUrl: 'manual://owner', sourceType: 'manual', sourceName: 'добавлено владельцем',
    };
    const merged = mergeDuplicateEvents(old, owner, { contour: 'test' });
    assert.equal(merged.ownerManual, true);
    assert.equal(merged.title, owner.title);
    assert.equal(merged.eventTime, owner.eventTime);
    assert.equal(merged.venue, owner.venue);
    assert.equal(merged.description, owner.description);
    assert.deepEqual(merged.imagePaths, ['owner.jpg']);
    assert.ok(merged.mergedSources.length >= 1);
});

test('task: VK opens are capture-serialized with 10-20s gaps; Telegram/Qtickets are not throttled', () => {
    assert.match(app, /const vkLaunchMinMs = 10_000;/u);
    assert.match(app, /const vkLaunchMaxMs = 20_000;/u);
    assert.match(app, /priorVkCaptureWaiter\.promise/u);
    assert.match(app, /randomInt\(vkLaunchMinMs, vkLaunchMaxMs \+ 1\)/u);
    assert.match(app, /source\.kind === 'vk-chat' \|\| source\.kind === 'vk-public'/u);
    assert.match(app, /staggerWindowMs: isVkBrowserSource \? \[vkLaunchMinMs, vkLaunchMaxMs\] : \[0, 0\]/u);
});

test('task: DB reparse resolves confirmed CWT poster #9, preserves posters on unsafe reparse, and locks owner-manual rows', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-refactor-task-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dataDirectory;
    process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');
    const dbApi = await import(`../../src/infrastructure/database/index.js?task=${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);

    const sourcePaths = Array.from({ length: 10 }, (_, i) => `vk_announcements/rb_diesel/13738-${i + 1}.jpg`);
    dbApi.upsertVkSourcePost({
        screenName: 'rb_diesel', ownerId: -1, postId: 13738, sourceUrl: 'https://vk.ru/wall-1_13738', publishedAt: now,
        rawText: 'CWT', imageUrls: sourcePaths.map((_, i) => `https://img/${i + 1}.jpg`), imagePaths: sourcePaths,
        contentHash: 'cwt', parseStatus: 'event', fetchedAt: now,
    });
    dbApi.replaceVkEventsForPost({
        screenName: 'rb_diesel', postId: 13738, sourceUrl: 'https://vk.ru/wall-1_13738', imagePaths: sourcePaths, updatedAt: now,
        mergeStoredEvents: false,
        events: [{
            title: 'CWT', eventDate: '2026-09-20', venue: 'Diesel Hall', imagePaths: ['event_message_cards/old-generated.png'],
            posterMatchStatus: 'no_safe_poster', posterImageIndex: 0, parseMethod: 'fixture', status: 'approved',
        }],
    });
    const sqlite = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    const cwtId = Number(sqlite.prepare("SELECT id FROM vk_events WHERE screen_name='rb_diesel' AND post_id=13738 LIMIT 1").get().id);
    const facts = [{ index: 9, poster: true, posterConfidence: 99, title: 'CWT', dates: '20 сентября', venue: 'Diesel Hall', text: 'Это афиша события: да; Название: CWT' }];
    assert.equal(dbApi.updateStoredEventRecordFromReparse({ sourceType: 'vk', id: cwtId, event: {
        title: 'CWT', eventDate: '2026-09-20', venue: 'Diesel Hall', imagePaths: ['event_message_cards/stale-generated.png'],
        posterMatchStatus: 'exact_poster_match', posterMatchReason: 'date+distinctive-identity', posterImageIndex: 9, posterVisionFacts: facts,
    }}), 1);
    let cwt = sqlite.prepare('SELECT image_paths_json, poster_image_index FROM vk_events WHERE id = ?').get(cwtId);
    assert.deepEqual(JSON.parse(cwt.image_paths_json), ['vk_announcements/rb_diesel/13738-9.jpg']);
    assert.equal(Number(cwt.poster_image_index), 9);

    // Unsafe/empty reparse must not delete Vdovin/intermediate-style existing posters.
    assert.equal(dbApi.updateStoredEventRecordFromReparse({ sourceType: 'vk', id: cwtId, event: {
        title: 'CWT', eventDate: '2026-09-20', venue: 'Diesel Hall', imagePaths: [], posterMatchStatus: 'no_safe_poster', posterImageIndex: 0,
    }}), 1);
    cwt = sqlite.prepare('SELECT image_paths_json FROM vk_events WHERE id = ?').get(cwtId);
    assert.deepEqual(JSON.parse(cwt.image_paths_json), ['vk_announcements/rb_diesel/13738-9.jpg']);

    const manualId = dbApi.saveManualEvent({
        title: 'Owner Truth', eventDate: '2026-09-22', eventTime: '20:00', venue: 'Owner Venue', description: 'owner body',
        imagePaths: ['manual_event_announcements/owner.jpg'], posterMatchStatus: 'legacy_manual_poster', posterImageIndex: 1,
        createdByPlatform: 'vk', createdBy: 1, ownerManual: true,
    });
    assert.equal(dbApi.updateStoredEventRecordFromReparse({ sourceType: 'manual', id: manualId, event: {
        title: 'AUTO OVERWRITE', eventDate: '2026-09-23', venue: 'AUTO', description: 'auto', imagePaths: [],
    }}), 0);
    const manual = sqlite.prepare('SELECT title, event_date, venue, description, image_paths_json, owner_manual FROM manual_events WHERE id = ?').get(manualId);
    assert.equal(manual.title, 'Owner Truth');
    assert.equal(manual.event_date, '2026-09-22');
    assert.equal(manual.venue, 'Owner Venue');
    assert.equal(manual.description, 'owner body');
    assert.deepEqual(JSON.parse(manual.image_paths_json), ['manual_event_announcements/owner.jpg']);
    assert.equal(Number(manual.owner_manual), 1);
    sqlite.close();
});
