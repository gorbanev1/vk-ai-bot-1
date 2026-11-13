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
function findQticketsPriceClause(command) {
    const patterns=[
        new RegExp('(?:по\\s+)?(?:цене|цена|стоимости|стоимость)\\s*(?:до|не\\s+дороже|максимум|max)?\\s*(\\d(?:[\\d\\s]*\\d)?)(?:\\s*'+CURRENCY+')?','giu'),
        new RegExp('(\\d(?:[\\d\\s]*\\d)?)\\s*'+CURRENCY,'giu'),
        /(?:не\s+дороже|максимум|max|до)\s*(\d(?:[\d\s]*\d)?)(?!\d)/giu,
    ];
    for(let i=0;i<patterns.length;i++)for(const m of command.matchAll(patterns[i])){
        const after=command.slice(m.index+m[0].length),before=command.slice(0,m.index);
        if(i===2){
            if(/^\s*(?:[./-]\d|январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр|дн|сут|недел|год|г(?:\.|\s|$))/u.test(after))continue;
            if(/^до/u.test(m[0])&&/^(?:19|20|21)\d{2}$/u.test(m[1])&&/(?:19|20|21)\d{2}\s*(?:г(?:ода|од)?\.?)?\s*$/u.test(before))continue;
        }
        const value=cleanNumericToken(m[1]);if(value!==null)return {index:m.index,text:m[0],value};
    }
    return null;
}
export function parseQticketsPriceLimit(value) {
    return findQticketsPriceClause(normalizeCommand(value))?.value ?? null;
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
 const text=normalizeCommand(value),clause=findQticketsPriceClause(text);
 return clause?(text.slice(0,clause.index)+' '+text.slice(clause.index+clause.text.length)).replace(/\s+/gu,' ').trim():text;
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

export function hasQticketsPriceLimit(value) {
    if (value === null || value === undefined || String(value).trim() === '') return false;
    const limit = Number(value);
    return Number.isFinite(limit) && limit >= 0;
}

/**
 * QTickets is the Voronezh catalogue, but some detail pages carry stale
 * structured location metadata for touring events. Only event identity text
 * is used here; the site-wide body and venue address can contain false city
 * values (or the words "Московский проспект").
 */
export function qticketsEventHasConflictingCity(event) {
    const identity = [event?.title, event?.description]
        .map((value) => String(value ?? ''))
        .join(' ')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е');
    const namesMoscow = /(?<![\p{L}\p{N}])москв(?:а|ы|е|у|ой|ою)(?![\p{L}\p{N}])/iu.test(identity);
    const namesVoronezh = /(?<![\p{L}\p{N}])воронеж(?:е|а|у|ом)?(?![\p{L}\p{N}])/iu.test(identity);
    return namesMoscow && !namesVoronezh;
}


export function resolveQticketsWindowSpec(command = {}) {
    const rangeText = String(command?.rangeText ?? '').trim();
    const weeksOnly = /(?:^|\s)(?:на\s+)?(?:одну\s+)?недел(?:ю|я)(?:$|\s)/iu.test(rangeText) &&
        !/(?:^|\s)\d{1,2}\s*недел/iu.test(rangeText);
    if (weeksOnly) {
        return { dayCount: null, weekendsOnly: false, usePublicRange: true };
    }
    const dayCount = Number(command?.dayCount);
    if (Number.isInteger(dayCount) && dayCount >= 1 && dayCount <= 365) {
        return { dayCount, weekendsOnly: Boolean(command?.weekendsOnly), usePublicRange: false };
    }
    if (command?.weekendsOnly) {
        return { dayCount: null, weekendsOnly: false, usePublicRange: true };
    }
    if (rangeText) {
        return { dayCount: null, weekendsOnly: false, usePublicRange: true };
    }
    // Keep the existing default listing window; price is independent and
    // remains unlimited unless the user explicitly supplies a price clause.
    return { dayCount: 7, weekendsOnly: false, usePublicRange: false };
}

export function parseQticketsCommand(value) {
    const originalCommand = normalizeCommand(value)
        .replace(/^(?:гигорейв|gigorave)\s+/u, '')
        .replace(/\bq[- ]?tickets\b/giu, 'qtickets')
        .trim();
    if (!originalCommand) return { matched: false, action: '', rangeText: '', commandText: originalCommand };

    const turboMatch = originalCommand.match(/(?:^|\s)(турбо[1-4]|турбо|turbo[1-4]|turbo)(?=\s|$)/iu);
    const rawTurboMode = String(turboMatch?.[1] || '').toLowerCase().replace(/^турбо/iu, 'turbo');
    const turboMode = rawTurboMode === 'turbo1' ? 'turbo' : rawTurboMode;
    const cleanOnly = /(?:^|\s)(?:новые|new|чисто|clean)(?=\s|$)/iu.test(originalCommand);
    const command = originalCommand
        .replace(/(?:^|\s)(?:турбо[1-4]|турбо|turbo[1-4]|turbo)(?=\s|$)/giu, ' ')
        .replace(/(?:^|\s)(?:новые|new|чисто|clean)(?=\s|$)/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    const tokens = command.split(' ').filter(Boolean);
    const namespacePattern = new RegExp(`^${NAMESPACE}$`, 'iu');
    const categoryPattern = new RegExp(`^${CATEGORY}$`, 'iu');
    if (!tokens.some((token) => namespacePattern.test(token))) {
        return { matched: false, action: '', rangeText: '', commandText: originalCommand };
    }
    const intentTokens = tokens.filter((token) => !namespacePattern.test(token) && !categoryPattern.test(token));
    const hasScrapeIntent = intentTokens.some((token) => /^(?:парсер|скрейпер|обновить|запустить|refresh|run)$/iu.test(token));
    if (hasScrapeIntent) {
        return {
            matched: true, action: 'scrape', rangeText: '', commandText: originalCommand,
            dayCount: null, weekendsOnly: false, maxPrice: null, cleanOnly,
            ...(turboMode ? { turboMode } : {}),
        };
    }

    const rawRangeText = intentTokens.join(' ').trim();
    const dayCount = parseQticketsRollingDays(rawRangeText);
    const weekendsOnly = /(?:^|\s)выходн/iu.test(rawRangeText);
    const maxPrice = parseQticketsPriceLimit(rawRangeText);
    return {
        matched: true, action: 'list', rangeText: stripQticketsPriceClause(rawRangeText), rawRangeText,
        dayCount, weekendsOnly, maxPrice, commandText: originalCommand, cleanOnly,
        ...(turboMode ? { turboMode } : {}),
    };
}
