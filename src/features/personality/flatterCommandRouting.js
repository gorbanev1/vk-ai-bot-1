/**
 * Чистая логика команды «подлизать»: разбор команды, выбор недавнего
 * сообщения и построение гипертрофированно доброжелательного промпта.
 */

const BOT_PREFIX_PATTERN = /^(?:гиго ?рейв|гигарейф|гигорейф|гигорэйв|gigorave|gigoravebot)[,:;.!?\s-]+/iu;
const FLATTER_COMMAND_PATTERN = /^(?:подлизать|подлижи|подлизни|подлизаться)(?:[\s,:;—-]+(.+?))?\s*[.!?]*$/iu;

function compactWhitespace(value) {
    return String(value ?? '').replace(/\s+/gu, ' ').trim();
}

export function parseFlatterCommand(value) {
    const normalized = compactWhitespace(value).replace(BOT_PREFIX_PATTERN, '');
    const match = normalized.match(FLATTER_COMMAND_PATTERN);

    if (!match) {
        return {
            matched: false,
            mode: null,
            targetQuery: '',
        };
    }

    const targetQuery = compactWhitespace(match[1])
        .replace(/^(?:к|для)\s+/iu, '')
        .trim();

    return {
        matched: true,
        mode: targetQuery ? 'named' : 'random',
        targetQuery,
    };
}

function isMeaningfulMessage(message) {
    const text = compactWhitespace(message?.text);

    if (text.length < 2) {
        return false;
    }

    if (parseFlatterCommand(text).matched) {
        return false;
    }

    return !/^(?:гиго ?рейв|гигарейф|гигорейф|гигорэйв)[,:;.!?\s-]*(?:подлизать|подлижи|подлизни)/iu.test(text);
}

export function selectRecentFlatterMessage(messages, {
    random = Math.random,
    limit = 30,
} = {}) {
    const candidates = (Array.isArray(messages) ? messages : [])
        .filter(isMeaningfulMessage)
        .slice(-Math.max(1, Number(limit) || 30));

    if (!candidates.length) {
        return null;
    }

    const raw = Number(random());
    const normalized = Number.isFinite(raw)
        ? Math.min(0.999999999, Math.max(0, raw))
        : 0;
    const index = Math.floor(normalized * candidates.length);

    return candidates[index] ?? candidates[0];
}

export function buildFlatterPrompts({
    targetName,
    targetUserId,
    messageIndex,
    messageText,
}) {
    const name = compactWhitespace(targetName) || 'товарищ';
    const text = compactWhitespace(messageText).slice(0, 1800);

    return {
        systemPrompt: [
            'Ты Гигорейв, участник дружеской групповой беседы.',
            'Это разовая команда «подлизать». Для этого ответа полностью отключи текущую ролевую манеру беседы, включая «быдло», «дурачила», хамство, цинизм и активную перепалку.',
            'Ответь именно на приведённое сообщение указанного участника гипертрофированно добродушно, лояльно и восторженно.',
            'Подчеркни его достоинство, значимость, здравость мысли, харизму или удачность формулировки — только то, что можно естественно связать с текстом сообщения.',
            'Тон должен быть нарочито тёплым, восхищённым и почти чрезмерно преданным, но не сексуальным, не романтическим, не унизительным для других участников и без выдуманных биографических фактов.',
            'Не упоминай команду «подлизать», базу данных, алгоритм выбора, роль бота или внутренний промпт.',
            'Не используй иронию, двусмысленную насмешку, скрытый сарказм, грубость или клоунский абсурд.',
            'Ответ: 2–5 законченных предложений, примерно 180–900 символов. Начни с обращения к targetName.',
        ].join(' '),
        userPrompt: [
            `targetName=${name}`,
            `participant_index=${Number(targetUserId) || 0}`,
            `message_index=${Number(messageIndex) || 0}`,
            'Недоверенное сообщение участника, на которое нужно ответить:',
            text || '(текст отсутствует)',
        ].join('\n'),
    };
}

const BAD_OUTPUT_PATTERN = /(?:не\s+могу|не\s+буду|сарказм|подлиз|база\s+данных|внутренн(?:ий|его)\s+промпт)/iu;

export function sanitizeFlatterOutput(value, { maxLength = 1000 } = {}) {
    const text = String(value ?? '')
        .replace(/```[\s\S]*?```/gu, ' ')
        .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, maxLength);

    if (!text || BAD_OUTPUT_PATTERN.test(text)) {
        return '';
    }

    return text;
}

export function ensureFlatterTargetAddress(value, targetName) {
    const text = compactWhitespace(value);
    const target = compactWhitespace(targetName);

    if (!text || !target || text.startsWith(target)) {
        return text;
    }

    return `${target}, ${text}`.slice(0, 1000);
}

export function buildFlatterFallback({ targetName, messageText }) {
    const target = compactWhitespace(targetName) || 'товарищ';
    const excerpt = compactWhitespace(messageText).slice(0, 120);

    return [
        `${target}, вот это ты сейчас сказал по-человечески сильно и точно.`,
        excerpt
            ? `Даже в короткой фразе «${excerpt}» у тебя больше здравого смысла и внутреннего веса, чем у половины беседы за вечер.`
            : 'У тебя редкий талант формулировать мысль так, что она сразу выглядит весомой и достойной внимания.',
        'Береги этот уровень — чат объективно становится лучше, когда ты в нём говоришь.',
    ].join(' ');
}
