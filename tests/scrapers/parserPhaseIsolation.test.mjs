import assert from 'node:assert/strict';
import test from 'node:test';
import { createVkPublicScraper } from '../../src/platforms/vk/vkPublicScraper.js';
import { getManualParserSeenItem, isManualParserSeenItemFinalStatus, createEventProposal, getEventProposal } from '../../src/infrastructure/database/index.js';

test('phase one preserves date-free raw items for phase two without finalizing them', async () => {
    const name = 'phase_isolation';
    const scraper = createVkPublicScraper({ screenName: name, dataDirectory: process.env.GIGORAVE_DATA_DIR, downloadImages: false, extractEventsWithAi: () => { throw new Error('unexpected AI'); } });
    const item = { postId: 1, text: 'Новая афиша', imageUrls: ['https://example.com/poster.jpg'], sourceUrl: 'https://vk.ru/wall-9000_1', publishedAt: Math.floor(Date.now() / 1000) };
    let capture;
    let admission;
    await scraper.run({ cachedItems: [item], phaseCount: 1, onCaptureComplete: value => { capture = value; }, onAdmissionComplete: value => { admission = value; } });
    assert.equal(capture.posterGateRequests.length, 0);
    assert.equal(admission.prefilterPreviews[0].visionPhase, 'phase2-date-free-image');
    assert.equal(isManualParserSeenItemFinalStatus(getManualParserSeenItem({ sourceId: `vk:${name}`, itemId: '1' }).parseStatus), false);
    await scraper.run({ cachedItems: [item], phaseCount: 2, getPosterGateResult: () => ({ attempted: true, facts: '[IMAGE 1]\nЭто афиша события: нет', error: '' }), onCaptureComplete: value => { capture = value; } });
    assert.equal(capture.posterGateRequests.length, 1);
    assert.equal(isManualParserSeenItemFinalStatus(getManualParserSeenItem({ sourceId: `vk:${name}`, itemId: '1' }).parseStatus), true);
});

test('proposal sender profile survives a database round trip', () => {
    const id = createEventProposal({ submitterPlatform: 'telegram', submitterExternalId: '123', submitterExternalUsername: 'guest', submitterDisplayName: 'Имя Фамилия', rawSubmission: 'Анонс' });
    const row = getEventProposal(id);
    assert.equal(row.submitterExternalUsername, 'guest');
    assert.equal(row.submitterDisplayName, 'Имя Фамилия');
});
