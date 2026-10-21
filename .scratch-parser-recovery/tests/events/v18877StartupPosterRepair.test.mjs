import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { assignEventImageIndexesFromParsedFacts } from '../../src/features/events/eventPosterMatching.js';

function fakePng(width, height, bytes = 16_000) {
    const buffer = Buffer.alloc(Math.max(24, bytes));
    buffer.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a], 0);
    buffer.writeUInt32BE(13, 8);
    buffer.write('IHDR', 12, 'ascii');
    buffer.writeUInt32BE(width, 16);
    buffer.writeUInt32BE(height, 20);
    return buffer;
}

test('V188.77 can restore a poster from vision facts already persisted in SQLite', () => {
    const [mapped] = assignEventImageIndexesFromParsedFacts([
        { title: 'Сквозь время', eventDate: '2026-09-18', venue: 'Мама Анархия', participants: 'Владимир и Мария Флавиановы' },
    ], [{
        index: 2,
        imageType: 'poster', poster: true, posterConfidence: 99, textReadability: 96,
        title: 'Сквозь время', dates: '18.09.2026', venue: 'Рок-ПАБ Мама Анархия',
        participants: 'Владимир и Мария Флавиановы', text: 'Сквозь время 18.09.2026',
    }]);
    assert.equal(mapped.posterImageIndex, 2);
    assert.equal(mapped.posterMatchStatus, 'exact_poster_match');
});

test('V188.77 exposes source media after V188.73 cleared only the event binding and writes a durable once marker', async () => {
    const dataDirectory = mkdtempSync(join(tmpdir(), 'gigorave-v18877-db-'));
    process.env.NODE_ENV = 'test';
    process.env.GIGORAVE_DATA_DIR = dataDirectory;
    process.env.GIGORAVE_DB_PATH = join(dataDirectory, 'bot.sqlite');
    const dbApi = await import(`../../src/infrastructure/database/index.js?v18877=${Date.now()}`);
    const now = Math.floor(Date.now() / 1000);
    const relative = 'vk_announcements/idmamaanarchy/1183-1.png';
    const absolute = join(dataDirectory, relative);
    mkdirSync(join(absolute, '..'), { recursive: true });
    writeFileSync(absolute, fakePng(1080, 1529));

    dbApi.upsertVkSourcePost({
        screenName: 'idmamaanarchy', ownerId: -226190294, postId: 1183,
        sourceUrl: 'https://vk.ru/wall-226190294_1183', publishedAt: now,
        rawText: 'Сквозь время 18 сентября', imageUrls: ['https://img/poster'], imagePaths: [relative],
        imageVisionFacts: [{ index: 1, imageType: 'poster', poster: true, posterConfidence: 99, textReadability: 96, title: 'Сквозь время', dates: '18.09.2099', text: 'Сквозь время 18.09.2099' }],
        contentHash: 'v18877-source', parseStatus: 'events-found', fetchedAt: now,
    });
    dbApi.replaceVkEventsForPost({
        screenName: 'idmamaanarchy', postId: 1183, sourceUrl: 'https://vk.ru/wall-226190294_1183',
        imagePaths: [relative], updatedAt: now,
        events: [{
            title: 'Сквозь время', eventDate: '2099-09-18', venue: 'Мама Анархия',
            imagePaths: [], posterMatchStatus: 'no_safe_poster', posterMatchReason: 'v18873-requires-vision-poster-binding',
            posterImageIndex: 0, parseMethod: 'fixture', status: 'approved',
        }],
    });

    const groups = dbApi.getStartupPosterRepairGroupsV18877({ fromDate: '2099-01-01' });
    const group = groups.find((item) => item.sourceType === 'vk' && item.postId === 1183);
    assert.ok(group);
    assert.deepEqual(group.imagePaths, [relative]);
    assert.equal(group.events.length, 1);
    assert.deepEqual(group.events[0].imagePaths, [relative]);
    assert.equal(group.imageVisionFacts[0].title, 'Сквозь время');

    assert.equal(dbApi.isStartupPosterRepairV18877Complete(), false);
    dbApi.markStartupPosterRepairV18877Complete();
    assert.equal(dbApi.isStartupPosterRepairV18877Complete(), true);
});

test('V188.83 startup media repair is after BOT READY, detached and one-time', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const readyAt = app.indexOf("'[BOT READY]'");
    const scheduledAt = app.indexOf("'[V18883 STARTUP MEDIA REPAIR SCHEDULED]'");
    assert.ok(readyAt >= 0 && scheduledAt > readyAt);
    assert.match(app, /if \(!isStartupMediaRepairV18883Complete\(\)\)/u);
    assert.match(app, /runDetachedSupervisedOperation\([\s\S]{0,300}event-media-repair:v18883-startup/u);
    assert.match(app, /assignEventImageIndexesFromParsedFacts\(events, facts/u);
    assert.match(app, /markStartupMediaRepairV18883Complete\(\)/u);
    assert.match(app, /data:\$\{mimeType\};base64/u);
});
