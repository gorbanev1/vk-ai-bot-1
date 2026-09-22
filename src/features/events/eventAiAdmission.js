import {
    extractExplicitDateMentions,
    extractRawDateMentions,
    inferEventYear,
    toIsoEventDate,
} from './publicPostDateEvidence.js';
import {
    explainOperationalStatusPost,
    explainRetrospectivePost,
    sanitizeEventBodyText,
} from './eventTextSanitation.js';

const DAY_MS = 86_400_000;
const TITLE_LABEL_PATTERN = /(?:^|\n)\s*(?:что|название|событие|кто|участники|лайн-?ап|line[ -]?up|lineup)\s*(?::|;|：|[—–-])\s*([^\n]{3,220})/iu;
const SOURCE_ONLY_PATTERN = /^(?:rock\s+bar\s+diesel(?:\s*&\s*diesel\s+hall)?|overlock(?:\s+bar)?|рок-?бар\s+[«"]?the\s+last\s+of\s+vavilone[»"]?|liverpool\s+pub|паб\s+мама\s+анархия|мама\s+анархия|митбоулинг\s+клуб|бар\s+[«"]?тупик[»"]?)$/iu;
const TITLE_JUNK_PATTERN = /^(?:когда|дата|время|начало|старт|где|место|адрес|площадка|локаци(?:я|и)|поч[её]м|цена|стоимость|вход|билеты?|запись\s+закреплена|сообщение|история\s+скрыта|нажмите,\s*чтобы\s+развернуть|добавить\s+в\s+мою\s+музыку|воспроизвести)$/iu;
const TITLE_JUNK_PREFIX_PATTERN = /^(?:когда|дата(?:\s+розыгрыша)?|время|начало|старт|где|место|адрес|площадка|локаци(?:я|и)|поч[её]м|цена|стоимость|вход|билеты?)\s*(?::|;|：|[—–-])/iu;
const NON_EVENT_DATE_CONTEXT_PATTERN = /(?:дата\s+розыгрыша|итоги(?:\s+розыгрыша)?|дедлайн|при[её]м\s+(?:заявок|анкет)|регистрац(?:ия|ии|ию)\s+до|продаж[аи]\s+(?:билетов?\s+)?до|билеты?\s+до|скидк[аи]\s+до|цена\s+до)[^\n]{0,40}$/iu;
const TIME_PATTERN = /(?<!\d)(?:[01]?\d|2[0-3]):[0-5]\d(?!\d)|(?:начало|старт|сбор|двери|время|в)\s*[:—–-]?\s*(?:[01]?\d|2[0-3])-[0-5]\d(?!\d)/gu;
const EVENT_WORD_PATTERN = /(?:концерт|вечерин|мероприят|событи|фест|фестиваль|гиг|рейв|party|выступ|шоу|маркет|квиз|стендап|джем|турнир|спектакл|показ)/iu;

function localDateParts(date, timeZone = 'Europe/Moscow') {
    const safeDate = date instanceof Date ? date : new Date(date);
    if (!Number.isFinite(safeDate.getTime())) return null;
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(safeDate);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
        year: Number(map.year),
        month: Number(map.month),
        day: Number(map.day),
    };
}

function compact(value, maximum = 220) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, maximum);
}

function meaningfulTitle(value) {
    const source = compact(value, 260)
        .replace(/https?:\/\/\S+/giu, ' ')
        .replace(TIME_PATTERN, ' ')
        .replace(/[\d\s.,;:()\[\]{}|/\\]+/gu, ' ')
        .replace(/^[—–-]+|[—–-]+$/gu, ' ')
        .replace(/\s{2,}/gu, ' ')
        .trim();
    if (source.length < 3) return '';
    if (SOURCE_ONLY_PATTERN.test(source) || TITLE_JUNK_PATTERN.test(source) || TITLE_JUNK_PREFIX_PATTERN.test(source)) return '';
    const words = source.match(/[\p{L}][\p{L}'’&+.-]{2,}/gu) || [];
    return words.length ? compact(value, 180) : '';
}

function titleEvidenceFromText(text, mentions) {
    const source = String(text ?? '');
    const labeled = source.match(TITLE_LABEL_PATTERN)?.[1] || '';
    const labeledTitle = meaningfulTitle(labeled);
    if (labeledTitle) {
        return { hasTitle: true, evidence: labeledTitle, method: 'labeled-title-or-participants' };
    }

    const lines = source.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
    for (const mention of mentions) {
        const start = source.lastIndexOf('\n', mention.index) + 1;
        let end = source.indexOf('\n', mention.index);
        if (end < 0) end = source.length;
        const line = source.slice(start, end).trim();
        const relativeIndex = Math.max(0, mention.index - start);
        const before = line.slice(0, relativeIndex)
            .replace(/(?:когда|дата)\s*[:—–-]?\s*$/iu, '')
            .replace(/(?:сегодня|завтра|послезавтра)\s*$/iu, '')
            .trim();
        const beforeTitle = meaningfulTitle(before);
        if (beforeTitle) {
            return { hasTitle: true, evidence: beforeTitle, method: 'same-line-before-date' };
        }

        const after = line.slice(relativeIndex + mention.length)
            .replace(/^\s*[,;|—–-]?\s*(?:в\s*)?(?:[01]?\d|2[0-3]):[0-5]\d\s*/u, '')
            .trim();
        const afterTitle = meaningfulTitle(after);
        if (afterTitle && (EVENT_WORD_PATTERN.test(after) || /(?:^|\s)[А-ЯA-ZЁ][\p{L}A-ZЁ0-9'’&+.-]{2,}/u.test(after))) {
            return { hasTitle: true, evidence: afterTitle, method: 'same-line-after-date' };
        }

        const lineIndex = lines.indexOf(line);
        for (const adjacent of [lines[lineIndex - 1], lines[lineIndex + 1]]) {
            const adjacentTitle = meaningfulTitle(adjacent);
            if (adjacentTitle) {
                return { hasTitle: true, evidence: adjacentTitle, method: 'adjacent-line' };
            }
        }
    }

    return { hasTitle: false, evidence: '', method: '' };
}

function mentionContext(source, mention, radius = 90) {
    const text = String(source ?? '');
    const start = Math.max(0, Number(mention?.index || 0) - radius);
    const end = Math.min(text.length, Number(mention?.index || 0) + Number(mention?.length || 0) + radius);
    return compact(text.slice(start, end), radius * 2 + 40);
}

function isAdministrativeDateMention(source, mention) {
    const text = String(source ?? '');
    const before = text.slice(Math.max(0, Number(mention?.index || 0) - 90), Number(mention?.index || 0));
    return NON_EVENT_DATE_CONTEXT_PATTERN.test(before);
}

function resolveMentionDate(mention, { publishedAt = 0, referenceNow = new Date(), timeZone = 'Europe/Moscow' } = {}) {
    const todayParts = localDateParts(referenceNow, timeZone);
    if (!todayParts) return null;
    const explicitYear = Number(mention?.explicitYear || 0) || null;
    const inferredFromPublication = !explicitYear
        ? inferEventYear({ month: mention?.month, publishedAt, timeZone })
        : null;
    let year = explicitYear || inferredFromPublication;
    let yearInferenceSource = explicitYear
        ? 'body-explicit-year'
        : inferredFromPublication
            ? 'published-at-for-year-only'
            : 'current-date-fallback';
    const today = Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day);
    if (!year) {
        year = todayParts.year;
        const currentYearValue = Date.UTC(year, Number(mention.month) - 1, Number(mention.day));
        // Without source timestamp, a month more than half a year behind the
        // current date is more plausibly an announcement for the next year.
        if (currentYearValue < today - 183 * DAY_MS) year += 1;
    }
    const isoDate = toIsoEventDate(year, mention.month, mention.day);
    if (!isoDate) return null;
    const value = Date.UTC(year, Number(mention.month) - 1, Number(mention.day));
    return {
        raw: String(mention.raw || ''),
        date: isoDate,
        deltaDays: Math.round((value - today) / DAY_MS),
        explicitYear,
        yearInferenceSource,
    };
}

/**
 * Strict pre-AI gate. Structural candidate detection may stay broad for
 * diagnostics/recovery, but an expensive model call is admitted only when the
 * actual announcement body contains a calendar date, a usable event title (or
 * participants acting as the title), and at least one such date is today/future.
 * UI/published metadata is intentionally not accepted as text evidence.
 */
export function explainEventAiAdmission({
    text = '',
    publishedAt = 0,
    referenceNow = new Date(),
    timeZone = 'Europe/Moscow',
} = {}) {
    const source = sanitizeEventBodyText(text);
    const retrospective = explainRetrospectivePost(source);
    const operationalStatus = explainOperationalStatusPost(source);
    const mentions = extractRawDateMentions(source);
    const todayParts = localDateParts(referenceNow, timeZone);
    const today = todayParts
        ? Date.UTC(todayParts.year, todayParts.month - 1, todayParts.day)
        : NaN;
    // Use the same unified resolver as the local parser. This intentionally
    // admits ISO dates, relative dates (today/tomorrow) and weekdays while
    // retaining raw source positions for title/context evidence.
    const resolvedDates = extractExplicitDateMentions(source, publishedAt, { referenceNow, timeZone })
        .map((mention) => {
            const value = Date.parse(`${mention.date}T00:00:00Z`);
            const administrative = isAdministrativeDateMention(source, mention);
            return {
                raw: String(mention.raw || ''),
                date: String(mention.date || ''),
                deltaDays: Number.isFinite(value) && Number.isFinite(today)
                    ? Math.round((value - today) / DAY_MS)
                    : 0,
                explicitYear: Number(mention.explicitYear || 0) || null,
                yearInferenceSource: mention.explicitYear
                    ? 'body-explicit-year'
                    : String(mention.yearSource || '').startsWith('published_at')
                        ? 'published-at-for-year-only'
                        : String(mention.yearSource || '').startsWith('reference_now')
                            ? 'current-date-fallback'
                            : String(mention.yearSource || ''),
                context: mentionContext(source, mention),
                role: administrative ? 'administrative-date' : 'event-date-candidate',
            };
        });
    const eventDateCandidates = resolvedDates.filter((item) => item.role !== 'administrative-date');
    const nonPastDates = eventDateCandidates.filter((item) => item.deltaDays >= 0);
    const title = titleEvidenceFromText(source, mentions);
    const hasCalendarDate = mentions.length > 0;
    const hasEventDateCandidate = eventDateCandidates.length > 0;
    const hasNonPastDate = nonPastDates.length > 0;
    // Retrospective language is a hard negative only when the post does not
    // separately prove a today/future event date. This keeps photo reports out
    // while allowing posts like "как это было ... следующая встреча 20 октября".
    const retrospectiveRejected = Boolean(retrospective.reject && !hasNonPastDate);
    // Operational venue notices are not event announcements by themselves.
    // Example: "По техническим причинам бар сегодня не работает. Завтра ждём
    // вас на концерт ...". Keep them out of main AI unless a real poster is
    // independently proven by the poster-vision rescue below.
    const operationalStatusRejected = Boolean(operationalStatus.rejectAsAnnouncement);
    const eligible = Boolean(!operationalStatusRejected && !retrospectiveRejected && hasEventDateCandidate && title.hasTitle && hasNonPastDate);
    let rejectionReason = '';
    if (operationalStatusRejected) rejectionReason = 'service-status-not-event-announcement';
    else if (retrospectiveRejected) rejectionReason = 'retrospective-post';
    else if (!hasCalendarDate) rejectionReason = 'no-calendar-date-in-body';
    else if (!hasEventDateCandidate) rejectionReason = 'only-administrative-dates-in-body';
    else if (!title.hasTitle) rejectionReason = 'no-event-title-in-body';
    else if (!hasNonPastDate) rejectionReason = 'all-body-event-dates-are-past';

    return {
        eligible,
        rejectionReason,
        dateSource: 'body-text-only',
        publishedAtUsage: 'never-date-evidence; year-disambiguation-only-when-body-omits-year',
        hasCalendarDate,
        hasEventDateCandidate,
        hasNonPastDate,
        hasTitle: title.hasTitle,
        retrospectiveRejected,
        operationalStatusRejected,
        titleEvidence: title.evidence,
        titleMethod: title.method,
        dateEvidence: resolvedDates.slice(0, 12),
        admittedDateEvidence: nonPastDates.slice(0, 12),
    };
}

function posterVisionExplicitlyAcceptsEvent(facts) {
    const source = String(facts ?? '');
    return /(?:^|\n)[ \t]*(?:это\s+афиша\s+события|афиша\s+события|event\s+poster)[ \t]*[:：-][ \t]*(?:да|yes|true)(?=[ \t]*(?:\n|$))/iu.test(source);
}

function posterVisionExplicitlyRejectsEvent(facts) {
    const source = String(facts ?? '');
    const hasYes = posterVisionExplicitlyAcceptsEvent(source);
    const hasNo = /(?:^|\n)[ \t]*(?:это\s+афиша\s+события|афиша\s+события|event\s+poster)[ \t]*[:：-][ \t]*(?:нет|no|false)(?=[ \t]*(?:\n|$))/iu.test(source);
    return hasNo && !hasYes;
}

function posterVisionLabeledField(facts, labels) {
    const source = String(facts ?? '');
    const label = Array.isArray(labels) ? labels.join('|') : String(labels || '');
    const match = source.match(
        new RegExp(`(?:^|\\n)[ \\t]*(?:${label})[ \\t]*[:：-][ \\t]*([^\\n]*)`, 'iu'),
    );
    const value = String(match?.[1] ?? '').trim();
    if (!value || /^(?:—|-|нет|не\s+указано|неизвестно|unknown|none|null)$/iu.test(value)) return '';
    return value;
}

function splitPosterVisionFactBlocks(facts) {
    const source = String(facts ?? '').trim();
    if (!source) return [];
    const blocks = source
        .split(/(?=^[ \t]*\[IMAGE\s+\d+\][ \t]*$)/gimu)
        .map((item) => item.trim())
        .filter(Boolean);
    return blocks.length ? blocks : [source];
}

/**
 * V188.63: combine the strict body gate with a narrow poster-vision fallback.
 * Poster OCR/vision is allowed to RESCUE a body-rejected structural candidate,
 * but publication/UI metadata still cannot create event-date evidence.
 */
export function explainEventAiAdmissionWithPosterFacts({
    text = '',
    posterFacts = '',
    posterVisionAttempted = false,
    publishedAt = 0,
    referenceNow = new Date(),
    timeZone = 'Europe/Moscow',
} = {}) {
    const bodyAdmission = explainEventAiAdmission({
        text,
        publishedAt,
        referenceNow,
        timeZone,
    });

    if (bodyAdmission.eligible) {
        return {
            ...bodyAdmission,
            admissionPath: 'body-text',
            posterVisionAttempted: Boolean(posterVisionAttempted),
            posterVisionChecked: false,
            bodyRejectionReason: '',
            posterVisionRejectionReason: '',
        };
    }

    const facts = String(posterFacts ?? '').trim();
    if (!facts) {
        return {
            ...bodyAdmission,
            admissionPath: 'blocked',
            posterVisionAttempted: Boolean(posterVisionAttempted),
            posterVisionChecked: Boolean(posterVisionAttempted),
            bodyRejectionReason: bodyAdmission.rejectionReason,
            posterVisionRejectionReason: posterVisionAttempted ? 'poster-vision-empty-or-failed' : '',
        };
    }

    // Never combine a title from one attachment with a date from another.
    // A single image block must independently prove title + today/future date.
    const posterBlocks = splitPosterVisionFactBlocks(facts);
    const posterBlockAdmissions = posterBlocks.map((block, index) => {
        const admission = explainEventAiAdmission({
            text: block,
            publishedAt,
            referenceNow,
            timeZone,
        });
        const saysEvent = posterVisionExplicitlyAcceptsEvent(block);
        const saysNotEvent = posterVisionExplicitlyRejectsEvent(block);
        const titleField = posterVisionLabeledField(block, ['Название', 'Title']);
        const dateField = posterVisionLabeledField(block, ['Дата', 'Date']);
        return {
            index: index + 1,
            block,
            admission,
            saysEvent,
            saysNotEvent,
            titleField,
            dateField,
            eligible: Boolean(admission.eligible && saysEvent && !saysNotEvent && titleField && dateField),
        };
    });
    const rescued = posterBlockAdmissions.find((item) => item.eligible);

    if (rescued) {
        return {
            ...rescued.admission,
            eligible: true,
            rejectionReason: '',
            dateSource: 'poster-vision',
            admissionPath: 'poster-vision-rescue',
            posterVisionAttempted: true,
            posterVisionChecked: true,
            posterVisionImageBlock: rescued.index,
            bodyRejectionReason: bodyAdmission.rejectionReason,
            posterVisionRejectionReason: '',
            posterFactsPreview: compact(rescued.block, 1200),
            bodyAdmission: {
                eligible: bodyAdmission.eligible,
                rejectionReason: bodyAdmission.rejectionReason,
                titleEvidence: bodyAdmission.titleEvidence,
                admittedDateEvidence: bodyAdmission.admittedDateEvidence,
            },
        };
    }

    const considered = posterBlockAdmissions.find((item) => item.saysEvent && !item.saysNotEvent) ||
        posterBlockAdmissions.find((item) => !item.saysNotEvent) ||
        posterBlockAdmissions[0];
    let posterVisionRejectionReason = 'poster-vision-insufficient-evidence';
    if (posterBlockAdmissions.every((item) => item.saysNotEvent)) {
        posterVisionRejectionReason = 'poster-vision-says-not-event';
    } else if (considered && !considered.saysEvent) {
        posterVisionRejectionReason = 'poster-vision-event-status-missing';
    } else if (considered && !considered.titleField) {
        posterVisionRejectionReason = 'no-event-title-on-poster';
    } else if (considered && !considered.dateField) {
        posterVisionRejectionReason = 'no-calendar-date-on-poster';
    } else if (considered?.admission?.rejectionReason) {
        posterVisionRejectionReason = considered.admission.rejectionReason;
    }
    const posterAdmission = considered?.admission || {};

    return {
        ...bodyAdmission,
        admissionPath: 'blocked-after-poster-vision',
        posterVisionAttempted: true,
        posterVisionChecked: true,
        bodyRejectionReason: bodyAdmission.rejectionReason,
        posterVisionRejectionReason,
        posterFactsPreview: compact(facts, 1200),
        posterAdmission: {
            eligible: false,
            rejectionReason: posterVisionRejectionReason,
            hasCalendarDate: Boolean(posterAdmission.hasCalendarDate),
            hasEventDateCandidate: Boolean(posterAdmission.hasEventDateCandidate),
            hasNonPastDate: Boolean(posterAdmission.hasNonPastDate),
            hasTitle: Boolean(posterAdmission.hasTitle),
            titleEvidence: posterAdmission.titleEvidence || '',
            dateEvidence: posterAdmission.dateEvidence || [],
            admittedDateEvidence: posterAdmission.admittedDateEvidence || [],
            imageBlocksChecked: posterBlockAdmissions.length,
        },
    };
}

