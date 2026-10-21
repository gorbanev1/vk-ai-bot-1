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
        'напомни мне 12.10.2026 в 18:30 забрать заказ',
        'напомни Милане 3 раза раз в час проверить задачу (только владелец)',
        'напомни Игорю завтра в 18:00 проверить задачу (только Милана)',
        'напиши Милане текст сообщения (только владелец)',
        '',
        'Полные примеры:',
        'Разово сегодня: напомни мне сегодня в 18:00 купить хлеб',
        'Разово по дате: напомни мне 12.10.2026 в 18:30 забрать заказ',
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
        'Остановить: нажми «Сделал(а)» под напоминанием или ответь «сделал/сделала» именно на него',
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
        'Нажатие «Сделал(а)» останавливает напоминание. Ответ «сделал/сделала» тоже сработает, только если это ответ именно на сообщение напоминания.',
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

function reminderDoneMarkup(reminderId) {
    return { inline_keyboard: [
        [{ text: 'Сделал(а)', callback_data: REMINDER_ACK_PREFIX + reminderId }],
        [{ text: 'Изменить напоминание', callback_data: 'remedit:' + reminderId }],
    ] };
}

function reminderHelpMarkup(target) {
    return { inline_keyboard: [[{ text: 'Понял(а)', callback_data: 'remhelp:' + target }]] };
}

function reminderListMarkup(item) {
    return { inline_keyboard: [[
        { text: 'Удалить', callback_data: 'remlist:delete:' + item.id },
        { text: 'Изменить', callback_data: 'remlist:edit:' + item.id },
    ]] };
}

export function parseReminderCommand(input, { now = new Date(), timeZone = 'Europe/Moscow', random = Math.random } = {}) {
    let normalizedInput = normalize(input);
    const reordered = normalizedInput.match(/^(.+?)\s+(напоминай|напомни)\s+(.+)$/iu);
    if (reordered) normalizedInput = reordered[2] + ' ' + reordered[3] + ' ' + reordered[1];
    const head = normalizedInput.match(/^(напомни|напомнить|напоминай|напиши|отправь|отправляй)(?:\s+|$)(.*)$/iu);
    if (!head) return null;
    let rest = normalize(head[2]);
    if (!rest) return { type: 'help' };
    let target = 'self';
    const recipient = rest.match(/^(мне|меня|себе|милан[аеуы]|миланой|игор[ьюяе]|игорем)(?:\s+|$)/iu);
    if (recipient) {
        if (/^милан/iu.test(recipient[1])) target = 'milana';
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
        return { ...scheduled, deliveryKind: 'attachment', attachmentMode: attachmentMode || 'any' };
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
            const year = Number(m[3] || localParts(now, timeZone).year);
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
    return { type: 'create', target, content: deliveryKind === 'attachment' ? '' : content, deliveryKind, attachmentMode, count: finiteCount, intervalMs: intervalMs || 3_600_000,
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

export function createReminderManager({ api, storagePath, timeZone = 'Europe/Moscow', ownerExternalUserId = '', defaultChatId = DEFAULT_CHAT_ID, defaultUserId = DEFAULT_USER_ID, defaultPeerId = DEFAULT_PEER_ID, now = () => Date.now(), random = Math.random, parseReminderWithAi = null, resolveEvent = null } = {}) {
    if (!storagePath) throw new Error('Reminder manager requires storagePath.');
    const state = readState(storagePath); state.aiProposals = Array.isArray(state.aiProposals) ? state.aiProposals : []; state.eventSessions = Array.isArray(state.eventSessions) ? state.eventSessions : []; let timer = null; let busy = false;
    const persist = () => writeState(storagePath, state);
    const isOwner = context => Boolean(ownerExternalUserId && String(context?.externalSenderId || '') === String(ownerExternalUserId));
    const isMilana = context => Boolean(String(context?.externalPeerId || '') === String(defaultChatId) && String(context?.externalSenderId || '') === String(defaultUserId));
    const canAddress = (context, target) => target === 'milana' ? isOwner(context)
        : target === 'owner' ? Boolean(ownerExternalUserId && isMilana(context)) : target === 'self';
    const recipientFor = (target, context) => target === 'milana'
        ? { chatId: String(defaultChatId), userId: String(defaultUserId), peerId: String(defaultPeerId) }
        : target === 'owner'
            ? { chatId: String(ownerExternalUserId), userId: String(ownerExternalUserId), peerId: '' }
            : { chatId: String(context.externalPeerId || ''), userId: String(context.externalSenderId || ''), peerId: String(context.peerId || '') };
    const canManageAll = context => isOwner(context) || isMilana(context);
    const canManageReminder = (context, item) => canManageAll(context) || owns(item, context);
    const reminderOwnerName = item => item.creatorName || (item.creatorUserId === String(defaultUserId) ? 'Милана' : item.creatorUserId === String(ownerExternalUserId) ? 'Игорь' : item.userId);
    const reminderDescription = item => {
        const recipient = item.chatId === String(defaultChatId) && item.userId === String(defaultUserId) ? 'Милане' : item.chatId === String(ownerExternalUserId) ? 'Игорю' : 'текущему чату';
        const attachment = item.deliveryKind === 'attachment' ? ' · вложение (' + (item.attachmentMode || 'any') + ')' : '';
        return '🔔 ' + (item.text || 'Отправить вложение') + attachment + '\nПолучатель: ' + recipient + '\nПервое: ' + formatAt(item.nextAt) + '\nСоздал(а): ' + reminderOwnerName(item) + '\nСтатус: ' + (item.active ? 'активно' : 'остановлено');
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
        const visible = state.reminders.filter(item => !item.deletedAt && (canManageAll(context) ? true : (item.active && owns(item, context))));
        if (!visible.length) { await context.send('Активных напоминаний нет.'); return true; }
        for (const item of visible) await context.send({ message: reminderDescription(item), replyMarkup: reminderListMarkup(item) });
        return true;
    }
    const owns = (item, context) => context?.isDM === true && item.chatId === String(context.externalPeerId) && item.userId === String(context.externalSenderId);
    const editFor = context => state.edits.find(edit => owns(edit, context));
    const formatAt = at => new Date(at).toLocaleString('ru-RU', { timeZone });
    const eventLocalDate = event => {
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
    const eventSessionFor = context => state.eventSessions.find(item => item.userId === String(context.externalSenderId || '') && item.chatId === String(context.externalPeerId || ''));
    async function beginEventReminder(context, event) {
        if (!context?.isDM) { await context.send('Персональное напоминание можно настроить в личном чате с ботом.'); return true; }
        const sourceType = String(event?.sourceType || '').toLowerCase(); const eventId = Number(event?.id);
        const userId = String(context.externalSenderId || ''); const chatId = String(context.externalPeerId || '');
        const options = makeEventOptions(event);
        if (!sourceType || !Number.isSafeInteger(eventId) || !options.length || !userId || !chatId) { await context.send('Для этого события не осталось корректных будущих вариантов напоминания.'); return true; }
        const session = { id: randomUUID(), userId, chatId, eventId, sourceType, eventTitle: String(event.title || event.participants || 'Событие'), eventDate: String(event.eventDate || ''), eventTime: String(event.eventTime || ''), options, state: 'SELECTING', createdAt: now(), expiresAt: now() + 30 * 60_000, revision: 1, pending: null };
        state.eventSessions = state.eventSessions.filter(item => item.userId !== userId);
        state.eventSessions.push(session); persist();
        try {
            await context.send({ message: [String(event.cardText || ''), '', 'Когда напомнить вам об этом событии?'].filter(Boolean).join('\n'), replyMarkup: eventMarkup(session) });
            await context.send({ message: ['Примеры команд:', 'напомни за день в 19:00', 'напомни в день события в 12:00', 'напомни за 2 часа', 'напомни за 3 часа', 'напомни за день в 15:00 и в день события в 14:00'].join('\n'), replyMarkup: { inline_keyboard: [[{ text: '⬅️ Назад', callback_data: 'evrem:back:' + session.id }]] } });
        } catch (error) {
            state.eventSessions = state.eventSessions.filter(item => item !== session); persist();
            throw error;
        }
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
        const session = state.eventSessions.find(item => item.id === match[2] && item.userId === String(context.externalSenderId || '') && item.chatId === String(context.externalPeerId || ''));
        if (!session || Number(session.expiresAt) <= now()) {
            if (session) { state.eventSessions = state.eventSessions.filter(item => item !== session); persist(); }
            await context.send('Эта настройка уже неактуальна. Откройте карточку события заново.'); return true;
        }
        const action = match[1];
        if (action === 'back') { state.eventSessions = state.eventSessions.filter(item => item !== session); persist(); await context.send('Настройка закрыта. Существующие напоминания сохранены.'); return true; }
        if (action === 'choose') {
            if (!context.isDM || session.state !== 'SELECTING') { await context.send('Эта кнопка уже неактуальна.'); return true; }
            const option = session.options[Number(match[3])];
            if (!option || option.at <= now()) { await context.send('Этот вариант уже недоступен. Выбери другой.'); return true; }
            session.pending = { optionIndex: Number(match[3]), at: option.at, rule: option.rule, proposalId: randomUUID() };
            session.state = 'AWAITING_CONFIRMATION'; session.revision = Number(session.revision || 0) + 1; persist();
            const existing = state.reminders.some(item => item.active && item.eventReminder && item.eventKey === session.sourceType + ':' + session.eventId && item.userId === session.userId);
            const times = Array.isArray(option.times) && option.times.length ? option.times : [option.at];
            session.pending.times = times;
            const message = ['Подтвердите установку напоминания:', 'Событие: ' + session.eventTitle, 'Напомнить: ' + times.map(dateLabel).join(' и '), 'Часовой пояс: ' + timeZone, 'Новых уведомлений: ' + times.length, existing ? 'После подтверждения прежнее напоминание для этого события будет заменено.' : ''].filter(Boolean).join('\n');
            await context.send({ message, replyMarkup: { inline_keyboard: [
                [{ text: '✅ Подтвердить', callback_data: 'evrem:confirm:' + session.id + ':' + session.revision }],
                [{ text: '❌ Отказаться', callback_data: 'evrem:reject:' + session.id + ':' + session.revision }],
                [{ text: '⬅️ Назад', callback_data: 'evrem:back:' + session.id }],
            ] } });
            return true;
        }
        if (Number(match[3]) !== Number(session.revision) || session.state !== 'AWAITING_CONFIRMATION' || !session.pending) { await context.send('Это подтверждение уже устарело.'); return true; }
        if (action === 'reject') { session.state = 'SELECTING'; session.pending = null; session.revision += 1; persist(); await context.send({ message: 'Предложение отменено. Выбери другой вариант или выйди кнопкой «Назад».', replyMarkup: eventMarkup(session) }); return true; }
        const currentEvent = typeof resolveEvent === 'function' ? await resolveEvent(session.sourceType, session.eventId) : null;
        if (!currentEvent || String(currentEvent.eventDate || '') !== session.eventDate || String(currentEvent.eventTime || '') !== session.eventTime || session.pending.at <= now()) {
            session.state = 'SELECTING'; session.pending = null; session.revision += 1; persist();
            await context.send({ message: 'Событие изменилось или выбранное время прошло. Напоминание не сохранено; открой карточку заново, чтобы пересчитать варианты.', replyMarkup: eventMarkup(session) }); return true;
        }
        const eventKey = session.sourceType + ':' + session.eventId;
        const reminder = { id: 'event-rem-' + randomUUID(), kind: 'user', eventReminder: true, eventKey, eventSourceType: session.sourceType, eventId: session.eventId, eventVersion: session.eventDate + 'T' + session.eventTime,
            creatorUserId: session.userId, chatId: session.chatId, userId: session.userId, peerId: session.chatId, text: 'Событие: ' + session.eventTitle,
            eventUrl: String(currentEvent.sourceUrl || currentEvent.url || ''), eventVenue: String(currentEvent.venue || ''), eventDate: String(currentEvent.eventDate || ''), eventTime: String(currentEvent.eventTime || ''),
            times: (session.pending.times || [session.pending.at]).slice(), nextAt: session.pending.times?.[0] || session.pending.at, remaining: (session.pending.times || [session.pending.at]).length, active: true, awaitingAck: false, pendingMessageIds: [], lastMessageId: null,
            timeZone, eventRule: session.pending.rule, createdAt: now(), nextEventCheckAt: now() + 60 * 60_000, revision: 1 };
        for (const previous of state.reminders.filter(item => item.active && item.eventReminder && item.eventKey === eventKey && item.userId === session.userId)) {
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
        const existing = state.reminders.some(item => item.active && item.eventReminder && item.eventKey === session.sourceType + ':' + session.eventId && item.userId === session.userId);
        await context.send({ message: ['Подтвердите установку напоминания:', 'Событие: ' + session.eventTitle, 'Напомнить: ' + session.pending.times.map(dateLabel).join(' и '), 'Часовой пояс: ' + timeZone, 'Новых уведомлений: ' + session.pending.times.length, existing ? 'После подтверждения прежнее напоминание для этого события будет заменено.' : ''].filter(Boolean).join('\n'), replyMarkup: { inline_keyboard: [
            [{ text: '✅ Подтвердить', callback_data: 'evrem:confirm:' + session.id + ':' + session.revision }],
            [{ text: '❌ Отказаться', callback_data: 'evrem:reject:' + session.id + ':' + session.revision }],
            [{ text: '⬅️ Назад', callback_data: 'evrem:back:' + session.id }],
        ] } });
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
        const parsed = parseReminderCommand(text, { now: new Date(now()), timeZone });
        if (parsed?.type !== 'create' || parsed.target !== 'self') {
            edit.proposal = null; edit.token = randomUUID(); persist();
            await context.send('Не понял новое расписание. Ничего не изменено. Укажи будущую дату/время и текст; получателя менять здесь нельзя.');
            await showEditHelp(context, edit, item); return true;
        }
        edit.proposal = parsed; edit.token = randomUUID(); persist();
        const times = parsed.times.map(formatAt);
        const repeat = parsed.count !== null ? 'Всего отправок: ' + parsed.count
            : parsed.cadence === 'daily' ? 'Каждый день'
                : parsed.cadence === 'weekly' ? 'Каждую неделю'
                    : 'Повтор каждые ' + (parsed.intervalMs / 60_000) + ' мин.';
        await context.send({ message: [
            'Изменяю так:', '«' + parsed.content + '»',
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
    async function sendReminder(item) {
        const revision = Number(item.revision || 0);
        let result = null;
        if (item.deliveryKind === 'attachment' && Array.isArray(item.archiveEntries) && item.archiveEntries.length && typeof api.sendDocument === 'function') {
            const entry = item.attachmentMode === 'random'
                ? item.archiveEntries[Math.floor(random() * item.archiveEntries.length)]
                : item.archiveEntries[(Number(item.attachmentIndex || 0)) % item.archiveEntries.length];
            if (item.attachmentMode !== 'random') item.attachmentIndex = Number(item.attachmentIndex || 0) + 1;
            try {
                result = await api.sendDocument({ chatId: item.chatId, document: { filePath: entry.path, filename: entry.name, mimeType: 'application/octet-stream' }, caption: '🔔 Напоминание: ' + (item.text || (item.attachmentMode === 'random' ? 'случайный файл' : 'файл по очереди')), replyMarkup: reminderDoneMarkup(item.id) });
            } catch (error) { console.warn('[TELEGRAM REMINDER ARCHIVE FILE ERROR]', item.id, entry.name, error?.message || error); }
        } else if (item.deliveryKind === 'attachment' && item.sourceChatId && item.sourceMessageId && typeof api.copyMessage === 'function') {
            try { result = await api.copyMessage({ chatId: item.chatId, fromChatId: item.sourceChatId, messageId: item.sourceMessageId, caption: '🔔 Напоминание: ' + (item.text || 'вложение'), replyMarkup: reminderDoneMarkup(item.id) }); }
            catch (error) { console.warn('[TELEGRAM REMINDER ATTACHMENT COPY ERROR]', item.id, error?.message || error); }
        }
        if (!result) {
            const eventDetails = item.eventReminder ? [item.eventDate ? '📅 ' + item.eventDate + (item.eventTime ? ' · ' + item.eventTime : '') : '', item.eventVenue ? '📍 ' + item.eventVenue : '', item.eventUrl ? 'Источник: ' + item.eventUrl : ''].filter(Boolean).join('\n') : '';
            result = await api.sendMessage({ chatId: item.chatId, text: ['🔔 Напоминание: ' + (item.text || 'Отправить вложение'), eventDetails].filter(Boolean).join('\n'), replyMarkup: reminderDoneMarkup(item.id) });
        }
        if (!item.active || Number(item.revision || 0) !== revision) return;
        const id = Number(result?.message_id || 0) || null;
        item.lastMessageId = id; item.pendingMessageIds = [...new Set([...(item.pendingMessageIds || []), id].filter(Boolean))].slice(-50); item.lastSentAt = now();
        if (item.kind === 'milana-weekly' && item.awaitingAck) {
            item.nextAt = now() + item.reminderDelayMinMs + Math.floor(random() * (item.reminderDelayMaxMs - item.reminderDelayMinMs + 1));
        } else if (item.kind === 'milana-weekly') {
            item.awaitingAck = true;
            item.nextAt = now() + item.reminderDelayMinMs + Math.floor(random() * (item.reminderDelayMaxMs - item.reminderDelayMinMs + 1));
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
        persist();
    }
    async function sendHelpNudge(item) {
        const result = await api.sendMessage({ chatId: item.chatId, text: buildReminderHelpNotice(item.name), replyMarkup: reminderHelpMarkup(item.id) });
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
        if (busy || !api) return; busy = true;
        try {
            for (const session of state.eventSessions.slice()) {
                if (Number(session.expiresAt) > now()) continue;
                try { await api.sendMessage({ chatId: session.chatId, text: '⏳ Время настройки напоминания истекло. Напоминание не создано. Открой событие и нажми кнопку настройки ещё раз.' }); }
                catch (error) { console.warn('[TELEGRAM EVENT REMINDER EXPIRY NOTICE ERROR]', session.id, error?.message || error); }
                state.eventSessions = state.eventSessions.filter(item => item !== session);
                persist();
            }
            for (const item of state.reminders) {
                if (!item.active || (!item.eventReminder && Number(item.nextAt || 0) > now()) || (item.eventReminder && Number(item.nextAt || 0) > now() && Number(item.nextEventCheckAt || 0) > now())) continue;
                if (item.eventReminder && typeof resolveEvent === 'function') {
                    let currentEvent = null;
                    try { currentEvent = await resolveEvent(item.eventSourceType, item.eventId); } catch (error) { console.warn('[TELEGRAM EVENT REMINDER REFRESH ERROR]', item.id, error?.message || error); item.nextAt = now() + 300_000; persist(); continue; }
                    item.nextEventCheckAt = now() + 60 * 60_000;
                    const version = currentEvent ? String(currentEvent.eventDate || '') + 'T' + String(currentEvent.eventTime || '') : '';
                    if (!currentEvent) {
                        item.active = false; item.cancelledAt = now(); item.cancelReason = 'event-unavailable'; persist();
                        await api.sendMessage({ chatId: item.chatId, text: 'ℹ️ Напоминание отменено: событие «' + item.text.replace(/^Событие:\s*/u, '') + '» удалено или уже прошло.' }).catch(() => {});
                        continue;
                    }
                    if (version !== item.eventVersion) {
                        if (item.eventRule?.explicit) {
                            item.active = false; item.cancelledAt = now(); item.cancelReason = 'explicit-schedule-event-changed'; persist();
                            await api.sendMessage({ chatId: item.chatId, text: 'ℹ️ Событие изменилось, поэтому напоминание с явно выбранной датой отменено. Настрой его заново по актуальной карточке.' }).catch(() => {});
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
        if (context?.platform !== 'telegram') return false;
        const callback = context.callbackQuery || context.message?.callback_query || null;
        const data = String(callback?.data || '').trim();
        if (/^evrem:/u.test(data)) return handleEventReminderCallback(context, data);
        if (!/^(?:remdone|remedit|remconfirm|remrevise|remcancel|remaiproposal|remlist):/u.test(data) && !HELP_ACK_DATA.test(data)) return false;
        const chatId = String(context.externalPeerId || '');
        const userId = String(context.externalSenderId || '');
        await context.answerCallbackQuery?.().catch(() => {});
        if (!context.isDM) return true;
        const listAction = data.match(/^remlist:(delete|edit):(.+)$/u);
        if (listAction) {
            const item = state.reminders.find(entry => entry.id === listAction[2]);
            if (!item || !canManageReminder(context, item)) { await context.send('Это напоминание недоступно для управления.'); return true; }
            if (listAction[1] === 'edit') {
                state.edits = state.edits.filter(edit => edit.reminderId !== item.id || !owns(edit, context));
                const edit = { chatId: String(context.externalPeerId), userId: String(context.externalSenderId), reminderId: item.id, revision: Number(item.revision || 0), token: randomUUID(), expiresAt: now() + 86_400_000, proposal: null };
                state.edits.push(edit); persist(); await showEditHelp(context, edit, item); return true;
            }
            const previousCreator = item.creatorUserId || item.userId;
            item.active = false; item.deletedAt = now(); item.deletedBy = String(context.externalSenderId || ''); item.pendingMessageIds = []; item.revision = Number(item.revision || 0) + 1; state.edits = state.edits.filter(edit => edit.reminderId !== item.id); persist();
            await context.send('✅ Напоминание удалено.');
            if (previousCreator && previousCreator !== String(context.externalSenderId || '') && api?.sendMessage) await api.sendMessage({ chatId: previousCreator, text: 'ℹ️ Напоминание удалено другим пользователем:\n' + (item.text || 'Отправить вложение') + '\nПервое: ' + formatAt(item.nextAt) }).catch(() => {});
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
            const reminder = { id: 'rem-' + now() + '-' + Math.floor(random() * 1_000_000), kind: 'user', ...recipient, text: parsed.content, times: parsed.times.slice(), nextAt: parsed.times[0], remaining: parsed.count, intervalMs: parsed.intervalMs, cadence: parsed.cadence, schedule: parsed.schedule, cycleDay: parsed.schedule?.anchorDay || null, active: true, awaitingAck: parsed.count === null, pendingMessageIds: [], lastMessageId: null, timeZone };
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
        const item = state.reminders.find(entry => entry.id === reminderId && ((entry.chatId === chatId && entry.userId === userId) || canManageAll(context)));
        if (!item) { await context.send('Это напоминание уже не найдено.'); return true; }
        const messageId = Number(callback?.message?.message_id || context.conversationMessageId || 0);
        if (!(item.pendingMessageIds || []).includes(messageId)) {
            await context.send('Это сообщение уже подтверждено или относится к прежнему расписанию.'); return true;
        }
        if (data.startsWith('remedit:')) {
            state.edits = state.edits.filter(edit => !owns(edit, context));
            const edit = { chatId, userId, reminderId, revision: Number(item.revision || 0), token: randomUUID(), expiresAt: now() + 86_400_000, proposal: null };
            state.edits.push(edit); persist(); await showEditHelp(context, edit, item); return true;
        }
        completeReminder(item);
        await context.send(item.kind === 'milana-weekly' ? '✅ Отметила. Следующее еженедельное напоминание будет через неделю.' : '✅ Напоминание остановлено.');
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
        const token = randomUUID();
        state.aiProposals = state.aiProposals.filter(item => !(item.chatId === String(context.externalPeerId) && item.userId === String(context.externalSenderId)));
        state.aiProposals.push({ token, chatId: String(context.externalPeerId), userId: String(context.externalSenderId), command: candidate, parsed, expiresAt: now() + 15 * 60_000 });
        persist();
        await context.send({ message: ['Синтаксис уточнён ИИ. Предлагаю установить так:', '«' + parsed.content + '»', 'Команда: ' + candidate, 'Первое срабатывание: ' + formatAt(parsed.times[0]), 'Если всё верно, подтвердите установку.'].join('\n'), replyMarkup: { inline_keyboard: [[{ text: 'Установить', callback_data: 'remaiproposal:confirm:' + token }], [{ text: 'Изменить', callback_data: 'remaiproposal:revise:' + token }]] } });
        return true;
    }
    async function handleIncoming(context) {
        if (context?.platform !== 'telegram') return false;
        const text = normalize(context.originalText || context.text); const replyId = Number(context.replyMessage?.conversationMessageId || 0);
        const eventSession = context.isDM && eventSessionFor(context);
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
                completeReminder(item); await context.send('✅ Повторы остановлены.'); return true;
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
        const reminder = { id: 'rem-' + now() + '-' + Math.floor(random() * 1_000_000), kind: 'user', creatorUserId: String(context.externalSenderId || ''), creatorName: isOwner(context) ? 'Игорь' : isMilana(context) ? 'Милана' : '', ...recipient, text: parsed.content, deliveryKind: parsed.deliveryKind || 'text', attachmentMode: parsed.attachmentMode || 'any', sourceChatId: sourceMessage ? String(context.sourceChatId) : '', sourceMessageId: sourceMessage ? Number(context.sourceMessageId) : null, ...preparedAttachment, attachmentIndex: 0, times: parsed.times.slice(), nextAt: parsed.times[0], remaining: parsed.count, intervalMs: parsed.intervalMs, cadence: parsed.cadence, schedule: parsed.schedule, cycleDay: parsed.schedule?.anchorDay || null, active: true, awaitingAck: parsed.count === null, pendingMessageIds: [], lastMessageId: null, timeZone };
        state.reminders.push(reminder); persist(); await context.send('✅ Напоминание сохранено. Первое: ' + new Date(reminder.nextAt).toLocaleString('ru-RU', { timeZone }) + '. Чтобы остановить повторы, ответьте «сделала» именно на сообщение напоминания.'); return true;
    }
    function start() { ensureMilanaReminder(); ensureHelpNudges(); if (!timer) { timer = setInterval(() => { void tick(); }, 15_000); timer.unref?.(); void tick(); } }
    function stop() { if (timer) clearInterval(timer); timer = null; }
    return { start, stop, tick, handleIncoming, handleCallback, beginEventReminder, ensureMilanaReminder, ensureHelpNudges, getState: () => JSON.parse(JSON.stringify(state)) };
}
