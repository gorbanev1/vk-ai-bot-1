import assert from 'node:assert/strict';

import {
    extractTelegramImageTargets,
    extractVkImageTargets,
    resolveIncomingImageTargets,
} from '../../src/features/ai/incomingImageTargets.js';

const vkUrls = extractVkImageTargets({
    attachments: [{
        type: 'wall_reply',
        wall_reply: {
            attachments: [{
                type: 'photo',
                photo: {
                    sizes: [
                        { type: 'm', url: 'https://sun9-1.userapi.com/small.jpg' },
                        { type: 'w', url: 'https://sun9-1.userapi.com/large.jpg' },
                    ],
                },
            }],
        },
    }],
});
assert.deepEqual(vkUrls, [
    'https://sun9-1.userapi.com/large.jpg',
]);

const replyPreferred = await resolveIncomingImageTargets({
    platform: 'vk',
    message: {
        attachments: [{
            type: 'photo',
            photo: { sizes: [{ url: 'https://sun9-1.userapi.com/current.jpg' }] },
        }],
        reply_message: {
            attachments: [{
                type: 'wall',
                wall: {
                    copy_history: [{
                        attachments: [{
                            type: 'photo',
                            photo: { sizes: [{ url: 'https://sun9-1.userapi.com/reply.jpg' }] },
                        }],
                    }],
                },
            }],
        },
    },
});
assert.deepEqual(replyPreferred, [
    'https://sun9-1.userapi.com/current.jpg',
    'https://sun9-1.userapi.com/reply.jpg',
]);

const telegramApi = {
    async getFile(fileId) {
        return { file_path: `photos/${fileId}.jpg` };
    },
    buildFileUrl(filePath) {
        return `https://api.telegram.org/file/botTOKEN/${filePath}`;
    },
};

assert.deepEqual(
    await extractTelegramImageTargets({
        photo: [
            { file_id: 'small' },
            { file_id: 'large' },
        ],
    }, telegramApi),
    ['https://api.telegram.org/file/botTOKEN/photos/large.jpg'],
);

assert.deepEqual(
    await resolveIncomingImageTargets({
        platform: 'telegram',
        telegramApi,
        message: {
            photo: [{ file_id: 'current' }],
            reply_message: {
                document: {
                    file_id: 'reply-document',
                    mime_type: 'image/png',
                },
            },
        },
    }),
    [
        'https://api.telegram.org/file/botTOKEN/photos/current.jpg',
        'https://api.telegram.org/file/botTOKEN/photos/reply-document.jpg',
    ],
);

console.log('incomingImageTargets tests: OK');
