import { extractRawDateMentions } from './publicPostDateEvidence.js';
import { explainEventAiAdmissionWithPosterFacts } from './eventAiAdmission.js';

/**
 * Быстрый дешёвый фильтр: решает, есть ли смысл отправлять сообщение в дорогой GPT-классификатор событий.
 */
const RUSSIAN_MONTH_WORDS = [
    'январ(?:я|е|ь)',
    'феврал(?:я|е|ь)',
    'март(?:а|е)?',
    'апрел(?:я|е|ь)',
    'ма[йяе]',
    'июн(?:я|е|ь)',
    'июл(?:я|е|ь)',
    'август(?:а|е)?',
    'сентябр(?:я|е|ь)',
    'октябр(?:я|е|ь)',
    'ноябр(?:я|е|ь)',
    'декабр(?:я|е|ь)',
].join('|');

const EXPLICIT_DATE_PATTERN = new RegExp(
    [
        '(?<![\\d.\\/:-])\\d{1,2}\\.\\d{1,2}(?:\\.\\d{2}|\\.\\d{4})?(?![\\d.\\/:-])',
        `(?<!\\d)\\d{1,2}\\s+(?:${RUSSIAN_MONTH_WORDS})(?:\\s+\\d{2,4})?(?!\\d)`,
    ].join('|'),
    'iu',
);

// Only HH:MM or a hyphenated clock with explicit time context. Not 19.00 or "7 вечера".
const TIME_PATTERN = /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)|(?:начало|старт|сбор|двери|время|в)\s*[:—–-]?\s*(?:[01]?\d|2[0-3])-[0-5]\d(?!\d)/iu;
const EVENT_WORD_PATTERN = /(?:мероприят|событи|концерт|вечерин|тус(?:а|овк)|гиг|фест|выступ|спектакл|лекци|мастер[- ]?класс|встреча|открытие|показ|турнир|квиз|стендап|вечер|фестиваль|воркшоп|экскурси|ярмарк|маркет|рейв|джем|сбор гостей|регистрац(?:ия|ии) на|билет(?:ы|ов)? на|двери открываются|начало концерта|дидже|dj\b|line[- ]?up|лайн[- ]?ап|играют|сцена|party)/iu;
const PRICE_PATTERN = /(?<!\d)\d{2,6}\s*(?:₽|р\.?|руб(?:лей|ля|ль|\.)?)\b|(?:вход|билет(?:ы|ов)?|стоимость|депозит)\s*[:—-]?\s*(?:от\s*)?\d{2,6}/iu;
const VENUE_CUE_PATTERN = /(?:где|место|локаци[яи]|адрес)\s*[:—-]|(?:в|во|на)\s+(?:бар(?:е)?|клуб(?:е)?|паб(?:е)?|пространств(?:е|о)|площадк(?:е|а)|студи[ия]|театре|дк\b|hall\b|pub\b|club\b|liverpool|ливерпул|тупик|overlock|diesel|мама\s+анархи)|(?:воронеж|москва|санкт[- ]?петербург|спб)\s*,?\s*(?:ул\.?|улица|проспект|пр-т|пер\.?|переулок|наб\.?|набережная)\s+/iu;
const URL_PATTERN = /https?:\/\/\S+/iu;
const VK_REPOST_MARKER_PATTERN = /\[Репост\/вложенный пост VK(?: — API)?\]/iu;
const VK_WALL_LINK_PATTERN = /https?:\/\/(?:www\.)?vk\.(?:ru|com)\/wall-?\d+_\d+/iu;

function trimText(value, maximum = 20_000) {
    return String(value ?? '')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n[ \t]+/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, maximum);
}


function getPriorityDateAdjustment(text, referenceNow = new Date()) {
    const source = String(text ?? '');
    const mentions = extractRawDateMentions(source);
    // Relative words in an old cached message ("завтра") are not evidence
    // that the event is upcoming *now*. Without a reliable source timestamp we
    // keep them as candidate evidence but do not give queue-priority bonus.
    if (!mentions.length) return { points: 0, reason: '' };
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Europe/Moscow', year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(referenceNow instanceof Date ? referenceNow : new Date(referenceNow));
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const currentYear = Number(map.year);
    const today = Date.UTC(currentYear, Number(map.month) - 1, Number(map.day));
    let best = -1000;
    for (const mention of mentions) {
        const year = Number(mention.explicitYear || currentYear);
        const value = Date.UTC(year, Number(mention.month) - 1, Number(mention.day));
        const delta = Math.round((value - today) / 86_400_000);
        let points = 0;
        if (delta >= 0 && delta <= 45) points = 36;
        else if (delta > 45 && delta <= 120) points = 18;
        else if (delta < 0 && delta >= -14) points = -12;
        else if (delta < -14) points = -28;
        if (points > best) best = points;
    }
    if (best === -1000) best = 0;
    return {
        points: best,
        reason: best > 0 ? 'upcoming-date-priority' : best < 0 ? 'past-date-deprioritized' : '',
    };
}

function uniqueStrings(values, maximum = 50) {
    const result = [];

    for (const value of Array.isArray(values) ? values : []) {
        const item = String(value ?? '').trim();
        if (item && !result.includes(item) && result.length < maximum) {
            result.push(item);
        }
    }

    return result;
}


/**
 * Репост/пересланный wall-post в основной VK-беседе рассматриваем как сильный
 * повод для AI-проверки даже без явных слов «концерт/вечеринка». Это нужно для
 * коротких анонсов, где смысл находится в репосте или афише.
 */
export function hasVkChatRepostEvidence({ text, links } = {}) {
    const source = trimText(text);
    if (VK_REPOST_MARKER_PATTERN.test(source) || VK_WALL_LINK_PATTERN.test(source)) {
        return true;
    }
    return uniqueStrings(links).some((url) => VK_WALL_LINK_PATTERN.test(url));
}

/**
 * Cheap pre-filter before the GPT event extractor.
 * A name, interface timestamp, lone URL or sales deadline must not reach the
 * event classifier. Missing announcements are more expensive than an extra
 * classification call, so an explicit event date is enough to enter AI review.
 * Time/link/event words remain evidence for diagnostics, not a hard gate.
 */
export function explainVkChatEventCandidate(input = {}) {
    const contentText = trimText(input?.contentText ?? '');
    const repostText = trimText(input?.repostText ?? input?.embeddedText ?? '');
    // New exact DOM snapshots keep UI metadata out of these structural fields.
    // For legacy/adaptive payloads fall back to `text`, but only when neither
    // structural field exists.
    const source = trimText(
        contentText || repostText
            ? [contentText, repostText].filter(Boolean).join('\n\n')
            : input?.text,
    );
    const links = uniqueStrings(input?.links);
    const imageUrls = uniqueStrings(input?.posterImageUrls?.length
        ? input.posterImageUrls
        : input?.imageUrls);
    const hasLink = URL_PATTERN.test(source) || links.length > 0;
    const hasWallLink = links.some((url) => VK_WALL_LINK_PATTERN.test(url));
    const hasDate = extractRawDateMentions(source).length > 0;
    const hasTime = TIME_PATTERN.test(source);
    const hasKeyword = EVENT_WORD_PATTERN.test(source);
    const hasPrice = PRICE_PATTERN.test(source);
    const hasVenueCue = VENUE_CUE_PATTERN.test(source);
    const hasPoster = imageUrls.length > 0;
    const hasRepost = Boolean(repostText || input?.hasRepostEvidence || hasWallLink || VK_REPOST_MARKER_PATTERN.test(source));
    const aiAdmission = explainEventAiAdmissionWithPosterFacts({
        text: source,
        posterFacts: input?.__posterGateFacts || '',
        posterVisionAttempted: Boolean(input?.__posterGateVisionAttempted),
        publishedAt: Number(input?.createdAt || 0),
        referenceNow: input?.referenceNow,
    });

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
    add(hasWallLink, 12, 'wall-link');
    add(hasRepost, 10, 'repost');
    // Pure visual candidates stay recoverable, but intentionally rank below
    // strong dated/reposted announcements so random user photos cannot block
    // the first six global AI slots for minutes.
    add(hasPoster, 18, 'poster-media');
    const datePriority = getPriorityDateAdjustment(source, input?.referenceNow);
    add(datePriority.points !== 0, datePriority.points, datePriority.reason);

    const posterVisionRescue = Boolean(
        hasPoster && aiAdmission.eligible && aiAdmission.dateSource === 'poster-vision'
    );
    const candidate = Boolean(
        hasDate ||
        (hasPoster && (hasRepost || hasKeyword || hasTime || hasPrice || hasVenueCue)) ||
        (hasKeyword && hasTime && (hasVenueCue || hasPrice || hasLink)) ||
        (hasRepost && hasKeyword && (hasTime || hasVenueCue || hasPrice)) ||
        posterVisionRescue
    );
    add(posterVisionRescue, 120, 'poster-vision-event');

    return {
        candidate,
        aiEligible: Boolean(candidate && aiAdmission.eligible),
        aiAdmission,
        score,
        reasons,
        evidence: {
            hasDate,
            hasTime,
            hasKeyword,
            hasPrice,
            hasVenueCue,
            hasLink,
            hasWallLink,
            hasRepost,
            hasPoster,
            contentChars: contentText.length,
            repostChars: repostText.length,
            imageCount: imageUrls.length,
            datePriorityPoints: datePriority.points,
            hasAiCalendarDate: aiAdmission.hasCalendarDate,
            hasAiEventTitle: aiAdmission.hasTitle,
            hasAiNonPastDate: aiAdmission.hasNonPastDate,
            aiGateRejectionReason: aiAdmission.rejectionReason,
        },
    };
}

export function looksLikeVkChatEventCandidate(input = {}) {
    return explainVkChatEventCandidate(input).candidate;
}

export const EVENT_CANDIDATE_PATTERNS = Object.freeze({
    explicitDate: EXPLICIT_DATE_PATTERN,
    time: TIME_PATTERN,
    eventWord: EVENT_WORD_PATTERN,
    url: URL_PATTERN,
    vkRepostMarker: VK_REPOST_MARKER_PATTERN,
    vkWallLink: VK_WALL_LINK_PATTERN,
    price: PRICE_PATTERN,
    venueCue: VENUE_CUE_PATTERN,
});
