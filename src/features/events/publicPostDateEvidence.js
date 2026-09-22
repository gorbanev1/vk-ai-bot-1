import {
    sanitizeEventBodyText,
} from './eventTextSanitation.js';

/**
 * Unified date evidence for public VK/Telegram and VK-chat parsing.
 *
 * Important invariants:
 *  - calendar validation is real, not regex-only;
 *  - publication timestamps are interpreted in their source timezone;
 *  - address/version/discount numeric fragments are not event dates;
 *  - relative dates and weekdays resolve from publishedAt, then referenceNow;
 *  - year rollover is based on full calendar distance, not month-only math.
 */

export const RUSSIAN_EVENT_MONTHS = new Map([
    ['января', 1], ['январь', 1], ['янв', 1],
    ['февраля', 2], ['февраль', 2], ['фев', 2],
    ['марта', 3], ['март', 3], ['мар', 3],
    ['апреля', 4], ['апрель', 4], ['апр', 4],
    ['мая', 5], ['май', 5],
    ['июня', 6], ['июнь', 6], ['июн', 6],
    ['июля', 7], ['июль', 7], ['июл', 7],
    ['августа', 8], ['август', 8], ['авг', 8],
    ['сентября', 9], ['сентябрь', 9], ['сен', 9], ['сент', 9],
    ['октября', 10], ['октябрь', 10], ['окт', 10],
    ['ноября', 11], ['ноябрь', 11], ['ноя', 11],
    ['декабря', 12], ['декабрь', 12], ['дек', 12],
]);

const WEEKDAY_INDEX = new Map([
    ['понедельник', 1], ['понедельника', 1],
    ['вторник', 2], ['вторника', 2],
    ['среда', 3], ['среду', 3], ['среды', 3],
    ['четверг', 4], ['четверга', 4],
    ['пятница', 5], ['пятницу', 5], ['пятницы', 5],
    ['суббота', 6], ['субботу', 6], ['субботы', 6],
    ['воскресенье', 0], ['воскресенья', 0],
]);

const DAY_MS = 86_400_000;

function pad(value) {
    return String(value).padStart(2, '0');
}

export function normalizeEventYear(value) {
    const year = Number(value);
    if (!Number.isInteger(year)) return null;
    if (year >= 1000) return year;
    return year <= 69 ? 2000 + year : 1900 + year;
}

export function toIsoEventDate(year, month, day) {
    const numericYear = Number(year);
    const numericMonth = Number(month);
    const numericDay = Number(day);
    if (!Number.isInteger(numericYear) || !Number.isInteger(numericMonth) || !Number.isInteger(numericDay)) {
        return null;
    }
    const date = new Date(Date.UTC(numericYear, numericMonth - 1, numericDay));
    if (
        date.getUTCFullYear() !== numericYear ||
        date.getUTCMonth() !== numericMonth - 1 ||
        date.getUTCDate() !== numericDay
    ) {
        return null;
    }
    return `${numericYear}-${pad(numericMonth)}-${pad(numericDay)}`;
}

export function isCalendarIsoDate(value) {
    const match = String(value ?? '').trim().match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    return Boolean(match && toIsoEventDate(Number(match[1]), Number(match[2]), Number(match[3])) === match[0]);
}

function getLocalDateParts(date, timeZone = 'Europe/Moscow') {
    const safeDate = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(safeDate.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(safeDate);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const year = Number(map.year);
    const month = Number(map.month);
    const day = Number(map.day);
    return Number.isInteger(year) && Number.isInteger(month) && Number.isInteger(day)
        ? { year, month, day }
        : null;
}

function getLocalDateTimeParts(date, timeZone = 'Europe/Moscow') {
    const safeDate = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(safeDate.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(safeDate);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const result = {
        year: Number(map.year), month: Number(map.month), day: Number(map.day),
        hour: Number(map.hour), minute: Number(map.minute), second: Number(map.second),
    };
    return Object.values(result).every(Number.isInteger) ? result : null;
}

function getPublishedDateParts(publishedAt, timeZone = 'Europe/Moscow') {
    const timestamp = Number(publishedAt);
    if (!Number.isFinite(timestamp) || timestamp <= 0) return null;
    return getLocalDateParts(new Date(timestamp * 1000), timeZone);
}

function getReferenceDateParts({ publishedAt = 0, referenceNow = new Date(), timeZone = 'Europe/Moscow' } = {}) {
    return getPublishedDateParts(publishedAt, timeZone) || getLocalDateParts(referenceNow, timeZone);
}

function datePartsToUtcDay(parts) {
    if (!parts) return NaN;
    return Date.UTC(Number(parts.year), Number(parts.month) - 1, Number(parts.day));
}

function addCalendarDays(parts, days) {
    if (!parts) return null;
    const date = new Date(Date.UTC(parts.year, parts.month - 1, parts.day + Number(days || 0)));
    return {
        year: date.getUTCFullYear(),
        month: date.getUTCMonth() + 1,
        day: date.getUTCDate(),
    };
}

/**
 * Year inference for dates without a year. A same-year date more than half a
 * year behind the post is treated as next year. Using the full day distance
 * fixes September->March / August->February boundary errors.
 */
export function inferEventYear({
    month,
    day = 1,
    explicitYear,
    publishedAt = 0,
    referenceNow = new Date(),
    timeZone = 'Europe/Moscow',
} = {}) {
    if (explicitYear !== undefined && explicitYear !== null && String(explicitYear).trim()) {
        return normalizeEventYear(explicitYear);
    }
    const postDate = getReferenceDateParts({ publishedAt, referenceNow, timeZone });
    if (!postDate) return null;
    const numericMonth = Number(month);
    const numericDay = Number(day);
    if (!toIsoEventDate(postDate.year, numericMonth, numericDay)) return null;

    const postDay = datePartsToUtcDay(postDate);
    const sameYearDay = Date.UTC(postDate.year, numericMonth - 1, numericDay);
    const deltaDays = Math.round((sameYearDay - postDay) / DAY_MS);
    return deltaDays < -183 ? postDate.year + 1 : postDate.year;
}

function normalizeSource(text) {
    return sanitizeEventBodyText(text).toLowerCase().replace(/ё/gu, 'е');
}

function surroundingContext(source, index, length, before = 90, after = 90) {
    return {
        before: source.slice(Math.max(0, index - before), index),
        after: source.slice(index + length, index + length + after),
    };
}

function isPhoneFragment(source, index, length) {
    const allowed = /[+\d\s().-]/u;
    let start = index;
    let end = index + length;
    while (start > 0 && allowed.test(source[start - 1])) start -= 1;
    while (end < source.length && allowed.test(source[end])) end += 1;
    const fragment = source.slice(start, end);
    const digits = fragment.match(/\d/gu) || [];
    return fragment.includes('+') || (digits.length >= 10 && /[()]/u.test(fragment));
}

function isAdministrativeOrNonDateContext(source, index, length, raw) {
    const { before, after } = surroundingContext(source, index, length);
    const left = before.slice(-70);
    const right = after.slice(0, 70);
    const compact = `${left} ${raw} ${right}`;

    // Street names such as «ул. 9 Января, 100» are addresses, not dates.
    if (/(?:^|\s)(?:ул\.?|улиц(?:а|е|ы|у)|просп(?:ект|\.)?|пр-т|пер\.?|переулок|наб\.?|набережн(?:ая|ой)|шоссе|бульвар|бул\.?|пл\.?|площадь)\s*$/iu.test(left)) {
        return true;
    }
    // Versions/builds/model numbers: «версия 2.10», «v2.10», «релиз 2.10».
    if (/(?:верси(?:я|и)|version|build|сборк(?:а|и)|релиз|release|(?:^|\s)v)\s*[:#-]?\s*$/iu.test(left)) {
        return true;
    }
    // Discounts/promocodes commonly look like 11-11 / 10.10.
    if (/(?:скидк|промокод|promo|акци(?:я|и)|купон|sale)\S*[^\n]{0,28}$/iu.test(left) &&
        !/(?:концерт|вечерин|мероприят|событи|начало|дата|когда)/iu.test(compact)) {
        return true;
    }
    // Dimensions, IPs and technical identifiers.
    if (/(?:размер|формат|верси|ip|порт|модель|артикул|sku|частот|hz|гц)\S*[^\n]{0,24}$/iu.test(left)) {
        return true;
    }
    if (/^\s*(?:%|процент|скидк)/iu.test(right)) return true;
    return false;
}

function pushMention(mentions, mention) {
    if (!mention) return;
    const key = [mention.kind || 'absolute', mention.index, mention.length, mention.day, mention.month, mention.explicitYear, mention.relativeDays, mention.weekday].join('|');
    if (mentions.some((item) => item.__key === key)) return;
    mentions.push({ ...mention, __key: key });
}

/**
 * Raw date mentions, including relative dates. Absolute mentions expose
 * day/month; relative mentions are resolved by extractExplicitDateMentions().
 */
export function extractRawDateMentions(text) {
    const source = normalizeSource(text);
    const mentions = [];
    let match;

    // Event dates in source text: DD.MM[.YYYY] or day + month name.
    // ISO is a valid INTERNAL eventDate, never raw VK/OCR date evidence.
    // Do not infer date from 19:00, 19-00, 20-09 or 2026-09-20.

    const numericPattern = /(?<![\d.\/:])(\d{1,2})\.(\d{1,2})(?:\.(\d{2}|\d{4}))?(?![\d.\/:])/gu;
    while ((match = numericPattern.exec(source)) !== null) {
        if (isPhoneFragment(source, match.index, match[0].length)) continue;
        if (isAdministrativeOrNonDateContext(source, match.index, match[0].length, match[0])) continue;
        pushMention(mentions, {
            kind: 'absolute',
            day: Number(match[1]), month: Number(match[2]),
            explicitYear: match[3] ? normalizeEventYear(match[3]) : null,
            index: match.index, length: match[0].length, raw: match[0],
        });
    }

    const words = [...RUSSIAN_EVENT_MONTHS.keys()].sort((a, b) => b.length - a.length).join('|');
    const textualPattern = new RegExp(`(?<!\\d)(\\d{1,2})(?:-?го)?[ \\t]+(${words})(?:[ \\t]+(\\d{4}))?(?!\\d)`, 'giu');
    while ((match = textualPattern.exec(source)) !== null) {
        if (isAdministrativeOrNonDateContext(source, match.index, match[0].length, match[0])) continue;
        pushMention(mentions, {
            kind: 'absolute', day: Number(match[1]),
            month: RUSSIAN_EVENT_MONTHS.get(String(match[2]).toLowerCase()),
            explicitYear: match[3] ? normalizeEventYear(match[3]) : null,
            index: match.index, length: match[0].length, raw: match[0],
        });
    }

    // Spoken ordinal day in a poster/text: "седьмое февраля", "двадцать первое марта".
    // This is still an explicit day + month, not a relative date guess.
    const ordinalBase = new Map([
        ['первое', 1], ['второе', 2], ['третье', 3], ['четвертое', 4],
        ['пятое', 5], ['шестое', 6], ['седьмое', 7], ['восьмое', 8],
        ['девятое', 9], ['десятое', 10], ['одиннадцатое', 11],
        ['двенадцатое', 12], ['тринадцатое', 13], ['четырнадцатое', 14],
        ['пятнадцатое', 15], ['шестнадцатое', 16], ['семнадцатое', 17],
        ['восемнадцатое', 18], ['девятнадцатое', 19], ['двадцатое', 20],
        ['тридцатое', 30],
    ]);
    for (const [spelling, day] of [...ordinalBase]) {
        if (day < 10) {
            ordinalBase.set(`двадцать ${spelling}`, day + 20);
            if (day === 1) ordinalBase.set(`тридцать ${spelling}`, 31);
        }
    }
    const ordinalPattern = new RegExp(
        `(?<![\\p{L}\\p{N}_])(${[...ordinalBase.keys()].sort((a,b) => b.length - a.length).join('|')})[ \t]+(${words})(?:[ \t]+(\\d{4}))?(?!\\d)`,
        'giu',
    );
    while ((match = ordinalPattern.exec(source)) !== null) {
        if (isAdministrativeOrNonDateContext(source, match.index, match[0].length, match[0])) continue;
        const day = ordinalBase.get(String(match[1]).toLowerCase().replace(/ё/gu, 'е'));
        const month = RUSSIAN_EVENT_MONTHS.get(String(match[2]).toLowerCase());
        if (!day || !month) continue;
        pushMention(mentions, {
            kind: 'absolute', day, month,
            explicitYear: match[3] ? normalizeEventYear(match[3]) : null,
            index: match.index, length: match[0].length, raw: match[0],
        });
    }

    // Text ranges where only the last day carries the month: 20–22 сентября,
    // с 20 по 22 сентября, 20, 21 и 22 сентября.
    const rangePatterns = [
        new RegExp(`(?<!\\d)(\\d{1,2})\\s*[—–-]\\s*(\\d{1,2})\\s+(${words})(?:\\s+(\\d{4}))?`, 'giu'),
        new RegExp(`(?<![\\p{L}\\p{N}_])с\\s+(\\d{1,2})\\s+по\\s+(\\d{1,2})\\s+(${words})(?:\\s+(\\d{4}))?`, 'giu'),
    ];
    for (const pattern of rangePatterns) {
        while ((match = pattern.exec(source)) !== null) {
            const month = RUSSIAN_EVENT_MONTHS.get(String(match[3]).toLowerCase());
            const year = match[4] ? normalizeEventYear(match[4]) : null;
            const firstDayOffset = match[0].indexOf(match[1]);
            const secondDayOffset = match[0].lastIndexOf(match[2]);
            pushMention(mentions, {
                kind: 'range-start', day: Number(match[1]), month, explicitYear: year,
                index: match.index + Math.max(0, firstDayOffset), length: String(match[1]).length, raw: String(match[1]),
                rangeId: `range:${match.index}`,
            });
            pushMention(mentions, {
                kind: 'range-end', day: Number(match[2]), month, explicitYear: year,
                index: match.index + Math.max(0, secondDayOffset), length: String(match[2]).length, raw: match[0],
                rangeId: `range:${match.index}`,
            });
        }
    }

    const listPattern = new RegExp(`(?<!\\d)(\\d{1,2})(?:\\s*,\\s*(\\d{1,2}))+\\s*(?:,?\\s*(?:и|and)\\s*)?(\\d{1,2})\\s+(${words})(?:\\s+(\\d{4}))?`, 'giu');
    while ((match = listPattern.exec(source)) !== null) {
        const month = RUSSIAN_EVENT_MONTHS.get(String(match[4]).toLowerCase());
        const year = match[5] ? normalizeEventYear(match[5]) : null;
        const dayMatches = [...match[0].matchAll(/\d{1,2}/gu)].map((item) => ({ day: Number(item[0]), offset: item.index || 0 }));
        const rangeId = `list:${match.index}`;
        dayMatches.slice(0, -1).forEach((item, idx) => pushMention(mentions, {
            kind: idx === 0 ? 'range-start' : 'range-day', day: item.day, month, explicitYear: year,
            index: match.index + item.offset, length: String(item.day).length, raw: String(item.day), rangeId,
        }));
        const last = dayMatches.at(-1);
        if (last) pushMention(mentions, {
            kind: 'range-end', day: last.day, month, explicitYear: year,
            index: match.index + last.offset, length: String(last.day).length, raw: match[0], rangeId,
        });
    }

    // "Сегодня/завтра" and weekday labels are unconfirmed without an
    // explicit DD.MM/month-name date. Preserve their raw text upstream,
    // but do not manufacture a calendar date here.

    return mentions
        .filter((mention) => toIsoEventDate(2000, mention.month, mention.day) !== null)
        .sort((a, b) => a.index - b.index || (a.kind === 'range-start' ? -1 : 0))
        .map(({ __key, ...mention }) => mention);
}

function resolveMention(mention, { publishedAt = 0, referenceNow = new Date(), timeZone = 'Europe/Moscow' } = {}) {
    const base = getReferenceDateParts({ publishedAt, referenceNow, timeZone });
    if (mention.kind === 'relative') {
        const parts = addCalendarDays(base, mention.relativeDays);
        const date = parts ? toIsoEventDate(parts.year, parts.month, parts.day) : null;
        return date ? { ...mention, ...parts, date, year: parts.year, yearSource: publishedAt > 0 ? 'published_at-relative' : 'reference_now-relative' } : null;
    }
    if (mention.kind === 'weekday') {
        if (!base || !Number.isInteger(mention.weekday)) return null;
        const baseDate = new Date(Date.UTC(base.year, base.month - 1, base.day));
        const currentWeekday = baseDate.getUTCDay();
        const delta = (mention.weekday - currentWeekday + 7) % 7;
        const parts = addCalendarDays(base, delta);
        const date = parts ? toIsoEventDate(parts.year, parts.month, parts.day) : null;
        return date ? { ...mention, ...parts, date, year: parts.year, yearSource: publishedAt > 0 ? 'published_at-weekday' : 'reference_now-weekday' } : null;
    }
    const year = inferEventYear({
        month: mention.month, day: mention.day, explicitYear: mention.explicitYear,
        publishedAt, referenceNow, timeZone,
    });
    const date = year ? toIsoEventDate(year, mention.month, mention.day) : null;
    return date ? {
        ...mention, date, year,
        yearSource: mention.explicitYear ? 'explicit' : publishedAt > 0 ? 'published_at' : 'reference_now',
    } : null;
}

export function extractExplicitDateMentions(text, publishedAt = 0, {
    timeZone = 'Europe/Moscow',
    referenceNow = new Date(),
} = {}) {
    return extractRawDateMentions(text)
        .map((mention) => resolveMention(mention, { publishedAt, referenceNow, timeZone }))
        .filter(Boolean);
}

export function extractExplicitDates(text, publishedAt = 0, options = {}) {
    const seen = new Set();
    const dates = [];
    for (const mention of extractExplicitDateMentions(text, publishedAt, options)) {
        if (!seen.has(mention.date)) {
            seen.add(mention.date);
            dates.push(mention.date);
        }
    }
    return dates;
}

export function extractEventDateRanges(text, publishedAt = 0, options = {}) {
    const mentions = extractExplicitDateMentions(text, publishedAt, options);
    const byRange = new Map();
    for (const mention of mentions) {
        if (!mention.rangeId) continue;
        const group = byRange.get(mention.rangeId) || [];
        group.push(mention);
        byRange.set(mention.rangeId, group);
    }
    return [...byRange.values()].map((group) => {
        const ordered = group.sort((a, b) => a.index - b.index);
        const start = ordered.find((item) => item.kind === 'range-start') || ordered[0];
        const end = [...ordered].reverse().find((item) => item.kind === 'range-end') || ordered.at(-1);
        return {
            startDate: start?.date || '', endDate: end?.date || start?.date || '',
            dates: [...new Set(ordered.map((item) => item.date).filter(Boolean))],
            raw: ordered.map((item) => item.raw).filter(Boolean).join(' '),
            index: Math.min(...ordered.map((item) => item.index)),
        };
    }).filter((range) => range.startDate);
}

function zonedLocalDateTimeToEpochSeconds({ year, month, day, hour = 12, minute = 0, second = 0, timeZone = 'Europe/Moscow' }) {
    if (!toIsoEventDate(year, month, day)) return 0;
    const desiredUtcShape = Date.UTC(year, month - 1, day, hour, minute, second);
    let guess = desiredUtcShape;
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const actual = getLocalDateTimeParts(new Date(guess), timeZone);
        if (!actual) return 0;
        const actualUtcShape = Date.UTC(actual.year, actual.month - 1, actual.day, actual.hour, actual.minute, actual.second);
        const delta = desiredUtcShape - actualUtcShape;
        if (delta === 0) break;
        guess += delta;
    }
    return Math.floor(guess / 1000);
}

function inferHistoricalLabelYear({ month, day, now = new Date(), timeZone = 'Europe/Moscow' }) {
    const today = getLocalDateParts(now, timeZone);
    if (!today) return null;
    let year = today.year;
    const current = Date.UTC(today.year, today.month - 1, today.day);
    const candidate = Date.UTC(year, Number(month) - 1, Number(day));
    if (candidate - current > 2 * DAY_MS) year -= 1;
    return year;
}

/** Parse VK labels in the provided timezone without treating local clock as UTC. */
export function parseVkPublishedAtLabel(label, {
    now = new Date(),
    timeZone = 'Europe/Moscow',
} = {}) {
    const source = String(label ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ').trim();
    if (!source) return 0;

    const relative = source.match(/^(сегодня|вчера)(?:\s+в)?(?:\s+([01]?\d|2[0-3]):([0-5]\d))?$/u);
    if (relative) {
        const today = getLocalDateParts(now, timeZone);
        if (!today) return 0;
        const parts = addCalendarDays(today, relative[1] === 'вчера' ? -1 : 0);
        return zonedLocalDateTimeToEpochSeconds({
            ...parts,
            hour: Number(relative[2] ?? 12), minute: Number(relative[3] ?? 0), timeZone,
        });
    }

    const numeric = source.match(/^(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?:\s+(?:в\s*)?([01]?\d|2[0-3]):([0-5]\d))?$/u);
    if (numeric) {
        const month = Number(numeric[2]);
        const day = Number(numeric[1]);
        const year = numeric[3] ? normalizeEventYear(numeric[3]) : inferHistoricalLabelYear({ month, day, now, timeZone });
        return year ? zonedLocalDateTimeToEpochSeconds({
            year, month, day, hour: Number(numeric[4] ?? 12), minute: Number(numeric[5] ?? 0), timeZone,
        }) : 0;
    }

    const words = [...RUSSIAN_EVENT_MONTHS.keys()].sort((a, b) => b.length - a.length).join('|');
    const textual = source.match(new RegExp(`^(\\d{1,2})\\s+(${words})(?:\\s+(\\d{2,4}))?(?:\\s+(?:в\\s*)?([01]?\\d|2[0-3]):([0-5]\\d))?$`, 'iu'));
    if (textual) {
        const day = Number(textual[1]);
        const month = RUSSIAN_EVENT_MONTHS.get(String(textual[2]).toLowerCase());
        const year = textual[3] ? normalizeEventYear(textual[3]) : inferHistoricalLabelYear({ month, day, now, timeZone });
        return year ? zonedLocalDateTimeToEpochSeconds({
            year, month, day, hour: Number(textual[4] ?? 12), minute: Number(textual[5] ?? 0), timeZone,
        }) : 0;
    }
    return 0;
}

export function isEventDateConsistentWithSource({
    eventDate,
    sourceText,
    publishedAt = 0,
    referenceNow = new Date(),
    timeZone = 'Europe/Moscow',
} = {}) {
    if (!isCalendarIsoDate(eventDate)) return false;
    return extractExplicitDates(sourceText, publishedAt, { timeZone, referenceNow }).includes(String(eventDate).trim());
}

export const publicPostDateEvidenceInternals = {
    addCalendarDays,
    getLocalDateParts,
    getReferenceDateParts,
    inferHistoricalLabelYear,
    isAdministrativeOrNonDateContext,
    zonedLocalDateTimeToEpochSeconds,
};
