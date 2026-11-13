/**
 * Адаптер Telegram Bot API: long polling, отправка сообщений/фото, меню и преобразование Telegram update в единый контекст приложения.
 */
import {
    existsSync,
    openAsBlob,
    readFileSync,
    statSync,
} from 'node:fs';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { Buffer } from 'node:buffer';
import { buildTelegramReplyParameters } from '../../shared/incomingReplyTransport.js';
import { createBotMentionTools } from '../../shared/commands.js';
import { splitTelegramLongReply, sendTelegramLongReply } from './telegramLongReply.js';
import { isExplicitApplicationCommand } from '../../features/routing/explicitApplicationCommand.js';
import { isProjectArchiveAuditIntent } from '../../features/audit/projectArchiveIntent.js';
import {
    parseQticketsBarePriceLimit,
    parseQticketsPriceLimit,
} from '../../features/events/qticketsRouting.js';
import { isAstraChannelMode } from '../../runtime/aiChannelMode.js';

import { EVENT_PROPOSAL_TEMPLATE } from '../../features/events/eventProposalSubmission.js';

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1000;
const TELEGRAM_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const TELEGRAM_PENDING_MENU_TTL_MS = 30 * 60 * 1000;
const TELEGRAM_NAMED_EVENT_DATE_INPUT = /(?:^|\s)\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?:\s+\d{4})?(?=$|\s)/iu;



const TELEGRAM_DIRECT_IMAGE_COMMAND = /^(?:нарисуй|рисуй|нарисовать|рисовать|изобрази|изображай|image|img|картин(?:ка|ку|ки|кой)?|изображени(?:е|я|ю|ем)?|сгенерируй(?:\s+(?:картинку|изображение))?|создай(?:\s+(?:картинку|изображение))?|сделай(?:\s+(?:картинку|изображение))?)(?=$|\s)/iu;
function isDirectTelegramImageCommand(value) {
    return TELEGRAM_DIRECT_IMAGE_COMMAND.test(String(value ?? '').trim());
}

function isExplicitTelegramNonImageCommand(value, { botUsername = '' } = {}) {
    const source = String(value ?? '').trim();
    if (!source) return false;
    if (isDirectTelegramImageCommand(source)) return false;
    if (isExplicitApplicationCommand(source)) return true;

    // Незавершённый режим меню не должен съедать локальную команду только
    // потому, что «Гигорейв» стоит после неё или внутри того же предложения.
    // Используем тот же sentence-scope, что и основной router.
    const mentionTools = createBotMentionTools({
        groupId: '',
        getTelegramBotUsername: () => botUsername,
    });
    if (!mentionTools.containsBotMention(source)) return false;

    // Любой осмысленный запрос, явно адресованный Гигорейву в одном
    // предложении, выходит из незавершённого меню и попадает в основной
    // router. Там уже решается, локальная это команда или обычный AI-запрос.
    // Так меню не может поглотить новую/редкую команду, отсутствующую в
    // своём статическом списке.
    return mentionTools.getBotAddressedCommandCandidates(source).length > 0;
}

const TELEGRAM_PERESOZDANIE_COORDS_TIME_ZONE = 'Europe/Moscow';
const TELEGRAM_PERESOZDANIE_COORDS_DATE = '2026-08-22';
const TELEGRAM_PERESOZDANIE_THANK_START = new Date('2026-08-22T17:00:00.000Z'); // 20:00 Europe/Moscow
const TELEGRAM_PERESOZDANIE_THANK_END = new Date('2026-08-23T21:00:00.000Z'); // end of 23 Aug Europe/Moscow

const TELEGRAM_MENU_BUTTONS = Object.freeze({
    parties: '🎉 Тусы',
    qtickets: '🎟 QTickets афиша',
    qticketsParser: '🔄 QTickets парсер',
    qticketsWeek: '📅 QTickets · эта неделя',
    qticketsTwoWeeks: '🗓 QTickets · 2 недели',
    qticketsMonth: '📆 QTickets · месяц',
    qticketsAll: '♾ QTickets · всё время',
    qticketsPriceFilter: '💰 Установить фильтр стоимости',
    qticketsPriceReset: '🧹 Сбросить фильтр стоимости',
    coords: '📍 Корды Пересоздание',
    thankEvent: '🖤 Поблагодарить за Пересоздание',
    imageMenu: '🖼 Изображения',
    image: '🖼 Изображение · выбрать модель',
    imageEdit: '🛠 Изображение · редактировать',
    imageModel2: '🖼 GPT Image 2',
    imageModel25: '✨ GPT Image 2.5 · по умолчанию',
    imageModel25Flare: '🔥 GPT Image 2.5 Flare',
    imageModel25Sunburst: '☀️ GPT Image 2.5 Sunburst',
    imageGenerate: '🎨 Сгенерировать',
    imageEditMode: '🛠 Отредактировать',
    imageModelTest: '🧪 Тест 3 image-моделей · петух',
    documents: '📄 Документы',
    huinglish: '🌭 Хуинглиш 🍆',
    huinglishReset: '🔄 Хуинглиш · сбросить',
    documentWord: '📝 Word',
    documentPdf: '📕 PDF',
    documentPptx: '📊 Презентация',
    models: '🚀 Продвинутые текстовые модели GPT',
    help: '❓ Помощь',
    contactDeveloper: '✉️ Написать разработчику',
    proposeEvent: '➕ Предложить тусу',
    partyAddEvent: '➕ Добавить тусу',
    addEvent: '➕ Добавить тусу',
    addSource: 'Добавить источник',
    week: '📅 Эта неделя',
    primaryToday: '☀️ Основные сегодня',
    primaryTomorrow: '🌅 Основные завтра',
    secondaryToday: '🍺 Второстепенные сегодня',
    secondaryTomorrow: '🍺 Второстепенные завтра',
    secondaryWeek: '📅 На этой неделе',
    secondaryMonth: '📆 На месяц вперёд',
    qticketsToday: '🎟 QTickets афиша сегодня',
    allToday: '🌐 Вообще все сегодня',
    allTomorrow: '🌐 Вообще все завтра',
    primaryUntilWeekEnd: '📅 Основные до конца недели',
    allUntilWeekEnd: '🌐 Вообще все до конца недели',
    allWeek: '🌐 Вообще все на этой неделе',
    allTwoWeeks: '🌐 Вообще все на две недели вперёд',
    allMonth: '🌐 Вообще все на месяц вперёд',
    allAll: '🌐 Все',
    weekend: '🎊 Эти выходные',
    twoWeeks: '🗓 На две недели вперёд',
    month: '📆 На месяц вперёд',
    allParties: '♾ Все тусы',
    allPartiesUnified: '🌐 Вообще все тусы',
    compact: '🧾 Кратко',
    full: '🖼 Полно',
    secondaryParties: '🍺 Второстепенные тусы',
    secondaryWeekend: '🎊 Второстепенные · эти выходные',
    secondaryTwoWeeks: '🗓 Второстепенные · 2 недели вперёд',
    secondaryAllParties: '♾ Все',
    hideKeyboard: '⌨️ Скрыть клавиатуру',
    modelPro: '🌙 Pro · Luna',
    modelPro2: '🌍 Pro2 · Terra',
    modelPro3: '☀️ Pro3 · Sol',
    modelAstra: '✨ Astra · GPT-6',
    modelDefault: '⚡ Базовая модель',
    back: '⬅️ Назад',
    home: '🏠 На главную',
    mainMenu: '🏠 Главное меню',
    cancelOperation: '🛑 Отменить операцию',
    operationStatus: '📊 Статус операции',
    astraChannel: '✨ Канал Astra',
    ordinaryChannel: '🔁 Обычный канал',
});

function normalizeTelegramKeyboardButton(button) {
    if (button && typeof button === 'object' && !Array.isArray(button)) {
        return { ...button, text: String(button.text ?? '').trim() };
    }
    return { text: String(button ?? '').trim() };
}

function createTelegramReplyKeyboard(rows, placeholder = '') {
    const normalizedRows = rows.map((row) => row.map(normalizeTelegramKeyboardButton));
    if (!normalizedRows.flat().some((button) => button.text === TELEGRAM_MENU_BUTTONS.hideKeyboard)) {
        normalizedRows.push([normalizeTelegramKeyboardButton(TELEGRAM_MENU_BUTTONS.hideKeyboard)]);
    }
    return {
        keyboard: normalizedRows,
        resize_keyboard: true,
        ...(placeholder
            ? { input_field_placeholder: placeholder }
            : {}),
    };
}

function getTelegramCalendarDate(now = new Date(), timeZone = TELEGRAM_PERESOZDANIE_COORDS_TIME_ZONE) {
    const date = now instanceof Date ? now : new Date(now);
    if (Number.isNaN(date.getTime())) return '';

    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const values = Object.fromEntries(
        parts
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value]),
    );

    return `${values.year}-${values.month}-${values.day}`;
}

function shouldShowTelegramCoordsButton(now = new Date()) {
    return getTelegramCalendarDate(now) === TELEGRAM_PERESOZDANIE_COORDS_DATE;
}

function shouldShowTelegramThankEventButton(now = new Date()) {
    const date = now instanceof Date ? now : new Date(now);
    return !Number.isNaN(date.getTime()) && date >= TELEGRAM_PERESOZDANIE_THANK_START && date < TELEGRAM_PERESOZDANIE_THANK_END;
}

function buildTelegramHuinglishMenu({isOwner=false}={}) {
    return createTelegramReplyKeyboard([
        ['📖 Хуинглиш · далее','📚 Хуинглиш · уроки'],
        ...(isOwner?[['🔄 Хуинглиш · сбросить']]:[]),
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu],
    ],'HuInglish — продолжить, посмотреть уроки или вернуться');
}
function buildTelegramHuinglishLessonPickerMenu({lessonIds=[]}={}) {
    const ids=[...new Set(lessonIds.map(Number))].filter(n=>Number.isInteger(n)&&n>=1&&n<=999).sort((a,b)=>a-b).slice(0,25);
    const rows=[];
    for(let i=0;i<ids.length;i+=4)rows.push(ids.slice(i,i+4).map(String));
    rows.push([TELEGRAM_MENU_BUTTONS.back,TELEGRAM_MENU_BUTTONS.mainMenu]);
    return createTelegramReplyKeyboard(rows,'Выбери номер завершённого урока');
}
let milanaMarkerModeProvider=()=>null;
export function setTelegramMilanaMarkerModeProvider(fn){milanaMarkerModeProvider=typeof fn==='function'?fn:()=>null}
function currentMilanaMarkerMode(chatId,userId){
 try{const mode=milanaMarkerModeProvider({chatId:String(chatId||''),userId:String(userId||'')});
  return mode==='active'||mode==='paused'?mode:null;
 }catch{return null}
}
// Quiz controls decorate the CURRENT reply keyboard, not the main menu.
// Otherwise a paused quiz hides nested party and image menus.
export function buildTelegramMilanaMarkerMenu({mode,isOwner=false,now=new Date(),baseMenu=null}={}){
 const base=baseMenu&&Array.isArray(baseMenu.keyboard)?baseMenu:buildTelegramMainMenu({isOwner,now});
 const button=mode==='active'?'🚪 Выйти из режима теста по словам-маркерам':
  mode==='paused'?'▶️ Продолжить тест по словам-маркерам':'';
 if(!button)return base;
 const controls=new Set(['🚪 Выйти из режима теста по словам-маркерам','▶️ Продолжить тест по словам-маркерам']);
 const rows=base.keyboard.map(row=>row.filter(item=>!controls.has(String(item?.text||'')))).filter(row=>row.length>0);
 return {...base,keyboard:[[{text:button}],...rows],
  input_field_placeholder:mode==='active'?'Ответь текстом или голосом на текущий вопрос':'Продолжи тест или выбери обычное действие'};
}
export function withTelegramMarkerMenu(replyMarkup,{mode,isOwner=false,now=new Date()}={}){
 if(!mode)return replyMarkup;
 // Inline callback buttons belong to a message. Do not replace their markup.
 if(replyMarkup&&!Array.isArray(replyMarkup.keyboard))return replyMarkup;
 return buildTelegramMilanaMarkerMenu({mode,isOwner,now,baseMenu:replyMarkup});
}

function buildTelegramMainMenu({ isOwner = false, now = new Date() } = {}) {
    const channelButton = isAstraChannelMode()
        ? TELEGRAM_MENU_BUTTONS.ordinaryChannel
        : TELEGRAM_MENU_BUTTONS.astraChannel;
    const rows = [
        [TELEGRAM_MENU_BUTTONS.parties, isOwner ? TELEGRAM_MENU_BUTTONS.addEvent : TELEGRAM_MENU_BUTTONS.proposeEvent],
        [TELEGRAM_MENU_BUTTONS.imageMenu],
        [TELEGRAM_MENU_BUTTONS.huinglish, TELEGRAM_MENU_BUTTONS.models],
        ...(isOwner ? [[TELEGRAM_MENU_BUTTONS.huinglishReset]] : []),
        [TELEGRAM_MENU_BUTTONS.help],
        [TELEGRAM_MENU_BUTTONS.contactDeveloper],
        [TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation],
        [channelButton],
    ];
    if (shouldShowTelegramCoordsButton(now)) {
        rows.push([TELEGRAM_MENU_BUTTONS.coords]);
    }

    if (shouldShowTelegramThankEventButton(now)) {
        rows.push([TELEGRAM_MENU_BUTTONS.thankEvent]);
    }


    return createTelegramReplyKeyboard(
        rows,
        'Напиши запрос или выбери действие',
    );
}

const TELEGRAM_IMAGE_MODELS = Object.freeze([
    { id: 'gpt-image-2', button: TELEGRAM_MENU_BUTTONS.imageModel2, description: 'Базовая версия семейства Image 2.' },
    { id: 'gpt-image-2.5', button: TELEGRAM_MENU_BUTTONS.imageModel25, description: 'Версия 2.5; можно выбрать отдельно от базовой версии.' },
    { id: 'gpt-image-2.5-flare', button: TELEGRAM_MENU_BUTTONS.imageModel25Flare, description: 'Вариант Flare семейства Image 2.5.' },
    { id: 'gpt-image-2.5-sunburst', button: TELEGRAM_MENU_BUTTONS.imageModel25Sunburst, description: 'Вариант Sunburst семейства Image 2.5.' },
]);

function buildTelegramImageSectionMenu() {
    return createTelegramReplyKeyboard([
        [TELEGRAM_MENU_BUTTONS.image],
        [TELEGRAM_MENU_BUTTONS.imageEdit],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home],
    ], 'Выбери создание или редактирование изображения');
}

function buildTelegramImageModelMenu({ isOwner = false } = {}) {
    const rows = [
        [TELEGRAM_MENU_BUTTONS.imageModel25],
        [TELEGRAM_MENU_BUTTONS.imageModel2],
        [TELEGRAM_MENU_BUTTONS.imageModel25Flare],
        [TELEGRAM_MENU_BUTTONS.imageModel25Sunburst],
        ...(isOwner ? [[TELEGRAM_MENU_BUTTONS.imageModelTest]] : []),
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home],
    ];
    return createTelegramReplyKeyboard(rows, 'Выбери модель или запусти тест трёх моделей.');
}

function buildTelegramImageOperationMenu(imageModel = '') {
    const model = TELEGRAM_IMAGE_MODELS.find((item) => item.id === imageModel);
    return createTelegramReplyKeyboard([
        [TELEGRAM_MENU_BUTTONS.imageGenerate, TELEGRAM_MENU_BUTTONS.imageEditMode],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home],
    ], model ? `${model.id} · выбери режим` : 'Выбери режим');
}

// Экспортируемые снимки меню оставлены для обратной совместимости тестов/импортов.
// В runtime меню строится заново для каждого входящего сообщения, поэтому кнопка
// автоматически исчезает после 22 августа по московскому времени без рестарта.
const TELEGRAM_MAIN_MENU = buildTelegramMainMenu({ isOwner: false });
const TELEGRAM_OWNER_MAIN_MENU = buildTelegramMainMenu({ isOwner: true });

function partyDisplayToggleButton(compact = false) {
    return compact ? TELEGRAM_MENU_BUTTONS.full : TELEGRAM_MENU_BUTTONS.compact;
}

function normalizeTelegramQticketsMaxPrice(value) {
    const digits = String(value ?? '').replace(/[^\d]/gu, '');
    if (!digits) return '';
    const numeric = Number(digits);
    return Number.isSafeInteger(numeric) && numeric > 0 ? String(numeric) : '';
}

function buildTelegramPartyMenu({ isOwner = false, compact = false } = {}) {
    // Держим главные разделы в верхней видимой части reply-keyboard. Telegram
    // Desktop ограничивает высоту панели и нижние одиночные ряды уходят под
    // прокрутку, из-за чего раздел второстепенных тус визуально «пропадал».
    const rows = [
        [TELEGRAM_MENU_BUTTONS.week, TELEGRAM_MENU_BUTTONS.twoWeeks],
        [TELEGRAM_MENU_BUTTONS.month, TELEGRAM_MENU_BUTTONS.allParties],
        [TELEGRAM_MENU_BUTTONS.secondaryParties],
        [TELEGRAM_MENU_BUTTONS.allPartiesUnified, TELEGRAM_MENU_BUTTONS.qtickets],
        [partyDisplayToggleButton(compact), isOwner ? TELEGRAM_MENU_BUTTONS.addEvent : TELEGRAM_MENU_BUTTONS.proposeEvent],
    ];

    if (isOwner) rows.push([TELEGRAM_MENU_BUTTONS.addSource]);
    rows.push([TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation]);
    rows.push([TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu]);
    return createTelegramReplyKeyboard(rows, compact ? 'Краткая выдача без фото' : 'Период: неделя, выходные, 2 недели или месяц вперёд');
}

const TELEGRAM_PARTY_MENU = buildTelegramPartyMenu({ isOwner: false });
const TELEGRAM_OWNER_PARTY_MENU = buildTelegramPartyMenu({ isOwner: true });

function buildTelegramQticketsMenu({ isOwner = false, maxPrice = '', compact = false } = {}) {
    const normalizedMaxPrice = normalizeTelegramQticketsMaxPrice(maxPrice);
    const numericPrice = Number(normalizedMaxPrice);
    const hasPrice = Boolean(normalizedMaxPrice);
    const rows = [
        [TELEGRAM_MENU_BUTTONS.qticketsWeek, TELEGRAM_MENU_BUTTONS.qticketsTwoWeeks],
        [TELEGRAM_MENU_BUTTONS.qticketsMonth, TELEGRAM_MENU_BUTTONS.qticketsAll],
        [TELEGRAM_MENU_BUTTONS.qticketsPriceFilter],
        [partyDisplayToggleButton(compact)],
    ];
    if (hasPrice) rows.push([TELEGRAM_MENU_BUTTONS.qticketsPriceReset]);
    if (isOwner) rows.push([TELEGRAM_MENU_BUTTONS.qticketsParser]);
    rows.push([TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation]);
    rows.push([TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu]);
    return createTelegramReplyKeyboard(
        rows,
        hasPrice
            ? `QTickets до ${numericPrice} ₽ · выбери период или напиши команду`
            : 'Без ограничения цены. Пример: qtickets тусы на ближайшие 3 дня до 500',
    );
}

const TELEGRAM_QTICKETS_MENU = buildTelegramQticketsMenu({ isOwner: false });

function buildTelegramSecondaryPartyMenu({ compact = false } = {}) {
    return createTelegramReplyKeyboard([
        [TELEGRAM_MENU_BUTTONS.secondaryWeek, TELEGRAM_MENU_BUTTONS.secondaryMonth, TELEGRAM_MENU_BUTTONS.secondaryAllParties],
        [partyDisplayToggleButton(compact)],
        [TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu],
    ], compact ? 'Краткая выдача без фото' : 'Неделя, 2 недели, месяц или все события');
}

function buildTelegramAllPartiesMenu({ compact = false } = {}) {
    return createTelegramReplyKeyboard([
        [TELEGRAM_MENU_BUTTONS.allWeek, TELEGRAM_MENU_BUTTONS.allTwoWeeks],
        [TELEGRAM_MENU_BUTTONS.allMonth, TELEGRAM_MENU_BUTTONS.allAll],
        [TELEGRAM_MENU_BUTTONS.allPartiesUnified],
        [partyDisplayToggleButton(compact)],
        [TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu],
    ], compact ? 'Краткая общая выдача без фото' : 'Выбери период всех тус');
}

function buildTelegramPrivateMenuForState(state = {}, { isOwner = false, now = new Date() } = {}) {
    const compact = state.partyDisplayMode === 'compact';
    if (state.menuPath === 'huinglish') return buildTelegramHuinglishMenu({isOwner});
    if (state.menuPath === 'huinglish-lessons') return buildTelegramHuinglishLessonPickerMenu({lessonIds:state.huinglishLessonIds||[]});
    if (state.menuPath === 'qtickets') {
        return buildTelegramQticketsMenu({ isOwner, maxPrice: state.qticketsMaxPrice, compact });
    }
    if (state.menuPath === 'secondary-parties') return buildTelegramSecondaryPartyMenu({ compact });
    if (state.menuPath === 'all-parties') return buildTelegramAllPartiesMenu({ compact });
    if (state.menuPath === 'parties') return buildTelegramPartyMenu({ isOwner, compact });
    if (state.menuPath === 'image-section') return buildTelegramImageSectionMenu();
    if (state.menuPath === 'image-models') return buildTelegramImageModelMenu({ isOwner });
    if (state.menuPath === 'image-modes') return buildTelegramImageOperationMenu(state.imageModel);
    if (state.menuPath === 'image-prompt') return TELEGRAM_ACTION_BACK_MENU;
    return buildTelegramMainMenu({ isOwner, now });
}

function telegramPartySectionHint() {
    return [
        'Тусы: выбери период кнопкой или напиши команду.',
        'Основные тусы: «тусы сегодня», «тусы завтра», «тусы эта неделя» / «тусы на эту неделю» / «тусы на этой неделе»; также можно написать «тусы на две недели вперёд», «тусы на месяц вперёд» или «все тусы».',
        'Выходные можно запросить текстом: «тусы на этих выходных».',
        'Примеры: «тусы в пятницу», «тусы 22.09.2026» (22 сентября 2026), «тусы в октябре 2026», «тусы на ближайшие три дня в Дизеле». Если указать место — Дизель, Ливерпуль или Мама Анархия — покажу события только в этом месте.',
        'Для QTickets цена не ограничена, пока не задан фильтр: «qtickets тусы за ближайшие 3 дня не дороже 500 рублей» или «qtickets выходные до 600 рублей».',
        'Добавь «кратко», чтобы убрать фото и сократить описание. Разделы: «Второстепенные тусы», «Вообще все тусы» (основные + второстепенные + QTickets) и «QTickets афиша».',
    ].join('\n');
}

function telegramPartyHintFollowUp() {
    return {
        text: telegramPartySectionHint(),
        replyMarkup: telegramPartyQuickButtons(),
    };
}

function telegramPartyQuickButtons() {
    return { inline_keyboard: [
        [{ text: TELEGRAM_MENU_BUTTONS.primaryToday, callback_data: 'party_quick:primary:today' }],
        [{ text: TELEGRAM_MENU_BUTTONS.secondaryToday, callback_data: 'party_quick:secondary:today' }],
        [{ text: TELEGRAM_MENU_BUTTONS.allToday, callback_data: 'party_quick:all:today' }],
        [{ text: TELEGRAM_MENU_BUTTONS.qticketsToday, callback_data: 'party_quick:qtickets:today' }],
        [{ text: TELEGRAM_MENU_BUTTONS.primaryTomorrow, callback_data: 'party_quick:primary:tomorrow' }],
        [{ text: TELEGRAM_MENU_BUTTONS.secondaryTomorrow, callback_data: 'party_quick:secondary:tomorrow' }],
        [{ text: TELEGRAM_MENU_BUTTONS.allTomorrow, callback_data: 'party_quick:all:tomorrow' }],
        [{ text: TELEGRAM_MENU_BUTTONS.primaryUntilWeekEnd, callback_data: 'party_quick:primary:until-week-end' }],
        [{ text: TELEGRAM_MENU_BUTTONS.allUntilWeekEnd, callback_data: 'party_quick:all:until-week-end' }],
    ] };
}

function telegramSecondaryPartyQuickButtons() {
    return { inline_keyboard: [
        [{ text: '☀️ Сегодня', callback_data: 'party_quick:secondary:today' }],
        [{ text: '🌅 Завтра', callback_data: 'party_quick:secondary:tomorrow' }],
        [{ text: '📅 На этой неделе', callback_data: 'party_quick:secondary:week' }],
        [{ text: '🗓 На две недели вперёд', callback_data: 'party_quick:secondary:two-weeks' }],
        [{ text: '📆 В этом месяце', callback_data: 'party_quick:secondary:current-month' }],
        [{ text: '♾ Все', callback_data: 'party_quick:secondary:all' }],
    ] };
}

function telegramQticketsQuickButtons() {
    return { inline_keyboard: [
        [{ text: '☀️ Сегодня', callback_data: 'party_quick:qtickets:today' }],
        [{ text: '🌅 Завтра', callback_data: 'party_quick:qtickets:tomorrow' }],
        [{ text: '📅 На этой неделе', callback_data: 'party_quick:qtickets:week' }],
        [{ text: '🗓 На две недели вперёд', callback_data: 'party_quick:qtickets:two-weeks' }],
        [{ text: '📆 В этом месяце', callback_data: 'party_quick:qtickets:current-month' }],
        [{ text: '♾ Все', callback_data: 'party_quick:qtickets:all' }],
    ] };
}

function telegramSecondaryPartySectionHint() {
    return [
        'Второстепенные тусы: выбери период кнопкой или напиши запрос.',
        'Периоды: «второстепенные тусы на этой неделе», «второстепенные тусы на две недели вперёд», «второстепенные тусы на месяц вперёд», «все второстепенные тусы». Также понимаются «эта неделя» и «на этой неделе».',
        'Выходные можно запросить текстом: «второстепенные тусы на этих выходных».',
        'Можно задать дату, диапазон, жанр или место: «второстепенные тусы 10.10», «второстепенные тусы 13-15.01», «второстепенные тусы с 13 по 15 января», «тусы второстепенные в ближайшие три дня», «второстепенные тусы на выходных рок», «второстепенные тусы в Дизеле». Указанное место ограничивает выдачу только событиями там.',
        'Добавь «кратко», чтобы убрать фото и сократить описание.',
        'Подсказка по кнопкам: сегодня/завтра, эта неделя, выходные, 2 недели, месяц или все события.',
    ].join('\n');
}

function telegramAllPartiesSectionHint() {
    return [
        'Вообще все тусы: основные + второстепенные + афиша QTickets; одинаковые события объединяются перед выдачей.',
        'Команды можно начинать с «вообще все тусы» или «все тусы»: «вообще все тусы сегодня», «вообще все тусы завтра», «вообще все тусы эта неделя» / «вообще все тусы на этой неделе», «вообще все тусы на две недели вперёд», «вообще все тусы на месяц вперёд» или просто «вообще все тусы».',
        'Выходные можно запросить текстом: «вообще все тусы на этих выходных».',
        'Примеры: «вообще все тусы в ближайшие три дня», «вообще все тусы 10.10», «вообще все тусы 13.01-15.01», «вообще все тусы с 13 по 15 января», «вообще все тусы на выходных рок», «вообще все тусы на месяц вперёд кратко», «вообще все тусы в Ливерпуле». Если указать Дизель, Ливерпуль или Мама Анархия, покажу только выбранное место.',
        '«Эта неделя» и «на этой неделе» означают один и тот же период.',
    ].join('\n');
}

function telegramQticketsSectionHint() {
    return [
        'QTickets афиша: выбери период кнопкой или напиши команду.',
        'Периоды: выходные — ближайшая пятница–воскресенье; неделя — от сегодня до воскресенья текущей календарной недели; две недели — 14 календарных дней от сегодня; месяц — от сегодня до дня перед такой же датой следующего месяца.',
        'Примеры календарных месяцев: «qtickets события в октябре», «qtickets события сентябрь октябрь ноябрь».',
        'Команды: «qtickets события на эту неделю», «qtickets события на две недели вперёд», «qtickets события на месяц вперёд», «qtickets события вообще за всё время».',
        'Фильтр цены по умолчанию выключен. Примеры: «qtickets тусы за ближайшие 3 дня не дороже 500 рублей», «qtickets выходные до 500», «qtickets события в пятницу без ограничения цены».',
        'Добавь «кратко», чтобы убрать фото и сократить описание.',
    ].join('\n');
}

const TELEGRAM_SECONDARY_PARTY_MENU = buildTelegramSecondaryPartyMenu();

const TELEGRAM_MODEL_MENU = createTelegramReplyKeyboard(
    [
        [TELEGRAM_MENU_BUTTONS.modelPro, TELEGRAM_MENU_BUTTONS.modelPro2],
        [TELEGRAM_MENU_BUTTONS.modelPro3, TELEGRAM_MENU_BUTTONS.modelAstra],
        [TELEGRAM_MENU_BUTTONS.modelDefault],
        [TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home],
    ],
    'Выбери модель для следующего запроса',
);

const TELEGRAM_ACTION_BACK_MENU = createTelegramReplyKeyboard(
    [
        [TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home],
    ],
    'Отправь данные или вернись назад',
);

const TELEGRAM_DOCUMENT_MENU = createTelegramReplyKeyboard(
    [
        [TELEGRAM_MENU_BUTTONS.documentWord, TELEGRAM_MENU_BUTTONS.documentPdf],
        [TELEGRAM_MENU_BUTTONS.documentPptx],
        [TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home],
    ],
    'Выбери формат файла',
);

function buildTelegramEventDeletionMenu(title = '') {
    const cleanTitle = String(title ?? '').trim() || 'тусу';
    return createTelegramReplyKeyboard(
        [
            [`Вернуть тусу ${cleanTitle}`],
            [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home],
        ],
        'Вернуть тусу, вернуться назад или выйти в главное меню',
    );
}

function buildTelegramEventCandidateSelectionMenu(count = 0, { action = 'delete' } = {}) {
    const total = Math.max(0, Math.min(12, Number(count) || 0));
    const verb = action === 'edit' ? 'Исправить' : 'Удалить';
    const buttons = Array.from({ length: total }, (_, index) => `${verb} ${index + 1}`);
    const rows = [];
    for (let index = 0; index < buttons.length; index += 3) rows.push(buttons.slice(index, index + 3));
    if (action === 'delete' && total > 1 && total <= 9) {
        rows.push([`Удалить ${Array.from({ length: total }, (_, index) => index + 1).join(' ')}`]);
    }
    rows.push([TELEGRAM_MENU_BUTTONS.parties, TELEGRAM_MENU_BUTTONS.mainMenu]);
    return createTelegramReplyKeyboard(
        rows,
        action === 'edit' ? 'Выбери номер тусы для исправления' : 'Выбери номер(а) тус для удаления',
    );
}

function buildTelegramEventOwnerActions({ sourceType = '', id = 0 } = {}) {
    const type = String(sourceType ?? '').trim().toLowerCase();
    const eventId = Number(id);
    if (!/^[a-z_]{2,16}$/u.test(type) || !Number.isSafeInteger(eventId) || eventId <= 0) {
        return null;
    }
    return {
        inline_keyboard: [
            [
                { text: '✏️ Изменить', callback_data: `event_edit:${type}:${eventId}` },
                { text: '🗑 Удалить', callback_data: `event_delete:${type}:${eventId}` },
            ],
            [{ text: '🚫 Удалить навсегда', callback_data: `event_delete_permanent:${type}:${eventId}` }],
        ],
    };
}

function telegramAllPartiesQuickButtons() {
    return { inline_keyboard: [
        [{ text: '🌐 Сегодня', callback_data: 'party_quick:all:today' }],
        [{ text: '🌐 Завтра', callback_data: 'party_quick:all:tomorrow' }],
        [{ text: '🌐 На этой неделе', callback_data: 'party_quick:all:week' }],
        [{ text: '🌐 На две недели вперёд', callback_data: 'party_quick:all:two-weeks' }],
        [{ text: '🌐 В этом месяце', callback_data: 'party_quick:all:current-month' }],
        [{ text: '🌐 На месяц вперёд', callback_data: 'party_quick:all:month' }],
        [{ text: '🌐 Все', callback_data: 'party_quick:all:all' }],
    ] };
}

function resolveTelegramMenuInput(value, currentState = {}, { isOwner = false, now = new Date(), hasImageAttachment = false, hasDocumentAttachment = false, botUsername = '', hasProposalDraft = false } = {}) {
    const text = String(value ?? '').trim();
    const state = {
        pendingAction: String(currentState.pendingAction ?? ''),
        pendingModel: String(currentState.pendingModel ?? ''),
        imageModel: String(currentState.imageModel ?? ''),
        menuPath: String(currentState.menuPath ?? ''),
        qticketsMaxPrice: normalizeTelegramQticketsMaxPrice(currentState.qticketsMaxPrice),
        partyDisplayMode: currentState.partyDisplayMode === 'compact' ? 'compact' : 'full',
    };
    const compact = state.partyDisplayMode === 'compact';
    const displayState = { partyDisplayMode: state.partyDisplayMode };
    const clearState = { pendingAction: '', pendingModel: '' };
    const partyClearState = { ...clearState, ...displayState };
    const mainMenu = buildTelegramMainMenu({ isOwner, now });
    const partyMenu = buildTelegramPartyMenu({ isOwner, compact });
    const qticketsMenu = buildTelegramQticketsMenu({ isOwner, maxPrice: state.qticketsMaxPrice, compact });

    if (/^(?:сбросить\s+состояние|отменить\s+отправку)$/iu.test(text)) return { type: 'command', text, state: clearState };
    if (hasProposalDraft && !['huinglish','huinglish-lessons'].includes(state.menuPath) && (text === TELEGRAM_MENU_BUTTONS.proposeEvent || text === TELEGRAM_MENU_BUTTONS.back || /^(?:назад|back)$/iu.test(text))) return { type: 'command', text: text === TELEGRAM_MENU_BUTTONS.proposeEvent ? 'предложить тусу' : 'назад', state: clearState };
    // Любой незавершённый Telegram-режим обязан иметь явный выход.
    // Это проверяется раньше image/document/proposal state, чтобы «отмена»
    // никогда не превращалась в содержимое картинки, документа или заявки.
    if (/^(?:отмена|отменить|отмени|cancel|стоп|сброс(?:ить)?(?:\s+режим)?|выйти)$/iu.test(text)) {
        if (state.pendingAction || state.pendingModel) {
            return {
                type: 'response',
                text: 'Текущее действие отменено. Главное меню.',
                replyMarkup: mainMenu,
                state: clearState,
            };
        }

        // В адаптере меню отменять уже нечего: передаём команду приложению,
        // где она очистит proposal/QR/coords/session state, если такой есть.
        return { type: 'command', text: 'отмена', state: clearState };
    }

    // A file attachment is not an instruction to manufacture a Word document.
    // Clear stale document-menu state before routing the original caption and file.
    if (hasDocumentAttachment && (state.pendingAction?.startsWith('document_') || isProjectArchiveAuditIntent(text))) {
        return { type: 'command', text, state: clearState };
    }

    if (!text) {
        if (hasImageAttachment && state.pendingAction === 'propose_event') {
            return {
                type: 'command',
                text: 'предложить информацию о тусе',
                state: clearState,
            };
        }
        if (hasImageAttachment && state.pendingAction === 'add_event' && isOwner) {
            return {
                type: 'command',
                text: 'добавить событие',
                state: clearState,
            };
        }
        if (hasImageAttachment && state.pendingAction === 'image_edit') {
            return {
                type: 'response',
                text: 'Картинка получена. Теперь напиши, что именно изменить.',
                replyMarkup: TELEGRAM_ACTION_BACK_MENU,
                state,
            };
        }
        return { type: 'pass', text, state };
    }

    if (text === TELEGRAM_MENU_BUTTONS.hideKeyboard) {
        return {
            type: 'response',
            text: 'Клавиатура скрыта. /menu — показать её снова.',
            replyMarkup: { remove_keyboard: true },
            state,
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.operationStatus) {
        return { type: 'command', text: 'процессы статус', state: clearState };
    }
    if (text === TELEGRAM_MENU_BUTTONS.cancelOperation) {
        return { type: 'command', text: 'прервать все процессы', state: clearState };
    }
    if (text === TELEGRAM_MENU_BUTTONS.astraChannel || text === TELEGRAM_MENU_BUTTONS.ordinaryChannel) {
        return {
            type: 'command',
            text: text === TELEGRAM_MENU_BUTTONS.astraChannel ? 'канал астра' : 'обычный канал',
            state: clearState,
        };
    }

    if (/^(?:\/(?:start|menu|home)(?:@[a-z0-9_]+)?|главная|главное\s+меню|домой)$/iu.test(text) || text === TELEGRAM_MENU_BUTTONS.home || text === TELEGRAM_MENU_BUTTONS.mainMenu) {
        if(['huinglish','huinglish-lessons'].includes(state.menuPath))return {type:'command',text:'хуинглиш выход',state:clearState};
        return {
            type: 'response',
            text: 'Главное меню.',
            replyMarkup: mainMenu,
            state: clearState,
        };
    }



    if (text === TELEGRAM_MENU_BUTTONS.coords) {
        return {
            type: 'command',
            text: 'корды пересоздание',
            state: clearState,
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.astraChannel) {
        return { type: 'command', text: 'канал астра', state: clearState };
    }
    if (text === TELEGRAM_MENU_BUTTONS.ordinaryChannel) {
        return { type: 'command', text: 'обычный канал', state: clearState };
    }

    if (text === TELEGRAM_MENU_BUTTONS.thankEvent) {
        if (!shouldShowTelegramThankEventButton(now)) {
            return {
                type: 'response',
                text: 'Эта кнопка станет доступна после 20:00 22 августа по московскому времени.',
                replyMarkup: mainMenu,
                state: clearState,
            };
        }
        return {
            type: 'command',
            text: 'пересоздание спасибо',
            state: clearState,
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.qtickets) {
        return {
            type: 'response',
            text: 'Раздел «QTickets афиша» открыт.',
            replyMarkup: buildTelegramQticketsMenu({ isOwner, compact }),
            followUp: { text: telegramQticketsSectionHint(), replyMarkup: telegramQticketsQuickButtons() },
            state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: '' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.imageMenu) {
        return {
            type: 'response',
            text: 'Изображения: выбери модель для создания или редактирования.',
            replyMarkup: buildTelegramImageSectionMenu(),
            state: { ...clearState, menuPath: 'image-section' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.image || text === TELEGRAM_MENU_BUTTONS.imageEdit) {
        return {
            type: 'response',
            text: [
                'Изображение: выбери модель, затем сразу отправь описание для генерации. Для редактирования приложи картинку с текстом изменений или начни текст с «измени изображение».',
                ...TELEGRAM_IMAGE_MODELS.map((model, index) => `${index + 1}. ${model.id} — ${model.description}`),
                'Алиасы в команде: image2 / image-2 / gpt-image-2; image2.5 / image-2.5 / gpt-image-2.5; flare / image25flare / gpt-image-2.5-flare; sunburst / image25sunburst / gpt-image-2.5-sunburst.',
                'Формы: «нарисуй flare петуха», «сгенерируй image2.5 ночной город», «изобрази sunburst нашу беседу», «gpt image-model=image2.5 нарисуй ...». По умолчанию используется gpt-image-2.5.',
                ...(isOwner ? ['🧪 Тест трёх моделей создаст один случайный prompt про петуха и отправит результаты по каждой модели.'] : []),
                'После выбора модели режим генерации включён по умолчанию; отдельную кнопку нажимать не нужно.',
                'Точные различия качества и цены зависят от доступности моделей у подключённого поставщика; здесь отображаются их реальные model ID.',
                'Нажми «Назад», чтобы вернуться в главное меню.',
            ].join('\n'),
            replyMarkup: buildTelegramImageModelMenu({ isOwner }),
            state: {
                ...clearState,
                // Keep the legacy image-edit state marker for callers that
                // inspect it, while the visible flow now starts with model
                // selection for both image actions.
                pendingAction: text === TELEGRAM_MENU_BUTTONS.imageEdit ? 'image_edit' : '',
                menuPath: 'image-models',
            },
        };
    }

    const imageModelByButton = new Map(TELEGRAM_IMAGE_MODELS.map((item) => [item.button, item]));
    if (imageModelByButton.has(text)) {
        const selectedImageModel = imageModelByButton.get(text);
        const editingSelected = state.pendingAction === 'image_edit' || state.imageEditMode === true;
        return {
            type: 'response',
            text: (editingSelected ? 'Редактирование: прикрепи картинку и укажи, что исправить.\n' : '') + `${selectedImageModel.id}: ${selectedImageModel.description}\nОтправь описание для генерации. Режим включён по умолчанию. Если приложишь изображение, текст будет инструкцией редактирования; без вложения начни с «измени изображение».`,
            replyMarkup: TELEGRAM_ACTION_BACK_MENU,
            state: { pendingAction: editingSelected ? 'image_edit' : 'image', pendingModel: '', imageModel: selectedImageModel.id, imageEditMode: editingSelected, menuPath: 'image-prompt' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.imageGenerate || text === TELEGRAM_MENU_BUTTONS.imageEditMode) {
        const imageModel = state.imageModel || 'gpt-image-2.5';
        const editing = text === TELEGRAM_MENU_BUTTONS.imageEditMode;
        return {
            type: 'response',
            text: editing
                ? `${imageModel} · редактирование. Пришли изображение с подписью-командой или сначала выбери эту модель, затем прикрепи изображение и напиши, что изменить.\nПримеры: «измени изображение: убери надпись», «замени фон на лес», «дорисуй свет справа».`
                : `${imageModel} · генерация. Напиши описание желаемой картинки.\nПримеры: «нарисуй концертный зал в Воронеже в стиле линогравюры», «создай картинку с ночным городом и трамваем».`,
            replyMarkup: TELEGRAM_ACTION_BACK_MENU,
            state: { pendingAction: editing ? 'image_edit' : 'image', pendingModel: '', imageModel, imageEditMode: editing, menuPath: 'image-prompt' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.imageModelTest) {
        if (!isOwner) return { type: 'response', text: 'Эта проверка доступна только владельцу.', replyMarkup: mainMenu, state: clearState };
        return { type: 'command', text: 'графика тест петух', state: clearState, replyMarkup: mainMenu };
    }

    if (text === TELEGRAM_MENU_BUTTONS.qticketsParser) {
        return {
            type: 'command',
            text: isOwner ? 'qtickets парсер' : 'qtickets события на эту неделю',
            state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: state.qticketsMaxPrice },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.qticketsPriceFilter) {
        return {
            type: 'response',
            text: 'Напиши максимальную стоимость. Можно просто «600», «до 600» или «600 рублей» — будет взято первое число из строки.',
            replyMarkup: createTelegramReplyKeyboard(
                [
                    [TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation],
                    [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu],
                ],
                'Например: 600',
            ),
            state: {
                pendingAction: 'qtickets_price_filter',
                pendingModel: '',
                menuPath: 'qtickets',
                qticketsMaxPrice: state.qticketsMaxPrice,
                ...displayState,
            },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.qticketsPriceReset) {
        return {
            type: 'response',
            text: 'Фильтр стоимости QTickets сброшен.',
            replyMarkup: buildTelegramQticketsMenu({ isOwner, compact }),
            state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: '' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.parties) {
        return {
            type: 'response',
            text: 'Раздел «Тусы» открыт.',
            replyMarkup: buildTelegramPartyMenu({ isOwner, compact }),
            followUp: telegramPartyHintFollowUp(),
            state: { ...partyClearState, menuPath: 'parties' },
        };
    }

    if (/^тусы$/iu.test(text)) {
        return {
            type: 'response',
            text: 'Раздел «Тусы» открыт.',
            replyMarkup: buildTelegramPartyMenu({ isOwner, compact }),
            followUp: telegramPartyHintFollowUp(),
            state: { ...partyClearState, menuPath: 'parties' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.secondaryParties) {
        return {
            type: 'response',
            text: 'Раздел «Второстепенные тусы» открыт.',
            replyMarkup: buildTelegramSecondaryPartyMenu({ compact }),
            followUp: { text: telegramSecondaryPartySectionHint(), replyMarkup: telegramSecondaryPartyQuickButtons() },
            state: { ...partyClearState, menuPath: 'secondary-parties' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.allPartiesUnified) {
        return {
            type: 'response',
            text: 'Раздел «Вообще все тусы» открыт.',
            replyMarkup: buildTelegramAllPartiesMenu({ compact }),
            followUp: { text: telegramAllPartiesSectionHint(), replyMarkup: telegramAllPartiesQuickButtons() },
            state: { ...partyClearState, menuPath: 'all-parties' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.compact || text === TELEGRAM_MENU_BUTTONS.full) {
        const nextCompact = text === TELEGRAM_MENU_BUTTONS.compact;
        const nextMode = nextCompact ? 'compact' : 'full';
        const nextState = { ...clearState, partyDisplayMode: nextMode };
        if (state.menuPath === 'qtickets') {
            return {
                type: 'response',
                text: nextCompact ? 'Краткая выдача QTickets: без фото, описание до 4 строк.' : 'Полная выдача QTickets.',
                replyMarkup: buildTelegramQticketsMenu({ isOwner, maxPrice: state.qticketsMaxPrice, compact: nextCompact }),
                state: { ...nextState, menuPath: 'qtickets', qticketsMaxPrice: state.qticketsMaxPrice },
            };
        }
        if (state.menuPath === 'secondary-parties') {
            return {
                type: 'response',
                text: nextCompact ? 'Краткая выдача быдлячьих тус.' : 'Полная выдача быдлячьих тус.',
                replyMarkup: buildTelegramSecondaryPartyMenu({ compact: nextCompact }),
                state: { ...nextState, menuPath: 'secondary-parties' },
            };
        }
        if (state.menuPath === 'all-parties') {
            return {
                type: 'response',
                text: nextCompact ? 'Краткая выдача вообще всех тус.' : 'Полная выдача вообще всех тус.',
                replyMarkup: buildTelegramAllPartiesMenu({ compact: nextCompact }),
                state: { ...nextState, menuPath: 'all-parties' },
            };
        }
        return {
            type: 'response',
            text: nextCompact ? 'Краткая выдача тус: без фото, описание до 4 строк.' : 'Полная выдача тус.',
            replyMarkup: buildTelegramPartyMenu({ isOwner, compact: nextCompact }),
            state: { ...nextState, menuPath: 'parties' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.addSource) {
        if (!isOwner) {
            return {
                type: 'response',
                text: 'Добавлять источники может только владелец бота.',
                replyMarkup: mainMenu,
                state: clearState,
            };
        }

        return {
            type: 'response',
            text: 'Пришли одну ссылку на публичный Telegram-канал или VK-сообщество. Можно также прислать @channel, tg:channel или vk:community. Источник сохранится и сразу запустится первый проход. Чтобы отменить, нажми «⬅️ Назад».',
            replyMarkup: TELEGRAM_ACTION_BACK_MENU,
            state: {
                pendingAction: 'add_source',
                pendingModel: '',
                menuPath: state.menuPath === 'parties' ? 'parties' : '',
            },
        };
    }

    if(state.menuPath==='huinglish-lessons'&&/^\d{1,3}$/u.test(text))
        return {type:'command',text:'хуинглиш урок '+Number(text),state:{...clearState,menuPath:'huinglish'}};
    if(text==='📖 Хуинглиш · далее')return {type:'command',text:'хуинглиш далее',state:{...clearState,menuPath:'huinglish'}};
    if(text==='📚 Хуинглиш · уроки')return {type:'command',text:'хуинглиш список',state:{...clearState,menuPath:'huinglish-lessons'}};
    if(/^хуинглиш список$/iu.test(text))return {type:'command',text:'хуинглиш список',state:{...clearState,menuPath:'huinglish-lessons'}};
    if(/^хуинглиш меню$/iu.test(text))return {type:'command',text:'хуинглиш меню',state:{...clearState,menuPath:'huinglish'}};
    if (text === TELEGRAM_MENU_BUTTONS.huinglishReset && isOwner) return {type:'command',text:'хуинглиш сбросить',state:clearState};
    if (text === TELEGRAM_MENU_BUTTONS.huinglish) return { type:'command', text:'хуинглиш меню', state:{...clearState,menuPath:'huinglish'} };
    if (text === TELEGRAM_MENU_BUTTONS.documents) {
        return {
            type: 'response',
            text: 'Что создать? Выбери Word, PDF или презентацию. После выбора напиши тему и требования — готовый файл придёт документом.',
            replyMarkup: TELEGRAM_DOCUMENT_MENU,
            state: { ...clearState, menuPath: 'documents' },
        };
    }

    const documentActions = new Map([
        [TELEGRAM_MENU_BUTTONS.documentWord, 'document_docx'],
        [TELEGRAM_MENU_BUTTONS.documentPdf, 'document_pdf'],
        [TELEGRAM_MENU_BUTTONS.documentPptx, 'document_pptx'],
    ]);
    if (documentActions.has(text)) {
        const pendingAction = documentActions.get(text);
        return {
            type: 'response',
            text: pendingAction === 'document_pptx'
                ? 'Напиши тему презентации, желаемое число слайдов и что обязательно включить.'
                : `Напиши тему, объём и требования к ${pendingAction === 'document_pdf' ? 'PDF' : 'Word'}-документу.`,
            replyMarkup: TELEGRAM_ACTION_BACK_MENU,
            state: { pendingAction, pendingModel: state.pendingModel, menuPath: 'documents' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.models) {
        return {
            type: 'response',
            text: 'Выбери продвинутую модель для следующего запроса:',
            replyMarkup: TELEGRAM_MODEL_MENU,
            state: {
                pendingAction: '',
                pendingModel: '',
                menuPath: 'models',
            },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.addEvent || text === TELEGRAM_MENU_BUTTONS.partyAddEvent) {
        if (!isOwner) {
            return {
                type: 'response',
                text: 'Добавлять события напрямую может только владелец бота. Для обычного предложения используй «➕ Предложить тусу».',
                replyMarkup: mainMenu,
                state: clearState,
            };
        }

        return {
            type: 'response',
            text: [
                'Пришли ссылку, текст анонса, афишу или всё вместе.',
                'Это режим владельца: материал считается подтверждённым событием. Бот разбирает структурные данные, текст страницы/поста, афишу и AI-факты, затем сохраняет напрямую без модерации.',
                'Для календаря всё равно нужна дата самого события; время, место, участники, цена и анонс добираются из всех доступных источников.',
                'Чтобы отменить, нажми «⬅️ Назад».',
            ].join('\n'),
            replyMarkup: TELEGRAM_ACTION_BACK_MENU,
            state: {
                pendingAction: 'add_event',
                pendingModel: '',
                menuPath: state.menuPath === 'parties' ? 'parties' : '',
            },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.proposeEvent) {
        const template = EVENT_PROPOSAL_TEMPLATE;
        return {
            type: 'response',
            text: [
                'Пришли любой из вариантов или всё вместе:',
                '1) ссылку на пост/встречу/паблик; бот откроет страницу в Chromium и объединит найденные данные;',
                '2) текст анонса;',
                '3) афишу или другое изображение;',
                '4) текст + изображение + ссылку.',
                '',
                'Шаблон для текста (можно скопировать и заполнить):',
                'Название: …',
                'Дата: …',
                'Время: …',
                'Место: …',
                'Участники: …',
                'Цена: …',
                'Описание: …',
                'Ссылка: …',
                'Контакты (необязательно): …',
                '',
                'Текст, ссылка и картинка всё равно проходят единый AI-разбор. Заявка придёт владельцу с вашим профилем/ID для ответа. Чтобы отменить, нажми «⬅️ Назад».',
            ].join('\n'),
            replyMarkup: TELEGRAM_ACTION_BACK_MENU,
            applicationCommand: 'предложить тусу',
            followUp: { text: 'Скопировать шаблон анонса:', replyMarkup: { inline_keyboard: [[{ text: '📋 Скопировать шаблон', copy_text: { text: template } }]] } },
            state: {
                pendingAction: 'propose_event',
                pendingModel: '',
                menuPath: state.menuPath === 'parties' ? 'parties' : '',
            },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.help) {
        return {
            type: 'command',
            text: 'помощь',
            state: clearState,
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.contactDeveloper) {
        return { type: 'command', text: 'написать разработчику', state: clearState };
    }

    if (text === TELEGRAM_MENU_BUTTONS.back || /^(?:назад|back)$/iu.test(text)) {
        if(state.menuPath==='huinglish-lessons')return {type:'command',text:'хуинглиш раздел',state:{...clearState,menuPath:'huinglish'}};
        if(state.menuPath==='huinglish')return {type:'command',text:'хуинглиш выход',state:clearState};
        if (state.menuPath === 'image-prompt') {
            return { type: 'response', text: 'Выбери image-модель.', replyMarkup: buildTelegramImageModelMenu({ isOwner }), state: { ...clearState, menuPath: 'image-models' } };
        }
        if (state.menuPath === 'image-modes') {
            return { type: 'response', text: 'Выбери image-модель.', replyMarkup: buildTelegramImageModelMenu(), state: { ...clearState, menuPath: 'image-models' } };
        }
        if (state.menuPath === 'image-models') {
            return { type: 'response', text: 'Изображения.', replyMarkup: buildTelegramImageSectionMenu(), state: { ...clearState, menuPath: 'image-section' } };
        }
        if (state.menuPath === 'image-section') {
            return { type: 'response', text: 'Главное меню.', replyMarkup: mainMenu, state: clearState };
        }
        if (state.menuPath === 'qtickets' && state.pendingAction === 'qtickets_price_filter') {
            return {
                type: 'response',
                text: 'QTickets афиша.',
                replyMarkup: buildTelegramQticketsMenu({ isOwner, maxPrice: state.qticketsMaxPrice, compact }),
                state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: state.qticketsMaxPrice },
            };
        }
        if (state.menuPath === 'qtickets') {
            return {
                type: 'response',
                text: telegramPartySectionHint(),
                replyMarkup: partyMenu,
                state: { ...partyClearState, menuPath: 'parties' },
            };
        }
        if (state.menuPath === 'secondary-parties' || state.menuPath === 'all-parties') {
            return {
                type: 'response',
                text: telegramPartySectionHint(),
                replyMarkup: partyMenu,
                state: { ...partyClearState, menuPath: 'parties' },
            };
        }
        if (state.menuPath === 'documents' && state.pendingAction?.startsWith('document_')) {
            return {
                type: 'response',
                text: 'Выбери формат документа.',
                replyMarkup: TELEGRAM_DOCUMENT_MENU,
                state: { ...clearState, menuPath: 'documents' },
            };
        }
        if (state.menuPath === 'parties' && state.pendingAction) {
            return {
                type: 'response',
                text: telegramPartySectionHint(),
                replyMarkup: partyMenu,
                state: { ...partyClearState, menuPath: 'parties' },
            };
        }
        return {
            type: 'response',
            text: 'Главное меню.',
            replyMarkup: mainMenu,
            state: clearState,
        };
    }

    const partyCommands = new Map([
        [TELEGRAM_MENU_BUTTONS.primaryToday, 'тусы сегодня'],
        [TELEGRAM_MENU_BUTTONS.primaryTomorrow, 'тусы завтра'],
        [TELEGRAM_MENU_BUTTONS.allToday, 'вообще все тусы сегодня'],
        [TELEGRAM_MENU_BUTTONS.allTomorrow, 'вообще все тусы завтра'],
        [TELEGRAM_MENU_BUTTONS.week, 'тусы на этой неделе'],
        [TELEGRAM_MENU_BUTTONS.twoWeeks, 'тусы на две недели'],
        [TELEGRAM_MENU_BUTTONS.month, 'тусы на месяц вперёд'],
        [TELEGRAM_MENU_BUTTONS.allParties, 'все тусы'],
    ]);

    const allPartyCommands = new Map([
        [TELEGRAM_MENU_BUTTONS.allWeek, 'вообще все тусы на этой неделе'],
        [TELEGRAM_MENU_BUTTONS.allTwoWeeks, 'вообще все тусы на две недели'],
        [TELEGRAM_MENU_BUTTONS.allMonth, 'вообще все тусы на месяц вперёд'],
        [TELEGRAM_MENU_BUTTONS.allAll, 'вообще все тусы'],
    ]);

    if (allPartyCommands.has(text)) {
        const commandText = allPartyCommands.get(text);
        return {
            type: 'command',
            text: compact ? commandText + ' кратко' : commandText,
            state: { ...partyClearState, menuPath: 'all-parties' },
        };
    }

    if (partyCommands.has(text)) {
        const baseCommand = partyCommands.get(text);
        const commandText = state.menuPath === 'all-parties'
            ? /^(?:вообще\s+все|все\s+вообще)\s+тусы/iu.test(baseCommand)
                ? baseCommand
                : `вообще все ${baseCommand.replace(/^тусы\s*/iu, 'тусы ').replace(/^все\s+тусы$/iu, 'тусы')}`.replace(/\s+/gu, ' ').trim()
            : baseCommand;
        return {
            type: 'command',
            text: compact ? `${commandText} кратко` : commandText,
            state: { ...partyClearState, menuPath: state.menuPath === 'all-parties' ? 'all-parties' : 'parties' },
        };
    }

    const qticketsPriceSuffix = state.qticketsMaxPrice ? ` до ${state.qticketsMaxPrice}` : '';
    if (text === TELEGRAM_MENU_BUTTONS.qticketsWeek) {
        return {
            type: 'command',
            text: `qtickets события на эту неделю${qticketsPriceSuffix}${compact ? ' кратко' : ''}`,
            // A query is a completed menu action. The result message gets the
            // main keyboard so the user is not trapped in the QTickets branch.
            state: clearState,
        };
    }
    if (text === TELEGRAM_MENU_BUTTONS.qticketsTwoWeeks) {
        return {
            type: 'command',
            text: `qtickets события на две недели вперёд${qticketsPriceSuffix}${compact ? ' кратко' : ''}`,
            state: clearState,
        };
    }
    if (text === TELEGRAM_MENU_BUTTONS.qticketsMonth) {
        return {
            type: 'command',
            text: `qtickets события на месяц вперёд${qticketsPriceSuffix}${compact ? ' кратко' : ''}`,
            state: clearState,
        };
    }
    if (text === TELEGRAM_MENU_BUTTONS.qticketsAll) {
        return {
            type: 'command',
            text: `qtickets события вообще за всё время${qticketsPriceSuffix}${compact ? ' кратко' : ''}`,
            state: clearState,
        };
    }

    const secondaryPartyCommands = new Map([
        [TELEGRAM_MENU_BUTTONS.secondaryToday, 'второстепенные / быдлячьи тусы сегодня'],
        [TELEGRAM_MENU_BUTTONS.secondaryTomorrow, 'второстепенные / быдлячьи тусы завтра'],
        [TELEGRAM_MENU_BUTTONS.secondaryWeek, 'второстепенные / быдлячьи тусы на этой неделе'],
        [TELEGRAM_MENU_BUTTONS.secondaryMonth, 'второстепенные / быдлячьи тусы на месяц вперёд'],
        [TELEGRAM_MENU_BUTTONS.secondaryAllParties, 'второстепенные / быдлячьи тусы'],
    ]);
    if (secondaryPartyCommands.has(text)) {
        const commandText = secondaryPartyCommands.get(text);
        return {
            type: 'command',
            text: compact ? `${commandText} кратко` : commandText,
            state: { ...partyClearState, menuPath: 'secondary-parties' },
        };
    }

    const modelCommands = new Map([
        [TELEGRAM_MENU_BUTTONS.modelPro, 'pro'],
        [TELEGRAM_MENU_BUTTONS.modelPro2, 'pro2'],
        [TELEGRAM_MENU_BUTTONS.modelPro3, 'pro3'],
        [TELEGRAM_MENU_BUTTONS.modelAstra, 'astra'],
        [TELEGRAM_MENU_BUTTONS.modelDefault, ''],
    ]);

    if (modelCommands.has(text)) {
        const model = modelCommands.get(text);
        return {
            type: 'response',
            text: model
                ? `Выбрана модель ${model} для следующего запроса. Теперь напиши сам запрос.`
                : 'Для следующего запроса выбрана базовая модель.',
            replyMarkup: mainMenu,
            state: {
                pendingAction: state.pendingAction,
                pendingModel: model,
                menuPath: '',
            },
        };
    }

    if (state.pendingAction === 'qtickets_price_filter') {
        const price = parseQticketsBarePriceLimit(text);
        if (price === null) {
            return {
                type: 'response',
                text: 'Не нашёл число. Напиши, например: «600», «до 600» или «600 рублей».',
                replyMarkup: createTelegramReplyKeyboard(
                    [
                        [TELEGRAM_MENU_BUTTONS.operationStatus, TELEGRAM_MENU_BUTTONS.cancelOperation],
                        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu],
                    ],
                    'Например: 600',
                ),
                state,
            };
        }
        return {
            type: 'response',
            text: `Фильтр QTickets установлен: до ${price} ₽. Теперь выбери период или напиши команду.`,
            replyMarkup: buildTelegramQticketsMenu({ isOwner, maxPrice: price, compact }),
            state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: String(price) },
        };
    }

    if (
        state.menuPath === 'qtickets' &&
        (/(?:тус|событ|афиш|выходн|ближайш|следующ|дн(?:я|ей)?|недел|месяц|сегодня|завтра|цен|стоим|не\s+дороже|до\s+\d|\d{1,2}\s*(?:[.\/-]|[-–—]|по)\s*\d{1,2}|\d{1,2}[.\/-]\d{1,2}|\bс\s+\d{1,2})/iu.test(text) || TELEGRAM_NAMED_EVENT_DATE_INPUT.test(text) || /^\d{1,2}$/u.test(text))
    ) {
        const explicitPrice = parseQticketsPriceLimit(text);
        const suffix = explicitPrice === null && state.qticketsMaxPrice
            ? ` до ${state.qticketsMaxPrice}`
            : '';
        const baseText = /^(?:q[- ]?tickets|qtickets|кутикетс|кутикеты)(?:\s|$)/iu.test(text)
            ? `${text}${suffix}`
            : `qtickets ${text}${suffix}`;
        const commandText = compact && !/(?:кратк|коротк)/iu.test(baseText)
            ? `${baseText} кратко`
            : baseText;
        return {
            type: 'command',
            text: commandText,
            // Free-text QTickets requests follow the same lifecycle as the
            // period buttons: show the result with the main menu.
            state: clearState,
        };
    }
    if (state.menuPath === 'qtickets') {
        return { type: 'pass', text, state: clearState };
    }

    if (
        state.menuPath === 'parties' &&
        (/(?:тус|выходн|ближайш|следующ|дн(?:я|ей)?|недел|месяц|сегодня|завтра|понедель|вторник|сред|четверг|пятниц|суббот|воскрес|\d{1,2}\s*(?:[.\/-]|[-–—]|по)\s*\d{1,2}|\d{1,2}[.\/-]\d{1,2}|\bс\s+\d{1,2})/iu.test(text) || TELEGRAM_NAMED_EVENT_DATE_INPUT.test(text) || /^\d{1,2}$/u.test(text))
    ) {
        const baseText = /^(?:тусы|тусовки|события)\b/iu.test(text) ? text : `тусы ${text}`;
        return {
            type: 'command',
            text: compact && !/(?:кратк|коротк)/iu.test(baseText) ? `${baseText} кратко` : baseText,
            state: { ...partyClearState, menuPath: 'parties' },
        };
    }

    if (
        state.menuPath === 'all-parties' &&
        (/(?:тус|выходн|ближайш|следующ|дн(?:я|ей)?|недел|месяц|сегодня|завтра|понедель|вторник|сред|четверг|пятниц|суббот|воскрес|\d{1,2}\s*(?:[.\/-]|[-–—]|по)\s*\d{1,2}|\d{1,2}[.\/-]\d{1,2}|\bс\s+\d{1,2})/iu.test(text) || TELEGRAM_NAMED_EVENT_DATE_INPUT.test(text) || /^\d{1,2}$/u.test(text))
    ) {
        const baseText = /^(?:вообще\s+все|все\s+вообще|общие)\s+тус/iu.test(text)
            ? text
            : `вообще все тусы ${text}`;
        return {
            type: 'command',
            text: compact && !/(?:кратк|коротк)/iu.test(baseText) ? `${baseText} кратко` : baseText,
            state: { ...partyClearState, menuPath: 'all-parties' },
        };
    }

    if (
        state.menuPath === 'secondary-parties' &&
        (/(?:тус|выходн|ближайш|следующ|дн(?:я|ей)?|недел|месяц|сегодня|завтра|понедель|вторник|сред|четверг|пятниц|суббот|воскрес|\d{1,2}\s*(?:[.\/-]|[-–—]|по)\s*\d{1,2}|\d{1,2}[.\/-]\d{1,2}|\bс\s+\d{1,2})/iu.test(text) || TELEGRAM_NAMED_EVENT_DATE_INPUT.test(text) || /^\d{1,2}$/u.test(text))
    ) {
        const baseText = /(?:второстепенн|быдляч)/iu.test(text)
            ? text
            : `второстепенные / быдлячьи тусы ${text}`;
        return {
            type: 'command',
            text: compact && !/(?:кратк|коротк)/iu.test(baseText) ? `${baseText} кратко` : baseText,
            state: { ...partyClearState, menuPath: 'secondary-parties' },
        };
    }

    if (state.pendingAction === 'image_edit' || (hasImageAttachment && state.pendingAction === 'image')) {
        if (!hasImageAttachment && isExplicitTelegramNonImageCommand(text, { botUsername })) {
            return { type: 'command', text, state: clearState };
        }
        const command = `gpt image-model=${state.imageModel || 'gpt-image-2.5'} измени изображение ${text}`;
        return {
            type: 'command',
            text: command,
            state: { pendingAction: '', pendingModel: '', imageModel: '', menuPath: 'image-models' },
        };
    }

    if (state.pendingAction?.startsWith('document_')) {
        if (isExplicitTelegramNonImageCommand(text, { botUsername })) {
            return { type: 'command', text, state: clearState };
        }
        const format = state.pendingAction.slice('document_'.length);
        const prefix = format === 'pptx'
            ? 'создай презентацию pptx файлом:'
            : format === 'pdf'
                ? 'создай pdf документ файлом:'
                : 'создай word docx документ файлом:';
        const command = [state.pendingModel, prefix, text].filter(Boolean).join(' ');
        return {
            type: 'command',
            text: command,
            state: { pendingAction: state.pendingAction, pendingModel: state.pendingModel, menuPath: state.menuPath },
        };
    }

    if (state.pendingAction === 'image') {
        if (isExplicitTelegramNonImageCommand(text, { botUsername })) {
            return {
                type: 'command',
                text,
                state: clearState,
            };
        }

        const explicitEdit = /^(?:измени|изменить|редактируй|редактировать|замени|заменить|дорисуй|дорисовать|убери|удали|сделай\s+правку|поправь)(?=$|\s|:)/iu.test(text);
        const selectedImageModel = state.imageModel || 'gpt-image-2.5';
        const command = hasImageAttachment || state.imageEditMode || explicitEdit
            ? `gpt image-model=${selectedImageModel} измени изображение ${text}`
            : isDirectTelegramImageCommand(text)
                ? `gpt image-model=${selectedImageModel} ${text}`
                : `gpt image-model=${selectedImageModel} нарисуй ${text}`;

        return {
            type: 'command',
            text: command,
            state: {
                pendingAction: '',
                pendingModel: '',
                imageModel: '',
                imageEditMode: false,
                menuPath: 'image-models',
            },
        };
    }

    if (state.pendingAction || state.pendingModel) {
        // Явные команды всегда важнее незавершённого режима меню. Иначе после
        // «Предложить тусу» строка «парсер все» превращалась в текст заявки.
        if (isExplicitTelegramNonImageCommand(text, { botUsername })) {
            return {
                type: 'command',
                text,
                state: clearState,
            };
        }

        const command = state.pendingAction === 'add_event'
            ? `добавить событие ${text}`
            : state.pendingAction === 'propose_event'
                ? `предложить информацию о тусе ${text}`
                : state.pendingAction === 'add_source'
                    ? `добавить источник ${text}`
                    : [state.pendingModel, text].filter(Boolean).join(' ');

        return {
            type: 'command',
            text: command,
            state: clearState,
        };
    }

    return { type: 'pass', text, state };
}

function sleep(ms) {
    return new Promise((resolvePromise) => {
        setTimeout(resolvePromise, ms);
    });
}

function fitTelegramCaption(value, limit = TELEGRAM_CAPTION_LIMIT) {
    const source = String(value ?? '').trim();
    if (source.length <= limit) return source;

    const suffix = '…';
    const target = Math.max(1, limit - suffix.length);
    let cut = source.lastIndexOf('\n\n', target);
    if (cut < Math.floor(target * 0.6)) cut = source.lastIndexOf('\n', target);
    if (cut < Math.floor(target * 0.6)) cut = source.lastIndexOf(' ', target);
    if (cut < Math.floor(target * 0.6)) cut = target;
    return `${source.slice(0, cut).trimEnd()}${suffix}`.slice(0, limit);
}

function clampTelegramEntities(entities, textLength) {
    const max = Math.max(0, Number(textLength) || 0);
    return (Array.isArray(entities) ? entities : []).filter((entity) => {
        const offset = Number(entity?.offset);
        const length = Number(entity?.length);
        return Number.isInteger(offset) && Number.isInteger(length) && offset >= 0 && length > 0 && offset + length <= max &&
            String(entity?.type || '') === 'text_link' && /^https?:\/\//iu.test(String(entity?.url || ''));
    }).map((entity) => ({ type: 'text_link', offset: Number(entity.offset), length: Number(entity.length), url: String(entity.url) }));
}

function sliceTelegramEntities(entities, offset, length) {
    return (Array.isArray(entities) ? entities : []).filter((entity) =>
        Number(entity?.offset) >= offset && Number(entity?.offset) + Number(entity?.length) <= offset + length)
        .map((entity) => ({ ...entity, offset: Number(entity.offset) - offset }));
}

function splitTelegramText(value, limit = TELEGRAM_TEXT_LIMIT) {
    // One shared splitter for text, media captions' overflow and streaming.
    // No trimming at chunk boundaries: concatenating parts reconstructs the source.
    return splitTelegramLongReply(String(value ?? '').trim(), Math.min(3500, limit));
}

function normalizeTelegramCommandText(text, botUsername = '') {
    const source = String(text ?? '').trim();
    const username = String(botUsername ?? '')
        .replace(/^@/u, '')
        .trim();

    if (!source.startsWith('/')) {
        return source;
    }

    const match = source.match(/^\/([^\s@]+)(?:@([^\s]+))?(?:\s+([\s\S]*))?$/u);

    if (!match) {
        return source;
    }

    const target = String(match[2] ?? '').trim();

    if (
        target &&
        username &&
        target.toLowerCase() !== username.toLowerCase()
    ) {
        return '';
    }

    const command = String(match[1] ?? '').toLowerCase();
    const body = String(match[3] ?? '').trim();
    const aliases = {
        start: 'помощь',
        help: 'помощь',
        commands: 'команды',
        ping: 'пинг',
        id: 'id',
        version: 'версия',
    };
    const normalizedCommand = aliases[command] ?? command.replace(/_/gu, ' ');

    return [normalizedCommand, body].filter(Boolean).join(' ').trim();
}

function createTelegramPhotoAttachment({
    buffer = null,
    filePath = '',
    filename = '',
    mimeType = '',
} = {}) {
    if (Buffer.isBuffer(buffer) && buffer.length) {
        return {
            platform: 'telegram',
            type: 'photo',
            buffer,
            filename: filename || 'image.png',
            mimeType: mimeType || 'image/png',
        };
    }

    const cleanPath = String(filePath ?? '').trim();

    if (cleanPath && existsSync(cleanPath)) {
        return {
            platform: 'telegram',
            type: 'photo',
            filePath: cleanPath,
            filename: filename || basename(cleanPath),
            mimeType: mimeType || '',
        };
    }

    return null;
}

function isTelegramPhotoAttachment(value) {
    return Boolean(
        value &&
        typeof value === 'object' &&
        value.platform === 'telegram' &&
        value.type === 'photo' &&
        (
            (Buffer.isBuffer(value.buffer) && value.buffer.length) ||
            (value.filePath && existsSync(value.filePath))
        ),
    );
}

function readTelegramPhotoAttachment(attachment) {
    if (!isTelegramPhotoAttachment(attachment)) {
        return null;
    }

    const buffer = Buffer.isBuffer(attachment.buffer)
        ? attachment.buffer
        : readFileSync(attachment.filePath);

    return {
        buffer,
        filename:
            String(attachment.filename ?? '').trim() ||
            basename(attachment.filePath || 'image.png'),
        mimeType: String(attachment.mimeType ?? '').trim() || 'image/png',
    };
}


function createTelegramDocumentAttachment({
    buffer = null,
    filePath = '',
    filename = '',
    mimeType = 'application/octet-stream',
} = {}) {
    if (Buffer.isBuffer(buffer) && buffer.length) {
        return { platform: 'telegram', type: 'document', buffer, filename: filename || 'document.bin', mimeType };
    }
    const cleanPath = String(filePath ?? '').trim();
    if (cleanPath && existsSync(cleanPath)) {
        return { platform: 'telegram', type: 'document', filePath: cleanPath, filename: filename || basename(cleanPath), mimeType };
    }
    return null;
}

function isTelegramDocumentAttachment(value) {
    return Boolean(value && typeof value === 'object' && value.platform === 'telegram' && value.type === 'document' && ((Buffer.isBuffer(value.buffer) && value.buffer.length) || (value.filePath && existsSync(value.filePath))));
}

function readTelegramDocumentAttachment(attachment) {
    if (!isTelegramDocumentAttachment(attachment)) return null;
    const buffer = Buffer.isBuffer(attachment.buffer) ? attachment.buffer : null;
    const filePath = buffer ? '' : String(attachment.filePath ?? '').trim();
    let fileSize = Number(buffer?.length || 0);
    if (!fileSize && filePath) {
        try { fileSize = Number(statSync(filePath).size || 0); } catch {}
    }
    return {
        ...(buffer ? { buffer } : { filePath }),
        fileSize,
        filename: String(attachment.filename ?? '').trim() || basename(filePath || 'document.bin'),
        mimeType: String(attachment.mimeType ?? '').trim() || 'application/octet-stream',
    };
}

class TelegramBotApiError extends Error {
    constructor(method, body, status = 0) {
        super(
            `Telegram Bot API ${method}: ${body?.description || `HTTP ${status}`}`,
        );
        this.name = 'TelegramBotApiError';
        this.code = body?.error_code ?? status;
        this.status = status;
        this.parameters = body?.parameters ?? null;
    }
}

function waitTelegramRetry(milliseconds, signal = null) {
    if (signal?.aborted) {
        return Promise.reject(signal.reason || new Error('Telegram retry aborted.'));
    }
    return new Promise((resolve, reject) => {
        let settled = false;
        const cleanup = () => signal?.removeEventListener?.('abort', onAbort);
        const timer = setTimeout(() => {
            if (settled) return;
            settled = true;
            cleanup();
            resolve();
        }, Math.max(0, Number(milliseconds) || 0));
        timer.unref?.();
        const onAbort = () => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            cleanup();
            reject(signal?.reason || new Error('Telegram retry aborted.'));
        };
        signal?.addEventListener?.('abort', onAbort, { once: true });
    });
}

const TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS = Math.max(
    60_000,
    Math.min(6 * 60 * 60 * 1000, Number(process.env.TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS) || 4 * 60 * 60 * 1000),
);
const TELEGRAM_FILE_METADATA_TIMEOUT_MS = Math.max(
    10_000,
    Math.min(10 * 60 * 1000, Number(process.env.TELEGRAM_FILE_METADATA_TIMEOUT_MS) || 60_000),
);
const TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS = Math.max(1, Math.min(20, Number(process.env.TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS) || 12));

function combineTelegramAbortSignals(signals = []) {
    const active = (Array.isArray(signals) ? signals : []).filter(Boolean);
    if (!active.length) return null;
    if (active.length === 1) return active[0];
    if (typeof AbortSignal.any === 'function') return AbortSignal.any(active);
    const controller = new AbortController();
    const abortFrom = (signal) => {
        if (!controller.signal.aborted) controller.abort(signal?.reason);
    };
    for (const signal of active) {
        if (signal.aborted) {
            abortFrom(signal);
            break;
        }
        signal.addEventListener('abort', () => abortFrom(signal), { once: true });
    }
    return controller.signal;
}

function getTelegramDocumentRetryDelay(error, attempt) {
    const status = Number(error?.status || error?.code || 0);
    const retryAfterSeconds = Number(error?.parameters?.retry_after || 0);
    if (status === 429 && retryAfterSeconds > 0) {
        return Math.min(15 * 60 * 1000, Math.max(1_000, retryAfterSeconds * 1000));
    }
    const message = String(error?.message ?? error ?? '');
    const retryable = status === 408 || status === 409 || status === 425 || status === 429 || status >= 500 ||
        /fetch failed|network|socket|econnreset|etimedout|eai_again|terminated|temporar|integrity mismatch|response size mismatch|timeout|abort/iu.test(message);
    if (!retryable) return null;
    const schedule = [2_000, 5_000, 10_000, 20_000, 30_000, 45_000, 60_000];
    return schedule[Math.max(0, Math.min(schedule.length - 1, attempt - 1))];
}

class TelegramBotApi {
    constructor(token) {
        this.token = token;
        const apiRoot = String(process.env.TELEGRAM_BOT_API_BASE_URL || 'https://api.telegram.org')
            .trim()
            .replace(/\/+$/u, '');
        const fileRoot = String(process.env.TELEGRAM_BOT_FILE_BASE_URL || apiRoot)
            .trim()
            .replace(/\/+$/u, '');
        this.baseUrl = `${apiRoot}/bot${token}`;
        this.fileBaseUrl = fileRoot;
    }

    async call(method, payload = {}, options = {}) {
        const hasExplicitSignal = Object.prototype.hasOwnProperty.call(options, 'signal');
        const timeoutMs = Number(options.timeoutMs);
        const timeoutSignal = Number.isFinite(timeoutMs) && timeoutMs > 0
            ? AbortSignal.timeout(timeoutMs)
            : hasExplicitSignal
                ? null
                : AbortSignal.timeout(15_000);
        const signal = combineTelegramAbortSignals([
            hasExplicitSignal ? options.signal : null,
            timeoutSignal,
        ]);
        const response = await fetch(`${this.baseUrl}/${method}`, {
            method: 'POST',
            headers: options.multipart
                ? undefined
                : { 'Content-Type': 'application/json' },
            body: options.multipart
                ? payload
                : JSON.stringify(payload),
            ...(signal ? { signal } : {}),
        });
        const text = await response.text();
        let body;

        try {
            body = JSON.parse(text);
        } catch {
            throw new TelegramBotApiError(
                method,
                { description: `ответ не JSON: ${text.slice(0, 500)}` },
                response.status,
            );
        }

        if (!response.ok || !body?.ok) {
            throw new TelegramBotApiError(method, body, response.status);
        }

        return body.result;
    }

    getMe() {
        return this.call('getMe');
    }

    deleteWebhook() {
        return this.call('deleteWebhook', {
            drop_pending_updates: false,
        });
    }

    getWebhookInfo() {
        return this.call('getWebhookInfo');
    }

    getUpdates({ offset, timeout = 50 }) {
        return this.call(
            'getUpdates',
            {
                offset,
                limit: 100,
                timeout,
                allowed_updates: ['message', 'callback_query', 'message_reaction', 'message_reaction_count'],
            },
            {
                signal: AbortSignal.timeout((timeout + 15) * 1000),
            },
        );
    }


    getChat(chatId) {
        return this.call('getChat', {
            chat_id: chatId,
        });
    }

    answerCallbackQuery({ callbackQueryId, text = '', showAlert = false, url = '' } = {}) {
        return this.call('answerCallbackQuery', {
            callback_query_id: callbackQueryId,
            ...(text ? { text: String(text).slice(0, 200) } : {}),
            ...(showAlert ? { show_alert: true } : {}),
            ...(url ? { url } : {}),
        }, { timeoutMs: 3000 });
    }

    async downloadFile(fileId, { timeoutMs = 120_000 } = {}) {
        let meta;
        try {
            meta = await this.getFile(fileId, { timeoutMs });
        } catch (error) {
            const message = String(error?.message || error);
            if (/file is too big|file too large|request entity too large/iu.test(message)) {
                const wrapped = new Error(
                    'Telegram не дал скачать файл через облачный Bot API: его лимит getFile — 20 МБ. В боте нет ограничения размера. Для ZIP больше 20 МБ укажи TELEGRAM_BOT_API_BASE_URL и TELEGRAM_BOT_FILE_BASE_URL на Local Bot API Server, затем отправь архив заново.',
                );
                wrapped.code = 'TELEGRAM_CLOUD_FILE_LIMIT';
                wrapped.cause = error;
                throw wrapped;
            }
            throw error;
        }
        const filePath = String(meta?.file_path || '').trim();
        if (!filePath) throw new Error('Telegram getFile returned no file_path.');
        const response = await fetch(this.buildFileUrl(filePath), { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) throw new Error('Telegram file download failed: HTTP ' + response.status);
        return Buffer.from(await response.arrayBuffer());
    }

    getFile(fileId, { signal = undefined, timeoutMs = TELEGRAM_FILE_METADATA_TIMEOUT_MS } = {}) {
        return this.call(
            'getFile',
            { file_id: fileId },
            { ...(signal !== undefined ? { signal } : {}), timeoutMs },
        );
    }

    buildFileUrl(filePath) {
        const cleanPath = String(filePath ?? '').replace(/^\/+/, '');

        return `${this.fileBaseUrl}/file/bot${this.token}/${cleanPath}`;
    }

    sendMessage({
        chatId,
        text,
        entities = null,
        parseMode = null,
        messageThreadId = null,
        replyMarkup = null,
        replyToMessageId = null,
    }) {
        const replyParameters = buildTelegramReplyParameters(replyToMessageId);

        return this.call('sendMessage', {
            chat_id: chatId,
            text,
            ...(Array.isArray(entities) && entities.length ? { entities } : {}),
            ...(parseMode ? { parse_mode: parseMode } : {}),
            ...(messageThreadId
                ? { message_thread_id: messageThreadId }
                : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            ...(replyParameters ? { reply_parameters: replyParameters } : {}),
            link_preview_options: {
                is_disabled: false,
            },
        });
    }

    copyMessage({ chatId, fromChatId, messageId, caption = '', replyMarkup = null, replyToMessageId = null }) {
        const replyParameters = buildTelegramReplyParameters(replyToMessageId);
        return this.call('copyMessage', {
            chat_id: chatId,
            from_chat_id: fromChatId,
            message_id: messageId,
            ...(caption ? { caption } : {}),
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            ...(replyParameters ? { reply_parameters: replyParameters } : {}),
        });
    }

    editMessageText({
        chatId,
        messageId,
        text,
        replyMarkup = null,
    }) {
        return this.call('editMessageText', {
            chat_id: chatId,
            message_id: messageId,
            text,
            ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
            link_preview_options: {
                is_disabled: false,
            },
        });
    }

    deleteMessage({ chatId, messageId }) {
        return this.call('deleteMessage', {
            chat_id: chatId,
            message_id: messageId,
        });
    }

    sendChatAction({ chatId, action, messageThreadId = null }) {
        return this.call('sendChatAction', {
            chat_id: chatId,
            action,
            ...(messageThreadId
                ? { message_thread_id: messageThreadId }
                : {}),
        });
    }

    async sendVideo({chatId, video, caption = '', captionEntities = null, captionParseMode = null,
        messageThreadId = null, replyMarkup = null, replyToMessageId = null}) {
        const size = Number(video?.fileSize || video?.buffer?.length || (video?.filePath ? statSync(video.filePath).size : 0));
        if (!size || size > 50 * 1024 * 1024) throw new Error('Video exceeds Telegram upload limit or is empty');
        const form = new FormData();
        form.set('chat_id', String(chatId));
        if (caption) form.set('caption', caption);
        if (captionEntities?.length) form.set('caption_entities', JSON.stringify(captionEntities));
        if (captionParseMode) form.set('parse_mode', captionParseMode);
        if (messageThreadId) form.set('message_thread_id', String(messageThreadId));
        if (replyMarkup) form.set('reply_markup', JSON.stringify(replyMarkup));
        const reply = buildTelegramReplyParameters(replyToMessageId);
        if (reply) form.set('reply_parameters', JSON.stringify(reply));
        const blob = video.filePath ? await openAsBlob(video.filePath, {type:'video/mp4'}) : new Blob([video.buffer], {type:'video/mp4'});
        form.set('video', blob, video.filename || 'event.mp4');
        return this.call('sendVideo', form, {multipart:true, timeoutMs:TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS});
    }

    async sendPhoto({
        chatId,
        photo,
        caption = '',
        captionEntities = null,
        captionParseMode = null,
        messageThreadId = null,
        replyMarkup = null,
        replyToMessageId = null,
    }) {
        const form = new FormData();
        const replyParameters = buildTelegramReplyParameters(replyToMessageId);
        form.set('chat_id', String(chatId));

        if (messageThreadId) {
            form.set('message_thread_id', String(messageThreadId));
        }

        if (caption) {
            form.set('caption', caption);
        }
        if (Array.isArray(captionEntities) && captionEntities.length) form.set('caption_entities', JSON.stringify(captionEntities));
        if (captionParseMode) form.set('parse_mode', captionParseMode);

        if (replyMarkup) {
            form.set('reply_markup', JSON.stringify(replyMarkup));
        }

        if (replyParameters) {
            form.set('reply_parameters', JSON.stringify(replyParameters));
        }

        form.set(
            'photo',
            new Blob([photo.buffer], {
                type: photo.mimeType || 'image/png',
            }),
            photo.filename || 'image.png',
        );

        return this.call('sendPhoto', form, {
            multipart: true,
        });
    }

    async sendMediaGroup({
        chatId,
        photos,
        caption = '',
        captionEntities = null,
        captionParseMode = null,
        messageThreadId = null,
        replyToMessageId = null,
    }) {
        const safePhotos = (Array.isArray(photos) ? photos : [])
            .map((photo) => readTelegramPhotoAttachment(photo))
            .filter(Boolean)
            .slice(0, 10);
        if (safePhotos.length < 2) {
            throw new Error('sendMediaGroup requires at least two photos');
        }
        const form = new FormData();
        const replyParameters = buildTelegramReplyParameters(replyToMessageId);
        form.set('chat_id', String(chatId));
        if (messageThreadId) form.set('message_thread_id', String(messageThreadId));
        if (replyParameters) form.set('reply_parameters', JSON.stringify(replyParameters));

        const media = safePhotos.map((photo, index) => {
            const field = `media_${index}`;
            form.append(
                field,
                new Blob([photo.buffer], { type: photo.mimeType || 'image/jpeg' }),
                photo.filename || `image-${index + 1}.jpg`,
            );
            return {
                type: 'photo',
                media: `attach://${field}`,
                ...(index === 0 && caption ? { caption: captionParseMode === 'HTML' ? caption : fitTelegramCaption(caption) } : {}),
                ...(index === 0 && captionEntities?.length && captionParseMode !== 'HTML' ? { caption_entities: clampTelegramEntities(captionEntities, fitTelegramCaption(caption).length) } : {}),
                ...(index === 0 && captionParseMode ? { parse_mode: captionParseMode } : {}),
            };
        });
        form.set('media', JSON.stringify(media));
        return this.call('sendMediaGroup', form, { multipart: true });
    }

    async sendDocument({
        chatId,
        document,
        caption = '',
        captionEntities = null,
        captionParseMode = null,
        messageThreadId = null,
        replyMarkup = null,
        replyToMessageId = null,
        signal = null,
    }) {
        const buildForm = async () => {
            const form = new FormData();
            const replyParameters = buildTelegramReplyParameters(replyToMessageId);
            form.set('chat_id', String(chatId));

            if (messageThreadId) form.set('message_thread_id', String(messageThreadId));
            if (caption) form.set('caption', caption);
            if (Array.isArray(captionEntities) && captionEntities.length) form.set('caption_entities', JSON.stringify(clampTelegramEntities(captionEntities, caption.length)));
            if (captionParseMode) form.set('parse_mode', captionParseMode);
            if (replyMarkup) form.set('reply_markup', JSON.stringify(replyMarkup));
            if (replyParameters) form.set('reply_parameters', JSON.stringify(replyParameters));

            const mimeType = document.mimeType || 'application/octet-stream';
            let blob;
            if (document.filePath) {
                blob = await openAsBlob(document.filePath, { type: mimeType });
            } else if (Buffer.isBuffer(document.buffer) && document.buffer.length) {
                blob = new Blob([document.buffer], { type: mimeType });
            } else {
                throw new Error('Telegram document has no buffer or filePath.');
            }
            form.set('document', blob, document.filename || basename(document.filePath || 'document.bin'));
            return form;
        };

        let lastError = null;
        const expectedBytes = Number(document?.fileSize || document?.buffer?.length || (document?.filePath ? statSync(document.filePath).size : 0));
        for (let attempt = 1; attempt <= TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS; attempt += 1) {
            try {
                const form = await buildForm();
                const result = await this.call('sendDocument', form, {
                    multipart: true,
                    ...(signal ? { signal } : {}),
                    timeoutMs: TELEGRAM_DOCUMENT_SEND_TIMEOUT_MS,
                });
                const reportedBytes = Number(result?.document?.file_size || 0);
                if (expectedBytes > 0 && reportedBytes > 0 && expectedBytes !== reportedBytes) {
                    const integrityError = new Error(
                        `Telegram document response size mismatch: local=${expectedBytes}, telegram=${reportedBytes}.`,
                    );
                    integrityError.status = 502;
                    throw integrityError;
                }
                return result;
            } catch (error) {
                lastError = error;
                const delayMs = getTelegramDocumentRetryDelay(error, attempt);
                if (attempt >= TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS || delayMs == null) throw error;
                console.warn(
                    '[TELEGRAM DOCUMENT RETRY]',
                    `attempt=${attempt}/${TELEGRAM_DOCUMENT_SEND_MAX_ATTEMPTS}`,
                    `delayMs=${delayMs}`,
                    `file=${document.filename || basename(document.filePath || 'document.bin')}`,
                    String(error?.message ?? error),
                );
                await waitTelegramRetry(delayMs, signal);
            }
        }
        throw lastError || new Error('Telegram document upload failed.');
    }
}

function createTelegramContext({
    api,
    message,
    callbackQuery = null,
    menuState = {},
    botUser,
    resolvePeerId,
    resolveUserId,
    ownerUserId = '',
}) {
    const chat = message.chat ?? {};
    const sender = message.from ?? {};
    const chatType = String(chat.type ?? 'private');
    const privateMode = chatType === 'private';
    const externalChatId = String(chat.id ?? '');
    const externalSenderId = String(sender.id ?? '');
    const isOwner = Boolean(
        ownerUserId && externalSenderId === String(ownerUserId),
    );
    const markerMode=privateMode?currentMilanaMarkerMode(externalChatId,externalSenderId):null;
    const privateReplyMenu = withTelegramMarkerMenu(
        buildTelegramPrivateMenuForState(menuState,{isOwner,now:new Date()}),
        {mode:markerMode,isOwner,now:new Date()},
    );
        const peerId = resolvePeerId({
        chatId: externalChatId,
        chatType,
    });
    const senderId = resolveUserId({
        userId: externalSenderId,
    });
    const rawText = String(message.text ?? message.caption ?? '').trim();
    const text = normalizeTelegramCommandText(
        rawText,
        botUser.username,
    );
    const threadId = Number(message.message_thread_id ?? 0) || null;
    const incomingMessageId = Number(message.message_id ?? 0) || null;
    let durableIntakeResolved = false;
    let durableIntakeResolve = null;
    const durableIntakePromise = new Promise((resolveDurable) => {
        durableIntakeResolve = resolveDurable;
    });
    let messagePersistenceResolved = false;
    let messagePersistenceResolve = null;
    const messagePersistencePromise = new Promise((resolvePersistence) => {
        messagePersistenceResolve = resolvePersistence;
    });

    const context = {
        platform: 'telegram',
        externalPeerId: externalChatId,
        externalSenderId,
        externalSenderUsername: String(sender.username ?? '').trim(),
        externalSenderName: [String(sender.first_name ?? '').trim(), String(sender.last_name ?? '').trim()].filter(Boolean).join(' '),
        telegramChatType: chatType,
        telegramBotUsername: botUser.username || '',
        telegramMessageThreadId: threadId,
        peerId,
        senderId,
        conversationMessageId: incomingMessageId,
        sourceMessageId: Number(message.reply_to_message?.message_id || incomingMessageId) || null,
        sourceChatId: externalChatId,
        sourceFileId: String(message.document?.file_id || message.photo?.at(-1)?.file_id || message.video?.file_id || message.audio?.file_id || message.voice?.file_id || message.reply_to_message?.document?.file_id || message.reply_to_message?.photo?.at(-1)?.file_id || message.reply_to_message?.video?.file_id || message.reply_to_message?.audio?.file_id || message.reply_to_message?.voice?.file_id || ''),
        sourceFileName: String(message.document?.file_name || message.reply_to_message?.document?.file_name || ''),
        sourceMimeType: String(message.document?.mime_type || message.reply_to_message?.document?.mime_type || ''),
        hasAttachment: Boolean(message.photo?.length || message.document?.file_id || message.video?.file_id || message.audio?.file_id || message.voice?.file_id || message.reply_to_message?.photo?.length || message.reply_to_message?.document?.file_id || message.reply_to_message?.video?.file_id || message.reply_to_message?.audio?.file_id || message.reply_to_message?.voice?.file_id),
        async downloadSourceAttachment() {
            if (!context.sourceFileId || typeof api.downloadFile !== 'function') return null;
            const buffer = await api.downloadFile(context.sourceFileId);
            return { buffer, filename: context.sourceFileName || 'attachment.bin', mimeType: context.sourceMimeType || 'application/octet-stream' };
        },
        createdAt: Number(message.date ?? Math.floor(Date.now() / 1000)),
        isChat: !privateMode,
        isDM: privateMode,
        isOutbox: false,
        text,
        originalText: rawText,
        callbackQuery: callbackQuery || null,
        message: {
            ...message,
            reply_message: message.reply_to_message
                ? {
                    ...message.reply_to_message,
                    conversation_message_id:
                        message.reply_to_message.message_id,
                }
                : undefined,
        },
        replyMessage: message.reply_to_message
            ? {
                conversationMessageId:
                    Number(message.reply_to_message.message_id ?? 0),
                senderId: message.reply_to_message.from?.id
                    ? resolveUserId({
                        userId: String(message.reply_to_message.from.id),
                    })
                    : 0,
                text: String(
                    message.reply_to_message.text ??
                    message.reply_to_message.caption ??
                    '',
                ),
                isBot: Boolean(message.reply_to_message.from?.is_bot),
            }
            : null,
        repliesToBot: Boolean(
            message.reply_to_message?.from?.id &&
            Number(message.reply_to_message.from.id) === Number(botUser.id),
        ),
        async send(payload) {
            const objectPayload = payload && typeof payload === 'object'
                ? payload
                : { message: String(payload ?? '') };
            const messageText = String(
                objectPayload.message ?? objectPayload.text ?? '',
            ).trim();
            const messageEntities = Array.isArray(objectPayload.entities) ? objectPayload.entities : [];
            const messageHtml = typeof objectPayload.html === 'string' ? objectPayload.html : '';
            const captionHtml = typeof objectPayload.htmlCaption === 'string' ? objectPayload.htmlCaption : messageHtml;
            const attachment = objectPayload.attachment;
            const photo = readTelegramPhotoAttachment(attachment);
            const video = attachment?.platform === 'telegram' && attachment?.type === 'video'
                ? readTelegramDocumentAttachment({...attachment, type:'document'}) : null;
            const document = readTelegramDocumentAttachment(attachment);
            const mediaGroupPhotos = Boolean(objectPayload.mediaGroup)
                ? (Array.isArray(objectPayload.attachments) ? objectPayload.attachments : [])
                    .filter(isTelegramPhotoAttachment)
                    .slice(0, 10)
                : [];
            const replyMarkup = objectPayload.replyMarkup ?? (
                privateMode ? privateReplyMenu : null
            );
            const hasExplicitInlineMarkup = Array.isArray(objectPayload.replyMarkup?.inline_keyboard);
            const explicitReplyMessageId = Number(
                objectPayload.replyToConversationMessageId ??
                objectPayload.replyToMessageId ??
                0,
            );
            const replyMessageId = Number.isSafeInteger(explicitReplyMessageId) &&
                explicitReplyMessageId > 0
                ? explicitReplyMessageId
                : incomingMessageId;
            let lastSent = null;
            // When Telegram cannot fit the full card into a photo caption, the
            // text is sent as a normal message.  Keep the media message id so
            // that the text is visibly attached to the photo instead of
            // appearing as an unrelated second card.
            let mediaAnchorMessageId = null;
            const captionHtmlFits = Boolean(captionHtml && (captionHtml === messageHtml ? messageText.length : String(captionHtml).replace(/<[^>]*>/gu, '').replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[\da-f]+);/giu, 'x').length) <= TELEGRAM_CAPTION_LIMIT);

            if (mediaGroupPhotos.length >= 2) {
                const fullCardAfterAlbum = Boolean(messageHtml && messageText.length > TELEGRAM_CAPTION_LIMIT);
                const albumUsesHtml = captionHtmlFits && (
                    messageText.length <= TELEGRAM_CAPTION_LIMIT || captionHtml !== messageHtml
                );
                const albumCaption = albumUsesHtml
                    ? captionHtml
                    : messageText.length <= TELEGRAM_CAPTION_LIMIT
                        ? messageText
                        : fitTelegramCaption(messageText);
                try {
                    await api.sendChatAction({
                        chatId: externalChatId,
                        action: 'upload_photo',
                        messageThreadId: threadId,
                    });
                } catch {}
                lastSent = await api.sendMediaGroup({
                    chatId: externalChatId,
                    photos: mediaGroupPhotos,
                    caption: albumCaption,
                    captionEntities: albumUsesHtml
                        ? []
                        : clampTelegramEntities(messageEntities, albumCaption.length),
                    ...(albumUsesHtml
                        ? { captionParseMode: 'HTML' }
                        : {}),
                    messageThreadId: threadId,
                    replyToMessageId: replyMessageId,
                });
                mediaAnchorMessageId = Number(
                    (Array.isArray(lastSent) ? lastSent[0] : lastSent)?.message_id ?? 0,
                ) || null;
                // Telegram does not accept reply_markup in sendMediaGroup.
                // Keep the album intact and send a tiny action row immediately
                // after it when the caller supplied owner controls.
                if (fullCardAfterAlbum) {
                    lastSent = await api.sendMessage({
                        chatId: externalChatId, text: messageHtml, parseMode: 'HTML',
                        messageThreadId: threadId, replyMarkup,
                        replyToMessageId: mediaAnchorMessageId || replyMessageId,
                    });
                } else if (hasExplicitInlineMarkup) {
                    lastSent = await api.sendMessage({
                        chatId: externalChatId,
                        text: '⚙️ Действия карточки',
                        messageThreadId: threadId,
                        replyMarkup,
                        replyToMessageId: replyMessageId,
                    });
                }
                // Long event cards are sent intact after the album: captions
                // have a smaller limit than normal Telegram messages.
            } else if (photo || video) {
                try {
                    await api.sendChatAction({
                        chatId: externalChatId,
                        action: video ? 'upload_video' : 'upload_photo',
                        messageThreadId: threadId,
                    });
                } catch {
                    // Статус набора не обязателен для основной отправки.
                }

                // Large cards fit a text message, but not a photo caption.
                const singleMediaMessage = Boolean(objectPayload.singleMediaMessage);
                const caption = singleMediaMessage
                    ? fitTelegramCaption(messageText)
                    : messageText.length <= TELEGRAM_CAPTION_LIMIT
                        ? messageText
                        : fitTelegramCaption(messageText);
                const captionEntities = caption ? clampTelegramEntities(messageEntities, caption.length) : [];
                const useHtmlCaption = captionHtmlFits && (
                    messageText.length <= TELEGRAM_CAPTION_LIMIT || captionHtml !== messageHtml
                );
                const outgoingCaption = caption ? (useHtmlCaption ? captionHtml : caption) : '';

                if (video) {
                    lastSent = await api.sendVideo({
                        chatId: externalChatId, video, caption: outgoingCaption,
                        captionEntities: useHtmlCaption ? [] : captionEntities,
                        ...(useHtmlCaption ? {captionParseMode:'HTML'} : {}),
                        messageThreadId: threadId, replyMarkup, replyToMessageId: replyMessageId,
                    });
                } else if (photo.buffer.length <= TELEGRAM_PHOTO_LIMIT_BYTES) {
                    lastSent = await api.sendPhoto({
                        chatId: externalChatId,
                        photo,
                        caption: outgoingCaption,
                        captionEntities: useHtmlCaption ? [] : captionEntities,
                        ...(useHtmlCaption ? { captionParseMode: 'HTML' } : {}),
                        messageThreadId: threadId,
                        replyMarkup: replyMarkup,
                        replyToMessageId: replyMessageId,
                    });
                } else {
                    lastSent = await api.sendDocument({
                        chatId: externalChatId,
                        document: photo,
                        caption: outgoingCaption,
                        captionEntities: useHtmlCaption ? [] : captionEntities,
                        ...(useHtmlCaption ? { captionParseMode: 'HTML' } : {}),
                        messageThreadId: threadId,
                        replyMarkup,
                        replyToMessageId: replyMessageId,
                    });
                }
                mediaAnchorMessageId = Number(lastSent?.message_id ?? 0) || null;

                // A photo caption is limited to 1024 characters, while the
                // event card itself may use the full text-message limit.  An
                // event card carries the complete HTML in messageHtml, so it
                // must be emitted as a follow-up reply to the photo even when
                // singleMediaMessage was requested.  Image-only sends have no
                // HTML body and therefore stay a single media message.
                if (messageText && messageText.length > TELEGRAM_CAPTION_LIMIT && messageHtml) {
                    if (messageHtml && messageText.length <= TELEGRAM_TEXT_LIMIT) {
                        lastSent = await api.sendMessage({
                            chatId: externalChatId, text: messageHtml, parseMode: 'HTML',
                            messageThreadId: threadId, replyMarkup,
                            replyToMessageId: mediaAnchorMessageId || replyMessageId,
                        });
                        return { conversationMessageId: Number(lastSent?.message_id ?? 0) || null, telegramMessage: lastSent };
                    }
                    let offset = 0;
                    for (const chunk of splitTelegramText(messageText)) {
                        const entities = sliceTelegramEntities(messageEntities, offset, chunk.length);
                        lastSent = await api.sendMessage({
                            chatId: externalChatId,
                            text: chunk,
                            ...(entities.length ? { entities } : {}),
                            messageThreadId: threadId,
                            replyMarkup,
                            replyToMessageId: mediaAnchorMessageId || replyMessageId,
                        });
                        offset += chunk.length;
                    }
                }
            } else if (document) {
                try {
                    await api.sendChatAction({
                        chatId: externalChatId,
                        action: 'upload_document',
                        messageThreadId: threadId,
                    });
                } catch {}
                lastSent = await api.sendDocument({
                    chatId: externalChatId,
                    document,
                    caption: messageText.length <= TELEGRAM_CAPTION_LIMIT ? (captionHtml || messageText) : '',
                    captionEntities: messageText.length <= TELEGRAM_CAPTION_LIMIT ? clampTelegramEntities(messageEntities, messageText.length) : [],
                    ...(captionHtml && messageText.length <= TELEGRAM_CAPTION_LIMIT ? { captionParseMode: 'HTML', captionEntities: [] } : {}),
                    messageThreadId: threadId,
                    replyMarkup,
                    replyToMessageId: replyMessageId,
                });
                if (messageText.length > TELEGRAM_CAPTION_LIMIT) {
                    if (messageHtml && messageText.length <= TELEGRAM_TEXT_LIMIT) {
                        lastSent = await api.sendMessage({
                            chatId: externalChatId, text: messageHtml, parseMode: 'HTML',
                            messageThreadId: threadId, replyMarkup, replyToMessageId: replyMessageId,
                        });
                        return { conversationMessageId: Number(lastSent?.message_id ?? 0) || null, telegramMessage: lastSent };
                    }
                    let offset = 0;
                    for (const chunk of splitTelegramText(messageText)) {
                        const entities = sliceTelegramEntities(messageEntities, offset, chunk.length);
                        lastSent = await api.sendMessage({
                            chatId: externalChatId,
                            text: chunk,
                            ...(entities.length ? { entities } : {}),
                            messageThreadId: threadId,
                            replyMarkup,
                            replyToMessageId: replyMessageId,
                        });
                        offset += chunk.length;
                    }
                }
            } else if (messageText) {
                try {
                    await api.sendChatAction({
                        chatId: externalChatId,
                        action: 'typing',
                        messageThreadId: threadId,
                    });
                } catch {
                    // Статус набора не обязателен для основной отправки.
                }

                if (messageHtml && messageText.length <= TELEGRAM_TEXT_LIMIT) {
                    lastSent = await api.sendMessage({
                        chatId: externalChatId, text: messageHtml, parseMode: 'HTML',
                        messageThreadId: threadId, replyMarkup, replyToMessageId: replyMessageId,
                    });
                    return { conversationMessageId: Number(lastSent?.message_id ?? 0) || null, telegramMessage: lastSent };
                }

                const delivery = await sendTelegramLongReply({
                    api, chatId: externalChatId, text: messageText,
                    entities: messageEntities,
                    messageThreadId: threadId, replyMarkup, replyToMessageId: replyMessageId,
                    log(event, info) {
                        // Content-free transport logs; AI text and access tokens never logged.
                        console.info('[TELEGRAM LONG REPLY]', event,
                            `part=${info.part}/${info.total || '-'}`,
                            `chars=${info.chars ?? '-'}`,
                            `messageId=${info.messageId ?? '-'}`,
                            `sent=${info.sentParts ?? '-'}`);
                    },
                });
                lastSent = { message_id: delivery.messageIds.at(-1) };
            }

            return {
                conversationMessageId:
                    Number(lastSent?.message_id ?? 0) || null,
                telegramMessage: lastSent,
            };
        },
    };

    Object.defineProperty(context, 'markDurableIntake', {
        value(details = {}) {
            if (durableIntakeResolved) return;
            durableIntakeResolved = true;
            durableIntakeResolve?.(details);
        },
        enumerable: false,
    });
    Object.defineProperty(context, 'waitForDurableIntake', {
        value() {
            return durableIntakePromise;
        },
        enumerable: false,
    });
    Object.defineProperty(context, 'markMessagePersistence', {
        value(details = {}) {
            if (messagePersistenceResolved) return;
            messagePersistenceResolved = true;
            messagePersistenceResolve?.(details);
        },
        enumerable: false,
    });
    Object.defineProperty(context, 'waitForMessagePersistence', {
        value() {
            return messagePersistencePromise;
        },
        enumerable: false,
    });

    Object.defineProperty(context, 'telegramApi', {
        value: api,
        enumerable: false,
        configurable: false,
        writable: false,
    });
    Object.defineProperty(context, 'answerCallbackQuery', {
        value(details = {}) {
            const callbackQueryId = String(callbackQuery?.id ?? '').trim();
            if (!callbackQueryId) return Promise.resolve(null);
            return api.answerCallbackQuery({ callbackQueryId, ...details });
        },
        enumerable: false,
    });

    return context;
}

function loadOffset(path) {
    try {
        return Math.max(
            0,
            Number(JSON.parse(readFileSync(path, 'utf8'))?.offset ?? 0),
        );
    } catch {
        return 0;
    }
}

function createAsyncOffsetWriter(path, { logger = console } = {}) {
    let pendingOffset = null;
    let scheduled = false;
    let scheduledPromise = Promise.resolve();
    let writeTail = Promise.resolve();
    let sequence = 0;

    const schedule = () => {
        if (scheduled) return;
        scheduled = true;
        scheduledPromise = new Promise(resolveScheduled => setImmediate(() => {
            scheduled = false;
            const nextOffset = pendingOffset;
            pendingOffset = null;
            if (nextOffset == null) {
                resolveScheduled();
                return;
            }
            const tempPath = `${path}.tmp-${process.pid}-${++sequence}`;
            writeTail = writeTail.then(async () => {
                await mkdir(resolve(path, '..'), { recursive: true });
                await writeFile(tempPath, JSON.stringify({ offset: nextOffset }, null, 2), 'utf8');
                await rename(tempPath, path);
            }).catch(error => {
                logger.error?.('[TELEGRAM OFFSET WRITE ERROR]', {
                    path,
                    offset: nextOffset,
                    name: error?.name,
                    message: error?.message,
                });
            }).finally(() => {
                try {
                    if (pendingOffset != null) schedule();
                } catch {}
                resolveScheduled();
            });
        }));
    };

    return {
        enqueue(offset) {
            const value = Number(offset);
            if (!Number.isSafeInteger(value) || value < 0) return;
            pendingOffset = pendingOffset == null ? value : Math.max(pendingOffset, value);
            schedule();
        },
        async flush() {
            do {
                await scheduledPromise;
                if (pendingOffset != null) schedule();
                await writeTail;
            } while (scheduled || pendingOffset != null);
        },
    };
}

function createTelegramBot({
    token,
    onMessage,
    onCallbackQuery = null,
    onReaction = null,
    onMenuAction = null,
    hasProposalDraft = () => false,
    resolvePeerId,
    resolveUserId,
    ownerUserId = '',
    statePath = './data/telegram-update-offset.json',
    logger = console,
    apiOverride = null,
}) {
    const cleanToken = String(token ?? '').trim();

    if (!cleanToken) {
        return null;
    }

    const api = apiOverride || new TelegramBotApi(cleanToken);
    const absoluteStatePath = resolve(statePath);
    let offset = loadOffset(absoluteStatePath);
    let running = false;
    let botUser = null;
    let loopPromise = null;
    const dmMenuStates = new Map();
    const offsetWriter = createAsyncOffsetWriter(absoluteStatePath, { logger });
    let updateAckTail = Promise.resolve();

    async function pollLoop() {
        let retryDelay = 1000;

        while (running) {
            try {
                const updates = await api.getUpdates({
                    offset,
                    timeout: 50,
                });

                retryDelay = 1000;

                for (const update of updates) {
                    const nextOffset = Number(update.update_id ?? 0) + 1;
                    const updateTasks = [];
                    if ((update.message_reaction || update.message_reaction_count) && onReaction) {
                        updateTasks.push(Promise.resolve().then(() => onReaction(update)).catch((error) => {
                            logger.error('[TELEGRAM REACTION TASK ERROR]', {
                                name: error?.name,
                                message: error?.message,
                            });
                        }));
                    }
                    const callbackQuery = update.callback_query;
                    if (callbackQuery?.id && callbackQuery.message && !callbackQuery.from?.is_bot) {
                        const callbackMessage = callbackQuery.message;
                        if (String(callbackMessage.chat?.type ?? '') === 'private') {
                            if(!String(callbackQuery.data||'').startsWith('huinglish:')||/^huinglish:menu:no:/u.test(String(callbackQuery.data||'')))
                                dmMenuStates.delete(String(callbackMessage.chat?.id ?? ''));
                        }
                        const callbackContext = createTelegramContext({
                            api,
                            message: {
                                ...callbackMessage,
                                from: callbackQuery.from,
                                text: '',
                                caption: undefined,
                            },
                            callbackQuery,
                            menuState:dmMenuStates.get(String(callbackMessage.chat?.id??''))||{},
                            botUser,
                            resolvePeerId,
                            resolveUserId,
                            ownerUserId,
                        });
                        if (typeof onCallbackQuery === 'function') {
                            const callbackTask = Promise.resolve().then(() => onCallbackQuery(callbackContext)).catch((error) => {
                                logger.error('[TELEGRAM CALLBACK TASK ERROR]', {
                                    name: error?.name,
                                    message: error?.message,
                                });
                            });
                            updateTasks.push(callbackTask);
                        } else {
                            void callbackContext.answerCallbackQuery().catch(() => {});
                        }
                    }
                    const message = update.message;

                    const messageHasImageAttachment = Boolean(
                        message && (
                            (Array.isArray(message.photo) && message.photo.length) ||
                            (message.document?.file_id && /^image\//iu.test(String(message.document?.mime_type ?? '')))
                        )
                    );
                    const messageHasVoiceAttachment = Boolean(
                        message?.voice?.file_id
                    );
                    const messageHasModelFileAttachment = Boolean(
                        message?.document?.file_id ||
                        (Array.isArray(message?.photo) && message.photo.length)
                    );

                    if (
                        message &&
                        !message.from?.is_bot &&
                        (message.text || message.caption || messageHasImageAttachment || messageHasVoiceAttachment || messageHasModelFileAttachment)
                    ) {
                        let effectiveMessage = message;
                        let handledByMenu = false;
                        let menuStateForContext = {};

                        if (String(message.chat?.type ?? '') === 'private') {
                            const menuKey = String(message.chat?.id ?? '');
                            const rawInput = String(
                                message.text ?? message.caption ?? '',
                            ).trim();
                            const storedMenuState = dmMenuStates.get(menuKey);
                            const currentMenuState = storedMenuState &&
                                Date.now() - Number(storedMenuState.updatedAt || 0) < TELEGRAM_PENDING_MENU_TTL_MS
                                ? storedMenuState
                                : {};
                            if (storedMenuState && currentMenuState !== storedMenuState) {
                                dmMenuStates.delete(menuKey);
                            }
                            const menuResult = resolveTelegramMenuInput(
                                rawInput,
                                currentMenuState,
                                {
                                    isOwner: Boolean(
                                        ownerUserId &&
                                        String(message.from?.id ?? '') === String(ownerUserId)
                                    ),
                                    now: new Date(),
                                    hasImageAttachment: messageHasImageAttachment,
                                    hasDocumentAttachment: Boolean(message.document?.file_id),
                                    botUsername: String(botUser?.username ?? ''),
                                    hasProposalDraft: hasProposalDraft(message),
                                },
                            );
                            if (menuResult.type !== 'pass' && typeof onMenuAction === 'function') {
                                try {
                                    onMenuAction({ message, input: rawInput, menuResult });
                                } catch (error) {
                                    logger.error('[TELEGRAM MENU ACTION HOOK ERROR]', { name: error?.name, message: error?.message });
                                }
                            }
                            menuStateForContext = menuResult.state || {};

                            if (menuResult.state?.pendingAction || menuResult.state?.pendingModel || menuResult.state?.menuPath) {
                                dmMenuStates.set(menuKey, {
                                    ...menuResult.state,
                                    updatedAt: Date.now(),
                                });
                            } else {
                                dmMenuStates.delete(menuKey);
                            }

                            if (menuResult.type === 'response') {
                                // Навигационная кнопка не имеет права останавливать long polling.
                                // Даже если Telegram API зависнет до сетевого timeout, следующий update
                                // уже может быть принят и обработан параллельно.
                                const menuTask = api.sendMessage({
                                    chatId: menuKey,
                                    text: menuResult.text,
                                    replyMarkup: withTelegramMarkerMenu(
                                        menuResult.replyMarkup ?? buildTelegramPrivateMenuForState(menuResult.state,{
                                            isOwner:Boolean(ownerUserId&&String(message.from?.id??'')===String(ownerUserId)),
                                            now:new Date(),
                                        }),
                                        {mode:currentMilanaMarkerMode(menuKey,message.from?.id),
                                         isOwner:Boolean(ownerUserId&&String(message.from?.id??'')===String(ownerUserId)),
                                         now:new Date()},
                                    ),
                                                                        replyToMessageId: message.message_id,
                                }).then(async () => {
                                    if (menuResult.followUp) await api.sendMessage({ chatId: menuKey, ...menuResult.followUp });
                                }).catch((error) => {
                                    logger.error('[TELEGRAM MENU SEND ERROR]', {
                                        name: error?.name,
                                        message: error?.message,
                                    });
                                });
                                updateTasks.push(menuTask);
                                handledByMenu = !menuResult.applicationCommand;
                                if (menuResult.applicationCommand) effectiveMessage = { ...message, text: menuResult.applicationCommand, caption: undefined };
                            } else if (menuResult.type === 'command') {
                                effectiveMessage = {
                                    ...message,
                                    text: menuResult.text,
                                    caption: undefined,
                                };
                            }
                        }

                        if (!handledByMenu) {
                            const context = createTelegramContext({
                                api,
                                message: effectiveMessage,
                                menuState: menuStateForContext,
                                botUser,
                                resolvePeerId,
                                resolveUserId,
                                ownerUserId,
                            });

                            const hasImageAttachment = Boolean(
                                (Array.isArray(effectiveMessage.photo) && effectiveMessage.photo.length) ||
                                (effectiveMessage.document?.file_id && /^image\//iu.test(String(effectiveMessage.document?.mime_type ?? '')))
                            );
                            const hasVoiceAttachment = Boolean(
                                effectiveMessage?.voice?.file_id
                            );
                            const hasModelFileAttachment = Boolean(
                                effectiveMessage?.document?.file_id ||
                                (Array.isArray(effectiveMessage?.photo) && effectiveMessage.photo.length)
                            );

                            if (context.text || hasImageAttachment || hasVoiceAttachment || hasModelFileAttachment) {
                                let taskPromise;
                                try {
                                    taskPromise = Promise.resolve(onMessage(context));
                                } catch (error) {
                                    taskPromise = Promise.reject(error);
                                }
                                const documentName = String(effectiveMessage?.document?.file_name ?? '');
                                const documentMime = String(effectiveMessage?.document?.mime_type ?? '');
                                const durableZipIntake = Boolean(
                                    effectiveMessage?.document?.file_id &&
                                    (/\.zip$/iu.test(documentName) || /^(?:application\/zip|application\/x-zip-compressed)$/iu.test(documentMime))
                                );

                                if (durableZipIntake) {
                                    // A ZIP update is acknowledged durably before advancing the persisted offset.
                                    // Project-audit marks this after source.zip + state.json exist; a non-audit ZIP
                                    // marks it as soon as routing determines that the durable audit path is not used.
                                    await Promise.race([
                                        context.waitForDurableIntake(),
                                        taskPromise,
                                    ]);
                                }

                                const handledTask = taskPromise.catch((error) => {
                                    logger.error('[TELEGRAM MESSAGE TASK ERROR]', {
                                        name: error?.name,
                                        message: error?.message,
                                    });
                                }).finally(() => {
                                    if (!context.messagePersistenceRequired) {
                                        context.markMessagePersistence?.({ reason: 'handler-finished' });
                                    }
                                });
                                updateTasks.push(handledTask);
                                if (context.messagePersistenceRequired) {
                                    updateTasks.push(context.waitForMessagePersistence().then((result) => {
                                        if (result?.failed) throw new Error('Telegram message persistence failed');
                                    }));
                                }
                            }
                        }
                    }

                    offset = Math.max(offset, nextOffset);
                    const updateCompletion = Promise.all(updateTasks);
                    updateAckTail = updateAckTail
                        .then(() => updateCompletion)
                        .then(() => offsetWriter.enqueue(nextOffset));
                    void updateAckTail.catch((error) => {
                        logger.error('[TELEGRAM UPDATE ACK ERROR]', {
                            name: error?.name,
                            message: error?.message,
                        });
                        running = false;
                    });
                }
            } catch (error) {
                if (!running) {
                    break;
                }

                logger.error('[TELEGRAM POLLING ERROR]', {
                    name: error?.name,
                    message: error?.message,
                    code: error?.code ?? null,
                });
                await sleep(retryDelay);
                retryDelay = Math.min(retryDelay * 2, 30_000);
            }
        }
    }

    return {
        get username() {
            return botUser?.username || '';
        },
        get id() {
            return botUser?.id || null;
        },
        async start() {
            if (running) {
                return botUser;
            }

            botUser = await api.getMe();
            await api.deleteWebhook();
            running = true;
            loopPromise = pollLoop();

            logger.log(
                '[TELEGRAM BOT STARTED]',
                `id=${botUser.id}`,
                `username=@${botUser.username || 'без_username'}`,
                `offset=${offset}`,
            );

            return botUser;
        },
        async stop() {
            running = false;

            try {
                await Promise.race([
                    loopPromise,
                    sleep(2000),
                ]);
            } catch {
                // Остановка не должна ломать завершение процесса.
            }
            await Promise.race([updateAckTail, sleep(2000)]).catch(() => {});
            await offsetWriter.flush().catch(() => {});
        },
        api,
    };
}

export {
    TELEGRAM_CAPTION_LIMIT,
    TELEGRAM_PENDING_MENU_TTL_MS,
    TELEGRAM_MAIN_MENU,
    TELEGRAM_MENU_BUTTONS,
    TELEGRAM_MODEL_MENU,
    TELEGRAM_DOCUMENT_MENU,
    TELEGRAM_ACTION_BACK_MENU,
    TELEGRAM_OWNER_MAIN_MENU,
    TELEGRAM_OWNER_PARTY_MENU,
    TELEGRAM_PARTY_MENU,
    TELEGRAM_QTICKETS_MENU,
    TELEGRAM_TEXT_LIMIT,
    TelegramBotApi,
    buildTelegramMainMenu,
    buildTelegramHuinglishMenu,
    buildTelegramHuinglishLessonPickerMenu,
    buildTelegramPartyMenu,
    buildTelegramQticketsMenu,
    buildTelegramSecondaryPartyMenu,
    buildTelegramAllPartiesMenu,
    buildTelegramEventDeletionMenu,
    buildTelegramEventCandidateSelectionMenu,
    buildTelegramEventOwnerActions,
    createTelegramBot,
    createTelegramContext,
    createTelegramPhotoAttachment,
    createTelegramDocumentAttachment,
    fitTelegramCaption,
    isTelegramPhotoAttachment,
    isTelegramDocumentAttachment,
    isDirectTelegramImageCommand,
    isExplicitTelegramNonImageCommand,
    normalizeTelegramCommandText,
    resolveTelegramMenuInput,
    shouldShowTelegramCoordsButton,
    shouldShowTelegramThankEventButton,
    splitTelegramText,
};
