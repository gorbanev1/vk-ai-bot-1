import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
    TELEGRAM_MAIN_MENU,
    TELEGRAM_MENU_BUTTONS,
    TELEGRAM_OWNER_MAIN_MENU,
    buildTelegramMainMenu,
    buildTelegramPartyMenu,
    buildTelegramEventOwnerActions,
    createTelegramPhotoAttachment,
    fitTelegramCaption,
    isTelegramPhotoAttachment,
    isDirectTelegramImageCommand,
    shouldShowTelegramCoordsButton,
    shouldShowTelegramThankEventButton,
    normalizeTelegramCommandText,
    resolveTelegramMenuInput,
    splitTelegramText,
} from '../../src/platforms/telegram/telegramBot.js';
import {
    getOrCreatePlatformIdentity,
} from '../../src/infrastructure/database/index.js';
import { isExplicitApplicationCommand } from '../../src/features/routing/explicitApplicationCommand.js';

assert.deepEqual(
    buildTelegramEventOwnerActions({ sourceType: 'vk', id: 304 }),
    { inline_keyboard: [
        [
            { text: '✏️ Изменить', callback_data: 'event_edit:vk:304' },
            { text: '🗑 Удалить', callback_data: 'event_delete:vk:304' },
        ],
        [{ text: '🚫 Удалить навсегда', callback_data: 'event_delete_permanent:vk:304' }],
    ] },
);
assert.equal(buildTelegramEventOwnerActions({ sourceType: 'vk', id: 0 }), null);

assert.equal(
    normalizeTelegramCommandText('/help@TestBot', 'TestBot'),
    'помощь',
);
assert.equal(
    normalizeTelegramCommandText('/pro3_prashna Воронеж вопрос', 'TestBot'),
    'pro3 prashna Воронеж вопрос',
);
assert.equal(
    normalizeTelegramCommandText('/help@OtherBot', 'TestBot'),
    '',
);


assert.equal(TELEGRAM_MAIN_MENU.keyboard[0][0].text, '🎉 Тусы');
assert.equal(
    TELEGRAM_MAIN_MENU.keyboard.flat().some((button) =>
        /натал/iu.test(button.text)),
    false,
);


assert.equal(
    TELEGRAM_MAIN_MENU.keyboard.flat().some((button) =>
        /Добавить тусу/iu.test(button.text)),
    false,
);
assert.equal(
    TELEGRAM_OWNER_MAIN_MENU.keyboard.flat().some((button) =>
        /Добавить тусу/iu.test(button.text)),
    true,
);
assert.equal(
    TELEGRAM_MAIN_MENU.keyboard.flat().some((button) =>
        button.text === TELEGRAM_MENU_BUTTONS.contactDeveloper),
    true,
);
assert.equal(
    resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.contactDeveloper).text,
    'написать разработчику',
);
assert.equal(isExplicitApplicationCommand('написать разработчику'), true);

assert.equal(
    TELEGRAM_MAIN_MENU.keyboard.flat().some((button) =>
        /Предложить тусу/iu.test(button.text)),
    true,
);

assert.equal(
    TELEGRAM_MAIN_MENU.keyboard.flat().some((button) => /пинбол/iu.test(button.text)),
    false,
);
assert.equal(TELEGRAM_MAIN_MENU.keyboard[0][1].text, TELEGRAM_MENU_BUTTONS.proposeEvent);


const beforeCoordsMenu = buildTelegramMainMenu({
    now: new Date('2026-08-21T20:59:59.999Z'), // 23:59:59.999 MSK on Aug 21
});
assert.equal(
    beforeCoordsMenu.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.coords),
    false,
);

const coordsMorningMenu = buildTelegramMainMenu({
    now: new Date('2026-08-21T21:00:00.000Z'), // 00:00 MSK on Aug 22
});
assert.equal(
    coordsMorningMenu.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.coords),
    true,
);
assert.equal(shouldShowTelegramCoordsButton(new Date('2026-08-21T21:00:00.000Z')), true);
assert.equal(shouldShowTelegramCoordsButton(new Date('2026-08-22T21:00:00.000Z')), false);

const beforeThanksMenu = buildTelegramMainMenu({
    now: new Date('2026-08-22T16:59:59.999Z'), // 19:59:59.999 MSK
});
assert.equal(
    beforeThanksMenu.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.thankEvent),
    false,
);
const thanksMenu = buildTelegramMainMenu({
    now: new Date('2026-08-22T17:00:00.000Z'), // 20:00 MSK
});
assert.equal(
    thanksMenu.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.thankEvent),
    true,
);
assert.equal(shouldShowTelegramThankEventButton(new Date('2026-08-23T12:00:00.000Z')), true);
assert.equal(shouldShowTelegramThankEventButton(new Date('2026-09-01T12:00:00.000Z')), false);

const coordsButton = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.coords,
    {},
    { isOwner: false, now: new Date('2026-08-22T04:00:00.000Z') },
);
assert.equal(coordsButton.type, 'command');
assert.equal(coordsButton.text, 'корды пересоздание');

const thankButton = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.thankEvent,
    {},
    { isOwner: false, now: new Date('2026-08-22T17:00:00.000Z') },
);
assert.equal(thankButton.type, 'command');
assert.equal(thankButton.text, 'пересоздание спасибо');
const proposalButton = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.proposeEvent,
    {},
    { isOwner: false },
);
assert.equal(proposalButton.state.pendingAction, 'propose_event');
assert.equal(proposalButton.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.back), true);
const proposalInput = resolveTelegramMenuInput(
    'https://example.com/party',
    proposalButton.state,
    { isOwner: false },
);
assert.equal(
    proposalInput.text,
    'предложить информацию о тусе https://example.com/party',
);
const proposalBack = resolveTelegramMenuInput(
    'назад',
    proposalButton.state,
    { isOwner: false },
);
assert.equal(proposalBack.type, 'response');
assert.deepEqual(proposalBack.state, { pendingAction: '', pendingModel: '' });


const ownerEventButton = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.addEvent,
    {},
    { isOwner: true },
);
assert.equal(ownerEventButton.state.pendingAction, 'add_event');
assert.equal(ownerEventButton.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.back), true);
const ownerEventInput = resolveTelegramMenuInput(
    'https://example.com/event',
    ownerEventButton.state,
    { isOwner: true },
);
assert.equal(
    ownerEventInput.text,
    'добавить событие https://example.com/event',
);
const nonOwnerEventButton = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.addEvent,
    {},
    { isOwner: false },
);
assert.equal(nonOwnerEventButton.type, 'response');
assert.match(nonOwnerEventButton.text, /только владелец/u);

const partyMenu = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.parties,
);
assert.equal(partyMenu.type, 'response');
assert.match(partyMenu.text, /выбери период кнопкой или напиши команду/iu);
assert.match(partyMenu.text, /22 сентября 2026/iu);
assert.equal(partyMenu.replyMarkup.keyboard.length >= 7, true);
assert.equal(partyMenu.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.week), true);
assert.equal(partyMenu.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.twoWeeks), true);
assert.equal(partyMenu.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.month), true);
assert.equal(
    partyMenu.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.back),
    true,
);
assert.equal(
    partyMenu.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.hideKeyboard),
    true,
);

const ownerPartyMenu = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.parties,
    {},
    { isOwner: true },
);
assert.equal(
    ownerPartyMenu.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.addSource),
    true,
);
assert.equal(
    buildTelegramPartyMenu({ isOwner: false }).keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.addSource),
    false,
);
const addSourceButton = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.addSource,
    {},
    { isOwner: true },
);
assert.equal(addSourceButton.state.pendingAction, 'add_source');
const addSourceInput = resolveTelegramMenuInput(
    'https://t.me/new_channel',
    addSourceButton.state,
    { isOwner: true },
);
assert.equal(addSourceInput.type, 'command');
assert.equal(addSourceInput.text, 'добавить источник https://t.me/new_channel');
const deniedAddSourceButton = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.addSource,
    {},
    { isOwner: false },
);
assert.equal(deniedAddSourceButton.type, 'response');
assert.match(deniedAddSourceButton.text, /только владелец/u);

const partyMenuButtons = buildTelegramPartyMenu().keyboard.flat().map((button) => button.text);
assert.equal(partyMenuButtons.some((button) => /ближайшие дни/iu.test(button)), false);
assert.match(resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.parties).text, /тусы на эту неделю/iu);
assert.match(resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.secondaryParties).text, /второстепенные тусы/iu);
assert.match(resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.qtickets).text, /qtickets события на эту неделю/iu);
const partyMenuRows = buildTelegramPartyMenu().keyboard.map((row) => row.map((button) => button.text));
assert.deepEqual(partyMenuRows.slice(2, 5), [
    [TELEGRAM_MENU_BUTTONS.secondaryParties],
    [TELEGRAM_MENU_BUTTONS.qtickets],
    [TELEGRAM_MENU_BUTTONS.allPartiesUnified],
]);

const allParties = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.allParties,
);
assert.equal(allParties.text, 'все тусы');

const selectedPro3 = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.modelPro3,
);
assert.equal(selectedPro3.state.pendingModel, 'pro3');
const pro3Query = resolveTelegramMenuInput(
    'объясни теорию относительности',
    selectedPro3.state,
);
assert.equal(
    pro3Query.text,
    'pro3 объясни теорию относительности',
);

const imagePrompt = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.image,
);
const ownerImageModelTest = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.imageModelTest,
    {},
    { isOwner: true },
);
assert.equal(ownerImageModelTest.type, 'command');
assert.equal(ownerImageModelTest.text, 'графика тест петух');
const deniedImageModelTest = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.imageModelTest,
    {},
    { isOwner: false },
);
assert.equal(deniedImageModelTest.type, 'response');
assert.match(imagePrompt.text, /генерации.*по умолчанию/iu);
assert.match(imagePrompt.text, /Назад/u);
assert.equal(imagePrompt.replyMarkup.keyboard.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.back), true);
assert.ok(Array.isArray(imagePrompt.replyMarkup.keyboard));
const selectedImageModel = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.imageModel2, imagePrompt.state);
assert.equal(selectedImageModel.state.imageModel, 'gpt-image-2');
assert.match(selectedImageModel.text, /Отправь описание для генерации/u);
assert.equal(selectedImageModel.state.pendingAction, 'image');
const directImageQuery = resolveTelegramMenuInput(
    'рыжего кота в космосе',
    selectedImageModel.state,
);
assert.equal(directImageQuery.text, 'gpt image-model=gpt-image-2 нарисуй рыжего кота в космосе');
assert.equal(directImageQuery.state.pendingAction, '');
const imageMode = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.imageGenerate, selectedImageModel.state);
assert.equal(imageMode.state.pendingAction, 'image');
const imageQuery = resolveTelegramMenuInput(
    'рыжего кота в космосе',
    imageMode.state,
);
assert.equal(imageQuery.text, 'gpt image-model=gpt-image-2 нарисуй рыжего кота в космосе');
assert.equal(imageQuery.state.pendingAction, '');
assert.equal(imageQuery.state.menuPath, 'image-models');
assert.equal(imageQuery.state.imageModel, '');

const secondImageQuery = resolveTelegramMenuInput(
    'киберпанк Воронеж ночью',
    imageQuery.state,
);
assert.equal(secondImageQuery.type, 'pass');

const explicitDrawInImageMode = resolveTelegramMenuInput(
    'рисуй кота в шлеме',
    imageMode.state,
);
assert.equal(explicitDrawInImageMode.text, 'gpt image-model=gpt-image-2 рисуй кота в шлеме');
assert.equal(explicitDrawInImageMode.state.pendingAction, '');
const attachedImageEdit = resolveTelegramMenuInput(
    'замени фон на лес',
    imageMode.state,
    { hasImageAttachment: true },
);
assert.equal(attachedImageEdit.text, 'gpt image-model=gpt-image-2 измени изображение замени фон на лес');
assert.equal(attachedImageEdit.state.menuPath, 'image-models');
const attachedImageEditWithoutModeSelection = resolveTelegramMenuInput(
    'убери надпись',
    selectedImageModel.state,
    { hasImageAttachment: true },
);
assert.equal(attachedImageEditWithoutModeSelection.type, 'command');
assert.equal(attachedImageEditWithoutModeSelection.text, 'gpt image-model=gpt-image-2 измени изображение убери надпись');
const plainTextLeavesImageMode = resolveTelegramMenuInput(
    'помощь',
    selectedImageModel.state,
);
assert.equal(plainTextLeavesImageMode.type, 'command');
assert.equal(plainTextLeavesImageMode.text, 'помощь');
assert.equal(isDirectTelegramImageCommand('Нарисуй город'), true);
assert.equal(isDirectTelegramImageCommand('рисуй город'), true);


const prashnaLeavesImageModeForPolicyBlock = resolveTelegramMenuInput(
    'pro3 прашна Воронеж вопрос',
    imageMode.state,
);
assert.equal(prashnaLeavesImageModeForPolicyBlock.type, 'command');
assert.equal(prashnaLeavesImageModeForPolicyBlock.text, 'pro3 прашна Воронеж вопрос');
assert.equal(prashnaLeavesImageModeForPolicyBlock.state.pendingAction, '');

const leaveImageModeWithParties = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.parties,
    imageMode.state,
);
assert.equal(leaveImageModeWithParties.state.pendingAction, '');

const explicitHelpLeavesImageMode = resolveTelegramMenuInput(
    'помощь',
    imageMode.state,
);
assert.equal(explicitHelpLeavesImageMode.text, 'помощь');
assert.equal(explicitHelpLeavesImageMode.state.pendingAction, '');

const fittedCaption = fitTelegramCaption('абзац\n\n' + 'а'.repeat(2000));
assert.ok(fittedCaption.length <= 1024);
assert.match(fittedCaption, /…$/u);

const chunks = splitTelegramText('а'.repeat(5000), 4096);
assert.equal(chunks.length, 2);
assert.equal(chunks.join('').length, 5000);

const attachment = createTelegramPhotoAttachment({
    buffer: Buffer.from([1, 2, 3]),
    filename: 'test.png',
    mimeType: 'image/png',
});
assert.equal(isTelegramPhotoAttachment(attachment), true);

const suffix = `${Date.now()}-${Math.random()}`;
const userOne = getOrCreatePlatformIdentity({
    platform: 'telegram',
    entityType: 'user',
    externalId: `user-${suffix}`,
});
const userTwo = getOrCreatePlatformIdentity({
    platform: 'telegram',
    entityType: 'user',
    externalId: `user-${suffix}`,
});
const peer = getOrCreatePlatformIdentity({
    platform: 'telegram',
    entityType: 'peer',
    externalId: `group:${suffix}`,
});

assert.equal(userOne, userTwo);
assert.ok(userOne >= 3_000_000_000);
assert.ok(peer <= -3_000_000_000);

console.log('telegram bot tests: OK');
