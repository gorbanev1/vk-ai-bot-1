import assert from 'node:assert/strict';
import test from 'node:test';

import { buildChtivoReplyForward, findLatestChtivoPartConversationMessageId, resolveChtivoConversationMessageId } from '../../src/features/chtivo/chtivoReplyTarget.js';

test('chitivo forwarding quotes the exact previous message', () => {
    assert.deepEqual(JSON.parse(buildChtivoReplyForward(2_000_000_027, 171_815)), {
        conversation_message_ids: 171_815,
        peer_id: 2_000_000_027,
        is_reply: true,
    });
    assert.equal(buildChtivoReplyForward(0, 171_815), '');
    assert.equal(buildChtivoReplyForward(2_000_000_027, 0), '');
});

test('chitivo continuation targets the latest outgoing part of the same chapter', () => {
    const history = [
        { out: 1, id: 9005, conversation_message_id: 905, text: '«Низший пилотаж»\nМарафон\nЧасть 4\n\nНовая часть' },
        { out: 1, id: 9004, conversation_message_id: 904, text: 'Марафон\nГигорейв чтиво — продолжение за сегодня\nЧасть 3\n\nПредыдущая часть' },
        { out: 1, id: 9003, conversation_message_id: 903, text: 'Другая глава\nЧасть 2\n\nСтарый фрагмент' },
        { out: 0, id: 9006, conversation_message_id: 906, text: 'Марафон\nЧасть 5\n\nПользовательский текст' },
    ];

    assert.equal(findLatestChtivoPartConversationMessageId(history, 'Марафон'), 905);
});

test('chitivo continuation does not use a different chapter or a regular message id', () => {
    const history = [
        { out: 1, message_id: 5001, text: 'Другая глава\nЧасть 2\n\nФрагмент' },
        { out: 1, message_id: 5000, text: 'Марафон\nЧасть 1\n\nФрагмент без VK ID' },
    ];

    assert.equal(findLatestChtivoPartConversationMessageId(history, 'Марафон'), 0);
});

test('chitivo restores a missing previous-part id from the outgoing message archive', () => {
    const archive = [
        { is_outbox: 1, conversation_message_id: 172625, text: 'Марафон\nЧасть 22\n\nПоследний фрагмент' },
        { is_outbox: 1, conversation_message_id: 172623, text: 'Другая глава\nЧасть 21\n\nСтарый фрагмент' },
    ];

    assert.equal(findLatestChtivoPartConversationMessageId(archive, 'Марафон'), 172625);
});

test('chitivo resolves a VK message id to its conversation message id', async () => {
    const api = {
        messages: {
            async getById({ message_ids: messageId }) {
                assert.equal(messageId, 9012);
                return { items: [{ id: 9012, conversation_message_id: 171_815 }] };
            },
        },
    };
    assert.equal(await resolveChtivoConversationMessageId(api, { message_id: 9012 }), 171_815);
});
