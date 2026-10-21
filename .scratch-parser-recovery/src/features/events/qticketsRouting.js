/**
 * Отдельное пространство команд для афиши QTickets.
 *
 * V188.87: публичный раздел QTickets живёт внутри меню «Тусы», но имеет
 * собственные период/ценовой фильтр. Браузерный парсер по-прежнему требует
 * явного административного хвоста «парсер»/«обновить».
 */

function normalizeCommand(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/[\u200B-\u200D\u2060\uFEFF]/gu, '')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .trim()
        .replace(/^[/\\]+/u, '')
        .replace(/[?!.,;]+$/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

const NAMESPACE = '(?:q[- ]?tickets|qtickets|кутикетс|кутикеты)';
const CATEGORY = '(?:события|евенты|ивенты|афиша|events|тусы|тусовки)';
const CURRENCY = '(?:₽|руб(?:ль|ля|лей|ли|\.)?|р(?:уб)?\.?)';

function cleanNumericToken(value) {
    const digits = String(value ?? '').replace(/[^\d]/gu, '');
    if (!digits) return null;
    const number = Number(digits);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

/**
 * Лимит цены из текстовой команды. Число дней никогда не принимается за цену:
 * цена должна идти после «цена/стоимость/до/не дороже» либо рядом с валютой.
 */
export function parseQticketsPriceLimit(value) {
    const command = normalizeCommand(value);
    if (!command) return null;

    const patterns = [
        new RegExp(`(?:по\\s+)?(?:цене|цена|стоимости|стоимость)\\s*(?:до|не\\s+дороже|максимум|max)?\\s*(\\d[\\d\\s]{0,8})(?:\\s*${CURRENCY})?`, 'iu'),
        new RegExp(`(?:не\\s+дороже|максимум|max|до)\\s*(\\d[\\d\\s]{0,8})(?:\\s*${CURRENCY})?(?!\\s*(?:дн(?:я|ей)?|сут(?:ок|ки)?))`, 'iu'),
        new RegExp(`(\\d[\\d\\s]{0,8})\\s*${CURRENCY}`, 'iu'),
    ];

    for (const pattern of patterns) {
        const match = command.match(pattern);
        const number = cleanNumericToken(match?.[1]);
        if (number !== null) return number;
    }
    return null;
}

/** Для кнопочного режима цены допустима любая строка: берём первое число. */
export function parseQticketsBarePriceLimit(value) {
    const match = String(value ?? '').match(/\d[\d\s]{0,8}/u);
    return cleanNumericToken(match?.[0]);
}

function parseQticketsRollingDays(value) {
    const command = normalizeCommand(value);
    const dayMatch = command.match(/(?:ближайш(?:ие|их)?\s+|следующ(?:ие|их)\s+|на\s+)?(\d{1,3})\s*(?:дн(?:я|ей)?|сут(?:ки|ок)?)/iu);
    if (dayMatch) {
        const days = Number(dayMatch[1]);
        return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
    }

    const weekMatch = command.match(/(?:ближайш(?:ие|их)?\s+|следующ(?:ие|их)\s+|на\s+)?(\d{1,2})\s*недел(?:ю|и|ь)/iu);
    if (weekMatch) {
        const days = Number(weekMatch[1]) * 7;
        return Number.isInteger(days) && days >= 1 && days <= 365 ? days : null;
    }
    if (/(?:^|\s)(?:на\s+)?(?:одну\s+)?недел(?:ю|я)(?:$|\s)/iu.test(command)) return 7;
    if (/(?:^|\s)(?:на\s+)?две\s+недели(?:$|\s)/iu.test(command)) return 14;
    return null;
}

function stripQticketsPriceClause(value) {
    let text = normalizeCommand(value);
    if (!text) return '';
    const price = parseQticketsPriceLimit(text);
    if (price === null) return text;

    // Убираем только хвост ценового фильтра; календарный текст сохраняется.
    text = text
        .replace(new RegExp(`(?:по\\s+)?(?:цене|цена|стоимости|стоимость)\\s*(?:до|не\\s+дороже|максимум|max)?\\s*${price}(?:\\s*${CURRENCY})?`, 'iu'), ' ')
        .replace(new RegExp(`(?:не\\s+дороже|максимум|max|до)\\s*${price}(?:\\s*${CURRENCY})?`, 'iu'), ' ')
        .replace(new RegExp(`${price}\\s*${CURRENCY}`, 'iu'), ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    return text;
}

/**
 * Для фильтра QTickets используется минимальная явно указанная стоимость:
 * «от 500», «500–800», «500 / 700» означают, что доступен билет от 500 ₽.
 * События без известной цены при активном фильтре не показываются.
 */
export function qticketsEventPriceFloorRubles(event) {
    const raw = String(event?.price ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').trim();
    if (!raw) return null;
    if (/(?:бесплатн|свободн(?:ый|ого)?\s+вход|free)/iu.test(raw)) return 0;

    const numbers = [...raw.matchAll(/(?<!\d)(\d[\d\s]{0,8})(?!\d)/gu)]
        .map((match) => cleanNumericToken(match[1]))
        .filter((value) => value !== null);
    return numbers.length ? Math.min(...numbers) : null;
}

export function qticketsEventMatchesPriceLimit(event, maxPrice) {
    const limit = Number(maxPrice);
    if (!Number.isFinite(limit) || limit < 0) return true;
    const price = qticketsEventPriceFloorRubles(event);
    return price !== null && price <= limit;
}


export function resolveQticketsWindowSpec(command = {}) {
    const dayCount = Number(command?.dayCount);
    if (Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 365) {
        return { dayCount, weekendsOnly: Boolean(command?.weekendsOnly), usePublicRange: false };
    }
    if (command?.weekendsOnly) {
        return { dayCount: 14, weekendsOnly: true, usePublicRange: false };
    }
    if (String(command?.rangeText ?? '').trim()) {
        return { dayCount: null, weekendsOnly: false, usePublicRange: true };
    }
    return { dayCount: 7, weekendsOnly: false, usePublicRange: false };
}

export function parseQticketsCommand(value) {
    const command = normalizeCommand(value)
        .replace(/^(?:гигорейв|gigorave)\s+/u, '')
        .trim();
    if (!command) return { matched: false, action: '', rangeText: '', commandText: command };

    const scrape = command.match(new RegExp(
        `^(?:${NAMESPACE})(?:\\s+${CATEGORY})?\\s+(?:парсер|скрейпер|обновить|запустить|refresh|run)$|^(?:парсер|скрейпер|обновить)\\s+${NAMESPACE}$`,
        'iu',
    ));
    if (scrape) {
        return {
            matched: true,
            action: 'scrape',
            rangeText: '',
            commandText: command,
            dayCount: null,
            weekendsOnly: false,
            maxPrice: null,
        };
    }

    const list = command.match(new RegExp(
        `^(?:${NAMESPACE})(?:\\s+${CATEGORY})?(?:\\s+(.+))?$|^(?:${CATEGORY})\\s+${NAMESPACE}(?:\\s+(.+))?$`,
        'iu',
    ));
    if (!list) return { matched: false, action: '', rangeText: '', commandText: command };

    const rawRangeText = String(list[1] ?? list[2] ?? '').trim();
    const dayCount = parseQticketsRollingDays(rawRangeText);
    const weekendsOnly = /(?:^|\s)выходн/iu.test(rawRangeText);
    const maxPrice = parseQticketsPriceLimit(rawRangeText);

    return {
        matched: true,
        action: 'list',
        rangeText: stripQticketsPriceClause(rawRangeText),
        rawRangeText,
        dayCount,
        weekendsOnly,
        maxPrice,
        commandText: command,
    };
}
