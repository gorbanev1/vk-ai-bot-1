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

    const leftTitle = String(pair?.left?.title ?? '').trim();
    const rightTitle = String(pair?.right?.title ?? '').trim();
    if (!leftTitle || !rightTitle) return false;

    const normalizedLeft = normalizeEventMatchTitle(leftTitle);
    const normalizedRight = normalizeEventMatchTitle(rightTitle);
    if (!normalizedLeft || !normalizedRight) return false;

    // Exact name + exact/overlapping date is resolved without AI.
    if (normalizedLeft === normalizedRight) return false;

    const shorter = normalizedLeft.length <= normalizedRight.length
        ? normalizedLeft
        : normalizedRight;
    const longer = normalizedLeft.length <= normalizedRight.length
        ? normalizedRight
        : normalizedLeft;
    const contained = shorter.length >= 4 && longer.includes(shorter);
    const similarity = eventTitleSimilarity(leftTitle, rightTitle);

    return contained || similarity >= similarityThreshold;
}
