/**
 * Календарная маршрутизация афиши: преобразует формулировки пользователя и токены GPT-классификатора в строгий диапазон YYYY-MM-DD.
 */
import { normalizeLocalCommand } from '../../shared/commands.js';
import {
    addDaysToDateString,
    getLocalDateString,
} from '../../shared/date.js';

const RUSSIAN_EVENT_MONTHS = Object.freeze({
    январь: 1, января: 1, январю: 1, январем: 1, январе: 1,
    февраль: 2, февраля: 2, февралю: 2, февралем: 2, феврале: 2,
    март: 3, марта: 3, марту: 3, мартом: 3, марте: 3,
    апрель: 4, апреля: 4, апрелю: 4, апрелем: 4, апреле: 4,
    май: 5, мая: 5, маю: 5, маем: 5, мае: 5,
    июнь: 6, июня: 6, июню: 6, июнем: 6, июне: 6,
    июль: 7, июля: 7, июлю: 7, июлем: 7, июле: 7,
    август: 8, августа: 8, августу: 8, августом: 8, августе: 8,
    сентябрь: 9, сентября: 9, сентябрю: 9, сентябрем: 9, сентябре: 9,
    октябрь: 10, октября: 10, октябрю: 10, октябрем: 10, октябре: 10,
    ноябрь: 11, ноября: 11, ноябрю: 11, ноябрем: 11, ноябре: 11,
    декабрь: 12, декабря: 12, декабрю: 12, декабрем: 12, декабре: 12,
});

const RUSSIAN_EVENT_MONTH_NAMES = Object.freeze([
    '', 'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
    'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
]);

const RUSSIAN_EVENT_MONTH_NAMES_NOMINATIVE = Object.freeze([
    '', 'январь', 'февраль', 'март', 'апрель', 'май', 'июнь',
    'июль', 'август', 'сентябрь', 'октябрь', 'ноябрь', 'декабрь',
]);


const RUSSIAN_EVENT_WEEKDAYS = Object.freeze({
    понедельник: 0, понедельника: 0, понедельнике: 0, пн: 0,
    вторник: 1, вторника: 1, вторнике: 1, вт: 1,
    среда: 2, среду: 2, среды: 2, среде: 2, ср: 2,
    четверг: 3, четверга: 3, четверге: 3, чт: 3,
    пятница: 4, пятницу: 4, пятницы: 4, пятнице: 4, пт: 4,
    суббота: 5, субботу: 5, субботы: 5, субботе: 5, сб: 5,
    воскресенье: 6, воскресенья: 6, воскресенью: 6, вс: 6,
});

export function isValidIsoEventDate(value) {
    if (!/^\d{4}-\d{2}-\d{2}$/u.test(String(value ?? ''))) {
        return false;
    }

    const [year, month, day] = String(value).split('-').map(Number);
    const date = new Date(Date.UTC(year, month - 1, day));

    return (
        date.getUTCFullYear() === year &&
        date.getUTCMonth() + 1 === month &&
        date.getUTCDate() === day
    );
}

export function compareIsoEventDates(left, right) {
    return String(left).localeCompare(String(right), 'en');
}

export function formatIsoEventDate(dateString, { includeYear = true } = {}) {
    if (!isValidIsoEventDate(dateString)) {
        return String(dateString ?? '');
    }

    const [year, month, day] = dateString.split('-').map(Number);
    const parts = [String(day), RUSSIAN_EVENT_MONTH_NAMES[month]];

    if (includeYear) {
        parts.push(String(year));
    }

    return parts.join(' ');
}

function makeIsoEventDate(year, month, day) {
    const value = [
        String(year).padStart(4, '0'),
        String(month).padStart(2, '0'),
        String(day).padStart(2, '0'),
    ].join('-');

    return isValidIsoEventDate(value) ? value : null;
}

function getIsoEventWeekday(dateString) {
    const [year, month, day] = String(dateString).split('-').map(Number);
    const sundayBased = new Date(Date.UTC(year, month - 1, day)).getUTCDay();

    // Внутри сервиса понедельник = 0, воскресенье = 6.
    return (sundayBased + 6) % 7;
}

function getIsoEventMonthLastDay(year, month) {
    return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

function formatIsoEventRange(fromDate, toDate) {
    if (fromDate === toDate) {
        return formatIsoEventDate(fromDate);
    }

    const [fromYear, fromMonth] = fromDate.split('-').map(Number);
    const [toYear, toMonth] = toDate.split('-').map(Number);

    if (fromYear === toYear && fromMonth === toMonth) {
        const fromDay = Number(fromDate.slice(8, 10));
        return `${fromDay}–${formatIsoEventDate(toDate)}`;
    }

    return [
        formatIsoEventDate(fromDate, { includeYear: fromYear !== toYear }),
        formatIsoEventDate(toDate),
    ].join(' — ');
}

function createPublicEventsRange(kind, fromDate, toDate, labelPrefix) {
    if (!isValidIsoEventDate(fromDate) || !isValidIsoEventDate(toDate)) {
        return null;
    }

    if (compareIsoEventDates(fromDate, toDate) > 0) {
        return null;
    }

    return {
        kind,
        fromDate,
        toDate,
        label: `${labelPrefix}: ${formatIsoEventRange(fromDate, toDate)}`,
    };
}

/**
 * Сервис разбора периода афиши. Он не обращается к GPT и не читает базу:
 * на вход получает текст, на выходе даёт только календарный диапазон.
 */
export function createPublicEventRangeService({
    timeZone,
    now = () => new Date(),
}) {
    const today = () => getLocalDateString(now(), timeZone);

    function createByKind(kind, date = now()) {
        const localToday = getLocalDateString(date, timeZone);
        const weekday = getIsoEventWeekday(localToday);

        switch (kind) {
            case 'today':
                return createPublicEventsRange('today', localToday, localToday, 'Сегодня');
            case 'tomorrow': {
                const tomorrow = addDaysToDateString(localToday, 1);
                return createPublicEventsRange('tomorrow', tomorrow, tomorrow, 'Завтра');
            }
            case 'weekend': {
                // Для афиши выходные начинаются в пятницу: ночные пятничные
                // события должны входить в «эти выходные». Пн–Чт -> ближайшая
                // пятница; Пт -> сегодня; Сб/Вс -> оставшаяся часть текущего окна.
                const daysUntilFriday = weekday <= 4 ? 4 - weekday : 0;
                const start = addDaysToDateString(localToday, daysUntilFriday);
                const startWeekday = getIsoEventWeekday(start);
                const daysThroughSunday = startWeekday <= 6 ? 6 - startWeekday : 0;
                const end = addDaysToDateString(start, daysThroughSunday);
                return createPublicEventsRange('weekend', start, end, 'Эти выходные');
            }
            case 'week': {
                const end = addDaysToDateString(localToday, 6 - weekday);
                return createPublicEventsRange(
                    'week', localToday, end, 'Оставшаяся часть этой недели',
                );
            }
            case 'nearWeekend': {
                const end = addDaysToDateString(localToday, 6 - weekday);
                return createPublicEventsRange(
                    'nearWeekend', localToday, end,
                    'Ближайшие дни с захватом выходных',
                );
            }
            case 'all':
                return {
                    kind: 'all',
                    fromDate: localToday,
                    toDate: '9999-12-31',
                    label: 'Все будущие тусы',
                };
            case 'next14':
                return createPublicEventsRange(
                    'next14', localToday, addDaysToDateString(localToday, 13),
                    'Ближайшие 14 дней',
                );
            case 'next30':
                return createPublicEventsRange(
                    'next30', localToday, addDaysToDateString(localToday, 29),
                    'Ближайшие 30 дней',
                );
            default:
                return null;
        }
    }

    function resolveDateWithoutYear(month, day, localToday) {
        const currentYear = Number(localToday.slice(0, 4));
        const candidate = makeIsoEventDate(currentYear, month, day);

        if (candidate && compareIsoEventDates(candidate, localToday) >= 0) {
            return candidate;
        }

        return makeIsoEventDate(currentYear + 1, month, day);
    }

    function parseNamedWeekday(command, localToday) {
        const weekdayWords = Object.keys(RUSSIAN_EVENT_WEEKDAYS)
            .sort((left, right) => right.length - left.length)
            .join('|');
        const match = command.match(new RegExp(
            `(?:^|\\s)(?:в|на)?\\s*(${weekdayWords})(?:$|\\s)`,
            'u',
        ));
        if (!match) return null;
        const target = RUSSIAN_EVENT_WEEKDAYS[match[1]];
        const current = getIsoEventWeekday(localToday);
        const offset = (target - current + 7) % 7;
        const date = addDaysToDateString(localToday, offset);
        return createPublicEventsRange('weekday', date, date, `Тусы в ${match[1]}`);
    }

    function parseSpecificDate(command, localToday) {
        const numericMatch = command.match(
            /(?:^|\s)(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?:\s|$)/u,
        );

        if (numericMatch) {
            let year = numericMatch[3] ? Number(numericMatch[3]) : null;
            const month = Number(numericMatch[2]);
            const day = Number(numericMatch[1]);

            if (year !== null && year < 100) year += 2000;

            const date = year === null
                ? resolveDateWithoutYear(month, day, localToday)
                : makeIsoEventDate(year, month, day);

            if (date) {
                return createPublicEventsRange('date', date, date, 'Тусы на дату');
            }
        }

        const monthWords = Object.keys(RUSSIAN_EVENT_MONTHS)
            .sort((left, right) => right.length - left.length)
            .join('|');
        const match = command.match(new RegExp(
            `(?:^|\\s)(\\d{1,2})\\s+(${monthWords})(?:\\s+(\\d{4}))?(?:\\s|$)`,
            'u',
        ));

        if (!match) return null;

        const day = Number(match[1]);
        const month = RUSSIAN_EVENT_MONTHS[match[2]];
        const year = match[3] ? Number(match[3]) : null;
        const date = year === null
            ? resolveDateWithoutYear(month, day, localToday)
            : makeIsoEventDate(year, month, day);

        return date
            ? createPublicEventsRange('date', date, date, 'Тусы на дату')
            : null;
    }

    function parseNamedMonth(command, localToday) {
        const monthWords = Object.keys(RUSSIAN_EVENT_MONTHS)
            .sort((left, right) => right.length - left.length)
            .join('|');
        const match = command.match(new RegExp(
            `(?:^|\\s)(?:в\\s+)?(${monthWords})(?:\\s+(\\d{4}))?(?:\\s|$)`,
            'u',
        ));

        if (!match) return null;

        const month = RUSSIAN_EVENT_MONTHS[match[1]];
        let year = match[2] ? Number(match[2]) : Number(localToday.slice(0, 4));
        let first = makeIsoEventDate(year, month, 1);
        let last = makeIsoEventDate(year, month, getIsoEventMonthLastDay(year, month));

        if (!first || !last) return null;

        if (!match[2] && compareIsoEventDates(last, localToday) < 0) {
            year += 1;
            first = makeIsoEventDate(year, month, 1);
            last = makeIsoEventDate(year, month, getIsoEventMonthLastDay(year, month));
        }

        const fromDate = compareIsoEventDates(first, localToday) < 0
            ? localToday
            : first;

        return createPublicEventsRange(
            'month', fromDate, last,
            `Тусы за ${RUSSIAN_EVENT_MONTH_NAMES_NOMINATIVE[month]}`,
        );
    }

    function hasSubject(command) {
        return /(?:тус(?:ы|овк|овки|овок)?|концерт|мероприят|афиш|вечерин|движ|куда\s+сходить)/u.test(command);
    }

    function isSingleOrganizerPartyQuery(command) {
        return /(?:^|\s)(?:следующ(?:ая|ую|ей)|ближайш(?:ая|ую|ей))\s+(?:тус(?:а|у|е|ы|овка|овку|овке)|вечеринк(?:а|у|е|и))(?:$|\s)/u.test(command);
    }

    function parseCommand(value) {
        const command = normalizeLocalCommand(value);

        if (!command || isSingleOrganizerPartyQuery(command) || !hasSubject(command)) return null;

        const localToday = today();
        const specificDate = parseSpecificDate(command, localToday);
        if (specificDate) return specificDate;
        const namedWeekday = parseNamedWeekday(command, localToday);
        if (namedWeekday) return namedWeekday;
        if (/^(?:все|вся)\s+(?:тусы|афиша|мероприятия|концерты)$/u.test(command)) return createByKind('all');
        if (/(?:^|\s)(?:ближайшие\s+дни|на\s+ближайшие\s+дни|до\s+конца\s+выходных)(?:$|\s)/u.test(command)) return createByKind('nearWeekend');
        if (/(?:^|\s)(?:сегодня|на\s+сегодня)(?:$|\s)/u.test(command)) return createByKind('today');
        if (/(?:^|\s)(?:завтра|на\s+завтра)(?:$|\s)/u.test(command)) return createByKind('tomorrow');
        if (/(?:^|\s)(?:эти\s+выходные|на\s+(?:этих\s+)?выходных|выходные)(?:$|\s)/u.test(command)) return createByKind('weekend');
        if (/(?:^|\s)(?:эта\s+неделя|этой\s+неделе|на\s+этой\s+неделе|за\s+эту\s+неделю)(?:$|\s)/u.test(command)) return createByKind('week');
        if (/(?:^|\s)(?:месяц|на\s+месяц|ближайший\s+месяц|следующие\s+30\s+дней)(?:$|\s)/u.test(command)) return createByKind('next30');

        const namedMonth = parseNamedMonth(command, localToday);
        if (namedMonth) return namedMonth;

        if (
            /(?:ближайш|скоро|в\s+ближайшее\s+время|(?:следующие|на)?\s*две\s+недели)/u.test(command) ||
            new Set([
                'тусы', 'концерты', 'афиша', 'мероприятия',
                'тусы из источников', 'тусы из телеграма', 'тусы из вк',
                'афиша из источников', 'афиша из телеграма', 'афиша из вк',
            ]).has(command)
        ) {
            return createByKind('next14');
        }

        return null;
    }

    function looksLikeQuestion(value) {
        const command = normalizeLocalCommand(value);
        if (!command || isSingleOrganizerPartyQuery(command)) return false;

        return (
            /(?:тусы|концерт|мероприят|афиш|куда\s+сходить|вечеринки|движи)/u.test(command) ||
            (hasSubject(command) && /(?:выходн|недел|месяц|сегодня|завтра|\d{1,2}[.\/-]\d{1,2})/u.test(command))
        );
    }

    function fromClassifierToken(token) {
        const normalized = String(token ?? '').trim().toLowerCase();

        if (['today', 'tomorrow', 'weekend', 'week', 'nearweekend', 'next14', 'next30', 'all'].includes(normalized)) {
            return createByKind(normalized === 'nearweekend' ? 'nearWeekend' : normalized);
        }

        const dateMatch = normalized.match(/^date=(\d{4}-\d{2}-\d{2})$/u);
        if (dateMatch && isValidIsoEventDate(dateMatch[1])) {
            return createPublicEventsRange('date', dateMatch[1], dateMatch[1], 'Тусы на дату');
        }

        const monthMatch = normalized.match(/^month=(\d{4})-(\d{2})$/u);
        if (!monthMatch) return null;

        const year = Number(monthMatch[1]);
        const month = Number(monthMatch[2]);
        const localToday = today();
        const first = makeIsoEventDate(year, month, 1);
        const last = makeIsoEventDate(year, month, getIsoEventMonthLastDay(year, month));

        return first && last
            ? createPublicEventsRange(
                'month',
                compareIsoEventDates(first, localToday) < 0 ? localToday : first,
                last,
                'Тусы за месяц',
            )
            : null;
    }

    return {
        createPublicEventsRangeByKind: createByKind,
        looksLikePublicEventsQuestion: looksLikeQuestion,
        parsePublicEventsRangeCommand: parseCommand,
        publicEventsRangeFromClassifierToken: fromClassifierToken,
    };
}
