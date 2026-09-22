import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import {
    vkChatSourceMediaFingerprint,
    captureVkChatObservation,
} from '../src/platforms/vk/vkChatIngestSafety.js';

const media = (url, attachmentKey = 'photo-10_20', origin = 'outer-message') => ({
    url, attachmentKey, origin, repostDepth: 0,
});

test('same proven attachment may receive a different signed URL without changing media fingerprint', () => {
    const before = { imageUrls: ['https://example.invalid/photo_old.jpg?sig=one'], imageMedia: [media('https://example.invalid/photo_old.jpg?sig=one')] };
    const after = { imageUrls: ['https://example.invalid/photo_new.jpg?sig=two'], imageMedia: [media('https://example.invalid/photo_new.jpg?sig=two')] };
    assert.deepEqual(vkChatSourceMediaFingerprint(before), vkChatSourceMediaFingerprint(after));
});

test('new attachment is visible even when text does not change', () => {
    const first = { imageUrls: ['https://example.invalid/1.jpg'], imageMedia: [media('https://example.invalid/1.jpg')] };
    const second = { imageUrls: ['https://example.invalid/1.jpg','https://example.invalid/2.jpg'], imageMedia: [media('https://example.invalid/1.jpg'), media('https://example.invalid/2.jpg','photo-10_21')] };
    assert.notDeepEqual(vkChatSourceMediaFingerprint(first), vkChatSourceMediaFingerprint(second));
});

test('same photo in separate layers is not one evidence record', () => {
    const example = { imageMedia: [media('https://example.invalid/1.jpg'), media('https://example.invalid/1.jpg','photo-10_20','repost-wall')] };
    assert.equal(vkChatSourceMediaFingerprint(example).length, 2);
});

test('unidentified URLs remain distinct and case-sensitive', () => {
    const example = { imageUrls: ['https://example.invalid/A.jpg', 'https://example.invalid/a.jpg'] };
    assert.equal(vkChatSourceMediaFingerprint(example).length, 2);
});

test('late poster is accumulated without combining old and new dates into AI text', () => {
    const messages = new Map();
    const first = { conversationMessageId: 100, contentText: '25 сентября', text: '25 сентября', imageUrls: [], imageMedia: [] };
    const second = { conversationMessageId: 100, contentText: '26 сентября', text: '26 сентября', imageUrls: ['https://example.invalid/1.jpg'], imageMedia: [media('https://example.invalid/1.jpg')] };
    assert.equal(captureVkChatObservation(messages, first), true);
    assert.equal(captureVkChatObservation(messages, second), false);
    assert.equal(messages.size, 1);
    assert.equal(first.contentText, '26 сентября');
    assert.ok(!first.text.includes('25 сентября'));
    assert.equal(first.imageUrls.length, 1);
});

test('DOM capture does not truncate discovered images before source persistence', () => {
    const source = readFileSync(new URL('../src/platforms/vk/vkChatEventScraper.js', import.meta.url), 'utf8');
    assert.doesNotMatch(source, /imageUrls:\s*(?:imageUrls|images)\.slice\(0,\s*(?:12|16)\)/u);
    assert.doesNotMatch(source, /imageMedia:\s*imageMedia\.slice\(0,\s*16\)/u);
    assert.match(source, /vkChatSourceMediaFingerprint\(message\)/u);
});
