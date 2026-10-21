/**
 * Separates the normal party feed from the deliberately independent
 * “secondary / быдлячьи” feed.  Source identity is the boundary: events from
 * the two pools must never meet in dedupe or public selection.
 */
export const PARTY_POOL_PRIMARY = 'primary';
export const PARTY_POOL_SECONDARY = 'secondary';
export const SECONDARY_PARTY_SECTION_LABEL = '🍺 Второстепенные / быдлячьи тусы 🥴';

export const SECONDARY_PARTY_INITIAL_SOURCES = Object.freeze([
    { label: 'Клуб 12', kind: 'vk-public', source: '12bpg' },
    { label: 'Хлам', kind: 'vk-public', source: 'xlambar' },
    { label: 'Хлам', kind: 'telegram', source: 'xlam_bar' },
    { label: 'ОНИ в баре', kind: 'vk-public', source: 'onibar' },
    { label: 'ОНИ в баре', kind: 'telegram', source: 'onibarvrn' },
    { label: 'Винзавод', kind: 'vk-public', source: 'vinzavodpro' },
    { label: 'Винзавод', kind: 'telegram', source: 'vinzavodproo' },
    { label: 'Площадка 1900', kind: 'vk-public', source: 'rest1900' },
    { label: 'Arena Hall', kind: 'vk-public', source: 'arena_voronez' },
    { label: 'Arena Hall', kind: 'telegram', source: 'arena_hall_vrn' },
    { label: 'Balagan City', kind: 'vk-public', source: 'balagan.city' },
    { label: 'Pinta Haus', kind: 'vk-public', source: 'pinta_haus' },
    { label: 'Pinta Haus', kind: 'telegram', source: 'pintahausvrn' },
    { label: 'AURA', kind: 'telegram', source: 'auraclubvrn' },
    { label: 'Литера', kind: 'vk-public', source: 'literabar' },
    { label: 'Понеслось', kind: 'vk-public', source: 'poneslosbar_vrn' },
    { label: 'Понеслось', kind: 'telegram', source: 'poneslosbar_vrn' },
    { label: 'Barak O’Mama', kind: 'vk-public', source: 'barakomama' },
    { label: 'Barak O’Mama', kind: 'telegram', source: 'barak_omama' },
    { label: 'ЦЕНЗУРА', kind: 'telegram', source: 'cenzurabar' },
    { label: 'Живой Контакт', kind: 'vk-public', source: 'zhivoikontakt_vrn' },
    { label: 'Нарядный', kind: 'vk-public', source: 'naryadny.rest' },
    { label: 'Нарядный', kind: 'telegram', source: 'naryadnyrest' },
    { label: 'Коптильня', kind: 'vk-public', source: 'koptilnyarest' },
    { label: 'Коммуна', kind: 'telegram', source: 'kommunavrn' },
].map((item) => Object.freeze({ ...item, initialCount: 10, partyPool: PARTY_POOL_SECONDARY })));

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
    return new Set(SECONDARY_PARTY_INITIAL_SOURCES.map((item) => normalizePartySourceKey(item.kind, item.source)));
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

export function classifyEventPartyPool(event, { secondarySourceKeys = null } = {}) {
    if (normalizePartyPool(event?.partyPool) === PARTY_POOL_SECONDARY) return PARTY_POOL_SECONDARY;
    const secondary = secondarySourceKeys instanceof Set
        ? secondarySourceKeys
        : getDefaultSecondaryPartySourceKeys();
    const strings = [];
    harvestStrings(event, strings);

    const sourceType = String(event?.sourceType ?? '').toLowerCase();
    const sourceName = String(event?.sourceName ?? event?.channel ?? event?.screenName ?? '').replace(/^@/u, '');
    const directKeys = [];
    if (/telegram|\btg\b/u.test(sourceType)) directKeys.push(normalizePartySourceKey('telegram', sourceName));
    if (/vk(?:_|-)?public|\bvk\b/u.test(sourceType)) directKeys.push(normalizePartySourceKey('vk-public', sourceName.replace(/^vk(?:\.com|\.ru)\//iu, '')));
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
