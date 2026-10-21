/**
 * Извлекает ссылки, цену, участников, площадку и другие структурные поля события.
 */
import { extractRawDateMentions } from './publicPostDateEvidence.js';
const MONTHS = new Map([
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

const KNOWN_VENUES = [
    /\b(?:rock\s+bar\s+)?diesel\s+hall\b/iu,
    /\b(?:rock\s+bar\s+)?diesel\s+bar\b/iu,
    /\boverlock(?:\s+bar)?\b/iu,
    /\bкотельная\b/iu,
    /\bпетровская\s+набережная(?:\s*,?\s*пирс)?\b/iu,
    /\bмитбоулинг\s+клуб\b/iu,
];

const EVENT_TYPES = [
    ['Концерт', /(?:концерт|гиг|лайв|live|выступлен|панк|рок|метал|хардкор)/iu],
    ['Вечеринка', /(?:вечеринк|тус(?:а|овк)|party|dj|дидже|клубная\s+ночь)/iu],
    ['Фестиваль', /(?:фестивал|фест)/iu],
    ['Танцы', /(?:танц|dance|дэнс)/iu],
    ['Маркет', /(?:маркет|ярмарк)/iu],
    ['Лекция', /(?:лекци|лектори)/iu],
    ['Мастер-класс', /(?:мастер[ -]?класс|воркшоп|workshop)/iu],
    ['Выставка', /(?:выставк|экспозици|галере)/iu],
    ['Стендап', /(?:стендап|stand[ -]?up)/iu],
    ['Квиз', /(?:квиз|викторин)/iu],
];

function normalizeSpaces(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/\r\n?/gu, '\n')
        .replace(/[\t ]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

function pad(value) {
    return String(value).padStart(2, '0');
}

function validIsoDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ''))) {
        return false;
    }

    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return date.getUTCFullYear() === year &&
        date.getUTCMonth() === month - 1 &&
        date.getUTCDate() === day;
}

function toIsoDate(year, month, day) {
    const numericYear = Number(year);
    const numericMonth = Number(month);
    const numericDay = Number(day);

    if (
        !Number.isInteger(numericYear) ||
        !Number.isInteger(numericMonth) ||
        !Number.isInteger(numericDay)
    ) {
        return '';
    }

    const candidate = `${numericYear}-${pad(numericMonth)}-${pad(numericDay)}`;
    return validIsoDate(candidate) ? candidate : '';
}

function normalizeYear(value, referenceYear) {
    // Number(null) and Number('') are 0; those mean year absent, NOT 2000.
    if (value === null || value === undefined || String(value).trim() === '') {
        return referenceYear;
    }
    const year = Number(value);

    if (!Number.isFinite(year)) {
        return referenceYear;
    }

    if (year < 100) {
        return year >= 70 ? 1900 + year : 2000 + year;
    }

    return year;
}

export function extractEventDate(value, {
    existingDate = '',
    referenceDate = new Date(),
} = {}) {
    if (validIsoDate(existingDate)) {
        return String(existingDate);
    }

    const text = normalizeSpaces(value).toLowerCase().replace(/ё/gu, 'е');
    // ISO remains the internal SQLite/AI field format (existingDate).
    // It is NOT accepted as a raw event-date string in VK post/OCR text.

    const numeric = text.match(
        /(?<![\d.\/:-])(0?[1-9]|[12]\d|3[01])\.(0?[1-9]|1[0-2])(?:\.(\d{2}|\d{4}))?(?![\d.\/:-])/u,
    );

    if (numeric) {
        const year = normalizeYear(
            numeric[3],
            referenceDate.getFullYear(),
        );
        const candidate = toIsoDate(year, Number(numeric[2]), Number(numeric[1]));

        if (candidate) {
            return candidate;
        }
    }

    const monthNames = [...MONTHS.keys()].sort((left, right) => right.length - left.length);
    const named = text.match(new RegExp(
        `(?:^|\\D)(0?[1-9]|[12]\\d|3[01])\\s+(${monthNames.join('|')})(?:\\s+(20\\d{2}|\\d{2}))?`,
        'iu',
    ));

    if (named) {
        const month = MONTHS.get(named[2].toLowerCase());
        const year = normalizeYear(
            named[3],
            referenceDate.getFullYear(),
        );
        return toIsoDate(year, month, Number(named[1]));
    }

    // Accept a spelled-out ordinal only when followed by an explicit month.
    const spoken = extractRawDateMentions(text).find((item) => /[а-яё]/iu.test(item.raw));
    if (spoken) {
        return toIsoDate(
            normalizeYear(spoken.explicitYear, referenceDate.getFullYear()),
            spoken.month, spoken.day,
        );
    }
    return '';
}

function normalizeTime(value) {
    const match = String(value ?? '').trim().match(/^([01]?\d|2[0-3]):([0-5]\d)$/u);

    if (!match) {
        return '';
    }

    return `${pad(match[1])}:${match[2]}`;
}

export function extractEventTime(value, existingTime = '') {
    const normalizedExisting = normalizeTime(existingTime);

    if (normalizedExisting) {
        return normalizedExisting;
    }

    const text = normalizeSpaces(value);
    const labelledPatterns = [
        /(?:начало|старт|начинаем|начн[её]тся)\s*(?:в|—|-|:|;|：)?\s*(?<!\d)([01]?\d|2[0-3])[:-]([0-5]\d)(?!\d)/iu,
        /(?:сбор|встречаемся|собираемся)\s*(?:в|—|-|:|;|：)?\s*(?<!\d)([01]?\d|2[0-3])[:-]([0-5]\d)(?!\d)/iu,
        /(?:двери|doors?)\s*(?:в|—|-|:|;|：)?\s*(?<!\d)([01]?\d|2[0-3])[:-]([0-5]\d)(?!\d)/iu,
        /(?:когда|время)\s*(?::|;|：|[—–-])\s*[^\n]{0,80}?(?<!\d)([01]?\d|2[0-3])[:-]([0-5]\d)(?!\d)/iu,
    ];

    for (const pattern of labelledPatterns) {
        const match = text.match(pattern);

        if (match) {
            return `${pad(match[1])}:${match[2]}`;
        }
    }

    // Only colon is unambiguous outside explicitly labelled time expressions.
    // Sentence punctuation after a normal 20:30. timestamp is allowed.
    const generic = text.match(/(?<!\d)([01]?\d|2[0-3]):(\d{2})(?!\d)/u);
    return generic ? `${pad(generic[1])}:${generic[2]}` : '';
}

function cleanMetadataValue(value, maximum = 700) {
    return normalizeSpaces(value)
        .replace(/^(?:где|место|адрес|площадка|цена|стоимость|поч[её]м|вход|билеты?)\s*:\s*/iu, '')
        .replace(/\s+(?:когда|кто|где|поч[её]м|цена|стоимость)\s*:.*$/iu, '')
        .trim()
        .slice(0, maximum);
}

export function extractEventVenue(value, existingVenue = '') {
    const existing = cleanMetadataValue(existingVenue, 700);

    if (existing) {
        return existing;
    }

    const text = normalizeSpaces(value);
    const labelled = text.match(
        /^(?:где|место|адрес|площадка)\s*:\s*([^\n]{2,240})$/imu,
    );

    if (labelled) {
        return cleanMetadataValue(labelled[1], 700);
    }

    for (const pattern of KNOWN_VENUES) {
        const match = text.match(pattern);

        if (match) {
            const venue = match[0]
                .replace(/^rock\s+bar\s+/iu, '')
                .replace(/^overlock$/iu, 'Overlock Bar');
            return cleanMetadataValue(venue, 700);
        }
    }

    const contextual = text.match(
        /(?:в|на)\s+(?:баре|клубе|площадке|пространстве|зале)\s+[«"]?([^\n,.!]{2,80})/iu,
    );

    return contextual ? cleanMetadataValue(contextual[1], 700) : '';
}

function isPriceLike(value) {
    return /(?:\d[\d\s]*(?:₽|руб(?:л(?:ей|я)?)?|р\.)|вход\s+(?:свобод|бесплат)|бесплатн|донат|free|по\s+регистрации)/iu.test(value);
}

export function extractEventPrice(value, existingPrice = '') {
    const existing = cleanMetadataValue(existingPrice, 700);

    if (existing) {
        return existing;
    }

    const text = normalizeSpaces(value);
    const lines = text.split('\n').map((line) => line.trim()).filter(Boolean);

    for (const line of lines) {
        if (
            /^(?:цена|стоимость|поч[её]м|вход|билеты?|донат)\s*[:—-]?/iu.test(line) &&
            isPriceLike(line)
        ) {
            return cleanMetadataValue(line, 700);
        }
    }

    const free = text.match(/\bвход\s+(?:свободный|бесплатный)|\bбесплатно\b/iu);

    if (free) {
        return free[0].replace(/^вход\s+/iu, 'Вход ');
    }

    const money = text.match(
        /(?:от\s+)?\d[\d\s]{0,7}\s*(?:₽|руб(?:л(?:ей|я)?)?|р\.)(?:\s*[-—–]\s*[^\n,.]{1,80})?/iu,
    );

    return money ? cleanMetadataValue(money[0], 700) : '';
}

export function extractAgeRestriction(value, existingAge = '') {
    const existing = String(existingAge ?? '').trim();

    if (/^(?:0|6|12|14|16|18|21)\+$/u.test(existing)) {
        return existing;
    }

    const match = normalizeSpaces(value).match(/(?:^|[^\d])(0|6|12|14|16|18|21)\+(?!\d)/u);
    return match ? `${match[1]}+` : '';
}

export function inferEventType(value, existingType = '') {
    const existing = String(existingType ?? '').trim();

    if (existing) {
        return existing.slice(0, 100);
    }

    const text = normalizeSpaces(value);

    for (const [label, pattern] of EVENT_TYPES) {
        if (pattern.test(text)) {
            return label;
        }
    }

    return '';
}

export function extractEventParticipants(value, existingParticipants = '') {
    const existing = cleanMetadataValue(existingParticipants, 1200);

    if (existing) {
        return existing;
    }

    const text = normalizeSpaces(value);
    const labelled = text.match(/^кто\s*:\s*([^\n]{2,500})$/imu);

    if (labelled) {
        return cleanMetadataValue(labelled[1], 1200);
    }

    const support = text.match(
        /при\s+поддержке\s*:\s*([^\n]{2,500}(?:\n(?!\s*(?:двери|билеты|цена|вход|адрес|где)\b)[^\n]{2,120}){0,4})/iu,
    );

    return support
        ? cleanMetadataValue(support[1].replace(/\n+/gu, ', '), 1200)
        : '';
}

function normalizeComparableUrl(value) {
    const raw = String(value ?? '')
        .trim()
        .replace(/[),.;!?]+$/gu, '');

    if (!raw) {
        return '';
    }

    const withProtocol = /^https?:\/\//iu.test(raw)
        ? raw
        : `https://${raw}`;

    try {
        const url = new URL(withProtocol);
        const host = url.hostname.toLowerCase().replace(/^m\./u, '');
        const pathname = url.pathname.replace(/\/+$/u, '');
        return `${host}${pathname}${url.search}`.toLowerCase();
    } catch {
        return raw.toLowerCase();
    }
}

export function extractContentLinks(value) {
    const text = String(value ?? '');
    const matches = text.match(
        /(?:https?:\/\/[^\s<>()]+|(?:vk\.cc|t\.me|vk\.(?:com|ru))\/[\w?=&%./-]+)/giu,
    ) ?? [];
    const result = [];

    for (const match of matches) {
        const normalized = normalizeComparableUrl(match);

        if (!normalized || result.includes(normalized)) {
            continue;
        }

        result.push(normalized);
    }

    return result;
}

export function enrichEventMetadata(event, options = {}) {
    const source = [
        event?.title,
        event?.participants,
        event?.venue,
        event?.price,
        event?.description,
        event?.evidence,
    ].filter(Boolean).join('\n');

    const eventDate = extractEventDate(source, {
        existingDate: event?.eventDate,
        referenceDate: options.referenceDate,
    });
    const eventTime = extractEventTime(source, event?.eventTime);
    const venue = extractEventVenue(source, event?.venue);
    const price = extractEventPrice(source, event?.price);
    const participants = extractEventParticipants(source, event?.participants);
    const ageRestriction = extractAgeRestriction(source, event?.ageRestriction);
    const eventType = inferEventType(source, event?.eventType);
    const contentLinks = [...new Set([
        ...(Array.isArray(event?.contentLinks) ? event.contentLinks : []),
        ...extractContentLinks(source),
    ])];

    return {
        ...event,
        eventDate: eventDate || String(event?.eventDate ?? ''),
        eventTime: eventTime || null,
        venue,
        price,
        participants,
        ageRestriction,
        eventType,
        contentLinks,
    };
}

export const eventMetadataInternals = {
    normalizeComparableUrl,
    normalizeSpaces,
    validIsoDate,
};
