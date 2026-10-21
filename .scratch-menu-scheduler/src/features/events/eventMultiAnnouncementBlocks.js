const VISION_FIELD_LINE = /^(?:\[IMAGE\s+\d+\]|(?:Тип изображения|Это афиша события|Уверенность афиши|Читаемость текста|Название|Дата|Даты|Время|Начало|Окончание|Место|Площадка|Город|Насел[её]нный пункт|Адрес|Участники|Исполнители|Артисты|Цена|Возраст|Программа|Распознанный текст|OCR|Причина)\s*:)/iu;

const NUMERIC_DATE = /\b([0-3]?\d)\.([01]?\d)(?:\.((?:20)?\d{2}))?\b/gu;
const NAMED_DATE = /(?<![\p{L}\p{N}])([0-3]?\d)\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?!\p{L})/giu;
const ORDINAL_NAMED_DATE = /(?<![\p{L}\p{N}])(?:двадцать\s+|тридцать\s+)?(?:первое|второе|третье|четвертое|пятое|шестое|седьмое|восьмое|девятое|десятое|одиннадцатое|двенадцатое|тринадцатое|четырнадцатое|пятнадцатое|шестнадцатое|семнадцатое|восемнадцатое|девятнадцатое|двадцатое|тридцатое)\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)(?!\p{L})/giu;

function normalizedLines(value) {
    return String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .split('\n')
        .map((line) => line.replace(/[\t\u00a0]+/gu, ' ').replace(/\s{2,}/gu, ' ').trim())
        .filter((line) => line && !VISION_FIELD_LINE.test(line));
}

function validCalendarDay(day, month, year = 2024) {
    const date = new Date(Date.UTC(year, month - 1, day));
    return date.getUTCFullYear() === year && date.getUTCMonth() === month - 1 && date.getUTCDate() === day;
}

export function findAnnouncementDateSignals(value) {
    const text = normalizedLines(value).join('\n');
    const signals = [];
    for (const match of text.matchAll(NUMERIC_DATE)) {
        const day = Number(match[1]);
        const month = Number(match[2]);
        const providedYear = match[3] ? Number(match[3]) : 2024;
        const year = providedYear < 100 ? 2000 + providedYear : providedYear;
        if (day >= 1 && day <= 31 && month >= 1 && month <= 12 && validCalendarDay(day, month, year)) {
            signals.push({ raw: match[0], key: `${day}.${month}`, offset: match.index ?? 0 });
        }
    }
    for (const match of text.matchAll(NAMED_DATE)) {
        signals.push({
            raw: match[0],
            key: String(match[0]).toLowerCase().replace(/\s+/gu, ' ').trim(),
            offset: match.index ?? 0,
        });
    }
    for (const match of text.matchAll(ORDINAL_NAMED_DATE)) {
        signals.push({
            raw: match[0],
            key: match[0].toLowerCase().replace(/\s+/gu, ' ').trim(),
            offset: match.index ?? 0,
        });
    }
    signals.sort((left, right) => left.offset - right.offset);
    const seen = new Set();
    return signals.filter((item) => {
        if (seen.has(item.key)) return false;
        seen.add(item.key);
        return true;
    });
}

function lineDateSignals(line) {
    return findAnnouncementDateSignals(line);
}

/**
 * Convert a text schedule into ordered date-led blocks. A line containing a new
 * date starts a new block; following lines belong to it until the next date.
 * Vision/OCR fact records are deliberately excluded: image metadata validates
 * the resulting cards later and never decides how many text events exist.
 */
export function buildSequentialAnnouncementBlocks(value) {
    const lines = normalizedLines(value);
    const preamble = [];
    const blocks = [];
    let current = null;

    for (const line of lines) {
        const dates = lineDateSignals(line);
        if (dates.length) {
            if (current) blocks.push(current);
            current = {
                order: blocks.length + 1,
                dateSignals: dates.map((item) => item.raw),
                lines: [line],
            };
            continue;
        }
        if (current) current.lines.push(line);
        else preamble.push(line);
    }
    if (current) blocks.push(current);

    return {
        preamble: preamble.join('\n').trim(),
        blocks: blocks.map((block, index) => ({
            order: index + 1,
            dateSignals: block.dateSignals,
            text: block.lines.join('\n').trim(),
        })),
        distinctDateSignals: findAnnouncementDateSignals(value).length,
    };
}
