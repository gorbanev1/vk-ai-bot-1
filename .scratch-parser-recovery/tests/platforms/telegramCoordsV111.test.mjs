import assert from 'node:assert/strict';
import {
    TELEGRAM_MENU_BUTTONS,
    buildTelegramMainMenu,
    resolveTelegramMenuInput,
    shouldShowTelegramCoordsButton,
} from '../../src/platforms/telegram/telegramBot.js';
import {
    getCoordsOverrideWindowState,
    isCoordsOverrideWindow,
    shouldSendCoordsOverride,
} from '../../src/features/coords/coordsOverrideRouting.js';

const aug21EndMoscow = new Date('2026-08-21T20:59:59.999Z');
const aug22StartMoscow = new Date('2026-08-21T21:00:00.000Z');
const beforeElevenMoscow = new Date('2026-08-22T07:59:59.999Z');
const elevenMoscow = new Date('2026-08-22T08:00:00.000Z');
const aug23StartMoscow = new Date('2026-08-22T21:00:00.000Z');

assert.equal(shouldShowTelegramCoordsButton(aug21EndMoscow), false);
assert.equal(shouldShowTelegramCoordsButton(aug22StartMoscow), true);
assert.equal(shouldShowTelegramCoordsButton(beforeElevenMoscow), true);
assert.equal(shouldShowTelegramCoordsButton(aug23StartMoscow), false);

const menu = buildTelegramMainMenu({ now: beforeElevenMoscow });
assert.equal(
    menu.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.coords),
    true,
);

const routed = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.coords,
    { pendingAction: 'image', pendingModel: 'pro3' },
    { now: beforeElevenMoscow },
);
assert.equal(routed.type, 'command');
assert.equal(routed.text, 'корды пересоздание');
assert.deepEqual(routed.state, { pendingAction: '', pendingModel: '' });

assert.equal(getCoordsOverrideWindowState(beforeElevenMoscow), 'before');
assert.equal(isCoordsOverrideWindow(beforeElevenMoscow), false);
assert.equal(getCoordsOverrideWindowState(elevenMoscow), 'active');
assert.equal(isCoordsOverrideWindow(elevenMoscow), true);
assert.equal(
    shouldSendCoordsOverride({
        requestText: 'корды пересоздание',
        settings: { enabled: true, messageText: 'текст из SQLite' },
        now: elevenMoscow,
    }),
    true,
);
assert.equal(getCoordsOverrideWindowState(aug23StartMoscow), 'after');
assert.equal(isCoordsOverrideWindow(aug23StartMoscow), false);

console.log('telegram V111 coords tests: OK');
