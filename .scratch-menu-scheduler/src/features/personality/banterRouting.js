/**
 * Ограниченная адресная перепалка: распознаёт выпад и формирует дерзкий ответ без угроз и травли по признакам.
 */
const STRONG_ATTACK_PATTERN = /(?:соси|сосни|хуй|хуя|хуе|ебал|ебать|еблан|долбоеб|долбоёб|мудак|мразь|пидор|пидорас|гандон|уебок|уёбок|чмо|тварь|заткнись|иди\s+нахуй|пошел\s+нахуй|пошёл\s+нахуй|сдохни)/iu;
const MILD_ATTACK_PATTERN = /(?:лох|лошара|дурак|дебил|идиот|тупой|тупица|балбес|клоун|помойка|говно|дерьмо|жалкий|бесполезный)/iu;
const BOT_REFERENCE_PATTERN = /(?:гигорейв|бот|тебя|ты|твой|твоя|твоё|твою|тебе)/iu;
const DIRECT_PROVOCATION_PATTERN = /(?:^(?:а\s+ну\s+)?(?:покажи|показывай|лижи|соси|нюхай|целуй|засунь|иди|пош[её]л)|(?:ты|бот|гигорейв)\s+(?:жалк|туп|дебил|лох|чмо|мудак|еблан)|(?:анус|жоп(?:а|у|ой)?|хуй|член|яйца)\s*(?:покажи|соси|лижи)?)/iu;

function normalizeBanterText(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 2000);
}

function classifyAttackHeuristically(value, { directedAtBot = false } = {}) {
    const text = normalizeBanterText(value);

    if (!text) {
        return { result: 'no', confidence: 1, reason: 'empty' };
    }

    if (STRONG_ATTACK_PATTERN.test(text)) {
        return {
            result: directedAtBot || BOT_REFERENCE_PATTERN.test(text)
                ? 'yes'
                : 'uncertain',
            confidence: directedAtBot ? 0.98 : 0.72,
            reason: 'strong-language',
        };
    }

    if (MILD_ATTACK_PATTERN.test(text)) {
        return {
            result: directedAtBot || BOT_REFERENCE_PATTERN.test(text)
                ? 'yes'
                : 'uncertain',
            confidence: directedAtBot ? 0.9 : 0.62,
            reason: 'mild-insult',
        };
    }

    if (
        /^(?:нет|неа|ладно|понял|ок|хорошо|отстань|хватит|замолчи)[.!\s]*$/iu.test(text) ||
        /^(?:ладно|ок|хорошо)[,\s]+(?:понял|ясно|договорились)[.!\s]*$/iu.test(text)
    ) {
        return { result: 'no', confidence: 0.92, reason: 'deescalation' };
    }

    return { result: 'uncertain', confidence: 0.4, reason: 'needs-model' };
}

function isDirectPersonaProvocation(value, { directedAtBot = true } = {}) {
    if (!directedAtBot) {
        return false;
    }

    const text = normalizeBanterText(value);

    if (!text) {
        return false;
    }

    return (
        STRONG_ATTACK_PATTERN.test(text) ||
        MILD_ATTACK_PATTERN.test(text) ||
        DIRECT_PROVOCATION_PATTERN.test(text)
    );
}

function parseAttackClassifierResponse(value) {
    const normalized = String(value ?? '')
        .toLowerCase()
        .replace(/[^a-zа-яё]/giu, '')
        .trim();

    if (['attack', 'yes', 'да', 'выпад'].includes(normalized)) {
        return true;
    }

    if (['no', 'нет', 'neutral', 'нейтрально'].includes(normalized)) {
        return false;
    }

    return null;
}

function buildAttackClassifierPrompts({ text, directedAtBot = false } = {}) {
    return {
        systemPrompt: [
            'Определи, является ли сообщение участника выпадом против чат-бота: прямым оскорблением, унизительным приказом, провокацией или агрессивной насмешкой.',
            'Обычная критика, несогласие, мат не в адрес бота, дружеская нейтральная шутка и просьба без нападения — не выпад.',
            `Сообщение ${directedAtBot ? 'явно обращено к боту' : 'может быть не обращено к боту'}.`,
            'Верни ровно ATTACK или NO без пояснений.',
        ].join(' '),
        userPrompt: normalizeBanterText(text),
    };
}

function buildBanterReplyPrompts({
    persona = 'bydlo',
    targetName = 'участник',
    incomingText = '',
    replyCount = 0,
} = {}) {
    const safeName = String(targetName ?? 'участник')
        .replace(/[\r\n]+/gu, ' ')
        .trim()
        .slice(0, 80) || 'участник';
    const stickyTurn = Number(replyCount) > 0 && Number(replyCount) % 3 === 2;
    const style = persona === 'durachila'
        ? [
            'Ответь откровенно тупо, примитивно, грубо и самоуверенно, будто неправильный вывод для тебя очевиден.',
            'Используй бытовую сломанную логику и тупую прямолинейность. Не пиши сюрреализм, говорящие предметы, случайные овощи и мягкую клоунаду.',
            stickyTurn
                ? 'Навязчиво цепляйся к одной конкретной детали его фразы и повторно делай из неё тупой, но понятный вывод.'
                : 'Не оправдывайся и не переходи в вежливый сервисный тон.',
        ]
        : [
            'Ответь максимально грубо, нагло, дерзко и холодно-цинично в пределах допустимого, с матом, придиркой и ситуативным оскорблением.',
            'Опирайся на конкретные слова собеседника. Не заменяй грубость милым абсурдным сравнением и не выдумывай фактов о нём.',
            stickyTurn
                ? 'Спокойно и навязчиво цепляйся к одной конкретной детали его фразы, усиливая холодную язвительность.'
                : 'Не оправдывайся и не переходи в вежливый сервисный тон.',
        ];

    return {
        systemPrompt: [
            'Ты отвечаешь в шуточной перепалке на выпад участника против чат-бота.',
            ...style,
            replyCount >= 2
                ? 'Это продолжение перепалки: ответ должен ощущаться навязчивым продолжением предыдущей линии, но не повторять дословно прошлые реплики.'
                : 'Это начало ответной перепалки.',
            'Можно использовать резкие ситуативные оскорбления, подколы, просторечие и мат в пределах допустимого.',
            'Нельзя угрожать, желать смерти или вреда, сексуально унижать, преследовать вне чата, раскрывать данные или атаковать защищённые и интимные личные признаки.',
            'Не используй длинные объяснения, но не обрубай мысль до односложной заготовки. Верни одну законченную реплику до 420 символов.',
        ].join(' '),
        userPrompt: [
            `Имя участника: ${safeName}`,
            `Его выпад: ${normalizeBanterText(incomingText)}`,
        ].join('\n'),
    };
}

function shouldKeepBanterActive({
    now,
    activeUntil,
    replyCount,
    maxReplies = 8,
} = {}) {
    return Number(activeUntil) > Number(now) && Number(replyCount) < maxReplies;
}

export {
    buildAttackClassifierPrompts,
    buildBanterReplyPrompts,
    classifyAttackHeuristically,
    isDirectPersonaProvocation,
    normalizeBanterText,
    parseAttackClassifierResponse,
    shouldKeepBanterActive,
};
