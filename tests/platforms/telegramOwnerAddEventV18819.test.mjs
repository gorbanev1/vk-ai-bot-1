import test from 'node:test';
import assert from 'node:assert/strict';

import {
    TELEGRAM_MENU_BUTTONS,
    buildTelegramMainMenu,
    buildTelegramPartyMenu,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

const labels = (menu) => menu.keyboard.flat().map((button) => button.text);

test('V188.19 owner main menu shows direct Add Event instead of Propose Event', () => {
    const owner = buildTelegramMainMenu({ isOwner: true, now: new Date('2026-09-09T12:00:00Z') });
    assert.equal(owner.keyboard[0][1].text, TELEGRAM_MENU_BUTTONS.addEvent);
    assert.equal(TELEGRAM_MENU_BUTTONS.addEvent, '➕ Добавить тусу');
    assert.equal(labels(owner).includes(TELEGRAM_MENU_BUTTONS.proposeEvent), false);

    const regular = buildTelegramMainMenu({ isOwner: false, now: new Date('2026-09-09T12:00:00Z') });
    assert.equal(regular.keyboard[0][1].text, TELEGRAM_MENU_BUTTONS.proposeEvent);
    assert.equal(labels(regular).includes(TELEGRAM_MENU_BUTTONS.addEvent), false);
});

test('V188.19 owner party menu has Add Event once and routes it to trusted add_event mode', () => {
    const ownerParty = buildTelegramPartyMenu({ isOwner: true });
    assert.equal(labels(ownerParty).filter((text) => text === TELEGRAM_MENU_BUTTONS.addEvent).length, 1);
    assert.equal(labels(ownerParty).includes(TELEGRAM_MENU_BUTTONS.proposeEvent), false);

    const routed = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.addEvent, {}, { isOwner: true });
    assert.equal(routed.state.pendingAction, 'add_event');
    assert.match(routed.text, /материал считается подтверждённым/u);
});

test('V188.19 non-owner party menu keeps proposal route', () => {
    const regularParty = buildTelegramPartyMenu({ isOwner: false });
    assert.equal(labels(regularParty).includes(TELEGRAM_MENU_BUTTONS.proposeEvent), true);
    assert.equal(labels(regularParty).includes(TELEGRAM_MENU_BUTTONS.addEvent), false);
});
