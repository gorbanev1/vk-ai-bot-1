import {
    addDaysToDateString,
    getLocalDateString,
    zonedDateTimeToUtcMilliseconds,
} from '../../shared/date.js';

export const AUTO_SUMMARY_MODE_FULL = 'full';
export const AUTO_SUMMARY_MODE_DAY = 'day';
export const AUTO_SUMMARY_MODE_EVENING = 'evening';
export const AUTO_SUMMARY_MODE_CUSTOM = 'custom';

export const AUTO_SUMMARY_MIN_CHARS = 1600;
export const AUTO_SUMMARY_MAX_CHARS = 2400;
export const AUTO_SUMMARY_MIN_PARAGRAPHS = 5;
export const AUTO_SUMMARY_MAX_PARAGRAPHS = 7;
export const AUTO_SUMMARY_STALE_GRACE_SECONDS = 10 * 60;
export const AUTO_SUMMARY_DAY_BOUNDARY_HOUR = 0; // V188.45: calendar day starts at midnight.

const MODE_SLOTS = Object.freeze({
    [AUTO_SUMMARY_MODE_FULL]: Object.freeze(['09:00', '13:00', '15:00', '18:00', '21:00', '23:59']),
    [AUTO_SUMMARY_MODE_DAY]: Object.freeze(['09:00', '13:00', '15:00', '18:00', '21:00', '23:59']),
    [AUTO_SUMMARY_MODE_EVENING]: Object.freeze(['09:00', '13:00', '15:00', '18:00', '21:00', '23:59']),
});

const RUSSIAN_HOUR_WORDS = new Map([
    ['ноль', 0], ['нуль', 0], ['полночь', 0],
    ['час', 1], ['один', 1], ['одна', 1],
    ['два', 2], ['две', 2], ['три', 3], ['четыре', 4], ['пять', 5],
    ['шесть', 6], ['семь', 7], ['восемь', 8], ['девять', 9], ['десять', 10],
    ['одиннадцать', 11], ['двенадцать', 12], ['тринадцать', 13],
    ['четырнадцать', 14], ['пятнадцать', 15], ['шестнадцать', 16],
    ['семнадцать', 17], ['восемнадцать', 18], ['весемнадцать', 18],
    ['девятнадцать', 19], ['двадцать', 20],
    ['двадцать один', 21], ['двадцать одна', 21],
    ['двадцать два', 22], ['двадцать две', 22], ['двадцать три', 23],
]);

export function clampAutoSummaryText(value, maxChars = AUTO_SUMMARY_MAX_CHARS) {
    const limit = Math.max(400, Number(maxChars) || AUTO_SUMMARY_MAX_CHARS);
    const text = String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();

    if (text.length <= limit) return text;

    const slice = text.slice(0, limit + 1);
    const minimumBoundary = Math.min(
        Math.max(AUTO_SUMMARY_MIN_CHARS, Math.floor(limit * 0.72)),
        limit - 1,
    );
    let boundary = -1;

    for (const match of slice.matchAll(/[.!?…](?=\s|$)/gu)) {
        const end = Number(match.index) + match[0].length;
        if (end >= minimumBoundary && end <= limit) boundary = end;
    }

    if (boundary < 0) {
        const paragraphBoundary = slice.lastIndexOf('\n\n', limit);
        if (paragraphBoundary >= minimumBoundary) boundary = paragraphBoundary;
    }

    if (boundary < 0) {
        const wordBoundary = slice.lastIndexOf(' ', limit);
        boundary = wordBoundary >= minimumBoundary ? wordBoundary : limit;
    }

    return slice.slice(0, boundary).trim();
}

function normalize(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[,_;]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function normalizeSlot(value) {
    const match = String(value ?? '').trim().match(/^(\d{1,2})(?::(\d{1,2}))?$/u);
    if (!match) return '';
    const hour = Number(match[1]);
    const minute = match[2] == null ? 0 : Number(match[2]);
    if (!Number.isInteger(hour) || hour < 0 || hour > 23) return '';
    if (!Number.isInteger(minute) || minute < 0 || minute > 59) return '';
    return `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`;
}

export function normalizeAutoSummarySchedule(value) {
    const input = Array.isArray(value) ? value : String(value ?? '').split(/[\s,;]+/u);
    const unique = new Set();
    for (const item of input) {
        const slot = normalizeSlot(item);
        if (slot) unique.add(slot);
    }
    return [...unique].sort((left, right) => {
        const [lh, lm] = left.split(':').map(Number);
        const [rh, rm] = right.split(':').map(Number);
        return (lh * 60 + lm) - (rh * 60 + rm);
    });
}

function replaceRussianNumberWords(value) {
    let text = ` ${normalize(value)} `;
    const phrases = [...RUSSIAN_HOUR_WORDS.keys()].sort((a, b) => b.length - a.length);
    for (const phrase of phrases) {
        const number = RUSSIAN_HOUR_WORDS.get(phrase);
        const escaped = phrase.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        text = text.replace(new RegExp(`(?<=\\s)${escaped}(?=\\s|$)`, 'gu'), String(number));
    }
    return text.replace(/\s+/gu, ' ').trim();
}

export function parseAutoSummarySchedule(value) {
    const normalized = replaceRussianNumberWords(value)
        .replace(/\b(?:в|во|и|на|по|час|часа|часов|ровно)\b/gu, ' ')
        .replace(/[—–-]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
    const matches = normalized.match(/(?:^|\s)([01]?\d|2[0-3])(?::([0-5]?\d))?(?=\s|$)/gu) || [];
    const slots = [];
    for (const raw of matches) {
        const clean = raw.trim();
        const slot = normalizeSlot(clean);
        if (slot) slots.push(slot);
    }
    return normalizeAutoSummarySchedule(slots);
}

function extractConversationTarget(value) {
    const text = String(value ?? '').trim();

    /*
     * Надёжные VK-идентификаторы для команд:
     *   2000000006 / peer_id 2000000006
     *   беседа 6 / чат 6 / c6
     *   https://vk.com/im?sel=c6
     *
     * /im/convo/<...> намеренно НЕ используется как источник peer_id:
     * веб-маршрут VK может быть персональным/редиректиться и ранее приводил
     * к выбору не той беседы.
     */
    const explicitPeer = text.match(/(?:^|\s)(?:peer(?:_id)?\s*[:=]?\s*)?(200000\d{4,})(?=\s|$)/iu);
    if (explicitPeer) {
        return {
            platform: 'vk',
            externalPeerId: String(explicitPeer[1]),
            canonicalUrl: '',
            matchedText: explicitPeer[0].trim(),
        };
    }

    const stableVkUrl = text.match(/https?:\/\/(?:m\.)?(?:vk\.com|vk\.ru)\/im\?(?:[^\s#]*&)?sel=c(\d+)(?:&[^\s#]*)?/iu);
    if (stableVkUrl) {
        const chatId = Number(stableVkUrl[1]);
        if (Number.isSafeInteger(chatId) && chatId > 0) {
            return {
                platform: 'vk',
                externalPeerId: String(2_000_000_000 + chatId),
                canonicalUrl: '',
                matchedText: stableVkUrl[0].trim(),
            };
        }
    }

    const shortChat = text.match(/(?:^|\s)(?:(?:беседа|чат)\s*#?\s*|c)(\d{1,9})(?=\s|$)/iu);
    if (shortChat) {
        const chatId = Number(shortChat[1]);
        if (Number.isSafeInteger(chatId) && chatId > 0) {
            return {
                platform: 'vk',
                externalPeerId: String(2_000_000_000 + chatId),
                canonicalUrl: '',
                matchedText: shortChat[0].trim(),
            };
        }
    }

    const telegram = text.match(/https?:\/\/t\.me\/c\/(\d+)(?:\/\d+)?/iu);
    if (telegram) {
        const externalPeerId = `-100${telegram[1]}`;
        return {
            platform: 'telegram',
            externalPeerId,
            canonicalUrl: '',
            matchedText: telegram[0].trim(),
        };
    }

    return null;
}

export function parseAutoSummaryCommand(value) {
    let text = normalize(value)
        .replace(/^(?:гигорейв|gigorave)(?:\s*[:,.!?—-]\s*|\s+)/u, '')
        .trim()
        .replace(/^резюмирование(?![\p{L}\p{N}_])/u, 'авторезюме');

    if (!/^авторезюме(?![\p{L}\p{N}_])/u.test(text)) {
        return { matched: false };
    }

    text = text.replace(/^авторезюме(?![\p{L}\p{N}_])/u, '').trim();
    const target = extractConversationTarget(text);
    if (target?.matchedText) {
        text = text.replace(target.matchedText, ' ').replace(/\s+/gu, ' ').trim();
    }

    if (!text) {
        return {
            matched: true,
            action: 'enable',
            mode: AUTO_SUMMARY_MODE_FULL,
            ...(target ? { target } : {}),
        };
    }

    if (/^(?:статус|status|настройки)$/u.test(text)) {
        return { matched: true, action: 'status', all: false, ...(target ? { target } : {}) };
    }
    if (/^(?:все\s+)?(?:статус(?:ы)?|status|настройки)\s+(?:все|всех|во\s+всех\s+беседах|всех\s+беседах)$/u.test(text) || /^(?:все\s+беседы|всех\s+бесед)$/u.test(text)) {
        return { matched: true, action: 'status', all: true, ...(target ? { target } : {}) };
    }

    if (/^(?:сейчас|сразу|тест|проверить|запустить)$/u.test(text)) {
        return { matched: true, action: 'run-now', ...(target ? { target } : {}) };
    }

    if (/^(?:вкл|включить|включи|on)$/u.test(text)) {
        return { matched: true, action: 'enable', mode: AUTO_SUMMARY_MODE_FULL, ...(target ? { target } : {}) };
    }

    if (/^(?:выкл|выключить|выключи|откл|отключить|отключи|стоп|off)$/u.test(text)) {
        return { matched: true, action: 'disable', ...(target ? { target } : {}) };
    }

    if (/^(?:только\s+)?(?:день|дневное|дневной)$/u.test(text)) {
        return {
            matched: true,
            action: 'enable',
            mode: AUTO_SUMMARY_MODE_DAY,
            ...(target ? { target } : {}),
        };
    }

    if (/^(?:только\s+)?(?:вечер|вечером|вечернее|вечерний)$/u.test(text)) {
        return {
            matched: true,
            action: 'enable',
            mode: AUTO_SUMMARY_MODE_EVENING,
            ...(target ? { target } : {}),
        };
    }

    const schedule = parseAutoSummarySchedule(text);
    if (schedule.length) {
        return {
            matched: true,
            action: 'enable',
            mode: AUTO_SUMMARY_MODE_CUSTOM,
            schedule,
            ...(target ? { target } : {}),
        };
    }

    return { matched: true, action: 'help', ...(target ? { target } : {}) };
}

export function getAutoSummaryScheduleSlots(_mode, _customSchedule = []) {
    // V188.45: one canonical schedule everywhere. Legacy mode/custom values may
    // remain in old SQLite rows for migration compatibility, but they no longer
    // change runtime boundaries.
    return [...MODE_SLOTS[AUTO_SUMMARY_MODE_FULL]];
}

// Legacy helper retained for older tests/callers.
export function getAutoSummaryScheduleHours(mode) {
    return getAutoSummaryScheduleSlots(mode).map((slot) => {
        const [hour] = slot.split(':').map(Number);
        return hour;
    });
}

export function formatAutoSummarySchedule(schedule = []) {
    const slots = normalizeAutoSummarySchedule(schedule);
    return slots.length ? slots.join(', ') : '—';
}

export function formatAutoSummaryMode() {
    return '09:00, 13:00, 15:00, 18:00, 21:00 и 23:59';
}

function candidateForDate(dateString, slot, timeZone) {
    const normalized = normalizeSlot(slot);
    if (!normalized) return Number.NaN;
    const [hour, minute] = normalized.split(':').map(Number);
    return zonedDateTimeToUtcMilliseconds(dateString, hour, minute, timeZone);
}

export function shouldSkipStaleAutoSummaryRun({
    scheduledTimestamp,
    nowTimestamp,
    graceSeconds = AUTO_SUMMARY_STALE_GRACE_SECONDS,
}) {
    const scheduled = Number(scheduledTimestamp) || 0;
    const now = Number(nowTimestamp) || 0;
    const grace = Math.max(0, Number(graceSeconds) || 0);
    if (scheduled <= 0 || now <= 0 || now < scheduled) return false;
    return now - scheduled > grace;
}

export function getNextAutoSummaryRunAt({
    mode,
    schedule = [],
    afterTimestamp,
    timeZone,
}) {
    const afterMs = Number(afterTimestamp) * 1000;
    const localDate = getLocalDateString(new Date(afterMs), timeZone);
    const slots = getAutoSummaryScheduleSlots(mode, schedule);
    let best = Number.POSITIVE_INFINITY;

    for (let dayOffset = 0; dayOffset <= 3; dayOffset += 1) {
        const dateString = addDaysToDateString(localDate, dayOffset);
        for (const slot of slots) {
            const candidate = candidateForDate(dateString, slot, timeZone);
            if (candidate > afterMs && candidate < best) best = candidate;
        }
    }

    if (!Number.isFinite(best)) {
        throw new Error(`Не удалось вычислить следующее авторезюме для режима ${mode}.`);
    }
    return Math.floor(best / 1000);
}


export function coalesceOverdueAutoSummaryRunAt({
    mode,
    schedule = [],
    nextRunAt,
    nowTimestamp,
    timeZone,
}) {
    const next = Number(nextRunAt) || 0;
    const now = Number(nowTimestamp) || 0;
    if (next <= 0 || now <= 0 || next > now) {
        return { scheduledAt: next, skippedSlots: 0 };
    }

    // Auto-summary uses immutable fixed intraday slices. If the bot was down
    // across several schedule slots, sending every stale intermediate summary
    // after restart only spams the chat. Run the latest due slot once, then
    // continue from the normal schedule. Crucially, unlike V158-V160, an
    // overdue slot is never silently discarded.
    let scheduledAt = next;
    let skippedSlots = 0;
    for (let guard = 0; guard < 512; guard += 1) {
        const candidate = getNextAutoSummaryRunAt({
            mode,
            schedule,
            afterTimestamp: scheduledAt,
            timeZone,
        });
        if (candidate > now) break;
        scheduledAt = candidate;
        skippedSlots += 1;
    }

    return { scheduledAt, skippedSlots };
}

export function resolveAutoSummaryRunWindow({
    mode,
    schedule = [],
    scheduledTimestamp,
    timeZone,
}) {
    const scheduledDate = new Date(Number(scheduledTimestamp) * 1000);
    const localDate = getLocalDateString(scheduledDate, timeZone);
    const timeParts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(scheduledDate);
    const parts = Object.fromEntries(timeParts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));
    const localHour = Number(parts.hour || 0);
    const localMinute = Number(parts.minute || 0);
    const slotLabel = `${String(localHour).padStart(2, '0')}:${String(localMinute).padStart(2, '0')}`;
    const slots = getAutoSummaryScheduleSlots(mode, schedule);
    const slotIndex = slots.indexOf(slotLabel);
    const previousSlot = slotIndex > 0 ? slots[slotIndex - 1] : '00:00';
    const [startHour, startMinute] = previousSlot.split(':').map(Number);
    const start = zonedDateTimeToUtcMilliseconds(
        localDate,
        startHour,
        startMinute,
        timeZone,
    );
    const end = Number(scheduledTimestamp) * 1000;

    return {
        summaryDate: localDate,
        slotLabel,
        startTimestamp: Math.floor(start / 1000),
        endTimestamp: Math.floor(end / 1000),
    };
}


/**
 * Legacy restart helper. It may extend one missed fixed slice to the current
 * moment, but never across local midnight. The durable calendar pipeline is the
 * primary restart-safe mechanism in V188.45.
 */
export function resolveStartupAutoSummaryCatchUpWindow({
    mode,
    window,
    nowTimestamp,
    timeZone,
}) {
    const source = window && typeof window === 'object' ? window : {};
    const scheduledEndTimestamp = Number(source.endTimestamp) || 0;
    const now = Number(nowTimestamp) || 0;
    const base = {
        ...source,
        startupCatchUp: false,
        catchUpExtended: false,
        scheduledEndTimestamp,
    };

    if (
        scheduledEndTimestamp <= 0 ||
        now <= scheduledEndTimestamp ||
        !String(source.summaryDate || '').trim()
    ) {
        return base;
    }

    // Catch-up may extend only inside the same calendar day. The durable
    // calendar pipeline is the primary restart mechanism; this helper exists
    // solely for the disabled-by-default legacy scheduler.
    const nextDate = addDaysToDateString(String(source.summaryDate), 1);
    const boundaryMs = zonedDateTimeToUtcMilliseconds(nextDate, 0, 0, timeZone);
    const boundaryTimestamp = Math.floor(boundaryMs / 1000);
    const endTimestamp = Math.max(
        scheduledEndTimestamp,
        Math.min(now, boundaryTimestamp),
    );

    return {
        ...source,
        endTimestamp,
        startupCatchUp: true,
        catchUpExtended: endTimestamp > scheduledEndTimestamp,
        scheduledEndTimestamp,
        catchUpRequestedAt: now,
        catchUpBoundaryTimestamp: boundaryTimestamp,
        mode,
    };
}
