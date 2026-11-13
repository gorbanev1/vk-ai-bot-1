import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildVkPartyDmKeyboard,
    isVkPartyDmHintRequest,
    resolveVkPartyDmCommand,
} from '../../src/platforms/vk/vkPartyDmKeyboard.js';

test('VK party DM keyboard contains six period commands', () => {
    const keyboard = JSON.parse(buildVkPartyDmKeyboard());
    assert.equal(keyboard.inline, false);
    assert.equal(keyboard.buttons.flat().length, 6);
    assert.deepEqual(
        keyboard.buttons.flat().map((button) => JSON.parse(button.action.payload).partyCommand),
        [
            'тусы сегодня',
            'вообще все тусы сегодня',
            'тусы завтра',
            'вообще все тусы завтра',
            'тусы эта неделя',
            'вообще все тусы эта неделя',
        ],
    );
});

test('VK party DM payload and visible labels resolve to event commands', () => {
    assert.equal(resolveVkPartyDmCommand('', JSON.stringify({ partyCommand: 'тусы завтра' })), 'тусы завтра');
    assert.equal(resolveVkPartyDmCommand('🌐 Вообще все эта неделя'), 'вообще все тусы эта неделя');
    assert.equal(resolveVkPartyDmCommand('', { object: { message: { payload: JSON.stringify({ partyCommand: 'тусы сегодня' }) } } }), 'тусы сегодня');
});

test('VK party hint is restricted to private messages', () => {
    assert.equal(isVkPartyDmHintRequest('тусы', true), true);
    assert.equal(isVkPartyDmHintRequest('тусы', false), false);
    assert.equal(isVkPartyDmHintRequest('тусы сегодня', true), false);
});
