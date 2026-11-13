import assert from 'node:assert/strict';
import { Buffer } from 'node:buffer';
import {
    TELEGRAM_MAIN_MENU,
    TELEGRAM_MENU_BUTTONS,
    TELEGRAM_OWNER_MAIN_MENU,
    buildTelegramMainMenu,
    buildTelegramPartyMenu,
    buildTelegramQticketsMenu,
    buildTelegramSecondaryPartyMenu,
    buildTelegramEventOwnerActions,
    createTelegramPhotoAttachment,
    createTelegramContext,
    TelegramBotApi,
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
assert.equal(partyMenu.text, 'Раздел «Тусы» открыт.');
assert.equal(partyMenu.replyMarkup.keyboard.length > 0, true);
assert.match(partyMenu.followUp.text, /выбери период кнопкой или напиши команду/iu);
assert.deepEqual(partyMenu.followUp.replyMarkup.inline_keyboard, [
    [{ text: TELEGRAM_MENU_BUTTONS.primaryToday, callback_data: 'party_quick:primary:today' }],
    [{ text: TELEGRAM_MENU_BUTTONS.secondaryToday, callback_data: 'party_quick:secondary:today' }],
    [{ text: TELEGRAM_MENU_BUTTONS.allToday, callback_data: 'party_quick:all:today' }],
    [{ text: TELEGRAM_MENU_BUTTONS.qticketsToday, callback_data: 'party_quick:qtickets:today' }],
    [{ text: TELEGRAM_MENU_BUTTONS.primaryTomorrow, callback_data: 'party_quick:primary:tomorrow' }],
    [{ text: TELEGRAM_MENU_BUTTONS.secondaryTomorrow, callback_data: 'party_quick:secondary:tomorrow' }],
    [{ text: TELEGRAM_MENU_BUTTONS.allTomorrow, callback_data: 'party_quick:all:tomorrow' }],
    [{ text: TELEGRAM_MENU_BUTTONS.primaryUntilWeekEnd, callback_data: 'party_quick:primary:until-week-end' }],
    [{ text: TELEGRAM_MENU_BUTTONS.allUntilWeekEnd, callback_data: 'party_quick:all:until-week-end' }],
]);

const ownerPartyMenu = resolveTelegramMenuInput(
    TELEGRAM_MENU_BUTTONS.parties,
    {},
    { isOwner: true },
);
assert.equal(
    Array.isArray(ownerPartyMenu.replyMarkup.inline_keyboard),
    false,
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
assert.match(resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.parties).followUp.text, /тусы на эту неделю/iu);
assert.equal(resolveTelegramMenuInput('тусы').state.menuPath, 'parties');
assert.equal(resolveTelegramMenuInput('тусы').followUp.replyMarkup.inline_keyboard.length, 9);
for (const [menuPath, expectedPrefix] of [
    ['parties', 'тусы '],
    ['secondary-parties', 'второстепенные / быдлячьи тусы '],
    ['all-parties', 'вообще все тусы '],
    ['qtickets', 'qtickets '],
]) {
    for (const dateText of ['31 октября', '31.10', '13-15.01']) {
        const result = resolveTelegramMenuInput(dateText, { menuPath });
        assert.equal(result.type, 'command', `${menuPath}: ${dateText}`);
        assert.ok(result.text.startsWith(expectedPrefix), `${menuPath}: ${result.text}`);
        assert.ok(result.text.includes(dateText), `${menuPath}: ${result.text}`);
    }
    const dayOnly = resolveTelegramMenuInput('19', { menuPath });
    assert.equal(dayOnly.type, 'command');
    assert.ok(dayOnly.text.includes('19'));
}
assert.match(resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.secondaryParties).followUp.text, /второстепенные тусы/iu);
assert.match(resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.qtickets).followUp.text, /qtickets события на эту неделю/iu);
const secondaryInline = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.secondaryParties).followUp.replyMarkup.inline_keyboard;
assert.deepEqual(secondaryInline.map(row => row.map(button => button.text)), [
    ['☀️ Сегодня'],
    ['🌅 Завтра'],
    ['📅 На этой неделе'],
    ['🗓 На две недели вперёд'],
    ['📆 В этом месяце'],
    ['♾ Все'],
]);
const qticketsInline = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.qtickets).followUp.replyMarkup.inline_keyboard;
assert.deepEqual(qticketsInline.map(row => row.map(button => button.text)), [
    ['☀️ Сегодня'],
    ['🌅 Завтра'],
    ['📅 На этой неделе'],
    ['🗓 На две недели вперёд'],
    ['📆 В этом месяце'],
    ['♾ Все'],
]);
const allInline = resolveTelegramMenuInput(TELEGRAM_MENU_BUTTONS.allPartiesUnified).followUp.replyMarkup.inline_keyboard;
assert.equal(allInline.flat().every(button => button.text.startsWith('🌐')), true);
assert.deepEqual(allInline.map(row => row.map(button => button.text)), [
    ['🌐 Сегодня'],
    ['🌐 Завтра'],
    ['🌐 На этой неделе'],
    ['🌐 На две недели вперёд'],
    ['🌐 В этом месяце'],
    ['🌐 На месяц вперёд'],
    ['🌐 Все'],
]);
for (const rows of [secondaryInline, qticketsInline, allInline]) {
    assert.equal(rows.every(row => row.length === 1), true);
}
assert.equal(buildTelegramSecondaryPartyMenu().keyboard.flat().some(button => button.text === '☀️ Сегодня'), false);
assert.equal(buildTelegramQticketsMenu().keyboard.flat().some(button => button.text === '☀️ Сегодня'), false);
const secondaryKeyboardRows = buildTelegramSecondaryPartyMenu().keyboard.map(row => row.map(button => button.text));
assert.deepEqual(secondaryKeyboardRows.slice(0, 2), [
    ['📅 На этой неделе', '📆 На месяц вперёд', '♾ Все'],
    ['🧾 Кратко'],
]);
const partyMenuRows = buildTelegramPartyMenu().keyboard.map((row) => row.map((button) => button.text));
assert.deepEqual(partyMenuRows.slice(2, 4), [
    [TELEGRAM_MENU_BUTTONS.secondaryParties],
    [TELEGRAM_MENU_BUTTONS.allPartiesUnified, TELEGRAM_MENU_BUTTONS.qtickets],
]);
assert.equal(partyMenuRows.flat().includes(TELEGRAM_MENU_BUTTONS.primaryToday), false);
assert.equal(partyMenuRows.flat().includes(TELEGRAM_MENU_BUTTONS.primaryTomorrow), false);
assert.equal(partyMenuRows.flat().includes(TELEGRAM_MENU_BUTTONS.allToday), false);
assert.equal(partyMenuRows.flat().includes(TELEGRAM_MENU_BUTTONS.allTomorrow), false);

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
assert.ok(fittedCaption.length <= 1000);
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

const telegramSends = [];
const htmlContext = createTelegramContext({
    api: {
        async sendChatAction() {},
        async sendMessage(payload) { telegramSends.push({ method: 'message', payload }); return { message_id: 701 }; },
        async sendPhoto(payload) { telegramSends.push({ method: 'photo', payload }); return { message_id: 702 }; },
    },
    message: { chat: { id: 701, type: 'private' }, from: { id: 701 }, message_id: 700, text: 'карточка' },
    menuState: {},
    botUser: { id: 799, username: 'Gigorave_bot' },
    resolvePeerId: () => 701,
    resolveUserId: () => 701,
    ownerUserId: '701',
});
const linkedVenueHtml = '📍 <a href="https://t.me/rb_diesel">Diesel Hall</a>, <a href="https://yandex.ru/maps/?text=venue">ул. Генерала Лизюкова, 4</a>';
await htmlContext.send({ message: '📍 Diesel Hall, ул. Генерала Лизюкова, 4', html: linkedVenueHtml });
assert.equal(telegramSends[0].payload.text, linkedVenueHtml);
assert.equal(telegramSends[0].payload.parseMode, 'HTML');
await htmlContext.send({
    message: '📍 Diesel Hall, ул. Генерала Лизюкова, 4',
    html: linkedVenueHtml,
    htmlCaption: linkedVenueHtml,
    attachment,
    singleMediaMessage: true,
});
assert.equal(telegramSends[1].method, 'photo');
assert.equal(telegramSends[1].payload.caption, linkedVenueHtml);
assert.equal(telegramSends[1].payload.captionParseMode, 'HTML');

const completeCard = 'Точный анонс. '.repeat(200) + 'КОНЕЦ ОРИГИНАЛА';
const completeHtml = linkedVenueHtml + '\n\n' + completeCard;
const cardButtons = { inline_keyboard: [[{ text: 'Напомнить', callback_data: 'event_remind:manual:1' }]] };
await htmlContext.send({ message: '📍 Diesel Hall, ул. Генерала Лизюкова, 4\n\n' + completeCard, html: completeHtml,
    htmlCaption: linkedVenueHtml + '…', attachment, singleMediaMessage: true, replyMarkup: cardButtons });
assert.equal(telegramSends[2].method, 'photo');
assert.ok(telegramSends[2].payload.caption.length > 0);
assert.ok(telegramSends[2].payload.caption.length <= 1000);
assert.equal(telegramSends[2].payload.captionParseMode, 'HTML');
assert.deepEqual(telegramSends[2].payload.replyMarkup, cardButtons);
assert.equal(telegramSends.length, 4);
assert.equal(telegramSends[3].method, 'message');
assert.equal(telegramSends[3].payload.parseMode, 'HTML');
assert.equal(telegramSends[3].payload.text, completeHtml);
assert.deepEqual(telegramSends[3].payload.replyMarkup, cardButtons);

const originalFetch = globalThis.fetch;
const originalTelegramApiBase = process.env.TELEGRAM_BOT_API_BASE_URL;
const telegramApiBodies = [];
process.env.TELEGRAM_BOT_API_BASE_URL = 'https://telegram-api.test';
globalThis.fetch = async (_url, options) => {
    telegramApiBodies.push(options.body);
    return new Response(JSON.stringify({ ok: true, result: { message_id: 703 } }), { status: 200 });
};
try {
    const api = new TelegramBotApi('test-token');
    await api.sendMessage({ chatId: 701, text: linkedVenueHtml, parseMode: 'HTML' });
    assert.equal(JSON.parse(telegramApiBodies[0]).parse_mode, 'HTML');
    await api.sendPhoto({ chatId: 701, photo: attachment, caption: linkedVenueHtml, captionParseMode: 'HTML' });
    assert.equal(telegramApiBodies[1].get('parse_mode'), 'HTML');
} finally {
    globalThis.fetch = originalFetch;
    if (originalTelegramApiBase === undefined) delete process.env.TELEGRAM_BOT_API_BASE_URL;
    else process.env.TELEGRAM_BOT_API_BASE_URL = originalTelegramApiBase;
}

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
