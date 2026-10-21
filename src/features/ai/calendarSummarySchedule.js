import { addCalendarDays, calendarWeekStart, calendarWeekday } from './calendarSummaryRollup.js';
import { getLocalDateString, zonedDateTimeToUtcMilliseconds } from '../../shared/date.js';

export const CALENDAR_SPECIAL_ROLLUP_CATCHUP_SECONDS = 7 * 24 * 60 * 60;
export const CALENDAR_LONG_ROLLUP_CATCHUP_SECONDS = 45 * 24 * 60 * 60;

export function calendarSummarySourceIsFullyContained(source, startAt, endAt) {
    const sourceStart = Number(source?.startAt || 0);
    const sourceEnd = Number(source?.endAt || 0);
    return sourceStart >= Number(startAt) && sourceEnd <= Number(endAt) && sourceEnd > sourceStart;
}

export function selectCalendarSummarySourcesForPeriod(dailyRows, batchRows, startAt, endAt) {
    const daily = (Array.isArray(dailyRows) ? dailyRows : [])
        .filter((row) => calendarSummarySourceIsFullyContained(row, startAt, endAt));
    const coveredDays = new Set(daily.map((row) => String(row?.dayKey || '')));
    const batches = (Array.isArray(batchRows) ? batchRows : [])
        .filter((row) => {
            const rowStart = Number(row?.startAt || 0);
            const rowEnd = Number(row?.endAt || 0);
            return rowStart < Number(endAt) && rowEnd > Number(startAt) &&
                !coveredDays.has(String(row?.dayKey || ''));
        });
    return { daily, batches };
}

const SPECIAL_ROLLUP_SCHEDULES = Object.freeze([
    Object.freeze({ periodType: 'workweek', weekday: 5, hour: 15, minute: 0 }),
    Object.freeze({ periodType: 'weekend', weekday: 0, hour: 20, minute: 0 }),
    Object.freeze({ periodType: 'full-week', weekday: 0, hour: 21, minute: 0 }),
]);

export function getDueCalendarLongRollups(
    now = new Date(),
    timeZone = 'Europe/Moscow',
    catchupSeconds = CALENDAR_LONG_ROLLUP_CATCHUP_SECONDS,
) {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const currentDateKey = getLocalDateString(now, timeZone);
    const periods = [];
    const addDue = (periodType, periodKey, scheduleDate, hour, startDate, endDate, label) => {
        const scheduledAt = localTimestamp(scheduleDate, hour, 0, timeZone);
        const age = nowSeconds - scheduledAt;
        if (age < 0 || age > catchupSeconds) return;
        periods.push({ periodType, periodKey, scheduledAt, startDate, endDate, hour, label });
    };

    const seasonStarts = [
        { month: 3, day: 1, key: 'spring', title: 'Весна', previous: 'winter', previousTitle: 'Зима', startMonth: 12, startYearOffset: -1 },
        { month: 6, day: 1, key: 'summer', title: 'Лето', previous: 'spring', previousTitle: 'Весна', startMonth: 3, startYearOffset: 0 },
        { month: 9, day: 1, key: 'autumn', title: 'Осень', previous: 'summer', previousTitle: 'Лето', startMonth: 6, startYearOffset: 0 },
        { month: 12, day: 1, key: 'winter', title: 'Зима', previous: 'autumn', previousTitle: 'Осень', startMonth: 9, startYearOffset: 0 },
    ];
    const maxDays = Math.min(400, Math.ceil(Math.max(0, Number(catchupSeconds) || 0) / 86400));
    for (let offset = 0; offset <= maxDays; offset += 1) {
        const scheduleDate = addCalendarDays(currentDateKey, -offset);
        if (!scheduleDate.endsWith('-01')) continue;
        const [year, month] = scheduleDate.split('-').map(Number);
        const monthAge = nowSeconds - localTimestamp(scheduleDate, 11, 0, timeZone);
        if (monthAge >= 0 && monthAge <= catchupSeconds) {
            const previousMonth = addCalendarDays(scheduleDate, -1).slice(0, 7);
        addDue(
            'calendar-month',
            previousMonth,
            scheduleDate,
            11,
            `${previousMonth}-01`,
            scheduleDate,
            `Месяц ${previousMonth}`,
        );
        }

        const yearAge = nowSeconds - localTimestamp(scheduleDate, 12, 0, timeZone);
        if (month === 1 && yearAge >= 0 && yearAge <= catchupSeconds) {
            addDue(
                'calendar-year',
                String(year - 1),
                scheduleDate,
                12,
                `${year - 1}-01-01`,
                scheduleDate,
                `Год ${year - 1}`,
            );
        }

        const seasonStart = seasonStarts.find((season) => month === season.month);
        if (!seasonStart || monthAge < 0 || monthAge > catchupSeconds) continue;
        const seasonYear = year + seasonStart.startYearOffset;
        const startDate = `${seasonYear}-${String(seasonStart.startMonth).padStart(2, '0')}-01`;
        addDue(
            'calendar-season',
            `${seasonStart.previous}:${startDate}`,
            scheduleDate,
            11,
            startDate,
            scheduleDate,
            `${seasonStart.previousTitle} ${startDate.slice(0, 4)}`,
        );
    }

    return periods.sort((left, right) => left.scheduledAt - right.scheduledAt);
}

function localTimestamp(dateKey, hour, minute, timeZone) {
    return Math.floor(zonedDateTimeToUtcMilliseconds(dateKey, hour, minute, timeZone) / 1000);
}

export function calendarPeriodClosedWithinCatchup(endExclusiveDateKey, now = new Date(), catchupSeconds = 0, timeZone = 'Europe/Moscow') {
    const closeAt = localTimestamp(String(endExclusiveDateKey || ''), 0, 0, timeZone);
    const ageSeconds = Math.floor(now.getTime() / 1000) - closeAt;
    return ageSeconds >= 0 && ageSeconds <= Math.max(0, Number(catchupSeconds) || 0);
}

export function getDueCalendarSpecialRollups(
    now = new Date(),
    timeZone = 'Europe/Moscow',
    catchupSeconds = CALENDAR_SPECIAL_ROLLUP_CATCHUP_SECONDS,
) {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const currentDateKey = getLocalDateString(now, timeZone);
    const maxDays = Math.ceil(Math.max(0, Number(catchupSeconds) || 0) / (24 * 60 * 60));
    const due = [];

    for (let offset = 0; offset <= maxDays; offset += 1) {
        const dateKey = addCalendarDays(currentDateKey, -offset);
        const weekday = calendarWeekday(dateKey);
        for (const schedule of SPECIAL_ROLLUP_SCHEDULES) {
            if (weekday !== schedule.weekday) continue;
            const scheduledAt = localTimestamp(dateKey, schedule.hour, schedule.minute, timeZone);
            const ageSeconds = nowSeconds - scheduledAt;
            if (ageSeconds < 0 || ageSeconds > catchupSeconds) continue;

            const monday = calendarWeekStart(dateKey);
            const friday = addCalendarDays(dateKey, -2);
            const period = schedule.periodType === 'workweek'
                ? { startDate: monday, startHour: 0, endDate: dateKey, endHour: 15, endMinute: 0 }
                : schedule.periodType === 'weekend'
                    ? { startDate: friday, startHour: 15, endDate: dateKey, endHour: 20, endMinute: 0 }
                    : { startDate: monday, startHour: 0, endDate: dateKey, endHour: 21, endMinute: 0 };
            due.push({
                ...schedule,
                periodKey: dateKey,
                scheduledAt,
                ...period,
            });
        }
    }

    return due.sort((left, right) => left.scheduledAt - right.scheduledAt);
}

export function getDueCalendarDailySummaryKeys(
    dayKeys,
    now = new Date(),
    timeZone = 'Europe/Moscow',
    catchupSeconds = CALENDAR_SPECIAL_ROLLUP_CATCHUP_SECONDS,
) {
    const nowSeconds = Math.floor(now.getTime() / 1000);
    const maxAge = Math.max(0, Number(catchupSeconds) || 0);
    return [...new Set((Array.isArray(dayKeys) ? dayKeys : [])
        .map((dayKey) => String(dayKey || ''))
        .filter((dayKey) => /^\d{4}-\d{2}-\d{2}$/u.test(dayKey)))]
        .filter((dayKey) => {
            const closesAt = localTimestamp(addCalendarDays(dayKey, 1), 0, 0, timeZone);
            const ageSeconds = nowSeconds - closesAt;
            return ageSeconds >= 0 && ageSeconds <= maxAge;
        })
        .sort((left, right) => right.localeCompare(left));
}
