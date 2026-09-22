import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

import { parseScraperStartCommand } from '../../src/features/scrapers/scraperCommandRouting.js';

const command = parseScraperStartCommand('Гигорейв парсер все чисто');
assert.equal(command.matched, true);
assert.equal(command.all, true);
assert.equal(command.cleanOnly, true);

const normal = parseScraperStartCommand('парсер все');
assert.equal(normal.cleanOnly, false);

const database = await readFile(new URL('../../src/infrastructure/database/index.js', import.meta.url), 'utf8');
assert.match(database, /CREATE TABLE IF NOT EXISTS manual_parser_seen_items/u);
assert.match(database, /source_id TEXT NOT NULL/u);
assert.match(database, /observed_at INTEGER NOT NULL/u);
assert.match(database, /raw_text TEXT NOT NULL/u);
assert.match(database, /attachments_json TEXT NOT NULL/u);
assert.match(database, /content_hash TEXT NOT NULL/u);
assert.match(database, /INSERT OR IGNORE INTO manual_parser_seen_items[\s\S]+FROM telegram_source_posts/u);
assert.match(database, /INSERT OR IGNORE INTO manual_parser_seen_items[\s\S]+FROM vk_source_posts/u);
assert.match(database, /INSERT OR IGNORE INTO manual_parser_seen_items[\s\S]+FROM vk_chat_source_messages/u);
assert.match(database, /export function getManualParserSeenItem/u);
assert.match(database, /export function upsertManualParserSeenItem/u);

const files = [
    '../../src/platforms/vk/vkPublicScraper.js',
    '../../src/platforms/telegram/telegramHtmlScraper.js',
    '../../src/platforms/vk/vkChatEventScraper.js',
];
for (const file of files) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /incrementalOnly = false/u, file);
    assert.match(source, /getManualParserSeenItem\(\{ sourceId, itemId \}\)/u, file);
    assert.match(source, /isManualParserSeenItemFinalStatus\(ledgerBefore\.parseStatus\)/u, file);
    assert.match(source, /clean-mode-database-known/u, file);
    assert.match(source, /!incrementalKnown[\s\S]{0,120}!decision\.aiEligible/u, file);
    assert.match(source, /upsertManualParserSeenItem/u, file);
    assert.match(source, /\.filter\(\([^)]*\) => !incrementalOnly \|\| !candidateDecisions\.get/u, file);
}

const chat = await readFile(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
assert.match(chat, /disableHistoryBackfill = false/u);
assert.match(chat, /finiteHistoryBackfillEnabled = historyBackfillEnabled && !disableHistoryBackfill/u);
assert.match(chat, /attachments:\s*\{[\s\S]{0,160}links:[\s\S]{0,160}imageUrls:/u);

const app = await readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
assert.match(app, /incrementalOnly: Boolean\(incrementalOnly\)/u);
assert.match(app, /targetMessages: incrementalOnly\s*\? 20/u);
assert.match(app, /run\.manual-poster-repair\.skipped/u);
assert.match(app, /уже видено в raw-ledger и отброшено ДО алгоритма\/vision\/AI/u);
