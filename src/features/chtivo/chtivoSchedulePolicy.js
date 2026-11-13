const DEFAULT_TIME_ZONE = 'Europe/Moscow';
const DEFAULT_GAP_MINUTES = 30;

function getLocalDateParts(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    return Object.fromEntries(parts.map((part) => [part.type, part.value]));
}

function getLocalMinuteOfDay(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const values = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return Number(values.hour || 0) * 60 + Number(values.minute || 0);
}

function wallClockToEpoch(dateParts, minuteOfDay, timeZone) {
    const wallClockUtc = Date.UTC(
        Number(dateParts.year),
        Number(dateParts.month) - 1,
        Number(dateParts.day),
        Math.floor(minuteOfDay / 60),
        minuteOfDay % 60,
    );
    const probe = new Date(wallClockUtc);
    const localParts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(probe);
    const local = Object.fromEntries(localParts.map((part) => [part.type, part.value]));
    const representedWallClock = Date.UTC(
        Number(local.year),
        Number(local.month) - 1,
        Number(local.day),
        Number(local.hour),
        Number(local.minute),
    );
    return wallClockUtc - (representedWallClock - wallClockUtc);
}

export function nextChtivoDropAt(now, remainingBatches, {
    timeZone = DEFAULT_TIME_ZONE,
    minimumGapMinutes = DEFAULT_GAP_MINUTES,
    startMinute = 10 * 60,
    endMinute = 23 * 60 + 45,
    random = Math.random,
} = {}) {
    const remaining = Math.max(0, Math.floor(Number(remainingBatches) || 0));
    if (!remaining) return 0;

    const current = now instanceof Date ? now : new Date(now);
    const nowMs = current.getTime();
    if (!Number.isFinite(nowMs)) throw new TypeError('A valid date is required.');

    const dateParts = getLocalDateParts(current, timeZone);
    const localMinute = getLocalMinuteOfDay(current, timeZone);
    const endAt = wallClockToEpoch(dateParts, endMinute, timeZone);
    const startAt = wallClockToEpoch(dateParts, startMinute, timeZone);
    const gapMs = Math.max(0, Number(minimumGapMinutes) || 0) * 60_000;
    const earliestAt = localMinute < startMinute ? Math.max(nowMs + 60_000, startAt) : nowMs + 60_000;
    const latestAt = endAt - Math.max(0, remaining - 1) * gapMs;

    if (localMinute >= endMinute || latestAt < earliestAt) {
        return Math.floor(Math.max(nowMs + 30_000, earliestAt) / 1000);
    }

    const span = Math.max(0, latestAt - earliestAt);
    const sample = Math.min(0.999999999, Math.max(0, Number(random()) || 0));
    return Math.floor((earliestAt + span * sample) / 1000);
}

export function chtivoScheduledBatchSize(remainingChunks, now, {
    timeZone = DEFAULT_TIME_ZONE,
    minimumGapMinutes = DEFAULT_GAP_MINUTES,
    endMinute = 23 * 60 + 45,
    configuredBatchSize = 1,
} = {}) {
    const chunks = Math.max(0, Math.floor(Number(remainingChunks) || 0));
    if (!chunks) return 1;
    const current = now instanceof Date ? now : new Date(now);
    const dateParts = getLocalDateParts(current, timeZone);
    const endAt = wallClockToEpoch(dateParts, endMinute, timeZone);
    const remainingMs = Math.max(0, endAt - current.getTime());
    const gapMs = Math.max(1, Number(minimumGapMinutes) || DEFAULT_GAP_MINUTES) * 60_000;
    const availableBatches = Math.max(1, Math.floor(remainingMs / gapMs) + 1);
    const neededPerBatch = Math.ceil(chunks / availableBatches);
    return Math.min(chunks, Math.max(1, Number(configuredBatchSize) || 1, neededPerBatch));
}
