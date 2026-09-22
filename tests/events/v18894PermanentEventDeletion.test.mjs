import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

function envForTest() {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v18894-delete-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dataDirectory;
    process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');
    process.env.GIGORAVE_QTICKETS_DB_PATH = join(dataDirectory, 'qtickets.sqlite');
    return dataDirectory;
}

test('V188.94 permanent delete blocks reparse by date + rich identity without killing another child event', async () => {
    const dataDirectory = envForTest();
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18894=${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);
    const sourceUrl = 'https://vk.ru/wall-991_15';

    dbApi.upsertVkSourcePost({
        screenName: 'malina_test', ownerId: -991, postId: 15, sourceUrl,
        publishedAt: now, rawText: '15 сентября MALINA PARTY. 15 сентября ДРУГОЙ КОНЦЕРТ.',
        imageUrls: [], imagePaths: [], imageVisionFacts: [], contentHash: 'v18894-a',
        parseStatus: 'events-found', fetchedAt: now,
    });
    dbApi.replaceVkEventsForPost({
        screenName: 'malina_test', postId: 15, sourceUrl, imagePaths: [], updatedAt: now,
        events: [
            { title: 'Malina Party', eventDate: '2099-09-15', venue: 'Malina Lounge', description: 'Malina Party с группой X', status: 'approved', parseMethod: 'fixture' },
            { title: 'Другой концерт', eventDate: '2099-09-15', venue: 'Malina Lounge', description: 'Совсем другое событие', status: 'approved', parseMethod: 'fixture' },
        ],
    });

    const deleted = dbApi.permanentlyDeleteStoredEvent({
        sourceType: 'vk', sourceUrl, canonicalPostUrl: sourceUrl, sourceItemId: 'malina_test:15',
        title: 'Malina Party', eventDate: '2099-09-15', venue: 'Malina Lounge', description: 'Malina Party с группой X',
    }, { reason: 'test', createdByPlatform: 'telegram', createdBy: 1 });
    assert.equal(deleted.added, true);
    assert.equal(deleted.deleted.changed, 1, 'same-date second child must survive permanent delete of first child');

    let check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    let rows = check.prepare(`SELECT title, status FROM vk_events WHERE screen_name = ? AND post_id = ? ORDER BY event_index`).all('malina_test', 15);
    assert.equal(rows.find((row) => row.title === 'Malina Party')?.status, 'ignored');
    assert.equal(rows.find((row) => row.title === 'Другой концерт')?.status, 'approved');
    check.close();

    // Reparse replaces source rows. The permanent child must be filtered before
    // insert even when AI shortened the title, while the other child is kept.
    dbApi.replaceVkEventsForPost({
        screenName: 'malina_test', postId: 15, sourceUrl, imagePaths: [], updatedAt: now + 1,
        events: [
            { title: 'MALINA', eventDate: '2099-09-15', venue: 'Malina', description: 'Malina Party с группой X', status: 'approved', parseMethod: 'fixture-reparse' },
            { title: 'Другой концерт', eventDate: '2099-09-15', venue: 'Malina Lounge', description: 'Совсем другое событие', status: 'approved', parseMethod: 'fixture-reparse' },
        ],
    });
    check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    rows = check.prepare(`SELECT title, status FROM vk_events WHERE screen_name = ? AND post_id = ? ORDER BY event_index`).all('malina_test', 15);
    assert.deepEqual(rows.map((row) => row.title), ['Другой концерт']);
    assert.equal(rows[0].status, 'approved');
    check.close();

    // Ordinary delete is intentionally temporary: the next reparse can bring it back.
    const soft = dbApi.softDeleteMatchingStoredEvents({
        sourceType: 'vk', sourceUrl, canonicalPostUrl: sourceUrl, sourceItemId: 'malina_test:15',
        title: 'Другой концерт', eventDate: '2099-09-15', venue: 'Malina Lounge', description: 'Совсем другое событие',
    });
    assert.equal(soft.changed, 1);
    dbApi.replaceVkEventsForPost({
        screenName: 'malina_test', postId: 15, sourceUrl, imagePaths: [], updatedAt: now + 2,
        events: [{ title: 'Другой концерт', eventDate: '2099-09-15', venue: 'Malina Lounge', description: 'Совсем другое событие', status: 'approved', parseMethod: 'fixture-reparse-2' }],
    });
    check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    rows = check.prepare(`SELECT title, status FROM vk_events WHERE screen_name = ? AND post_id = ?`).all('malina_test', 15);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].title, 'Другой концерт');
    assert.equal(rows[0].status, 'approved');
    check.close();
});

test('V188.94 owner-manual event obeys the same permanent deletion registry', async () => {
    envForTest();
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18894manual=${Date.now()}`);
    const id = dbApi.saveManualEvent({
        title: 'Owner Rave', eventDate: '2099-10-01', venue: 'Тупик', participants: 'Artist One',
        description: 'Owner Rave в Тупике', sourceUrl: 'https://vk.ru/wall-777_9', ownerManual: true,
    });
    assert.ok(id > 0);
    const result = dbApi.permanentlyDeleteStoredEvent({
        id, sourceType: 'manual', title: 'Owner Rave', eventDate: '2099-10-01', venue: 'Тупик', participants: 'Artist One',
        description: 'Owner Rave в Тупике', sourceUrl: 'https://vk.ru/wall-777_9', canonicalPostUrl: 'https://vk.ru/wall-777_9',
    }, { reason: 'test-owner-manual' });
    assert.equal(result.deleted.changed, 1);
    const secondId = dbApi.saveManualEvent({
        title: 'Owner Rave', eventDate: '2099-10-01', venue: 'Тупик', participants: 'Artist One',
        description: 'Owner Rave в Тупике', sourceUrl: 'https://vk.ru/wall-777_9', ownerManual: true,
    });
    assert.equal(secondId, 0, 'permanent owner-manual deletion must block later re-add');
});


test('V188.94 owner-manual soft delete can be added again because no permanent fingerprint is created', async () => {
    envForTest();
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18894manualsoft=${Date.now()}`);
    const payload = {
        title: 'Manual Soft Event', eventDate: '2099-11-02', venue: 'Liverpool', participants: 'Artist Two',
        description: 'Manual soft delete fixture', sourceUrl: 'https://vk.ru/wall-778_10', ownerManual: true,
    };
    const first = dbApi.saveManualEvent(payload);
    assert.ok(first > 0);
    const deleted = dbApi.softDeleteMatchingStoredEvents({ ...payload, id: first, sourceType: 'manual', canonicalPostUrl: payload.sourceUrl });
    assert.equal(deleted.changed, 1);
    const second = dbApi.saveManualEvent(payload);
    assert.ok(second > first, 'soft delete must not block later owner re-add');
});

test('V188.94 moderation routing clearly separates soft delete from permanent delete', async () => {
    const { parseEventModerationCommand } = await import('../../src/features/events/eventModerationRouting.js');
    assert.deepEqual(parseEventModerationCommand('тусы удалить Malina Party'), { action: 'delete', query: 'Malina Party' });
    assert.deepEqual(parseEventModerationCommand('тусы удалить насовсем Malina Party'), { action: 'delete-permanent', query: 'Malina Party' });
    assert.deepEqual(parseEventModerationCommand('удалить тусу навсегда Malina Party'), { action: 'delete-permanent', query: 'Malina Party' });
});

test('V188.94 historical cleanup helper is retention-only and cannot delete past events', async () => {
    const dataDirectory = envForTest();
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18894retention=${Date.now()}`);
    const id = dbApi.saveManualEvent({
        title: 'Historical retained event', eventDate: '2000-01-01', venue: 'Liverpool', description: 'archive fixture', ownerManual: false,
    });
    assert.ok(id > 0);
    const result = dbApi.cleanupExpiredEventData({ beforeDate: '2099-01-01' });
    assert.equal(result.disabled, true);
    const check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    const row = check.prepare('SELECT id, title FROM manual_events WHERE id = ?').get(id);
    check.close();
    assert.equal(row?.title, 'Historical retained event');
});
