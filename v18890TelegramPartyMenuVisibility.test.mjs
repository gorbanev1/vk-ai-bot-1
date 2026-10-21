import assert from 'node:assert/strict';
import test from 'node:test';

import {
    TELEGRAM_MENU_BUTTONS,
    buildTelegramPartyMenu,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

test('V188.90 party menu keeps All parties and Secondary parties in the visible top rows', () => {
    const menu = buildTelegramPartyMenu({ isOwner: false });
    const topRows = menu.keyboard.slice(0, 3).map((row) => row.map((button) => button.text));

    assert.deepEqual(topRows[2], [
        TELEGRAM_MENU_BUTTONS.allParties,
        TELEGRAM_MENU_BUTTONS.secondaryParties,
    ]);
    assert.equal(TELEGRAM_MENU_BUTTONS.secondaryParties, '🍺 Второстепенные тусы');
});

test('V188.90 secondary button still opens the dedicated secondary party submenu', () => {
    const opened = resolveTelegramMenuInput(
        TELEGRAM_MENU_BUTTONS.secondaryParties,
        { menuPath: 'parties' },
        { isOwner: false },
    );

    assert.equal(opened.type, 'response');
    assert.equal(opened.state.menuPath, 'secondary-parties');
    assert.match(opened.text, /второстепенные/u);
});

test('V188.90 compact party menu keeps aggregate and QTickets available without displacing primary categories', () => {
    const menu = buildTelegramPartyMenu({ isOwner: false, compact: true });
    const rows = menu.keyboard.map((row) => row.map((button) => button.text));

    assert.deepEqual(rows[3], [
        TELEGRAM_MENU_BUTTONS.allPartiesUnified,
        TELEGRAM_MENU_BUTTONS.qtickets,
    ]);
    assert.ok(rows.flat().includes(TELEGRAM_MENU_BUTTONS.compact) === false);
    assert.ok(rows.flat().includes(TELEGRAM_MENU_BUTTONS.full));
});
