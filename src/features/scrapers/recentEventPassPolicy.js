import { extractExplicitDateMentions } from '../events/publicPostDateEvidence.js';

const DAY_MS = 24 * 60 * 60 * 1000;
// A parser run may inspect a broad immutable feed, but an individual post
// older than six months must never enter the expensive poster/browser/Vision
// contours. This applies even to phase 2 (where recentDays is intentionally
// disabled because it replays the phase-1 cache).
export const PARSER_MAX_POST_AGE_DAYS = 183;

function localTodayEpoch(timeZone = 'Europe/Moscow', now = new Date()) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
    }).formatToParts(now);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const value = Date.UTC(Number(map.year), Number(map.month) - 1, Number(map.day));
    return Number.isFinite(value) ? value : NaN;
}

function boundedDays(value, fallback = 3) {
    const parsed = Number(value);
    return Number.isFinite(parsed) ? Math.min(3, Math.max(2, Math.trunc(parsed))) : fallback;
}

/**
 * parser-all may capture a broad immutable DOM, but its expensive contours
 * must only inspect posts changed recently or posts which explicitly contain
 * a current/future event date. A disabled (zero) window keeps single-source
 * and diagnostic runs backwards compatible.
 */
export function explainRecentOrFuturePost({
    publishedAt = 0,
    updatedAt = 0,
    text = '',
    referenceNow = new Date(),
    timeZone = 'Europe/Moscow',
    recentDays = 0,
    contentChanged = false,
    maxPostAgeDays = PARSER_MAX_POST_AGE_DAYS,
} = {}) {
    const days = Number(recentDays) > 0 ? boundedDays(recentDays) : 0;
    const nowMs = referenceNow instanceof Date ? referenceNow.getTime() : Date.parse(referenceNow);
    const safeNowMs = Number.isFinite(nowMs) ? nowMs : Date.now();
    const observed = Math.max(Number(publishedAt) || 0, Number(updatedAt) || 0) * 1000;
    const maxAge = Number(maxPostAgeDays) > 0 ? Math.max(1, Math.trunc(Number(maxPostAgeDays))) : 0;
    const today = localTodayEpoch(timeZone, new Date(safeNowMs));
    // This is a current inventory pass: resolve yearless event dates against
    // today so an old post announcing a still-upcoming event remains eligible.
    const dates = extractExplicitDateMentions(String(text || ''), 0, {
        referenceNow: new Date(safeNowMs), timeZone,
    });
    const futureDates = dates
        .map((mention) => String(mention?.date || ''))
        .filter((date) => /^\d{4}-\d{2}-\d{2}$/u.test(date))
        .filter((date) => Date.parse(`${date}T00:00:00Z`) >= today);
    const maxAgeCutoffMs = maxAge ? safeNowMs - maxAge * DAY_MS : 0;
    if (observed > 0 && maxAgeCutoffMs && observed < maxAgeCutoffMs && !futureDates.length) {
        return { allowed: false, reason: 'parser-post-older-than-six-months', recentDays: days, maxPostAgeDays: maxAge, futureDates: [], maxAgeExceeded: true };
    }
    if (!days) return { allowed: true, reason: 'window-disabled', recentDays: 0, maxPostAgeDays: maxAge, futureDates };
    if (contentChanged) return { allowed: true, reason: 'content-changed-since-last-capture', recentDays: days, maxPostAgeDays: maxAge, futureDates };

    const cutoffMs = safeNowMs - days * DAY_MS;
    const recent = observed > 0 && observed >= cutoffMs;
    if (recent) return { allowed: true, reason: 'recent-post', recentDays: days, maxPostAgeDays: maxAge, futureDates };
    if (futureDates.length) return { allowed: true, reason: 'future-event-date', recentDays: days, maxPostAgeDays: maxAge, futureDates: [...new Set(futureDates)] };
    // Unknown publication timestamps are retained for safety. They cannot be
    // proven stale, and dropping them would violate the no-card-loss contract.
    if (!observed) return { allowed: true, reason: 'unknown-post-date', recentDays: days, maxPostAgeDays: maxAge, futureDates: [] };
    return { allowed: false, reason: 'stale-post-outside-recent-window', recentDays: days, maxPostAgeDays: maxAge, futureDates: [] };
}

export function isRecentOrFuturePost(options = {}) {
    return Boolean(explainRecentOrFuturePost(options).allowed);
}
