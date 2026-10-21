import assert from 'node:assert/strict';
import {
    TELEGRAM_MENU_BUTTONS,
    buildTelegramPartyMenu,
    resolveTelegramMenuInput,
} from '../../src/platforms/telegram/telegramBot.js';

const publicMenu = buildTelegramPartyMenu({ isOwner: false });
const publicButtons = publicMenu.keyboard.flat().map((button) => button.text);
assert.equal(publicButtons.includes(TELEGRAM_MENU_BUTTONS.proposeEvent), true);
assert.equal(publicButtons.includes(TELEGRAM_MENU_BUTTONS.mainMenu), true);
assert.equal(publicButtons.includes(TELEGRAM_MENU_BUTTONS.back), true);
assert.equal(publicButtons.includes(TELEGRAM_MENU_BUTTONS.home), false);
assert.equal(publicButtons.includes(TELEGRAM_MENU_BUTTONS.addEvent), false);
assert.equal(publicButtons.includes(TELEGRAM_MENU_BUTTONS.addSource), false);
assert.equal(publicButtons.includes(TELEGRAM_MENU_BUTTONS.hideKeyboard), true);

const ownerMenu = buildTelegramPartyMenu({ isOwner: true });
const ownerButtons = ownerMenu.keyboard.flat().map((button) => button.text);
assert.equal(ownerButtons.includes(TELEGRAM_MENU_BUTTONS.partyAddEvent), true);
assert.equal(ownerButtons.includes(TELEGRAM_MENU_BUTTONS.addEvent), true);
assert.equal(ownerButtons.includes(TELEGRAM_MENU_BUTTONS.addSource), true);
assert.equal(ownerButtons.includes(TELEGRAM_MENU_BUTTONS.mainMenu), true);
assert.equal(ownerButtons.includes(TELEGRAM_MENU_BUTTONS.back), true);
assert.equal(ownerButtons.includes(TELEGRAM_MENU_BUTTONS.home), false);
assert.equal(ownerButtons.includes(TELEGRAM_MENU_BUTTONS.hideKeyboard), true);

const publicAdd = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.proposeEvent, {}, { isOwner: false });
assert.equal(publicAdd.type, 'response');
assert.equal(publicAdd.state.pendingAction, 'propose_event');

const ownerAdd = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.addEvent, {}, { isOwner: true });
assert.equal(ownerAdd.state.pendingAction, 'add_event');

const mainMenu = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.mainMenu, {}, { isOwner: true });
assert.equal(mainMenu.type, 'response');
assert.equal(mainMenu.text, 'Главное меню.');
assert.deepEqual(mainMenu.state, { pendingAction: '', pendingModel: '' });

console.log('telegram party menu V1885 tests: ok');
