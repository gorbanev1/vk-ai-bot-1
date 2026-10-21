import assert from 'node:assert/strict';
import {
    TELEGRAM_MENU_BUTTONS,
    buildTelegramEventDeletionMenu,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

const title = 'Концерт Кати IOWA';
const deletionMenu = buildTelegramEventDeletionMenu(title);

assert.deepEqual(
    deletionMenu.keyboard.map((row) => row.map((button) => button.text)),
    [
        [`Вернуть тусу ${title}`],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home],
    ],
);
assert.equal(deletionMenu.is_persistent, true);
assert.equal(TELEGRAM_MENU_BUTTONS.home, '🏠 На главную');

const home = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.home,
    { pendingAction: 'image', pendingModel: 'pro3' },
    { isOwner: true, now: new Date('2026-08-24T07:30:00.000Z') },
);
assert.equal(home.type, 'response');
assert.equal(home.text, 'Главное меню.');
assert.deepEqual(home.state, { pendingAction: '', pendingModel: '' });
assert.equal(
    home.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.home),
    false,
);
assert.equal(
    home.replyMarkup.keyboard.flat().some((button) => /Добавить тусу/iu.test(button.text)),
    true,
);

console.log('telegram event deletion menu V115 tests: ok');
