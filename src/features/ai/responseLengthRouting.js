/**
 * Ограничения длины ответа: короткий базовый профиль, подробный профиль и расширенный профиль pro/натала.
 */
const DETAILED_RESPONSE_PATTERN = /(?:^|[\s,.;:!?()\[\]{}«»"'`-])(?:подробно|подробнее|детально|развернуто|развёрнуто|максимально\s+(?:подробно|глубоко)|глубок(?:ий|ая|ое|ую)\s+(?:разбор|анализ)|полный\s+тех(?:нический)?\s*расч[её]т|максимальн(?:ый|ая|ое|ую)\s+(?:расч[её]т|техрасч[её]т))(?=$|[\s,.;:!?()\[\]{}«»"'`-])/iu;

export const RESPONSE_LENGTH_PROFILES = Object.freeze({
    concise: Object.freeze({
        name: 'concise',
        maxParagraphs: 1,
        maxCharacters: 1200,
        maxCompletionTokens: 1000,
    }),
    standard: Object.freeze({
        name: 'standard',
        maxParagraphs: 2,
        maxCharacters: 2800,
        maxCompletionTokens: 1800,
    }),
    detailed: Object.freeze({
        name: 'detailed',
        maxParagraphs: 5,
        maxCharacters: 6500,
        maxCompletionTokens: 2800,
    }),
    pro: Object.freeze({
        name: 'pro',
        maxParagraphs: 16,
        maxCharacters: 14000,
        maxCompletionTokens: 10000,
    }),
    prashna: Object.freeze({
        name: 'prashna',
        maxParagraphs: 3,
        maxCharacters: 3200,
        maxCompletionTokens: 1800,
    }),
    prashnaDetailed: Object.freeze({
        name: 'prashna-detailed',
        maxParagraphs: 14,
        maxCharacters: 12000,
        maxCompletionTokens: 8000,
    }),
    prashnaPro: Object.freeze({
        name: 'prashna-pro',
        maxParagraphs: 16,
        maxCharacters: 14000,
        maxCompletionTokens: 10000,
    }),
    natal: Object.freeze({
        name: 'natal',
        maxParagraphs: 16,
        maxCharacters: 14000,
        maxCompletionTokens: 10000,
    }),
});

const PRO_LENGTH_CONTEXT_PATTERN = /(?:10\s*000|\d[\d\s.,]{2,}\s*(?:слов|знаков|символов)|тысяч\w*\s+(?:слов|знаков|символов)|страниц\w*|объ[её]м\w*|лимит\w*|длин\w*|формат\w*)/iu;
const PRO_LENGTH_DEFLECTION_PATTERN = /(?:не\s+(?:влез\w*|помещ\w*|умещ\w*|взлет\w*|буду\s+(?:писать|делать|разворачивать)|стану\s+(?:писать|делать))|слишком\s+(?:длин\w*|больш\w*)|могу\s+(?:вместо\s+этого\s+)?(?:сделать|написать|дать|предложить)|(?:давай|лучше)\s+(?:сначала\s+)?(?:выберем|уточним|разобь[её]м|сократим)|(?:уточни|выбери|задай)\s+(?:формат|объ[её]м|часть)|(?:продолжу|допишу)\s+(?:потом|следующим\s+сообщением|по\s+команде))/iu;

/**
 * Единый контракт длины для Luna, Terra и Sol. Ограничение относится ко всему
 * ответу, а не к одному сообщению платформы: транспорт сам делит текст на
 * несколько нативных reply-частей.
 */
export function buildProResponseLengthRules(platformLabel = 'VK или Telegram') {
    const platform = String(platformLabel || 'VK или Telegram').trim();

    return [
        `В режимах pro, pro2 и pro3 разрешён законченный ответ объёмом до двух больших страниц в ${platform}; при необходимости транспорт автоматически разделит его на несколько сообщений.`,
        'Для pro-режима не действует обычное правило 8–10 предложений и не действует лимит одного сообщения платформы.',
        'Две страницы — верхняя граница, а не обязательный объём: простой вопрос можно раскрыть короче, сложный — подробно до этого предела.',
        'Если пользователь просит 10 000 слов, восемь страниц или любой объём больше максимума, не спорь с ним о длине, не отказывайся, не проси выбрать другой формат и не обещай продолжение. Молча дай максимально полный и законченный ответ в пределах двух больших страниц, сохранив главное.',
        'Не начинай ответ с обсуждения лимитов, количества слов, невозможности «вместить» текст или предложений разбить работу на части.',
    ];
}

/**
 * Выявляет короткий мета-ответ, в котором модель обсуждает объём вместо
 * выполнения pro-запроса. Длинный содержательный ответ не перегенерируется,
 * даже если внутри него случайно встретилось слово «страница».
 */
export function isProLengthDeflection(text, {
    maximumUsefulCharacters = 3600,
} = {}) {
    const source = String(text ?? '').trim();

    if (!source || source.length > maximumUsefulCharacters) {
        return false;
    }

    return (
        PRO_LENGTH_CONTEXT_PATTERN.test(source) &&
        PRO_LENGTH_DEFLECTION_PATTERN.test(source)
    );
}

export function buildProLengthRecoveryInstruction(platformLabel = 'VK или Telegram') {
    const platform = String(platformLabel || 'VK или Telegram').trim();

    return [
        'ПРЕДЫДУЩИЙ ОТВЕТ БЫЛ ОШИБОЧНЫМ: он обсуждал размер задачи вместо её выполнения.',
        `Сейчас сразу выполни исходный запрос. В ${platform} разрешено отправить до двух больших страниц несколькими сообщениями.`,
        'Если исходно запрошено больше, молча отрежь только избыточный объём и выдай лучший законченный вариант в пределах двух страниц.',
        'Не упоминай лимит, невозможность вместить текст, число слов, альтернативный формат, продолжение позже или просьбу уточнить объём.',
    ].join('\n');
}

export function isDetailedResponseRequest(text) {
    return DETAILED_RESPONSE_PATTERN.test(String(text ?? ''));
}

export function getResponseLengthProfile(text, {
    concise = false,
    prashna = false,
    natal = false,
    mode = 'default',
} = {}) {
    if (natal) {
        return RESPONSE_LENGTH_PROFILES.natal;
    }

    if (prashna) {
        if (['pro', 'pro2', 'pro3'].includes(mode)) {
            return RESPONSE_LENGTH_PROFILES.prashnaPro;
        }

        return isDetailedResponseRequest(text)
            ? RESPONSE_LENGTH_PROFILES.prashnaDetailed
            : RESPONSE_LENGTH_PROFILES.prashna;
    }

    if (concise && !['pro', 'pro2', 'pro3'].includes(mode)) {
        return RESPONSE_LENGTH_PROFILES.concise;
    }

    if (['pro', 'pro2', 'pro3'].includes(mode)) {
        return RESPONSE_LENGTH_PROFILES.pro;
    }

    return isDetailedResponseRequest(text)
        ? RESPONSE_LENGTH_PROFILES.detailed
        : RESPONSE_LENGTH_PROFILES.standard;
}

function normalizeParagraphs(text) {
    return String(text ?? '')
        .replace(/\r\n?/gu, '\n')
        .split(/\n\s*\n/gu)
        .map((paragraph) => paragraph.trim())
        .filter(Boolean);
}

function endsWithCompleteBoundary(text) {
    return /(?:[.!?…]|[)\]}>»"'`])$/u.test(String(text).trim());
}

function truncateAtNaturalBoundary(text, maxCharacters) {
    const source = String(text ?? '').trim();

    if (source.length <= maxCharacters) {
        return source;
    }

    const candidate = source.slice(0, maxCharacters + 1);
    let sentenceBoundary = -1;

    for (const match of candidate.matchAll(/[.!?…](?=\s|$)/gu)) {
        sentenceBoundary = match.index;
    }

    const boundaries = [
        candidate.lastIndexOf('\n\n'),
        candidate.lastIndexOf('\n'),
        sentenceBoundary,
    ];

    let cut = Math.max(...boundaries);

    if (cut < Math.floor(maxCharacters * 0.55)) {
        cut = candidate.lastIndexOf(' ', maxCharacters);
    }

    if (cut < Math.floor(maxCharacters * 0.55)) {
        cut = maxCharacters;
    }

    let result = candidate.slice(0, cut + 1).trim();

    if (!endsWithCompleteBoundary(result)) {
        result = result.replace(/[,:;\-–—\s]+$/gu, '').trim();
        result += '…';
    }

    return result;
}

function mergeOverflowParagraphs(paragraphs, maxParagraphs) {
    if (paragraphs.length <= maxParagraphs) {
        return paragraphs;
    }

    const head = paragraphs.slice(0, Math.max(0, maxParagraphs - 1));
    const tail = paragraphs
        .slice(Math.max(0, maxParagraphs - 1))
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();

    return [...head, tail].filter(Boolean);
}

export function enforceResponseLength(text, profile) {
    const resolvedProfile = profile ?? RESPONSE_LENGTH_PROFILES.standard;
    const paragraphs = mergeOverflowParagraphs(
        normalizeParagraphs(text),
        resolvedProfile.maxParagraphs,
    );
    const combined = paragraphs.join('\n\n').trim();

    return truncateAtNaturalBoundary(
        combined,
        resolvedProfile.maxCharacters,
    );
}
