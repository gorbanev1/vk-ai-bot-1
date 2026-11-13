import { validateSharedEventSchedule, validateTheaterRepertoireSchedule, validateScheduleCardinality, selectDateProgramSegment } from './sharedEventSchedule.js';
import { parseIndexedImageFacts } from './eventPosterMatching.js';
/**
 * Pure local parser for public Telegram/VK announcement text.
 *
 * This module intentionally has no browser/database imports so parser regressions
 * can be exercised directly with unit tests.
 */
import {
    explainEventAiAdmissionWithPosterFacts,
} from './eventAiAdmission.js';
import {
    sanitizeEventBodyText,
} from './eventTextSanitation.js';

import {
    cleanEventTitle,
    paragraphizeEventText,
} from './eventText.js';

import {
    extractEventTime,
} from './eventMetadata.js';

import {
    inferEventVenueFromText,
} from './eventVenueInference.js';

import {
    explainStrictEventRecord,
    isStrictEventRecord,
    sourceContainsEvidence,
    normalizeEventEvidence,
} from './eventValidation.js';

import {
    extractExplicitDateMentions,
    extractExplicitDates,
    extractEventDateRanges,
    extractRawDateMentions,
    normalizeEventYear as normalizeYear,
    toIsoEventDate as toIsoDate,
} from './publicPostDateEvidence.js';
import {
    extractDateSpecificAnnouncementSegment,
} from './eventMultiAnnouncementBlocks.js';
import { acceptedDateFreePoster } from './dateFreeEventEvidence.js';
import { getLocalDateString } from '../../shared/date.js';
import { inferEventSearchTags } from './eventSearchTaxonomy.js';

function scoreEventDateMention(text, mention) {
    const source = String(text ?? '');
    const before = source.slice(Math.max(0, mention.index - 130), mention.index);
    const after = source.slice(
        mention.index + mention.length,
        mention.index + mention.length + 180,
    );
    const context = `${before} ${after}`.toLowerCase();
    let score = 0;

    if (mention.index < 280) score += 2;
    if (/^\s*[—–-]\s*[^\n.!?]{2,160}/u.test(after)) score += 8;
    if (/(?:концерт|мероприят|вечерин|тус|party|gothic|гиг|фест|выступ|шоу|состоится|начало|двери|doors|live|hall|клуб|бар|встреча|спектакл|показ)/iu.test(context)) {
        score += 5;
    }
    if (/(?:итог|результат|конкурс|розыгрыш|победител|опублик|дедлайн|при[её]м\s+заявок|регистрац(?:ия|ии)?\s+до|продаж(?:а|и)?\s+до|успей(?:те)?\s+до)/iu.test(context)) {
        score -= 10;
    }
    if (/(?:итоги\s+конкурса|результаты\s+розыгрыша)[^\n.!?]{0,80}$/iu.test(before)) {
        score -= 12;
    }

    return score;
}

function choosePrimaryEventDateMentions(post) {
    const mentions = extractExplicitDateMentions(post.text, post.publishedAt, { referenceNow: post?.referenceNow });

    if (mentions.length <= 1) {
        return mentions;
    }

    const scored = mentions.map((mention) => ({
        ...mention,
        score: scoreEventDateMention(post.text, mention),
    })).sort((left, right) => (
        right.score - left.score || left.index - right.index
    ));
    const eventMentions = scored
        .filter((mention) => Number(mention.score || 0) >= 0)
        .sort((left, right) => left.index - right.index);

    // Keep all positively supported event dates for the local fallback.
    // Non-event dates (publication deadlines, contest dates, etc.) remain
    // filtered by the score gate; if every date is weak, retain the strongest
    // single mention for backwards-compatible admission.
    return eventMentions.length ? eventMentions : (scored[0] ? [scored[0]] : []);
}

const SOURCE_HEADING_PATTERNS = [
    /^rock\s+bar\s+diesel(?:\s*&\s*diesel\s+hall)?$/iu,
    /^(?:overlock|overlock\s+bar)$/iu,
    /^рок-?бар\s+[«"]?the\s+last\s+of\s+vavilone[»"]?$/iu,
    /^liverpool\s+pub$/iu,
    /^паб\s+мама\s+анархия$/iu,
    /^митбоулинг\s+клуб$/iu,
];

const TITLE_JUNK_PATTERNS = [
    /^действия$/iu,
    /^и$/iu,
    /^ещ[её]\s+\d+\s+автор(?:а|ов)?$/iu,
    /^показать\s+ещ[её]$/iu,
    /^мероприятие$/iu,
    /^афиша$/iu,
    /^открыть\s+(?:пост|приложение)$/iu,
    /^подробнее$/iu,
    /^полный\s+список$/iu,
    /^(?:участники|кто|цена|стоимость|вход|место|адрес|площадка|локация|дата|время|начало|старт)$/iu,
    /^(?:билеты?|вход|регистрация|подробнее|ссылка)(?:\s|:|[—–-]|$).*(?:https?:\/\/|ticketscloud|qtickets|vk\.cc|t\.me)/iu,
];

const RUSSIAN_MONTH_WORD = '(?:январ(?:я|ь)|феврал(?:я|ь)|март(?:а)?|апрел(?:я|ь)|ма(?:я|й)|июн(?:я|ь)|июл(?:я|ь)|август(?:а)?|сентябр(?:я|ь)|октябр(?:я|ь)|ноябр(?:я|ь)|декабр(?:я|ь))';
const DATE_TIME_ONLY_TITLE_RE = new RegExp(
    `^\\s*\\d{1,2}\\s+${RUSSIAN_MONTH_WORD}(?:\\s+20\\d{2})?(?:\\s*[,;]\\s*|\\s+)(?:в\\s*)?(?:[01]?\\d|2[0-3]):[0-5]\\d\\s*$`,
    'iu',
);
const INLINE_SCHEDULE_RE = new RegExp(
    `^\\s*(\\d{1,2}(?:\\s*[—–-]\\s*\\d{1,2})?\\s+${RUSSIAN_MONTH_WORD}(?:\\s+20\\d{2})?|\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2,4})?)\\s*[,;]?\\s*(?:(?:в\\s*)?((?:[01]?\\d|2[0-3]):[0-5]\\d))?\\s*[—–-]\\s*(.+?)\\s*$`,
    'iu',
);
const INLINE_CONTEXT_HYPHEN_SCHEDULE_RE = new RegExp(
    `^\\s*(\\d{1,2}(?:\\s*[—–-]\\s*\\d{1,2})?\\s+${RUSSIAN_MONTH_WORD}(?:\\s+20\\d{2})?|\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2,4})?)\\s*[,;]?\\s*(?:начало|старт|двери|сбор|время)\\s*(?::|[—–-]|в)?\\s*((?:[01]?\\d|2[0-3])-[0-5]\\d)\\s*[—–-]\\s*(.+?)\\s*$`,
    'iu',
);

function extractDateAdjacentEventTime(text) {
    for (const rawLine of String(text ?? '').split(/\n+/u)) {
        const line = rawLine.trim();
        if (!DATE_TIME_ONLY_TITLE_RE.test(line)) continue;
        const match = line.match(/(?:[,;]\s*|\s+)(?:в\s*)?([01]?\d|2[0-3]):(\d{2})\s*$/u);
        if (match) return `${String(match[1]).padStart(2, '0')}:${match[2]}`;
    }
    return '';
}

function isMetadataLabelLine(line) {
    return /^(?:когда|дата|время|начало|старт|где|место|адрес|площадка|кто|участники|лайн-?ап|line[ -]?up|что|название|мероприятие|событие|поч[её]м|цена|стоимость|вход|билеты?)\s*(?::|;|：|[—–-])/iu.test(String(line ?? '').trim());
}

function isUsableTitleLine(line) {
    const value = cleanEventTitle(line, 220);

    return Boolean(
        value.length >= 3 &&
        !isMetadataLabelLine(value) &&
        !SOURCE_HEADING_PATTERNS.some((pattern) => pattern.test(value)) &&
        !TITLE_JUNK_PATTERNS.some((pattern) => pattern.test(value)) &&
        !DATE_TIME_ONLY_TITLE_RE.test(value) &&
        !/^\d{1,2}\.\d{1,2}(?:\.\d{2,4})?(?:\s+\d{1,2}:\d{2})?$/u.test(value)
    );
}

function inferTitleFromDate(post, mention, lines) {
    const source = String(post.text ?? '');
    // Prefer the meaningful prefix on the SAME line before the date. This is
    // essential for ISO dates and ranges: "Фестиваль 20–22 сентября" must
    // yield "Фестиваль", not the range tail "22 сентября ...".
    const lineStart = source.lastIndexOf('\n', Math.max(0, mention.index - 1)) + 1;
    let lineEnd = source.indexOf('\n', mention.index + mention.length);
    if (lineEnd < 0) lineEnd = source.length;
    const linePrefix = source.slice(lineStart, mention.index)
        .replace(/(?:когда|дата)\s*(?::|;|：|[—–-])?\s*$/iu, '')
        .replace(/[|·,:;—–-]+\s*$/u, '')
        .trim();
    if (linePrefix && isUsableTitleLine(linePrefix)) {
        return cleanEventTitle(linePrefix, 220);
    }

    const after = source.slice(
        mention.index + mention.length,
        mention.index + mention.length + 260,
    );
    const afterSeparator = after.match(/^\s*[—–-]\s*([^\n.!?]{2,220})/u)?.[1] ?? '';
    const cleanedAfter = afterSeparator
        .split(/\b(?:друзья|уникальная|для\s+этого|итоги|купить\s+билет|подробности|билеты)\b/iu)[0]
        .replace(/\s{2,}/gu, ' ')
        .trim();

    if (cleanedAfter.length >= 2 && isUsableTitleLine(cleanedAfter)) {
        return cleanEventTitle(cleanedAfter, 220);
    }

    const lineWithDate = lines.find((line) => line.toLowerCase().includes(String(mention.raw ?? '').toLowerCase()));
    const fromLine = lineWithDate?.match(/[—–-]\s*(.+)$/u)?.[1] ?? '';

    if (fromLine && isUsableTitleLine(fromLine)) {
        return cleanEventTitle(fromLine, 220);
    }

    // Если дата встроена в само название («RAMMSTEIN Воронеж 4 Сентября ...»),
    // сохраняем всю строку: обрезание только хвоста после даты давало мусорные
    // заголовки либо UI-слова.
    if (lineWithDate && isUsableTitleLine(lineWithDate)) {
        return cleanEventTitle(lineWithDate, 220);
    }

    return cleanEventTitle(
        lines.find((line) => isUsableTitleLine(line)) || '',
        220,
    );
}

function refineKnownVenue({ post, title, venue }) {
    void post;
    const cleanTitle = cleanEventTitle(title, 220);
    const cleanVenue = trimEventValue(venue, 500);

    return {
        title: cleanTitle,
        venue: cleanVenue,
    };
}

function parseDateTimeField(value, publishedAt) {
    const source = String(value ?? '').trim();
    const dates = extractExplicitDates(source, publishedAt);

    return {
        date: dates[0] ?? null,
        time: extractEventTime(source) || null,
    };
}

function escapeRegex(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function extractBestVenueLabel(text) {
    const source = String(text ?? '');
    const pattern = /^(?:где|место|адрес|площадка|локаци(?:я|и)|venue)\s*(?::|;|：|[—–-])\s*(.+)$/gimu;
    const genericCity = /^(?:г\.?\s*)?(?:воронеж|москва|санкт[- ]?петербург|спб)$/iu;
    for (const match of source.matchAll(pattern)) {
        const value = trimEventValue(match[1] || '', 500)
            .replace(/\(\s*https?:\/\/[^)]+\)/giu, ' ')
            .replace(/https?:\/\/\S+/giu, ' ')
            .replace(/\s{2,}/gu, ' ')
            .replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/gu, '')
            .trim();
        if (!value || genericCity.test(value)) continue;
        return value;
    }
    return '';
}

function extractLabel(text, labels) {
    const names = (Array.isArray(labels) ? labels : [labels])
        .map((label) => String(label ?? '').trim())
        .filter(Boolean)
        .map(escapeRegex);

    if (!names.length) {
        return '';
    }

    const pattern = new RegExp(
        `^(?:${names.join('|')})\\s*(?::|;|：|[—–-])\\s*(.+)$`,
        'imu',
    );
    return String(text ?? '').match(pattern)?.[1]?.trim() ?? '';
}

function firstUsableTitleLine(text) {
    return String(text ?? '')
        .split(/\n+/u)
        .map((line) => line.trim())
        .find((line) => isUsableTitleLine(line)) || '';
}

function trimEventValue(value, maximum = 2000) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, maximum);
}

function trimEventDescription(value, maximum = 5000) {
    return paragraphizeEventText(value, maximum);
}


function normalizePriceValue(value) {
    const withoutLinks = trimEventValue(value, 700)
        .replace(/(?:https?:\/\/|www\.)\S+/giu, '')
        .replace(/\b(?:vk\.cc|t\.me|qtickets\.[a-z]+|ticketscloud\.[a-z]+|band\.link)\/\S*/giu, '')
        .replace(/\s{2,}/gu, ' ')
        .replace(/^[\s,;:—–-]+|[\s,;:—–-]+$/gu, '')
        .trim();

    if (!withoutLinks) {
        return '';
    }

    return /(?:\d[\d\s]*(?:₽|р(?:\.|\b)|руб(?:л(?:ей|я)?)?)|бесплат|свободн(?:ый|о)|донат|free|нипоч[её]м|репост|респект|по\s+регистрации)/iu.test(withoutLinks)
        ? withoutLinks.slice(0, 500)
        : '';
}


function inferInlineVenueFromSchedule(text) {
    const month = RUSSIAN_MONTH_WORD;
    const dateToken = `(?:\\d{1,2}\\s+${month}(?:\\s+20\\d{2})?|\\d{1,2}\.\\d{1,2}(?:\.\\d{2,4})?)`;
    const beforeDate = new RegExp(
        `^\\s*([^,;|]{2,100}?)\\s*[,;|]\\s*${dateToken}(?:\\s+(?:в\\s*)?(?:[01]?\\d|2[0-3]):\\d{2})?[.!]?\\s*$`,
        'iu',
    );
    const afterDate = new RegExp(
        `^\\s*${dateToken}(?:\\s+(?:в\\s*)?(?:[01]?\\d|2[0-3]):\\d{2})?\\s*[,;|]\\s*([^,;|]{2,100}?)[.!]?\\s*$`,
        'iu',
    );
    const reject = /(?:https?:\/\/|www\.|билет|цена|стоим|вход|регистрац|начало|дата|время|участник|лайн|афиша|событие|мероприятие)/iu;
    const dotClockCandidate = /^\d{1,2}\.\d{2}\s*(?:[—–-]|$)/u;

    for (const rawLine of String(text ?? '').split(/\n+/u)) {
        const line = rawLine.replace(/\s+/gu, ' ').trim();
        if (!line || line.length > 180) continue;
        const match = line.match(beforeDate) || line.match(afterDate);
        const candidate = trimEventValue(match?.[1] || '', 120)
            .replace(/^[—–-]+|[—–-]+$/gu, '')
            .trim();
        if (
            candidate.length >= 2 &&
            candidate.length <= 100 &&
            /[\p{L}]/u.test(candidate) &&
            !reject.test(candidate) &&
            !dotClockCandidate.test(candidate) &&
            !DATE_TIME_ONLY_TITLE_RE.test(candidate)
        ) {
            return candidate;
        }
    }
    return '';
}

function inferCompactParticipantBlock(text) {
    const lines = String(text ?? '')
        .split(/\n+/u)
        .map((line) => line.trim())
        .filter(Boolean);
    if (!lines.length) return '';

    const stop = /^(?:когда|дата|время|начало|старт|двери|где|место|адрес|площадка|поч[её]м|сколько|цена|стоимость|вход|билеты?|источник)\s*(?::|;|：|[—–-]|$)/iu;
    const reject = /(?:https?:\/\/|www\.|\b(?:когда|дата|время|начало|старт|двери|место|адрес|площадка|цена|стоимость|вход|билет|источник)\b|\b\d{1,2}\.\d{1,2}|\b\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр))/iu;
    const looksLikeArtistLine = (value) => {
        const clean = trimEventValue(value, 180)
            .replace(/^[•*—–-]+\s*/u, '')
            .replace(/[;,]+$/gu, '')
            .trim();
        if (clean.length < 2 || clean.length > 120 || !/[\p{L}]/u.test(clean)) return '';
        if (reject.test(clean) || isMetadataLabelLine(clean)) return '';
        if (clean.split(/\s+/u).length > 10) return '';
        if (/[.!?]\s+\p{L}/u.test(clean)) return '';
        return clean;
    };

    const blocks = [];
    let current = [];
    const flush = () => {
        if (current.length >= 2) blocks.push(current);
        current = [];
    };

    for (let index = 0; index < lines.length; index += 1) {
        let line = lines[index];
        const descriptionMatch = line.match(/^(?:описание|анонс)\s*(?::|;|：|[—–-])\s*(.*)$/iu);
        if (descriptionMatch) {
            flush();
            const first = looksLikeArtistLine(descriptionMatch[1] || '');
            if (first) current.push(first);
            continue;
        }
        if (stop.test(line)) {
            flush();
            continue;
        }
        const candidate = looksLikeArtistLine(line);
        if (candidate) current.push(candidate);
        else flush();
        if (current.length >= 12) flush();
    }
    flush();

    if (!blocks.length) return '';
    blocks.sort((left, right) => right.length - left.length);
    return blocks[0].slice(0, 12).join('; ');
}

function inferBulletParticipants(text) {
    const candidates = [];
    const reject = /(?:https?:\/\/|www\.|билет|цена|стоим|вход|регистрац|когда|дата|время|начало|старт|место|адрес|площадка|\b\d{1,2}\.\d{1,2}|\b\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр))/iu;
    for (const rawLine of String(text ?? '').split(/\n+/u)) {
        const match = rawLine.match(/^\s*[-•—–]\s*(.+?)\s*$/u);
        if (!match) continue;
        const value = trimEventValue(match[1], 160)
            .replace(/[;,]+$/gu, '')
            .trim();
        if (
            value.length < 2 ||
            value.length > 120 ||
            !/[\p{L}]/u.test(value) ||
            reject.test(value) ||
            isMetadataLabelLine(value)
        ) continue;
        candidates.push(value);
        if (candidates.length >= 12) break;
    }
    return candidates.length >= 2 ? candidates.join('; ') : '';
}

function providedPostEventTitle(post) {
    const value = cleanEventTitle(post?.eventTitle || '', 220);
    return value && isUsableTitleLine(value) ? value : '';
}

function parseStructuredEvent(post) {
    const when = extractLabel(post.text, ['когда', 'дата']);

    if (!when) {
        return [];
    }

    const dates = extractExplicitDates(when, post.publishedAt, { referenceNow: post?.referenceNow });

    if (!dates.length) {
        return [];
    }

    const separateTime = extractLabel(post.text, ['время', 'начало', 'старт', 'двери']);
    const eventTime = extractEventTime(
        [when, separateTime ? `Начало: ${separateTime}` : ''].filter(Boolean).join('\n'),
    ) || null;
    const title =
        extractLabel(post.text, ['что', 'название', 'мероприятие', 'событие']) ||
        '';
    const participants = extractLabel(post.text, [
        'кто',
        'участники',
        'лайн-ап',
        'лайнап',
        'line-up',
        'lineup',
    ]) || inferBulletParticipants(post.text) || inferCompactParticipantBlock(post.text);
    const venue = extractBestVenueLabel(post.text) ||
        inferInlineVenueFromSchedule(post.text) ||
        inferEventVenueFromText(post.text).venue;
    const price = extractLabel(post.text, [
        'почем',
        'почём',
        'сколько',
        'цена',
        'стоимость',
        'вход',
        'билет',
        'билеты',
    ]);
    const refined = refineKnownVenue({
        post,
        title: title || providedPostEventTitle(post) || participants || firstUsableTitleLine(post.text) || '',
        venue,
    });

    // A calendar card represents one concrete day. A range in the source is
    // therefore expanded into one card per day; lineage/source text can still
    // preserve that the cards came from one multi-day announcement.
    const rangeLike = dates.length > 1 && /\d{1,2}\.\d{1,2}(?:\.\d{2,4})?\s*[-–—]\s*\d{1,2}\.\d{1,2}/u.test(when);
    const selectedDates = dates.slice(0, 12);

    return selectedDates.map((date, index) => ({
        title: trimEventValue(refined.title, 500),
        eventDate: date,
        eventTime,
        venue: trimEventValue(refined.venue, 500),
        participants: trimEventValue(participants, 2000),
        price: normalizePriceValue(price),
        description: trimEventDescription(
            extractDateSpecificAnnouncementSegment(post.text, date, {
                publishedAt: post.publishedAt, referenceNow: post?.referenceNow,
            }) || post.text,
            5000,
        ),
        sourceSegment: extractDateSpecificAnnouncementSegment(post.text, date, {
            publishedAt: post.publishedAt, referenceNow: post?.referenceNow,
        }),
        evidence: trimEventValue(when, 500),
        parseMethod: rangeLike
            ? 'local_structured_v15_range_day'
            : index === 0
                ? 'local_structured_v14'
                : 'local_structured_v14_multi_date',
        status: 'approved',
    }));
}

function parseLabeledScheduleEvents(post) {
    const lines = String(post.text ?? '')
        .split(/\n+/u)
        .map((line) => line.trim())
        .filter(Boolean);
    const events = [];
    let currentDate = '';

    for (const line of lines) {
        const dateOnly = /^\d{1,2}\.\d{1,2}(?:\.\d{2,4})?$/u;
        // RUSSIAN_MONTH_WORD is a pattern string, therefore use an explicit
        // RegExp here rather than the literal above when month names appear.
        const namedDateOnly = new RegExp(`^\\d{1,2}\\s+${RUSSIAN_MONTH_WORD}(?:\\s+20\\d{2})?$`, 'iu');
        if (dateOnly.test(line) || namedDateOnly.test(line)) {
            currentDate = extractExplicitDates(line, post.publishedAt, { referenceNow: post?.referenceNow })[0] || '';
            continue;
        }

        if (!currentDate) continue;
        const labeled = line.match(/^(HALL|BAR|CLUB|PUB|ЗАЛ|СЦЕНА)\s*:\s*(.{2,700})$/iu);
        if (!labeled) continue;

        const label = String(labeled[1] || '').toUpperCase();
        const rawTitle = trimEventValue(labeled[2] || '', 600);
        if (!rawTitle || !/[\p{L}\p{N}]/u.test(rawTitle)) continue;

        let venue = label;
        const source = String(post?.screenName ?? '').toLowerCase();
        if (source === 'rb_diesel') {
            venue = label === 'HALL' || label === 'ЗАЛ' ? 'Diesel Hall' : 'Diesel Rock Bar';
        }
        const refined = refineKnownVenue({ post, title: rawTitle, venue });
        events.push({
            title: refined.title,
            eventDate: currentDate,
            eventTime: extractEventTime(rawTitle) || null,
            venue: trimEventValue(refined.venue, 500),
            participants: trimEventValue(rawTitle, 1000),
            price: '',
            description: trimEventDescription(line, 1200),
            evidence: trimEventValue(line, 500),
            parseMethod: 'local_labeled_schedule_v18861',
            status: 'approved',
        });
    }

    return events.slice(0, 30);
}

function parseDigestEvents(post) {
    const lines = String(post.text ?? '')
        .split(/\n+/u)
        .map((line) => line.trim())
        .filter(Boolean);
    const events = [];
    let currentDate = null;

    for (const line of lines) {
        const exactDate = line.match(
            /^(\d{1,2})\.(\d{1,2})\.(\d{2,4})$/u,
        );

        if (exactDate) {
            const year = normalizeYear(exactDate[3]);
            currentDate = year
                ? toIsoDate(
                    year,
                    Number(exactDate[2]),
                    Number(exactDate[1]),
                )
                : null;
            continue;
        }

        if (!currentDate) {
            continue;
        }

        const separator = line.match(/^(.{2,120}?)\s+[—–-]\s+(.{2,500})$/u);

        if (!separator) {
            continue;
        }

        const venue = trimEventValue(separator[1], 500);
        const title = trimEventValue(separator[2], 500);

        if (
            /^(когда|кто|где|почем|цена)$/iu.test(venue) ||
            title.includes('http')
        ) {
            continue;
        }

        events.push({
            title,
            eventDate: currentDate,
            eventTime: null,
            venue,
            participants: title,
            price: '',
            description: trimEventDescription(
                extractDateSpecificAnnouncementSegment(post.text, currentDate, {
                    publishedAt: post.publishedAt, referenceNow: post?.referenceNow,
                }) || post.text,
                5000,
            ),
            sourceSegment: extractDateSpecificAnnouncementSegment(post.text, currentDate, {
                publishedAt: post.publishedAt, referenceNow: post?.referenceNow,
            }),
            evidence: trimEventValue(line, 500),
            parseMethod: 'local_digest',
            status: 'approved',
        });
    }

    return events.slice(0, 30);
}


function normalizeInlineScheduleTitle(value) {
    const source = trimEventValue(value, 600);
    const cut = source.split(
        /\s*,\s*(?=(?:билет|tickets?|вход|free|донат|стоимость|цена|регистрац|предпродаж|на\s+входе)(?:\s|:|$))/iu,
    )[0] || source;
    return cleanEventTitle(cut.replace(/[\s,;:—–-]+$/gu, ''), 300);
}

function extractInlineSchedulePrice(group) {
    const tail = String(group?.tail ?? '');
    const tailPrice = tail.match(
        /(?:^|,\s*)((?:билет|tickets?|вход|free|донат|стоимость|цена|регистрац|предпродаж|на\s+входе)[^\n]{0,240})$/iu,
    )?.[1] ?? '';
    if (tailPrice) return normalizePriceValue(tailPrice);

    const line = (Array.isArray(group?.lines) ? group.lines : [])
        .find((value) => /(?:\d[\d\s]*(?:₽|р\.|руб)|вход\s+(?:свобод|бесплат)|бесплатн|донат|free|стоимость|цена)/iu.test(value));
    return normalizePriceValue(line || '');
}

function parseInlineScheduleEvents(post) {
    const lines = String(post.text ?? '')
        .split(/\n+/u)
        .map((line) => line.trim())
        .filter(Boolean);
    const groups = [];
    let current = null;

    for (const line of lines) {
        const match = line.match(INLINE_SCHEDULE_RE) || line.match(INLINE_CONTEXT_HYPHEN_SCHEDULE_RE);
        if (match) {
            if (current) groups.push(current);
            current = {
                firstLine: line,
                dateText: match[1],
                timeText: match[2] || '',
                tail: match[3],
                lines: [line],
            };
            continue;
        }
        if (current) {
            current.lines.push(line);
        }
    }
    if (current) groups.push(current);
    if (!groups.length) return [];

    const events = [];
    for (const group of groups.slice(0, 20)) {
        const dates = extractExplicitDates(group.dateText, post.publishedAt, { referenceNow: post?.referenceNow });
        if (!dates.length) continue;

        const segment = group.lines.join('\n');
        const title = normalizeInlineScheduleTitle(group.tail);
        if (!title || !isUsableTitleLine(title)) continue;

        const eventTime = group.timeText
            ? group.timeText.replace('-', ':').replace(/^([0-9]):/u, '0$1:')
            : extractEventTime(segment) || null;
        const refined = refineKnownVenue({ post, title, venue: '' });
        const price = extractInlineSchedulePrice(group);

        for (const eventDate of dates) {
            const sourceSegment = extractDateSpecificAnnouncementSegment(post.text, eventDate, {
                publishedAt: post.publishedAt, referenceNow: post?.referenceNow,
            });
            events.push({
                title: refined.title,
                eventDate,
                eventTime,
                venue: trimEventValue(refined.venue, 500),
                participants: trimEventValue(title, 1000),
                price,
                description: trimEventDescription(sourceSegment || segment, 2400),
                sourceSegment,
                evidence: trimEventValue(group.firstLine, 500),
                parseMethod: 'local_inline_schedule_v131',
                status: 'approved',
            });
        }
    }

    return events;
}

function parseGenericEvent(post) {
    const mentions = choosePrimaryEventDateMentions(post);

    if (!mentions.length || !looksLikeEventCandidate(post)) {
        return [];
    }

    const lines = String(post.text ?? '')
        .split(/\n+/u)
        .map((line) => line.trim())
        .filter(Boolean);
    const participants = extractLabel(post.text, [
        'кто',
        'участники',
        'лайн-ап',
        'лайнап',
        'line-up',
        'lineup',
    ]) || inferBulletParticipants(post.text) || inferCompactParticipantBlock(post.text);
    const venue = extractBestVenueLabel(post.text) ||
        inferInlineVenueFromSchedule(post.text) ||
        inferEventVenueFromText(post.text).venue;
    const price = extractLabel(post.text, [
        'почем',
        'почём',
        'сколько',
        'цена',
        'стоимость',
        'вход',
        'билет',
        'билеты',
    ]);
    const eventTime = extractEventTime(post.text) || extractDateAdjacentEventTime(post.text) || null;
    const dateRange = extractEventDateRanges(post.text, post.publishedAt, { referenceNow: post?.referenceNow })[0] || null;

    // Fallback parser follows the calendar-card invariant too: every explicit
    // calendar date gets its own candidate. AI may later decide that several
    // times on one date are a program, but a local fallback must never collapse
    // different dates into a single multi-day card.
    return mentions.map((mention) => {
        const refined = refineKnownVenue({
            post,
            title: providedPostEventTitle(post) || inferTitleFromDate(post, mention, lines),
            venue,
        });

        return {
            title: refined.title,
            eventDate: mention.date,
            eventEndDate: mention.date,
            eventDays: [{ date: mention.date, timeLabel: eventTime || '', venue: refined.venue }],
            eventTime,
            venue: refined.venue,
            participants: trimEventValue(participants, 2000),
            price: normalizePriceValue(price),
            description: trimEventDescription(post.text, 5000),
            evidence: trimEventValue(mention.raw, 500),
            parseMethod: 'local_generic_v14_primary_date',
            status: 'approved',
        };
    });
}

export function parsePublicPostLocally(post) {
    const sanitizedPost = { ...post, text: sanitizeEventBodyText(post?.text) };
    const retrospectiveAdmission = explainEventAiAdmissionWithPosterFacts({
        text: sanitizedPost.text,
        publishedAt: Number(sanitizedPost?.publishedAt || 0),
        referenceNow: sanitizedPost?.referenceNow,
    });
    if ([
        'retrospective-post',
        'service-status-not-event-announcement',
    ].includes(retrospectiveAdmission.rejectionReason)) return [];
    post = sanitizedPost;
    const structured = parseStructuredEvent(post);
    const inlineSchedule = structured.length ? [] : parseInlineScheduleEvents(post);
    const labeledSchedule = structured.length || inlineSchedule.length ? [] : parseLabeledScheduleEvents(post);
    const digest = structured.length || inlineSchedule.length || labeledSchedule.length ? [] : parseDigestEvents(post);
    const parsed = structured.length ? structured : inlineSchedule.length ? inlineSchedule : labeledSchedule.length ? labeledSchedule : digest.length ? digest : parseGenericEvent(post);
    return parsed.map((event) => ({
        ...event,
        eventTags: inferEventSearchTags({
            ...event,
            sourceText: [event?.sourceText, event?.sourceSegment, post?.text].filter(Boolean).join(' '),
            description: [event?.description, post?.text].filter(Boolean).join(' '),
        }),
    }));
}

const PUBLIC_EVENT_WORD_PATTERN = /(?:мероприят|событи|концерт|вечерин|тус(?:а|овк)|гиг|фест|выступ|спектакл|лекци|мастер[- ]?класс|встреча|открытие|показ|турнир|квиз|стендап|вечер|фестиваль|воркшоп|экскурси|ярмарк|маркет|рейв|джем|дидже|dj\b|line[- ]?up|лайн[- ]?ап|играют|сцена|party)/iu;
const PUBLIC_TIME_PATTERN = /(?<!\d)(?:[01]?\d|2[0-3]):\d{2}(?!\d)|(?:начало|двери|сбор)\s*(?:в|:)\s*(?:[01]?\d|2[0-3]):[0-5]\d/iu;
const PUBLIC_PRICE_PATTERN = /(?<!\d)\d{2,6}\s*(?:₽|р\.?|руб(?:лей|ля|ль|\.)?)\b|(?:вход|билет(?:ы|ов)?|стоимость|депозит)\s*[:—-]?\s*(?:от\s*)?\d{2,6}/iu;
const PUBLIC_VENUE_PATTERN = /(?:где|место|локаци[яи]|адрес)\s*[:—-]|(?:в|во|на)\s+(?:бар(?:е)?|клуб(?:е)?|паб(?:е)?|пространств(?:е|о)|площадк(?:е|а)|студи[ия]|театре|hall\b|pub\b|club\b|liverpool|ливерпул|тупик|overlock|diesel|мама\s+анархи)/iu;


function getPublicPriorityDateAdjustment(text, referenceNow = new Date(), publishedAt = 0) {
    const safeNow = referenceNow instanceof Date ? referenceNow : new Date(referenceNow);
    const mentions = extractExplicitDateMentions(text, publishedAt, { referenceNow: safeNow });
    if (!mentions.length) return { points: 0, reason: '' };
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(Number.isFinite(safeNow.getTime()) ? safeNow : new Date());
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const today = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day));
    let best = -1000;
    for (const mention of mentions) {
        const [year, month, day] = String(mention.date || '').split('-').map(Number);
        if (!year || !month || !day) continue;
        const delta = Math.round((Date.UTC(year, month - 1, day) - today) / 86_400_000);
        let points = 0;
        if (delta >= 0 && delta <= 45) points = 36;
        else if (delta > 45 && delta <= 120) points = 18;
        else if (delta < 0 && delta >= -14) points = -12;
        else if (delta < -14) points = -28;
        if (points > best) best = points;
    }
    if (best === -1000) best = 0;
    return { points: best, reason: best > 0 ? 'upcoming-date-priority' : best < 0 ? 'past-date-deprioritized' : '' };
}

export function explainPublicPostEventCandidate(post = {}) {
    const contentText = String(post?.contentText ?? '').trim();
    const repostText = String(post?.repostText ?? '').trim();
    // A resolved root body is provenance, not by itself proof that the public
    // post is a repost. Treat only explicit nested/repost evidence as such.
    const hasRepost = Boolean(repostText || String(post?.imageOrigin || '') === 'nested-repost' || post?.repostDepth > 0 || post?.originalSourceUrl && post?.originalSourceUrl !== post?.sourceUrl);
    const rootPostTextResolved = post?.rootPostTextResolved === true;
    const text = sanitizeEventBodyText(String(
        rootPostTextResolved
            ? post?.rootPostText ?? ''
            : contentText || repostText
                ? [contentText, repostText].filter(Boolean).join('\n\n')
                : post?.text ?? '',
    )).trim();
    const dateMentions = extractExplicitDateMentions(text, Number(post?.publishedAt || 0), { referenceNow: post?.referenceNow });
    const hasDate = dateMentions.length > 0;
    const hasAbsoluteDate = dateMentions.some((mention) => !['relative', 'weekday'].includes(String(mention?.kind || '')));
    const hasTime = PUBLIC_TIME_PATTERN.test(text);
    const hasKeyword = PUBLIC_EVENT_WORD_PATTERN.test(text);
    const hasPrice = PUBLIC_PRICE_PATTERN.test(text);
    const hasVenueCue = PUBLIC_VENUE_PATTERN.test(text);
    const hasPoster = Array.isArray(post?.imageUrls) && post.imageUrls.length > 0;
    const aiAdmission = explainEventAiAdmissionWithPosterFacts({
        text,
        posterFacts: post?.__posterGateFacts || '',
        posterVisionAttempted: Boolean(post?.__posterGateVisionAttempted),
        dateFreePhase: post?.__dateFreeVisionPhase === true,
        publishedAt: Number(post?.publishedAt || 0),
        referenceNow: post?.referenceNow,
    });
    if (hasRepost && !rootPostTextResolved) {
        aiAdmission.eligible = false;
        aiAdmission.rejectionReason = 'repost-root-text-unresolved';
        aiAdmission.dateSource = 'repost-root-text-required';
        aiAdmission.hasCalendarDate = false;
        aiAdmission.hasEventDateCandidate = false;
        aiAdmission.hasNonPastDate = false;
        aiAdmission.pastOnly = false;
    }
    const retrospectiveRejected = aiAdmission.rejectionReason === 'retrospective-post';

    let score = 0;
    const reasons = [];
    const add = (condition, points, reason) => {
        if (!condition) return;
        score += points;
        reasons.push(reason);
    };
    add(hasDate, 100, 'explicit-event-date');
    add(hasTime, 16, 'event-time');
    add(hasKeyword, 24, 'event-word');
    add(hasPrice, 22, 'price');
    add(hasVenueCue, 22, 'venue-cue');
    add(hasRepost, 10, 'repost');
    add(hasPoster, 18, 'poster-media');
    const datePriority = getPublicPriorityDateAdjustment(text, post?.referenceNow, Number(post?.publishedAt || 0));
    add(datePriority.points !== 0, datePriority.points, datePriority.reason);

    const posterVisionRescue = Boolean(
        hasPoster && aiAdmission.eligible && aiAdmission.dateSource === 'poster-vision'
    );
    const candidate = Boolean(!retrospectiveRejected && !(hasRepost && !rootPostTextResolved) && (
        hasAbsoluteDate ||
        (hasDate && (hasKeyword || hasTime || hasVenueCue || hasPoster || hasRepost)) ||
        (hasPoster && (hasRepost || hasKeyword || hasTime || hasPrice || hasVenueCue)) ||
        (hasKeyword && hasTime && (hasVenueCue || hasPrice)) ||
        (hasRepost && hasKeyword && (hasTime || hasVenueCue || hasPrice)) ||
        posterVisionRescue
    ));
    add(posterVisionRescue, 120, 'poster-vision-event');

    return {
        candidate,
        aiEligible: Boolean(candidate && aiAdmission.eligible),
        aiAdmission,
        score,
        reasons,
        evidence: {
            hasDate,
            hasAbsoluteDate,
            hasTime,
            hasKeyword,
            hasPrice,
            hasVenueCue,
            hasPoster,
            hasRepost,
            contentChars: contentText.length,
            repostChars: repostText.length,
            textChars: text.length,
            datePriorityPoints: datePriority.points,
            hasAiCalendarDate: aiAdmission.hasCalendarDate,
            hasAiEventTitle: aiAdmission.hasTitle,
            hasAiNonPastDate: aiAdmission.hasNonPastDate,
            aiGateRejectionReason: retrospectiveRejected ? 'retrospective-post' : aiAdmission.rejectionReason,
            retrospectiveRejected,
            rootPostTextResolved,
            rootPostTextChars: String(post?.rootPostText || '').length,
        },
    };
}

export function publicPostLooksLikeEventCandidate(post) {
    return explainPublicPostEventCandidate(post).candidate;
}

export function validatePublicAiEvents(events, post) {
    return validateAiEvents(events, post);
}

export function setPublicAiResponseMetadata(events, {
    structure = '',
    reason = '',
    valid = false,
    error = '',
    validationFailures = [],
} = {}) {
    const result = Array.isArray(events) ? events : [];
    // Keep transport metadata attached to the array without changing its JSON
    // shape or deep-equality semantics.  Callers can still read the properties
    // directly, while an unresolved result remains an ordinary empty event list.
    for (const [key, value] of [
        ['aiStructureDecision', String(structure || '').trim()],
        ['aiStructureReason', String(reason || '').trim()],
        ['aiResponseValid', Boolean(valid)],
        ['aiResponseError', String(error || '').trim()],
        ['aiValidationFailures', Array.isArray(validationFailures) ? validationFailures.slice(0, 20) : []],
    ]) {
        Object.defineProperty(result, key, { value, writable: true, configurable: true, enumerable: false });
    }
    return result;
}

export function selectPublicAiEventsForPersistence({
    localEvents = [],
    aiEvents = null,
    validatedEvents = null,
    aiRequired = false,
    aiCalled = false,
    aiError = '',
    post = null,
    timeZone = 'Europe/Moscow',
} = {}) {
    if (!aiRequired) {
        return { events: Array.isArray(localEvents) ? localEvents : [], resolved: true, unresolved: false, notEvent: false, reason: 'ai-not-required' };
    }

    const structure = String(aiEvents?.aiStructureDecision ?? aiEvents?.[0]?._structure ?? '').trim();
    const structureReason = String(aiEvents?.aiStructureReason ?? aiEvents?.[0]?._structureReason ?? '').trim();
    const invalidReason = String(aiError || aiEvents?.aiResponseError || validatedEvents?.aiResponseError || '').trim();
    if (aiCalled && !aiError && !aiEvents?.aiResponseError && aiEvents?.aiResponseValid === true &&
        isUntitledBookingWindowOffer(aiEvents, post)) {
        return { events: [], resolved: true, unresolved: false, notEvent: true, structure, structureReason,
            reason: 'booking-window-offer-not-a-dated-event' };
    }
    if (aiCalled && !aiError && !aiEvents?.aiResponseError && aiEvents?.aiResponseValid === true &&
        isConfirmedPosterWithoutEventDate(post, timeZone)) {
        return { events: [], resolved: true, unresolved: false, notEvent: false, structure, structureReason,
            reason: 'confirmed-poster-has-no-event-date' };
    }
    if (aiCalled && !aiError && !aiEvents?.aiResponseError && aiEvents?.aiResponseValid === true &&
        isCompletePastOnlyResponse(aiEvents, post, { structure, timeZone })) {
        return { events: [], resolved: true, unresolved: false, notEvent: false, pastOnly: true, structure, structureReason, reason: 'all-supported-event-dates-are-past' };
    }
    if (!aiCalled || invalidReason || aiEvents?.aiResponseValid !== true) {
        return { events: [], resolved: false, unresolved: true, notEvent: false, structure, structureReason,
            reason: invalidReason || (aiCalled ? 'invalid-ai-structure-response' : 'ai-unavailable'),
            validationFailures: validatedEvents?.aiValidationFailures || [] };
    }

    if (structure === 'not_event' && validatedEvents?.aiResponseValid === true) {
        return { events: [], resolved: true, unresolved: false, notEvent: true, structure, structureReason, reason: 'ai-not-event' };
    }

    if (['single_event', 'single_event_program', 'shared_schedule_event', 'theater_repertoire', 'multiple_events'].includes(structure) &&
        validatedEvents?.aiResponseValid === true && Array.isArray(validatedEvents) && validatedEvents.length > 0) {
        return { events: validatedEvents, resolved: true, unresolved: false, notEvent: false, structure, structureReason, reason: 'ai-cardinality-accepted' };
    }

    return { events: [], resolved: false, unresolved: true, notEvent: false, structure, structureReason,
        reason: structure === 'uncertain' ? 'ai-structure-uncertain' : invalidReason || 'ai-events-failed-validation' };
}

function isCompletePastOnlyResponse(aiEvents, post, { structure, timeZone }) {
    const events = Array.isArray(aiEvents) ? aiEvents : [];
    if (!['single_event', 'single_event_program', 'shared_schedule_event', 'theater_repertoire', 'multiple_events'].includes(structure) ||
        events.length > 20 ||
        (structure === 'multiple_events' ? events.length < 2 : events.length !== 1)) return false;

    const referenceNow = post?.referenceNow instanceof Date && Number.isFinite(post.referenceNow.getTime())
        ? post.referenceNow
        : new Date();
    const today = getLocalDateString(referenceNow, timeZone);
    const sourceDates = new Set(extractExplicitDates(post?.text, post?.publishedAt, {
        referenceNow,
        timeZone,
    }));
    if (!sourceDates.size || [...sourceDates].some((date) => date >= today)) return false;

    return events.every((event) => {
        const date = String(event?.date ?? '').trim();
        const end = ['shared_schedule_event', 'theater_repertoire'].includes(structure) ? String(event?.schedule?.endDate || event?.eventSchedule?.endDate || '') : date;
        return /^\d{4}-\d{2}-\d{2}$/u.test(end) && end < today && sourceDates.has(date);
    });
}

function isUntitledBookingWindowOffer(aiEvents, post) {
    const events = Array.isArray(aiEvents) ? aiEvents : [];
    const structure = String(aiEvents?.aiStructureDecision ?? events[0]?._structure ?? events[0]?.structure ?? '').trim();
    if (structure !== 'multiple_events' || events.length > 20) return false;

    const source = String(post?.text || '');
    if (!/открываем\s+бронирование\s+на\s+(?:новогодние\s+)?корпоратив/iu.test(source)) return false;
    const hasBookingRange = extractEventDateRanges(source, post?.publishedAt, {
        referenceNow: post?.referenceNow instanceof Date ? post.referenceNow : new Date(),
    }).length > 0;
    if (!hasBookingRange) return false;

    // A complete empty multiple-events response can explicitly mean that the
    // date range offers booking availability, not separate event listings.
    const emptyRangeExplanation = events.length === 0 && /диапазон|отдельн(?:ые|ых)\s+(?:событи|мероприяти)|не\s+назван/iu.test(
        String(aiEvents?.aiStructureReason || ''),
    );
    if (emptyRangeExplanation) return true;

    return events.length >= 2 && events.every((event) => (
        !String(event?.title || '').trim() && !String(event?.participants || '').trim()
    ));
}

function isConfirmedPosterWithoutEventDate(post, timeZone) {
    if (!acceptedDateFreePoster(post)) return false;
    const facts = String(post?.__posterGateFacts || '');
    // A blank poster field must not hide a date supplied by the announcement.
    if (parseIndexedImageFacts(facts).some((fact) => fact.visionError)) return false;
    const explicitDates = extractExplicitDates([post?.__sourceAnnouncementText ?? post?.text, facts].filter(Boolean).join('\n'), post?.publishedAt, {
        referenceNow: post?.referenceNow instanceof Date ? post.referenceNow : new Date(),
        timeZone,
    });
    if (explicitDates.length) return false;
    return ![...facts.matchAll(/^[ \t]*(?:Дата|Даты|Date)[ \t]*:([^\r\n]*)/gimu)]
        .some((match) => match[1].trim().length > 0);
}

function looksLikeEventCandidate(post) {
    return explainPublicPostEventCandidate(post).candidate;
}

function validateAiEvents(events, post) {
    if (!Array.isArray(events)) {
        return setPublicAiResponseMetadata([], {
            structure: events?.aiStructureDecision,
            reason: events?.aiStructureReason,
            error: events?.aiResponseError || 'response-is-not-an-event-array',
        });
    }

    const repertoire = collapseTheaterRepertoireResponse(events, post);
    if (repertoire) events = setPublicAiResponseMetadata(repertoire.events, {
        structure: 'theater_repertoire',
        reason: repertoire.reason,
        valid: true,
    });
    const responseStructure = String(
        events.aiStructureDecision ?? events[0]?._structure ?? events[0]?.structure ?? events[0]?.structure_decision ??
        (events.length === 1 ? 'single_event' : ''),
    ).trim();
    if (['uncertain', 'not_event'].includes(responseStructure)) {
        const validNotEvent = responseStructure === 'not_event' && events.aiResponseValid === true && events.length === 0;
        return setPublicAiResponseMetadata([], {
            structure: responseStructure,
            reason: events.aiStructureReason,
            valid: validNotEvent,
            error: validNotEvent ? '' : responseStructure === 'not_event' && events.length
                ? 'not_event-has-events'
                : events.aiResponseError || (responseStructure === 'uncertain' ? 'ai-structure-uncertain' : 'invalid-ai-structure-response'),
        });
    }

    if (!['single_event', 'single_event_program', 'shared_schedule_event', 'theater_repertoire', 'multiple_events'].includes(responseStructure)) {
        return setPublicAiResponseMetadata([], {
            structure: responseStructure,
            reason: events.aiStructureReason,
            error: events.aiResponseError || 'missing-or-unknown-structure',
        });
    }

    if (events.aiResponseValid === false || events.length > 20 ||
        (responseStructure === 'multiple_events' && events.length < 2) ||
        (['single_event', 'single_event_program', 'shared_schedule_event', 'theater_repertoire'].includes(responseStructure) && events.length !== 1)) {
        return setPublicAiResponseMetadata([], {
            structure: responseStructure,
            reason: events.aiStructureReason,
            error: events.aiResponseError || 'structure-event-count-mismatch',
        });
    }

    const cardinality = validateScheduleCardinality(responseStructure, events, {
        sourceText: post?.__sourceAnnouncementText ?? post?.text ?? '',
        facts: parseIndexedImageFacts(post?.__posterGateFacts || ''),
        publishedAt: post?.publishedAt, referenceNow: post?.referenceNow,
    });
    if (!cardinality.ok) return setPublicAiResponseMetadata([], {
        structure: responseStructure, reason: events.aiStructureReason, error: cardinality.reason,
    });
    const sharedSchedule = responseStructure === 'shared_schedule_event'
        ? validateSharedEventSchedule(events[0], {
            sourceText: post?.__sourceAnnouncementText ?? post?.text ?? '',
            facts: parseIndexedImageFacts(post?.__posterGateFacts || ''),
            publishedAt: post?.publishedAt, referenceNow: post?.referenceNow,
        }) : null;
    if (sharedSchedule && !sharedSchedule.ok) return setPublicAiResponseMetadata([], {
        structure: responseStructure, reason: events.aiStructureReason, error: sharedSchedule.reason,
    });
    const theaterRepertoire = responseStructure === 'theater_repertoire'
        ? validateTheaterRepertoireSchedule(events[0], {
            sourceText: post?.__sourceAnnouncementText ?? post?.text ?? '',
            facts: parseIndexedImageFacts(post?.__posterGateFacts || ''),
            publishedAt: post?.publishedAt, referenceNow: post?.referenceNow,
        }) : null;
    if (theaterRepertoire && !theaterRepertoire.ok) return setPublicAiResponseMetadata([], {
        structure: responseStructure, reason: events.aiStructureReason, error: theaterRepertoire.reason,
    });
    const dateFreeVisionPhase = acceptedDateFreePoster(post);
    const sourceAnnouncementText = String(post?.__sourceAnnouncementText ?? post?.text ?? '');
    // In phase two, post.text contains the poster-gate facts. Use those facts
    // to validate date and venue fields, while skipping verbatim comparison
    // against the independent announcement text.
    const validationSourceText = String(post?.text ?? '');
    const allowedDates = new Set(
        extractExplicitDates(post.text, post.publishedAt, { referenceNow: post?.referenceNow }),
    );

    if (!dateFreeVisionPhase && !allowedDates.size) return setPublicAiResponseMetadata([], {
        structure: responseStructure,
        reason: events.aiStructureReason,
        error: 'no-supported-calendar-date-in-source',
    });

    // Cardinality is an explicit AI contract. An unresolved one-date/multiple-
    // time decision must never silently become a local single card: the caller
    // can retain the source and retry the structured extraction later.
    const result = [];
    const validationFailures = [];
    const reject = (event, reason) => validationFailures.push({
        eventIndex: events.indexOf(event), date: String(event?.date || '').slice(0, 20),
        title: String(event?.title || event?.participants || '').slice(0, 160), reason,
    });

    for (const event of events.slice(0, 20)) {
        const eventDate = String(event?.date ?? '').trim();

        if (!dateFreeVisionPhase && !allowedDates.has(eventDate)) {
            reject(event, 'event-date-not-supported-by-source');
            continue;
        }

        const eventTime = /^([01]\d|2[0-3]):[0-5]\d$/u.test(
            String(event?.time ?? ''),
        )
            ? String(event.time)
            : null;
        const evidence = normalizeEventEvidence(event?.evidence);
        // The shared matcher normalizes case/spacing and accepts an explicit
        // ellipsis between ordered exact fragments. This lets Vision-enriched
        // dates survive compact AI evidence without weakening source proof.
        if (!dateFreeVisionPhase && !sourceContainsEvidence(evidence, post.text)) {
            reject(event, 'evidence-not-verbatim-in-source');
            continue;
        }

        const dateProgramSegment = responseStructure === 'multiple_events' ? selectDateProgramSegment(event, {
            sourceText: sourceAnnouncementText, facts: parseIndexedImageFacts(post?.__posterGateFacts || ''),
            publishedAt: post?.publishedAt, referenceNow: post?.referenceNow,
        }) : '';
        const candidate = {
            // The title contract allows an empty title when the source has no
            // proper event name. Validation still needs a stable human label;
            // use participants as the fallback, matching the local parser,
            // without inventing a name or changing the event identity rules.
            title: trimEventValue(event?.title || event?.participants || '', 500),
            eventDate,
            ...((sharedSchedule?.ok || theaterRepertoire?.ok) ? { eventSchedule: (sharedSchedule?.schedule || theaterRepertoire.schedule), eventEndDate: (sharedSchedule?.schedule || theaterRepertoire.schedule).endDate } : {}),
            eventTime,
            venue: trimEventValue(event?.venue, 500),
            participants: trimEventValue(event?.participants, 2000),
            price: trimEventValue(event?.price, 500),
            // Keep the complete source post in the source table for audit.
            // The event row's description is the concise AI-written card text;
            // sourceSegment remains the exact/date-specific source evidence.
            description: trimEventDescription(
                ((sharedSchedule?.ok || theaterRepertoire?.ok) ? sourceAnnouncementText : event?.announcement) || dateProgramSegment || (dateFreeVisionPhase
                    ? sourceAnnouncementText
                    : extractDateSpecificAnnouncementSegment(post.text, eventDate, {
                    publishedAt: post.publishedAt, referenceNow: post?.referenceNow,
                    }) || event?.source_segment || event?.sourceSegment || post.text),
                5000,
            ),
            evidence,
            announcement: trimEventDescription(event?.announcement || '', 5000),
            sourceSegment: trimEventDescription(
                responseStructure === 'multiple_events' ? dateProgramSegment || event?.source_segment || event?.sourceSegment || '' :
                ((sharedSchedule?.ok || theaterRepertoire?.ok) || dateFreeVisionPhase) ? sourceAnnouncementText : extractDateSpecificAnnouncementSegment(post.text, eventDate, {
                    publishedAt: post.publishedAt, referenceNow: post?.referenceNow,
                }) || event?.source_segment || event?.sourceSegment || '',
                5000,
            ),
            structureDecision: responseStructure,
            structureReason: trimEventValue(event?._structureReason || event?.structure_reason || event?.structureReason || '', 1000),
            programItems: Array.isArray(event?.program_items || event?.programItems)
                ? (event.program_items || event.programItems).slice(0, 64).map((item) => ({
                    date: trimEventValue(item?.date, 32),
                    title: trimEventValue(item?.title, 500),
                    time: trimEventValue(item?.time, 32),
                    text: trimEventValue(item?.text, 500),
                    evidence: trimEventValue(item?.evidence, 1200),
                })).filter((item) => item.date || item.title || item.time || item.text || item.evidence)
                : [],
            isMultiAnnouncement: String(event?._structure || event?.structure || '').trim() === 'multiple_events' ? 1 : 0,
            imageIndexes: [...new Set((Array.isArray(event?.image_indexes) ? event.image_indexes : event?.imageIndexes ?? [])
                .map(Number)
                .filter((value) => Number.isInteger(value) && value >= 1 && value <= 12))],
            eventTags: inferEventSearchTags({
                ...event,
                eventTags: Array.isArray(event?.tags) ? event.tags : event?.eventTags,
                title: event?.title || event?.participants,
                description: [event?.description, event?.sourceSegment, post?.text].filter(Boolean).join(' '),
                venue: event?.venue || inferEventVenueFromText(post?.text).venue,
                eventType: event?.eventType || event?.programItems?.map((item) => item?.text).join(' '),
            }),
            parseMethod: dateFreeVisionPhase ? 'gigachat_validated_phase2_poster_v2' : 'gigachat_validated',
            status: 'pending',
        };

        const strictValidation = explainStrictEventRecord(candidate, {
            sourceText: validationSourceText,
            requireEvidence: !dateFreeVisionPhase,
            trustedPosterEvent: dateFreeVisionPhase,
        });
        if (strictValidation.ok) {
            result.push(candidate);
        } else {
            reject(event, strictValidation.reason);
        }
    }

    if (responseStructure === 'multiple_events' && result.length !== events.length) {
        return setPublicAiResponseMetadata([], {
            structure: responseStructure,
            reason: events.aiStructureReason,
            valid: false,
            error: 'one-or-more-events-failed-validation',
            validationFailures,
        });
    }
    if (['single_event', 'single_event_program', 'shared_schedule_event', 'theater_repertoire'].includes(responseStructure) && result.length !== 1) {
        return setPublicAiResponseMetadata([], {
            structure: responseStructure,
            reason: events.aiStructureReason,
            valid: false,
            error: 'event-failed-validation',
            validationFailures,
        });
    }

    return setPublicAiResponseMetadata(result, {
        structure: responseStructure,
        reason: events.aiStructureReason,
        valid: result.length === events.length,
        error: result.length === events.length ? '' : 'one-or-more-events-failed-validation',
    });
}

function collapseTheaterRepertoireResponse(events, post) {
    const structure = String(events?.aiStructureDecision ?? events?.[0]?._structure ?? '').trim();
    if (structure !== 'multiple_events' || !Array.isArray(events) || events.length < 2 || events.length > 20) return null;
    const sourceText = String(post?.__sourceAnnouncementText ?? post?.text ?? '');
    const posterText = String(post?.__posterGateFacts ?? '');
    const context = sourceText + '\n' + posterText;
    if (!/(?:репертуар|афиша\s+(?:театра|спектаклей)|театр.{0,50}(?:ноябр|октябр|декабр|репертуар)|(?:ноябр|октябр|декабр).{0,50}театр)/iu.test(context)) return null;
    if (!/(?:спектакл|театр|theatre)/iu.test(context)) return null;

    const rows = events.map((event) => ({
        date: String(event?.eventDate ?? event?.date ?? '').trim(),
        title: trimEventValue(event?.title || event?.participants || '', 500),
        time: String(event?.eventTime ?? event?.time ?? '').trim(),
        text: trimEventDescription(event?.announcement || event?.description || event?.source_segment || event?.sourceSegment || '', 500),
        evidence: normalizeEventEvidence(event?.evidence || event?.source_segment || event?.sourceSegment || ''),
        venue: trimEventValue(event?.venue || '', 500),
        image_indexes: Array.isArray(event?.image_indexes) ? event.image_indexes : event?.imageIndexes,
    }));
    if (rows.some((row) => !/^\d{4}-\d{2}-\d{2}$/u.test(row.date) || !row.title || !row.evidence)) return null;
    if (new Set(rows.map((row) => row.date)).size !== rows.length || new Set(rows.map((row) => row.title.toLowerCase())).size !== rows.length) return null;

    const dates = rows.map((row) => row.date).sort();
    const venues = [...new Set(rows.map((row) => row.venue).filter(Boolean))];
    const evidence = rows.map((row) => row.evidence).join(' || ');
    const programItems = rows.map(({ date, title, time, text, evidence: rowEvidence }) => ({
        date, title, time: time || null, text, evidence: rowEvidence,
        venue: rows.find(row => row.date === date && row.title === title)?.venue || '',
    }));
    return {
        reason: String(events?.aiStructureReason || events?.[0]?._structureReason || 'Один театральный репертуар с отдельными постановками по датам.'),
        events: [{
            date: dates[0],
            title: 'Репертуар театра',
            time: null,
            venue: venues.length === 1 ? venues[0] : 'Театр «Версия» — несколько площадок',
            participants: '',
            price: '',
            announcement: 'Театральный репертуар; даты и постановки перечислены ниже.',
            source_segment: sourceText,
            evidence,
            schedule: { dateMode: 'specific', startDate: dates[0], endDate: dates.at(-1), dates },
            program_items: programItems,
            tags: ['theater'],
            image_indexes: [...new Set(rows.flatMap((row) => Array.isArray(row.image_indexes) ? row.image_indexes : []).map(Number).filter(n => Number.isInteger(n) && n > 0))],
            _structure: 'theater_repertoire',
            _structureReason: 'Несколько отдельных спектаклей относятся к одному театральному репертуару.',
        }],
    };
}
