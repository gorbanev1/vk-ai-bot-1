import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildPartyRequestSignature,
    partyDeliveryEventKey,
    preparePartyDelivery,
    markPartyDelivery,
    parsePartyCooldownCommand,
} from '../../src/features/events/partyDeliveryCooldown.js';

const event = (id, date = '2026-11-02') => ({ sourceType: 'vk', id, eventDate: date, title: `Event ${id}` });

test('new request keeps cards that were not delivered recently', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const signature = buildPartyRequestSignature({ fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'primary' });
    const first = preparePartyDelivery({
        state: { requests: [{ id: 'old', signature: 'other', platform: 'vk', peerId: '1', messageId: 10, createdAt: now - 2 * 60 * 60 * 1000, fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'primary', deliveredKeys: [partyDeliveryEventKey(event(1))] }] },
        nowMs: now, signature, request: { platform: 'vk', peerId: '1', messageId: 20, fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'primary' }, events: [event(1), event(2)],
    });
    assert.deepEqual(first.eligibleEvents.map(partyDeliveryEventKey), ['vk:2']);
});

test('exact range is blocked for configured window', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const signature = buildPartyRequestSignature({ fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'primary' });
    const result = preparePartyDelivery({
        state: { requests: [{ id: 'same', signature, platform: 'vk', peerId: '1', messageId: 10, createdAt: now - 60 * 60 * 1000, fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'primary', deliveredKeys: [partyDeliveryEventKey(event(1))] }] },
        nowMs: now, signature, request: { platform: 'vk', peerId: '1', messageId: 20, fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'primary' }, events: [event(1), event(2)],
    });
    assert.equal(result.sameRange, true);
    assert.equal(result.eligibleEvents.length, 0);
    assert.equal(result.previousSameRange[0].messageId, 10);
});

test('cards from overlapping previous request reply to its message', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const signature = buildPartyRequestSignature({ fromDate: '2026-11-03', toDate: '2026-11-05', partyPool: 'primary' });
    const previousSignature = buildPartyRequestSignature({ fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'primary' });
    const result = preparePartyDelivery({
        state: { requests: [{ id: 'prior', signature: previousSignature, platform: 'vk', peerId: '1', messageId: 10, createdAt: now - 60 * 60 * 1000, fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'primary', deliveredKeys: [partyDeliveryEventKey(event(1))] }] },
        nowMs: now, signature, request: { platform: 'vk', peerId: '1', messageId: 20, fromDate: '2026-11-03', toDate: '2026-11-05', partyPool: 'primary' }, events: [event(1, '2026-11-03'), event(2, '2026-11-04')],
    });
    assert.deepEqual(result.eligibleEvents.map(partyDeliveryEventKey), ['vk:2']);
    assert.equal(result.replyGroups[0].messageId, 10);
});

test('an event replies once to one matching previously delivered request', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const signature = buildPartyRequestSignature({ fromDate: '2026-11-04', toDate: '2026-11-06', partyPool: 'primary' });
    const prior = (id, messageId, fromDate, toDate) => ({
        id, messageId, createdAt: now - 60 * 60 * 1000, platform: 'telegram', peerId: 'chat',
        fromDate, toDate, partyPool: 'primary', filters: {},
        signature: buildPartyRequestSignature({ fromDate, toDate, partyPool: 'primary' }),
        deliveredKeys: ['vk:8'],
    });
    const result = preparePartyDelivery({
        state: { requests: [prior('one', 101, '2026-11-03', '2026-11-05'), prior('two', 202, '2026-11-04', '2026-11-07')] },
        nowMs: now, signature, request: { platform: 'telegram', peerId: 'chat', messageId: 303, fromDate: '2026-11-04', toDate: '2026-11-06', partyPool: 'primary' },
        events: [event(9, '2026-11-04')],
    });
    assert.deepEqual(result.targetByEventKey.get(partyDeliveryEventKey(event(9, '2026-11-04'))), [101]);
});

test('a classified event never crosses a dedicated pool boundary', () => {
    const now = Date.parse('2026-11-02T12:00:00Z');
    const signature = buildPartyRequestSignature({ fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'secondary' });
    const result = preparePartyDelivery({
        state: { requests: [{ id: 'primary', signature: 'other', platform: 'vk', peerId: '1', messageId: 10, createdAt: now - 60 * 60 * 1000, fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'primary', deliveredKeys: [] }] },
        nowMs: now, signature, request: { platform: 'vk', peerId: '1', messageId: 20, fromDate: '2026-11-02', toDate: '2026-11-04', partyPool: 'secondary' },
        events: [{ ...event(1), partyPool: 'secondary' }],
    });
    assert.deepEqual(result.targetByEventKey.get(partyDeliveryEventKey({ ...event(1), partyPool: 'secondary' })), [0]);
});

test('cooldown command parses status and both intervals', () => {
    assert.deepEqual(parsePartyCooldownCommand('тусы повторы статус'), { action: 'status' });
    assert.equal(parsePartyCooldownCommand('тусы повторы карточки 4 часа').hours, 4);
    assert.equal(parsePartyCooldownCommand('тусы повторы диапазон 8 часов').hours, 8);
});

test('marking delivery records only actual cards', () => {
    const state = { requests: [{ id: 'r', createdAt: Date.now(), deliveredKeys: [] }] };
    const updated = markPartyDelivery(state, 'r', [event(1)]);
    assert.deepEqual(updated.requests[0].deliveredKeys, ['vk:1']);
});
