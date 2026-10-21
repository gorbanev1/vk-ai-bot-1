import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

test('V130 explicit parser command escapes pending proposal menu state', () => {
    const result = resolveTelegramMenuInput('парсер все', {
        pendingAction: 'propose_event',
        pendingModel: '',
    });
    assert.equal(result.type, 'command');
    assert.equal(result.text, 'парсер все');
    assert.equal(result.state.pendingAction, '');
});

test('V130 image-only message in proposal mode becomes proposal command and keeps media path open', () => {
    const result = resolveTelegramMenuInput('', {
        pendingAction: 'propose_event',
        pendingModel: '',
    }, {
        hasImageAttachment: true,
        isOwner: false,
    });
    assert.equal(result.type, 'command');
    assert.equal(result.text, 'предложить информацию о тусе');
});
