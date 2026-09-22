import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const db = await import('../../src/infrastructure/database/index.js');
const sourceId = 'vk:v18866-test';
const itemId = `item-${Date.now()}-${Math.random()}`;

db.upsertManualParserSeenItem({
    sourceId,
    sourceKind: 'vk-public',
    itemId,
    rawText: 'новый пост',
    parseStatus: 'captured',
});
let row = db.getManualParserSeenItem({ sourceId, itemId });
assert.equal(row.parseStatus, 'captured');
assert.equal(db.isManualParserSeenItemFinalStatus(row.parseStatus), false);

db.markManualParserSeenItemProcessing({ sourceId, itemId, runId: 'run-1' });
row = db.getManualParserSeenItem({ sourceId, itemId });
assert.equal(row.parseStatus, 'processing');
assert.equal(row.attemptCount, 1);
assert.equal(db.isManualParserSeenItemFinalStatus(row.parseStatus), false);

db.markManualParserSeenItemFailed({ sourceId, itemId, runId: 'run-1', error: 'simulated interruption' });
row = db.getManualParserSeenItem({ sourceId, itemId });
assert.equal(row.parseStatus, 'failed_retryable');
assert.match(row.lastError, /simulated interruption/u);
assert.equal(db.isManualParserSeenItemFinalStatus(row.parseStatus), false);

db.markManualParserSeenItemProcessing({ sourceId, itemId, runId: 'run-2' });
db.finalizeManualParserSeenItem({ sourceId, itemId, runId: 'run-2', parseStatus: 'processed_rejected' });
row = db.getManualParserSeenItem({ sourceId, itemId });
assert.equal(row.parseStatus, 'processed_rejected');
assert.equal(row.attemptCount, 2);
assert.ok(row.processedAt > 0);
assert.equal(db.isManualParserSeenItemFinalStatus(row.parseStatus), true);

for (const file of [
    '../../src/platforms/vk/vkPublicScraper.js',
    '../../src/platforms/telegram/telegramHtmlScraper.js',
    '../../src/platforms/vk/vkChatEventScraper.js',
]) {
    const source = await readFile(new URL(file, import.meta.url), 'utf8');
    assert.match(source, /isManualParserSeenItemFinalStatus\(ledgerBefore\.parseStatus\)/u, file);
    assert.match(source, /markManualParserSeenItemProcessing/u, file);
    assert.match(source, /processed_rejected/u, file);
    assert.match(source, /processed_event/u, file);
    assert.match(source, /processed_not_event/u, file);
    assert.match(source, /markManualParserSeenItemFailed/u, file);
}
