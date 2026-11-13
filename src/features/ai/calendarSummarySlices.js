import { addCalendarDays } from './calendarSummaryRollup.js';
import { zonedDateTimeToUtcMilliseconds } from '../../shared/date.js';

/**
 * V188.45 fixed intraday summary slices.
 * Labels are the user-visible delivery times. The calendar starts with a
 * compact overnight slice at 03:00, then uses the daytime boundaries 09:00,
 * 12:00, 15:00, 18:00 and 21:00. The 22:30 and 23:59 slices are explicit
 * tail batches: the 22:30 batch may be delivered normally, while the latter
 * owns the final 90 minutes and is folded into the 23:59 daily rollup only.
 */
export const CALENDAR_SUMMARY_SLICE_SLOTS = Object.freeze([
    Object.freeze({ label: '03:00', startMinute: 0, endMinute: 3 * 60 }),
    Object.freeze({ label: '09:00', startMinute: 3 * 60, endMinute: 9 * 60 }),
    Object.freeze({ label: '12:00', startMinute: 9 * 60, endMinute: 12 * 60 }),
    Object.freeze({ label: '15:00', startMinute: 12 * 60, endMinute: 15 * 60 }),
    Object.freeze({ label: '18:00', startMinute: 15 * 60, endMinute: 18 * 60 }),
    Object.freeze({ label: '21:00', startMinute: 18 * 60, endMinute: 21 * 60 }),
    Object.freeze({ label: '22:30', startMinute: 21 * 60, endMinute: 22 * 60 + 30 }),
    Object.freeze({ label: '23:59', startMinute: 22 * 60 + 30, endMinute: 24 * 60 }),
]);

export const CALENDAR_SUMMARY_SLICE_LABELS = Object.freeze(
    CALENDAR_SUMMARY_SLICE_SLOTS.map((slot) => slot.label),
);

export function getCalendarSummarySliceSlot(label) {
    return CALENDAR_SUMMARY_SLICE_SLOTS.find((slot) => slot.label === String(label || '')) || null;
}

function minuteParts(totalMinutes) {
    const safe = Math.max(0, Math.min(24 * 60, Number(totalMinutes) || 0));
    if (safe === 24 * 60) return { hour: 0, minute: 0, nextDay: true };
    return {
        hour: Math.floor(safe / 60),
        minute: safe % 60,
        nextDay: false,
    };
}

export function calendarSummarySliceBounds(dayKey, slot, timeZone) {
    const start = minuteParts(slot.startMinute);
    const end = minuteParts(slot.endMinute);
    const startDay = start.nextDay ? addCalendarDays(dayKey, 1) : dayKey;
    const endDay = end.nextDay ? addCalendarDays(dayKey, 1) : dayKey;
    const endAt = Math.floor(zonedDateTimeToUtcMilliseconds(endDay, end.hour, end.minute, timeZone) / 1000);
    const closeAt = slot.label === '23:59'
        ? Math.floor(zonedDateTimeToUtcMilliseconds(dayKey, 23, 59, timeZone) / 1000)
        : endAt;
    return {
        dayKey,
        slotLabel: slot.label,
        sliceKey: `${dayKey}@${slot.label}`,
        startAt: Math.floor(zonedDateTimeToUtcMilliseconds(startDay, start.hour, start.minute, timeZone) / 1000),
        endAt,
        closeAt,
    };
}

// Bounds depend only on day and timezone, never on the individual message.
// Keep this bounded: long historical scans must not retain every day forever.
const sliceDayCache = new Map();
export function calendarSummarySliceForTimestamp(timestampSeconds, dayKey, timeZone) {
    const ts = Number(timestampSeconds) || 0;
    const key = JSON.stringify([dayKey, timeZone]);
    let slices = sliceDayCache.get(key);
    if (!slices) {
        slices = CALENDAR_SUMMARY_SLICE_SLOTS.map(slot => ({
            ...slot, ...calendarSummarySliceBounds(dayKey, slot, timeZone),
        }));
        if (sliceDayCache.size >= 128) sliceDayCache.delete(sliceDayCache.keys().next().value);
        sliceDayCache.set(key, slices);
    }
    const slice = slices.find(bounds => ts >= bounds.startAt && ts < bounds.endAt);
    return slice ? { ...slice } : null;
}

export function calendarSummarySliceIsClosed(slice, now = new Date()) {
    return Number(slice?.closeAt || slice?.endAt || 0) <= Math.floor(now.getTime() / 1000);
}

export function shouldRunCalendarSliceBoundaryTick(date = new Date(), timeZone = 'Europe/Moscow') {
    const parts = new Intl.DateTimeFormat('en-GB', {
        timeZone,
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const clock = `${String(map.hour || '00').padStart(2, '0')}:${String(map.minute || '00').padStart(2, '0')}`;
    // 20:00 is a calendar rollup boundary (weekend/month-end). It is not a
    // raw batch boundary, so keep it in the maintenance tick separately.
    return CALENDAR_SUMMARY_SLICE_LABELS.includes(clock) ||
        ['00:00', '11:00', '12:00', '20:00'].includes(clock);
}
