/**
 * V149: дешёвый gate перед вторым (AI) контуром дедупликации.
 *
 * ИИ вызывается только когда:
 *  - у карточек есть хотя бы одна общая календарная дата;
 *  - нет hard conflict из deterministic contour;
 *  - названия НЕ идентичны после нормализации;
 *  - но названия частично совпадают или достаточно похожи.
 *
 * Полное название + дата — deterministic случай, AI там только тратит время.
 */
import {
    eventTitleSimilarity,
    normalizeEventMatchTitle,
} from './eventModeration.js';
import { eventParticipantsMatchedCount } from './eventDuplicateResolution.js';
import { sharedIdentityWords, transliteratedIdentityTokens } from './eventIdentityTokens.js';

export function eventDuplicatePairSharedDates(pair) {
    // A card has one canonical calendar identity. eventDays is retained as
    // source/audit schedule and must not make two different daily cards look
    // mergeable (a multi-day announcement can otherwise share every date).
    const canonicalDate = (event) => String(event?.eventDate || event?.date || '').trim();
    const leftDates = new Set([
        canonicalDate(pair?.left),
    ].filter(Boolean));
    const rightDates = new Set([
        canonicalDate(pair?.right),
    ].filter(Boolean));

    return [...leftDates].filter((date) => rightDates.has(date));
}

export function shouldReviewEventDuplicatePairWithAi(pair, {
    similarityThreshold = 0.42,
} = {}) {
    const hardConflicts = Array.isArray(pair?.contour1?.hardConflicts)
        ? pair.contour1.hardConflicts
        : [];
    if (hardConflicts.length) return false;
    if (!eventDuplicatePairSharedDates(pair).length) return false;

    const participantOverlap = eventParticipantsMatchedCount(
        pair?.left?.participants,
        pair?.right?.participants,
    ) > 0;
    const leftTitle = String(pair?.left?.title ?? '').trim();
    const rightTitle = String(pair?.right?.title ?? '').trim();
    if (!leftTitle || !rightTitle) return participantOverlap;
    const variants = (event) => [...new Set([String(event?.title ?? '').trim(), ...(Array.isArray(event?.alternativeTitles) ? event.alternativeTitles : [])].filter(Boolean))];
    const hasCyrillic = (value) => /[А-Яа-яЁё]/u.test(String(value ?? ''));
    const hasLatin = (value) => /[A-Za-z]/u.test(String(value ?? ''));
    const crossLanguage = variants(pair?.left).some((left) => variants(pair?.right).some((right) =>
        (hasCyrillic(left) && hasLatin(right)) || (hasLatin(left) && hasCyrillic(right))));
    if (crossLanguage) return true;

    const normalizedLeft = normalizeEventMatchTitle(leftTitle);
    const normalizedRight = normalizeEventMatchTitle(rightTitle);
    if (!normalizedLeft || !normalizedRight) return participantOverlap;

    const directShared = sharedIdentityWords(leftTitle, rightTitle);
    const leftTranslit = new Set(transliteratedIdentityTokens(leftTitle));
    const rightTranslit = new Set(transliteratedIdentityTokens(rightTitle));
    const translitShared = [...leftTranslit].filter((token) => rightTranslit.has(token));

    // A same-date shared content word (including an exact normalized title)
    // is always sent to AI.  The deterministic contour supplies scores only;
    // it must not decide this identity or suppress the review.
    if (directShared.length || translitShared.length) return true;
    if (normalizedLeft === normalizedRight) return true;

    const shorter = normalizedLeft.length <= normalizedRight.length
        ? normalizedLeft
        : normalizedRight;
    const longer = normalizedLeft.length <= normalizedRight.length
        ? normalizedRight
        : normalizedLeft;
    const contained = shorter.length >= 4 && longer.includes(shorter);
    const similarity = eventTitleSimilarity(leftTitle, rightTitle);

    // Participant overlap is a fallback trigger only when title comparison
    // did not already find a partial identity signal.
    return contained || similarity >= similarityThreshold || participantOverlap;
}
