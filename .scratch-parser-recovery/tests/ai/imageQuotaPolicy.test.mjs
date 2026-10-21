import assert from 'node:assert/strict';
import { resolveGptImageDailyLimit } from '../../src/features/ai/imageQuotaPolicy.js';

assert.equal(resolveGptImageDailyLimit({ platform: 'telegram', vkLimit: 5, telegramLimit: 2 }), 2);
assert.equal(resolveGptImageDailyLimit({ platform: 'vk', vkLimit: 5, telegramLimit: 2 }), 5);
assert.equal(resolveGptImageDailyLimit({ platform: 'telegram', vkLimit: 5 }), 2);

console.log('image quota policy tests: OK');
