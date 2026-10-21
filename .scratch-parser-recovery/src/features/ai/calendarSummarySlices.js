import { addCalendarDays } from './calendarSummaryRollup.js';
import { zonedDateTimeToUtcMilliseconds } from '../../shared/date.js';

/**
 * V188.45 fixed intraday summary slices.
 * Labels are the user-visible delivery times. The final 23:59 slice owns the
 * interval through local midnight; a late message becomes an immutable delta
 * revision of the same slice instead of reopening already-paid messages.
 */
export const CALENDAR_SUMMARY_SLICE_SLOTS = Object.freeze([
    Object.freeze({ label: '09:00', startMinute: 0, endMinute: 9 * 60 }),
    Object.freeze({ label: '13:00', startMinute: 9 * 60, endMinute: 13 * 60 }),
    Object.freeze({ label: '15:00', startMinute: 13 * 60, endMinute: 15 * 60 }),
    Object.freeze({ label: '18:00', startMinute: 15 * 60, endMinute: 18 * 60 }),
    Object.freeze({ label: '21:00', startMinute: 18 * 60, endMinute: 21 * 60 }),
    Object.freeze({ label: '23:59', startMinute: 21 * 60, endMinute: 24 * 60 }),
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

export function calendarSummarySliceForTimestamp(timestampSeconds, dayKey, timeZone) {
    const ts = Number(timestampSeconds) || 0;
    for (const slot of CALENDAR_SUMMARY_SLICE_SLOTS) {
        const bounds = calendarSummarySliceBounds(dayKey, slot, timeZone);
        if (ts >= bounds.startAt && ts < bounds.endAt) return { ...slot, ...bounds };
    }
    return null;
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
    return CALENDAR_SUMMARY_SLICE_LABELS.includes(clock) || clock === '00:00';
}
