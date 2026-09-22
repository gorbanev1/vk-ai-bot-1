/**
 * Адаптер Telegram Bot API: long polling, отправка сообщений/фото, меню и преобразование Telegram update в единый контекст приложения.
 */
import {
    existsSync,
    mkdirSync,
    openAsBlob,
    readFileSync,
    statSync,
    writeFileSync,
} from 'node:fs';
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

const TELEGRAM_TEXT_LIMIT = 4096;
const TELEGRAM_CAPTION_LIMIT = 1024;
const TELEGRAM_PHOTO_LIMIT_BYTES = 10 * 1024 * 1024;
const TELEGRAM_PENDING_MENU_TTL_MS = 30 * 60 * 1000;



const TELEGRAM_DIRECT_IMAGE_COMMAND = /^(?:нарисуй|рисуй|нарисовать|рисовать|image|img|картин(?:ка|ку|ки|кой)?|изображени(?:е|я|ю|ем)?|сгенерируй\s+(?:картинку|изображение)|создай\s+(?:картинку|изображение)|сделай\s+(?:картинку|изображение))(?=$|\s)/iu;
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
    qticketsWeek: '📅 QTickets · 7 дней',
    qticketsWeekends: '🎊 QTickets · выходные 2 недели',
    qticketsPriceFilter: '💰 Установить фильтр стоимости',
    qticketsPriceReset: '🧹 Сбросить фильтр стоимости',
    coords: '📍 Корды Пересоздание',
    thankEvent: '🖤 Поблагодарить за Пересоздание',
    image: '🖼 Изображение',
    imageEdit: '🛠 Изменить изображение',
    documents: '📄 Документы',
    documentWord: '📝 Word',
    documentPdf: '📕 PDF',
    documentPptx: '📊 Презентация',
    models: '🚀 Продвинутые текстовые модели GPT',
    help: '❓ Помощь',
    proposeEvent: '➕ Предложить тусу',
    partyAddEvent: '➕ Добавить тусу',
    addEvent: '➕ Добавить тусу',
    addSource: 'Добавить источник',
    nearWeekend: '📅 Ближайшие дни',
    weekend: '🎊 Эти выходные',
    twoWeeks: '🗓 Две недели',
    month: '📆 Месяц',
    allParties: '♾ Все тусы',
    allPartiesUnified: '🌐 Вообще все тусы',
    compact: '🧾 Кратко',
    full: '🖼 Полно',
    secondaryParties: '🍺 Второстепенные тусы',
    secondaryNearWeekend: '📅 Второстепенные · ближайшие дни',
    secondaryWeekend: '🎊 Второстепенные · эти выходные',
    secondaryTwoWeeks: '🗓 Второстепенные · две недели',
    secondaryMonth: '📆 Второстепенные · месяц',
    secondaryAllParties: '♾ Второстепенные · все',
    hideKeyboard: '⌨️ Скрыть клавиатуру',
    modelPro: '🌙 Pro · Luna',
    modelPro2: '🌍 Pro2 · Terra',
    modelPro3: '☀️ Pro3 · Sol',
    modelAstra: '✨ Astra · GPT-6',
    modelDefault: '⚡ Базовая модель',
    back: '⬅️ Назад',
    home: '🏠 На главную',
    mainMenu: '🏠 Главное меню',
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

function buildTelegramMainMenu({ isOwner = false, now = new Date() } = {}) {
    const rows = [
        [TELEGRAM_MENU_BUTTONS.parties, isOwner ? TELEGRAM_MENU_BUTTONS.addEvent : TELEGRAM_MENU_BUTTONS.proposeEvent],
        [TELEGRAM_MENU_BUTTONS.image, TELEGRAM_MENU_BUTTONS.imageEdit],
        [TELEGRAM_MENU_BUTTONS.documents, TELEGRAM_MENU_BUTTONS.models],
        [TELEGRAM_MENU_BUTTONS.help],
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

// Экспортируемые снимки меню оставлены для обратной совместимости тестов/импортов.
// В runtime меню строится заново для каждого входящего сообщения, поэтому кнопка
// автоматически исчезает после 22 августа по московскому времени без рестарта.
const TELEGRAM_MAIN_MENU = buildTelegramMainMenu({ isOwner: false });
const TELEGRAM_OWNER_MAIN_MENU = buildTelegramMainMenu({ isOwner: true });

function partyDisplayToggleButton(compact = false) {
    return compact ? TELEGRAM_MENU_BUTTONS.full : TELEGRAM_MENU_BUTTONS.compact;
}

function buildTelegramPartyMenu({ isOwner = false, compact = false } = {}) {
    // Держим главные разделы в верхней видимой части reply-keyboard. Telegram
    // Desktop ограничивает высоту панели и нижние одиночные ряды уходят под
    // прокрутку, из-за чего раздел второстепенных тус визуально «пропадал».
    const rows = [
        [TELEGRAM_MENU_BUTTONS.nearWeekend, TELEGRAM_MENU_BUTTONS.weekend],
        [TELEGRAM_MENU_BUTTONS.twoWeeks, TELEGRAM_MENU_BUTTONS.month],
        [TELEGRAM_MENU_BUTTONS.allParties, TELEGRAM_MENU_BUTTONS.secondaryParties],
        [TELEGRAM_MENU_BUTTONS.allPartiesUnified, TELEGRAM_MENU_BUTTONS.qtickets],
        [partyDisplayToggleButton(compact), isOwner ? TELEGRAM_MENU_BUTTONS.addEvent : TELEGRAM_MENU_BUTTONS.proposeEvent],
    ];

    if (isOwner) rows.push([TELEGRAM_MENU_BUTTONS.addSource]);
    rows.push([TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu]);
    return createTelegramReplyKeyboard(rows, compact ? 'Краткая выдача без фото' : 'Выбери период афиши');
}

const TELEGRAM_PARTY_MENU = buildTelegramPartyMenu({ isOwner: false });
const TELEGRAM_OWNER_PARTY_MENU = buildTelegramPartyMenu({ isOwner: true });

function buildTelegramQticketsMenu({ isOwner = false, maxPrice = '', compact = false } = {}) {
    const numericPrice = Number(String(maxPrice ?? '').replace(/[^\d]/gu, ''));
    const hasPrice = Number.isFinite(numericPrice) && numericPrice >= 0 && String(maxPrice ?? '').trim() !== '';
    const rows = [
        [TELEGRAM_MENU_BUTTONS.qticketsWeek, TELEGRAM_MENU_BUTTONS.qticketsWeekends],
        [TELEGRAM_MENU_BUTTONS.qticketsPriceFilter],
        [partyDisplayToggleButton(compact)],
    ];
    if (hasPrice) rows.push([TELEGRAM_MENU_BUTTONS.qticketsPriceReset]);
    if (isOwner) rows.push([TELEGRAM_MENU_BUTTONS.qticketsParser]);
    rows.push([TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu]);
    return createTelegramReplyKeyboard(
        rows,
        hasPrice
            ? `QTickets до ${numericPrice} ₽ · выбери период или напиши команду`
            : 'Например: тусы на ближайшие 5 дней до 600',
    );
}

const TELEGRAM_QTICKETS_MENU = buildTelegramQticketsMenu({ isOwner: false });

function buildTelegramSecondaryPartyMenu({ compact = false } = {}) {
    return createTelegramReplyKeyboard([
        [TELEGRAM_MENU_BUTTONS.secondaryNearWeekend, TELEGRAM_MENU_BUTTONS.secondaryWeekend],
        [TELEGRAM_MENU_BUTTONS.secondaryTwoWeeks, TELEGRAM_MENU_BUTTONS.secondaryMonth],
        [TELEGRAM_MENU_BUTTONS.secondaryAllParties],
        [partyDisplayToggleButton(compact)],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu],
    ], compact ? 'Краткая выдача без фото' : 'Выбери период второстепенных тус');
}

function buildTelegramAllPartiesMenu({ compact = false } = {}) {
    return createTelegramReplyKeyboard([
        [TELEGRAM_MENU_BUTTONS.nearWeekend, TELEGRAM_MENU_BUTTONS.weekend],
        [TELEGRAM_MENU_BUTTONS.twoWeeks, TELEGRAM_MENU_BUTTONS.month],
        [TELEGRAM_MENU_BUTTONS.allParties],
        [partyDisplayToggleButton(compact)],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu],
    ], compact ? 'Краткая общая выдача без фото' : 'Выбери период всех тус');
}

const TELEGRAM_SECONDARY_PARTY_MENU = buildTelegramSecondaryPartyMenu();

const TELEGRAM_MODEL_MENU = createTelegramReplyKeyboard(
    [
        [TELEGRAM_MENU_BUTTONS.modelPro, TELEGRAM_MENU_BUTTONS.modelPro2],
        [TELEGRAM_MENU_BUTTONS.modelPro3, TELEGRAM_MENU_BUTTONS.modelAstra],
        [TELEGRAM_MENU_BUTTONS.modelDefault],
        [TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home],
    ],
    'Выбери модель для следующего запроса',
);

const TELEGRAM_ACTION_BACK_MENU = createTelegramReplyKeyboard(
    [[TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.home]],
    'Отправь данные или вернись назад',
);

const TELEGRAM_DOCUMENT_MENU = createTelegramReplyKeyboard(
    [
        [TELEGRAM_MENU_BUTTONS.documentWord, TELEGRAM_MENU_BUTTONS.documentPdf],
        [TELEGRAM_MENU_BUTTONS.documentPptx],
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

function resolveTelegramMenuInput(value, currentState = {}, { isOwner = false, now = new Date(), hasImageAttachment = false, hasDocumentAttachment = false, botUsername = '' } = {}) {
    const text = String(value ?? '').trim();
    const state = {
        pendingAction: String(currentState.pendingAction ?? ''),
        pendingModel: String(currentState.pendingModel ?? ''),
        menuPath: String(currentState.menuPath ?? ''),
        qticketsMaxPrice: String(currentState.qticketsMaxPrice ?? '').replace(/[^\d]/gu, ''),
        partyDisplayMode: currentState.partyDisplayMode === 'compact' ? 'compact' : 'full',
    };
    const compact = state.partyDisplayMode === 'compact';
    const displayState = { partyDisplayMode: state.partyDisplayMode };
    const clearState = { pendingAction: '', pendingModel: '' };
    const partyClearState = { ...clearState, ...displayState };
    const mainMenu = buildTelegramMainMenu({ isOwner, now });
    const partyMenu = buildTelegramPartyMenu({ isOwner, compact });
    const qticketsMenu = buildTelegramQticketsMenu({ isOwner, maxPrice: state.qticketsMaxPrice, compact });

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

    if (/^(?:\/(?:start|menu|home)(?:@[a-z0-9_]+)?|главная|главное\s+меню|домой)$/iu.test(text) || text === TELEGRAM_MENU_BUTTONS.home || text === TELEGRAM_MENU_BUTTONS.mainMenu) {
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
            text: [
                'QTickets афиша.',
                'По умолчанию — ближайшие 7 дней. «Выходные» показывает только пятницу–воскресенье в окне ближайших 14 дней.',
                'Можно написать: «тусы на ближайшие 5 дней по цене до 600 рублей». Слова «руб/рублей» необязательны.',
            ].join('\n'),
            replyMarkup: buildTelegramQticketsMenu({ isOwner, compact }),
            state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: '' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.qticketsParser) {
        return {
            type: 'command',
            text: isOwner ? 'qtickets парсер' : 'qtickets события на ближайшие 7 дней',
            state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: state.qticketsMaxPrice },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.qticketsPriceFilter) {
        return {
            type: 'response',
            text: 'Напиши максимальную стоимость. Можно просто «600», «до 600» или «600 рублей» — будет взято первое число из строки.',
            replyMarkup: createTelegramReplyKeyboard(
                [[TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu]],
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
            text: [
                'Тусы: выбери период кнопкой или напиши команду.',
                'Примеры: «тусы сегодня», «тусы завтра», «тусы в пятницу», «тусы на этих выходных».',
                'Периоды: «тусы на неделю», «тусы на две недели», «тусы на месяц», «все тусы».',
                'Даты: «тусы 22.09», «22.09.2026», «22 сентября», «22 сентября 2026».',
                'Месяцы: «тусы в сентябре», «тусы сентябрь 2026»; падеж месяца не важен.',
                'Разделы: «быдлячьи тусы», «вообще все тусы», «QTickets».',
                'Цена QTickets: «тусы на 5 дней до 600», «до 600 руб», «до 600 рублей».',
                'Добавь «кратко»/«коротко» или нажми «Кратко»: без фото, описание максимум 4 строки.',
            ].join('\n'),
            replyMarkup: partyMenu,
            state: { ...partyClearState, menuPath: 'parties' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.secondaryParties) {
        return {
            type: 'response',
            text: 'За какой период показать второстепенные / быдлячьи тусы?',
            replyMarkup: buildTelegramSecondaryPartyMenu({ compact }),
            state: { ...partyClearState, menuPath: 'secondary-parties' },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.allPartiesUnified) {
        return {
            type: 'response',
            text: [
                'Вообще все тусы: обычные + быдлячьи + QTickets.',
                'Перед выдачей выполняется realtime-дедуп. При дубле карточка QTickets имеет приоритет.',
            ].join('\n'),
            replyMarkup: buildTelegramAllPartiesMenu({ compact }),
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

    if (text === TELEGRAM_MENU_BUTTONS.image) {
        return {
            type: 'response',
            text: 'Режим создания изображений включён. Просто опишите, что нарисовать. Нажмите «⬅️ Назад» или «🏠 На главную», чтобы выйти из режима.',
            replyMarkup: TELEGRAM_ACTION_BACK_MENU,
            state: {
                pendingAction: 'image',
                pendingModel: state.pendingModel,
                menuPath: '',
            },
        };
    }

    if (text === TELEGRAM_MENU_BUTTONS.imageEdit) {
        return {
            type: 'response',
            text: 'Прикрепи изображение к сообщению и напиши, что хочешь изменить. Можно также ответить на сообщение с картинкой. Меню продолжит работать, пока изображение обрабатывается.',
            replyMarkup: TELEGRAM_ACTION_BACK_MENU,
            state: {
                pendingAction: 'image_edit',
                pendingModel: state.pendingModel,
                menuPath: '',
            },
        };
    }

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
        return {
            type: 'response',
            text: 'Пришли ссылку на пост/встречу или просто информацию о тусе, которую хочешь предложить. Чтобы отменить, нажми «⬅️ Назад».',
            replyMarkup: TELEGRAM_ACTION_BACK_MENU,
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

    if (text === TELEGRAM_MENU_BUTTONS.back || /^(?:назад|back)$/iu.test(text)) {
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
                text: 'Тусы.',
                replyMarkup: partyMenu,
                state: { ...partyClearState, menuPath: 'parties' },
            };
        }
        if (state.menuPath === 'secondary-parties' || state.menuPath === 'all-parties') {
            return {
                type: 'response',
                text: 'Тусы.',
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
                text: 'Тусы.',
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
        [TELEGRAM_MENU_BUTTONS.nearWeekend, 'тусы ближайшие дни'],
        [TELEGRAM_MENU_BUTTONS.weekend, 'тусы на этих выходных'],
        [TELEGRAM_MENU_BUTTONS.twoWeeks, 'тусы на две недели'],
        [TELEGRAM_MENU_BUTTONS.month, 'тусы на месяц'],
        [TELEGRAM_MENU_BUTTONS.allParties, 'все тусы'],
    ]);

    if (partyCommands.has(text)) {
        const baseCommand = partyCommands.get(text);
        const commandText = state.menuPath === 'all-parties'
            ? `вообще все ${baseCommand.replace(/^тусы\s*/iu, 'тусы ').replace(/^все\s+тусы$/iu, 'тусы')}`.replace(/\s+/gu, ' ').trim()
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
            text: `qtickets события на ближайшие 7 дней${qticketsPriceSuffix}${compact ? ' кратко' : ''}`,
            state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: state.qticketsMaxPrice },
        };
    }
    if (text === TELEGRAM_MENU_BUTTONS.qticketsWeekends) {
        return {
            type: 'command',
            text: `qtickets события выходные на ближайшие 14 дней${qticketsPriceSuffix}${compact ? ' кратко' : ''}`,
            state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: state.qticketsMaxPrice },
        };
    }

    const secondaryPartyCommands = new Map([
        [TELEGRAM_MENU_BUTTONS.secondaryNearWeekend, 'второстепенные / быдлячьи тусы ближайшие дни'],
        [TELEGRAM_MENU_BUTTONS.secondaryWeekend, 'второстепенные / быдлячьи тусы на этих выходных'],
        [TELEGRAM_MENU_BUTTONS.secondaryTwoWeeks, 'второстепенные / быдлячьи тусы на две недели'],
        [TELEGRAM_MENU_BUTTONS.secondaryMonth, 'второстепенные / быдлячьи тусы на месяц'],
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
                    [[TELEGRAM_MENU_BUTTONS.back, TELEGRAM_MENU_BUTTONS.mainMenu]],
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
        /(?:тус|событ|афиш|выходн|ближайш|следующ|дн(?:я|ей)?|недел|месяц|сегодня|завтра|цен|стоим|не\s+дороже|до\s+\d)/iu.test(text)
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
            state: { ...partyClearState, menuPath: 'qtickets', qticketsMaxPrice: state.qticketsMaxPrice },
        };
    }

    if (
        state.menuPath === 'all-parties' &&
        /(?:тус|выходн|ближайш|следующ|дн(?:я|ей)?|недел|месяц|сегодня|завтра|понедель|вторник|сред|четверг|пятниц|суббот|воскрес)/iu.test(text)
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
        /(?:тус|выходн|ближайш|следующ|дн(?:я|ей)?|недел|месяц|сегодня|завтра|понедель|вторник|сред|четверг|пятниц|суббот|воскрес)/iu.test(text)
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

    if (state.pendingAction === 'image_edit') {
        if (isExplicitTelegramNonImageCommand(text, { botUsername })) {
            return { type: 'command', text, state: clearState };
        }
        const command = [
            state.pendingModel,
            `измени изображение ${text}`,
        ].filter(Boolean).join(' ');
        return {
            type: 'command',
            text: command,
            state: { pendingAction: 'image_edit', pendingModel: state.pendingModel, menuPath: state.menuPath },
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

        const commandText = isDirectTelegramImageCommand(text)
            ? text
            : `нарисуй ${text}`;
        const command = [state.pendingModel, commandText]
            .filter(Boolean)
            .join(' ');

        return {
            type: 'command',
            text: command,
            state: {
                pendingAction: 'image',
                pendingModel: state.pendingModel,
                menuPath: state.menuPath,
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
                allowed_updates: ['message'],
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
        messageThreadId = null,
        replyMarkup = null,
        replyToMessageId = null,
    }) {
        const replyParameters = buildTelegramReplyParameters(replyToMessageId);

        return this.call('sendMessage', {
            chat_id: chatId,
            text,
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

    async sendPhoto({
        chatId,
        photo,
        caption = '',
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
                ...(index === 0 && caption ? { caption: fitTelegramCaption(caption) } : {}),
            };
        });
        form.set('media', JSON.stringify(media));
        return this.call('sendMediaGroup', form, { multipart: true });
    }

    async sendDocument({
        chatId,
        document,
        caption = '',
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
    const privateReplyMenu = buildTelegramMainMenu({
        isOwner,
        now: new Date(),
    });
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

    const context = {
        platform: 'telegram',
        externalPeerId: externalChatId,
        externalSenderId,
        telegramChatType: chatType,
        telegramBotUsername: botUser.username || '',
        telegramMessageThreadId: threadId,
        peerId,
        senderId,
        conversationMessageId: incomingMessageId,
        createdAt: Number(message.date ?? Math.floor(Date.now() / 1000)),
        isChat: !privateMode,
        isDM: privateMode,
        isOutbox: false,
        text,
        originalText: rawText,
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
            const attachment = objectPayload.attachment;
            const photo = readTelegramPhotoAttachment(attachment);
            const document = readTelegramDocumentAttachment(attachment);
            const mediaGroupPhotos = Boolean(objectPayload.mediaGroup)
                ? (Array.isArray(objectPayload.attachments) ? objectPayload.attachments : [])
                    .filter(isTelegramPhotoAttachment)
                    .slice(0, 10)
                : [];
            const replyMarkup = objectPayload.replyMarkup ?? (
                privateMode ? privateReplyMenu : null
            );
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

            if (mediaGroupPhotos.length >= 2) {
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
                    caption: fitTelegramCaption(messageText),
                    messageThreadId: threadId,
                    replyToMessageId: replyMessageId,
                });
                // One event = one Telegram media album. Telegram allows a
                // caption only on an album item and caps it at 1024 chars; do
                // not emit the tail as a separate text message because that
                // breaks the event card into multiple messages.
            } else if (photo) {
                try {
                    await api.sendChatAction({
                        chatId: externalChatId,
                        action: 'upload_photo',
                        messageThreadId: threadId,
                    });
                } catch {
                    // Статус набора не обязателен для основной отправки.
                }

                const singleMediaMessage = Boolean(objectPayload.singleMediaMessage);
                const caption = singleMediaMessage
                    ? fitTelegramCaption(messageText)
                    : messageText.length <= TELEGRAM_CAPTION_LIMIT
                        ? messageText
                        : '';

                if (photo.buffer.length <= TELEGRAM_PHOTO_LIMIT_BYTES) {
                    lastSent = await api.sendPhoto({
                        chatId: externalChatId,
                        photo,
                        caption,
                        messageThreadId: threadId,
                        replyMarkup,
                        replyToMessageId: replyMessageId,
                    });
                } else {
                    lastSent = await api.sendDocument({
                        chatId: externalChatId,
                        document: photo,
                        caption,
                        messageThreadId: threadId,
                        replyMarkup,
                        replyToMessageId: replyMessageId,
                    });
                }

                if (messageText && !caption && !singleMediaMessage) {
                    for (const chunk of splitTelegramText(messageText)) {
                        lastSent = await api.sendMessage({
                            chatId: externalChatId,
                            text: chunk,
                            messageThreadId: threadId,
                            replyMarkup,
                            replyToMessageId: replyMessageId,
                        });
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
                    caption: messageText.length <= TELEGRAM_CAPTION_LIMIT ? messageText : '',
                    messageThreadId: threadId,
                    replyMarkup,
                    replyToMessageId: replyMessageId,
                });
                if (messageText.length > TELEGRAM_CAPTION_LIMIT) {
                    for (const chunk of splitTelegramText(messageText)) {
                        lastSent = await api.sendMessage({
                            chatId: externalChatId,
                            text: chunk,
                            messageThreadId: threadId,
                            replyMarkup,
                            replyToMessageId: replyMessageId,
                        });
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

                const delivery = await sendTelegramLongReply({
                    api, chatId: externalChatId, text: messageText,
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

    Object.defineProperty(context, 'telegramApi', {
        value: api,
        enumerable: false,
        configurable: false,
        writable: false,
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

function saveOffset(path, offset) {
    mkdirSync(resolve(path, '..'), { recursive: true });
    writeFileSync(
        path,
        JSON.stringify({ offset }, null, 2),
        'utf8',
    );
}

function createTelegramBot({
    token,
    onMessage,
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
                                },
                            );

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
                                void api.sendMessage({
                                    chatId: menuKey,
                                    text: menuResult.text,
                                    replyMarkup:
                                        menuResult.replyMarkup ?? buildTelegramMainMenu({
                                            isOwner: Boolean(
                                                ownerUserId &&
                                                String(message.from?.id ?? '') === String(ownerUserId)
                                            ),
                                            now: new Date(),
                                        }),
                                    replyToMessageId: message.message_id,
                                }).catch((error) => {
                                    logger.error('[TELEGRAM MENU SEND ERROR]', {
                                        name: error?.name,
                                        message: error?.message,
                                    });
                                });
                                handledByMenu = true;
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
                                const taskPromise = Promise.resolve(onMessage(context));
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

                                void taskPromise.catch((error) => {
                                    logger.error('[TELEGRAM MESSAGE TASK ERROR]', {
                                        name: error?.name,
                                        message: error?.message,
                                    });
                                });
                            }
                        }
                    }

                    offset = Math.max(offset, nextOffset);
                    saveOffset(absoluteStatePath, offset);
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
    buildTelegramPartyMenu,
    buildTelegramQticketsMenu,
    buildTelegramSecondaryPartyMenu,
    buildTelegramAllPartiesMenu,
    buildTelegramEventDeletionMenu,
    buildTelegramEventCandidateSelectionMenu,
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
