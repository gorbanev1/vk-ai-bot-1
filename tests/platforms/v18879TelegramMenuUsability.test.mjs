import test from 'node:test';
import assert from 'node:assert/strict';
import {
  TELEGRAM_MENU_BUTTONS,
  buildTelegramMainMenu,
  buildTelegramPartyMenu,
  resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

test('every reply keyboard has an explicit hide button and is not persistent', () => {
  for (const menu of [buildTelegramMainMenu({ isOwner: true }), buildTelegramPartyMenu({ isOwner: true })]) {
    const labels = menu.keyboard.flat().map((button) => button.text);
    assert.equal(labels.includes(TELEGRAM_MENU_BUTTONS.hideKeyboard), true);
    assert.equal('is_persistent' in menu, false);
  }
  const hidden = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.hideKeyboard, { menuPath: 'parties' }, { isOwner: true });
  assert.deepEqual(hidden.replyMarkup, { remove_keyboard: true });
  assert.equal(hidden.state.menuPath, 'parties');
});

test('secondary party button has different characteristic emoji on both sides', () => {
  assert.match(TELEGRAM_MENU_BUTTONS.secondaryParties, /^🍺\s/u);
  assert.match(TELEGRAM_MENU_BUTTONS.secondaryParties, /Второстепенные тусы$/u);
});

test('party period menus use week, two weeks, month and all; weekends remain text commands', () => {
    const parties = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.parties);
    const secondary = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.secondaryParties, parties.state);
    const all = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.allPartiesUnified, parties.state);
    const regularLabels = parties.replyMarkup.keyboard.flat().map((button) => button.text);
    const secondaryLabels = secondary.replyMarkup.keyboard.flat().map((button) => button.text);
    const allLabels = all.replyMarkup.keyboard.flat().map((button) => button.text);
    assert.ok(!regularLabels.includes(TELEGRAM_MENU_BUTTONS.weekend));
    assert.ok(!secondaryLabels.includes(TELEGRAM_MENU_BUTTONS.secondaryWeekend));
    assert.ok(regularLabels.includes(TELEGRAM_MENU_BUTTONS.week));
    assert.ok(regularLabels.includes(TELEGRAM_MENU_BUTTONS.twoWeeks));
    assert.ok(regularLabels.includes(TELEGRAM_MENU_BUTTONS.month));
    assert.ok(secondaryLabels.includes(TELEGRAM_MENU_BUTTONS.secondaryWeek));
    assert.ok(secondaryLabels.includes(TELEGRAM_MENU_BUTTONS.secondaryTwoWeeks));
    assert.ok(secondaryLabels.includes(TELEGRAM_MENU_BUTTONS.secondaryMonth));
    assert.ok(allLabels.includes(TELEGRAM_MENU_BUTTONS.week));
    assert.ok(allLabels.includes(TELEGRAM_MENU_BUTTONS.twoWeeks));
    assert.ok(allLabels.includes(TELEGRAM_MENU_BUTTONS.month));
    assert.equal(resolveTelegramMenuInput('тусы на этих выходных', parties.state).type, 'command');
});

test('back works hierarchically in Telegram branches', () => {
  const party = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.parties, {}, { isOwner: true });
  assert.equal(party.state.menuPath, 'parties');
  assert.equal(party.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.back), true);

  const secondary = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.secondaryParties, party.state, { isOwner: true });
  assert.equal(secondary.state.menuPath, 'secondary-parties');
  const backToParty = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.back, secondary.state, { isOwner: true });
  assert.equal(backToParty.state.menuPath, 'parties');
  assert.equal(backToParty.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.secondaryParties), true);

  const backHome = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.back, backToParty.state, { isOwner: true });
  assert.equal(backHome.text, 'Главное меню.');
  assert.equal(backHome.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.parties), true);
});
