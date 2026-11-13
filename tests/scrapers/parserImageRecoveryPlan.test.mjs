import test from 'node:test';
import assert from 'node:assert/strict';
import { buildAdmittedParserImageRecoveryIds, isAdmittedParserImageRecoveryItem } from '../../src/features/scrapers/parserImageRecoveryPlan.js';

test('browser image recovery excludes rejected image previews while retaining admitted and poster-gate items', () => {
    const admitted = buildAdmittedParserImageRecoveryIds([{
        sourceId: 'vk:12bpg',
        prefilterPreviews: [
            { itemId: '12730', candidate: false, aiEligible: false, aiCandidate: false, imageUrls: ['rejected.jpg'] },
            { itemId: '12731', candidate: true, aiEligible: true, aiCandidate: false, imageUrls: ['deduped.jpg'] },
            { itemId: '12745', candidate: true, aiEligible: true, aiCandidate: true, imageUrls: ['admitted.jpg'] },
            { itemId: '12746', candidate: true, aiEligible: false, refreshKnownMediaCandidate: true, imageUrls: ['refresh.jpg'] },
        ],
        posterGateRequests: [
            { itemId: '12732', visionPhase: 'phase2-date-free-image', imageUrls: ['date-free.jpg'] },
        ],
    }]).get('vk:12bpg');

    assert.equal(isAdmittedParserImageRecoveryItem({ postId: 12730 }, admitted), false);
    assert.equal(isAdmittedParserImageRecoveryItem({ postId: 12731 }, admitted), false);
    assert.equal(isAdmittedParserImageRecoveryItem({ postId: 12745 }, admitted), true);
    assert.equal(isAdmittedParserImageRecoveryItem({ postId: 12746 }, admitted), true);
    assert.equal(isAdmittedParserImageRecoveryItem({ postId: 12732 }, admitted), true);
});

test('admission IDs remain source-scoped and support Telegram/VK item identity fields', () => {
    const admitted = buildAdmittedParserImageRecoveryIds([
        { sourceId: 'vk:12bpg', prefilterPreviews: [{ itemId: '42', aiEligible: true, aiCandidate: true }] },
        { sourceId: 'tg:kurazhcity', posterGateRequests: [{ messageId: 42 }] },
    ]);

    assert.equal(isAdmittedParserImageRecoveryItem({ postId: 42 }, admitted.get('vk:12bpg')), true);
    assert.equal(isAdmittedParserImageRecoveryItem({ messageId: 42 }, admitted.get('tg:kurazhcity')), true);
    assert.equal(isAdmittedParserImageRecoveryItem({ postId: 42 }, admitted.get('tg:kurazhcity')), true);
    assert.equal(isAdmittedParserImageRecoveryItem({ postId: 42 }, admitted.get('vk:other')), false);
});
