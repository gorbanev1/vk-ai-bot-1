import assert from 'node:assert/strict';
import { selectDeepestCapturedVkWall } from '../../src/features/events/vkOriginalPost.js';

const outer = {
    owner_id: -10,
    id: 100,
    text: 'подпись сообщения-репоста',
    copy_history: [{
        owner_id: -11,
        id: 101,
        text: 'второй репост',
        copy_history: [{ owner_id: -12, id: 102, text: 'исходный пост события' }],
    }],
};
const result = selectDeepestCapturedVkWall([outer]);
assert.equal(result.wall.text, 'исходный пост события');
assert.equal(result.url, 'https://vk.ru/wall-12_102');
console.log('vkOriginalPostDeepest.test.mjs: OK');
