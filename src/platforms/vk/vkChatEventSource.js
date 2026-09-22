/**
 * Чистые правила выбора публичной ссылки-источника для события из VK-беседы.
 */
function parseHttpUrl(value) {
    const source = String(value ?? '').trim();

    if (!source) {
        return null;
    }

    try {
        const parsed = new URL(source);

        if (!/^https?:$/iu.test(parsed.protocol)) {
            return null;
        }

        return parsed;
    } catch {
        return null;
    }
}


function extractHttpUrlsFromText(value) {
    const source = String(value ?? '');
    const matches = source.match(/https?:\/\/[^\s<>"'«»]+/giu) ?? [];

    return matches.map((url) => url.replace(/[),.;!?]+$/gu, ''));
}

export function isVkConversationUrl(value) {
    const parsed = parseHttpUrl(value);

    if (!parsed) {
        return false;
    }

    const hostname = parsed.hostname
        .replace(/^www\./iu, '')
        .replace(/^m\./iu, '')
        .toLowerCase();

    if (hostname !== 'vk.ru' && hostname !== 'vk.com') {
        return false;
    }

    const pathname = parsed.pathname
        .replace(/\/{2,}/gu, '/')
        .toLowerCase();

    /*
     * Любая ссылка на раздел личных сообщений VK является персональной:
     * /im/convo/<peer>, /im?sel=..., /im?peers=... и их варианты.
     * Такие URL нельзя публиковать как источник события.
     */
    return pathname === '/im' || pathname.startsWith('/im/');
}

export function filterVkChatPublicMessageLinks(values, maximum = 20) {
    const result = [];

    for (const value of Array.isArray(values) ? values : []) {
        const source = String(value ?? '').trim();
        const parsed = parseHttpUrl(source);

        if (!parsed || isVkConversationUrl(source) || result.includes(source)) {
            continue;
        }

        result.push(source);

        if (result.length >= maximum) {
            break;
        }
    }

    return result;
}

export function selectVkChatPublicSourceUrl(values, messageText = '') {
    const candidates = [
        ...extractHttpUrlsFromText(messageText),
        ...(Array.isArray(values) ? values : []),
    ];

    return filterVkChatPublicMessageLinks(candidates, 1)[0] ?? '';
}

export function formatVkChatEventSourceBlock(sourceUrl) {
    const publicSourceUrl = selectVkChatPublicSourceUrl([sourceUrl]);

    return publicSourceUrl
        ? `Источник:\n${publicSourceUrl}`
        : 'Информация с беседы';
}
