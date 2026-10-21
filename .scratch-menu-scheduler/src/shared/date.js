/**
 * Небольшие функции работы с календарными датами без сторонней библиотеки.
 * Строки формата YYYY-MM-DD удобны тем, что корректно сравниваются лексически.
 */
export function getLocalDateString(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const map = Object.fromEntries(
        parts.map((part) => [part.type, part.value]),
    );

    return `${map.year}-${map.month}-${map.day}`;
}

export function addDaysToDateString(dateString, days) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    date.setUTCDate(date.getUTCDate() + days);

    return [
        date.getUTCFullYear(),
        String(date.getUTCMonth() + 1).padStart(2, '0'),
        String(date.getUTCDate()).padStart(2, '0'),
    ].join('-');
}

export function getLocalDayWindow(day, timeZone) {
    const nextDay = addDaysToDateString(day, 1);

    return {
        startTimestamp: Math.floor(zonedMidnightToUtcMilliseconds(day, timeZone) / 1000),
        endTimestamp: Math.floor(zonedMidnightToUtcMilliseconds(nextDay, timeZone) / 1000),
    };
}


export function zonedDateTimeToUtcMilliseconds(
    dateString,
    hour,
    minute,
    timeZone,
) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const targetHour = Number(hour) || 0;
    const targetMinute = Number(minute) || 0;
    let utcMilliseconds = Date.UTC(
        year,
        month - 1,
        day,
        targetHour,
        targetMinute,
    );

    for (let attempt = 0; attempt < 4; attempt += 1) {
        const offset = getTimeZoneOffsetMilliseconds(
            new Date(utcMilliseconds),
            timeZone,
        );
        const nextValue = Date.UTC(
            year,
            month - 1,
            day,
            targetHour,
            targetMinute,
        ) - offset;

        if (nextValue === utcMilliseconds) {
            break;
        }

        utcMilliseconds = nextValue;
    }

    return utcMilliseconds;
}

export function zonedMidnightToUtcMilliseconds(dateString, timeZone) {
    const [year, month, day] = dateString.split('-').map(Number);
    let utcMilliseconds = Date.UTC(year, month - 1, day);

    // Intl не умеет напрямую создать Date «в указанном часовом поясе».
    // Несколько итераций корректируют UTC-момент до локальной полуночи,
    // включая исторические переходы часового пояса и летнее время.
    for (let attempt = 0; attempt < 4; attempt += 1) {
        const offset = getTimeZoneOffsetMilliseconds(
            new Date(utcMilliseconds),
            timeZone,
        );
        const nextValue = Date.UTC(year, month - 1, day) - offset;

        if (nextValue === utcMilliseconds) {
            break;
        }

        utcMilliseconds = nextValue;
    }

    return utcMilliseconds;
}

export function getTimeZoneOffsetMilliseconds(date, timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    const map = Object.fromEntries(
        parts.map((part) => [part.type, part.value]),
    );
    const representedAsUtc = Date.UTC(
        Number(map.year),
        Number(map.month) - 1,
        Number(map.day),
        Number(map.hour),
        Number(map.minute),
        Number(map.second),
    );

    return representedAsUtc - date.getTime();
}
