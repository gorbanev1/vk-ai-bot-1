import {
    explainEventAiAdmission,
} from './eventAiAdmission.js';
import {
    extractRawDateMentions,
} from './publicPostDateEvidence.js';
import {
    sanitizeEventBodyText,
    explainRetrospectivePost,
} from './eventTextSanitation.js';

const SECONDARY_TIME_PATTERNS = Object.freeze([
    /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)/giu,
    /(?:начало|старт|сбор|двери|время|в)\s*[:—–-]?\s*(?:[01]?\d|2[0-3])-[0-5]\d(?!\d)/giu,
]);

const PARTY_STRONG = /(?:вечеринк|тусовк|\bтус[аы]\b|дискотек|after\s*party|afterparty|pre\s*party|preparty|\bparty\b|\brave\b|рейв|club\s*night|клаб\s*найт|танцевальн(?:ая|ый)\s+ночь|ночь\s+танц|ночн(?:ая|ой)\s+вечерин)/iu;
const EVENT_MEDIUM = /(?:концерт|live\b|лайв|выступ|шоу|dj\s*set|дидже(?:й|и)|диджейск|сет\b|караоке\s*вечер|музыкальн(?:ый|ая)\s+вечер|трибьют|cover\s*band|кавер[- ]?групп|фест|фестиваль)/iu;
const ANNOUNCEMENT_VERBS = /(?:состо(?:ит|ится)|пройд[её]т|провед[её]м|устроим|устраиваем|приглашаем|жд[её]м\s+вас|встречаемся|готовим|представляем|анонсируем|отмечаем|зажигаем|танцуем|будет\s+(?:вечерин|тус|дискотек|концерт|шоу)|врываемся|качаем\s+танцпол)/iu;
const MUSIC_CUES = /(?:\bdj\b|дидже|за\s+пультом|за\s+вертушками|танцпол|dance\s*floor|музык|сет\b|хиты|трек|beats?|бит(?:ы|ами)?)/iu;
const NEGATIVE_COMMERCIAL = /(?:бизнес[- ]?ланч|доставк|меню|нов(?:ое|инки)\s+меню|акци[яи]|скидк|бронь\s+стол|ваканси|розыгрыш|итоги\s+розыгрыша|дедлайн|продажа\s+билетов\s+до)/iu;
const EXPLICIT_TITLE = /(?:назван(?:ие|ием)|под\s+названием|с\s+названием|вечеринк(?:а|у|и)\s+под\s+названием|party\s+called|дискотек(?:а|у|и)\s+под\s+названием)[\s:—–-]*[«"“„]?([^\n.!?]{3,100}?)[»"”]?(?=$|\n|[.!?])/iu;
const LABELED_TITLE = /(?:^|\n)\s*(?:название|событие|вечеринка|туса|party|дискотека|шоу)\s*[:：—–-]\s*([^\n]{3,120})/iu;
const QUOTED_TITLE = /[«"“„]([^»"”\n]{3,80})[»"”]/u;
const DATE_OR_TIME_LINE = /^\s*(?:\d{1,2}\.\d{1,2}(?:\.\d{2,4})?|\d{1,2}\s+[а-яё]+(?:\s+\d{4})?)(?:\s*(?:в|,|;|—|-)?\s*(?:[01]?\d|2[0-3]):?\d{0,2})?\s*$/iu;
const META_LINE = /^(?:дата|время|начало|старт|двери|где|место|адрес|цена|стоимость|вход|билет|бронь|телефон|контакт)\s*[:：—–-]/iu;
const VENUE_OR_ADDRESS_ONLY = /^(?:(?:бар|паб|pub|клуб|club|ресторан|кафе|hall|зал|venue)\s+[^.!?]{1,80}|(?:ул\.?|улица|проспект|пр-т|пл\.?|площадь|пер\.?|переулок)\s+[^.!?]{1,80})$/iu;
const GENERIC_CALL_TO_ACTION = /^(?:жд[её]м\s+вас|до\s+встречи|бронируй(?:те)?|бронь|вход\s+свободный|подробности|мест\s+мало|успей(?:те)?|приходи(?:те)?|собираемся)$/iu;
const UI_CAROUSEL_LINE = /^\s*\d{1,2}\s*\/\s*\d{1,2}\s*$/u;

function compact(value, maximum = 240) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, maximum);
}

function collectTimeEvidence(text) {
    const source = String(text ?? '');
    const evidence = [];
    for (const pattern of SECONDARY_TIME_PATTERNS) {
        pattern.lastIndex = 0;
        let match;
        while ((match = pattern.exec(source)) !== null && evidence.length < 12) {
            const raw = compact(match[0], 80);
            if (raw && !evidence.includes(raw)) evidence.push(raw);
            if (!pattern.global) break;
        }
    }
    return evidence;
}

function isCarouselMention(source, mention) {
    const text = String(source ?? '');
    const start = text.lastIndexOf('\n', Number(mention?.index || 0)) + 1;
    let end = text.indexOf('\n', Number(mention?.index || 0));
    if (end < 0) end = text.length;
    const line = text.slice(start, end).trim();
    if (!UI_CAROUSEL_LINE.test(line)) return false;
    const around = text.slice(Math.max(0, start - 100), Math.min(text.length, end + 100));
    return /(?:следующ(?:ий|ая)\s+слайд|предыдущ(?:ий|ая)\s+слайд|carousel|слайд)/iu.test(around) || /^\d{1,2}\s*\/\s*\d{1,2}$/u.test(line);
}

function meaningfulDateMentions(text) {
    const source = String(text ?? '');
    return extractRawDateMentions(source).filter((mention) => !isCarouselMention(source, mention));
}

function relativeDateEvidence(text) {
    const source = String(text ?? '');
    const result = [];
    for (const match of source.matchAll(/(?<![\p{L}\d])(?:сегодня|завтра|послезавтра)(?![\p{L}\d])/giu)) {
        result.push({ raw: match[0], kind: 'relative-day', index: match.index });
    }
    for (const match of source.matchAll(/(?<![\p{L}\d])(?:в\s+)?(?:эт(?:у|от)|ближайш(?:ую|ий))?\s*(?:понедельник|вторник|сред[ау]|четверг|пятниц[ау]|суббот[ау]|воскресень[ея])(?![\p{L}\d])/giu)) {
        result.push({ raw: compact(match[0], 80), kind: 'weekday', index: match.index });
    }
    return result.slice(0, 12);
}

function cleanLikelyTitle(value) {
    const title = compact(value, 140)
        .replace(/https?:\/\/\S+/giu, ' ')
        .replace(/^[\s•*—–-]+|[\s•*—–-]+$/gu, '')
        .replace(/\s{2,}/gu, ' ')
        .trim();
    if (title.length < 3 || title.length > 120) return '';
    if (DATE_OR_TIME_LINE.test(title) || META_LINE.test(title) || UI_CAROUSEL_LINE.test(title)) return '';
    if (!/[\p{L}]/u.test(title)) return '';
    return title;
}

function inferLikelyTitle(text) {
    const source = String(text ?? '');
    const labeled = cleanLikelyTitle(source.match(LABELED_TITLE)?.[1] || '');
    if (labeled) return { title: labeled, confidence: 98, method: 'labeled-title' };

    const explicit = cleanLikelyTitle(source.match(EXPLICIT_TITLE)?.[1] || '');
    if (explicit) return { title: explicit, confidence: 95, method: 'event-name-construction' };

    const quoted = cleanLikelyTitle(source.match(QUOTED_TITLE)?.[1] || '');
    if (quoted && !/(?:бар|клуб|ресторан|паб|кафе|hall|venue)$/iu.test(quoted)) {
        return { title: quoted, confidence: 84, method: 'quoted-title' };
    }

    const lines = source.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
    const dateMentions = meaningfulDateMentions(source);
    for (const mention of dateMentions) {
        const start = source.lastIndexOf('\n', mention.index) + 1;
        let end = source.indexOf('\n', mention.index);
        if (end < 0) end = source.length;
        const line = source.slice(start, end).trim();
        const lineIndex = lines.indexOf(line);
        for (const candidate of [lines[lineIndex - 1], lines[lineIndex + 1], line]) {
            const cleaned = cleanLikelyTitle(candidate);
            if (!cleaned) continue;
            const words = cleaned.match(/[\p{L}][\p{L}\d'’&+.-]*/gu) || [];
            const caps = cleaned.replace(/[^\p{L}]/gu, '');
            const capsRatio = caps ? (caps.match(/\p{Lu}/gu) || []).length / caps.length : 0;
            if (PARTY_STRONG.test(cleaned) || EVENT_MEDIUM.test(cleaned)) {
                return { title: cleaned, confidence: 76, method: 'date-adjacent-event-line' };
            }
            if (words.length >= 1 && words.length <= 9 && capsRatio >= 0.55) {
                return { title: cleaned, confidence: 72, method: 'date-adjacent-display-title' };
            }
            // Club announcements often use a plain mixed-case proper name on
            // the line immediately before/after the date (e.g. "Stonehand").
            // Admit it to vision when it is short and title-like; the joint AI
            // still makes the final announcement/media decision.
            if (
                words.length >= 1 &&
                words.length <= 7 &&
                cleaned.length <= 72 &&
                !VENUE_OR_ADDRESS_ONLY.test(cleaned) &&
                !GENERIC_CALL_TO_ACTION.test(cleaned) &&
                !/[.!?]{2,}/u.test(cleaned)
            ) {
                return { title: cleaned, confidence: 67, method: 'date-adjacent-short-title' };
            }
        }
    }

    const eventLine = lines.find((line) => {
        const cleaned = cleanLikelyTitle(line);
        return cleaned && (PARTY_STRONG.test(cleaned) || EVENT_MEDIUM.test(cleaned)) && cleaned.length <= 120;
    });
    if (eventLine) return { title: cleanLikelyTitle(eventLine), confidence: 66, method: 'event-line' };

    return { title: '', confidence: 0, method: '' };
}

function scoreIntent(text, titleInfo, hasTime) {
    const source = String(text ?? '');
    let score = 0;
    const reasons = [];
    const add = (condition, points, reason) => {
        if (!condition) return;
        score += points;
        reasons.push(reason);
    };
    add(PARTY_STRONG.test(source), 50, 'strong-party-language');
    add(EVENT_MEDIUM.test(source), 30, 'music-or-live-event-language');
    add(ANNOUNCEMENT_VERBS.test(source), 25, 'announcement-verb');
    add(MUSIC_CUES.test(source), 15, 'music-dance-cue');
    add(Boolean(titleInfo.title), Math.min(20, Math.round(titleInfo.confidence / 5)), `title:${titleInfo.method || 'heuristic'}`);
    add(hasTime, 10, 'explicit-time-in-body');
    if (NEGATIVE_COMMERCIAL.test(source)) {
        score -= 30;
        reasons.push('commercial-or-administrative-negative');
    }
    return { confidence: Math.max(0, Math.min(100, score)), reasons };
}

/**
 * Cheap, deterministic pre-vision gate used ONLY by secondary/bydlo party sources.
 * The actual event date must exist in semantic post text. Publication time/UI
 * metadata never creates date/time evidence. Vision is admitted either by the
 * direct date+time+title route or by the >=65% party/title heuristic route.
 */
export function explainSecondaryPartyTextGate({
    text = '',
    publishedAt = 0,
    referenceNow = new Date(),
    timeZone = 'Europe/Moscow',
} = {}) {
    const bodyText = sanitizeEventBodyText(text).trim();
    const retrospective = explainRetrospectivePost(bodyText);
    const rawDateMentions = meaningfulDateMentions(bodyText);
    const relativeDates = relativeDateEvidence(bodyText);
    const dateAdmission = explainEventAiAdmission({ text: bodyText, publishedAt, referenceNow, timeZone });
    const hasCalendarDateInBody = rawDateMentions.length > 0 || relativeDates.length > 0;
    const hasNonPastDate = relativeDates.length > 0 || Boolean(dateAdmission.hasNonPastDate);
    const timeEvidence = collectTimeEvidence(bodyText);
    const hasTimeInBody = timeEvidence.length > 0;
    const title = inferLikelyTitle(bodyText);
    const intent = scoreIntent(bodyText, title, hasTimeInBody);
    const retrospectiveRejected = Boolean(retrospective.reject && !hasNonPastDate);

    const direct = Boolean(
        !retrospectiveRejected &&
        hasCalendarDateInBody &&
        hasNonPastDate &&
        hasTimeInBody &&
        title.confidence >= 50 &&
        intent.confidence >= 35
    );
    const heuristic = Boolean(
        !retrospectiveRejected &&
        hasCalendarDateInBody &&
        hasNonPastDate &&
        title.confidence >= 65 &&
        intent.confidence >= 65
    );
    const visionEligible = Boolean(direct || heuristic);

    let rejectionReason = '';
    if (!bodyText) rejectionReason = 'empty-semantic-body';
    else if (retrospectiveRejected) rejectionReason = 'retrospective-post';
    else if (!hasCalendarDateInBody) rejectionReason = 'no-date-in-semantic-body';
    else if (!hasNonPastDate) rejectionReason = 'no-current-or-future-date-in-semantic-body';
    else if (!title.title || title.confidence < 50) rejectionReason = 'no-likely-event-title-in-body';
    else if (!hasTimeInBody && !(title.confidence >= 65 && intent.confidence >= 65)) rejectionReason = 'no-time-and-heuristic-below-65';
    else if (!visionEligible && intent.confidence < 45) rejectionReason = 'party-intent-too-weak';
    else if (!visionEligible) rejectionReason = 'secondary-pre-ai-gate-rejected';

    return {
        candidate: visionEligible,
        visionEligible,
        route: direct ? 'date-time-title-direct' : heuristic ? 'date-title-party-heuristic-65' : 'blocked',
        rejectionReason,
        evidenceSource: 'semantic-post-text-only',
        metadataDateAccepted: false,
        bodyText,
        hasCalendarDateInBody,
        hasNonPastDate,
        calendarDateEvidence: rawDateMentions.slice(0, 12).map((item) => ({
            raw: item.raw,
            index: item.index,
            day: item.day,
            month: item.month,
            explicitYear: item.explicitYear || null,
        })),
        relativeDateEvidence: relativeDates,
        hasTimeInBody,
        timeEvidence,
        likelyTitle: title.title,
        titleConfidence: title.confidence,
        titleMethod: title.method,
        eventIntentConfidence: intent.confidence,
        eventIntentReasons: intent.reasons,
        retrospectiveRejected,
        direct,
        heuristic,
    };
}

export function secondaryJointVisionAccepted(facts) {
    const source = String(facts ?? '');
    const explicit = [...source.matchAll(/(?:^|\n)\s*(?:совокупность\s+(?:текста\s+и\s+картинки\s+)?является\s+анонсом|итоговый\s+анонс|announcement\s+accepted)\s*[:：-]\s*(да|нет|yes|no|true|false)(?![\p{L}\d])/giu)]
        .map((match) => String(match?.[1] || '').toLowerCase());
    // Multi-image posts are accepted when at least one image + the same post
    // text forms a valid announcement. A rejected first photo must not hide a
    // later actual poster.
    if (explicit.some((value) => /^(?:да|yes|true)$/iu.test(value))) return true;
    if (explicit.length && explicit.every((value) => /^(?:нет|no|false)$/iu.test(value))) return false;
    return /(?:^|\n)\s*(?:это\s+афиша\s+события|афиша\s+события|event\s+poster)\s*[:：-]\s*(?:да|yes|true)(?![\p{L}\d])/iu.test(source);
}
