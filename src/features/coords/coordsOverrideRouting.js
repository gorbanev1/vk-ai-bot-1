/**
 * Специальный дословный ответ на команды «корды» в фиксированное окно.
 *
 * Окно продукта: 22 августа 2026 года, 11:00–24:00 по Europe/Moscow.
 * Управляющие команды владельца работают независимо от даты.
 */
import { normalizeLocalCommand } from '../../shared/commands.js';

export const COORDS_OVERRIDE_TIME_ZONE = 'Europe/Moscow';
export const COORDS_OVERRIDE_DATE = '2026-08-22';
export const COORDS_OVERRIDE_START_HOUR = 11;

const RESPONSE_COMMANDS = new Set([
    'координаты',
    'корды',
    'карды',
    'корды пересоздание',
    'карды пересоздание',
    'корды случайное пересоздание',
    'карды случайное пересоздание',
]);

const SET_MESSAGE_COMMANDS = new Set([
    'корды сообщение',
]);

const DELETE_MESSAGE_COMMANDS = new Set([
    'корды удалить',
    'корды удалить сообщение',
    'удалить сообщение',
]);

const DISABLE_COMMANDS = new Set([
    'корды отключить',
    'корды откл',
]);

const BROADCAST_START_COMMANDS = new Set([
    'корды рассылка',
    'корды ответить всем',
    'корды сообщение всем',
]);

const BROADCAST_SEND_COMMANDS = new Set([
    'корды рассылка отправить',
    'корды рассылка подтвердить',
]);

const BROADCAST_CANCEL_COMMANDS = new Set([
    'корды рассылка отменить',
    'корды рассылка отмена',
]);

const RECIPIENT_STATS_COMMANDS = new Set([
    'корды получатели',
    'сколько запросило корды',
]);

const RECIPIENT_LIST_COMMANDS = new Set([
    'корды список',
    'корды получатели список',
]);

const RECIPIENT_USERNAME_COMMANDS = new Set([
    'корды юзернеймы',
]);

const RECIPIENT_CLEAR_COMMANDS = new Set([
    'корды получатели очистить',
    'корды список очистить',
]);

const PERESOZDANIE_BROADCAST_START_COMMANDS = new Set([
    'разослать всем пересоздание',
    'пересоздание рассылка',
    'пересоздание всем',
]);

const PERESOZDANIE_BROADCAST_SEND_COMMANDS = new Set([
    'пересоздание отправить',
    'пересоздание рассылка отправить',
    'разослать пересоздание отправить',
]);

const PERESOZDANIE_BROADCAST_CANCEL_COMMANDS = new Set([
    'пересоздание отменить',
    'пересоздание рассылка отменить',
]);

const PERESOZDANIE_BROADCAST_EDIT_COMMANDS = new Set([
    'пересоздание текст',
    'пересоздание сообщение',
    'пересоздание изменить текст',
]);

const PERESOZDANIE_TEMPLATE_COMMANDS = new Set([
    'пересоздание шаблон',
    'пересоздание шаблон показать',
]);

const PERESOZDANIE_REVIEWS_COMMANDS = new Set([
    'пересоздание отзывы',
    'отзывы пересоздание',
]);

const PERESOZDANIE_REVIEW_STATS_COMMANDS = new Set([
    'пересоздание отзывы статистика',
    'пересоздание отзывы статус',
]);


const PERESOZDANIE_QR_DISABLE_COMMANDS = new Set([
    'qr-код убрать',
    'qr код убрать',
    'qr убрать',
]);

const PERESOZDANIE_QR_ENABLE_COMMANDS = new Set([
    'qr-код вернуть',
    'qr код вернуть',
    'qr вернуть',
]);

const PERESOZDANIE_THANK_COMMANDS = new Set([
    'пересоздание спасибо',
    'поблагодарить за пересоздание',
]);

export function parseCoordsOverrideCommand(value) {
    const normalized = normalizeLocalCommand(value);

    if (SET_MESSAGE_COMMANDS.has(normalized)) {
        return {
            matched: true,
            action: 'set-message',
            normalized,
            ownerOnly: true,
        };
    }

    if (DELETE_MESSAGE_COMMANDS.has(normalized)) {
        return {
            matched: true,
            action: 'delete-message',
            normalized,
            ownerOnly: true,
        };
    }

    if (DISABLE_COMMANDS.has(normalized)) {
        return {
            matched: true,
            action: 'disable',
            normalized,
            ownerOnly: true,
        };
    }

    if (BROADCAST_START_COMMANDS.has(normalized)) {
        return { matched: true, action: 'broadcast-start', normalized, ownerOnly: true };
    }

    if (BROADCAST_SEND_COMMANDS.has(normalized)) {
        return { matched: true, action: 'broadcast-send', normalized, ownerOnly: true };
    }

    if (BROADCAST_CANCEL_COMMANDS.has(normalized)) {
        return { matched: true, action: 'broadcast-cancel', normalized, ownerOnly: true };
    }

    if (RECIPIENT_STATS_COMMANDS.has(normalized)) {
        return { matched: true, action: 'recipient-stats', normalized, ownerOnly: true };
    }

    if (RECIPIENT_LIST_COMMANDS.has(normalized)) {
        return { matched: true, action: 'recipient-list', normalized, ownerOnly: true };
    }

    if (RECIPIENT_USERNAME_COMMANDS.has(normalized)) {
        return { matched: true, action: 'recipient-usernames', normalized, ownerOnly: true };
    }

    if (RECIPIENT_CLEAR_COMMANDS.has(normalized)) {
        return { matched: true, action: 'recipient-clear', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_BROADCAST_START_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-broadcast-start', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_BROADCAST_SEND_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-broadcast-send', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_BROADCAST_CANCEL_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-broadcast-cancel', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_BROADCAST_EDIT_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-broadcast-edit', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_TEMPLATE_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-template', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_REVIEWS_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-reviews', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_REVIEW_STATS_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-review-stats', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_QR_DISABLE_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-qr-disable', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_QR_ENABLE_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-qr-enable', normalized, ownerOnly: true };
    }

    if (PERESOZDANIE_THANK_COMMANDS.has(normalized)) {
        return { matched: true, action: 'peresozdanie-thank', normalized, ownerOnly: false };
    }

    if (RESPONSE_COMMANDS.has(normalized)) {
        return {
            matched: true,
            action: 'respond',
            normalized,
            ownerOnly: false,
        };
    }

    return {
        matched: false,
        action: 'none',
        normalized,
        ownerOnly: false,
    };
}

export function isCoordsOverrideResponseCommand(value) {
    return parseCoordsOverrideCommand(value).action === 'respond';
}

export function isCoordsOverrideOwnerCommand(value) {
    const parsed = parseCoordsOverrideCommand(value);
    return parsed.matched && parsed.ownerOnly;
}

/**
 * Проверяется именно календарное время Москвы, а не timezone сервера.
 * Верхняя граница 24:00 естественно является началом 23 августа и уже
 * не проходит проверку даты.
 */
export function isCoordsOverrideWindow(now = new Date()) {
    const date = now instanceof Date ? now : new Date(now);

    if (Number.isNaN(date.getTime())) {
        return false;
    }

    const formatter = new Intl.DateTimeFormat('en-CA', {
        timeZone: COORDS_OVERRIDE_TIME_ZONE,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    });
    const parts = Object.fromEntries(
        formatter.formatToParts(date)
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, part.value]),
    );
    const localDate = `${parts.year}-${parts.month}-${parts.day}`;
    const hour = Number(parts.hour);

    return (
        localDate === COORDS_OVERRIDE_DATE &&
        Number.isInteger(hour) &&
        hour >= COORDS_OVERRIDE_START_HOUR
    );
}


export function getCoordsOverrideWindowState(now = new Date()) {
    const date = now instanceof Date ? now : new Date(now);

    if (Number.isNaN(date.getTime())) {
        return 'invalid';
    }

    const start = new Date('2026-08-22T08:00:00.000Z');
    const end = new Date('2026-08-22T21:00:00.000Z');

    if (date < start) {
        return 'before';
    }

    if (date >= end) {
        return 'after';
    }

    return 'active';
}

export function shouldSendCoordsOverride({
    requestText,
    settings,
    now = new Date(),
    owner = false,
} = {}) {
    const parsed = parseCoordsOverrideCommand(requestText);

    return Boolean(
        parsed.action === 'respond' &&
        (owner || isCoordsOverrideWindow(now)) &&
        settings?.enabled &&
        String(settings?.messageText ?? '').trim()
    );
}
