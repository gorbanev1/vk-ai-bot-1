import assert from 'node:assert/strict';

import {
    vkContextReferencesGroupBot,
} from '../../src/shared/botAddressing.js';

const groupId = 12345;

assert.equal(vkContextReferencesGroupBot({
    message: {
        reply_message: {
            from_id: -groupId,
            text: 'Ответ бота',
        },
    },
}, groupId), true);

assert.equal(vkContextReferencesGroupBot({
    replyMessage: {
        senderId: -groupId,
    },
}, groupId), true);

assert.equal(vkContextReferencesGroupBot({
    message: {
        fwd_messages: [{
            from_id: 777,
            reply_message: {
                from_id: -groupId,
            },
        }],
    },
}, groupId), true);

assert.equal(vkContextReferencesGroupBot({
    message: {
        fwd_messages: [{
            from_id: 777,
        }],
    },
}, groupId), false);

assert.equal(vkContextReferencesGroupBot({
    message: {
        from_id: -groupId,
    },
}, groupId), false);

assert.equal(vkContextReferencesGroupBot({}, ''), false);

console.log('botAddressing tests: OK');
