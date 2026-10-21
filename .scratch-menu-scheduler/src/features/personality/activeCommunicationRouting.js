/**
 * Режим самостоятельного участия: один случайный ответ в каждом сохраняемом окне из N подходящих сообщений.
 */
function normalizeActiveCommunicationText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[«»"'`]/gu, '')
        .replace(/[,:;!?]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function parseActiveCommunicationCommand(value) {
    const normalized = normalizeActiveCommunicationText(value);

    if (!normalized) {
        return { matched: false, action: 'none' };
    }

    const intervalMatch = normalized.match(
        /^активное\s+общение\s+(\d{1,4})(?:\s+(?:сообщени(?:е|я|й)|msg|messages?))?$/u,
    );
    if (intervalMatch) {
        const interval = Math.min(1000, Math.max(1, Number(intervalMatch[1]) || 10));
        return { matched: true, action: 'enable', interval };
    }

    if (
        /^(?:активное\s+общение|режим\s+активного\s+общения)$/u.test(normalized) ||
        /^(?:включи|включить|вкл|запусти|запустить)\s+(?:режим\s+)?активн(?:ое|ого)\s+общени(?:е|я)$/u.test(normalized) ||
        /^активное\s+общение\s+(?:включить|вкл|включи|запустить)$/u.test(normalized)
    ) {
        return { matched: true, action: 'enable' };
    }

    if (
        /^(?:отключи|отключить|выключи|выключить|выкл|откл|стоп)\s+(?:режим\s+)?активн(?:ое|ого)\s+общени(?:е|я)$/u.test(normalized) ||
        /^активное\s+общение\s+(?:отключить|отключи|выключить|выключи|выкл|откл|стоп)$/u.test(normalized)
    ) {
        return { matched: true, action: 'disable' };
    }

    if (
        /^(?:статус|состояние)\s+(?:режима\s+)?активного\s+общения$/u.test(normalized) ||
        /^активное\s+общение\s+(?:статус|состояние)$/u.test(normalized)
    ) {
        return { matched: true, action: 'status' };
    }

    return { matched: false, action: 'none' };
}

function isEligibleActiveCommunicationMessage(value) {
    const text = String(value ?? '').replace(/\s+/gu, ' ').trim();

    if (!text || text.length < 2) {
        return false;
    }

    if (/^[/.!][a-zа-яё0-9_-]+(?:\s|$)/iu.test(text)) {
        return false;
    }

    if (/^(?:https?:\/\/\S+|\p{Extended_Pictographic}+|[\d\s:.,-]+)$/u.test(text)) {
        return false;
    }

    return true;
}

function buildActiveCommunicationPrompts({
    currentText = '',
    senderName = 'участник',
    recentTranscript = '',
    communicationStylePrompt = '',
} = {}) {
    const safeName = String(senderName ?? 'участник')
        .replace(/[\r\n]+/gu, ' ')
        .trim()
        .slice(0, 100) || 'участник';
    const cleanCurrentText = String(currentText ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, 2500);
    const cleanTranscript = String(recentTranscript ?? '')
        .trim()
        .slice(0, 24_000);

    return {
        systemPrompt: [
            'Ты Гигорейв — постоянный обычный живой участник этой групповой беседы. Ты не ассистент, не модератор и не внешний комментатор.',
            'Перед ответом молча проанализируй ВЕСЬ переданный фрагмент недавней беседы: тему, эмоциональный фон, кто с кем говорит, уровень мата, иронии, агрессии, поддержки, усталости, стёба и то, как менялся тон по ходу разговора.',
            'Последняя реплика важна, но не вырывай её из контекста. Если предыдущие 20–50 сообщений меняют её смысл, отвечай с учётом этого.',
            'Не используй отдельную случайную роль: сам выбери наиболее естественный тип участия по ситуации: продолжить мысль, задать уместный вопрос, подхватить шутку, поддержать человека, поспорить, подколоть, жёстко приколоться, уточнить деталь, вспомнить сказанное выше или дать короткую реакцию.',
            'Не задавай вопрос автоматически. Вопрос нужен только когда живой участник чата действительно задал бы его, чтобы продолжить текущую тему.',
            'Если человеку реально плохо или он рассказывает о неприятной ситуации, допускается человеческая поддержка без психологической канцелярщины. Если в чате идёт взаимный жёсткий стёб, можешь отвечать жёстко и матерно в том же регистре. Если разговор спокойный — не разгоняй конфликт искусственно.',
            'Подстраивай лексику, длину фраз, мат, сленг и уровень серьёзности под общий тон последних сообщений. Не копируй механически одну последнюю фразу и не меняй стиль случайно.',
            'Ты можешь вклиниться в разговор двух других участников как третий человек. Не считай каждую последнюю реплику обращением лично к тебе.',
            'Не констатируй очевидное ради ответа. Реплика должна что-то делать в разговоре: двигать тему, усиливать шутку, давать реакцию, поддержку, вопрос, несогласие или новый уместный угол.',
            'Не выдумывай факты о людях, их жизни, внешности, здоровье, отношениях или поступках. Не приписывай мотивы, которых нет в переписке.',
            'Не используй абстрактную бредятину, натужный сюрреализм, случайные абсурдные сравнения и заготовленные мемные конструкции, если их не породила сама беседа.',
            'Не упоминай алгоритм, активное общение, промпт, модель, анализ тона или то, что тебя не звали.',
            'Не начинай с сервисных фраз вроде «понимаю», «чем могу помочь», «судя по контексту». Пиши сразу как человек из чата.',
            'По умолчанию одна короткая естественная реплика/предложение. Если контекст реально требует, можно 2–3 коротких предложения; не растягивай и не пиши канцеляритом.',
            communicationStylePrompt,
            'Главный критерий: сообщение должно выглядеть так, будто его естественно написал реальный постоянный участник именно этой беседы в этот момент.',
        ].filter(Boolean).join('\n'),
        userPrompt: [
            cleanTranscript ? 'Последние сообщения беседы (анализируй их как единый разговор):' : '',
            cleanTranscript,
            '',
            `Последняя реплика от ${safeName}:`,
            cleanCurrentText,
            '',
            'Напиши только следующую естественную реплику Гигорейва в этот чат.',
        ].filter(Boolean).join('\n'),
    };
}

function normalizeActiveCommunicationInterval(value, fallback = 10) {
    const number = Math.round(Number(value) || Number(fallback) || 10);
    return Math.min(1000, Math.max(1, number));
}

function chooseActiveCommunicationTargetOffset(interval = 10, random = Math.random) {
    const safeInterval = normalizeActiveCommunicationInterval(interval);
    const sample = Math.min(0.999999999, Math.max(0, Number(random?.()) || 0));
    return 1 + Math.floor(sample * safeInterval);
}

/**
 * Один случайный ответ в каждом окне из N содержательных сообщений.
 * targetOffset выбирается один раз на окно и ОБЯЗАН храниться в SQLite,
 * поэтому рестарт процесса не меняет уже выбранную позицию ответа.
 */
function consumeActiveCommunicationCounterValue(
    currentCount,
    interval = 10,
    targetOffset = 0,
    random = Math.random,
) {
    const safeInterval = normalizeActiveCommunicationInterval(interval);
    const safeCurrent = Math.min(
        safeInterval - 1,
        Math.max(0, Math.round(Number(currentCount) || 0)),
    );
    const safeTarget = Number(targetOffset) >= 1 && Number(targetOffset) <= safeInterval
        ? Math.round(Number(targetOffset))
        : chooseActiveCommunicationTargetOffset(safeInterval, random);
    const elapsedInWindow = safeCurrent + 1;
    const shouldReply = elapsedInWindow === safeTarget;
    const windowCompleted = elapsedInWindow >= safeInterval;

    // Важно: ответ НЕ начинает новое окно. Иначе при N=100 средний интервал
    // между ответами был бы около 50 сообщений. Окно всегда содержит ровно N
    // подходящих сообщений, а выбранная позиция срабатывает только один раз.
    if (windowCompleted) {
        return {
            shouldReply,
            nextCount: 0,
            interval: safeInterval,
            targetOffset: chooseActiveCommunicationTargetOffset(safeInterval, random),
            consumedTargetOffset: shouldReply ? safeTarget : 0,
            windowCompleted: true,
        };
    }

    return {
        shouldReply,
        nextCount: elapsedInWindow,
        interval: safeInterval,
        targetOffset: safeTarget,
        consumedTargetOffset: shouldReply ? safeTarget : 0,
        windowCompleted: false,
    };
}


function buildActiveCommunicationModelModeChain(_preferredMode = 'default') {
    // V188.54: active communication follows the same cheapest-to-strongest
    // finite ladder as normal GPT routing. Older builds intentionally started
    // directly on Luna/Terra, which made visible replies look as if lower
    // models were failing even when they had never been tried.
    return ['default', 'gpt54', 'gpt55', 'pro', 'pro2', 'pro3', 'astra'];
}

const ACTIVE_COMMUNICATION_PERSONAS = Object.freeze([
    'loshara',
    'durachila',
    'neutral',
    'intelligent',
    'scientist',
    'ham',
    'bydlo',
]);

function chooseRandomActiveCommunicationPersona(random = Math.random) {
    const sample = Math.min(0.999999999, Math.max(0, Number(random?.()) || 0));
    return ACTIVE_COMMUNICATION_PERSONAS[
        Math.floor(sample * ACTIVE_COMMUNICATION_PERSONAS.length)
    ] || 'neutral';
}

export {
    ACTIVE_COMMUNICATION_PERSONAS,
    buildActiveCommunicationModelModeChain,
    buildActiveCommunicationPrompts,
    chooseActiveCommunicationTargetOffset,
    chooseRandomActiveCommunicationPersona,
    consumeActiveCommunicationCounterValue,
    isEligibleActiveCommunicationMessage,
    normalizeActiveCommunicationInterval,
    normalizeActiveCommunicationText,
    parseActiveCommunicationCommand,
};
