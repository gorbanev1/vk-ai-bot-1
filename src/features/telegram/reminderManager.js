import { getSharedEventSchedule } from '../events/sharedEventSchedule.js';
import { splitTelegramLongReply } from '../../platforms/telegram/telegramLongReply.js';
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { randomUUID } from 'node:crypto';
import { inflateRawSync } from 'node:zlib';

const DEFAULT_CHAT_ID = '8019356616';
const DEFAULT_USER_ID = '8019356616';
const DEFAULT_PEER_ID = '-3000000005';
const ACK = /^(?:сделал(?:а)?|подстригла|готово|выполнено|сделано|отмен(?:а|ить))$/iu;
const HELP_ACK_DATA = /^remhelp:(owner|milana)$/u;
const REMINDER_ACK_PREFIX = 'remdone:';
const REMINDER_LIST_PREFIX = 'remlist:';
const ATTACHMENT_CACHE_ROOT = 'data/telegram-reminder-attachments';
const normalize = value => String(value ?? '').replace(/\s+/gu, ' ').trim();

function safeArchiveName(value) {
    const name = String(value || '').replaceAll('\\', '/').split('/').pop().trim();
    return name && name !== '.' && name !== '..' ? name.slice(0, 180) : '';
}

function extractZipEntries(buffer, outputDir) {
    if (!Buffer.isBuffer(buffer) || buffer.length < 30) return [];
    mkdirSync(outputDir, { recursive: true });
    const entries = [];
    // Read the central directory: local headers may omit sizes when the
    // archive uses a data descriptor (the common ZIP writer behaviour).
    let eocd = -1;
    for (let offset = Math.max(0, buffer.length - 65_557); offset + 22 <= buffer.length; offset += 1) {
        if (buffer.readUInt32LE(offset) === 0x06054b50) eocd = offset;
    }
    if (eocd < 0) return [];
    const count = buffer.readUInt16LE(eocd + 10);
    const centralOffset = buffer.readUInt32LE(eocd + 16);
    let offset = centralOffset;
    for (let index = 0; index < count && offset + 46 <= buffer.length; index += 1) {
        if (buffer.readUInt32LE(offset) !== 0x02014b50) break;
        const flags = buffer.readUInt16LE(offset + 8);
        const method = buffer.readUInt16LE(offset + 10);
        const compressedSize = buffer.readUInt32LE(offset + 20);
        const uncompressedSize = buffer.readUInt32LE(offset + 24);
        const nameLength = buffer.readUInt16LE(offset + 28);
        const extraLength = buffer.readUInt16LE(offset + 30);
        const commentLength = buffer.readUInt16LE(offset + 32);
        const localOffset = buffer.readUInt32LE(offset + 42);
        const rawName = buffer.subarray(offset + 46, offset + 46 + nameLength).toString('utf8');
        const name = safeArchiveName(rawName);
        if (localOffset + 30 > buffer.length || buffer.readUInt32LE(localOffset) !== 0x04034b50) { offset += 46 + nameLength + extraLength + commentLength; continue; }
        const localNameLength = buffer.readUInt16LE(localOffset + 26);
        const localExtraLength = buffer.readUInt16LE(localOffset + 28);
        const dataStart = localOffset + 30 + localNameLength + localExtraLength;
        if (!name || rawName.endsWith('/') || dataStart + compressedSize > buffer.length) { offset += 46 + nameLength + extraLength + commentLength; continue; }
        try {
            const compressed = buffer.subarray(dataStart, dataStart + compressedSize);
            const data = method === 0 ? compressed : method === 8 ? inflateRawSync(compressed) : null;
            if (!data || (uncompressedSize && data.length !== uncompressedSize)) throw new Error('unsupported ZIP entry');
            const path = join(outputDir, String(entries.length).padStart(4, '0') + '-' + name);
            writeFileSync(path, data);
            entries.push({ name, path, size: data.length, index: entries.length });
        } catch (error) { console.warn('[TELEGRAM REMINDER ZIP ENTRY ERROR]', name, error?.message || error); }
        offset += 46 + nameLength + extraLength + commentLength;
    }
    return entries;
}

function localParts(date, timeZone) {
    return Object.fromEntries(new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
    }).formatToParts(date).filter(part => part.type !== 'literal').map(part => [part.type, part.value]));
}

function localEpoch({ year, month, day, hour = 0, minute = 0 }, timeZone) {
    const desired = Date.UTC(year, month - 1, day, hour, minute);
    const actual = localParts(new Date(desired), timeZone);
    const actualUtc = Date.UTC(Number(actual.year), Number(actual.month) - 1, Number(actual.day), Number(actual.hour), Number(actual.minute), Number(actual.second));
    return desired + desired - actualUtc;
}

function parseClock(value) {
    const match = String(value ?? '').match(/^(\d{1,2})(?::(\d{2}))?$/u);
    if (!match) return null;
    const hour = Number(match[1]); const minute = Number(match[2] || 0);
    return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

function parseHour(hourText, minuteText, period) {
    let hour = Number(hourText); const minute = Number(minuteText || 0);
    if (hour > 23 || minute > 59) return null;
    if (period === 'утра' && hour === 12) hour = 0;
    else if ((period === 'дня' || period === 'вечера') && hour < 12) hour += 12;
    else if (period === 'ночи' && hour === 12) hour = 0;
    return { hour, minute };
}

function baseDate(now, offset, zone) {
    const p = localParts(now, zone);
    const d = new Date(Date.UTC(Number(p.year), Number(p.month) - 1, Number(p.day) + offset));
    return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate() };
}

function weekdayIndex(value) {
    const table = [
        [/воскресень/iu, 0], [/понедельник/iu, 1], [/вторник/iu, 2],
        [/сред/iu, 3], [/четверг/iu, 4], [/пятниц/iu, 5], [/суббот/iu, 6],
    ];
    return table.find(([pattern]) => pattern.test(value))?.[1] ?? -1;
}

function weekdayDateAfter(now, weekday, timeZone, includeToday = false) {
    const current = localParts(now, timeZone);
    const today = new Date(Date.UTC(Number(current.year), Number(current.month) - 1, Number(current.day)));
    const delta = (weekday - today.getUTCDay() + 7) % 7 || (includeToday ? 0 : 7);
    const target = new Date(today.getTime() + delta * 86_400_000);
    return { year: target.getUTCFullYear(), month: target.getUTCMonth() + 1, day: target.getUTCDate() };
}

function monthDayAfter(now, monthDay, timeZone) {
    const current = localParts(now, timeZone);
    const currentYear = Number(current.year);
    const currentMonth = Number(current.month);
    const daysInMonth = (year, month) => new Date(Date.UTC(year, month, 0)).getUTCDate();
    let year = currentYear; let month = currentMonth;
    if (Number(current.day) > monthDay) month += 1;
    if (month > 12) { month = 1; year += 1; }
    return { year, month, day: Math.min(monthDay, daysInMonth(year, month)) };
}

function datePartsAt(timestamp, timeZone) {
    const parts = localParts(new Date(timestamp), timeZone);
    return { year: Number(parts.year), month: Number(parts.month), day: Number(parts.day) };
}

function shiftDate(day, cadence) {
    if (cadence === 'daily') {
        const value = new Date(Date.UTC(day.year, day.month - 1, day.day + 1));
        return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
    }
    if (cadence === 'weekly') {
        const value = new Date(Date.UTC(day.year, day.month - 1, day.day + 7));
        return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: value.getUTCDate() };
    }
    if (cadence === 'monthly') {
        const value = new Date(Date.UTC(day.year, day.month, 1));
        const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
        return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: Math.min(day.day, end) };
    }
    if (cadence === 'yearly') {
        const year = day.year + 1;
        const end = new Date(Date.UTC(year, day.month, 0)).getUTCDate();
        return { year, month: day.month, day: Math.min(day.day, end) };
    }
    return null;
}

function nextMonthlyAnchor(day, monthDay) {
    const value = new Date(Date.UTC(day.year, day.month, 1));
    const end = new Date(Date.UTC(value.getUTCFullYear(), value.getUTCMonth() + 1, 0)).getUTCDate();
    return { year: value.getUTCFullYear(), month: value.getUTCMonth() + 1, day: Math.min(Number(monthDay || day.day), end) };
}

function buildCycleTimes(day, schedule, after, random = Math.random) {
    const from = schedule.windowStart || schedule.clock || { hour: 10, minute: 0 };
    const to = schedule.windowEnd || from;
    const first = localEpoch({ ...day, ...from }, schedule.timeZone);
    const last = localEpoch({ ...day, ...to }, schedule.timeZone);
    if (last < first) return { error: 'range-order' };
    let times = [];
    if (schedule.intervalMs && schedule.windowStart && schedule.windowEnd) {
        const aligned = first + Math.max(0, Math.ceil((after - first) / schedule.intervalMs)) * schedule.intervalMs;
        for (let at = aligned; at <= last && times.length < 1000; at += schedule.intervalMs) times.push(at);
        if (schedule.countPerCycle) times = times.slice(0, schedule.countPerCycle);
    } else if (schedule.dailyInsidePeriod) {
        const endDay = shiftDate(day, schedule.cadence);
        const endExclusive = endDay ? localEpoch({ ...endDay, hour: 0, minute: 0 }, schedule.timeZone) : last;
        const perDay = Math.max(1, Number(schedule.dailyCountPerDay || 1));
        for (let cursor = { ...day }; localEpoch({ ...cursor, hour: 0, minute: 0 }, schedule.timeZone) < endExclusive && times.length < 1000;) {
            const dayFirst = localEpoch({ ...cursor, ...(schedule.windowStart || schedule.clock || { hour: 10, minute: 0 }) }, schedule.timeZone);
            const defaultLast = schedule.windowStart || schedule.clock || { hour: 10, minute: 0 };
            const dayLast = localEpoch({ ...cursor, ...(schedule.windowEnd || defaultLast) }, schedule.timeZone)
                + (!schedule.windowStart && !schedule.windowEnd ? Math.max(0, perDay - 1) * 3_600_000 : 0);
            const span = Math.max(0, dayLast - dayFirst);
            if (dayLast >= dayFirst) for (let index = 0; index < perDay; index += 1) {
                const at = perDay === 1 ? dayFirst : schedule.random
                    ? dayFirst + Math.floor(random() * Math.max(1, span))
                    : dayFirst + Math.floor(span * index / (perDay - 1));
                if (at > after && at < endExclusive) times.push(at);
            }
            const next = new Date(Date.UTC(cursor.year, cursor.month - 1, cursor.day + 1));
            cursor = { year: next.getUTCFullYear(), month: next.getUTCMonth() + 1, day: next.getUTCDate() };
        }
    } else if (schedule.countPerCycle > 1 && schedule.windowStart && schedule.windowEnd) {
        const count = schedule.countPerCycle;
        const span = last - first;
        if (span < (count - 1) * 60_000) return { error: 'window-too-short' };
        times = Array.from({ length: count }, (_, index) => {
            const low = first + Math.floor(span * index / count);
            const high = first + Math.floor(span * (index + 1) / count);
            return schedule.random ? low + Math.floor(random() * Math.max(1, high - low)) : low + Math.floor((high - low) / 2);
        }).sort((a, b) => a - b);
    } else {
        const interval = schedule.intervalMs || 60 * 60_000;
        const count = schedule.countPerCycle || 1;
        times = Array.from({ length: Math.min(count, 1000) }, (_, index) => first + index * interval);
    }
    times = times.filter(at => at > after);
    return { times, windowEnd: last };
}

function nextCycle(schedule, currentDay, after, random = Math.random) {
    let day = currentDay;
    for (let attempt = 0; attempt < 400; attempt += 1) {
        day = schedule.cadence === 'monthly' && schedule.monthDay
            ? nextMonthlyAnchor(day, schedule.monthDay)
            : shiftDate(day, schedule.cadence);
        if (!day) return null;
        const cycle = buildCycleTimes(day, schedule, after, random);
        if (cycle.error) return cycle;
        if (cycle.times.length) return { ...cycle, day };
    }
    return null;
}

function hasWord(text, word) {
    return new RegExp('(?<![\\p{L}\\p{N}_])' + word + '(?=$|[^\\p{L}\\p{N}_])', 'iu').test(text);
}

export function buildReminderHelp() {
    return [
        'Повторы: «Сделал(а)» убирает оставшиеся повторы только сегодня. Завтра расписание продолжится. Автор получает уведомление.',
        'Постоянная отмена — отдельная кнопка. С ключом «личная отмена» получатель запрашивает разрешение автора; без ключа отменяет сам.',
        'напоминай Мелане каждый день в 10:00 выпить витамины личная отмена',
        'напоминай мне три раза в день с 10:00 по 20:00 проверить задачу',
        'напоминай Милане четыре раза в день с 10:00 до 20:00 проверить задачу отменять лично',
        'напомни Игорю завтра в 18:00 позвонить',
        'напомни мне завтра и 20.12.2026 в 18:00 проверить задачу',
        'напомни мне завтра и 20.12.2026 с 10:00 до 18:00 3 раза проверить задачу',
        'напомни мне через неделю в 18:00 проверить задачу',

        'Команды напоминаний (время — московское). Сначала — готовые примеры, ниже — шаблоны.',
        '',
        'напомни мне завтра в 12:30 позвонить врачу',
        'напомни мне через 2 часа позвонить врачу',
        'напомни мне завтра с 10:00 до 15:00 3 раза случайно проверить почту',
        'напомни мне завтра с 10 часов до 15 часов 3 раза рандомно проверить почту',
        'напомни мне завтра каждые 20 минут 3 раза забрать документы',
        'напомни мне каждый день в 09:00 принять лекарство',
        'напомни мне каждую неделю в понедельник в 10:00 оплатить счет',
        'напоминай с 14 числа каждого месяца 2 раза в день с 10:00 до 16:00 Отправить ТНС',
        'напомни мне 12.12.2026 в 18:30 забрать заказ',
        'напомни Милане 3 раза раз в час проверить задачу (только владелец)',
        'напомни Игорю завтра в 18:00 проверить задачу (только Милана)',
        'напиши Милане текст сообщения (только владелец)',
        '',
        'Полные примеры:',
        'Разово сегодня: напомни мне сегодня в 18:00 купить хлеб',
        'Разово по дате: напомни мне 12.12.2026 в 18:30 забрать заказ',
        'Разово через интервал: напомни мне через 45 минут позвонить врачу',
        'Несколько раз в окне: напомни мне завтра с 10:00 до 15:00 3 раза проверить почту',
        'Несколько раз случайно: напомни мне завтра 3 раза случайно с 10:00 до 15:00 проверить почту',
        'Через равные интервалы: напомни мне завтра каждые 20 минут 3 раза забрать документы',
        'Каждый день в одно время: напомни мне каждый день в 09:00 принять лекарство',
        'Каждый день в окне: напоминай мне каждый день с 10:00 до 16:00 2 раза в день случайно сделать паузу',
        'Каждую неделю: напоминай мне каждую неделю по понедельникам в 10:00 оплатить счет',
        'С указанного дня месяца: напоминай мне с 14 числа каждого месяца 2 раза в день случайно с 10:00 до 16:00 отправить ТНС',
        'Месячный вариант с другим числом: напоминай мне ежемесячно с 12 числа 3 раза в день с 10:00 до 20:00 проверить отчёт',
        'Порядок блоков свободный: напоминай мне 3 раза в день с 10:00 до 20:00 с 12 числа каждого месяца проверить отчёт',
        'Напомнить Милане: напомни Милане завтра в 18:00 проверить задачу (только владелец)',
        'Напомнить владельцу: напомни Игорю завтра в 18:00 проверить задачу (только Милана)',
        'Отправить текст сразу: напиши Милане Встреча перенесена на 19:00 (только владелец)',
        'Отправить вложение сразу: ответь «отправь Милане» на сообщение с фото или документом',
        'Отправить вложение позже: ответь «отправь Милане завтра в 12:00 любой файл» на сообщение с вложением',
        'Отправлять файлы по очереди: ответь «отправь Милане каждый день в 12:00 по очереди» на ZIP-архив',
        'Отправлять случайный файл: ответь «отправь Милане каждый день в 12:00 случайный файл» на ZIP-архив',
        'Показать список: мои напоминания',
        'Выполнено сегодня: нажми «Сделал(а)» под напоминанием или ответь «сделал/сделала» именно на него',
        '',
        'Шаблоны: обязательные части отмечены угловыми скобками <…>, необязательные — квадратными […].',
        'Получатель: <мне | Милане | Игорю>. «Милане» доступно владельцу; «Игорю» доступно Милане; «мне» — текущему отправителю.',
        'Разово: напомни [<получатель>] <сегодня | завтра | послезавтра | ДД.ММ.ГГГГ | через N минут/часов/дней> [в ЧЧ:ММ] <действие>',
        'По календарю: напоминай [<получатель>] [с ДД.ММ.ГГГГ | с дня недели] <ежедневно | еженедельно | ежемесячно | ежегодно> [в ЧЧ:ММ] <действие>',
        'По интервалу: напоминай [<получатель>] [старт] каждые <N минут/часов/дней> [N раз] <действие>',
        'Окно: напоминай [<получатель>] [старт] с <ЧЧ:ММ> до <ЧЧ:ММ> [N раз] [случайно | равномерно] <действие>',
        'Ежедневное окно: напоминай [<получатель>] [с даты/дня недели] <ежедневно> с <ЧЧ:ММ> до <ЧЧ:ММ> [каждые N минут/часов | N раз в день] <действие>',
        'Ежемесячное окно: напоминай [<получатель>] с <числа> числа каждого месяца [N раз в день] с <ЧЧ:ММ> до <ЧЧ:ММ> <действие>',
        'Минуты часа: напоминай [<получатель>] [период] в <MM> минут каждого часа [N раз] <действие>',
        'Сообщение без расписания: напиши/отправь <Милане | Игорю> <текст> (адресат по правам тот же).',
        'Вложение: ответь командой «отправь Милане» на сообщение с фото, документом или ZIP-архивом. Вложение будет передано адресату.',
        'Вложение по расписанию: отправь Милане [время/дата и повтор] [любой файл | случайный файл | по очереди] на сообщение с вложением.',
        'ZIP распаковывается при сохранении напоминания: «случайный файл» выбирает случайный элемент, «по очереди» и «последовательно» отправляют элементы по порядку; обычное одиночное вложение передаётся как есть.',
        'Где указано [старт], можно использовать: сегодня, завтра, послезавтра, ДД.ММ.ГГГГ, с понедельника/вторника/… или со следующего понедельника/… .',
        'N раз — количество отправок в одном разовом цикле или календарном периоде. Без N раз повтор продолжается по указанному периоду/интервалу.',
        'Случайно выбирает моменты внутри окна; равномерно распределяет их. Если режим не указан, N отправок распределяются равномерно.',
        'Нажатие «Сделал(а)» завершает только сегодняшний день повторяющегося напоминания. Ответ «сделал/сделала» тоже сработает, только если это ответ именно на сообщение напоминания.',
        'Кнопка «Изменить напоминание» открывает форму; новое расписание применяется после «Подтвердить».',
    ].join('\n');
}

function buildReminderHelpNotice(name = '') {
    return [
        name ? name + ', вот как задавать напоминания:' : 'Как задавать напоминания:',
        '',
        buildReminderHelp(),
        '',
        'Нажми «Понял(а)», чтобы закрыть эту подсказку. Пока кнопка не нажата, бот будет присылать её снова через случайные 1–3 часа.',
    ].join('\n');
}

function reminderDoneMarkup(reminderId, approvalRequired = false) {
    return { inline_keyboard: [
        [{ text: 'Сделал(а)', callback_data: REMINDER_ACK_PREFIX + reminderId }],
        [{ text: 'Изменить напоминание', callback_data: 'remedit:' + reminderId }],
        [{ text: approvalRequired ? 'Запросить отмену' : 'Отменить навсегда', callback_data: 'remstop:' + reminderId }],
    ] };
}

function reminderHelpMarkup(target) {
    return { inline_keyboard: [[{ text: 'Понял(а)', callback_data: 'remhelp:' + target }]] };
}

function reminderListMarkup(item, viewerId = '') {
    return { inline_keyboard: [
        [{ text: item.personalCancel && String(item.creatorUserId || item.userId) !== String(viewerId) ? 'Запросить отмену' : 'Отменить навсегда', callback_data: 'remstop:' + item.id }],
        [{ text: 'Изменить', callback_data: 'remlist:edit:' + item.id }],
    ] };
}

export function parseReminderCommand(input, { now = new Date(), timeZone = 'Europe/Moscow', random = Math.random } = {}) {
    let normalizedInput = normalize(input);
    const personalCancel = /(?:личная отмена|отмена лично|отменять лично|отменить можно лично)/iu.test(normalizedInput);
    normalizedInput = normalize(normalizedInput.replace(/(?:личная отмена|отмена лично|отменять лично|отменить можно лично)/giu, ''));
    // A dictated typo: "в с 10:30 до 20:00" means "с 10:30 ...".
    normalizedInput = normalize(normalizedInput.replace(/(^|\s)в\s+с(?=\s+\d{1,2}(?::\d{2})?)/giu, '$1с'));
    normalizedInput = normalizedInput.replace(/(два|три|четыре) раза в день/giu, (_, n) => ({два:2,три:3,четыре:4}[n.toLowerCase()] + ' раза в день')).replace(/в период\s+с/giu, 'с');
    normalizedInput = normalizedInput.replace(/через\s+(?:(\d+)\s+)?недел(?:ю|и|ь)/giu, (_, n) => {
        const d = baseDate(now, 7 * Number(n || 1), timeZone);
        return `${d.day}.${d.month}.${d.year}`;
    });
    const months = ['января','февраля','марта','апреля','мая','июня','июля','августа','сентября','октября','ноября','декабря'];
    normalizedInput = normalizedInput.replace(new RegExp('(?:на\\s+)?(\\d{1,2})\\s+(' + months.join('|') + ')(?:\\s+(20\\d{2}))?', 'giu'), (_, d, m, y) => {
        const month = months.indexOf(m.toLowerCase()) + 1;
        const today = localParts(now, timeZone);
        const year = Number(y || today.year) + (!y && (month < Number(today.month) || (month === Number(today.month) && Number(d) < Number(today.day))) ? 1 : 0);
        return d + '.' + month + '.' + year;
    });
    normalizedInput = normalizedInput.replace(/(\d{4})-(\d{2})-(\d{2})/gu, '$3.$2.$1');
    const multiple = normalizedInput.match(/^(напомни(?:ть)?|напоминай)\s+(?:(мне|м[ие]лане|игорю)\s+)?((?:завтра|послезавтра|сегодня|\d{1,2}\.\d{1,2}(?:\.\d{4})?)(?:\s*(?:,|и)\s*(?:завтра|послезавтра|сегодня|\d{1,2}\.\d{1,2}(?:\.\d{4})?))+)(\s+.+)$/iu);
    if (multiple) {
        const days = multiple[3].split(/\s*(?:,|и)\s*/u);
        const parts = days.map(day => parseReminderCommand(`${multiple[1]} ${multiple[2] || ''} ${day}${multiple[4]}`, {now, timeZone, random}));
        if (parts.some(p => p?.type !== 'create')) return {type:'invalid', reason:'invalid-date-list'};
        const times = [...new Set(parts.flatMap(p => p.times))].sort((a,b)=>a-b);
        return {...parts[0], personalCancel, cadence:'once', count:times.length, times, schedule:{...parts[0].schedule, cadence:'once'}};
    }
    const reordered = normalizedInput.match(/^(.+?)\s+(напоминай|напомни)\s+(.+)$/iu);
    if (reordered) normalizedInput = reordered[2] + ' ' + reordered[3] + ' ' + reordered[1];
    const head = normalizedInput.match(/^(напомни|напомнить|напоминай|напиши|отправь|отправляй)(?:\s+|$)(.*)$/iu);
    if (!head) return null;
    let rest = normalize(head[2]);
    if (!rest) return { type: 'help' };
    let target = 'self';
    const recipient = rest.match(/^(мне|меня|себе|м[ие]лан[аеуы]|м[ие]ланой|игор[ьюяе]|игорем)(?:\s+|$)/iu);
    if (recipient) {
        if (/^м[ие]лан/iu.test(recipient[1])) target = 'milana';
        if (/^игор/iu.test(recipient[1])) target = 'owner';
        rest = normalize(rest.slice(recipient[0].length));
    }
    if (/^(?:напиши|отправь|отправляй)$/iu.test(head[1])) {
        const hasSchedule = /(?:сегодня|завтра|послезавтра|через\s+\d+|\d{1,2}\.\d{1,2}|\d{1,2}:\d{2}|(?:^|\s)в\s+\d{1,2}|кажд|еженед|ежеднев|ежемесяч|ежегод|раз\s+в|каждые)/iu.test(rest);
        if (!hasSchedule) return rest ? { type: 'send', target, content: rest } : { type: 'send-attachment', target, content: '' };
        const sequentialMode = /(?:по\s+очереди|последовательно)/iu.test(rest);
        const randomMode = /случайн\p{L}*\s+файл/iu.test(rest);
        const modeSuffix = randomMode ? '' : sequentialMode ? '' : ' любой файл';
        // The common parser treats mode words as scheduling metadata. For
        // imperative attachment commands, normalize "по очереди" to the
        // canonical "последующий файл" token and let the parser consume it.
        const normalizedRest = sequentialMode
            ? rest.replace(/по\s+очереди|последовательно/iu, 'последующий файл')
            : rest;
        normalizedInput = 'напомни ' + (target === 'self' ? '' : target === 'milana' ? 'Милане ' : 'Игорю ') + normalizedRest + modeSuffix;
        const scheduled = parseReminderCommand(normalizedInput, { now, timeZone, random });
        if (scheduled?.type !== 'create') return scheduled;
        const attachmentMode = randomMode ? 'random'
            : /(?:по\s+очереди|последовательно)/iu.test(rest) ? 'sequential' : scheduled.attachmentMode;
        return { ...scheduled, personalCancel, deliveryKind: 'attachment', attachmentMode: attachmentMode || 'any' };
    }
    // Scheduling blocks may be written in any order. Move recognized blocks
    // before the action while preserving the action text itself.
    const scheduleBlocks = [];
    const blockPatterns = [
        /(?:сегодня|завтра|послезавтра)/iu,
        /(?:каждый|каждую|по)\s+(?:воскресень\p{L}*|понедельник\p{L}*|вторник\p{L}*|сред\p{L}*|четверг\p{L}*|пятниц\p{L}*|суббот\p{L}*)/iu,
        /(?:с|со)\s+(?:следующ\p{L}*\s+)?(?:воскресень\p{L}*|понедельник\p{L}*|вторник\p{L}*|сред\p{L}*|четверг\p{L}*|пятниц\p{L}*|суббот\p{L}*)/iu,
        /с\s+\d{1,2}(?:-?го)?\s+числа(?:\s+кажд\p{L}*\s+месяц\p{L}*)?/iu,
        /\d{1,2}\.\d{1,2}(?:\.\d{2,4})?/u,
        /с\s+\d{1,2}(?::\d{2})?\s*(?:час\p{L}*)?\s+(?:до|по)\s+\d{1,2}(?::\d{2})?\s*(?:час\p{L}*)?/iu,
        /в\s+\d{1,2}(?::\d{2})?(?:\s+час\p{L}*)?/iu,
        /через\s+(?:\d+|пол)\s*(?:минут\p{L}*|час\p{L}*|дн\p{L}*)/iu,
        /ежедневно|еженедельно|ежемесячно|ежегодно|каждый\s+день|каждую\s+неделю|каждый\s+месяц|каждый\s+год/iu,
        /кажд\p{L}*\s+месяц\p{L}*/iu,
        /каждые\s+\d+\s+(?:минут\p{L}*|час\p{L}*|дн\p{L}*|недел\p{L}*|месяц\p{L}*|год\p{L}*)/iu,
        /(?:каждые|раз\s+в|с\s+интервалом\s+в)\s+(?:\d+\s*)?(?:минут\p{L}*|час\p{L}*|полчаса)/iu,
        /\d+\s+раз(?:а|ы)?\s+в\s+день/iu,
        /\d+\s+раз(?:а|ы)?/iu,
        /(?:случайно|рандомно|равномерно)/iu,
    ];
    for (const pattern of blockPatterns) {
        const match = rest.match(pattern);
        if (match) { scheduleBlocks.push(match[0]); rest = normalize(rest.slice(0, match.index) + ' ' + rest.slice(match.index + match[0].length)); }
    }
    if (scheduleBlocks.length) rest = normalize(scheduleBlocks.join(' ') + ' ' + rest);
    if (!rest) return { type: 'help' };
    let day = null, cadence = 'once', cadenceEvery = 1, intervalMs = null, count = null, monthDay = null, dailyCountPerDay = null;
    let clock = null, windowStart = null, windowEnd = null, relativeMs = null, minuteEachHour = null;
    let randomMode = false, weekday = null, dailyInsidePeriod = false, recognized = false;
    let deliveryKind = /(?:любой|случайн\p{L}*|по очереди|последовательно|следующ\p{L}*)\s+файл/iu.test(rest) ? 'attachment' : 'text';
    let attachmentMode = /случайн\p{L}*\s+файл/iu.test(rest) ? 'random' : /(?:по очереди|последовательно|следующ\p{L}*)\s+файл/iu.test(rest) ? 'sequential' : 'any';
    const invalid = reason => ({ type: 'invalid', reason });
    const boundary = '(?=$|\\s|:)';
    const clockToken = '(\\d{1,2})(?:[:\\-](\\d{2}))?(?:\\s+час(?:а|ов)?)?(?:\\s+(утра|дня|вечера|ночи))?';
    const weekdays = '(воскресень\\p{L}*|понедельник\\p{L}*|вторник\\p{L}*|сред\\p{L}*|четверг\\p{L}*|пятниц\\p{L}*|суббот\\p{L}*)';
    const consume = pattern => {
        const match = rest.match(pattern);
        if (match) { rest = normalize(rest.slice(match[0].length)); recognized = true; }
        return match;
    };
    // Only consume a scheduling prefix: dates/numbers inside the action stay intact.
    while (rest && !rest.startsWith(':')) {
        let m;
        if ((m = consume(new RegExp('^(?:в окне\\s+)?с\\s+' + clockToken + '\\s+(?:до|по)\\s+' + clockToken + boundary, 'iu')))) {
            if (windowStart) return invalid('duplicate-window');
            windowStart = parseHour(m[1], m[2], m[3]); windowEnd = parseHour(m[4], m[5], m[6]);
            if (!windowStart || !windowEnd) return invalid('invalid-time');
        } else if ((m = consume(/^(?:с(?:о)?\s+)?(сегодня|завтра|послезавтра)(?=$|\s|:)/iu))) {
            if (day) return invalid('duplicate-date');
            day = baseDate(now, m[1].toLowerCase() === 'послезавтра' ? 2 : m[1].toLowerCase() === 'завтра' ? 1 : 0, timeZone);
        } else if ((m = consume(/^(?:с\s+)?(\d{1,2})\.(\d{1,2})(?:\.(\d{4}))?(?=$|\s|:)/u))) {
            if (day) return invalid('duplicate-date');
            const today = localParts(now, timeZone);
            const year = Number(m[3] || today.year) + (!m[3] && (Number(m[2]) < Number(today.month) || (Number(m[2]) === Number(today.month) && Number(m[1]) < Number(today.day))) ? 1 : 0);
            const d = new Date(Date.UTC(year, Number(m[2]) - 1, Number(m[1])));
            if (d.getUTCMonth() + 1 !== Number(m[2]) || d.getUTCDate() !== Number(m[1])) return invalid('invalid-date');
            day = { year, month: Number(m[2]), day: Number(m[1]) };
        } else if ((m = consume(/^с\s+(\d{1,2})(?:-?го)?\s+числа(?:\s+(?:кажд\p{L}*\s+)?месяц\p{L}*)?(?=$|\s|:)/iu))) {
            monthDay = Number(m[1]);
            if (monthDay < 1 || monthDay > 31) return invalid('invalid-month-day');
            if (cadence !== 'once' && cadence !== 'monthly') return invalid('conflicting-period');
            cadence = 'monthly';
            day = monthDayAfter(now, monthDay, timeZone);
        } else if ((m = consume(new RegExp('^(?:(?:с|со|в|каждый|каждую|по)\\s+)?(?:(следующ\\p{L}*)\\s+)?' + weekdays + boundary, 'iu')))) {
            if (day) return invalid('duplicate-date');
            weekday = weekdayIndex(m[2]);
            day = weekdayDateAfter(now, weekday, timeZone, !m[1]);
        } else if ((m = consume(/^(ежедневно|еженедельно|ежемесячно|ежегодно|каждый день|каждую неделю|каждый месяц|каждого месяца|каждый год)(?=$|\s|:)/iu))) {
            if (cadence !== 'once' && cadence !== 'monthly') return invalid('duplicate-period');
            cadence = /месяч|месяц|месяца/iu.test(m[1]) ? 'monthly' : /год/iu.test(m[1]) ? 'yearly' : /недел/iu.test(m[1]) ? 'weekly' : 'daily';
        } else if ((m = consume(/^каждые\s+(\d+)\s+(дня|дней|недели|недель|месяца|месяцев|года|лет)(?=$|\s|:)/iu))) {
            cadenceEvery = Number(m[1]); if (!cadenceEvery || cadenceEvery > 100) return invalid('invalid-period');
            if (cadence !== 'once') return invalid('duplicate-period');
            cadence = /недел/iu.test(m[2]) ? 'weekly' : /месяц/iu.test(m[2]) ? 'monthly' : /год|лет/iu.test(m[2]) ? 'yearly' : 'daily';
        } else if ((m = consume(/^через\s+(\d+|пол)\s*(минут(?:у|ы)?|час(?:а|ов)?|день|дня|дней)(?=$|\s|:)/iu))) {
            if (relativeMs !== null) return invalid('duplicate-relative');
            relativeMs = (m[1] === 'пол' ? 0.5 : Number(m[1])) * (/час/iu.test(m[2]) ? 3_600_000 : /день|дня|дней/iu.test(m[2]) ? 86_400_000 : 60_000);
            if (!relativeMs) return invalid('invalid-interval');
        } else if ((m = consume(/^(?:каждые|каждый|каждую|раз\s+в|с\s+интервалом(?:\s+в)?)\s+(?:(\d+)\s*)?(полчаса|минут(?:у|ы)?|час(?:а|ов)?)(?=$|\s|:)/iu))) {
            if (intervalMs) return invalid('duplicate-interval');
            intervalMs = Number(m[1] || 1) * (/полчаса/iu.test(m[2]) ? 1_800_000 : /час/iu.test(m[2]) ? 3_600_000 : 60_000);
            if (!intervalMs || intervalMs > 366 * 86_400_000) return invalid('invalid-interval');
        } else if ((m = consume(/^(\d+)\s+раз(?:а|ы)?\s+в\s+день(?=$|\s|:)/iu))) {
            if (dailyCountPerDay !== null || count !== null) return invalid('duplicate-count');
            dailyCountPerDay = Number(m[1]);
            if (dailyCountPerDay < 1 || dailyCountPerDay > 100) return invalid('invalid-count');
            dailyInsidePeriod = true;
        } else if (consume(/^раз\s+в\s+день(?=$|\s|:)/iu)) {
            dailyInsidePeriod = true;
        } else if (consume(/^в\s+день(?=$|\s|:)/iu)) {
            dailyInsidePeriod = true;
        } else if ((m = consume(/^(\d+)\s+раз(?:а|ы)?(?=$|\s|:)/iu))) {
            if (count !== null) return invalid('duplicate-count');
            count = Number(m[1]); if (count < 1 || count > 100) return invalid('invalid-count');
        } else if ((m = consume(/^(случайно|рандомно|равномерно)(?=$|\s|:)/iu))) {
            randomMode = m[1].toLowerCase() !== 'равномерно';
        } else if ((m = consume(/^в\s+(\d{1,2})\s+минут(?:у|ы)?\s+(?:каждого|следующего)\s+часа(?=$|\s|:)/iu))) {
            minuteEachHour = Number(m[1]); if (minuteEachHour > 59) return invalid('invalid-time');
        } else if ((m = consume(new RegExp('^в\\s+' + clockToken + boundary, 'iu')))) {
            if (clock) return invalid('duplicate-time');
            clock = parseHour(m[1], m[2], m[3]); if (!clock) return invalid('invalid-time');
        } else break;
    }
    const content = normalize(rest.replace(/^:\s*/u, ''));
    if (!content) return { type: 'help' };
    if (!recognized || /^(?:с|со|в|каждые|каждый|каждую|через|до|по|еженедельно|ежемесячно)(?=\s|$)/iu.test(content)) return invalid('unrecognized-syntax');
    if (relativeMs !== null && (day || clock || windowStart)) return invalid('conflicting-start');
    if (clock && windowStart) return invalid('conflicting-time');
    if (randomMode && !windowEnd) return invalid('random-needs-window');
    if (dailyInsidePeriod && cadence === 'once') cadence = 'daily';
    const explicitDay = Boolean(day);
    day ||= baseDate(now, 0, timeZone);
    if (minuteEachHour !== null) {
        if (intervalMs || clock) return invalid('conflicting-hourly');
        intervalMs = 3_600_000;
        windowStart ||= { hour: 0, minute: 0 };
        windowEnd ||= { hour: 23, minute: 59 };
    }
    if (cadence === 'once' && intervalMs && !windowStart) cadence = 'interval';
    if (dailyInsidePeriod && dailyCountPerDay === null && count !== null) { dailyCountPerDay = count; count = null; }
    const schedule = { cadence, cadenceEvery, intervalMs, countPerCycle: count, dailyCountPerDay, monthDay, random: randomMode,
        windowStart, windowEnd, clock: clock || { hour: 10, minute: 0 }, dailyInsidePeriod, minuteEachHour, timeZone };
    let cycle;
    if (relativeMs !== null || (cadence === 'interval' && !explicitDay && !clock)) {
        const first = now.getTime() + (relativeMs || intervalMs);
        cycle = { times: Array.from({ length: count || 1 }, (_, i) => first + i * (intervalMs || 3_600_000)) };
        day = datePartsAt(first, timeZone);
    } else {
        cycle = buildCycleTimes(day, schedule, now.getTime(), random);
        if (cycle.error) return invalid(cycle.error);
        if (!cycle.times.length && ['daily', 'weekly', 'monthly', 'yearly'].includes(cadence)) {
            const next = nextCycle(schedule, day, now.getTime(), random);
            if (next) { cycle = next; day = next.day; }
        }
    }
    if (!cycle.times?.length || cycle.times.some(at => !Number.isFinite(at) || at <= now.getTime())) return invalid('past-time');
    const finiteCount = ['once', 'interval'].includes(cadence) ? count || (cadence === 'interval' ? null : cycle.times.length) : null;
    return { type: 'create', target, personalCancel, content: deliveryKind === 'attachment' ? '' : content, deliveryKind, attachmentMode, count: finiteCount, intervalMs: intervalMs || 3_600_000,
        random: randomMode, times: cycle.times, cadence, schedule: { ...schedule, anchorDay: day },
        timeZone, weeklyDay: weekday, monthDay };
}
function readState(path) {
    try { const value = JSON.parse(readFileSync(path, 'utf8')); return { version: 1, reminders: Array.isArray(value?.reminders) ? value.reminders : [], helpNudges: Array.isArray(value?.helpNudges) ? value.helpNudges : [], edits: Array.isArray(value?.edits) ? value.edits : [], aiProposals: Array.isArray(value?.aiProposals) ? value.aiProposals : [], eventSessions: Array.isArray(value?.eventSessions) ? value.eventSessions : [] }; }
    catch { return { version: 1, reminders: [], helpNudges: [], edits: [], aiProposals: [], eventSessions: [] }; }
}
function writeState(path, state) {
    mkdirSync(dirname(path), { recursive: true }); const temp = path + '.tmp';
    writeFileSync(temp, JSON.stringify(state, null, 2), 'utf8'); renameSync(temp, path);
}

export function createReminderManager({ api, storagePath, timeZone = 'Europe/Moscow', ownerExternalUserId = '', ownerVkUserId = '', defaultChatId = DEFAULT_CHAT_ID, defaultUserId = DEFAULT_USER_ID, defaultPeerId = DEFAULT_PEER_ID, now = () => Date.now(), random = Math.random, parseReminderWithAi = null, resolveEvent = null, sendEventReminder = null, sendEventNotice = null, sendVkForwardReminder = null } = {}) {
    if (!storagePath) throw new Error('Reminder manager requires storagePath.');
    const state = readState(storagePath); state.aiProposals = Array.isArray(state.aiProposals) ? state.aiProposals : []; state.eventSessions = Array.isArray(state.eventSessions) ? state.eventSessions : []; let timer = null; let busy = false;
    const persist = () => writeState(storagePath, state);
    const isOwner = context => {
        const platform=String(context?.platform||'').toLowerCase();
        const ownerId=platform==='vk'?ownerVkUserId:platform==='telegram'?ownerExternalUserId:'';
        return Boolean(ownerId && String(context?.externalSenderId||'')===String(ownerId));
    };
    async function denyNonOwnerGroup(context) {
        if (context?.isDM || isOwner(context)) return false;
        await context.send('⛔ Команды напоминаний в беседе доступны только владельцу.');
        return true;
    }
    function revokeUnauthorizedGroupJobs() {
        let count=0;
        for(const item of state.reminders) {
            if(!item.active || storedPlatform(item)!=='vk' ||
                !(item.groupEventReminder || item.deliveryKind==='vk-forward') ||
                String(item.creatorUserId||'')===String(ownerVkUserId||''))continue;
            item.active=false;item.cancelledAt=now();item.cancelReason='owner-only-group';count++;
        }
        if(count){persist();console.warn('[NONOWNER GROUP REMINDERS CANCELLED]',count);}
    }
    const isMilana = context => Boolean(String(context?.externalPeerId || '') === String(defaultChatId) && String(context?.externalSenderId || '') === String(defaultUserId));
    const canAddress = (context, target) => target === 'milana' ? isOwner(context)
        : target === 'owner' ? Boolean(ownerExternalUserId && isMilana(context)) : target === 'self';
    const recipientFor = (target, context) => target === 'milana'
        ? { chatId: String(defaultChatId), userId: String(defaultUserId), peerId: String(defaultPeerId) }
        : target === 'owner'
            ? { chatId: String(ownerExternalUserId), userId: String(ownerExternalUserId), peerId: '' }
            : { chatId: String(context.externalPeerId || ''), userId: String(context.externalSenderId || ''), peerId: String(context.peerId || '') };
    const canManageAll = context => isOwner(context) || isMilana(context);
    const canManageReminder = (context, item) => owns(item, context) || String(item.creatorUserId || '') === String(context.externalSenderId || '') || isOwner(context);
    const reminderOwnerName = item => item.creatorName || (item.creatorUserId === String(defaultUserId) ? 'Милана' : item.creatorUserId === String(ownerExternalUserId) ? 'Игорь' : item.userId);
    const reminderDescription = item => {
        const recipient = item.chatId === String(defaultChatId) && item.userId === String(defaultUserId) ? 'Милане' : item.chatId === String(ownerExternalUserId) ? 'Игорю' : 'текущему чату';
        const attachment = item.deliveryKind === 'attachment' ? ' · вложение (' + (item.attachmentMode || 'any') + ')' : '';
        return '🔔 ' + (item.text || 'Отправить вложение') + attachment + '\nПолучатель: ' + recipient + '\nСледующее: ' + formatAt(item.nextAt) + '\nСоздал(а): ' + reminderOwnerName(item) + '\nСтатус: ' + (item.active ? 'активно' : 'остановлено') + (item.completedDay === dayKey(now(), item.timeZone) ? ' · сделано сегодня' : '') + (item.personalCancel ? '\nОтмена: только с разрешения автора' : '') + (item.cancelRequest ? '\nЗапрос отмены ожидает решения автора' : '');
    };
    async function prepareAttachmentSource(context, parsed) {
        if (!context?.downloadSourceAttachment) return null;
        const source = await context.downloadSourceAttachment();
        if (!source?.buffer?.length) return null;
        const isZip = /\.zip$/iu.test(source.filename || '') || /application\/(?:zip|x-zip-compressed)/iu.test(source.mimeType || '');
        if (!isZip) return { sourceFileName: source.filename, sourceMimeType: source.mimeType };
        const directory = join(ATTACHMENT_CACHE_ROOT, randomUUID());
        const entries = extractZipEntries(source.buffer, directory);
        if (!entries.length) return { sourceFileName: source.filename, sourceMimeType: source.mimeType, archiveEntries: [] };
        return { sourceFileName: source.filename, sourceMimeType: source.mimeType, archiveEntries: entries };
    }
    async function sendReminderList(context) {
        if (!context.isDM) { await context.send('Список напоминаний доступен в личном чате.'); return true; }
        const visible = state.reminders.filter(item => storedPlatform(item) === 'telegram' && item.active && !item.deletedAt && (owns(item, context) || String(item.creatorUserId || '') === String(context.externalSenderId || ''))).sort((a,b) => a.nextAt - b.nextAt);
        if (!visible.length) { await context.send('Активных напоминаний нет.'); return true; }
        for (const item of visible) await context.send({ message: reminderDescription(item), replyMarkup: reminderListMarkup(item, context.externalSenderId) });
        return true;
    }
    const owns = (item, context) => storedPlatform(item) === contextPlatform(context) && context?.isDM === true && item.chatId === String(context.externalPeerId) && item.userId === String(context.externalSenderId);
    const editFor = context => state.edits.find(edit => owns(edit, context));
    const formatAt = at => new Date(at).toLocaleString('ru-RU', { timeZone });
    const eventLocalDate = event => {
        if (getSharedEventSchedule(event)) return null;
        const value = String(event?.eventDate || '').trim();
        const iso = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
        if (iso) return { year: Number(iso[1]), month: Number(iso[2]), day: Number(iso[3]) };
        const ru = value.match(/^(\d{1,2})[.\-/](\d{1,2})(?:[.\-/](\d{4}))?$/u);
        if (ru) return { year: Number(ru[3] || new Date(now()).toLocaleString('en-US', { timeZone, year: 'numeric' })), month: Number(ru[2]), day: Number(ru[1]) };
        return null;
    };
    const eventClock = event => parseClock(String(event?.eventTime || event?.timeLabel || '').match(/\d{1,2}(?::\d{2})?/u)?.[0]);
    const eventStartAt = event => { const day = eventLocalDate(event); const clock = eventClock(event); return day && clock ? localEpoch({ ...day, ...clock }, timeZone) : null; };
    const dateLabel = at => new Date(at).toLocaleString('ru-RU', { timeZone, day: 'numeric', month: 'long', year: 'numeric', hour: '2-digit', minute: '2-digit' });
    const eventDateLabel = event => {
        const date = eventLocalDate(event);
        if (!date) return String(event?.eventDate || 'дата не указана');
        return new Intl.DateTimeFormat('ru-RU', { timeZone, day: 'numeric', month: 'long', year: 'numeric' }).format(new Date(localEpoch({ ...date, hour: 12 }, timeZone)));
    };
    const groupReminderOptions = event => {
        const date = eventLocalDate(event);
        if (!date) return [];
        const definitions = [
            { label: 'В 09:00', hours: [9] },
            { label: 'В 12:00', hours: [12] },
            { label: 'В 09:00 и 12:00', hours: [9, 12] },
            { label: 'В 12:00 и 14:00', hours: [12, 14] },
            { label: 'В 10:00, 13:00 и 15:00', hours: [10, 13, 15] },
        ];
        return definitions.map(definition => ({
            label: definition.label,
            times: definition.hours.map(hour => localEpoch({ ...date, hour, minute: 0 }, timeZone)),
            rule: { kind: 'group-event-day-fixed-times', hours: definition.hours },
        }));
    };
    const groupReminderDetails = session => [
        '🎸 ' + session.eventTitle,
        '📅 ' + eventDateLabel({ eventDate: session.eventDate }),
        session.eventTime ? '🕒 Начало: ' + session.eventTime : '',
        session.eventVenue ? '📍 ' + session.eventVenue : '',
    ].filter(Boolean).join('\n');
    const groupReminderMarkup = session => ({ inline_keyboard: [
        ...session.options.map((option, index) => [{ text: option.label, callback_data: 'evgrouprem:choose:' + session.id + ':' + index }]),
    ] });
    const groupReminderKeyboard = session => {
        if (session.platform !== 'vk') return groupReminderMarkup(session);
        return JSON.stringify({ inline: true, buttons: [
            ...session.options.map((option, index) => ({ label: option.label, data: 'evgrouprem:choose:' + session.id + ':' + index })),
        ].map(({ label, data }) => [{ action: { type: 'callback', label: String(label).slice(0, 40), payload: JSON.stringify({ action: 'event_reminder_session', data }) } }]) });
    };
    const groupReminderConfirmation = (session, times) => [
        '✅ Я напомню о событии:',
        groupReminderDetails(session),
        '',
        'Напоминания придут в этот чат ' + times.map(at => new Intl.DateTimeFormat('ru-RU', { timeZone, hour: '2-digit', minute: '2-digit' }).format(new Date(at))).join(' и ') + '.',
    ].join('\n');
    const makeEventOptions = event => {
        const day = eventLocalDate(event); if (!day) return [];
        const start = eventStartAt(event); const dayBefore = baseDate(new Date(localEpoch({ ...day, hour: 12, minute: 0 }, timeZone)), -1, timeZone);
        const candidates = [];
        const add = (label, at, rule) => { if (at > now() && (!start || at < start) && !candidates.some(item => item.at === at)) candidates.push({ label, at, rule }); };
        const prev1900 = localEpoch({ ...dayBefore, hour: 19, minute: 0 }, timeZone);
        const prev1500 = localEpoch({ ...dayBefore, hour: 15, minute: 0 }, timeZone);
        add('Накануне в 19:00', prev1900, { kind: 'previous-day', hour: 19, minute: 0 });
        add('Накануне в 15:00', prev1500, { kind: 'previous-day', hour: 15, minute: 0 });
        if (start) {
            const clock = eventClock(event);
            const relativeHours = clock.hour < 9 ? null : clock.hour <= 13 ? 2 : 3;
            const eight = localEpoch({ ...day, hour: 8, minute: 0 }, timeZone);
            const relativeAt = relativeHours === null ? prev1900 : Math.max(start - relativeHours * 3_600_000, eight);
            const actualHours = (start - relativeAt) / 3_600_000;
            const relativeLabel = relativeHours === null ? 'Основное: накануне в 19:00' : actualHours < relativeHours ? 'В день события в 08:00' : 'За ' + relativeHours + ' ч. до начала';
            add(relativeLabel, relativeAt, { kind: 'before-start', hours: relativeHours, fallback: relativeHours === null ? 'previous-day-1900' : 'event-day-0800' });
            const noon = localEpoch({ ...day, hour: 12, minute: 0 }, timeZone);
            const eventDayAt = clock.hour < 9 ? localEpoch({ ...dayBefore, hour: 19, minute: 30 }, timeZone)
                : noon < start ? Math.max(start - 2 * 3_600_000, eight) : noon;
            add('В день события в ' + dateLabel(eventDayAt).split(' в ').pop(), eventDayAt, { kind: 'event-day', hour: eventDayAt === noon ? 12 : 8, minute: 0 });
            const combinedPrevious = localEpoch({ ...dayBefore, hour: 15, minute: 0 }, timeZone);
            const combinedEvent = localEpoch({ ...day, hour: 14, minute: 0 }, timeZone);
            if (combinedPrevious > now() && combinedPrevious < start && combinedEvent > now() && combinedEvent < start) {
                candidates.push({ label: 'Дважды: накануне в 15:00 и в день события в 14:00', at: combinedPrevious,
                    times: [combinedPrevious, combinedEvent], rule: { kind: 'combined-event-day', explicit: false } });
            }
        } else {
            const pool = Array.from({ length: 27 }, (_, index) => ({ hour: 9 + Math.floor(index / 2), minute: index % 2 ? 30 : 0 })).filter(value => value.hour <= 22);
            for (let i = pool.length - 1; i > 0; i -= 1) { const j = Math.floor(random() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
            const first = pool[0] || { hour: 19, minute: 0 }; const second = pool[1] || { hour: 15, minute: 0 };
            add('Накануне в ' + String(first.hour).padStart(2, '0') + ':' + String(first.minute).padStart(2, '0'), localEpoch({ ...dayBefore, ...first }, timeZone), { kind: 'previous-day-random', ...first });
            add('Накануне в ' + String(second.hour).padStart(2, '0') + ':' + String(second.minute).padStart(2, '0'), localEpoch({ ...dayBefore, ...second }, timeZone), { kind: 'previous-day-random', ...second });
            const third = pool[2] || { hour: 12, minute: 0 }; const fourth = pool[3] || { hour: 20, minute: 0 };
            add('Накануне в ' + String(third.hour).padStart(2, '0') + ':' + String(third.minute).padStart(2, '0'), localEpoch({ ...dayBefore, ...third }, timeZone), { kind: 'previous-day-random', ...third });
            add('Накануне в ' + String(fourth.hour).padStart(2, '0') + ':' + String(fourth.minute).padStart(2, '0'), localEpoch({ ...dayBefore, ...fourth }, timeZone), { kind: 'previous-day-random', ...fourth });
            const eventDayAt = localEpoch({ ...day, hour: 12, minute: 0 }, timeZone);
            if (prev1500 > now() && eventDayAt > now()) candidates.push({ label: 'Дважды: накануне в 15:00 и в день события в 12:00', at: prev1500,
                times: [prev1500, eventDayAt], rule: { kind: 'combined-event-day', explicit: false } });
        }
        return candidates.slice(0, 5);
    };
    const eventMarkup = session => ({ inline_keyboard: [
        ...session.options.map((option, index) => [{ text: option.label, callback_data: 'evrem:choose:' + session.id + ':' + index }]),
        [{ text: '⬅️ Назад', callback_data: 'evrem:back:' + session.id }],
    ] });
    const eventKeyboard = session => {
        if (session.platform !== 'vk') return eventMarkup(session);
        const buttons = [
            ...session.options.map((option, index) => ({ label: option.label, data: 'evrem:choose:' + session.id + ':' + index })),
            { label: '⬅️ Назад', data: 'evrem:back:' + session.id },
        ].map(({ label, data }) => [{ action: { type: 'callback', label: String(label).slice(0, 40), payload: JSON.stringify({ action: 'event_reminder_session', data }) } }]);
        return JSON.stringify({ inline: true, buttons });
    };
    const eventConfirmationKeyboard = session => {
        if (session.platform !== 'vk') return { inline_keyboard: [
            [{ text: '✅ Подтвердить', callback_data: 'evrem:confirm:' + session.id + ':' + session.revision }],
            [{ text: '❌ Отказаться', callback_data: 'evrem:reject:' + session.id + ':' + session.revision }],
            [{ text: '⬅️ Назад', callback_data: 'evrem:back:' + session.id }],
        ] };
        return JSON.stringify({ inline: true, buttons: [
            ['✅ Подтвердить', 'confirm'], ['❌ Отказаться', 'reject'], ['⬅️ Назад', 'back'],
        ].map(([label, action]) => [{ action: { type: 'callback', label, payload: JSON.stringify({ action: 'event_reminder_session', data: 'evrem:' + action + ':' + session.id + (action === 'back' ? '' : ':' + session.revision) }) } }]) });
    };
    const contextPlatform = context => String(context?.platform || (context?.telegramChatType ? 'telegram' : 'vk'));
    const storedPlatform = item => String(item?.platform || 'telegram');
    const contextUserId = context => String(context?.externalSenderId ?? context?.userId ?? context?.senderId ?? '');
    const contextPeerId = context => String(context?.externalPeerId ?? context?.peerId ?? '');
    const eventSessionFor = context => state.eventSessions.find(item => item.userId === contextUserId(context)
        && item.kind !== 'group-event-reminder'
        && storedPlatform(item) === contextPlatform(context)
        && String(item.sessionChatId || item.chatId) === contextPeerId(context));
    const samePersonalEventReminder = (item, session) => item.active && item.eventReminder && !item.groupEventReminder
        && item.eventKey === session.sourceType + ':' + session.eventId && item.userId === session.userId
        && storedPlatform(item) === storedPlatform(session)
        && (storedPlatform(session) === 'telegram' || (String(item.endpointKey || '') === String(session.endpointKey || '') && item.chatId === session.chatId));
    async function beginEventReminder(context, event, delivery = {}) {
        if (context?.platform === 'telegram' && !context?.isDM) {
            await context.send('Персональное напоминание можно настроить в личном чате с ботом.');
            return true;
        }
        const sourceType = String(event?.sourceType || '').toLowerCase(); const eventId = Number(event?.id);
        const userId = String(context.externalSenderId || ''); const chatId = String(context.externalPeerId || '');
        const options = makeEventOptions(event);
        if (!sourceType || !Number.isSafeInteger(eventId) || !options.length || !userId || !chatId) { await context.send('Для этого события не осталось корректных будущих вариантов напоминания.'); return true; }
        const session = {
            id: randomUUID(), userId, sessionChatId: chatId,
            chatId: String(delivery.chatId ?? context.eventDelivery?.chatId ?? chatId),
            peerId: String(delivery.peerId ?? context.eventDelivery?.peerId ?? context.peerId ?? chatId),
            platform: String(delivery.platform ?? context.eventDelivery?.platform ?? context.platform ?? 'telegram'),
            endpointKey: String(delivery.endpointKey ?? context.eventDelivery?.endpointKey ?? context.endpointKey ?? ''),
            deliveryTarget: delivery.deliveryTarget || context.eventDelivery?.deliveryTarget || context.deliveryTarget || (context.isDM ? 'dm' : 'chat'),
            threadId: Number(delivery.threadId ?? context.eventDelivery?.threadId ?? context.threadId ?? 0) || 0,
            username: String(delivery.username ?? context.eventDelivery?.username ?? context.externalSenderUsername ?? context.username ?? ''),
            displayName: String(delivery.displayName ?? context.eventDelivery?.displayName ?? context.externalSenderName ?? context.displayName ?? ''),
            eventId, sourceType, eventTitle: String(event.title || event.participants || 'Событие'),
            eventDate: String(event.eventDate || ''), eventTime: String(event.eventTime || ''), options,
            state: 'SELECTING', createdAt: now(), expiresAt: now() + 30 * 60_000, revision: 1, pending: null,
        };
        state.eventSessions = state.eventSessions.filter(item => item.userId !== userId
            || storedPlatform(item) !== session.platform
            || (session.platform === 'vk' && String(item.sessionChatId || item.chatId) !== chatId));
        state.eventSessions.push(session); persist();
        try {
            await context.send({ message: [String(event.cardText || ''), '', 'Когда напомнить вам об этом событии?'].filter(Boolean).join('\n'), ...(session.platform === 'vk' ? { keyboard: eventKeyboard(session) } : { replyMarkup: eventKeyboard(session) }) });
            if (session.platform === 'telegram') {
                const examples = [
                    'Примеры команд:',
                    'напомни за день в 19:00',
                    'напомни накануне в 15:00',
                    'напомни накануне в 19:30',
                    'напомни за 2 дня в 12:00',
                    'напомни за 2 дня в 19:00',
                    'напомни за 3 дня в 18:00',
                    'напомни в день события в 08:00',
                    'напомни в день события в 09:00',
                    'напомни в день события в 10:00',
                    'напомни в день события в 12:00',
                    'напомни в день события в 14:00',
                    'напомни в день события в 17:00',
                    'напомни за 2 часа',
                    'напомни за 3 часа',
                    'напомни за 2 часа и за 30 минут',
                    'напомни 24 октября в 12:00',
                    'напомни 24.10 в 12:00',
                    'напомни завтра в 10:00',
                    'напомни послезавтра в 18:30',
                    'напомни за день в 15:00 и в день события в 14:00',
                    'напомни накануне в 19:00 и в день события в 12:00',
                    'напомни в день события в 09:00 и в 12:00',
                    'напомни в день события в 10:00, 13:00 и 15:00',
                    'напомни за 2 дня в 19:00 и за день в 19:00',
                    'напомни за 2 дня в 12:00, за день в 18:00 и в день события в 10:00',
                    'напомни за 3 дня в 20:00 и за 2 часа',
                    'напомни за 24 часа',
                    'напомни за 12 часов',
                    'напомни за 6 часов',
                    'напомни за 90 минут',
                    'напомни за 60 минут',
                    'напомни за 30 минут',
                    'напомни за 15 минут',
                    'напомни в день события в 07:00',
                    'напомни в день события в 08:30',
                    'напомни в день события в 11:00',
                    'напомни в день события в 13:00',
                    'напомни в день события в 15:00',
                    'напомни в день события в 18:00',
                    'напомни в день события в 20:00',
                    'напомни завтра утром',
                    'напомни завтра вечером',
                    'напомни в понедельник в 10:00',
                    'напомни 25 октября 2026 в 10:00',
                    'напомни 25.10.2026 в 10:00',
                    'напомни 25/10 в 10:00',
                    'напомни за день в 09:00, 12:00 и 18:00',
                    'напомни за 3 часа и за 1 час',
                    'напомни за 2 часа и в день события в 09:00',
                    'напомни за день в 19:00 и за 2 часа',
                    'напомни накануне в 15:00, накануне в 19:00 и в день события в 12:00',
                    'напомни за день в 19:00, в день события в 09:00 и за 2 часа',
                    'напомни в день события в 09:00, 12:00, 14:00 и 16:00',
                    'напомни за день в 18:00 и в день события в 10:00, 13:00 и 15:00',
                    'напомни за 2 дня в 18:00, за день в 18:00 и в день события в 09:00',
                    'напомни за день в 19:00 и за 3 часа до начала',
                    'напомни за 2 часа до начала и за 30 минут до начала',
                    'напомни за день вечером и в день события утром',
                    'напомни дважды: за день в 19:00 и в день события в 12:00',
                    'напомни трижды: за 2 дня в 19:00, за день в 19:00 и в день события в 10:00',
                    '',
                    'Можно написать свой вариант в таком же формате. Выбери кнопку выше или отправь команду сообщением.',
                ];
                await context.send({ message: examples.join('\n'), replyMarkup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'evrem:back:' + session.id }]] } });
            }
        } catch (error) {
            state.eventSessions = state.eventSessions.filter(item => item !== session); persist();
            throw error;
        }
        return true;
    }
    const repliedGroupEventReplyKeyboard = session => JSON.stringify({ inline: true, buttons: [
        [{ action: { type: 'callback', label: '✅ Подтвердить', payload: JSON.stringify({ action: 'event_reminder_session', data: 'evgrouprem:replyconfirm:' + session.id }) } }],
        [{ action: { type: 'callback', label: '❌ Отмена', payload: JSON.stringify({ action: 'event_reminder_session', data: 'evgrouprem:replycancel:' + session.id }) } }],
    ] });
    async function beginRepliedGroupEventReminder(context, event, request, delivery = {}) {
        if (context.platform !== 'vk' || context.isDM) return false;
        if (await denyNonOwnerGroup(context)) return true;
        if (!request?.valid) { await context.send(request?.error || 'Не понял расписание.'); return true; }
        if (request.personal) { await context.send('Ответом в беседе можно настроить напоминание всем. Для личного напоминания используй кнопку «Попросить напомнить» на карточке.'); return true; }
        const date = eventLocalDate(event);
        const startsAt = eventStartAt(event);
        if (!date || !startsAt || startsAt <= now()) { await context.send('У этой карточки нет будущей даты и времени начала события. Напоминание не установлено.'); return true; }
        const parsed = parseReminderCommand(request.command + ' напоминание о событии', { now: new Date(now()), timeZone, random });
        if (parsed?.type !== 'create' || !parsed.times?.length || !['once','daily','weekly','monthly','yearly'].includes(parsed.cadence)) {
            await context.send('Не смог разобрать расписание. Ответь на карточку, например: «напоминай всем каждый день 2 раза в день с 10:00 до 18:00 до начала».');
            return true;
        }
        const eventSourceType = String(event.sourceType || '').toLowerCase();
        const eventId = Number(event.id);
        const eventKey = eventSourceType + ':' + eventId;
        if (!eventSourceType || !Number.isSafeInteger(eventId) || eventId <= 0) return false;
        let times = parsed.times.filter(at => at > now() && at < startsAt);
        if (!times.length && parsed.schedule && parsed.cadence !== 'once') {
            const next = nextCycle(parsed.schedule, parsed.schedule.anchorDay || datePartsAt(now(), timeZone), now(), random);
            times = (next?.times || []).filter(at => at > now() && at < startsAt);
        }
        if (!times.length) { await context.send('До начала события уже нет подходящих будущих срабатываний. Укажи более раннее время.'); return true; }
        const peerId=String(delivery.peerId || context.peerId || context.externalPeerId);
        const chatId=String(delivery.chatId || context.externalPeerId || context.peerId);
        const endpointKey=String(delivery.endpointKey || context.endpointKey || 'vk:primary');
        const existing=state.reminders.find(x=>x.active && x.groupEventReminder && x.eventKey === eventKey &&
            storedPlatform(x)==='vk' && x.chatId===chatId && x.endpointKey===endpointKey);
        const dayCount=Number(parsed.schedule?.dailyCountPerDay || 0);
        const window=parsed.schedule?.windowStart && parsed.schedule?.windowEnd
            ? ' c ' + String(parsed.schedule.windowStart.hour).padStart(2,'0') + ':' + String(parsed.schedule.windowStart.minute).padStart(2,'0')
                + ' до ' + String(parsed.schedule.windowEnd.hour).padStart(2,'0') + ':' + String(parsed.schedule.windowEnd.minute).padStart(2,'0') : '';
        const session={
            id:randomUUID(), kind:'group-event-reply', userId:String(context.externalSenderId),
            sessionChatId:String(context.externalPeerId), chatId, peerId, endpointKey, platform:'vk',
            eventKey,eventSourceType,eventId,eventTitle:String(event.title || event.participants || 'Событие'),
            eventDate:String(event.eventDate || ''),eventTime:String(event.eventTime || ''),eventVenue:String(event.venue || ''),
            eventUrl:String(event.sourceUrl || ''), startAt:startsAt, cadence:parsed.cadence,
            schedule:parsed.schedule || null, times, remaining:parsed.count,
            cycleDay:datePartsAt(times[0],timeZone),
            expiresAt:now()+15*60_000, createdAt:now(),
        };
        state.eventSessions=state.eventSessions.filter(x=>!(x.kind==='group-event-reply' && x.userId===session.userId && x.sessionChatId===session.sessionChatId));
        state.eventSessions.push(session);persist();
        const cadence=parsed.cadence === 'daily' ? ('Каждый день' + (dayCount ? ', ' + dayCount + ' раза в день' : '') + window)
            : parsed.cadence === 'once' ? 'Разовое расписание' : 'Повтор: ' + parsed.cadence;
        await context.send({message:[
            '🔔 Подтверди напоминание именно об этой тусе:',
            '🎸 ' + session.eventTitle,
            '📅 ' + eventDateLabel(event) + ' в ' + session.eventTime,
            '📍 ' + session.eventVenue,
            'В эту беседу, для всех.',
            'Расписание: ' + cadence + '.',
            'Первые отправки: ' + times.slice(0,4).map(dateLabel).join('; '),
            'Автоматическая остановка: ' + dateLabel(startsAt) + ' (начало события).',
            existing ? 'В этой беседе уже есть напоминание об этой тусе: после подтверждения оно будет заменено.' : '',
            'Ничего не включено до нажатия «Подтвердить».',
        ].filter(Boolean).join('\n'),keyboard:repliedGroupEventReplyKeyboard(session)});
        return true;
    }
    async function handleRepliedGroupEventReminderCallback(context,data) {
        const match=String(data||'').match(/^evgrouprem:reply(confirm|cancel):([a-f0-9-]{36})$/iu);
        if(!match)return false;
        await context.answerCallbackQuery?.().catch(()=>{});
        const session=state.eventSessions.find(x=>x.id===match[2] && x.kind==='group-event-reply' &&
            x.userId===String(context.externalSenderId) && x.sessionChatId===String(context.externalPeerId) && storedPlatform(x)==='vk');
        if(!session || session.expiresAt<=now()){await context.send('Подтверждение устарело или относится другому участнику. Ответь на карточку ещё раз.');return true;}
        if(match[1]==='cancel'){state.eventSessions=state.eventSessions.filter(x=>x!==session);persist();await context.send('Настройка напоминания отменена.');return true;}
        const fresh=typeof resolveEvent==='function' ? await resolveEvent(session.eventSourceType,session.eventId):null;
        if(!fresh || String(fresh.eventDate||'')!==session.eventDate || String(fresh.eventTime||'')!==session.eventTime || now()>=session.startAt){
            state.eventSessions=state.eventSessions.filter(x=>x!==session);persist();
            await context.send('Дата или время события изменились либо оно уже началось. Ответь на актуальную карточку заново.');return true;
        }
        const times=session.times.filter(at=>at>now() && at<session.startAt);
        if(!times.length){state.eventSessions=state.eventSessions.filter(x=>x!==session);persist();await context.send('Время выбранных отправок уже прошло. Ответь на карточку ещё раз.');return true;}
        const old=state.reminders.filter(x=>x.active && x.groupEventReminder && x.eventKey===session.eventKey &&
            storedPlatform(x)==='vk' && x.chatId===session.chatId && x.endpointKey===session.endpointKey);
        for(const item of old){item.active=false;item.cancelledAt=now();item.cancelReason='replaced-from-card-reply';}
        const item={
            id:'event-group-reply-'+randomUUID(), kind:'user', eventReminder:true,groupEventReminder:true,
            eventKey:session.eventKey,eventSourceType:session.eventSourceType,eventId:session.eventId,
            eventVersion:session.eventDate+'T'+session.eventTime,creatorUserId:session.userId,
            platform:'vk',endpointKey:session.endpointKey,chatId:session.chatId,userId:session.userId,peerId:session.peerId,
            deliveryTarget:'chat',threadId:0,eventTitle:String(fresh.title||fresh.participants||session.eventTitle),
            text:'Событие: '+String(fresh.title||fresh.participants||session.eventTitle),
            eventUrl:String(fresh.sourceUrl||session.eventUrl),eventVenue:String(fresh.venue||session.eventVenue),
            eventDate:session.eventDate,eventTime:session.eventTime,eventDeadlineAt:session.startAt,
            times,nextAt:times[0],remaining:session.cadence==='once'?times.length:null,
            cadence:session.cadence,schedule:session.schedule,cycleDay:session.cycleDay,
            active:true,awaitingAck:false,pendingMessageIds:[],lastMessageId:null,timeZone,
            eventRule:{kind:'group-event-reply',explicit:true},revision:1,createdAt:now(),nextEventCheckAt:now()+60*60_000,
        };
        state.reminders.push(item);state.eventSessions=state.eventSessions.filter(x=>x!==session);persist();
        await context.send('✅ Напоминание об «'+item.eventTitle+'» включено для всей беседы. Следующее: '+dateLabel(item.nextAt)+'. До начала события: '+dateLabel(item.eventDeadlineAt)+'.'+(old.length?' Предыдущее расписание заменено.':''));
        return true;
    }
    function vkForwardKeyboard(identifier, mode='confirm') {
        const btn=(label,data)=>[{action:{type:'callback',label,payload:JSON.stringify({action:'event_reminder_session',data})}}];
        const buttons=mode==='stop'
            ?[btn('🛑 Отменить навсегда','evgrouprem:msgstop:'+identifier)]
            :[btn('✅ Подтвердить','evgrouprem:msgconfirm:'+identifier),btn('❌ Отмена','evgrouprem:msgcancel:'+identifier)];
        return JSON.stringify({inline:true,buttons});
    }
    async function beginVkForwardReminder(context,source,request,delivery={}) {
        if(context.platform!=='vk'||!context.isChat)return false;
        if(await denyNonOwnerGroup(context))return true;
        if(!request?.valid){await context.send(request?.error||'Укажи расписание.');return true;}
        const chatId=String(delivery.peerId||context.peerId||context.externalPeerId);
        const cmid=Number(source.cmid||0),messageId=Number(source.messageId||0);
        if(Number(chatId)<2000000000||Number(source.peerId)!==Number(chatId)||(cmid<=0&&messageId<=0)){
            await context.send('Не удалось привязаться к точному исходному сообщению в беседе.');return true;
        }
        const parsed=parseReminderCommand(request.command,{now:new Date(now()),timeZone,random});
        if(parsed?.type!=='create'||parsed.target!=='self'||!parsed.times?.length||
            parsed.times.some(at=>at<=now())||!['once','daily','weekly','monthly','yearly','interval'].includes(parsed.cadence)){
            await context.send('Не понял расписание. Примеры: «Гигорейв, напомни это сообщение завтра в 12:00», «Гигорейв, напоминай это сообщение каждый день 2 раза с 10:00 до 18:00».');
            return true;
        }
        const userId=String(context.externalSenderId||''),endpointKey=String(delivery.endpointKey||'vk:primary');
        const own=state.reminders.filter(x=>x.active&&x.deliveryKind==='vk-forward'&&x.chatId===chatId&&x.creatorUserId===userId);
        if(own.length>=20&&!own.some(x=>Number(x.sourceCmid||0)===cmid&&Number(x.sourceMessageId||0)===messageId)){
            await context.send('У тебя уже 20 активных пересылок в этой беседе. Отмени одну перед добавлением новой.');return true;
        }
        const session={id:randomUUID(),kind:'vk-forward-reply',platform:'vk',chatId,sessionChatId:chatId,peerId:chatId,
            endpointKey,userId,sourcePeerId:Number(source.peerId),sourceCmid:cmid,sourceMessageId:messageId,
            preview:String(source.text||'📎 Сообщение с вложением').slice(0,220),
            times:parsed.times.slice(),remaining:parsed.count,cadence:parsed.cadence,schedule:parsed.schedule||null,
            intervalMs:parsed.intervalMs||null,cycleDay:parsed.schedule?.anchorDay||datePartsAt(parsed.times[0],timeZone),
            expiresAt:now()+15*60_000};
        state.eventSessions=state.eventSessions.filter(x=>!(x.kind==='vk-forward-reply'&&x.userId===userId&&x.chatId===chatId));
        state.eventSessions.push(session);persist();
        const rate=parsed.cadence==='daily'?'ежедневно'+(parsed.schedule?.dailyCountPerDay?', '+parsed.schedule.dailyCountPerDay+' раза в день':''):parsed.cadence==='once'?'один раз':parsed.cadence;
        await context.send({message:[
            '🔔 Подтвердить ПЕРЕСЫЛКУ этого сообщения:',
            '«'+session.preview+'»','Куда: в эту же беседу.','Расписание: '+rate+'.',
            'Первая пересылка: '+dateLabel(parsed.times[0])+'.',
            'Бот перешлёт оригинал с его вложениями, а не ответит цитатой.',
            'Ничего не включено до подтверждения.'
        ].join('\n'),keyboard:vkForwardKeyboard(session.id)});
        return true;
    }
    async function handleVkForwardReminderCallback(context,data) {
        const match=String(data||'').match(/^evgrouprem:msg(confirm|cancel|stop):([a-f0-9-]{36})$/iu);
        if(!match)return false;
        await context.answerCallbackQuery?.().catch(()=>{});
        const actor=String(context.externalSenderId||''),chatId=String(context.externalPeerId||'');
        if(match[1]==='stop'){
            const item=state.reminders.find(x=>x.id==='vk-forward-'+match[2]&&x.deliveryKind==='vk-forward'&&x.active&&x.chatId===chatId&&x.creatorUserId===actor);
            if(!item){await context.send('Напоминание уже отменено или отменить его может только автор.');return true;}
            item.active=false;item.cancelledAt=now();item.deletedAt=now();persist();
            await context.send('✅ Пересылка навсегда отменена.');return true;
        }
        const session=state.eventSessions.find(x=>x.kind==='vk-forward-reply'&&x.id===match[2]&&x.userId===actor&&x.chatId===chatId);
        if(!session||session.expiresAt<=now()){await context.send('Подтверждение недоступно. Ответь на сообщение заново.');return true;}
        if(match[1]==='cancel'){
            state.eventSessions=state.eventSessions.filter(x=>x!==session);persist();
            await context.send('Настройка пересылки отменена.');return true;
        }
        const times=session.times.filter(at=>at>now());
        if(!times.length){
            state.eventSessions=state.eventSessions.filter(x=>x!==session);persist();
            await context.send('Время первой пересылки прошло. Настрой напоминание заново.');return true;
        }
        const same=x=>x.active&&x.deliveryKind==='vk-forward'&&x.chatId===chatId&&x.creatorUserId===actor&&
            x.endpointKey===session.endpointKey&&Number(x.sourcePeerId)===session.sourcePeerId&&
            Number(x.sourceCmid||0)===session.sourceCmid&&Number(x.sourceMessageId||0)===session.sourceMessageId;
        const duplicates=state.reminders.filter(same);
        for(const x of duplicates){x.active=false;x.cancelledAt=now();x.cancelReason='replaced';}
        const item={id:'vk-forward-'+randomUUID(),kind:'user',deliveryKind:'vk-forward',platform:'vk',
            chatId,peerId:chatId,userId:actor,creatorUserId:actor,endpointKey:session.endpointKey,
            sourcePeerId:session.sourcePeerId,sourceCmid:session.sourceCmid,sourceMessageId:session.sourceMessageId,
            text:'Переслать сообщение: '+session.preview,deliveryTarget:'chat',times,nextAt:times[0],
            remaining:session.cadence==='once'?times.length:session.remaining,cadence:session.cadence,
            schedule:session.schedule,intervalMs:session.intervalMs,cycleDay:session.cycleDay,
            active:true,awaitingAck:false,pendingMessageIds:[],lastMessageId:null,timeZone,revision:1,createdAt:now()};
        state.reminders.push(item);state.eventSessions=state.eventSessions.filter(x=>x!==session);persist();
        await context.send('✅ Пересылка включена. Первая: '+dateLabel(item.nextAt)+'.'+(duplicates.length?' Старое расписание заменено.':''));
        return true;
    }
    async function handleGroupEventReminder(context, event, delivery = {}) {
        if (String(context?.platform || delivery.platform || '').toLowerCase() !== 'vk') return false;
        if(await denyNonOwnerGroup(context))return true;
        const sourceType = String(event?.sourceType || '').toLowerCase();
        const eventId = Number(event?.id);
        const userId = String(context.externalSenderId || '');
        const chatId = String(delivery.chatId ?? context.eventDelivery?.chatId ?? context.externalPeerId ?? '');
        const platform = String(delivery.platform ?? context.eventDelivery?.platform ?? context.platform ?? '');
        const endpointKey = String(delivery.endpointKey ?? context.eventDelivery?.endpointKey ?? context.endpointKey ?? '');
        const peerId = String(delivery.peerId ?? context.eventDelivery?.peerId ?? context.peerId ?? chatId);
        const date = eventLocalDate(event);
        if (!sourceType || !Number.isSafeInteger(eventId) || !userId || !chatId || !date || !['telegram', 'vk'].includes(platform)) {
            await context.send('Для этого события нельзя установить напоминание в исходном чате.');
            return true;
        }
        if (context.isDM) {
            await context.send('Общее напоминание доступно только в беседе. Нажми эту кнопку в беседе с карточкой события.');
            return true;
        }
        const startsAt = eventStartAt(event);
        const eventKey = sourceType + ':' + eventId;
        const existing = state.reminders.find(item => item.active && item.eventReminder && item.groupEventReminder
            && item.eventKey === eventKey && item.platform === platform && item.endpointKey === endpointKey && item.chatId === chatId);
        if (existing) {
            await context.send('✅ Напоминание для всех уже настроено в этом чате: ' + groupReminderConfirmation({
                eventTitle: existing.eventTitle, eventDate: existing.eventDate, eventTime: existing.eventTime, eventVenue: existing.eventVenue,
            }, existing.times || [existing.nextAt]));
            return true;
        }
        const currentEvent = typeof resolveEvent === 'function' ? await resolveEvent(sourceType, eventId) : event;
        if (!currentEvent || String(currentEvent.eventDate || '') !== String(event.eventDate || '')
            || String(currentEvent.eventTime || '') !== String(event.eventTime || '')) {
            await context.send('Событие изменилось. Открой актуальную карточку и нажми кнопку ещё раз.');
            return true;
        }
        const options = groupReminderOptions(currentEvent).filter(option =>
            option.times.length > 0 && option.times.every(at => at > now() && (!startsAt || at < startsAt)));
        if (!options.length) {
            await context.send('Для этого события уже не осталось времени сегодня, когда можно напомнить до начала.');
            return true;
        }
        const session = {
            id: randomUUID(), kind: 'group-event-reminder', userId, sessionChatId: String(context.externalPeerId || chatId),
            chatId, peerId, platform, endpointKey, deliveryTarget: 'chat',
            threadId: Number(delivery.threadId ?? context.eventDelivery?.threadId ?? context.telegramMessageThreadId ?? context.threadId ?? 0) || 0,
            eventKey, eventSourceType: sourceType, eventId, eventTitle: String(currentEvent.title || currentEvent.participants || 'Событие'),
            eventDate: String(currentEvent.eventDate || ''), eventTime: String(currentEvent.eventTime || ''), eventVenue: String(currentEvent.venue || ''),
            eventUrl: String(currentEvent.sourceUrl || currentEvent.url || ''), options,
            expiresAt: now() + 30 * 60_000, createdAt: now(),
        };
        state.eventSessions = state.eventSessions.filter(item => !(item.kind === 'group-event-reminder' && item.userId === userId
            && item.platform === platform && String(item.sessionChatId || item.chatId) === session.sessionChatId));
        state.eventSessions.push(session);
        persist();
        const message = ['Я напомню в этой беседе и пришлю карточку события:', groupReminderDetails(session), '', 'Выбери время напоминания в день события:'].join('\n');
        try {
            await context.send({ message, ...(platform === 'vk' ? { keyboard: groupReminderKeyboard(session) } : { replyMarkup: groupReminderKeyboard(session) }) });
        } catch (error) {
            state.eventSessions = state.eventSessions.filter(item => item !== session); persist(); throw error;
        }
        return true;
    }
    async function handleGroupEventReminderCallback(context, data) {
        if(/^evgrouprem:/iu.test(String(data||'')) && await denyNonOwnerGroup(context))return true;
        if (/^evgrouprem:reply(?:confirm|cancel):/iu.test(data)) return handleRepliedGroupEventReminderCallback(context, data);
        if (/^evgrouprem:msg(?:confirm|cancel|stop):/iu.test(data)) return handleVkForwardReminderCallback(context, data);
        const match = String(data || '').match(/^evgrouprem:choose:([a-f0-9-]{36}):(\d+)$/iu);
        if (!match) return false;
        await context.answerCallbackQuery?.().catch(() => {});
        const session = state.eventSessions.find(item => item.id === match[1] && item.kind === 'group-event-reminder'
            && item.userId === String(context.externalSenderId || '') && storedPlatform(item) === contextPlatform(context)
            && String(item.sessionChatId || item.chatId) === String(context.externalPeerId || ''));
        if (!session || Number(session.expiresAt) <= now()) {
            if (session) { state.eventSessions = state.eventSessions.filter(item => item !== session); persist(); }
            await context.send('Этот выбор уже неактуален. Нажми кнопку напоминания на карточке события ещё раз.');
            return true;
        }
        const option = session.options[Number(match[2])];
        if (!option) { await context.send('Не удалось определить время. Открой настройку заново по кнопке на карточке.'); return true; }
        const currentEvent = typeof resolveEvent === 'function'
            ? await resolveEvent(session.eventSourceType, session.eventId)
            : { eventDate: session.eventDate, eventTime: session.eventTime };
        if (!currentEvent || String(currentEvent.eventDate || '') !== session.eventDate || String(currentEvent.eventTime || '') !== session.eventTime) {
            state.eventSessions = state.eventSessions.filter(item => item !== session); persist();
            await context.send('Событие изменилось. Открой актуальную карточку и выбери время напоминания заново.');
            return true;
        }
        const startsAt = eventStartAt(currentEvent);
        if (option.times.some(at => at <= now() || (startsAt && at >= startsAt))) {
            await context.send('Этот вариант уже нельзя выполнить полностью до начала события. Выбери другое время или настрой напоминание заранее.');
            return true;
        }
        const existing = state.reminders.find(item => item.active && item.eventReminder && item.groupEventReminder
            && item.eventKey === session.eventKey && item.platform === session.platform
            && item.endpointKey === session.endpointKey && item.chatId === session.chatId);
        if (existing) {
            await context.send('В этом чате напоминание об этом событии уже настроено.');
            state.eventSessions = state.eventSessions.filter(item => item !== session); persist();
            return true;
        }
        const times = option.times.slice();
        const reminder = {
            id: 'event-group-rem-' + randomUUID(), kind: 'user', eventReminder: true, groupEventReminder: true,
            eventKey: session.eventKey, eventSourceType: session.eventSourceType, eventId: session.eventId,
            eventVersion: session.eventDate + 'T' + session.eventTime, creatorUserId: session.userId,
            platform: session.platform, endpointKey: session.endpointKey, chatId: session.chatId, userId: session.userId, peerId: session.peerId,
            deliveryTarget: 'chat', threadId: session.threadId, eventTitle: String(currentEvent.title || currentEvent.participants || session.eventTitle || 'Событие'),
            text: 'Событие: ' + String(currentEvent.title || currentEvent.participants || session.eventTitle || 'Событие'),
            eventUrl: String(currentEvent.sourceUrl || currentEvent.url || session.eventUrl || ''),
            eventVenue: String(currentEvent.venue || session.eventVenue || ''), eventDate: String(currentEvent.eventDate || ''), eventTime: String(currentEvent.eventTime || ''),
            times, nextAt: times[0], remaining: times.length, active: true, awaitingAck: false,
            pendingMessageIds: [], lastMessageId: null, timeZone,
            eventRule: { ...option.rule, explicit: true }, createdAt: now(), nextEventCheckAt: now() + 60 * 60_000, revision: 1,
        };
        state.reminders.push(reminder);
        state.eventSessions = state.eventSessions.filter(item => item !== session);
        persist();
        await context.send(groupReminderConfirmation({ ...session, eventTitle: reminder.eventTitle, eventVenue: reminder.eventVenue }, times));
        return true;
    }
    function parseEventReminderText(text, session) {
        const normalized = normalize(text).toLocaleLowerCase('ru-RU');
        let at = null; let label = ''; let rule = null;
        const date = eventLocalDate({ eventDate: session.eventDate });
        if (!date) return null;
        const eventStart = eventStartAt({ eventDate: session.eventDate, eventTime: session.eventTime });
        const combined = normalized.match(/за\s+день\s+в\s+(\d{1,2})(?::(\d{2}))?\s+и\s+в\s+день\s+события\s+в\s+(\d{1,2})(?::(\d{2}))?/u);
        if (combined) {
            if (!eventStart) return null;
            const previousDay = baseDate(new Date(localEpoch({ ...date, hour: 12 }, timeZone)), -1, timeZone);
            const first = localEpoch({ ...previousDay, hour: Number(combined[1]), minute: Number(combined[2] || 0) }, timeZone);
            const second = localEpoch({ ...date, hour: Number(combined[3]), minute: Number(combined[4] || 0) }, timeZone);
            if (first > now() && second > now() && (!eventStart || (first < eventStart && second < eventStart))) return { label: 'Дважды: ' + dateLabel(first) + ' и ' + dateLabel(second), at: first, times: [first, second], rule: { kind: 'combined-explicit', explicit: true } };
            return null;
        }
        const tomorrow = normalized.match(/(?:за\s+день|накануне)(?:\s+в\s+(\d{1,2})(?::(\d{2}))?)?/u);
        const sameDay = normalized.match(/(?:в\s+день\s+события|день\s+мероприятия)(?:\s+в\s+(\d{1,2})(?::(\d{2}))?)?/u);
        const hoursBefore = normalized.match(/за\s+(2|3|дв(?:а|ух)|тр(?:и|ёх))\s+час/u);
        if (/за\s+два\s+дня/u.test(normalized)) {
            const twoDaysBefore = baseDate(new Date(localEpoch({ ...date, hour: 12 }, timeZone)), -2, timeZone);
            const clock = normalized.match(/\s+в\s+(\d{1,2})(?::(\d{2}))?/u);
            const hour = Number(clock?.[1] || 19); const minute = Number(clock?.[2] || 0);
            at = localEpoch({ ...twoDaysBefore, hour, minute }, timeZone); label = 'За 2 дня в ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0'); rule = { kind: 'days-before', days: 2, hour, minute, explicit: true };
        } else if (tomorrow || sameDay) {
            if (sameDay && !eventStart) return null;
            const parsed = tomorrow || sameDay;
            const selectedDay = tomorrow ? baseDate(new Date(localEpoch({ ...date, hour: 12 }, timeZone)), -1, timeZone) : date;
            const hour = Number(parsed[1] || (tomorrow ? 19 : 12)); const minute = Number(parsed[2] || 0);
            at = localEpoch({ ...selectedDay, hour, minute }, timeZone);
            label = (tomorrow ? 'Накануне' : 'В день события') + ' в ' + String(hour).padStart(2, '0') + ':' + String(minute).padStart(2, '0');
            rule = { kind: tomorrow ? 'previous-day' : 'event-day', hour, minute, explicit: true };
        } else if (hoursBefore) {
            if (!eventStart) return null;
            const hours = Number(/^(?:дв|два)/u.test(hoursBefore[1]) ? 2 : /^(?:тр|три)/u.test(hoursBefore[1]) ? 3 : hoursBefore[1]);
            at = eventStart - hours * 3_600_000; label = 'За ' + hours + ' ч. до начала'; rule = { kind: 'before-start', hours, explicit: true };
        } else {
            const command = normalized.replace(/^(?:напомни(?:те)?|напоминай)\s*/u, '').trim();
            if (!command) return null;
            const parsed = parseReminderCommand('напомни мне ' + command + ' напоминание о событии', { now: new Date(now()), timeZone, random });
            if (parsed?.type !== 'create' || parsed.cadence !== 'once' || !parsed.times?.length) return null;
            const eventDayStart = localEpoch({ ...date, hour: 0, minute: 0 }, timeZone);
            if (parsed.times.some(value => value <= now() || (eventStart ? value >= eventStart : value >= eventDayStart))) return null;
            return { label: 'Выбранное время: ' + parsed.times.map(dateLabel).join(' и '), at: parsed.times[0], times: parsed.times, rule: { kind: 'absolute', explicit: true } };
        }
        const eventDayStart = localEpoch({ ...date, hour: 0, minute: 0 }, timeZone);
        if (!Number.isFinite(at) || at <= now() || (eventStart ? at >= eventStart : at >= eventDayStart)) return null;
        return { label, at, rule };
    }
    function discardEdit(edit) { state.edits = state.edits.filter(entry => entry !== edit); }
    const dayKey = (at, zone) => { const d = localParts(new Date(at), zone || timeZone); return `${d.year}-${d.month}-${d.day}`; };
    async function acknowledgeReminder(item, context) {
        const today = dayKey(now(), item.timeZone);
        const messageId = Number(context.callbackQuery?.message?.message_id || context.replyMessage?.conversationMessageId || 0);
        if (item.sentMessageDays?.[messageId] && item.sentMessageDays[messageId] !== today) { await context.send('Эта кнопка относится к предыдущему дню. Используй сегодняшнее напоминание.'); return; }
        if (item.lastSentAt && dayKey(item.lastSentAt, item.timeZone) !== today) { await context.send('Это напоминание за предыдущий день. Используй сегодняшнее сообщение.'); return; }
        if (item.completedDay === today) { await context.send('Сегодня уже отмечено.'); return; }
        item.completedDay = today;
        if (item.kind === 'user' && (item.remaining === null || (item.times || []).some(at => dayKey(at, item.timeZone) !== today))) {
            // Delivery has already advanced the queue; discard only today's remaining slots.
            item.times = (item.times || []).filter(at => at > now() && dayKey(at, item.timeZone) !== today);
            if (item.times.length) item.nextAt = item.times[0];
            else if (item.schedule && ['daily','weekly','monthly','yearly'].includes(item.cadence)) {
                const next = nextCycle(item.schedule, item.cycleDay || datePartsAt(now(), item.timeZone || timeZone), now(), random);
                if (next?.times?.length) { item.times = next.times; item.nextAt = next.times[0]; item.cycleDay = next.day; }
            } else if (item.cadence === 'interval') {
                const d = baseDate(new Date(now()), 1, item.timeZone || timeZone);
                const midnight = localEpoch(d, item.timeZone || timeZone);
                item.nextAt += Math.max(0, Math.ceil((midnight - item.nextAt) / item.intervalMs)) * item.intervalMs;
            }
            if (item.remaining !== null) item.remaining = item.times.length;
            item.pendingMessageIds = []; item.lastMessageId = null;
            item.revision = Number(item.revision || 0) + 1; persist();
        } else completeReminder(item);
        await context.send(item.active ? '✅ Сделано сегодня. Остальные напоминания сегодня пропущены; следующие дни сохранены.' : '✅ Выполнено.');
        if (item.creatorUserId && item.creatorUserId !== String(context.externalSenderId)) {
            await api.sendMessage({chatId:item.creatorUserId, text:'✅ Получатель отметил «Сделал(а)» сегодня:\n' + item.text}).catch(error => console.warn('[REMINDER ACK NOTICE]', error.message));
        }
    }
    async function cancelReminder(item, context) {
        const actor = String(context.externalSenderId || '');
        const creator = item.creatorUserId || item.userId;
        if (item.personalCancel && actor !== creator) {
            if (item.cancelRequest) { await context.send('Запрос на отмену уже отправлен автору.'); return; }
            item.cancelRequest = randomUUID(); persist();
            try { await api.sendMessage({chatId:creator, text:'Получатель просит отменить напоминание навсегда:\n' + item.text,
                replyMarkup:{inline_keyboard:[[{text:'Да, отменить',callback_data:'remapprove:' + item.cancelRequest}],[{text:'Нет, оставить',callback_data:'remdeny:' + item.cancelRequest}]]}}); }
            catch (error) { item.cancelRequest = null; persist(); await context.send('Не удалось отправить запрос автору. Напоминание сохранено; попробуй ещё раз.'); return; }
            await context.send('Запрос отправлен автору. До его решения расписание действует.'); return;
        }
        item.active = false; item.cancelRequest = null; item.pendingMessageIds = [];
        item.revision = Number(item.revision || 0) + 1; item.cancelledAt = now(); item.deletedAt = now(); item.deletedBy = actor; persist();
        await context.send('✅ Напоминание отменено навсегда.');
        const noticeChat = actor === creator ? item.chatId : creator;
        if (noticeChat !== String(context.externalPeerId)) await api.sendMessage({chatId:noticeChat, text:'ℹ️ Напоминание удалено другим пользователем:\n' + item.text}).catch(error => console.warn('[REMINDER CANCEL NOTICE]', error.message));
    }
    function completeReminder(item) {
        if (item.kind === 'milana-weekly') {
            item.awaitingAck = false;
            const due = Number(item.weeklyDueAt || now());
            item.weeklyDueAt = due + Math.max(1, Math.floor((now() - due) / (7 * 86_400_000)) + 1) * 7 * 86_400_000;
            item.nextAt = item.weeklyDueAt;
        } else item.active = false;
        item.pendingMessageIds = []; item.lastMessageId = null;
        item.stoppedAt = now(); item.revision = Number(item.revision || 0) + 1;
        state.edits = state.edits.filter(edit => edit.reminderId !== item.id);
        persist();
    }
    async function handleEventReminderCallback(context, data) {
        const match = data.match(/^evrem:(choose|confirm|reject|back):([a-f0-9-]{36})(?::(\d+))?$/iu);
        if (!match) return false;
        await context.answerCallbackQuery?.().catch(() => {});
        const session = state.eventSessions.find(item => item.id === match[2] && item.userId === String(context.externalSenderId || '')
            && storedPlatform(item) === contextPlatform(context)
            && String(item.sessionChatId || item.chatId) === String(context.externalPeerId || ''));
        if (!session || Number(session.expiresAt) <= now()) {
            if (session) { state.eventSessions = state.eventSessions.filter(item => item !== session); persist(); }
            await context.send('Эта настройка уже неактуальна. Откройте карточку события заново.'); return true;
        }
        const action = match[1];
        if (action === 'back') { state.eventSessions = state.eventSessions.filter(item => item !== session); persist(); await context.send('Настройка закрыта. Существующие напоминания сохранены.'); return true; }
        if (action === 'choose') {
            if ((session.platform !== 'vk' && !context.isDM) || session.state !== 'SELECTING') { await context.send('Эта кнопка уже неактуальна.'); return true; }
            const option = session.options[Number(match[3])];
            if (!option || option.at <= now()) { await context.send('Этот вариант уже недоступен. Выбери другой.'); return true; }
            session.pending = { optionIndex: Number(match[3]), at: option.at, rule: option.rule, proposalId: randomUUID() };
            session.state = 'AWAITING_CONFIRMATION'; session.revision = Number(session.revision || 0) + 1; persist();
            const existing = state.reminders.some(item => samePersonalEventReminder(item, session));
            const times = Array.isArray(option.times) && option.times.length ? option.times : [option.at];
            session.pending.times = times;
            const message = ['Подтвердите установку напоминания:', 'Событие: ' + session.eventTitle, 'Напомнить: ' + times.map(dateLabel).join(' и '), 'Часовой пояс: ' + timeZone, 'Новых уведомлений: ' + times.length, existing ? 'После подтверждения прежнее напоминание для этого события будет заменено.' : ''].filter(Boolean).join('\n');
            await context.send({ message, ...(session.platform === 'vk' ? { keyboard: eventConfirmationKeyboard(session) } : { replyMarkup: eventConfirmationKeyboard(session) }) });
            return true;
        }
        if (Number(match[3]) !== Number(session.revision) || session.state !== 'AWAITING_CONFIRMATION' || !session.pending) { await context.send('Это подтверждение уже устарело.'); return true; }
        if (action === 'reject') { session.state = 'SELECTING'; session.pending = null; session.revision += 1; persist(); await context.send({ message: 'Предложение отменено. Выбери другой вариант или выйди кнопкой «Назад».', ...(session.platform === 'vk' ? { keyboard: eventKeyboard(session) } : { replyMarkup: eventKeyboard(session) }) }); return true; }
        const currentEvent = typeof resolveEvent === 'function' ? await resolveEvent(session.sourceType, session.eventId) : null;
        if (!currentEvent || String(currentEvent.eventDate || '') !== session.eventDate || String(currentEvent.eventTime || '') !== session.eventTime || session.pending.at <= now()) {
            session.state = 'SELECTING'; session.pending = null; session.revision += 1; persist();
            await context.send({ message: 'Событие изменилось или выбранное время прошло. Напоминание не сохранено; открой карточку заново, чтобы пересчитать варианты.', ...(session.platform === 'vk' ? { keyboard: eventKeyboard(session) } : { replyMarkup: eventKeyboard(session) }) }); return true;
        }
        const eventKey = session.sourceType + ':' + session.eventId;
        const reminder = { id: 'event-rem-' + randomUUID(), kind: 'user', eventReminder: true, eventKey, eventSourceType: session.sourceType, eventId: session.eventId, eventVersion: session.eventDate + 'T' + session.eventTime,
            creatorUserId: session.userId, platform: session.platform, endpointKey: session.endpointKey, chatId: session.chatId, userId: session.userId, peerId: session.peerId, username: session.username, displayName: session.displayName, deliveryTarget: session.deliveryTarget, text: 'Событие: ' + session.eventTitle,
            eventUrl: String(currentEvent.sourceUrl || currentEvent.url || ''), eventVenue: String(currentEvent.venue || ''), eventDate: String(currentEvent.eventDate || ''), eventTime: String(currentEvent.eventTime || ''),
            times: (session.pending.times || [session.pending.at]).slice(), nextAt: session.pending.times?.[0] || session.pending.at, remaining: (session.pending.times || [session.pending.at]).length, active: true, awaitingAck: false, pendingMessageIds: [], lastMessageId: null,
            timeZone, eventRule: session.pending.rule, createdAt: now(), nextEventCheckAt: now() + 60 * 60_000, revision: 1 };
        for (const previous of state.reminders.filter(item => samePersonalEventReminder(item, session))) {
            previous.active = false; previous.replacedAt = now(); previous.pendingMessageIds = []; previous.revision = Number(previous.revision || 0) + 1;
        }
        state.reminders.push(reminder); state.eventSessions = state.eventSessions.filter(item => item !== session); persist();
        await context.send('✅ Напоминание установлено для «' + session.eventTitle + '»: ' + dateLabel(reminder.nextAt) + '.');
        return true;
    }
    async function chooseEventReminder(context, session, optionIndex) {
        const option = session.options[optionIndex];
        if (!option || option.at <= now()) { await context.send('Этот вариант уже недоступен. Выбери другой.'); return true; }
        session.pending = { optionIndex, at: option.at, times: Array.isArray(option.times) && option.times.length ? option.times.slice() : [option.at], rule: option.rule, proposalId: randomUUID() };
        session.state = 'AWAITING_CONFIRMATION'; session.revision = Number(session.revision || 0) + 1; persist();
        const existing = state.reminders.some(item => samePersonalEventReminder(item, session));
        await context.send({ message: ['Подтвердите установку напоминания:', 'Событие: ' + session.eventTitle, 'Напомнить: ' + session.pending.times.map(dateLabel).join(' и '), 'Часовой пояс: ' + timeZone, 'Новых уведомлений: ' + session.pending.times.length, existing ? 'После подтверждения прежнее напоминание для этого события будет заменено.' : ''].filter(Boolean).join('\n'), ...(session.platform === 'vk' ? { keyboard: eventConfirmationKeyboard(session) } : { replyMarkup: eventConfirmationKeyboard(session) }) });
        return true;
    }
    async function showEditHelp(context, edit, item) {
        await context.send({ message: [
            'Изменение напоминания: «' + item.text + '».',
            'Пришли новую полную команду «напомни мне …» с текстом и расписанием. Получатель останется прежним.',
            buildReminderHelp(),
            'Например: напомни мне завтра в 12:30 позвонить врачу',
            'Или: напомни мне завтра с 10:00 до 15:00 3 раза рандомно проверить почту',
            'До подтверждения прежнее напоминание действует. Для выхода — «отмена».',
        ].join('\n\n'), replyMarkup: { inline_keyboard: [[{ text: 'Отмена', callback_data: 'remcancel:' + edit.token }]] } });
    }
    async function handleEditInput(context, text, edit) {
        if (/^(?:отмена|назад|отменить)$/iu.test(text)) {
            discardEdit(edit); persist(); await context.send('Изменение отменено. Прежнее напоминание сохранено.'); return true;
        }
        const item = state.reminders.find(entry => entry.id === edit.reminderId && canManageReminder(context, entry));
        if (!item || Number(item.revision || 0) !== edit.revision || now() > edit.expiresAt) {
            discardEdit(edit); persist(); await context.send('Редактирование устарело. Нажми «Изменить напоминание» ещё раз.'); return true;
        }
        const sameRecipient = candidate => {
            if (candidate?.target === 'self') return true; // In edit mode, self means the stored recipient.
            if (!canAddress(context, candidate?.target)) return false;
            const requested = recipientFor(candidate.target, context);
            return String(requested.chatId) === String(item.chatId) && String(requested.userId) === String(item.userId);
        };
        const explicitRecipient = normalize(text).match(/^(?:напомни(?:ть)?|напоминай)\s+(м[ие]лан[аеуы]|игор[ьюяе])(?=\s|$)/iu)?.[1];
        if (explicitRecipient && !sameRecipient({ target: /^игор/iu.test(explicitRecipient) ? 'owner' : 'milana' })) {
            await context.send('Получателя существующего напоминания менять нельзя. Для другого адресата создай новое напоминание. Ничего не изменено.');
            return true;
        }
        let parsed = parseReminderCommand(text, { now: new Date(now()), timeZone });
        let clarifiedByAi = false;
        if (parsed?.type !== 'create' && typeof parseReminderWithAi === 'function' &&
            context?.isDM && (isOwner(context) || isMilana(context))) {
            await context.send('Не удалось точно разобрать расписание. Передаю команду ИИ вместе с шаблонами. Изменения будут предложены только на подтверждение.');
            const originalToken = edit.token;
            try {
                const recipientName = String(item.userId) === String(defaultUserId) ? 'Милане'
                    : String(item.userId) === String(ownerExternalUserId) ? 'Игорю' : 'прежнему получателю';
                const response = await parseReminderWithAi({
                    text, help: buildReminderHelp(), now: new Date(now()), timeZone,
                    edit: { recipient: recipientName, currentText: item.text },
                });
                if (editFor(context) !== edit || edit.token !== originalToken ||
                    Number(item.revision || 0) !== Number(edit.revision || 0) || now() > edit.expiresAt) {
                    await context.send('Пока ИИ уточнял команду, настройка изменилась. Повтори редактирование.');
                    return true;
                }
                const command = typeof response === 'string' ? response
                    : response?.understood === false ? '' : String(response?.command || '');
                const suggestion = command ? parseReminderCommand(command, { now: new Date(now()), timeZone, random }) : null;
                if (suggestion?.type === 'create' && sameRecipient(suggestion) &&
                    suggestion.times?.length && suggestion.times.every(at => at > now())) {
                    parsed = suggestion;
                    clarifiedByAi = true;
                }
            } catch (error) {
                console.warn('[TELEGRAM REMINDER EDIT AI FALLBACK ERROR]', error?.message || error);
            }
        }
        if (parsed?.type !== 'create' || !sameRecipient(parsed) ||
            !parsed.times?.length || parsed.times.some(at => at <= now())) {
            edit.proposal = null; edit.token = randomUUID(); persist();
            await context.send('Не удалось безопасно определить новое расписание, даже с уточнением ИИ. Прежнее напоминание не изменено.');
            await showEditHelp(context, edit, item);
            return true;
        }
        edit.proposal = parsed; edit.token = randomUUID(); persist();
        const times = parsed.times.map(formatAt);
        const repeat = parsed.cadence === 'daily' && parsed.schedule?.dailyCountPerDay
            ? 'Каждый день, ' + parsed.schedule.dailyCountPerDay + ' раза в день'
            : parsed.count !== null ? 'Всего отправок: ' + parsed.count
            : parsed.cadence === 'daily' ? 'Каждый день'
                : parsed.cadence === 'weekly' ? 'Каждую неделю'
                    : 'Повтор каждые ' + (parsed.intervalMs / 60_000) + ' мин.';
        await context.send({ message: [
            clarifiedByAi ? 'ИИ предложил изменение. Проверь и подтверди:' : 'Изменяю так:', '«' + parsed.content + '»',
            'Время — московское: ' + times.join('; '), repeat,
            parsed.random ? 'Случайные моменты выбраны внутри указанного окна.' : '',
            'Получатель прежний. Старое расписание заменится только после подтверждения.',
        ].filter(Boolean).join('\n'), replyMarkup: { inline_keyboard: [
            [{ text: 'Подтвердить', callback_data: 'remconfirm:' + edit.token }],
            [{ text: 'Изменить', callback_data: 'remrevise:' + edit.token }],
        ] } });
        return true;
    }
    function ensureHelpNudges() {
        state.helpNudges = Array.isArray(state.helpNudges) ? state.helpNudges : [];
        const recipients = [
            { id: 'owner', chatId: String(ownerExternalUserId || ''), userId: String(ownerExternalUserId || ''), name: '' },
            { id: 'milana', chatId: String(defaultChatId), userId: String(defaultUserId), name: 'Милана' },
        ].filter(item => item.chatId);
        const byChat = new Set();
        for (const recipient of recipients) {
            if (byChat.has(recipient.chatId)) continue;
            byChat.add(recipient.chatId);
            if (!state.helpNudges.some(item => item.id === recipient.id || (item.active && item.chatId === recipient.chatId))) {
                state.helpNudges.push({ ...recipient, active: true, nextAt: now(), pendingMessageIds: [], lastMessageId: null, sentCount: 0 });
            }
        }
        persist();
    }
    function ensureMilanaReminder() {
        if (state.reminders.some(item => item.id === 'milana-weekly')) return false;
        const current = new Date(now()); const tomorrow = baseDate(current, 1, timeZone);
        const at = localEpoch({ ...tomorrow, hour: 10, minute: 0 }, timeZone);
        state.reminders.push({ id: 'milana-weekly', kind: 'milana-weekly', chatId: String(defaultChatId), userId: String(defaultUserId), peerId: String(defaultPeerId), text: 'Подстриги когти котам. Когда сделаешь, ответь «подстригла» на это сообщение.', nextAt: at, weeklyDueAt: at, reminderDelayMinMs: 30 * 60_000, reminderDelayMaxMs: 60 * 60_000, active: true, awaitingAck: false, pendingMessageIds: [], lastMessageId: null, timeZone });
        persist(); return true;
    }
    function advanceReminderAfterDelivery(item) {
        if (item.kind === 'milana-weekly' && item.awaitingAck) {
            item.nextAt = now() + item.reminderDelayMinMs + Math.floor(random() * (item.reminderDelayMaxMs - item.reminderDelayMinMs + 1));
        } else if (item.kind === 'milana-weekly') {
            item.awaitingAck = true;
            item.nextAt = now() + item.reminderDelayMinMs + Math.floor(random() * (item.reminderDelayMaxMs - item.reminderDelayMinMs + 1));
        } else if (item.eventDeadlineAt) {
            item.times=(item.times||[]).slice(1).filter(at=>at>now() && at<item.eventDeadlineAt);
            if(item.times.length){item.nextAt=item.times[0];}
            else if(item.schedule && item.cadence!=='once') {
                const next=nextCycle(item.schedule,item.cycleDay||datePartsAt(item.nextAt,item.timeZone||timeZone),now(),random);
                const upcoming=(next?.times||[]).filter(at=>at>now() && at<item.eventDeadlineAt);
                if(upcoming.length){item.times=upcoming;item.nextAt=upcoming[0];item.cycleDay=next.day;}
                else item.active=false;
            } else item.active=false;
        } else {
            item.times = (item.times || []).slice(1);
            if (item.eventReminder && item.times.length) item.times = item.times.filter(at => at > now());
            if (item.times.length) item.nextAt = item.times[0];
            else if (item.remaining === null && ['daily', 'weekly', 'monthly', 'yearly'].includes(item.cadence) && item.schedule) {
                const currentDay = item.cycleDay || datePartsAt(item.nextAt, item.timeZone || timeZone);
                const next = nextCycle(item.schedule, currentDay, now(), random);
                if (next?.times?.length) { item.times = next.times; item.nextAt = next.times[0]; item.cycleDay = next.day; }
                else item.active = false;
            }
            else if (item.remaining === null && item.cadence === 'daily') item.nextAt += 86_400_000;
            else if (item.remaining === null && item.cadence === 'weekly') item.nextAt += 7 * 86_400_000;
            else if (item.remaining === null && item.cadence === 'interval') item.nextAt += Number(item.intervalMs || 3_600_000);
            else item.active = false;
            if (item.remaining !== null) { item.remaining = Math.max(0, Number(item.remaining) - 1); if (item.remaining === 0) item.active = false; }
        }
    }
    async function sendReminder(item) {
        const revision = Number(item.revision || 0);
        let result = null;
        let deliveryItems = [item];
        if (item.eventReminder && !item.groupEventReminder && item.deliveryTarget === 'chat') {
            deliveryItems = state.reminders.filter(candidate => candidate.active && candidate.eventReminder && !candidate.groupEventReminder
                && candidate.eventKey === item.eventKey && storedPlatform(candidate) === storedPlatform(item) && candidate.endpointKey === item.endpointKey
                && candidate.chatId === item.chatId && Number(candidate.nextAt) === Number(item.nextAt) && Number(candidate.nextAt) <= now());
            if (!deliveryItems.length) deliveryItems = [item];
        }
        if(item.deliveryKind==='vk-forward') {
            if(storedPlatform(item)!=='vk'||typeof sendVkForwardReminder!=='function')throw new Error('VK forwarding unavailable');
            result=await sendVkForwardReminder({peerId:item.peerId,chatId:item.chatId,endpointKey:item.endpointKey,sourcePeerId:item.sourcePeerId,sourceCmid:item.sourceCmid,sourceMessageId:item.sourceMessageId,keyboard:vkForwardKeyboard(item.id.slice('vk-forward-'.length),'stop')});
            if(!result)throw new Error('VK forward failed');
        } else if (item.eventReminder && storedPlatform(item) === 'vk' && typeof sendEventReminder === 'function') {
            const title = String(item.eventTitle || item.text || 'Событие').replace(/^Событие:\s*/u, '');
            const text = item.groupEventReminder
                ? (item.eventDeadlineAt ? '🔔 Напоминаю вам о предстоящем событии.' : '🔔 Напоминаю вам о сегодняшнем событии.')
                : '🔔 Ты просил напомнить о событии «' + title + '».';
            result = await sendEventReminder({
                platform: item.platform || 'telegram', endpointKey: item.endpointKey || '', chatId: item.chatId,
                peerId: item.peerId || item.chatId, threadId: item.threadId || 0, text, event: item,
                subscribers: item.groupEventReminder || item.deliveryTarget !== 'chat' ? [] : deliveryItems.map(candidate => ({ id: candidate.userId, username: candidate.username || '', displayName: candidate.displayName || '' })),
                groupEventReminder: Boolean(item.groupEventReminder),
            });
            if (!result) throw new Error('event reminder delivery returned no result');
        } else if (item.deliveryKind === 'attachment' && Array.isArray(item.archiveEntries) && item.archiveEntries.length && typeof api.sendDocument === 'function') {
            const entry = item.attachmentMode === 'random'
                ? item.archiveEntries[Math.floor(random() * item.archiveEntries.length)]
                : item.archiveEntries[(Number(item.attachmentIndex || 0)) % item.archiveEntries.length];
            if (item.attachmentMode !== 'random') item.attachmentIndex = Number(item.attachmentIndex || 0) + 1;
            try { result = await api.sendDocument({ chatId: item.chatId, document: { filePath: entry.path, filename: entry.name, mimeType: 'application/octet-stream' }, caption: '🔔 Напоминание: ' + (item.text || (item.attachmentMode === 'random' ? 'случайный файл' : 'файл по очереди')), replyMarkup: reminderDoneMarkup(item.id, Boolean(item.personalCancel && item.creatorUserId && item.creatorUserId !== item.userId)) }); }
            catch (error) { console.warn('[TELEGRAM REMINDER ARCHIVE FILE ERROR]', item.id, entry.name, error?.message || error); }
        } else if (item.deliveryKind === 'attachment' && item.sourceChatId && item.sourceMessageId && typeof api.copyMessage === 'function') {
            try { result = await api.copyMessage({ chatId: item.chatId, fromChatId: item.sourceChatId, messageId: item.sourceMessageId, caption: '🔔 Напоминание: ' + (item.text || 'вложение'), replyMarkup: reminderDoneMarkup(item.id, Boolean(item.personalCancel && item.creatorUserId && item.creatorUserId !== item.userId)) }); }
            catch (error) { console.warn('[TELEGRAM REMINDER ATTACHMENT COPY ERROR]', item.id, error?.message || error); }
        }
        if (!result) {
            const eventDetails = item.eventReminder ? [item.eventDate ? '📅 ' + item.eventDate + (item.eventTime ? ' · ' + item.eventTime : '') : '', item.eventVenue ? '📍 ' + item.eventVenue : '', item.eventUrl ? 'Источник: ' + item.eventUrl : ''].filter(Boolean).join('\n') : '';
            result = await api.sendMessage({ chatId: item.chatId, text: ['🔔 Напоминание: ' + (item.text || 'Отправить вложение'), eventDetails].filter(Boolean).join('\n'), replyMarkup: reminderDoneMarkup(item.id, Boolean(item.personalCancel && item.creatorUserId && item.creatorUserId !== item.userId)) });
        }
        if (!item.active || Number(item.revision || 0) !== revision) return;
        const id = Number(result?.message_id || result?.conversation_message_id || result?.id || 0) || null;
        for (const deliveryItem of deliveryItems) {
            deliveryItem.lastMessageId = id;
            deliveryItem.pendingMessageIds = [...new Set([...(deliveryItem.pendingMessageIds || []), id].filter(Boolean))].slice(-50);
            deliveryItem.sentMessageDays = Object.fromEntries(deliveryItem.pendingMessageIds.map(messageId => [messageId, messageId === id ? dayKey(now(), deliveryItem.timeZone) : deliveryItem.sentMessageDays?.[messageId] || dayKey(deliveryItem.lastSentAt || now(), deliveryItem.timeZone)]));
            deliveryItem.lastSentAt = now();
            advanceReminderAfterDelivery(deliveryItem);
        }
        persist();
    }
    async function sendHelpNudge(item) {
        const chunks = splitTelegramLongReply(buildReminderHelpNotice(item.name), 3500);
        let result = null;
        for (let i = 0; i < chunks.length; i += 1) {
            result = await api.sendMessage({ chatId: item.chatId, text: chunks[i],
                ...(i === chunks.length - 1 ? { replyMarkup: reminderHelpMarkup(item.id) } : {}) });
        }
        const id = Number(result?.message_id || 0) || null;
        item.lastMessageId = id;
        item.pendingMessageIds = [...new Set([...(item.pendingMessageIds || []), id].filter(Boolean))].slice(-20);
        item.sentCount = Number(item.sentCount || 0) + 1;
        item.lastSentAt = now();
        item.nextAt = now() + 60 * 60_000 + Math.floor(random() * (2 * 60 * 60_000 + 1));
        persist();
        console.log('[TELEGRAM REMINDER HELP SENT]', 'target=' + item.id, 'sentCount=' + item.sentCount, 'nextAt=' + item.nextAt);
    }
    async function tick() {
        revokeUnauthorizedGroupJobs();
        if (busy || !api) return; busy = true;
        try {
            for (const session of state.eventSessions.slice()) {
                if (Number(session.expiresAt) > now()) continue;
                try {
                    const text = '⏳ Время настройки напоминания истекло. Напоминание не создано. Открой событие и нажми кнопку настройки ещё раз.';
                    if (storedPlatform(session) === 'telegram') await api.sendMessage({ chatId: session.chatId, text, messageThreadId: Number(session.threadId || 0) || null });
                    else await sendEventNotice?.({ platform: storedPlatform(session), endpointKey: session.endpointKey, chatId: session.chatId, peerId: session.peerId, threadId: session.threadId, text });
                } catch (error) { console.warn('[EVENT REMINDER EXPIRY NOTICE ERROR]', session.id, error?.message || error); }
                state.eventSessions = state.eventSessions.filter(item => item !== session);
                persist();
            }
            for (const item of state.reminders) {
                if (item.active && item.eventDeadlineAt && now() >= item.eventDeadlineAt) {
                    item.active=false;item.cancelledAt=now();item.cancelReason='event-started';persist();continue;
                }
                if (!item.active || (!item.eventReminder && Number(item.nextAt || 0) > now()) || (item.eventReminder && Number(item.nextAt || 0) > now() && Number(item.nextEventCheckAt || 0) > now())) continue;
                if (item.eventReminder && typeof resolveEvent === 'function') {
                    let currentEvent = null;
                    try { currentEvent = await resolveEvent(item.eventSourceType, item.eventId); } catch (error) { console.warn('[TELEGRAM EVENT REMINDER REFRESH ERROR]', item.id, error?.message || error); item.nextAt = now() + 300_000; persist(); continue; }
                    item.nextEventCheckAt = now() + 60 * 60_000;
                    const version = currentEvent ? String(currentEvent.eventDate || '') + 'T' + String(currentEvent.eventTime || '') : '';
                    if (!currentEvent) {
                        item.active = false; item.cancelledAt = now(); item.cancelReason = 'event-unavailable'; persist();
                        const notice = 'ℹ️ Напоминание отменено: событие «' + item.text.replace(/^Событие:\s*/u, '') + '» удалено или уже прошло.';
                        await (storedPlatform(item) === 'telegram' ? api.sendMessage({ chatId: item.chatId, text: notice, messageThreadId: Number(item.threadId || 0) || null }) : sendEventNotice?.({ platform: storedPlatform(item), endpointKey: item.endpointKey, chatId: item.chatId, peerId: item.peerId, threadId: item.threadId, text: notice }))?.catch?.(() => {});
                        continue;
                    }
                    if (version !== item.eventVersion) {
                        if (item.eventRule?.explicit) {
                            item.active = false; item.cancelledAt = now(); item.cancelReason = 'explicit-schedule-event-changed'; persist();
                            const notice = 'ℹ️ Событие изменилось, поэтому напоминание с явно выбранной датой отменено. Настрой его заново по актуальной карточке.';
                            await (storedPlatform(item) === 'telegram' ? api.sendMessage({ chatId: item.chatId, text: notice, messageThreadId: Number(item.threadId || 0) || null }) : sendEventNotice?.({ platform: storedPlatform(item), endpointKey: item.endpointKey, chatId: item.chatId, peerId: item.peerId, threadId: item.threadId, text: notice }))?.catch?.(() => {});
                            continue;
                        }
                        const updated = makeEventOptions(currentEvent).find(option => option.rule?.kind === item.eventRule?.kind && (option.rule?.hours === item.eventRule?.hours || item.eventRule?.kind !== 'before-start'));
                        if (!updated) {
                            item.active = false; item.cancelledAt = now(); item.cancelReason = 'no-valid-time-after-event-change'; persist();
                            await api.sendMessage({ chatId: item.chatId, text: 'ℹ️ Событие изменилось, и подходящего будущего времени для напоминания больше нет. Напоминание отменено.' }).catch(() => {});
                            continue;
                        }
                        item.eventVersion = version; item.eventTitle = String(currentEvent.title || currentEvent.participants || item.eventTitle || 'Событие');
                        item.eventVenue = String(currentEvent.venue || ''); item.eventUrl = String(currentEvent.sourceUrl || currentEvent.url || '');
                        item.eventDate = String(currentEvent.eventDate || ''); item.eventTime = String(currentEvent.eventTime || '');
                        item.text = 'Событие: ' + item.eventTitle;
                        item.times = (updated.times || [updated.at]).filter(at => at > now());
                        item.nextAt = item.times[0] || 0; item.remaining = item.times.length; item.eventRule = updated.rule; persist();
                        if (!item.times.length) { item.active = false; item.cancelledAt = now(); item.cancelReason = 'no-future-times-after-reschedule'; persist(); continue; }
                    }
                    if (Number(item.nextAt || 0) > now()) continue;
                }
                if (Number(item.nextAt || 0) > now()) continue;
                try { await sendReminder(item); }
                catch (error) { console.warn('[TELEGRAM REMINDER SEND ERROR]', error?.message || error); item.nextAt = now() + 300_000; persist(); }
            }
            for (const item of state.helpNudges || []) {
                if (!item.active || Number(item.nextAt || 0) > now()) continue;
                try { await sendHelpNudge(item); }
                catch (error) { console.warn('[TELEGRAM REMINDER HELP SEND ERROR]', 'target=' + item.id, error?.message || error); item.nextAt = now() + 300_000; persist(); }
            }
        } finally { busy = false; }
    }
    async function handleCallback(context) {
        const platform = contextPlatform(context);
        if (!['telegram', 'vk'].includes(platform)) return false;
        const callback = context.callbackQuery || context.message?.callback_query || null;
        const data = String(callback?.data || '').trim();
        if (/^evgrouprem:/u.test(data)) return platform === 'vk' ? handleGroupEventReminderCallback(context, data) : false;
        if (/^evrem:/u.test(data)) return handleEventReminderCallback(context, data);
        if (context.platform === 'vk') return false;
        if (!/^(?:remdone|remstop|remapprove|remdeny|remedit|remconfirm|remrevise|remcancel|remaiproposal|remlist):/u.test(data) && !HELP_ACK_DATA.test(data)) return false;
        const chatId = String(context.externalPeerId || '');
        const userId = String(context.externalSenderId || '');
        await context.answerCallbackQuery?.().catch(() => {});
        if (!context.isDM) return true;
        const cancellation = data.match(/^rem(stop|approve|deny):(.+)$/u);
        if (cancellation) {
            const action = cancellation[1];
            const item = state.reminders.find(r => action === 'stop' ? r.id === cancellation[2] : r.cancelRequest === cancellation[2]);
            if (!item || !item.active || (action === 'stop' ? !canManageReminder(context, item) : (item.creatorUserId || item.userId) !== userId)) { await context.send('Запрос устарел или недоступен.'); return true; }
            if (action === 'deny') { item.cancelRequest = null; persist(); await context.send('Напоминание оставлено.'); await api.sendMessage({chatId:item.chatId, text:'Автор отклонил отмену. Напоминание продолжает действовать:\n' + item.text}).catch(error => console.warn('[REMINDER CANCEL NOTICE]', error.message)); }
            else await cancelReminder(item, context);
            return true;
        }
        const listAction = data.match(/^remlist:(delete|edit):(.+)$/u);
        if (listAction) {
            const item = state.reminders.find(entry => entry.id === listAction[2]);
            if (!item || !canManageReminder(context, item)) { await context.send('Это напоминание недоступно для управления.'); return true; }
            if (listAction[1] === 'edit') {
                if (item.personalCancel && (item.creatorUserId || item.userId) !== userId) { await context.send('Изменять это напоминание может автор. Можно запросить отмену.'); return true; }
                state.edits = state.edits.filter(edit => edit.reminderId !== item.id || !owns(edit, context));
                const edit = { chatId: String(context.externalPeerId), userId: String(context.externalSenderId), reminderId: item.id, revision: Number(item.revision || 0), token: randomUUID(), expiresAt: now() + 86_400_000, proposal: null };
                state.edits.push(edit); persist(); await showEditHelp(context, edit, item); return true;
            }
            await cancelReminder(item, context);
            return true;
        }
        const aiAction = data.match(/^remaiproposal:(confirm|revise):(.+)$/u);
        if (aiAction) {
            const allowed = isOwner(context) || isMilana(context);
            const proposal = state.aiProposals.find(item => item.token === aiAction[2] && item.chatId === chatId && item.userId === userId && Number(item.expiresAt) > now());
            if (!allowed || !proposal) { await context.send('Это предложение устарело или недоступно этому пользователю.'); return true; }
            if (aiAction[1] === 'revise') {
                state.aiProposals = state.aiProposals.filter(item => item !== proposal); persist();
                await context.send(buildReminderHelp()); return true;
            }
            const parsed = proposal.parsed;
            if (!parsed?.times?.length || parsed.times.some(at => at <= now()) || !canAddress(context, parsed.target)) { state.aiProposals = state.aiProposals.filter(item => item !== proposal); persist(); await context.send('Предложение нельзя установить для этого получателя. Пришли команду снова.'); return true; }
            const recipient = recipientFor(parsed.target, context);
            const reminder = { id: 'rem-' + now() + '-' + Math.floor(random() * 1_000_000), kind: 'user', creatorUserId: userId, personalCancel: Boolean(parsed.personalCancel), ...recipient, text: parsed.content, times: parsed.times.slice(), nextAt: parsed.times[0], remaining: parsed.count, intervalMs: parsed.intervalMs, cadence: parsed.cadence, schedule: parsed.schedule, cycleDay: parsed.schedule?.anchorDay || null, active: true, awaitingAck: parsed.count === null, pendingMessageIds: [], lastMessageId: null, timeZone };
            state.reminders.push(reminder); state.aiProposals = state.aiProposals.filter(item => item !== proposal); persist();
            await context.send('✅ Напоминание установлено по предложению ИИ. Первое: ' + formatAt(reminder.nextAt) + '.'); return true;
        }
        const editAction = data.match(/^rem(confirm|revise|cancel):(.+)$/u);
        if (editAction) {
            const edit = editFor(context);
            const item = edit && state.reminders.find(entry => entry.id === edit.reminderId && canManageReminder(context, entry));
            if (!edit || !item || edit.token !== editAction[2] || now() > edit.expiresAt || Number(item.revision || 0) !== edit.revision) {
                await context.send('Эта кнопка устарела. Используй последнее сообщение или снова нажми «Изменить напоминание».'); return true;
            }
            if (editAction[1] === 'cancel') {
                discardEdit(edit); persist(); await context.send('Изменение отменено. Прежнее напоминание сохранено.'); return true;
            }
            if (editAction[1] === 'revise') {
                edit.proposal = null; edit.token = randomUUID(); persist(); await showEditHelp(context, edit, item); return true;
            }
            const parsed = edit.proposal;
            if (!parsed || parsed.times.some(at => at <= now())) {
                edit.proposal = null; edit.token = randomUUID(); persist();
                await context.send('Время уже прошло или предложение отсутствует. Укажи новое расписание.');
                await showEditHelp(context, edit, item); return true;
            }
            Object.assign(item, { kind: 'user', text: parsed.content, times: parsed.times.slice(), nextAt: parsed.times[0], remaining: parsed.count,
                intervalMs: parsed.intervalMs, cadence: parsed.cadence, schedule: parsed.schedule, cycleDay: parsed.schedule?.anchorDay || null, active: true, awaitingAck: parsed.count === null,
                pendingMessageIds: [], lastMessageId: null, revision: edit.revision + 1, updatedAt: now(), timeZone });
            discardEdit(edit); persist();
            await context.send('✅ Напоминание изменено: «' + item.text + '». Первое: ' + formatAt(item.nextAt) + '.'); return true;
        }
        const helpMatch = data.match(HELP_ACK_DATA);
        if (helpMatch) {
            const item = (state.helpNudges || []).find(entry => entry.active && entry.id === helpMatch[1] && entry.chatId === chatId && entry.userId === userId);
            if (!item) { await context.send('Эта подсказка уже закрыта или предназначена другому получателю.'); return true; }
            item.active = false; item.acknowledgedAt = now(); item.pendingMessageIds = []; persist();
            await context.send('✅ Понял(а). Больше не буду повторять подсказку по напоминаниям.');
            return true;
        }
        const reminderId = data.slice(data.indexOf(':') + 1);
        const item = state.reminders.find(entry => entry.id === reminderId && canManageReminder(context, entry));
        if (!item) { await context.send('Это напоминание уже не найдено.'); return true; }
        const messageId = Number(callback?.message?.message_id || context.conversationMessageId || 0);
        if (!(item.pendingMessageIds || []).includes(messageId)) {
            await context.send('Это сообщение уже подтверждено или относится к прежнему расписанию.'); return true;
        }
        if (data.startsWith('remedit:')) {
            if (item.personalCancel && (item.creatorUserId || item.userId) !== userId) { await context.send('Изменять это напоминание может автор. Можно запросить отмену.'); return true; }
            state.edits = state.edits.filter(edit => !owns(edit, context));
            const edit = { chatId, userId, reminderId, revision: Number(item.revision || 0), token: randomUUID(), expiresAt: now() + 86_400_000, proposal: null };
            state.edits.push(edit); persist(); await showEditHelp(context, edit, item); return true;
        }
        await acknowledgeReminder(item, context);
        return true;
    }
    const looksLikeReminder = text => /^(?:напомни|напомнить|напоминай)(?=$|[^\p{L}\p{N}_])/iu.test(text);
    async function requestAiReminderClarification(context, text) {
        if (typeof parseReminderWithAi !== 'function' || !context?.isDM || !(isOwner(context) || isMilana(context))) return false;
        await context.send('Синтаксис не распознан автоматически. Делаю дополнительный анализ.');
        let proposal;
        try { proposal = await parseReminderWithAi({ text, help: buildReminderHelp(), now: new Date(now()), timeZone }); }
        catch (error) { console.warn('[TELEGRAM REMINDER AI FALLBACK ERROR]', error?.message || error); await context.send('Не удалось уточнить синтаксис автоматически. Пришли команду по одному из форматов подсказки.'); return true; }
        const candidate = typeof proposal === 'string' ? proposal : proposal?.understood === false ? '' : proposal?.command;
        const parsed = candidate ? parseReminderCommand(candidate, { now: new Date(now()), timeZone, random }) : null;
        if (!parsed || parsed.type !== 'create' || !canAddress(context, parsed.target) || !parsed.times?.length || parsed.times.some(at => at <= now())) {
            await context.send('ИИ не смог безопасно вывести будущее расписание. Напиши команду по формату из подсказки.'); return true;
        }
        if (/(?:личная отмена|отмена лично|отменять лично|отменить можно лично)/iu.test(text)) parsed.personalCancel = true;
        const namedTarget = text.match(/^(?:напомни(?:ть)?|напоминай)\s+(м[ие]лане|игорю)(?:\s|$)/iu)?.[1];
        if (namedTarget) parsed.target = /^игор/iu.test(namedTarget) ? 'owner' : 'milana';
        if (!canAddress(context, parsed.target)) { await context.send('Нельзя создать напоминание для этого получателя.'); return true; }
        const token = randomUUID();
        state.aiProposals = state.aiProposals.filter(item => !(item.chatId === String(context.externalPeerId) && item.userId === String(context.externalSenderId)));
        state.aiProposals.push({ token, chatId: String(context.externalPeerId), userId: String(context.externalSenderId), command: candidate, parsed, expiresAt: now() + 15 * 60_000 });
        persist();
        await context.send({ message: ['Синтаксис уточнён ИИ. Предлагаю установить так:', '«' + parsed.content + '»', 'Команда: ' + candidate, 'Первое срабатывание: ' + formatAt(parsed.times[0]), 'Если всё верно, подтвердите установку.'].join('\n'), replyMarkup: { inline_keyboard: [[{ text: 'Установить', callback_data: 'remaiproposal:confirm:' + token }], [{ text: 'Изменить', callback_data: 'remaiproposal:revise:' + token }]] } });
        return true;
    }
    async function handleIncoming(context) {
        if (!['telegram', 'vk'].includes(String(context?.platform || ''))) return false;
        const text = normalize(context.originalText || context.text); const replyId = Number(context.replyMessage?.conversationMessageId || 0);
        const eventSession = context.platform === 'telegram'
            ? (context.isDM && eventSessionFor(context))
            : eventSessionFor(context);
        if (context.platform === 'vk' && !eventSession) return false;
        if (eventSession && Number(eventSession.expiresAt) <= now()) {
            state.eventSessions = state.eventSessions.filter(item => item !== eventSession); persist();
            await context.send('⏳ Время настройки напоминания истекло. Напоминание не создано. Открой событие и нажми кнопку настройки ещё раз.');
            return true;
        }
        if (eventSession && text) {
            if (eventSession.state === 'AWAITING_CONFIRMATION') {
                const revised = parseEventReminderText(text, eventSession);
                if (revised) {
                    eventSession.options.unshift(revised); eventSession.options = eventSession.options.slice(0, 5);
                    eventSession.pending = { optionIndex: 0, at: revised.at, rule: revised.rule, proposalId: randomUUID() };
                    eventSession.revision += 1; persist();
                    await context.send({ message: 'Обновил вариант: ' + revised.label + ', ' + dateLabel(revised.at) + '. Подтверди новый вариант.', replyMarkup: { inline_keyboard: [
                        [{ text: '✅ Подтвердить', callback_data: 'evrem:confirm:' + eventSession.id + ':' + eventSession.revision }],
                        [{ text: '❌ Отказаться', callback_data: 'evrem:reject:' + eventSession.id + ':' + eventSession.revision }],
                        [{ text: '⬅️ Назад', callback_data: 'evrem:back:' + eventSession.id }],
                    ] } }); return true;
                }
                await context.send('Настройка ждёт подтверждения кнопкой. Чтобы выбрать другой срок, нажми «Отказаться» и выбери вариант заново.'); return true;
            }
            if (/^(?:назад|отмена|отменить)$/iu.test(text)) { state.eventSessions = state.eventSessions.filter(item => item !== eventSession); persist(); await context.send('Настройка закрыта.'); return true; }
            const requested = parseEventReminderText(text, eventSession);
            if (requested) {
                eventSession.options.unshift(requested); eventSession.options = eventSession.options.slice(0, 5); persist();
                await chooseEventReminder(context, eventSession, 0); return true;
            }
            if (typeof parseReminderWithAi === 'function') {
                await context.send('🤖 Не удалось сразу распознать ваш запрос как команду напоминания.\n\nПопробую подобрать наиболее подходящий вариант из доступных команд. Пожалуйста, подождите немного.');
                const revision = eventSession.revision; const requestId = randomUUID(); eventSession.aiRequestId = requestId; persist();
                try {
                    const ai = await parseReminderWithAi({ text, help: 'Напомни накануне в 19:00; в день события в 12:00; за 2 или 3 часа до начала.', event: { id: eventSession.eventId, title: eventSession.eventTitle, eventDate: eventSession.eventDate, eventTime: eventSession.eventTime, timeZone }, sessionId: eventSession.id, now: new Date(now()), timeZone });
                    const current = state.eventSessions.find(item => item.id === eventSession.id && item.aiRequestId === requestId && item.revision === revision && Number(item.expiresAt) > now());
                    if (!current) return true;
                    const candidate = typeof ai === 'string' ? ai : ai?.command || '';
                    const proposal = parseEventReminderText(candidate, current);
                    if (!proposal) { await context.send({ message: 'Не удалось подобрать однозначный вариант. Выбери кнопку или уточни: «накануне в 19:00», «в день события в 12:00», «за 2 часа».', replyMarkup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'evrem:back:' + current.id }]] } }); return true; }
                    current.options.unshift(proposal); current.options = current.options.slice(0, 5); persist();
                    await chooseEventReminder(context, current, 0);
                } catch (error) { console.warn('[TELEGRAM EVENT REMINDER AI ERROR]', error?.message || error); await context.send('Не удалось разобрать команду. Выбери один из рассчитанных вариантов кнопкой.'); }
                return true;
            }
            await context.send('Выбери рассчитанный вариант кнопкой или напиши, например: «накануне в 19:00», «в день события в 12:00», «за 2 часа».');
            return true;
        }
        if (/^(?:(?:показать|покажи)\s+|мои\s+)напоминания(?:\s+|$)/iu.test(text) || /^напоминания\s+показать$/iu.test(text)) return sendReminderList(context);
        if (replyId && ACK.test(text) && context.replyMessage?.isBot) {
            const item = state.reminders.find(reminder => owns(reminder, context) && (reminder.pendingMessageIds || [reminder.lastMessageId]).some(id => Number(id || 0) === replyId));
            if (item) {
                if (/^отмен/iu.test(text)) await cancelReminder(item, context);
                else await acknowledgeReminder(item, context); return true;
            }
        }
        const edit = context.isDM && editFor(context);
        if (edit) return handleEditInput(context, text, edit);
        const parsed = parseReminderCommand(text, { now: new Date(now()), timeZone });
        if (!parsed) return looksLikeReminder(text) ? await requestAiReminderClarification(context, text) : false;
        if (parsed.type === 'help') {
            const hasArguments = normalize(text.replace(/^(?:напомни|напомнить|напоминай)\s*/iu, '')).length > 0;
            if (hasArguments && await requestAiReminderClarification(context, text)) return true;
            await context.send(buildReminderHelp()); return true;
        }
        if (parsed.type === 'invalid') {
            if (await requestAiReminderClarification(context, text)) return true;
            await context.send(parsed.reason === 'window-too-short' ? 'Временное окно слишком короткое для такого числа напоминаний.' : 'Временной диапазон указан некорректно.'); return true;
        }
        if (!context.isDM) { await context.send('Напоминания настраиваются в личном чате с ботом.'); return true; }
        if (!canAddress(context, parsed.target)) { await context.send(parsed.target === 'milana' ? 'Команды для Миланы доступны только владельцу.' : 'Команды для Игоря доступны только Милане.'); return true; }
        const recipient = recipientFor(parsed.target, context);
        const sourceMessage = context.sourceMessageId && context.sourceChatId && context.hasAttachment;
        if (parsed.type === 'send-attachment') {
            if (!sourceMessage || typeof api.copyMessage !== 'function') { await context.send('Прикрепи файл или ответь командой на сообщение с вложением.'); return true; }
            await api.copyMessage({ chatId: recipient.chatId, fromChatId: context.sourceChatId, messageId: context.sourceMessageId, caption: context.originalText || 'Вложение' });
            await context.send('✅ Вложение отправлено.'); return true;
        }
        if (parsed.type === 'send') { await api.sendMessage({ chatId: recipient.chatId, text: parsed.content }); await context.send('✅ Сообщение отправлено.'); return true; }
        if (parsed.deliveryKind === 'attachment' && !sourceMessage) { await context.send('Для напоминания о вложении прикрепи файл или ответь командой на сообщение с вложением.'); return true; }
        let preparedAttachment = null;
        if (parsed.deliveryKind === 'attachment') {
            try { preparedAttachment = await prepareAttachmentSource(context, parsed); }
            catch (error) {
                const message = String(error?.message || error);
                await context.send('Не удалось сохранить вложение для напоминания: ' + message);
                return true;
            }
        }
        const reminder = { id: 'rem-' + now() + '-' + Math.floor(random() * 1_000_000), kind: 'user', personalCancel: Boolean(parsed.personalCancel), creatorUserId: String(context.externalSenderId || ''), creatorName: isOwner(context) ? 'Игорь' : isMilana(context) ? 'Милана' : '', ...recipient, text: parsed.content, deliveryKind: parsed.deliveryKind || 'text', attachmentMode: parsed.attachmentMode || 'any', sourceChatId: sourceMessage ? String(context.sourceChatId) : '', sourceMessageId: sourceMessage ? Number(context.sourceMessageId) : null, ...preparedAttachment, attachmentIndex: 0, times: parsed.times.slice(), nextAt: parsed.times[0], remaining: parsed.count, intervalMs: parsed.intervalMs, cadence: parsed.cadence, schedule: parsed.schedule, cycleDay: parsed.schedule?.anchorDay || null, active: true, awaitingAck: parsed.count === null, pendingMessageIds: [], lastMessageId: null, timeZone };
        state.reminders.push(reminder); persist(); await context.send('✅ Напоминание сохранено. Первое: ' + new Date(reminder.nextAt).toLocaleString('ru-RU', { timeZone }) + '. «Сделал(а)» закрывает текущий день. Для постоянной отмены используй отдельную кнопку.'); return true;
    }
    function start() { revokeUnauthorizedGroupJobs(); ensureMilanaReminder(); ensureHelpNudges(); if (!timer) { timer = setInterval(() => { void tick(); }, 15_000); timer.unref?.(); void tick(); } }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { start, stop, tick, handleIncoming, handleCallback, beginEventReminder, handleGroupEventReminder, beginRepliedGroupEventReminder, beginVkForwardReminder, ensureMilanaReminder, ensureHelpNudges, getState: () => JSON.parse(JSON.stringify(state)) };
}
