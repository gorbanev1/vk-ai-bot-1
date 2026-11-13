import assert from 'node:assert/strict';
import test from 'node:test';
import { MessageEventContext } from 'vk-io';
import { installVkMessageEventPollingBridge } from '../../src/platforms/vk/vkMessageEventPollingBridge.js';

test('community Long Poll type 80 reaches the callback middleware as a message event', async () => {
    const dispatched = [];
    let originalCalls = 0;
    const updates = {
        api: {}, upload: {},
        handlePollingUpdate: async () => { originalCalls += 1; },
        dispatchMiddleware: async context => { dispatched.push(context); },
    };
    assert.equal(installVkMessageEventPollingBridge(updates, { role: 'primary', logger: { info() {} } }), true);
    await updates.handlePollingUpdate([80, {
        user_id: 123, peer_id: 2_000_000_027, conversation_message_id: 91,
        event_id: 'callback-id', payload: { action: 'event_remind', sourceType: 'vk_public', id: 42 },
    }]);
    assert.equal(originalCalls, 0);
    assert.equal(dispatched.length, 1);
    assert.ok(dispatched[0] instanceof MessageEventContext);
    assert.equal(dispatched[0].peerId, 2_000_000_027);
    assert.equal(dispatched[0].userId, 123);
    assert.equal(dispatched[0].eventPayload.action, 'event_remind');
});

test('bridge preserves other VK Long Poll updates and installs only once', async () => {
    const received = [];
    const updates = {
        handlePollingUpdate: async update => { received.push(update); },
        dispatchMiddleware: async () => {},
    };
    assert.equal(installVkMessageEventPollingBridge(updates, { logger: { info() {} } }), true);
    assert.equal(installVkMessageEventPollingBridge(updates, { logger: { info() {} } }), false);
    const update = [4, 1, 0, 0, 0, 'hello'];
    await updates.handlePollingUpdate(update);
    assert.deepEqual(received, [update]);
});

test('community Long Poll object update is translated from message_event', async () => {
    let dispatched = null;
    const updates = {
        api: {}, upload: {},
        handlePollingUpdate: async () => assert.fail('type 80 must not be dropped by vk-io'),
        dispatchMiddleware: async context => { dispatched = context; },
    };
    installVkMessageEventPollingBridge(updates, { role: 'primary', logger: { info() {} } });
    const object = {
        type: 'message_event',
        group_id: 233007447,
        object: {
            user_id: 123, peer_id: 2_000_000_027, conversation_message_id: 91,
            event_id: 'callback-id', payload: { action: 'event_remind_group', sourceType: 'vk_public', id: 42 },
        },
    };
    await updates.handlePollingUpdate(object);
    assert.ok(dispatched instanceof MessageEventContext);
    assert.equal(dispatched.eventId, 'callback-id');
    assert.equal(dispatched.eventPayload.action, 'event_remind_group');
});

test('community Long Poll positional type 80 update preserves all callback fields', async () => {
    let dispatched = null;
    const updates = {
        api: {}, upload: {},
        handlePollingUpdate: async () => assert.fail('type 80 must be adapted before vk-io sees it'),
        dispatchMiddleware: async context => { dispatched = context; },
    };
    installVkMessageEventPollingBridge(updates, { role: 'primary', logger: { info() {} } });
    await updates.handlePollingUpdate([
        80, 'callback-id', 123, 2_000_000_027,
        JSON.stringify({ action: 'event_remind', sourceType: 'vk_public', id: 42 }), 91,
    ]);
    assert.ok(dispatched instanceof MessageEventContext);
    assert.equal(dispatched.userId, 123);
    assert.equal(dispatched.peerId, 2_000_000_027);
    assert.equal(dispatched.eventId, 'callback-id');
    assert.equal(dispatched.conversationMessageId, 91);
    assert.equal(JSON.parse(dispatched.eventPayload).action, 'event_remind');
});

test('community Long Poll type 80 uses payload before conversation_message_id', async () => {
    let dispatched = null;
    const updates = {
        api: {}, upload: {},
        handlePollingUpdate: async () => assert.fail('type 80 must be adapted before vk-io sees it'),
        dispatchMiddleware: async context => { dispatched = context; },
    };
    installVkMessageEventPollingBridge(updates, { role: 'primary', logger: { info() {} } });
    const eventPayload = { action: 'event_remind_group', sourceType: 'vk_public', id: 42 };
    await updates.handlePollingUpdate([80, 'callback-id', 123, 2_000_000_027, eventPayload, 91]);
    assert.equal(dispatched.conversationMessageId, 91);
    assert.deepEqual(dispatched.eventPayload, eventPayload);
});

test('community Long Poll type 80 also accepts the legacy message_id before payload layout', async () => {
    let dispatched = null;
    const updates = {
        api: {}, upload: {},
        handlePollingUpdate: async () => assert.fail('type 80 must be adapted before vk-io sees it'),
        dispatchMiddleware: async context => { dispatched = context; },
    };
    installVkMessageEventPollingBridge(updates, { role: 'primary', logger: { info() {} } });
    const eventPayload = { action: 'event_remind', sourceType: 'vk_public', id: 42 };
    await updates.handlePollingUpdate([80, 'callback-id', 123, 2_000_000_027, 91, eventPayload]);
    assert.equal(dispatched.conversationMessageId, 91);
    assert.deepEqual(dispatched.eventPayload, eventPayload);
});
