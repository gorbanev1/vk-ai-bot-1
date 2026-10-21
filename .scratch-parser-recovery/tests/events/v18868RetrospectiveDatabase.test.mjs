import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

test('V188.68 DB repair ignores persisted VK photo reports but preserves a real future announcement', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v18868-retro-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dataDirectory;
    process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18868-retro=${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);

    const photoReport = [
        'Рок-бар "The last of Vavilone"',
        'Как мы провожали лето!',
        'Было круто.',
        '1/10',
        'Следующий слайд',
    ].join('\n');
    dbApi.upsertVkSourcePost({
        screenName: 'vavilone_rb', ownerId: -1, postId: 4529,
        sourceUrl: 'https://vk.ru/wall-1_4529', publishedAt: 0,
        rawText: photoReport, imageUrls: [], imagePaths: [], contentHash: 'retro', parseStatus: 'event', fetchedAt: now,
    });
    dbApi.replaceVkEventsForPost({
        screenName: 'vavilone_rb', postId: 4529, sourceUrl: 'https://vk.ru/wall-1_4529', imagePaths: [], updatedAt: now,
        events: [{ title: 'Как мы провожали лето!', eventDate: '2026-10-01', venue: 'Vavilone', evidence: '1/10', parseMethod: 'fixture', status: 'approved' }],
    });

    const genuineFuture = [
        'Приглашаем на фестиваль 1.10.2026',
        'Мы сохраним атмосферу так, как это было задумано.',
        'Двери: 19:30',
    ].join('\n');
    dbApi.upsertVkSourcePost({
        screenName: 'rb_diesel', ownerId: -2, postId: 13685,
        sourceUrl: 'https://vk.ru/wall-2_13685', publishedAt: 0,
        rawText: genuineFuture, imageUrls: [], imagePaths: [], contentHash: 'future', parseStatus: 'event', fetchedAt: now,
    });
    dbApi.replaceVkEventsForPost({
        screenName: 'rb_diesel', postId: 13685, sourceUrl: 'https://vk.ru/wall-2_13685', imagePaths: [], updatedAt: now,
        events: [{ title: 'Дрфест', eventDate: '2026-10-01', venue: 'Diesel Hall', evidence: '1.10.2026', parseMethod: 'fixture', status: 'approved' }],
    });

    dbApi.backfillRetrospectiveFalsePositivesV18868({ force: true, now: new Date('2026-09-14T12:00:00Z') });

    const check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    try {
        const bad = check.prepare(`SELECT status FROM vk_events WHERE screen_name = 'vavilone_rb' AND post_id = 4529`).get();
        assert.equal(bad.status, 'ignored');
        const badSource = check.prepare(`SELECT parse_status FROM vk_source_posts WHERE screen_name = 'vavilone_rb' AND post_id = 4529`).get();
        assert.equal(badSource.parse_status, 'not_event_retrospective');

        const good = check.prepare(`SELECT status FROM vk_events WHERE screen_name = 'rb_diesel' AND post_id = 13685`).get();
        assert.equal(good.status, 'approved');
    } finally {
        check.close();
    }
});
