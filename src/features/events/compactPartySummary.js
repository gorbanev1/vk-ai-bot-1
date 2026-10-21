const COMPACT_PARTY_KEYWORD = /(?:^|[^\p{L}\p{N}])(?:кратко|коротко|краткий\s+список|короткий\s+список)(?=$|[^\p{L}\p{N}])/iu;
const TICKET_CONTEXT = /(?:билет|tickets?|купить|касс|регистрац|бронь|заброниров|вход)/iu;
const PLATFORM_LINK = /^https?:\/\/(?:www\.)?(?:vk\.(?:ru|com)|t\.me|telegram\.me)\//iu;
const GIVEAWAY_NOISE = /(?:розыгрыш|конкурс|репост|репостом|вступить\s+во\s+встречу|точно\s+пойду|хочу\s+на\s+концерт|итоги\s+конкурса|призов|призовое\s+место|победител|разыгра|услови[яе]\s+(?:розыгрыша|конкурса))/iu;
const SERVICE_NOISE = /(?:полный\s+текст\s+сообщения|view\s+in\s+telegram|please\s+open\s+telegram|действия\s*:|источник\s*:)/iu;
const RAW_PLATFORM_NOISE = /(?:\bпоказать\s+ещ[её]\s+\d+|выбор\s+реакции|отправить\s+реакцию|пожаловаться|ответить|поделиться|прикрепить\s+фотографию|добавить\s+эмодзи|отправить\s*$|\b\d+\s+ч\s+назад|\b\d+\s+дн(?:я|ей)\s+назад)/iu;

function normalizeSpaces(value) {
    return String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/[ \t\u00a0]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

function cleanUrl(value) {
    return String(value ?? '')
        .trim()
        .replace(/[),.;!?]+$/u, '');
}

function isQticketsListingRoot(value) {
    try {
        const url = new URL(String(value || ''));
        const host = url.hostname.toLowerCase().replace(/^www\./u, '');
        if (!host.endsWith('qtickets.events')) return false;
        const path = url.pathname.replace(/^\/+|\/+$/gu, '').toLowerCase();
        return !path || ['events', 'afisha', 'poster', 'catalog'].includes(path);
    } catch {
        return false;
    }
}


function stripCompactNoiseSentences(value) {
    const source = normalizeSpaces(value);
    if (!source) return '';

    return source
        .split(/(?<=[.!?])\s+|\n+/u)
        .map((part) => part.trim())
        .filter(Boolean)
        .filter((part) => !GIVEAWAY_NOISE.test(part) && !SERVICE_NOISE.test(part))
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function getCompactSupportedTime(event) {
    const candidate = String(event?.timeLabel ?? event?.eventTime ?? '').trim();
    if (!candidate) return '';

    const simple = candidate.match(/^([01]?\d|2[0-3]):([0-5]\d)$/u);
    if (!simple) return candidate;

    const normalized = `${String(simple[1]).padStart(2, '0')}:${simple[2]}`;
    const source = [
        event?._compactTimeSource,
        event?.rawSource,
        event?.sourceText,
        event?.description,
    ].filter(Boolean).join(' ');

    if (!source) return '';
    const escaped = normalized.replace(':', '[:.]');
    const explicit = new RegExp(`(?:^|[^\\d.])${escaped}(?![.\\d])`, 'u');
    return explicit.test(source) ? normalized : '';
}

export function isCompactPartyRequest(value) {
    return COMPACT_PARTY_KEYWORD.test(normalizeSpaces(value));
}

export function extractTicketLink(event) {
    const explicit = [
        event?.ticketUrl,
        event?.ticketsUrl,
        event?.ticketLink,
        event?.bookingUrl,
    ]
        .map(cleanUrl)
        .find((url) => /^https?:\/\//iu.test(url) && !isQticketsListingRoot(url));

    if (explicit) return explicit;

    const source = normalizeSpaces(event?.description ?? '');
    const matches = [...source.matchAll(/https?:\/\/[^\s<>"']+/giu)];

    for (const match of matches) {
        const url = cleanUrl(match[0]);
        if (!url || PLATFORM_LINK.test(url)) continue;
        const start = Math.max(0, Number(match.index ?? 0) - 100);
        const end = Math.min(source.length, Number(match.index ?? 0) + match[0].length + 100);
        if (TICKET_CONTEXT.test(source.slice(start, end))) {
            return url;
        }
    }

    return '';
}

export function compactSummarySource(value, limit = 1800) {
    return stripCompactNoiseSentences(
        normalizeSpaces(value).replace(/https?:\/\/\S+/giu, ' '),
    )
        .slice(0, Math.max(100, Number(limit) || 1800));
}

export function normalizeCompactSummary(value, maxChars = 300) {
    const clean = stripCompactNoiseSentences(value)
        .replace(/^[-•*\d.)\s]+/u, '')
        .replace(/\s+/gu, ' ')
        .trim();

    if (!clean) return '';

    const sentences = clean
        .match(/[^.!?]+[.!?]+|[^.!?]+$/gu)
        ?.map((sentence) => sentence.trim())
        .filter(Boolean)
        .slice(0, 4) ?? [];
    let result = sentences.join(' ').trim();
    const safeLimit = Math.max(90, Number(maxChars) || 300);

    if (result.length > safeLimit) {
        result = result.slice(0, safeLimit - 1).trimEnd() + '…';
    }

    return result;
}

export function isCompactSummaryUsable(value) {
    const raw = String(value ?? '').trim();
    if (!raw || RAW_PLATFORM_NOISE.test(raw) || /(?:^|\n)\s*(?:когда|где|кто|поч[её]м|встреча|анонс|билеты)\s*[:：]/iu.test(raw)) return false;
    const normalized = normalizeCompactSummary(raw, 1000);
    if (!normalized) return false;
    const sentenceCount = normalized.match(/[^.!?]+[.!?]+|[^.!?]+$/gu)?.length ?? 0;
    return sentenceCount >= 2 && sentenceCount <= 4 && normalized.length >= 45;
}

export function buildCompactPartyPayload(events) {
    return (Array.isArray(events) ? events : []).map((event, index) => ({
        key: String(index),
        title: String(event?.title ?? event?.participants ?? 'Мероприятие').trim(),
        date: String(event?.displayDate || event?.eventDate || '').trim(),
        time: getCompactSupportedTime(event),
        venue: String(event?.venue ?? '').trim(),
        participants: String(event?.participants ?? '').trim(),
        price: String(event?.price ?? '').trim(),
        ticketLink: extractTicketLink(event),
        sourceText: compactSummarySource(event?.description ?? ''),
    }));
}

export function buildCompactPartySummarySystemPrompt(maxSummaryChars = 260) {
    const limit = Math.max(90, Math.min(360, Number(maxSummaryChars) || 260));
    return [
        'Ты редактор краткой городской афиши.',
        'Получаешь массив уже найденных мероприятий. Нельзя удалять, объединять или добавлять события.',
        'Используй только sourceText и структурированные поля входа. Ничего не выдумывай.',
        'Верни только JSON без Markdown вида {"events":[{"key":"0","summary":"..."}]}.',
        'Для каждого входного key верни ровно один объект с тем же key и в том же порядке.',
        'summary — 2–4 максимально коротких предложения, полностью передающие суть события: формат, что будет происходить, программа и важные особенности. Сохраняй конкретные детали из sourceText, не ограничивайся общими словами. Не повторяй дату, время, цену, место и ссылку, уже вынесенные отдельными полями. Список участников упоминай только если это важно для понимания события.',
        'Полностью игнорируй конкурсы и розыгрыши: условия репоста, "Точно пойду", "Хочу на концерт", итоги конкурса, призы, победителей и просьбы вступить во встречу. Это не описание мероприятия.',
        'Не пиши служебные фразы "Полный текст сообщения", "Источник", кнопки платформ и технические подписи.',
        `Каждый summary не длиннее ${limit} символов. Пиши по-русски, сжато, без рекламного пафоса и служебного текста.`,
        'Не добавляй фактов, которых нет во входе. Если подробностей мало, составь 2 коротких предложения только из достоверных фактов о формате события и его участниках.',
    ].join(' ');
}
