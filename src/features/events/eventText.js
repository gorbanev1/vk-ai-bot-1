/**
 * Нормализует и форматирует текст анонсов перед сохранением и показом.
 */
const UI_LINE_PATTERNS = [
    /^показать\s+(?:ещ[её]|полностью)(?:\s+\d+)?$/iu,
    /^действия$/iu,
    /^и$/iu,
    /^ещ[её]\s+\d+\s+автор(?:а|ов)?$/iu,
    /^и\s+ещ[её]\s+\d+\s+автор(?:а|ов)?$/iu,
    /^svg(?:\s*\d+)?$/iu,
    /^реклама$/iu,
    /^отправить\s+реакцию(?:\s+.+)?$/iu,
    /^выбор\s+реакции(?:\s+\d+)?$/iu,
    /^(?:нравится|комментировать|поделиться|ответить|редактировать|удалить|закрепить|скопировать\s+ссылку|ещ[её])(?:\s+\d+)?$/iu,
    /^\d+\s*(?:просмотр(?:а|ов)?|реакци(?:я|и|й)|комментари(?:й|я|ев)|репост(?:а|ов)?)$/iu,
    /^\d+\s*(?:сек|с|мин|м|час(?:а|ов)?|ч|дн(?:я|ей)?|д|недел(?:я|и|ь)|нед|месяц(?:а|ев)?|мес|год(?:а|лет)?|г)\.?\s+назад$/iu,
    /^(?:сегодня|вчера)\s+(?:в\s+)?(?:[01]?\d|2[0-3]):[0-5]\d$/iu,
    /^картинка\s*:\s*(?:[a-z]:[\\/]|\.?\.?[\\/]|[\w.-]+[\\/])\S+$/iu,
];

const INLINE_UI_TAIL_PATTERNS = [
    /\s+показать\s+(?:ещ[её]|полностью)(?:\s+\d+)?\s+отправить\s+реакцию[\s\S]*$/iu,
    /\s+отправить\s+реакцию\s+[«"']?лайк[»"']?[\s\S]*$/iu,
    /\s+выбор\s+реакции(?:\s+\d+)?(?:\s+\d+\s*(?:сек|с|мин|м|ч|д|нед|мес|г)\.?\s+назад)?\s*$/iu,
    /\s+показать\s+(?:ещ[её]|полностью)(?:\s+\d+)?\s*$/iu,
];

function isUiLine(line) {
    return UI_LINE_PATTERNS.some((pattern) => pattern.test(line));
}

export function cleanVkEventText(value, maximum = 12_000) {
    let source = String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n[ \t]+/gu, '\n');

    for (const pattern of INLINE_UI_TAIL_PATTERNS) {
        source = source.replace(pattern, '');
    }

    const lines = source
        .split('\n')
        .map((line) => line.replace(/[ \t]{2,}/gu, ' ').trim())
        .filter((line) => line && !isUiLine(line));

    return lines
        .join('\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, maximum);
}

export function paragraphizeEventText(value, maximum = 12_000) {
    let source = cleanVkEventText(value, maximum);

    if (!source) {
        return '';
    }

    source = source
        .replace(/\s+(?=(?:анонс|когда|дата|время|где|место|адрес|площадка|кто|участники|цена|стоимость|вход|купить\s+билет|регистрация|телеграм|telegram|vk)\s*(?::|;|：|[—–-]))/giu, '\n')
        .replace(/\s+(?=(?:для\s+этого\s+нужно|итоги\s+(?:конкурса|розыгрыша)|условия\s+(?:конкурса|розыгрыша)|второе\s+место|подробности|билеты|начало|двери)(?=\s|:|$))/giu, '\n')
        .replace(/\s+(?=https?:\/\/)/giu, '\n')
        .replace(/\n{3,}/gu, '\n\n');

    const paragraphs = source
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean);

    return paragraphs.join('\n').slice(0, maximum);
}

export function cleanEventTitle(value, maximum = 220) {
    return cleanVkEventText(value, maximum)
        .replace(/^анонс\s*:\s*/iu, '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, maximum);
}
