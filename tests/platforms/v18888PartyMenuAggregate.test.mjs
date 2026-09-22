import assert from 'node:assert/strict';
import test from 'node:test';

import {
    TELEGRAM_MENU_BUTTONS,
    buildTelegramAllPartiesMenu,
    buildTelegramPartyMenu,
    buildTelegramQticketsMenu,
    buildTelegramSecondaryPartyMenu,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

function buttons(markup) {
    return markup.keyboard.flat().map((button) => button.text);
}

test('V188.88 party menu preserves secondary section, adds aggregate, compact toggle and back', () => {
    const labels = buttons(buildTelegramPartyMenu());
    assert.ok(labels.includes(TELEGRAM_MENU_BUTTONS.secondaryParties));
    assert.ok(labels.includes(TELEGRAM_MENU_BUTTONS.allPartiesUnified));
    assert.ok(labels.includes(TELEGRAM_MENU_BUTTONS.compact));
    assert.ok(labels.includes(TELEGRAM_MENU_BUTTONS.back));
});

test('V188.88 every party submenu has one-level back and compact/full toggle', () => {
    for (const markup of [
        buildTelegramQticketsMenu(),
        buildTelegramSecondaryPartyMenu(),
        buildTelegramAllPartiesMenu(),
    ]) {
        const labels = buttons(markup);
        assert.ok(labels.includes(TELEGRAM_MENU_BUTTONS.back));
        assert.ok(labels.includes(TELEGRAM_MENU_BUTTONS.compact));
    }
});

test('V188.88 pressing parties shows command examples including dates, weekday, price and aggregate', () => {
    const result = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.parties);
    assert.equal(result.type, 'response');
    assert.match(result.text, /тусы в пятницу/iu);
    assert.match(result.text, /22\.09\.2026/u);
    assert.match(result.text, /22 сентября 2026/iu);
    assert.match(result.text, /вообще все тусы/iu);
    assert.match(result.text, /до 600 рублей/iu);
});

test('V188.88 compact toggle stays in section, changes to full and changes next command', () => {
    const party = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.parties);
    const compact = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.compact, party.state);
    assert.equal(compact.state.partyDisplayMode, 'compact');
    assert.ok(buttons(compact.replyMarkup).includes(TELEGRAM_MENU_BUTTONS.full));
    const command = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.weekend, compact.state);
    assert.equal(command.type, 'command');
    assert.match(command.text, /кратко$/iu);
});

test('V188.88 aggregate submenu emits aggregate command and back returns to parties', () => {
    const parties = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.parties);
    const aggregate = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.allPartiesUnified, parties.state);
    assert.equal(aggregate.state.menuPath, 'all-parties');
    const command = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.month, aggregate.state);
    assert.equal(command.text, 'вообще все тусы на месяц');
    const back = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.back, aggregate.state);
    assert.equal(back.state.menuPath, 'parties');
    assert.ok(buttons(back.replyMarkup).includes(TELEGRAM_MENU_BUTTONS.secondaryParties));
});
