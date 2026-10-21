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
  assert.match(TELEGRAM_MENU_BUTTONS.secondaryParties, /\s🥴$/u);
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
