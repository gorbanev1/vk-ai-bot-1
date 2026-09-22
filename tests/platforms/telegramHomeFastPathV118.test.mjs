import assert from 'node:assert/strict';
import {
    TELEGRAM_MENU_BUTTONS,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

for (const input of ['/start', '/menu', '/home', 'главная', 'главное меню', 'домой', TELEGRAM_MENU_BUTTONS.home]) {
    const result = resolveTelegramMenuInput(
        input,
        { pendingAction: 'image', pendingModel: 'pro3' },
        { isOwner: true, now: new Date('2026-08-24T08:00:00.000Z') },
    );
    assert.equal(result.type, 'response', input);
    assert.equal(result.text, 'Главное меню.', input);
    assert.deepEqual(result.state, { pendingAction: '', pendingModel: '' }, input);
    const buttons = result.replyMarkup.keyboard.flat().map((button) => button.text);
    assert.ok(buttons.some((text) => /Добавить тусу/iu.test(text)), input);
    assert.equal(buttons.includes(TELEGRAM_MENU_BUTTONS.home), false, input);
}

console.log('telegram home fast-path V118 tests: ok');
