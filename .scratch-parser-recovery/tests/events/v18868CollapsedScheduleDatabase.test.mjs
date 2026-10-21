import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import test from 'node:test';

function fakePng(width = 640, height = 960, bytes = 16_000) {
    const buffer = Buffer.alloc(bytes);
    buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

test('V188.68 DB repair expands collapsed Diesel HALL/BAR parent into ten children', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v18868-schedule-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dataDirectory;
    process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18868-schedule=${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);

    const text = `запись закреплена
Друзья, мы составили пост-график ваших будущих планов на вечер в этом сентябре.
12.09
HALL: ASCENSION OF THE INEFFABLE GIG | 12.09 | Воронеж
BAR: DEXDBELL - Воронеж "Diesel Rock Bar"
17.09
BAR: Метал с берегов Невы, Воронеж
18.09
BAR: SPOOKERS | 18.09 Воронеж
19.09
HALL: Placebo & MCR Tribute 19.09 - Воронеж / Diesel
BAR: NO PLACE FOR OLD PADS 19.09 в Diesel Bar
25.09
BAR: SYSTEM OF A DOWN by CHOPSY Воронеж
26.09
HALL: STONEHAND (ВОРОНЕЖ) DIESEL HALL
BAR: 26 сентября | CWT | Воронеж - Презентация альбом
27.09
BAR: Ospa 1959 - Воронеж 27.09`;
    const paths = [];
    const urls = [];
    for (let index = 1; index <= 10; index += 1) {
        const relative = `vk_announcements/rb_diesel/13738-${index}.jpg`;
        const absolute = join(dataDirectory, relative);
        mkdirSync(join(absolute, '..'), { recursive: true });
        writeFileSync(absolute, fakePng());
        paths.push(relative);
        urls.push(`https://img/${index}.jpg?cs=640x0`);
    }
    dbApi.upsertVkSourcePost({
        screenName: 'rb_diesel', ownerId: -117292629, postId: 13738,
        sourceUrl: 'https://vk.ru/wall-117292629_13738', publishedAt: 0,
        rawText: text, imageUrls: urls, imagePaths: paths.slice(0, 8),
        contentHash: 'diesel-parent', parseStatus: 'event', fetchedAt: now,
    });
    const factText = `[Факты с афиши]
[IMAGE 1]
Название: ASCENSION OF THE INEFFABLE GIG
Дата: 12.09
Место: DIESEL HALL
Участники: BRUMA
[IMAGE 2]
Название: DEXDBELL
Дата: 12/09
Место: Diesel Rock Bar
Участники: DEXDBELL`;
    dbApi.replaceVkEventsForPost({
        screenName: 'rb_diesel', postId: 13738, sourceUrl: 'https://vk.ru/wall-117292629_13738', imagePaths: [paths[0]], updatedAt: now,
        events: [{
            title: 'запись закреплена', eventDate: '2026-09-25', eventTime: '18:30', venue: 'DIESEL HALL', participants: 'BRUMA',
            description: `${text}\n${factText}`, evidence: '25.09.26', imagePaths: [paths[0]], parseMethod: 'fixture', status: 'approved',
        }],
    });

    dbApi.backfillCollapsedLabeledSchedulesV18868({ force: true });

    const check = new DatabaseSync(join(dataDirectory, 'bot.sqlite'));
    try {
        const events = check.prepare(`SELECT * FROM vk_events WHERE screen_name = 'rb_diesel' AND post_id = 13738 ORDER BY event_index`).all();
        assert.equal(events.length, 10);
        assert.equal(events.filter((row) => row.event_date === '2026-09-19').length, 2);
        assert.equal(events.filter((row) => row.event_date === '2026-09-26').length, 2);
        assert.equal(events[0].title.includes('ASCENSION'), true);
        assert.equal(events[0].poster_match_status, 'no_safe_poster');
        assert.deepEqual(JSON.parse(events[0].image_paths_json), []);
        assert.equal(events[1].poster_match_status, 'no_safe_poster');
        assert.deepEqual(JSON.parse(events[1].image_paths_json), []);
        assert.equal(events[7].poster_match_status, 'no_safe_poster');

        const sourcePaths = JSON.parse(check.prepare(`SELECT image_paths_json FROM vk_source_posts WHERE screen_name='rb_diesel' AND post_id=13738`).get().image_paths_json);
        assert.equal(sourcePaths.length, 10);
    } finally {
        check.close();
    }
});
