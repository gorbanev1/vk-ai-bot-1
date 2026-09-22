import assert from 'node:assert/strict';

import {
    extractIncomingReplyTarget,
    formatTelegramReplyAuthor,
    summarizeReplyTargetAttachments,
} from '../../src/features/ai/replyTargetRouting.js';

const vkTarget = extractIncomingReplyTarget({
    platform: 'vk',
    replyMessage: {
        conversationMessageId: 455,
        senderId: 77,
        text: 'Исходная реплика VK',
    },
    message: {
        reply_message: {
            conversation_message_id: 455,
            from_id: 77,
            text: 'Исходная реплика VK',
            attachments: [{
                type: 'link',
                link: {
                    title: 'Статья',
                    url: 'https://example.com/article',
                },
            }],
        },
    },
});

assert.equal(vkTarget.messageIndex, 455);
assert.equal(vkTarget.participantIndex, 77);
assert.equal(vkTarget.participantNameHint, '');
assert.match(vkTarget.messageText, /Исходная реплика VK/u);
assert.match(vkTarget.messageText, /Название: Статья/u);
assert.equal(
    vkTarget.attachments,
    'type=link title=Статья url=https://example.com/article',
);


const vkWallReplyTarget = extractIncomingReplyTarget({
    platform: 'vk',
    replyMessage: {
        conversationMessageId: 700,
        senderId: 88,
        text: '',
    },
    message: {
        reply_message: {
            conversation_message_id: 700,
            from_id: 88,
            text: '',
            attachments: [{
                type: 'wall_reply',
                wall_reply: {
                    id: 55,
                    owner_id: -10,
                    post_id: 20,
                    from_id: 99,
                    text: 'Текст комментария к посту внутри сообщения',
                },
            }],
        },
    },
});

assert.equal(vkWallReplyTarget.messageIndex, 700);
assert.equal(vkWallReplyTarget.participantIndex, 88);
assert.match(
    vkWallReplyTarget.messageText,
    /Текст комментария к посту внутри сообщения/u,
);
assert.match(vkWallReplyTarget.attachments, /type=wall_reply/u);

const telegramTarget = extractIncomingReplyTarget({
    platform: 'telegram',
    replyMessage: {
        conversationMessageId: 901,
        senderId: 123456,
        text: 'Подпись к документу',
    },
    message: {
        reply_message: {
            message_id: 901,
            from: {
                id: 42,
                first_name: 'Анна',
                last_name: 'Петрова',
                username: 'anna_test',
            },
            caption: 'Подпись к документу',
            document: {
                file_name: 'report.pdf',
                mime_type: 'application/pdf',
            },
        },
    },
});

assert.equal(telegramTarget.messageIndex, 901);
assert.equal(telegramTarget.participantIndex, 123456);
assert.equal(telegramTarget.participantNameHint, 'Анна Петрова (@anna_test)');
assert.equal(telegramTarget.messageText, 'Подпись к документу');
assert.match(telegramTarget.attachments, /type=document/u);
assert.match(telegramTarget.attachments, /file=report\.pdf/u);
assert.match(telegramTarget.attachments, /mime=application\/pdf/u);

assert.equal(formatTelegramReplyAuthor({
    from: {
        username: 'only_username',
    },
}), '@only_username');

assert.match(summarizeReplyTargetAttachments({
    photo: [{ file_id: 'small' }, { file_id: 'large' }],
    location: { latitude: 1, longitude: 2 },
}), /type=photo[\s\S]*type=location/u);

assert.equal(extractIncomingReplyTarget({ platform: 'vk' }), null);
assert.equal(extractIncomingReplyTarget({
    platform: 'vk',
    replyMessage: {},
    message: { reply_message: {} },
}), null);

console.log('replyTargetRouting tests: OK');
