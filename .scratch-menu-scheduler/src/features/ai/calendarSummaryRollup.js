function parseDateKey(value) {
    const match = /^(\d{4})-(\d{2})-(\d{2})$/u.exec(String(value || ''));
    if (!match) throw new Error(`Invalid calendar date key: ${value}`);
    return {
        year: Number(match[1]),
        month: Number(match[2]),
        day: Number(match[3]),
    };
}

export function addCalendarDays(dateKey, delta) {
    const { year, month, day } = parseDateKey(dateKey);
    const date = new Date(Date.UTC(year, month - 1, day + Number(delta || 0)));
    return date.toISOString().slice(0, 10);
}

export function calendarWeekday(dateKey) {
    const { year, month, day } = parseDateKey(dateKey);
    return new Date(Date.UTC(year, month - 1, day)).getUTCDay();
}

export function calendarWeekStart(dateKey) {
    const weekday = calendarWeekday(dateKey);
    const daysSinceMonday = (weekday + 6) % 7;
    return addCalendarDays(dateKey, -daysSinceMonday);
}

export function calendarWeekEndExclusive(weekKey) {
    return addCalendarDays(weekKey, 7);
}

export function calendarMonthKey(dateKey) {
    parseDateKey(dateKey);
    return String(dateKey).slice(0, 7);
}

export function calendarMonthStart(monthKey) {
    const match = /^(\d{4})-(\d{2})$/u.exec(String(monthKey || ''));
    if (!match) throw new Error(`Invalid calendar month key: ${monthKey}`);
    return `${match[1]}-${match[2]}-01`;
}

export function nextCalendarMonthStart(monthKey) {
    const start = calendarMonthStart(monthKey);
    const { year, month } = parseDateKey(start);
    const date = new Date(Date.UTC(year, month, 1));
    return date.toISOString().slice(0, 10);
}

export function calendarWeekMonthSegmentForDay(dayKey) {
    const weekKey = calendarWeekStart(dayKey);
    const weekEnd = calendarWeekEndExclusive(weekKey);
    const monthKey = calendarMonthKey(dayKey);
    const monthStart = calendarMonthStart(monthKey);
    const monthEnd = nextCalendarMonthStart(monthKey);
    const startDate = weekKey > monthStart ? weekKey : monthStart;
    const endDate = weekEnd < monthEnd ? weekEnd : monthEnd;
    return {
        weekKey,
        monthKey,
        segmentKey: `${weekKey}::${monthKey}`,
        startDate,
        endDate,
    };
}

export function isClosedCalendarDate(endExclusiveDateKey, currentDateKey) {
    parseDateKey(endExclusiveDateKey);
    parseDateKey(currentDateKey);
    return String(endExclusiveDateKey) <= String(currentDateKey);
}

export function isCalendarWeekClosed(weekKey, currentDateKey) {
    return isClosedCalendarDate(calendarWeekEndExclusive(weekKey), currentDateKey);
}

export function isCalendarMonthClosed(monthKey, currentDateKey) {
    return isClosedCalendarDate(nextCalendarMonthStart(monthKey), currentDateKey);
}
