import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import {
    appendEventIngestAudit,
    EVENT_INGEST_AUDIT_FILE,
} from '../../src/features/events/eventIngestAudit.js';

const vkPublic = readFileSync(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8');
const telegram = readFileSync(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8');
const vkChat = readFileSync(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
const app = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');

test('V185 writes one structured JSONL audit row with reject details', () => {
    const directory = mkdtempSync(join(tmpdir(), 'gigorave-v185-audit-'));
    try {
        const row = appendEventIngestAudit({
            dataDirectory: directory,
            sourceType: 'vk-public',
            sourceKey: 'rb_diesel',
            itemId: 13699,
            status: 'rejected-or-not-event',
            reason: 'candidate-produced-no-events',
            details: { publishedAt: 0, rejectedEvents: [{ reason: 'missing-source-date' }] },
            rawText: 'SPOOKERS | 18.09 | Воронеж • DIESEL BAR',
            at: 123,
        });
        assert.equal(row.status, 'rejected-or-not-event');
        const lines = readFileSync(join(directory, EVENT_INGEST_AUDIT_FILE), 'utf8').trim().split('\n');
        assert.equal(lines.length, 1);
        const saved = JSON.parse(lines[0]);
        assert.equal(saved.sourceKey, 'rb_diesel');
        assert.equal(saved.details.rejectedEvents[0].reason, 'missing-source-date');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('V185 preserves rejected source evidence instead of deleting it', () => {
    assert.doesNotMatch(vkPublic, /removeVkSourcePost/u);
    assert.doesNotMatch(telegram, /removeTelegramSourcePost/u);
    assert.doesNotMatch(vkChat, /removeVkChatSourceMessage/u);
    assert.match(vkPublic, /appendEventIngestAudit/u);
    assert.match(telegram, /appendEventIngestAudit/u);
    assert.match(vkChat, /appendEventIngestAudit/u);
});

test('V185 audit chain reaches the public event route', () => {
    const start = app.indexOf('async function sendPublicEventsForRange');
    const end = app.indexOf('function canonicalEventSourceUrl', start);
    const block = app.slice(start, end);
    assert.match(block, /sourceType: 'public-route'/u);
    assert.match(block, /snapshotMode/u);
    assert.match(block, /eventCount: events\.length/u);
    assert.match(block, /no-events-after-snapshot-or-sqlite-selection/u);
});
