import assert from 'node:assert/strict';
import test from 'node:test';

import {
    buildTelegramEventCandidateSelectionMenu,
    TELEGRAM_MENU_BUTTONS,
} from '../../src/platforms/telegram/telegramBot.js';

function labels(menu) {
    return menu.keyboard.flat().map((button) => button.text);
}

test('V188.97 Telegram delete menu exposes numbered choices, multi-delete and return to party menu', () => {
    const menu = buildTelegramEventCandidateSelectionMenu(3, { action: 'delete' });
    const text = labels(menu);
    assert.ok(text.includes('Удалить 1'));
    assert.ok(text.includes('Удалить 2'));
    assert.ok(text.includes('Удалить 3'));
    assert.ok(text.includes('Удалить 1 2 3'));
    assert.ok(text.includes(TELEGRAM_MENU_BUTTONS.parties));
    assert.ok(text.includes(TELEGRAM_MENU_BUTTONS.mainMenu));
});

test('V188.97 Telegram edit menu offers one numbered edit action per candidate', () => {
    const menu = buildTelegramEventCandidateSelectionMenu(3, { action: 'edit' });
    const text = labels(menu);
    assert.ok(text.includes('Исправить 1'));
    assert.ok(text.includes('Исправить 2'));
    assert.ok(text.includes('Исправить 3'));
    assert.equal(text.some((item) => item === 'Удалить 1 2 3'), false);
});
