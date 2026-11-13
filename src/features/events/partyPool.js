/**
 * Separates the normal party feed from the deliberately independent
 * “secondary / быдлячьи” feed.  Source identity is the boundary: events from
 * the two pools must never meet in dedupe or public selection.
 */
export const PARTY_POOL_PRIMARY = 'primary';
export const PARTY_POOL_SECONDARY = 'secondary';
export const SECONDARY_PARTY_SECTION_LABEL = '🍺 Второстепенные / быдлячьи тусы 🥴';

export const SECONDARY_PARTY_INITIAL_SOURCES = Object.freeze([
    { label: 'Бар «Хлам»', kind: 'vk-public', source: 'xlambar' },
    { label: 'Бар «Хлам»', kind: 'telegram', source: 'xlam_bar' },
    { label: 'ОНИ в баре', kind: 'vk-public', source: 'onibar' },
    { label: 'ОНИ в баре', kind: 'telegram', source: 'onibarvrn' },
    { label: 'Винзавод', kind: 'vk-public', source: 'vinzavodpro' },
    { label: 'Винзавод', kind: 'telegram', source: 'vinzavodproo' },
    { label: 'Площадка 1900', kind: 'vk-public', source: 'rest1900' },
    { label: 'Balagan City', kind: 'vk-public', source: 'balagan.city' },
    { label: 'Arena Hall', kind: 'vk-public', source: 'arena_voronez' },
    { label: 'Arena Hall', kind: 'telegram', source: 'arena_hall_vrn' },
    { label: 'Рестобар Pinta Haus', kind: 'vk-public', source: 'pinta_haus' },
    { label: 'Рестобар Pinta Haus', kind: 'telegram', source: 'pintahausvrn' },
    { label: 'AURA CLUB', kind: 'vk-public', source: 'auravrn' },
    { label: 'AURA CLUB', kind: 'telegram', source: 'auraclubvrn' },
    { label: 'Литера BAR', kind: 'vk-public', source: 'literabar' },
    { label: 'Бар «Понеслось»', kind: 'vk-public', source: 'poneslosbar_vrn' },
    { label: 'Бар «Понеслось»', kind: 'telegram', source: 'poneslosbar_vrn' },
    { label: 'BARak O’Mama', kind: 'vk-public', source: 'barakomama' },
    { label: 'BARak O’Mama', kind: 'telegram', source: 'barak_omama' },
    { label: 'Цензура Бар', kind: 'vk-public', source: 'cenzura_bar' },
    { label: 'Цензура Бар', kind: 'telegram', source: 'cenzurabar' },
    { label: 'Живой Контакт', kind: 'vk-public', source: 'zhivoikontakt_vrn' },
    { label: 'Нарядный', kind: 'vk-public', source: 'naryadny.rest' },
    { label: 'Нарядный', kind: 'telegram', source: 'naryadnyrest' },
    { label: 'Коптильня', kind: 'vk-public', source: 'koptilnyarest' },
    { label: 'Коммуна', kind: 'vk-public', source: 'kommunavrn' },
    { label: 'Коммуна', kind: 'telegram', source: 'kommunavrn' },
].map((item) => Object.freeze({ ...item, initialCount: 10, partyPool: PARTY_POOL_SECONDARY })));

// These feeds belong to the ordinary/main source set. Their presence in older
// secondary registries must not reclassify their events as secondary.
export const PRIMARY_PARTY_SOURCE_KEYS = Object.freeze(new Set([
    'vk:vavilone_rb',
    'vk:12bpg',
]));

export function normalizePartyPool(value) {
    return String(value ?? '').trim().toLowerCase() === PARTY_POOL_SECONDARY
        ? PARTY_POOL_SECONDARY
        : PARTY_POOL_PRIMARY;
}

export function normalizePartySourceKey(kind, source) {
    const rawKind = String(kind ?? '').trim().toLowerCase();
    const rawSource = String(source ?? '').trim().replace(/^@/u, '').toLowerCase();
    if (!rawSource) return '';
    if (rawKind === 'telegram' || rawKind === 'tg') return `tg:${rawSource}`;
    if (rawKind === 'vk-public' || rawKind === 'vk' || rawKind === 'vk_public') return `vk:${rawSource}`;
    if (rawKind === 'vk-chat' || rawKind === 'chat') return `chat:${rawSource}`;
    return `${rawKind}:${rawSource}`;
}

export function getDefaultSecondaryPartySourceKeys() {
    return new Set(SECONDARY_PARTY_INITIAL_SOURCES
        .map((item) => normalizePartySourceKey(item.kind, item.source))
        .filter((key) => !PRIMARY_PARTY_SOURCE_KEYS.has(key)));
}

function primarySourceKeys(primarySources, defaultKind) {
    const keys = new Set(PRIMARY_PARTY_SOURCE_KEYS);
    for (const item of Array.isArray(primarySources) ? primarySources : []) {
        const key = normalizePartySourceKey(item?.kind || defaultKind, item?.source);
        if (key) keys.add(key);
    }
    return keys;
}

export function filterSecondaryVkSources(vkSources, primarySources = []) {
    const primaryKeys = primarySourceKeys(primarySources, 'vk-public');
    return (Array.isArray(vkSources) ? vkSources : []).filter((item) =>
        !primaryKeys.has(normalizePartySourceKey('vk-public', item?.source)));
}

export function filterSecondaryTelegramSources(telegramSources, primarySources = [], vkSources = []) {
    const primaryKeys = primarySourceKeys(primarySources, 'telegram');
    const activeVkKeys = new Set(filterSecondaryVkSources(vkSources, primarySources)
        .filter(item => item?.enabled !== false)
        .map(item => normalizePartySourceKey('vk-public', item?.source)));
    // Pair only known publishers of the same venue; identical handles alone
    // do not prove that an arbitrary Telegram channel belongs to a VK group.
    const telegramToVk = new Map();
    for (const item of SECONDARY_PARTY_INITIAL_SOURCES) {
        if (item.kind !== 'telegram') continue;
        const vk = SECONDARY_PARTY_INITIAL_SOURCES.find(candidate =>
            candidate.kind === 'vk-public' && candidate.label === item.label);
        if (vk) telegramToVk.set(normalizePartySourceKey(item.kind, item.source),
            normalizePartySourceKey(vk.kind, vk.source));
    }
    telegramToVk.set('tg:literabar', 'vk:literabar');
    telegramToVk.set('tg:litera_vrn_restobar', 'vk:literabar');
    return (Array.isArray(telegramSources) ? telegramSources : []).filter((item) => {
        const key = normalizePartySourceKey('telegram', item?.source);
        return !primaryKeys.has(key) && !activeVkKeys.has(telegramToVk.get(key));
    });
}

function harvestStrings(value, out, depth = 0) {
    if (depth > 4 || value == null) return;
    if (typeof value === 'string' || typeof value === 'number') {
        out.push(String(value));
        return;
    }
    if (Array.isArray(value)) {
        value.slice(0, 80).forEach((item) => harvestStrings(item, out, depth + 1));
        return;
    }
    if (typeof value !== 'object') return;
    const usefulKeys = /(?:source|channel|screen|url|provenance|origin|post|peer|label|name)/iu;
    for (const [key, item] of Object.entries(value)) {
        if (usefulKeys.test(key)) harvestStrings(item, out, depth + 1);
    }
}

function sourceKeysFromText(value) {
    const text = String(value ?? '');
    const keys = [];
    for (const match of text.matchAll(/(?:https?:\/\/)?(?:www\.)?t\.me\/(?:s\/)?([A-Za-z0-9_]{3,})/giu)) {
        keys.push(normalizePartySourceKey('telegram', match[1]));
    }
    for (const match of text.matchAll(/(?:https?:\/\/)?(?:www\.)?(?:vk\.com|vk\.ru)\/([A-Za-z0-9_.-]{2,})/giu)) {
        const source = String(match[1] || '');
        if (!/^wall-?\d+_\d+$/iu.test(source)) keys.push(normalizePartySourceKey('vk-public', source));
    }
    for (const match of text.matchAll(/\b(tg|vk|chat):([^\s,;]+)/giu)) {
        keys.push(normalizePartySourceKey(match[1], match[2]));
    }
    return keys.filter(Boolean);
}

// A theatre repertoire may have been parsed by an older run as
// multiple_events.  Its source identity still has to keep the whole group out
// of the main feed until the source is reparsed into the durable
// theater_repertoire card.  This guard is deliberately narrow: it requires a
// repertoire/ theatre marker and at least two dated programme blocks, so an
// ordinary multi-event concert post is unaffected.
function looksLikeTheaterRepertoire(event) {
    const structure = String(event?.structureDecision ?? event?.structure_decision ?? event?._structure ?? '').trim().toLowerCase();
    if (structure === 'theater_repertoire') return true;
    if (structure !== 'multiple_events') return false;
    const text = [
        event?.sourceText, event?.rawSource, event?.description,
        event?.sourceSegment, event?.structureReason,
        event?.posterVisionFacts, event?.imageVisionFacts,
    ].filter(Boolean).map(value => typeof value === 'string' ? value : JSON.stringify(value)).join(' ');
    if (!/(?:репертуар|театр(?:а|е|ом|ральн)|спектакл|theatre|repertoire)/iu.test(text)) return false;
    const dates = text.match(/(?<!\d)(?:[0-3]?\d)[./](?:0?\d|1[0-2])(?:[./]\d{2,4})?(?!\d)/gu) || [];
    return new Set(dates).size >= 2;
}

export function classifyEventPartyPool(event, { secondarySourceKeys = null } = {}) {
    // Theatre repertoire is a dedicated one-card calendar. It belongs to the
    // secondary feed regardless of which configured source supplied the post.
    const structure = String(event?.structureDecision ?? event?.structure_decision ?? event?._structure ?? '').trim().toLowerCase();
    if (looksLikeTheaterRepertoire(event)) return PARTY_POOL_SECONDARY;
    const secondary = secondarySourceKeys instanceof Set
        ? secondarySourceKeys
        : getDefaultSecondaryPartySourceKeys();
    const sourceType = String(event?.sourceType ?? '').toLowerCase();
    const sourceName = String(event?.sourceName ?? event?.channel ?? event?.screenName ?? '').replace(/^@/u, '');
    const directKeys = [];
    if (/telegram|\btg\b/u.test(sourceType)) directKeys.push(normalizePartySourceKey('telegram', sourceName));
    if (/vk(?:_|-)?public|\bvk\b/u.test(sourceType)) directKeys.push(normalizePartySourceKey('vk-public', sourceName.replace(/^vk(?:\.com|\.ru)\//iu, '')));
    // A cached partyPool label may predate source reclassification. Current
    // configured source identity wins when it is explicit; retain a stored
    // secondary label only when no source identity is available.
    if (directKeys.length) {
        return directKeys.some((key) => secondary.has(key)) ? PARTY_POOL_SECONDARY : PARTY_POOL_PRIMARY;
    }
    const strings = [];
    harvestStrings(event, strings);
    if (normalizePartyPool(event?.partyPool) === PARTY_POOL_SECONDARY) return PARTY_POOL_SECONDARY;
    for (const key of [...directKeys, ...strings.flatMap(sourceKeysFromText)]) {
        if (key && secondary.has(key)) return PARTY_POOL_SECONDARY;
    }
    return PARTY_POOL_PRIMARY;
}

export function partitionEventsByPartyPool(events, options = {}) {
    const result = { primary: [], secondary: [] };
    for (const event of Array.isArray(events) ? events : []) {
        result[classifyEventPartyPool(event, options)].push(event);
    }
    return result;
}

export function parsePartyPoolRequest(value) {
    const raw = String(value ?? '').trim();
    const normalized = raw.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
    const secondaryPrefix = /^(?:(?:второстепенные\s*\/\s*быдлячьи|быдлячьи\s*\/\s*второстепенные|второстепенные|быдлячьи)\s+тус[аы]|тус[аы]\s+(?:второстепенные|быдлячьи))(?:\s+|$)/u;
    if (!secondaryPrefix.test(normalized)) {
        return { partyPool: PARTY_POOL_PRIMARY, text: raw };
    }
    const stripped = normalized.replace(secondaryPrefix, '').trim();
    return {
        partyPool: PARTY_POOL_SECONDARY,
        text: stripped ? `тусы ${stripped}` : 'все тусы',
    };
}
