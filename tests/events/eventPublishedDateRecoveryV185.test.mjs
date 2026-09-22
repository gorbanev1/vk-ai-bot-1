import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

import {
    parsePublicPostLocally,
    publicPostLooksLikeEventCandidate,
} from '../../src/features/events/publicPostLocalParser.js';

const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

const spookers = {
    screenName: 'rb_diesel',
    postId: 13699,
    text: 'SPOOKERS | 18.09 | Воронеж • DIESEL BAR\nУспей купить билеты на дебютный тур SPOOKERS до подорожания 06.09!\nУвидимся уже в сентябре',
};

const oktoberfest = {
    screenName: 'idmamaanarchy',
    postId: 1164,
    text: 'Паб Мама Анархия\n25.09 Октоберфест в пабе Мама анархия с группой "Играючи". Билеты. На входе 500₽',
};

test('yearless dates remain AI candidates even when local year inference lacks published_at', () => {
    for (const post of [spookers, oktoberfest]) {
        assert.equal(publicPostLooksLikeEventCandidate({ ...post, publishedAt: 0 }), true);
        assert.deepEqual(parsePublicPostLocally({ ...post, publishedAt: 0 }), []);
    }
});

test('V185 reliable VK wall.date restores yearless September events', () => {
    const publishedAt = unix('2026-09-07T12:00:00Z');
    const [spookersEvent] = parsePublicPostLocally({ ...spookers, publishedAt });
    const [oktoberfestEvent] = parsePublicPostLocally({ ...oktoberfest, publishedAt });

    assert.equal(publicPostLooksLikeEventCandidate({ ...spookers, publishedAt }), true);
    assert.equal(spookersEvent?.eventDate, '2026-09-18');
    assert.match(spookersEvent?.venue ?? '', /DIESEL/u);
    assert.equal(oktoberfestEvent?.eventDate, '2026-09-25');
    assert.match(oktoberfestEvent?.venue ?? '', /Мама Анархия/u);
});

test('V185 VK API hydration persists wall.date and never substitutes process time as source evidence', () => {
    const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    const scraper = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
    const database = readFileSync(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');

    assert.match(app, /const apiPublishedAt = Number\(wall\?\.date \?\? 0\)/u);
    assert.match(app, /publishedAt: apiPublishedAt > 0/u);
    assert.match(app, /vk-api-wall-date-v185/u);

    const start = scraper.indexOf('const originalPublishedAt');
    const end = scraper.indexOf('const contentHash', start);
    assert.ok(start >= 0 && end > start);
    const fallbackBlock = scraper.slice(start, end);
    assert.match(fallbackBlock, /stored-v185-fallback/u);
    assert.match(fallbackBlock, /missing-source-date-v185/u);
    assert.doesNotMatch(fallbackBlock, /Date\.now\(\)/u);

    const selectStart = database.indexOf('const selectVkPostMetaStatement');
    const selectEnd = database.indexOf('const upsertVkSourcePostStatement', selectStart);
    const selectBlock = database.slice(selectStart, selectEnd);
    assert.match(selectBlock, /published_at/u);
    assert.match(database, /publishedAt: Number\(row\.published_at \?\? 0\)/u);
});
