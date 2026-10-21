import test from 'node:test';
import assert from 'node:assert/strict';
import {
    captureVkChatObservation,
    assertVkChatSessionActive,
    assertResolvedVkChatAiResult,
} from '../src/platforms/vk/vkChatIngestSafety.js';

const makeMessage = (overrides = {}) => ({
    conversationMessageId: 100,
    hasStableConversationMessageId: true,
    senderId: 10,
    createdAt: 1_800_000_000,
    contentText: 'Концерт 25 сентября',
    repostText: '', embeddedText: '', text: 'Концерт 25 сентября',
    links: [], repostUrls: [], attachmentLinks: [], imageUrls: [], imageMedia: [],
    ...overrides,
});

test('CMID не увеличивает число элементов при повторном наблюдении', () => {
    const byId = new Map();
    assert.equal(captureVkChatObservation(byId, makeMessage()), true);
    assert.equal(captureVkChatObservation(byId, makeMessage()), false);
    assert.equal(byId.size, 1);
});

test('поздняя афиша дополняет исходный объект без нового элемента', () => {
    const byId = new Map();
    const first = makeMessage();
    const captured = [];
    if (captureVkChatObservation(byId, first)) captured.push(first);
    assert.equal(captureVkChatObservation(byId, makeMessage({
        imageUrls: ['https://example.test/poster.jpg'],
        imageMedia: [{ url: 'https://example.test/poster.jpg', attachmentKey: 'photo-10_20', origin: 'outer-message', repostDepth: 0 }],
    })), false);
    assert.equal(captured.length, 1);
    assert.strictEqual(captured[0], first);
    assert.deepEqual(first.imageUrls, ['https://example.test/poster.jpg']);
    assert.equal(first.captureObservations.length, 2);
});

test('замена даты не склеивает старый и новый тексты', () => {
    const byId = new Map();
    captureVkChatObservation(byId, makeMessage());
    captureVkChatObservation(byId, makeMessage({ contentText: 'Концерт 26 сентября', text: 'Концерт 26 сентября' }));
    assert.equal(byId.get(100).text, 'Концерт 26 сентября');
    assert.equal(byId.get(100).captureObservations[0].contentText, 'Концерт 25 сентября');
});

test('текст сообщения и репоста остаётся раздельным', () => {
    const byId = new Map();
    captureVkChatObservation(byId, makeMessage({ contentText: 'Советую сходить', text: 'Советую сходить' }));
    captureVkChatObservation(byId, makeMessage({ contentText: '', repostText: 'Фестиваль 27 сентября', embeddedText: 'Фестиваль 27 сентября', text: 'Фестиваль 27 сентября' }));
    assert.equal(byId.get(100).contentText, 'Советую сходить');
    assert.equal(byId.get(100).repostText, 'Фестиваль 27 сентября');
    assert.match(byId.get(100).text, /\[Репост\/вложенный пост VK\]/u);
});

test('поздний URL того же ID афиши заменяет прежний URL', () => {
    const byId = new Map();
    for (const suffix of ['old', 'new']) {
        captureVkChatObservation(byId, makeMessage({
            imageUrls: [`https://example.test/${suffix}.jpg`],
            imageMedia: [{ url: `https://example.test/${suffix}.jpg`, attachmentKey: 'photo-10_20', origin: 'outer-message', repostDepth: 0 }],
        }));
    }
    assert.deepEqual(byId.get(100).imageUrls, ['https://example.test/new.jpg']);
});

test('URL без ID сохраняют регистр', () => {
    const byId = new Map();
    captureVkChatObservation(byId, makeMessage({ imageUrls: ['https://example.test/A.jpg'] }));
    captureVkChatObservation(byId, makeMessage({ imageUrls: ['https://example.test/a.jpg'] }));
    assert.equal(byId.get(100).imageUrls.length, 2);
});

test('остановленная сессия отклоняется как незавершённая', () => {
    assert.doesNotThrow(() => assertVkChatSessionActive(true));
    assert.throws(() => assertVkChatSessionActive(false), { code: 'MANUAL_SESSION_INACTIVE' });
});

test('успешный пустой результат AI допустим', () => {
    assert.doesNotThrow(() => assertResolvedVkChatAiResult([]));
    assert.doesNotThrow(() => assertResolvedVkChatAiResult({ events: [] }));
});

test('невалидный или технически ошибочный результат AI отклоняется', () => {
    for (const value of [null, undefined, {}, { unresolved: true }, { events: [], unresolved: true }, { events: [], error: 'timeout' }, { events: [], ok: false }, { events: [null] }, '[]']) {
        assert.throws(() => assertResolvedVkChatAiResult(value), { code: 'EVENT_AI_UNRESOLVED' });
    }
});
