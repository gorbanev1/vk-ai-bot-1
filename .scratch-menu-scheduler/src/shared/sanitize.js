/**
 * Общая очистка текста перед отправкой во внешние модели.
 */
const START = String.raw`(?<![\p{L}\p{N}_])`;
const END = String.raw`(?![\p{L}\p{N}_])`;

function createRule(source, replacement) {
    return {
        pattern: new RegExp(
            `${START}(?:${source})${END}`,
            'giu',
        ),
        replacement,
    };
}

const replacementRules = [
    createRule(
        String.raw`(?:иди|пош(?:е|ё)л|пошла|пошли)\s+на\s*(?:хуй|хер|хрен)`,
        'уйди',
    ),
    createRule(
        String.raw`пош(?:е|ё)л\s+срат[\p{L}]*`,
        'отправился в туалет',
    ),
    createRule(String.raw`ни\s*хуя`, 'ничего'),
    createRule(String.raw`до\s*хуя`, 'очень много'),
    createRule(String.raw`на\s*хуя`, 'зачем'),
    createRule(
        String.raw`ху(?:й|я|ю|е|ё|ем|йн[\p{L}]*|ев[\p{L}]*|ёв[\p{L}]*)`,
        'грубое выражение',
    ),
    createRule(String.raw`пизд[\p{L}]*`, 'грубое выражение'),
    createRule(
        String.raw`(?:за|про|на|разъ|съ|у|вы)?(?:е|ё)б[\p{L}]*`,
        'грубое выражение',
    ),
    createRule(String.raw`бля[\p{L}]*`, 'чёрт'),
    createRule(
        String.raw`(?:долбо(?:е|ё)б|мудак|дебил|идиот)[\p{L}]*`,
        'глупец',
    ),
    createRule(
        String.raw`(?:мраз|ублюд|гандон)[\p{L}]*`,
        'неприятный человек',
    ),
    createRule(String.raw`су(?:ка|ки|кой|кам|ками)`, 'негодяй'),
    createRule(
        String.raw`(?:шлюх|пид(?:ор|ар|орас))[\p{L}]*`,
        'оскорбление',
    ),
    createRule(String.raw`срат[\p{L}]*`, 'отправиться в туалет'),
    createRule(String.raw`пер(?:д|н)[\p{L}]*`, 'испустил газы'),
    createRule(
        String.raw`(?:говн|дерьм)[\p{L}]*`,
        'нечто неприятное',
    ),
    createRule(String.raw`жоп[\p{L}]*`, 'зад'),
];

function normalizeSeparatedLetters(text) {
    return text.replace(
        /(?<![\p{L}\p{N}])(?:[\p{L}][\s*_.\-]+){2,}[\p{L}](?![\p{L}\p{N}])/giu,
        (fragment) => fragment.replace(/[\s*_.\-]+/g, ''),
    );
}

export function sanitizeForGigaChat(value) {
    if (typeof value !== 'string') {
        return '';
    }

    let result = normalizeSeparatedLetters(value);

    for (const rule of replacementRules) {
        result = result.replace(rule.pattern, rule.replacement);
    }

    return result
        .replace(/[ \t]{2,}/g, ' ')
        .replace(/\s+([,.!?;:])/g, '$1')
        .trim();
}
