/**
 * Извлекает дату, время и место рождения из натального запроса и проверяет полноту данных.
 */
function normalizeNatalText(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .replace(/\u00a0/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function daysInMonth(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function isValidDateParts({ year, month, day, hour, minute }) {
    return (
        Number.isInteger(year) &&
        year >= 1800 &&
        year <= 2200 &&
        Number.isInteger(month) &&
        month >= 1 &&
        month <= 12 &&
        Number.isInteger(day) &&
        day >= 1 &&
        day <= daysInMonth(year, month) &&
        Number.isInteger(hour) &&
        hour >= 0 &&
        hour <= 23 &&
        Number.isInteger(minute) &&
        minute >= 0 &&
        minute <= 59
    );
}

function readDateMatch(text) {
    const dayFirst = text.match(
        /(?<!\d)(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})(?!\d)/u,
    );

    if (dayFirst) {
        return {
            day: Number(dayFirst[1]),
            month: Number(dayFirst[2]),
            year: Number(dayFirst[3]),
            raw: dayFirst[0],
        };
    }

    const yearFirst = text.match(
        /(?<!\d)(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?!\d)/u,
    );

    if (yearFirst) {
        return {
            day: Number(yearFirst[3]),
            month: Number(yearFirst[2]),
            year: Number(yearFirst[1]),
            raw: yearFirst[0],
        };
    }

    return null;
}

function readTimeMatch(text) {
    const colonMatch = text.match(
        /(?<!\d)([01]?\d|2[0-3]):(\d{2})(?!\d)/u,
    );
    const dottedMatch = text.match(
        /(?:\bв(?:ремя)?\s*[:=]?\s*)([01]?\d|2[0-3])[.](\d{2})(?!\d)/iu,
    );
    const match = colonMatch || dottedMatch;

    if (!match) {
        return null;
    }

    return {
        hour: Number(match[1]),
        minute: Number(match[2]),
        raw: match[0],
    };
}

function zonedParts(date, timeZone) {
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
    const values = Object.fromEntries(
        parts
            .filter((part) => part.type !== 'literal')
            .map((part) => [part.type, Number(part.value)]),
    );

    return {
        year: values.year,
        month: values.month,
        day: values.day,
        hour: values.hour,
        minute: values.minute,
        second: values.second,
    };
}

export function zonedDateTimeToUtc(parts, timeZone = 'Europe/Moscow') {
    if (!isValidDateParts(parts)) {
        return null;
    }

    const targetUtc = Date.UTC(
        parts.year,
        parts.month - 1,
        parts.day,
        parts.hour,
        parts.minute,
        0,
        0,
    );
    let candidate = new Date(targetUtc);

    for (let iteration = 0; iteration < 4; iteration += 1) {
        const local = zonedParts(candidate, timeZone);
        const representedAsUtc = Date.UTC(
            local.year,
            local.month - 1,
            local.day,
            local.hour,
            local.minute,
            local.second,
            0,
        );
        const offset = representedAsUtc - candidate.getTime();
        const next = new Date(targetUtc - offset);

        if (Math.abs(next.getTime() - candidate.getTime()) < 1000) {
            candidate = next;
            break;
        }

        candidate = next;
    }

    const verification = zonedParts(candidate, timeZone);

    if (
        verification.year !== parts.year ||
        verification.month !== parts.month ||
        verification.day !== parts.day ||
        verification.hour !== parts.hour ||
        verification.minute !== parts.minute
    ) {
        return null;
    }

    return candidate;
}

export function parseNatalBirthData(
    text,
    { timeZone = 'Europe/Moscow' } = {},
) {
    const source = normalizeNatalText(text);
    const date = readDateMatch(source);
    const time = readTimeMatch(source);
    const missing = [];

    if (!date) {
        missing.push('дата рождения');
    }

    if (!time) {
        missing.push('точное время рождения');
    }

    if (missing.length) {
        return {
            ok: false,
            missing,
            source,
            date: null,
            time: null,
            instant: null,
            timeZone,
        };
    }

    const parts = {
        year: date.year,
        month: date.month,
        day: date.day,
        hour: time.hour,
        minute: time.minute,
    };

    if (!isValidDateParts(parts)) {
        return {
            ok: false,
            missing: [],
            error: 'Некорректная дата или время рождения.',
            source,
            date,
            time,
            instant: null,
            timeZone,
        };
    }

    const instant = zonedDateTimeToUtc(parts, timeZone);

    if (!instant) {
        return {
            ok: false,
            missing: [],
            error: `Не удалось преобразовать время рождения в часовой пояс ${timeZone}.`,
            source,
            date,
            time,
            instant: null,
            timeZone,
        };
    }

    return {
        ok: true,
        missing: [],
        source,
        date,
        time,
        parts,
        instant,
        timeZone,
    };
}

export function formatNatalBirthData(parsed, locale = 'ru-RU') {
    if (!parsed?.ok || !(parsed.instant instanceof Date)) {
        return '';
    }

    return new Intl.DateTimeFormat(locale, {
        timeZone: parsed.timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hour12: false,
    }).format(parsed.instant);
}
