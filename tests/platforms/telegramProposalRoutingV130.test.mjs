import assert from 'node:assert/strict';
import test from 'node:test';

import {
    resolveTelegramMenuInput,
    TELEGRAM_MENU_BUTTONS,
} from '../../src/platforms/telegram/telegramBot.js';

test('proposal prompt supplies a native copy button while retaining the back menu', () => {
    const result = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.proposeEvent, {}, { isOwner: false });
    assert.equal(result.state.pendingAction, 'propose_event');
    assert.ok(result.replyMarkup.keyboard);
    assert.ok(result.followUp.replyMarkup.inline_keyboard[0][0].copy_text.text.startsWith('Название:'));
});

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

test('TG back reaches durable proposal; reset escapes every menu state', () => {
    assert.equal(resolveTelegramMenuInput('⬅️ Назад', {}, { hasProposalDraft: true }).text, 'назад');
    for (const pendingAction of ['propose_event', 'image', 'document_pdf']) {
        const result = resolveTelegramMenuInput('сбросить состояние', { pendingAction });
        assert.equal(result.type, 'command'); assert.equal(result.state.pendingAction, '');
    }
});
