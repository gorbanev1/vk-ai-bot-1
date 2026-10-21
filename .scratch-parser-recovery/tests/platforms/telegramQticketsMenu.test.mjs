import assert from 'node:assert/strict';
import test from 'node:test';

import {
    TELEGRAM_MENU_BUTTONS,
    buildTelegramMainMenu,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

test('QTickets is not shown in Telegram main menu', () => {
    const menu = buildTelegramMainMenu({ isOwner: false });
    const buttons = menu.keyboard.flat().map((button) => button.text);
    assert.ok(!buttons.includes(TELEGRAM_MENU_BUTTONS.qtickets));
    assert.ok(!buttons.includes(TELEGRAM_MENU_BUTTONS.qticketsParser));
});

test('QTickets poster button is shown inside parties menu', async () => {
    const { buildTelegramPartyMenu } = await import('../../src/platforms/telegram/telegramBot.js');
    const menu = buildTelegramPartyMenu({ isOwner: false });
    const buttons = menu.keyboard.flat().map((button) => button.text);
    assert.ok(buttons.includes('🎟 QTickets афиша'));
});

test('QTickets Telegram button opens its own submenu', () => {
    const result = resolveTelegramMenuInput(
        TELEGRAM_MENU_BUTTONS.qtickets,
        {},
        { isOwner: false },
    );
    assert.equal(result.type, 'response');
    assert.equal(result.state.menuPath, 'qtickets');
    const buttons = result.replyMarkup.keyboard.flat().map((button) => button.text);
    assert.ok(buttons.includes(TELEGRAM_MENU_BUTTONS.qticketsWeek));
    assert.ok(buttons.includes(TELEGRAM_MENU_BUTTONS.qticketsPriceFilter));
});

