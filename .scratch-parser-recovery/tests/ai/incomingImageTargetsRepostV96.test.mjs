import assert from 'node:assert/strict';
import {
    extractVkImageTargets,
    resolveIncomingImageTargets,
} from '../../src/features/ai/incomingImageTargets.js';

const large = 'https://sun9-1.userapi.com/repost-large.jpg';
const small = 'https://sun9-1.userapi.com/repost-small.jpg';
const nested = {
    reply_message: {
        attachments: [{
            type: 'wall',
            wall: {
                owner_id: -123,
                id: 456,
                copy_history: [{
                    attachments: [{
                        type: 'photo',
                        photo: {
                            sizes: [
                                { url: small, width: 100, height: 100 },
                                { url: large, width: 1600, height: 1200 },
                            ],
                        },
                    }],
                }],
            },
        }],
    },
};

assert.deepEqual(extractVkImageTargets(nested), [large]);
const resolved = await resolveIncomingImageTargets({
    platform: 'vk',
    eventPayload: { object: { message: nested } },
});
assert.deepEqual(resolved, [large]);

const deepest = 'https://sun9-1.userapi.com/deepest-poster.jpg';
let deepCopy = {
    attachments: [{
        type: 'photo',
        photo: {
            sizes: [{ url: deepest, width: 1800, height: 2400 }],
        },
    }],
};
for (let index = 0; index < 20; index += 1) {
    deepCopy = { copy_history: [deepCopy] };
}
assert.deepEqual(extractVkImageTargets({
    attachments: [{ type: 'wall', wall: deepCopy }],
}), [deepest]);

console.log('incomingImageTargetsRepostV96.test.mjs: OK');
