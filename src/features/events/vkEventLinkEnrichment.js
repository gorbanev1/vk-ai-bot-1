function compact(value, maximum = 1200) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/\u00a0/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .slice(0, maximum);
}

function normalizeVkHost(value) {
    const host = String(value ?? '').toLowerCase().replace(/^www\./u, '').replace(/^m\./u, '');
    return host;
}

export function classifyVkEventSourceUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return { eligible: false, kind: '', url: '', short: false };
    let url;
    try {
        url = new URL(raw.startsWith('/') ? `https://vk.ru${raw}` : raw);
    } catch {
        return { eligible: false, kind: '', url: '', short: false };
    }
    const host = normalizeVkHost(url.hostname);
    if (host === 'vk.cc') {
        return {
            eligible: true,
            kind: 'short',
            url: `https://vk.cc${url.pathname}`,
            short: true,
        };
    }
    if (!['vk.ru', 'vk.com'].includes(host)) {
        return { eligible: false, kind: '', url: '', short: false };
    }

    const wallFromQuery = String(url.searchParams.get('w') || '').match(/^wall-?\d+_\d+/iu)?.[0] || '';
    const path = decodeURIComponent(url.pathname || '').replace(/^\/+|\/+$/gu, '');
    const wall = wallFromQuery || path.match(/^wall-?\d+_\d+/iu)?.[0] || '';
    if (wall) {
        return { eligible: true, kind: 'wall', url: `https://vk.ru/${wall.toLowerCase()}`, short: false };
    }
    const event = path.match(/^event\d+/iu)?.[0] || '';
    if (event) {
        return { eligible: true, kind: 'event', url: `https://vk.ru/${event.toLowerCase()}`, short: false };
    }
    const club = path.match(/^(?:club|public)\d+/iu)?.[0] || '';
    if (club) {
        return { eligible: true, kind: 'community', url: `https://vk.ru/${club.toLowerCase()}`, short: false };
    }
    return { eligible: false, kind: '', url: '', short: false };
}

export function boundedVkEventSourceLinks(values, { maximum = 12 } = {}) {
    const result = [];
    const seen = new Set();
    for (const entry of Array.isArray(values) ? values : []) {
        const rawUrl = typeof entry === 'string' ? entry : entry?.url;
        const classified = classifyVkEventSourceUrl(rawUrl);
        if (!classified.eligible || seen.has(classified.url)) continue;
        seen.add(classified.url);
        result.push({
            ...classified,
            text: compact(typeof entry === 'string' ? '' : entry?.text, 300),
            context: compact(typeof entry === 'string' ? '' : entry?.context, 900),
        });
        if (result.length >= Math.max(1, Number(maximum) || 12)) break;
    }
    return result;
}

export function validateResolvedVkShortUrl(value) {
    const classified = classifyVkEventSourceUrl(value);
    if (!classified.eligible || classified.short) return null;
    return classified;
}

function tokens(value) {
    return [...new Set(compact(value, 700).toLowerCase().replace(/ё/gu, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/u)
        .filter((token) => token.length >= 3 && !/^\d+$/u.test(token)))];
}

function dateTokens(isoDate) {
    const match = String(isoDate ?? '').match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (!match) return [];
    const monthNames = ['январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр'];
    const day = Number(match[3]);
    const month = Number(match[2]);
    return [
        `${day}.${month}`,
        `${day}/${month}`,
        `${String(day).padStart(2, '0')}.${String(month).padStart(2, '0')}`,
        `${day} ${monthNames[month - 1] || ''}`.trim(),
    ];
}

function scoreLinkForEvent(event, link) {
    const haystack = compact([link?.text, link?.context, link?.url].filter(Boolean).join(' '), 1600).toLowerCase().replace(/ё/gu, 'е');
    let score = link?.kind === 'wall' ? 20 : link?.kind === 'event' ? 12 : link?.kind === 'community' ? 5 : 0;
    for (const token of tokens([event?.title, event?.participants].filter(Boolean).join(' ')).slice(0, 12)) {
        if (haystack.includes(token)) score += 6;
    }
    for (const token of tokens(event?.venue).slice(0, 6)) {
        if (haystack.includes(token)) score += 3;
    }
    for (const token of dateTokens(event?.eventDate)) {
        if (token && haystack.includes(token)) score += 12;
    }
    return score;
}

/**
 * Attach direct source provenance to schedule children without creating a
 * second card. A link is used by at most one child unless it is the sole link.
 */
export function attachVkChildSourceProvenance(events, rawLinks, {
    parentSourceUrl = '',
    parentItemId = '',
    maximum = 12,
} = {}) {
    const parentCanonical = classifyVkEventSourceUrl(parentSourceUrl)?.url || String(parentSourceUrl || '').trim();
    const links = boundedVkEventSourceLinks(rawLinks, { maximum })
        .filter((link) => !link.short && link.url !== parentCanonical);
    const rows = (Array.isArray(events) ? events : []).map((event) => ({ ...event }));
    if (!rows.length || !links.length) return rows;
    const claimed = new Set();

    for (let index = 0; index < rows.length; index += 1) {
        const event = rows[index];
        let best = null;
        for (const link of links) {
            if (claimed.has(link.url) && links.length > 1) continue;
            const score = scoreLinkForEvent(event, link);
            if (!best || score > best.score) best = { link, score };
        }
        const minimum = rows.length === 1 && links.length === 1 ? 1 : 24;
        if (!best || best.score < minimum) continue;
        claimed.add(best.link.url);
        rows[index] = {
            ...event,
            canonicalPostUrl: best.link.url,
            linkedSourceUrl: best.link.url,
            sourceOriginalUrl: String(parentSourceUrl || '').trim(),
            sourceItemId: String(parentItemId || '').trim(),
            canonicalOrigin: 'schedule-child-link',
            provenanceSourceType: 'vk',
        };
    }
    return rows;
}

/**
 * Expand vk.cc without following an unchecked redirect. Every hop is inspected
 * manually and the chain is aborted before any non-VK host is requested.
 */
export async function resolveVkShortUrlControlled(value, {
    fetchImpl = globalThis.fetch,
    maximumRedirects = 3,
    timeoutMs = 8_000,
} = {}) {
    let current = classifyVkEventSourceUrl(value);
    if (!current.eligible) return null;
    if (!current.short) return current;
    if (typeof fetchImpl !== 'function') return null;

    for (let hop = 0; hop < Math.max(1, Number(maximumRedirects) || 3); hop += 1) {
        let response;
        try {
            response = await fetchImpl(current.url, {
                method: 'HEAD',
                redirect: 'manual',
                signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 8_000)),
            });
            if (Number(response?.status || 0) === 405) {
                response = await fetchImpl(current.url, {
                    method: 'GET',
                    redirect: 'manual',
                    signal: AbortSignal.timeout(Math.max(1_000, Number(timeoutMs) || 8_000)),
                });
            }
        } catch {
            return null;
        }
        const location = String(response?.headers?.get?.('location') || '').trim();
        if (!location) return null;
        let nextUrl = '';
        try { nextUrl = new URL(location, current.url).href; } catch { return null; }
        const next = classifyVkEventSourceUrl(nextUrl);
        // Critical safety property: do not issue the next request when the
        // redirect points at ticket/social/random external infrastructure.
        if (!next.eligible) return null;
        if (!next.short) return next;
        current = next;
    }
    return null;
}
