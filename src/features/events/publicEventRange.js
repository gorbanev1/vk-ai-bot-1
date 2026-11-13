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

function addIsoEventMonths(dateString, months) {
    const [year, month, day] = dateString.split('-').map(Number);
    const absoluteMonth = year * 12 + (month - 1) + months;
    const targetYear = Math.floor(absoluteMonth / 12);
    const targetMonth = (absoluteMonth % 12) + 1;
    return makeIsoEventDate(
        targetYear, targetMonth, Math.min(day, getIsoEventMonthLastDay(targetYear, targetMonth)),
    );
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


/** Shared future-only policy for typed requests, classifier results and buttons. */
export function restrictPublicEventsToFuture(range, localToday) {
    if (!range || range.invalid || range.pastOnly) return range;
    if (range.toDate < localToday) return {...range,pastOnly:true,notice:'Прошедшие тусы не показываю.'};
    if (range.fromDate < localToday) return {...range,requestedFromDate:range.requestedFromDate||range.fromDate,
        fromDate:localToday,label:'Будущие тусы за период: '+formatIsoEventRange(localToday,range.toDate),
        notice:'Прошедшие тусы не показываю, только будущие.'};
    return range;
}
function parseCalendarExpression(command, localToday) {
    const months={...RUSSIAN_EVENT_MONTHS,янв:1,фев:2,мар:3,апр:4,июн:6,июл:7,авг:8,сен:9,сент:9,окт:10,ноя:11,дек:12};
    const words=Object.keys(months).sort((a,b)=>b.length-a.length).join('|');
    let text=command.replace(new RegExp('(\\d{1,2})\\s*(?:[-–—]|по|до)\\s*(\\d{1,2})\\s*('+words+')\\.?(?:\\s+(\\d{4}))?(?![\\p{L}\\p{N}])','gu'),
        (_,a,b,m,y)=>a+' '+m+(y?' '+y:'')+' — '+b+' '+m+(y?' '+y:''));
    text=text.replace(/(?<![\d./-])(\d{1,2})\s*[-–—]\s*(\d{1,2})([./]\d{1,2}(?:[./](?:\d{4}|\d{2}))?)(?!\d)/gu,
        (_,a,b,tail)=>a+tail+' — '+b+tail);
    text=text.replace(/(\d{1,2}[./]\d{1,2}(?:[./](?:\d{4}|\d{2}))?)\s*[-–—]\s*(?=\d{1,2}[./]\d{1,2})/gu,'$1 — ');
    const pattern=new RegExp('(?<![\\p{L}\\p{N}])(?:\\d{4}-\\d{1,2}-\\d{1,2}|\\d{1,2}[./-]\\d{1,2}(?:[./-](?:\\d{4}|\\d{2}))?|\\d{1,2}\\s*(?:'+words+')\\.?(?:\\s+\\d{4})?|(?:'+words+')\\.?(?:\\s+\\d{4})?|(?:19|20|21)\\d{2})(?![\\p{L}\\p{N}])','gu');
    const matches=[...text.matchAll(pattern)].filter(m=>! /^\s*(?:₽|руб|р\.)(?:\s|$)/u.test(text.slice(m.index+m[0].length)) &&
        !/(?:цена|цене|стоимость|стоимости|дороже|максимум)\s*(?:до\s*)?$/u.test(text.slice(0,m.index)));
    if(!matches.length)return null;
    for(let i=1;i<matches.length;i++){
        const gap=text.slice(matches[i-1].index+matches[i-1][0].length,matches[i].index);
        if(!/^\s*(?:г(?:ода|оду|од)?\.?)?\s*(?:[-–—,/]|\.\.\.?|по|до|и)?\s*$/u.test(gap))return null;
    }
    const tokens=matches.map(m=>{
        const raw=m[0];let v;
        if((v=raw.match(/^(\d{4})-(\d{1,2})-(\d{1,2})$/u)))return {year:+v[1],month:+v[2],day:+v[3],precision:'day'};
        if((v=raw.match(/^(\d{1,2})[./-](\d{1,2})(?:[./-](\d{4}|\d{2}))?$/u)))return {year:v[3]?(+v[3]<100?2000+(+v[3]):+v[3]):0,month:+v[2],day:+v[1],precision:'day'};
        if(/^\d{4}$/u.test(raw))return {year:+raw,month:1,day:1,precision:'year'};
        v=raw.match(new RegExp('^(?:(\\d{1,2})\\s*)?('+words+')\\.?(?:\\s+(\\d{4}))?$','u'));
        return v?{year:+v[3]||0,month:months[v[2]],day:+v[1]||1,precision:v[1]?'day':'month'}:null;
    });
    if(tokens.some(t=>!t))return null;
    const invalid=()=>({kind:'invalid',invalid:true,fromDate:localToday,toDate:localToday,label:'Некорректный период',notice:'Укажите корректный период, например: 31.10.2026 — 05.11.2026.'});
    const explicit=tokens.some(t=>t.year);
    for(let i=0;i<tokens.length;i++){
        const t=tokens[i];if(t.year)continue;
        const next=tokens.slice(i+1).find(x=>x.year);
        t.year=next?.year||tokens[i-1]?.year||Number(localToday.slice(0,4));
        if(next&&t.month>next.month)t.year--;
        else if(!next&&i&&t.month<tokens[i-1].month)t.year++;
    }
    const bounds=t=>[makeIsoEventDate(t.year,t.month,t.day),t.precision==='year'?makeIsoEventDate(t.year,12,31):t.precision==='month'?makeIsoEventDate(t.year,t.month,getIsoEventMonthLastDay(t.year,t.month)):makeIsoEventDate(t.year,t.month,t.day)];
    let first=bounds(tokens[0])[0],last=bounds(tokens.at(-1))[1];
    if(!first||!last||tokens.some(t=>!bounds(t)[0]))return invalid();
    if(!explicit&&tokens.some(t=>t.precision==='day')&&last<localToday){
        tokens.forEach(t=>t.year++);first=bounds(tokens[0])[0];last=bounds(tokens.at(-1))[1];
    }
    if(!first||!last||first>last)return invalid();
    const precision=tokens.every(t=>t.precision==='year')?'year':tokens.every(t=>t.precision==='month')?'month':'day';
    const kind=precision==='day'?(tokens.length>1?'date-range':'date'):precision;
    const prefix=precision==='month'?'Тусы за '+tokens.map(t=>RUSSIAN_EVENT_MONTH_NAMES_NOMINATIVE[t.month]).join(' '):precision==='year'?'Тусы за год':tokens.length>1?'Тусы за период':'Тусы на дату';
    return createPublicEventsRange(kind,first,last,prefix);
}

function daysWord(days) {
    const n = Math.abs(Number(days)) % 100;
    const last = n % 10;
    if (n >= 11 && n <= 14) return 'дней';
    if (last === 1) return 'день';
    if (last >= 2 && last <= 4) return 'дня';
    return 'дней';
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

    function createByKind(kind, date = now(), dayCount = 3) {
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
            case 'nextDays': {
                const days = Math.min(365, Math.max(1, Number(dayCount) || 3));
                return createPublicEventsRange(
                    'nextDays', localToday, addDaysToDateString(localToday, days - 1),
                    `Ближайшие ${days} ${daysWord(days)}`,
                );
            }
            case 'next30':
                return createPublicEventsRange(
                    'next30', localToday, addDaysToDateString(addIsoEventMonths(localToday, 1), -1),
                    'Ближайший месяц',
                );
            case 'currentMonth': {
                const year = Number(localToday.slice(0, 4));
                const month = Number(localToday.slice(5, 7));
                const last = makeIsoEventDate(year, month, getIsoEventMonthLastDay(year, month));
                return createPublicEventsRange('currentMonth', localToday, last, 'Этот месяц');
            }
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

    function resolveBareDay(day, localToday) {
        const currentYear = Number(localToday.slice(0, 4));
        const currentMonth = Number(localToday.slice(5, 7));
        const candidate = makeIsoEventDate(currentYear, currentMonth, day);
        if (candidate && compareIsoEventDates(candidate, localToday) >= 0) return candidate;
        const nextMonth = currentMonth === 12 ? 1 : currentMonth + 1;
        const nextYear = currentMonth === 12 ? currentYear + 1 : currentYear;
        return makeIsoEventDate(nextYear, nextMonth, day);
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
        const dateMonthWords = Object.keys(RUSSIAN_EVENT_MONTHS)
            .sort((left, right) => right.length - left.length)
            .join('|');
        const makeRange = (fromDay, fromMonth, fromYear, toDay, toMonth, toYear) => {
            const makeDate = (day, month, year) => year
                ? makeIsoEventDate(Number(year) < 100 ? Number(year) + 2000 : Number(year), Number(month), Number(day))
                : resolveDateWithoutYear(Number(month), Number(day), localToday);
            let from = makeDate(fromDay, fromMonth, fromYear);
            let to = makeDate(toDay, toMonth, toYear || fromYear);
            if (!from || !to) return null;
            if (compareIsoEventDates(from, to) > 0 && !fromYear && !toYear) {
                to = makeIsoEventDate(Number(to.slice(0, 4)) + 1, Number(toMonth), Number(toDay));
            }
            if (!to || compareIsoEventDates(from, to) > 0) return null;
            return createPublicEventsRange('date-range', from, to, 'Тусы за период');
        };
        const rangePatterns = [
            {
                regex: /(?:^|\s)(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?\s*(?:-|–|—|по)\s*(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?=$|\s)/u,
                read: match => makeRange(match[1], match[2], match[3], match[4], match[5], match[6] || match[3]),
            },
            {
                regex: /(?:^|\s)(\d{1,2})\s*(?:-|–|—)\s*(\d{1,2})[.\/-](\d{1,2})(?:[.\/-](\d{2,4}))?(?=$|\s)/u,
                read: match => makeRange(match[1], match[3], match[4], match[2], match[3], match[4]),
            },
            {
                regex: new RegExp('(?:^|\\s)(?:с\\s+)?(\\d{1,2})\\s+по\\s+(\\d{1,2})\\s+(' + dateMonthWords + ')(?:\\s+(\\d{4}))?(?=$|\\s)', 'iu'),
                read: match => makeRange(match[1], RUSSIAN_EVENT_MONTHS[match[3]], match[4], match[2], RUSSIAN_EVENT_MONTHS[match[3]], match[4]),
            },
            {
                regex: new RegExp('(?:^|\\s)(?:с\\s+)?(\\d{1,2})\\s+(' + dateMonthWords + ')\\s+(?:по|[-–—])\\s+(\\d{1,2})(?:\\s+(' + dateMonthWords + '))?(?:\\s+(\\d{4}))?(?=$|\\s)', 'iu'),
                read: match => makeRange(match[1], RUSSIAN_EVENT_MONTHS[match[2]], match[5], match[3], RUSSIAN_EVENT_MONTHS[match[4] || match[2]], match[5]),
            },
            {
                regex: new RegExp('(?:^|\\s)(?:с\\s+)?(\\d{1,2})\\s+(' + dateMonthWords + ')\\s+(?:по|[-–—])\\s+(\\d{1,2})\\s+(' + dateMonthWords + ')(?:\\s+(\\d{4}))?(?=$|\\s)', 'iu'),
                read: match => makeRange(match[1], RUSSIAN_EVENT_MONTHS[match[2]], match[5], match[3], RUSSIAN_EVENT_MONTHS[match[4]], match[5]),
            },
        ];
        for (const item of rangePatterns) {
            const match = command.match(item.regex);
            const range = match ? item.read(match) : null;
            if (range) return range;
        }
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

        // A standalone day in an events menu means that day in the current
        // month, rolling to the next occurrence when this month's date passed.
        // Keep price phrases out of this shortcut.
        const bareDayMatch = command.match(/(?:^|\s)(\d{1,2})(?=\s|$)/u);
        if (bareDayMatch &&
            !/(?:до|цена|стоимость|руб(?:лей|ля)?|₽)/iu.test(command) &&
            !/(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр)/iu.test(command)) {
            const day = Number(bareDayMatch[1]);
            if (day >= 1 && day <= 31) {
                const date = resolveBareDay(day, localToday);
                if (date) return createPublicEventsRange('date', date, date, 'Тусы на дату');
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

    function parseNamedMonths(command, localToday) {
        const monthWords = Object.keys(RUSSIAN_EVENT_MONTHS)
            .sort((left, right) => right.length - left.length)
            .join('|');
        const matches = [...command.matchAll(new RegExp(
            '(?:^|\\s)(?:в\\s+)?(' + monthWords + ')(?:\\s+(\\d{4}))?(?=$|\\s)',
            'gu',
        ))];
        if (matches.length < 2) return null;
        const currentYear = Number(localToday.slice(0, 4));
        const parsed = matches.map((match) => ({
            month: RUSSIAN_EVENT_MONTHS[match[1]],
            year: match[2] ? Number(match[2]) : currentYear,
            explicitYear: Boolean(match[2]),
        })).filter((item) => Number.isInteger(item.month));
        if (parsed.length < 2) return null;
        for (let index = 1; index < parsed.length; index += 1) {
            if (!parsed[index].explicitYear) {
                parsed[index].year = parsed[index - 1].year +
                    (parsed[index].month < parsed[index - 1].month ? 1 : 0);
            }
        }
        let first = makeIsoEventDate(parsed[0].year, parsed[0].month, 1);
        let lastItem = parsed.at(-1);
        let last = makeIsoEventDate(lastItem.year, lastItem.month, getIsoEventMonthLastDay(lastItem.year, lastItem.month));
        if (!first || !last) return null;
        const fromDate = first;
        const names = parsed.map((item) => RUSSIAN_EVENT_MONTH_NAMES_NOMINATIVE[item.month]);
        return createPublicEventsRange('month', fromDate, last, 'Тусы за ' + names.join(' '));
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

        const fromDate = first;

        return createPublicEventsRange(
            'month', fromDate, last,
            `Тусы за ${RUSSIAN_EVENT_MONTH_NAMES_NOMINATIVE[month]}`,
        );
    }

    function hasSubject(command) {
        return /(?:тус(?:ы|овк|овки|овок)?|концерт|мероприят|афиш|вечерин|событи|движ|куда\s+сходить)/u.test(command);
    }

    function isSingleOrganizerPartyQuery(command) {
        return /(?:^|\s)(?:следующ(?:ая|ую|ей)|ближайш(?:ая|ую|ей))\s+(?:тус(?:а|у|е|ы|овка|овку|овке)|вечеринк(?:а|у|е|и))(?:$|\s)/u.test(command);
    }

    function parseCommandRaw(value) {
        const command = normalizeLocalCommand(value);

        if (!command || isSingleOrganizerPartyQuery(command) || !hasSubject(command)) return null;

        const localToday = today();

        const past = /(?:^|\s)(?:прошедш(?:ие|их)|прешедш(?:ие|их)|прошл(?:ые|ых|ый|ую|ой|ом|ое)|вчера|позавчера)(?=$|\s)/u.test(command);
        const future = /(?:^|\s)(?:будущ(?:ие|их)|предстоящ(?:ие|их))(?=$|\s)/u.test(command);
        if(past&&!future)return {...createByKind('all'),pastOnly:true,notice:'Прошедшие тусы не показываю.'};
        const calendar=parseCalendarExpression(command,localToday);
        if(calendar)return past&&future?{...calendar,notice:'Прошедшие тусы не показываю, только будущие.'}:calendar;
        if(past&&future)return {...createByKind('all'),notice:'Прошедшие тусы не показываю, только будущие.'};
        const specificDate = parseSpecificDate(command, localToday);
        if (specificDate) return specificDate;
        const namedWeekday = parseNamedWeekday(command, localToday);
        if (namedWeekday) return namedWeekday;
        // The all-time qualifier is commonly prefixed by a subject and/or
        // section marker ("тусы вообще за всё время", "qtickets события").
        // Match the qualifier as a phrase instead of requiring the whole
        // normalized command to equal it.
        if (
            /(?:^|\s)(?:(?:вообще\s+)?все\s+(?:тусы|тусовки|мероприятия|события))(?:$|\s)/u.test(command) ||
            /(?:^|\s)(?:(?:вообще\s+)?за\s+все\s+(?:будущие\s+)?(?:тусы|события|время)|(?:все|вся)\s+будущие\s+(?:тусы|события)|(?:все|вся)\s+время)(?:$|\s)/u.test(command) ||
            /(?:^|\s)(?:вообще\s+)?за\s+все\s+время(?:$|\s)/u.test(command)
        ) return createByKind('all');
        if (/(?:^|\s)(?:ближайшие\s+дни|на\s+ближайшие\s+дни|до\s+конца\s+выходных)(?:$|\s)/u.test(command)) return createByKind('nearWeekend');
        const dayCountMatch = command.match(/(?:^|\s)(?:(?:в|на)\s+)?(?:ближайш(?:ие|их)|следующ(?:ие|их))\s+(\d{1,3}|один|одна|два|две|три|четыре|пять|шесть|семь|восемь|девять|десять)\s+дн(?:я|ей)(?:$|\s)/u);
        if (dayCountMatch) {
            const words = { один: 1, одна: 1, два: 2, две: 2, три: 3, четыре: 4, пять: 5, шесть: 6, семь: 7, восемь: 8, девять: 9, десять: 10 };
            const days = Number(dayCountMatch[1]) || words[dayCountMatch[1]];
            if (days > 0) return createByKind('nextDays', now(), days);
        }
        if (/(?:^|\s)(?:сегодня|на\s+сегодня)(?:$|\s)/u.test(command)) return createByKind('today');
        if (/(?:^|\s)(?:завтра|на\s+завтра)(?:$|\s)/u.test(command)) return createByKind('tomorrow');
        if (/(?:^|\s)(?:эти\s+выходные|на\s+(?:этих\s+)?выходных|выходные)(?:$|\s)/u.test(command)) return createByKind('weekend');
        if (/(?:^|\s)(?:(?:эта\s+неделя|эту\s+неделю|этой\s+неделе|на\s+эту\s+неделю|на\s+этой\s+неделе|за\s+эту\s+неделю)|(?:на\s+)?недел(?:ю|я))(?:$|\s)/u.test(command)) {
            // «Эта неделя» is the remaining calendar week through Sunday.
            // The weekend button remains a narrower Friday–Sunday view; the
            // two commands intentionally overlap so a user asking for the
            // whole current week does not lose Friday–Sunday events.
            const week = createByKind('week');
            if (!week) return null;
            return createPublicEventsRange('week', week.fromDate, week.toDate, 'Эта неделя');
        }
        if (/(?:^|\s)(?:месяц|на\s+месяц|на\s+месяц\s+вперед|на\s+месяц\s+вперёд|ближайший\s+месяц|следующие\s+30\s+дней)(?:$|\s)/u.test(command)) return createByKind('next30');
        if (/(?:^|\s)(?:этот\s+месяц|этом\s+месяце|текущий\s+месяц|на\s+этот\s+месяц)(?:$|\s)/u.test(command)) return createByKind('currentMonth');

        const namedMonth = parseNamedMonths(command, localToday) || parseNamedMonth(command, localToday);
        if (namedMonth) return namedMonth;

        if (
            /(?:ближайш|скоро|в\s+ближайшее\s+время|(?:следующие|на)?\s*две\s+недели|на\s+две\s+недели\s+вперед|на\s+две\s+недели\s+вперёд)/u.test(command) ||
            new Set([
                'тусы', 'концерты', 'афиша', 'мероприятия',
                'тусы из источников', 'тусы из телеграма', 'тусы из вк',
                'афиша из источников', 'афиша из телеграма', 'афиша из вк',
            ]).has(command)
        ) {
            return createByKind('next14');
        }

        // A bare section selection is an explicit event command, not an AI prompt.
        // Without this, «тусы второстепенные» used an expensive semantic route.
        if (/^(?:тусы\s+второстепенные|второстепенные\s+тусы|тусы\s+основные|основные\s+тусы)$/u.test(command)) {
            return createByKind('next14');
        }
        return null;
    }

    const parseCommand = value => restrictPublicEventsToFuture(parseCommandRaw(value), today());

    function looksLikeQuestion(value) {
        const command = normalizeLocalCommand(value);
        if (!command || isSingleOrganizerPartyQuery(command)) return false;

        return (
            /(?:тусы|концерт|мероприят|афиш|куда\s+сходить|вечеринки|движи)/u.test(command) ||
            (hasSubject(command) && /(?:выходн|недел|месяц|сегодня|завтра|\d{1,2}[.\/-]\d{1,2})/u.test(command))
        );
    }

    function fromClassifierTokenRaw(token) {
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
                first,
                last,
                'Тусы за месяц',
            )
            : null;
    }

    const fromClassifierToken = token => restrictPublicEventsToFuture(fromClassifierTokenRaw(token), today());

    return {
        createPublicEventsRangeByKind: createByKind,
        looksLikePublicEventsQuestion: looksLikeQuestion,
        parsePublicEventsRangeCommand: parseCommand,
        publicEventsRangeFromClassifierToken: fromClassifierToken,
    };
}
