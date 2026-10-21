import {
    addDaysToDateString,
    getLocalDateString,
    zonedDateTimeToUtcMilliseconds,
} from '../../shared/date.js';

export const SECONDARY_PARTY_AUTO_INTERVAL_DAYS = 3;
export const SECONDARY_PARTY_AUTO_HOUR = 4;

function safeNowMs(value) {
    const numeric = value instanceof Date ? value.getTime() : Number(value);
    return Number.isFinite(numeric) && numeric > 0 ? numeric : Date.now();
}

export function getInitialSecondaryPartyAutoRunAt({
    now = Date.now(),
    timeZone = 'Europe/Moscow',
} = {}) {
    const nowMs = safeNowMs(now);
    const localDay = getLocalDateString(new Date(nowMs), timeZone);
    const todayAtFour = zonedDateTimeToUtcMilliseconds(
        localDay,
        SECONDARY_PARTY_AUTO_HOUR,
        0,
        timeZone,
    );
    if (todayAtFour > nowMs) return Math.floor(todayAtFour / 1000);
    const tomorrow = addDaysToDateString(localDay, 1);
    return Math.floor(zonedDateTimeToUtcMilliseconds(
        tomorrow,
        SECONDARY_PARTY_AUTO_HOUR,
        0,
        timeZone,
    ) / 1000);
}

export function getNextSecondaryPartyAutoRunAt({
    scheduledAt,
    now = Date.now(),
    timeZone = 'Europe/Moscow',
} = {}) {
    const nowMs = safeNowMs(now);
    let baseSeconds = Number(scheduledAt || 0);
    if (!(baseSeconds > 0)) {
        return getInitialSecondaryPartyAutoRunAt({ now: nowMs, timeZone });
    }

    let localDay = getLocalDateString(new Date(baseSeconds * 1000), timeZone);
    let candidateMs = baseSeconds * 1000;
    do {
        localDay = addDaysToDateString(localDay, SECONDARY_PARTY_AUTO_INTERVAL_DAYS);
        candidateMs = zonedDateTimeToUtcMilliseconds(
            localDay,
            SECONDARY_PARTY_AUTO_HOUR,
            0,
            timeZone,
        );
    } while (candidateMs <= nowMs);

    return Math.floor(candidateMs / 1000);
}
