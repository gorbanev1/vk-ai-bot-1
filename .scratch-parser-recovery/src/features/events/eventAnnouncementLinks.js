const MAX_ANNOUNCEMENT_LINKS = 100;

function cleanUrl(value) {
    return String(value ?? '').trim().replace(/[),.;!?\]}]+$/u, '');
}

function isConversationUrl(value) {
    try {
        const url = new URL(value);
        return ['vk.ru', 'vk.com'].includes(url.hostname.toLowerCase().replace(/^(?:www\.|m\.)/u, '')) &&
            /^\/im(?:\/|$)/iu.test(url.pathname);
    } catch {
        return false;
    }
}

function isIdentityOnlyVkUrl(value) {
    try {
        const url = new URL(value);
        const host = url.hostname.toLowerCase().replace(/^(?:www\.|m\.)/u, '');
        if (!['vk.ru', 'vk.com'].includes(host)) return false;
        const path = url.pathname.replace(/^\/+|\/+$/gu, '');
        return /^(?:id\d+|club\d+|public\d+)$/iu.test(path) && !url.searchParams.has('w');
    } catch {
        return false;
    }
}

export function normalizeAnnouncementLinks(values, { maximum = MAX_ANNOUNCEMENT_LINKS } = {}) {
    const result = [];
    const seen = new Set();
    for (const entry of Array.isArray(values) ? values : []) {
        const raw = cleanUrl(typeof entry === 'string' ? entry : entry?.url);
        if (!raw) continue;
        try {
            const url = new URL(raw);
            if (!/^https?:$/iu.test(url.protocol) || isConversationUrl(raw) || isIdentityOnlyVkUrl(raw)) continue;
            const normalized = url.href;
            if (seen.has(normalized)) continue;
            seen.add(normalized);
            result.push(normalized);
            if (result.length >= Math.max(1, Number(maximum) || MAX_ANNOUNCEMENT_LINKS)) break;
        } catch {
            continue;
        }
    }
    return result;
}

export function extractAnnouncementLinks(text, capturedLinks = [], options = {}) {
    const source = String(text ?? '');
    const fromText = source.match(/https?:\/\/[^\s<>"'«»]+/giu) ?? [];
    return normalizeAnnouncementLinks([...fromText, ...(Array.isArray(capturedLinks) ? capturedLinks : [])], options);
}
