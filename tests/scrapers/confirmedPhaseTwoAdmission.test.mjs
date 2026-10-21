import test from 'node:test';
import assert from 'node:assert/strict';
import { createVkPublicScraper } from '../../src/platforms/vk/vkPublicScraper.js';
import { createTelegramHtmlScraper } from '../../src/platforms/telegram/telegramHtmlScraper.js';

const facts = '[IMAGE 1]\nТип изображения: poster\nЭто афиша события: да\nНазвание: RammPage\nДата: 24 октября 2026\nМесто: Rock Bar';

// Stop at the real admission boundary: these tests exercise capture/ledger and
// queue decisions without downloading media or issuing any model requests.
async function admissionFor(scraper, item, options = {}) {
    let admission;
    const stop = new Error('admission captured');
    await assert.rejects(scraper.run({
        cachedItems: [item], phaseCount: 2, ...options,
        getPosterGateResult: () => ({ attempted: true, dateFreePhase: true, facts, error: '' }),
        onAdmissionComplete(value) { admission = value; throw stop; },
    }), error => error === stop);
    return admission.prefilterPreviews[0];
}

for (const platform of ['vk', 'telegram']) {
    for (const text of ['', 'На кухне новое меню, забронируйте столик.']) {
        test(`${platform}: cached confirmed phase-two poster admits extraction with ${text ? 'unrelated' : 'empty'} text`, async () => {
            const name = `confirmed_phase2_${platform}_${text ? 'body' : 'empty'}`;
            const scraper = platform === 'vk'
                ? createVkPublicScraper({ screenName: name, partyPool: 'secondary', dataDirectory: process.env.GIGORAVE_DATA_DIR, downloadImages: false })
                : createTelegramHtmlScraper({ channel: name, partyPool: 'secondary', dataDirectory: process.env.GIGORAVE_DATA_DIR, downloadImages: false });
            const result = await admissionFor(scraper, {
                screenName: name, channel: name, postId: 1, messageId: 1, text,
                sourceUrl: platform === 'vk' ? 'https://vk.ru/wall-98765_1' : `https://t.me/${name}/1`,
                publishedAt: Math.floor(Date.now() / 1000), imageUrls: ['https://example.com/poster.jpg'],
                __dateFreeVisionPhase: true, __posterGateVisionAttempted: true, __posterGateFacts: facts,
            });
            assert.equal(result.aiEligible, true);
            assert.equal(result.aiCandidate, true);
            assert.equal(result.aiAdmission.rejectionReason, '');
        });
    }
}

test('a confirmed phase-two VK repost poster does not require missing root body text for admission', async () => {
    const scraper = createVkPublicScraper({ screenName: 'confirmed_phase2_repost', partyPool: 'secondary', dataDirectory: process.env.GIGORAVE_DATA_DIR, downloadImages: false });
    const result = await admissionFor(scraper, {
        postId: 2, text: '', repostText: '', imageOrigin: 'nested-repost', rootPostTextResolved: false,
        sourceUrl: 'https://vk.ru/wall-98765_2', publishedAt: Math.floor(Date.now() / 1000),
        imageUrls: ['https://example.com/poster.jpg'], __dateFreeVisionPhase: true,
        __posterGateVisionAttempted: true, __posterGateFacts: facts,
    });
    assert.equal(result.aiEligible, true);
    assert.equal(result.aiCandidate, true);
});
