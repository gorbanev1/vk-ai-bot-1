import { extractEventTime } from './eventMetadata.js';
import { extractExplicitDates } from './publicPostDateEvidence.js';
import { classifyEventSourceUrl } from './eventSourceLink.js';

const UNKNOWN_VALUE_PATTERN = /^(?:[-—–]+|нет|неизвестно|неизвестен|неизвестна|неизвестное|не\s+указан(?:о|а)?|не\s+уточнен(?:о|а)?|не\s+определен(?:о|а)?|unknown|tbd|n\/a)$/iu;
const GENERIC_CITY_ONLY_PATTERN = /^(?:г\.?\s*)?(?:воронеж|москва|санкт[- ]?петербург|спб)$/iu;
const DEFERRED_VENUE_PATTERN = /(?:место|локаци|адрес|площадк|точк[ау]|координат)[^\n]{0,90}(?:в\s+день|день\s+в\s+день|позже|перед\s+(?:началом|мероприятием|стартом)|будет\s+(?:объявлен|сообщен|уточнен)|сообщим|объявим|уточним)|(?:в\s+день|позже|перед\s+(?:началом|мероприятием|стартом))[^\n]{0,90}(?:место|локаци|адрес|площадк|координат)|секретн(?:ая|ой)\s+локаци/iu;
const GENERIC_TITLE_PATTERN = /^(?:музыкальное\s+мероприятие|мероприятие|событие|туса|тусовка|концерт|вечеринка)$/iu;


/**
 * A fresh event-source URL must escape a pending proposal review/edit state.
 * VK/Telegram links are always considered new source material. Other HTTP URLs
 * are treated as a restart only when the message is effectively just the URL,
 * so a correction such as "место: https://maps..." is not stolen accidentally.
 */
export function extractEventProposalRestartSource(value) {
    const source = String(value ?? '').replace(/\u00a0/gu, ' ').trim();
    if (!source) return null;

    const urls = [...new Set(
        [...source.matchAll(/https?:\/\/[^\s<>"']+/giu)]
            .map((match) => String(match[0] || '').replace(/[),.;!?]+$/u, ''))
            .filter(Boolean),
    )].slice(0, 3);
    if (!urls.length) return null;

    for (const url of urls) {
        const descriptor = classifyEventSourceUrl(url);
        if (descriptor.platform === 'vk' || descriptor.platform === 'telegram') {
            return { url, descriptor, reason: `${descriptor.platform}-source-link` };
        }
    }

    const remainder = source
        .replace(/https?:\/\/[^\s<>"']+/giu, ' ')
        .replace(/[\s,.;:!?()\[\]{}«»"'—–-]+/gu, '')
        .trim();
    if (!remainder) {
        const url = urls[0];
        return { url, descriptor: classifyEventSourceUrl(url), reason: 'standalone-http-link' };
    }

    return null;
}

function clean(value, maximum = 5000) {
    return String(value ?? '')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, maximum);
}

function normalizeIsoDate(value) {
    const source = clean(value, 32);
    const match = source.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (!match) return '';
    const year = Number(match[1]);
    const month = Number(match[2]);
    const day = Number(match[3]);
    const date = new Date(Date.UTC(year, month - 1, day));
    if (
        date.getUTCFullYear() !== year ||
        date.getUTCMonth() !== month - 1 ||
        date.getUTCDate() !== day
    ) {
        return '';
    }
    return `${match[1]}-${match[2]}-${match[3]}`;
}

export function normalizeEventProposalDraftEvent(event = {}) {
    const eventDate = normalizeIsoDate(event?.eventDate ?? event?.date);
    const rawTime = clean(event?.eventTime ?? event?.time, 32);
    const eventTime = /^([01]\d|2[0-3]):[0-5]\d$/u.test(rawTime)
        ? rawTime
        : null;

    return {
        ...event,
        title: clean(event?.title, 500),
        eventDate,
        eventTime,
        venue: clean(event?.venue, 500),
        participants: clean(event?.participants, 2000),
        price: clean(event?.price, 700),
        description: clean(event?.description ?? event?.announcement, 6000),
        evidence: clean(event?.evidence, 1000),
        sourceUrl: clean(event?.sourceUrl, 2000),
        sourceText: clean(event?.sourceText, 16000),
        imagePaths: Array.isArray(event?.imagePaths)
            ? event.imagePaths.map((value) => clean(value, 2000)).filter(Boolean).slice(0, 10)
            : [],
        eventTags: [...new Set((Array.isArray(event?.eventTags) ? event.eventTags : Array.isArray(event?.tags) ? event.tags : [])
            .map((value) => clean(value, 80))
            .filter(Boolean))].slice(0, 16),
    };
}

export function isDeferredVenueStatement(value) {
    const venue = clean(value, 500);
    return Boolean(venue && DEFERRED_VENUE_PATTERN.test(venue));
}

export function hasUsableVenueStatement(value) {
    const venue = clean(value, 500);
    if (!venue || UNKNOWN_VALUE_PATTERN.test(venue) || GENERIC_CITY_ONLY_PATTERN.test(venue)) {
        return false;
    }
    return true;
}

export function analyzeEventProposalDraft(event, {
    referenceDate = '',
} = {}) {
    const normalized = normalizeEventProposalDraftEvent(event);
    const missingRequired = [];
    const missingOptional = [];
    const blocking = [];

    if (!normalized.eventDate) {
        missingRequired.push('date');
    } else if (referenceDate && normalized.eventDate < referenceDate) {
        blocking.push('past_date');
    }

    if (!hasUsableVenueStatement(normalized.venue)) {
        missingRequired.push('venue');
    }

    if (!normalized.eventTime) missingOptional.push('time');
    if (!normalized.title || GENERIC_TITLE_PATTERN.test(normalized.title)) missingOptional.push('title');
    if (!normalized.participants) missingOptional.push('participants');
    if (!normalized.price) missingOptional.push('price');

    return {
        event: normalized,
        missingRequired,
        missingOptional,
        blocking,
        canSubmit: missingRequired.length === 0 && blocking.length === 0,
        venueDeferred: isDeferredVenueStatement(normalized.venue),
    };
}

export function analyzeEventProposalDrafts(events, options = {}) {
    const analyses = (Array.isArray(events) ? events : [])
        .map((event) => analyzeEventProposalDraft(event, options));
    return {
        analyses,
        canSubmit: analyses.length > 0 && analyses.every((item) => item.canSubmit),
        hasRequiredMissing: analyses.some((item) => item.missingRequired.length > 0),
        hasOptionalMissing: analyses.some((item) => item.missingOptional.length > 0),
        hasBlocking: analyses.some((item) => item.blocking.length > 0),
    };
}

function parseCorrectionDate(value, referenceTimestampSeconds) {
    const source = clean(value, 200);
    const iso = normalizeIsoDate(source);
    if (iso) return iso;
    const dates = extractExplicitDates(source, referenceTimestampSeconds);
    return dates[0] || '';
}

function parseCorrectionValue(label, value, referenceTimestampSeconds) {
    const source = clean(value, 4000);
    switch (label) {
    case 'date':
        return parseCorrectionDate(source, referenceTimestampSeconds);
    case 'time':
        return extractEventTime(`Время: ${source}`) || null;
    case 'title':
        return clean(source, 500);
    case 'venue':
        return clean(source, 500);
    case 'participants':
        return clean(source, 2000);
    case 'price':
        return clean(source, 700);
    case 'description':
        return clean(source, 6000);
    default:
        return source;
    }
}

const FIELD_ALIASES = new Map([
    ['дата', 'date'], ['когда', 'date'],
    ['время', 'time'], ['начало', 'time'], ['старт', 'time'], ['двери', 'time'],
    ['место', 'venue'], ['где', 'venue'], ['адрес', 'venue'], ['локация', 'venue'], ['площадка', 'venue'],
    ['название', 'title'], ['что', 'title'], ['событие', 'title'], ['мероприятие', 'title'],
    ['участники', 'participants'], ['кто', 'participants'], ['лайнап', 'participants'], ['лайн-ап', 'participants'], ['lineup', 'participants'], ['line-up', 'participants'],
    ['цена', 'price'], ['стоимость', 'price'], ['вход', 'price'], ['билеты', 'price'], ['почем', 'price'], ['почём', 'price'],
    ['описание', 'description'], ['анонс', 'description'],
]);

/**
 * Разбирает пользовательскую правку черновика. Поддерживает:
 *   «время: 19:00»
 *   «2 место: DIESEL Hall»
 *   «событие 3 дата 5 сентября 2026»
 * Несколько полей можно прислать отдельными строками.
 */
export function parseEventProposalCorrections(value, {
    referenceTimestampSeconds = Math.floor(Date.now() / 1000),
} = {}) {
    const source = String(value ?? '')
        .replace(/\u00a0/gu, ' ')
        .trim();
    if (!source) return [];

    const corrections = [];
    const lines = source.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
    const aliases = [...FIELD_ALIASES.keys()]
        .sort((left, right) => right.length - left.length)
        .map((name) => name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&'))
        .join('|');
    const pattern = new RegExp(
        `^(?:(?:#?([1-9]\\d*)|событие\\s+#?([1-9]\\d*))\\s*[).:-]?\\s*)?(${aliases})\\s*(?::|=|—|–|-)?\\s+(.+)$`,
        'iu',
    );

    for (const line of lines) {
        const match = line.match(pattern);
        if (!match) continue;
        const field = FIELD_ALIASES.get(String(match[3]).toLowerCase().replace(/ё/gu, 'е'))
            || FIELD_ALIASES.get(String(match[3]).toLowerCase());
        if (!field) continue;
        const parsedValue = parseCorrectionValue(field, match[4], referenceTimestampSeconds);
        if (field === 'date' && !parsedValue) continue;
        if (field === 'time' && !parsedValue) continue;
        corrections.push({
            eventIndex: Number(match[1] || match[2] || 0) || 0,
            field,
            value: parsedValue,
            raw: line,
        });
    }

    return corrections;
}

export function applyEventProposalCorrections(events, corrections) {
    const result = (Array.isArray(events) ? events : [])
        .map((event) => normalizeEventProposalDraftEvent(event));
    const safeCorrections = Array.isArray(corrections) ? corrections : [];

    for (const correction of safeCorrections) {
        const targetIndexes = correction.eventIndex > 0
            ? [correction.eventIndex - 1]
            : result.length === 1
                ? [0]
                : [];
        for (const index of targetIndexes) {
            if (!result[index]) continue;
            const key = ({
                date: 'eventDate',
                time: 'eventTime',
                title: 'title',
                venue: 'venue',
                participants: 'participants',
                price: 'price',
                description: 'description',
            })[correction.field];
            if (!key) continue;
            result[index] = {
                ...result[index],
                [key]: correction.value,
            };
        }
    }

    return result;
}
