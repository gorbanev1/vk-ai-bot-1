import assert from 'node:assert/strict';
import test from 'node:test';

import {
    advancePreparedUserReplyCounter,
    findPreparedUserReplyProfile,
    normalizePreparedUserRepliesConfig,
    parsePreparedUserRepliesReloadCommand,
} from '../../src/features/personality/preparedUserReplies.js';

test('prepared reply config matches a profile by platform ID, username, or display name', () => {
    const config = normalizePreparedUserRepliesConfig({ users: [{
        platform: 'telegram', ids: ['123'], usernames: ['@tim'], names: ['Tim User'],
        interval: { min: 2, max: 5 }, phrases: ['A', 'B'],
    }] });
    assert.equal(findPreparedUserReplyProfile(config, { platform: 'telegram', id: '123' })?.phrases[0], 'A');
    assert.equal(findPreparedUserReplyProfile(config, { platform: 'telegram', username: 'TIM' })?.interval.max, 5);
    assert.equal(findPreparedUserReplyProfile(config, { platform: 'telegram', name: 'Tim User' })?.ids[0], '123');
    assert.equal(findPreparedUserReplyProfile(config, { platform: 'vk', id: '123' }), null);
});

test('random request interval replies on the first request when gap is zero and preserves next threshold', () => {
    const drawZero = () => 0;
    const interval = { min: 0, max: 4 };
    const first = advancePreparedUserReplyCounter(null, interval, drawZero);
    assert.equal(first.shouldReply, true);
    assert.equal(first.state.totalRequests, 1);
    assert.equal(first.state.nextReplyAt, 1);
    const second = advancePreparedUserReplyCounter(first.state, interval, drawZero);
    assert.equal(second.shouldReply, true);
    assert.equal(second.state.totalRequests, 2);
});

test('random request interval skips until the selected number of later requests', () => {
    const drawTwo = (min, max) => Math.min(2, max - 1);
    const interval = { min: 1, max: 3 };
    const first = advancePreparedUserReplyCounter(null, interval, drawTwo);
    assert.equal(first.shouldReply, false);
    assert.equal(first.state.nextReplyAt, 3);
    const second = advancePreparedUserReplyCounter(first.state, interval, drawTwo);
    assert.equal(second.shouldReply, false);
    const third = advancePreparedUserReplyCounter(second.state, interval, drawTwo);
    assert.equal(third.shouldReply, true);
    assert.equal(third.state.nextReplyAt, 5);
});

test('owner reload command accepts expected phrasings independent of ё', () => {
    assert.equal(parsePreparedUserRepliesReloadCommand('подгрузить фразы для юзернеймов'), true);
    assert.equal(parsePreparedUserRepliesReloadCommand('перечитать фразы'), true);
    assert.equal(parsePreparedUserRepliesReloadCommand('обычный вопрос'), false);
});
