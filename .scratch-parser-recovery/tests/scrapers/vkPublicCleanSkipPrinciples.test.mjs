import test from 'node:test';
import assert from 'node:assert/strict';
import { createVkPublicCaptureHash } from '../../src/features/events/vkPublicContentHash.js';
import { shouldSkipUnchangedCapturedItem } from '../../src/features/scrapers/manualParserCleanSkip.js';
import { mergeVkChatSnapshotMedia, captureVkChatObservation } from '../../src/platforms/vk/vkChatIngestSafety.js';

const source = (changes = {}) => ({
    postId: 100, text: 'Концерт 25 сентября', contentText: 'Концерт 25 сентября',
    repostText: '', publishedAt: 1780000000, links: [], imageUrls: [
        'https://vk.example/cdn/photo.jpg?token=first',
    ], imageMedia: [{
        url: 'https://vk.example/cdn/photo.jpg?token=first',
        attachmentKey: 'photo-10_20', origin: 'outer-message', repostDepth: 0,
    }], ...changes,
});
const completed = (status) => ['processed_event', 'processed_not_event', 'processed_existing'].includes(status);
const skip = (previous, post, incrementalOnly = true) => shouldSkipUnchangedCapturedItem({
    incrementalOnly, previous, contentHash: createVkPublicCaptureHash(post, ''), isFinalStatus: completed,
});

test('same occurrence, final status, identical fingerprint skips', () => {
    const post = source();
    assert.equal(skip({ parseStatus: 'processed_event', contentHash: createVkPublicCaptureHash(post, '') }, post), true);
});
test('date edit is not skipped despite unchanged post ID', () => {
    const original = source(), changed = source({ text: 'Концерт 26 сентября' });
    assert.equal(skip({ parseStatus: 'processed_event', contentHash: createVkPublicCaptureHash(original, '') }, changed), false);
});
test('new poster ID is not skipped despite unchanged text and URL', () => {
    const original = source(), changed = source({ imageMedia: [{ ...source().imageMedia[0], attachmentKey: 'photo-10_21' }] });
    assert.equal(skip({ parseStatus: 'processed_event', contentHash: createVkPublicCaptureHash(original, '') }, changed), false);
});
test('same verified photo with a different signed URL does not force reparse', () => {
    const original = source(), changed = source({
        imageUrls: ['https://vk.example/cdn/different-size.jpg?token=second'],
        imageMedia: [{ ...source().imageMedia[0], url: 'https://vk.example/cdn/different-size.jpg?token=second' }],
    });
    assert.equal(createVkPublicCaptureHash(original, ''), createVkPublicCaptureHash(changed, ''));
});
test('unknown image URL with a different query is conservatively reprocessed', () => {
    const original = source({ imageMedia: [], imageUrls: ['https://vk.example/img.jpg?v=1'] });
    const changed = source({ imageMedia: [], imageUrls: ['https://vk.example/img.jpg?v=2'] });
    assert.notEqual(createVkPublicCaptureHash(original, ''), createVkPublicCaptureHash(changed, ''));
});
test('ledger without hash, unfinished status or non-incremental run never skip', () => {
    const post = source(), hash = createVkPublicCaptureHash(post, '');
    for (const previous of [null, { parseStatus: 'processed_event' }, { parseStatus: 'failed_retryable', contentHash: hash }]) {
        assert.equal(skip(previous, post), false);
    }
    assert.equal(skip({ parseStatus: 'processed_event', contentHash: hash }, post, false), false);
});
test('two different occurrences with identical content do not automatically share a ledger result', () => {
    // A caller must look up (sourceId, itemId), never near-duplicate content.
    const oneOccurrence = { sourceId: 'vk:a', itemId: '100', contentHash: createVkPublicCaptureHash(source(), '') };
    const otherOccurrence = { sourceId: 'vk:a', itemId: '101', contentHash: createVkPublicCaptureHash(source(), '') };
    assert.notEqual(`${oneOccurrence.sourceId}/${oneOccurrence.itemId}`, `${otherOccurrence.sourceId}/${otherOccurrence.itemId}`);
});
test('adaptive image with verified attachment is accepted even if exact saw none', () => {
    const merged = mergeVkChatSnapshotMedia({ imageMedia: [] }, { imageMedia: [
        { url: 'https://vk.example/poster.jpg', attachmentKey: 'photo-10_20' },
        { url: 'https://vk.example/avatar.jpg' },
    ] });
    assert.equal(merged.length, 1);
    assert.equal(merged[0].attachmentKey, 'photo-10_20');
});
test('repeated observations keep bounded history and preserve late media', () => {
    const first = { conversationMessageId: 100, contentText: 'Концерт 25 сентября', text: 'Концерт 25 сентября', imageMedia: [], imageUrls: [] };
    const seen = new Map();
    assert.equal(captureVkChatObservation(seen, first), true);
    for (let i = 0; i < 50; i++) {
        captureVkChatObservation(seen, { ...first, contentText: `Концерт ${i} сентября`, text: `Концерт ${i} сентября`,
            imageMedia: [{ url: `https://vk.example/${i}.jpg`, attachmentKey: `photo-10_${i}` }], imageUrls: [`https://vk.example/${i}.jpg`] });
    }
    assert.ok(first.captureObservations.length <= 30);
    assert.equal(seen.size, 1);
    assert.equal(first.imageMedia.length, 50);
    assert.equal(first.contentText, 'Концерт 49 сентября');
});
