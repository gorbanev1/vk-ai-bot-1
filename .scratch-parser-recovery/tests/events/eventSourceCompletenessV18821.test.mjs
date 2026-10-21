import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

import {
    parsePublicPostLocally,
} from '../../src/features/events/publicPostLocalParser.js';
import {
    visionSkipReason,
} from '../../src/features/events/eventVisionPolicy.js';

const unix = (iso) => Math.floor(new Date(iso).getTime() / 1000);

test('V18821 poster vision is not skipped merely because text already looks complete', () => {
    assert.equal(visionSkipReason({
        textComplete: true,
        storedImageReusable: false,
        eligibleImageCount: 1,
        hasVision: true,
    }), '');
});

test('V18821 source account name never fabricates venue', () => {
    const [event] = parsePublicPostLocally({
        text: '12 сентября — PEREGRUZ\nКонцерт. Начало 22:00',
        publishedAt: unix('2026-09-01T12:00:00Z'),
        screenName: 'overlockbar',
    });

    assert.ok(event);
    assert.equal(event.title, 'PEREGRUZ');
    assert.equal(event.venue, '');
});

test('V18821 ingest paths enforce source posters while explicit compact output stays text-only', async () => {
    const [assets, telegram, vkPublic, vkChat, app] = await Promise.all([
        readFile(new URL('../../src/features/events/eventAssets.js', import.meta.url), 'utf8'),
        readFile(new URL('../../src/platforms/telegram/telegramHtmlScraper.js', import.meta.url), 'utf8'),
        readFile(new URL('../../src/platforms/vk/vkPublicScraper.js', import.meta.url), 'utf8'),
        readFile(new URL('../../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8'),
        readFile(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8'),
    ]);

    assert.match(assets, /export function filterEventsWithAnnouncementImages/u);
    assert.match(assets, /missing-source-announcement-image/u);
    for (const source of [telegram, vkPublic, vkChat]) {
        assert.match(source, /filterEventsWithAnnouncementImages\(events/u);
    }
    assert.doesNotMatch(telegram, /imageUrls:\s*downloadImages\s*\?/u);
    assert.doesNotMatch(vkPublic, /imageUrls:\s*downloadImages\s*\?/u);
    assert.match(telegram, /imageUrls:\s*visionImageUrls/u);
    assert.match(vkPublic, /imageUrls:\s*visionImageUrls/u);
    assert.match(app, /MANUAL EVENT REJECTED WITHOUT POSTER/u);
    assert.match(app, /EVENT REPARSE POSTER RECOVERY ERROR/u);
    assert.match(app, /EVENT REPARSE REJECTED/u);
    assert.match(app, /'images=false'/u);
    assert.match(app, /'layout=single-list'/u);
    const compactStart = app.indexOf('function buildCompactPublicEventsMessage(items, range) {');
    const compactEnd = app.indexOf('function buildSinglePublicEventMessage(event) {', compactStart);
    const compactSection = app.slice(compactStart, compactEnd);
    assert.doesNotMatch(compactSection, /getEventAttachments\(/u);
    assert.doesNotMatch(compactSection, /buildCompactMergedSourceLines\(/u);
});
