import assert from 'node:assert/strict';
import test from 'node:test';

import {
    assertVkHistoryBatchVisibility,
    getVkHistoryResponseConversationMessageIds,
} from '../../src/features/history/vkHistoryRecoveryVisibility.js';

test('V188.22 extracts conversation_message_id variants from a VK history response', () => {
    const ids = getVkHistoryResponseConversationMessageIds({
        items: [
            { conversation_message_id: 11 },
            { conversationMessageId: 12 },
            { id: 13 },
        ],
    });
    assert.deepEqual([...ids], [11, 12, 13]);
});

test('V188.22 rejects a successful-looking empty VK batch when SQLite proves messages exist there', () => {
    assert.throws(
        () => assertVkHistoryBatchVisibility(
            { items: [] },
            [42, 57],
            { method: 'getByConversationMessageId', peerId: 2000000006 },
        ),
        (error) => {
            assert.equal(error.code, 'VK_HISTORY_RECOVERY_FALSE_EMPTY');
            assert.equal(error.peerId, 2000000006);
            assert.deepEqual(error.expectedKnownCmids, [42, 57]);
            return true;
        },
    );
});

test('V188.22 accepts a batch when at least one locally-known CMID is actually visible', () => {
    const response = { items: [{ conversation_message_id: 57 }] };
    assert.equal(
        assertVkHistoryBatchVisibility(
            response,
            [42, 57],
            { method: 'getByConversationMessageId', peerId: 2000000006 },
        ),
        response,
    );
});

test('V188.22 does not invent visibility requirements for ranges absent from local history', () => {
    const response = { items: [] };
    assert.equal(
        assertVkHistoryBatchVisibility(
            response,
            [],
            { method: 'getByConversationMessageId', peerId: 2000000006 },
        ),
        response,
    );
});
