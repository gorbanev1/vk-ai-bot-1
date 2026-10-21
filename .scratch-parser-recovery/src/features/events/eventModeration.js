import {
    existsSync,
    mkdirSync,
    readFileSync,
    writeFileSync,
} from 'node:fs';
import { dirname, resolve } from 'node:path';

const DEFAULT_BLOCKLIST_FILE = resolve(
    process.env.EVENT_BLOCKLIST_FILE || './data/event-blacklist.json',
);
const DEFAULT_FUZZY_THRESHOLD = 0.90;

function normalizeSpaces(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/ё/giu, 'е')
        .replace(/[«»„“”"'`´]/gu, ' ')
        .replace(/[\p{P}\p{S}_]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase();
}

export function normalizeEventMatchTitle(value) {
    // JS \b не считает кириллицу word-character во всех окружениях, поэтому
    // служебные location/venue tokens убираем токенами, а не word-boundary regex.
    const ignoredTokens = new Set(['воронеж', 'vrn', 'rock', 'bar', 'бар', 'клуб', 'club', 'pub']);
    return normalizeSpaces(value)
        .split(' ')
        .filter((token) => token && !ignoredTokens.has(token))
        .join(' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function levenshteinDistance(left, right) {
    const a = Array.from(String(left ?? ''));
    const b = Array.from(String(right ?? ''));

    if (!a.length) return b.length;
    if (!b.length) return a.length;

    const previous = Array.from({ length: b.length + 1 }, (_, index) => index);
    const current = new Array(b.length + 1);

    for (let i = 1; i <= a.length; i += 1) {
        current[0] = i;
        for (let j = 1; j <= b.length; j += 1) {
            const cost = a[i - 1] === b[j - 1] ? 0 : 1;
            current[j] = Math.min(
                current[j - 1] + 1,
                previous[j] + 1,
                previous[j - 1] + cost,
            );
        }
        for (let j = 0; j <= b.length; j += 1) previous[j] = current[j];
    }

    return previous[b.length];
}

export function eventTitleSimilarity(left, right) {
    const a = normalizeEventMatchTitle(left);
    const b = normalizeEventMatchTitle(right);

    if (!a || !b) return 0;
    if (a === b) return 1;

    const longest = Math.max(Array.from(a).length, Array.from(b).length);
    if (!longest) return 1;
    return Math.max(0, 1 - (levenshteinDistance(a, b) / longest));
}

export function eventTitleSmartMatch(left, right, threshold = DEFAULT_FUZZY_THRESHOLD) {
    const a = normalizeEventMatchTitle(left);
    const b = normalizeEventMatchTitle(right);
    const safeThreshold = Math.max(0.5, Math.min(1, Number(threshold) || DEFAULT_FUZZY_THRESHOLD));

    if (!a || !b) return false;
    if (a === b) return true;

    // Подстрока должна быть достаточно содержательной, чтобы запрос «а» не снёс всю афишу.
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;
    if (shorter.length >= 4 && longer.includes(shorter)) return true;

    return eventTitleSimilarity(a, b) >= safeThreshold;
}

function normalizeDate(value) {
    return String(value ?? '').trim();
}

function normalizeTime(value) {
    const text = String(value ?? '').trim();
    const match = text.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u);
    return match ? `${String(match[1]).padStart(2, '0')}:${match[2]}` : '';
}

function eventDescriptionQuality(value) {
    const text = String(value ?? '').trim();
    if (!text) return -1000;
    const giveawayNoise = (text.match(/(?:розыгрыш|конкурс|репост|точно пойду|вступить во встречу|итоги конкурса|призов|победител)/giu) || []).length;
    const serviceNoise = (text.match(/(?:полный текст сообщения|источник:|view in telegram|please open telegram)/giu) || []).length;
    return Math.min(2000, text.length) - giveawayNoise * 500 - serviceNoise * 300;
}

function chooseBetterText(left, right) {
    const a = String(left ?? '').trim();
    const b = String(right ?? '').trim();
    if (!a) return b;
    if (!b) return a;
    return b.length > a.length ? b : a;
}

function chooseBetterDescription(left, right) {
    return eventDescriptionQuality(right) > eventDescriptionQuality(left)
        ? String(right ?? '').trim()
        : String(left ?? '').trim();
}

function mergeEventPair(left, right) {
    const leftTime = normalizeTime(left?.timeLabel || left?.eventTime);
    const rightTime = normalizeTime(right?.timeLabel || right?.eventTime);
    const mergedTime = leftTime || rightTime;
    const leftTitle = String(left?.title ?? '').trim();
    const rightTitle = String(right?.title ?? '').trim();

    return {
        ...right,
        ...left,
        title: leftTitle.length >= rightTitle.length ? leftTitle : rightTitle,
        eventDate: normalizeDate(left?.eventDate) || normalizeDate(right?.eventDate),
        eventTime: mergedTime || String(left?.eventTime ?? right?.eventTime ?? '').trim(),
        timeLabel: mergedTime || String(left?.timeLabel ?? right?.timeLabel ?? '').trim(),
        venue: chooseBetterText(left?.venue, right?.venue),
        participants: chooseBetterText(left?.participants, right?.participants),
        price: chooseBetterText(left?.price, right?.price),
        description: chooseBetterDescription(left?.description, right?.description),
        sourceUrl: String(left?.sourceUrl ?? '').trim() || String(right?.sourceUrl ?? '').trim(),
        sourceName: String(left?.sourceName ?? '').trim() || String(right?.sourceName ?? '').trim(),
        _moderationMerged: true,
    };
}

function sameEventIdentity(left, right, threshold = DEFAULT_FUZZY_THRESHOLD) {
    const leftDate = normalizeDate(left?.eventDate);
    const rightDate = normalizeDate(right?.eventDate);
    if (!leftDate || !rightDate || leftDate !== rightDate) return false;

    const leftTitle = left?.title || left?.participants;
    const rightTitle = right?.title || right?.participants;
    if (!eventTitleSmartMatch(leftTitle, rightTitle, threshold)) return false;

    const leftTime = normalizeTime(left?.timeLabel || left?.eventTime);
    const rightTime = normalizeTime(right?.timeLabel || right?.eventTime);

    // Если оба времени уверенно известны и различаются, не склеиваем автоматически.
    if (leftTime && rightTime && leftTime !== rightTime) return false;
    return true;
}


export function findDuplicateEventGroups(events, { threshold = DEFAULT_FUZZY_THRESHOLD } = {}) {
    const source = Array.isArray(events) ? events.filter(Boolean) : [];
    const groups = [];
    const consumed = new Set();

    for (let i = 0; i < source.length; i += 1) {
        if (consumed.has(i)) continue;
        const members = [{ index: i, event: source[i] }];
        const memberIndexes = new Set([i]);
        let expanded = true;

        while (expanded) {
            expanded = false;
            for (let j = i + 1; j < source.length; j += 1) {
                if (consumed.has(j) || memberIndexes.has(j)) continue;
                const candidate = source[j];
                const matchesAny = members.some(({ event }) => sameEventIdentity(event, candidate, threshold));
                if (!matchesAny) continue;
                members.push({ index: j, event: candidate });
                memberIndexes.add(j);
                expanded = true;
            }
        }

        if (members.length < 2) continue;
        for (const member of members) consumed.add(member.index);

        let bestSimilarity = 0;
        const pairs = [];
        for (let a = 0; a < members.length; a += 1) {
            for (let b = a + 1; b < members.length; b += 1) {
                const left = members[a].event;
                const right = members[b].event;
                const similarity = eventTitleSimilarity(
                    left?.title || left?.participants,
                    right?.title || right?.participants,
                );
                if (!sameEventIdentity(left, right, threshold)) continue;
                bestSimilarity = Math.max(bestSimilarity, similarity);
                pairs.push({
                    leftIndex: members[a].index,
                    rightIndex: members[b].index,
                    similarity,
                });
            }
        }

        groups.push({
            members: members.map(({ event }) => event),
            pairs,
            bestSimilarity,
            eventDate: String(members[0]?.event?.eventDate ?? '').trim(),
        });
    }

    return groups.sort((a, b) => {
        if (a.eventDate !== b.eventDate) return a.eventDate.localeCompare(b.eventDate);
        return b.bestSimilarity - a.bestSimilarity;
    });
}

export function deduplicateEventsStrict(events, { threshold = DEFAULT_FUZZY_THRESHOLD } = {}) {
    const output = [];
    const merges = [];

    for (const event of Array.isArray(events) ? events : []) {
        const index = output.findIndex((existing) => sameEventIdentity(existing, event, threshold));
        if (index < 0) {
            output.push(event);
            continue;
        }

        const previous = output[index];
        const merged = mergeEventPair(previous, event);
        output[index] = merged;
        merges.push({
            eventDate: merged.eventDate,
            leftTitle: String(previous?.title ?? ''),
            rightTitle: String(event?.title ?? ''),
            resultTitle: String(merged?.title ?? ''),
            score: eventTitleSimilarity(previous?.title, event?.title),
            reasons: ['strict-date-title'],
        });
    }

    return { events: output, merges };
}

function normalizeRule(raw) {
    if (!raw || typeof raw !== 'object') return null;
    const query = String(raw.query ?? raw.title ?? '').trim();
    if (!query) return null;
    return {
        id: String(raw.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`),
        query,
        normalizedQuery: normalizeEventMatchTitle(query),
        threshold: Math.max(0.5, Math.min(1, Number(raw.threshold) || DEFAULT_FUZZY_THRESHOLD)),
        createdAt: String(raw.createdAt || new Date().toISOString()),
    };
}

export function readEventBlocklist(filePath = DEFAULT_BLOCKLIST_FILE) {
    try {
        if (!existsSync(filePath)) return [];
        const parsed = JSON.parse(readFileSync(filePath, 'utf8'));
        const list = Array.isArray(parsed) ? parsed : parsed?.rules;
        return (Array.isArray(list) ? list : []).map(normalizeRule).filter(Boolean);
    } catch (error) {
        console.error('[EVENT BLOCKLIST READ ERROR]', error?.message || error);
        return [];
    }
}

function writeEventBlocklist(rules, filePath = DEFAULT_BLOCKLIST_FILE) {
    mkdirSync(dirname(filePath), { recursive: true });
    writeFileSync(filePath, JSON.stringify({ version: 1, rules }, null, 2) + '\n', 'utf8');
}

export function addEventBlockRule(query, {
    threshold = DEFAULT_FUZZY_THRESHOLD,
    filePath = DEFAULT_BLOCKLIST_FILE,
} = {}) {
    const cleanQuery = String(query ?? '').trim();
    const normalizedQuery = normalizeEventMatchTitle(cleanQuery);
    if (normalizedQuery.length < 3) {
        throw new Error('Название для удаления должно содержать минимум 3 значимых символа.');
    }

    const rules = readEventBlocklist(filePath);
    const existing = rules.find((rule) => normalizeEventMatchTitle(rule.query) === normalizedQuery);
    if (existing) return { added: false, rule: existing, rules };

    const rule = normalizeRule({
        id: `event-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
        query: cleanQuery,
        threshold,
        createdAt: new Date().toISOString(),
    });
    const next = [...rules, rule];
    writeEventBlocklist(next, filePath);
    return { added: true, rule, rules: next };
}

export function removeEventBlockRule(query, { filePath = DEFAULT_BLOCKLIST_FILE } = {}) {
    const normalizedQuery = normalizeEventMatchTitle(query);
    const rules = readEventBlocklist(filePath);
    const kept = rules.filter((rule) => !eventTitleSmartMatch(rule.query, normalizedQuery, 0.98));
    const removed = rules.filter((rule) => !kept.includes(rule));
    if (removed.length) writeEventBlocklist(kept, filePath);
    return { removed, rules: kept };
}

export function matchEventBlockRule(event, rules = readEventBlocklist()) {
    const title = String(event?.title ?? event?.participants ?? '').trim();
    if (!title) return null;
    return rules.find((rule) => eventTitleSmartMatch(title, rule.query, rule.threshold)) || null;
}

export function filterBlockedEvents(events, rules = readEventBlocklist()) {
    const kept = [];
    const blocked = [];
    for (const event of Array.isArray(events) ? events : []) {
        const rule = matchEventBlockRule(event, rules);
        if (rule) blocked.push({ event, rule });
        else kept.push(event);
    }
    return { events: kept, blocked };
}

export function findEventMatchesByTitle(events, query, threshold = DEFAULT_FUZZY_THRESHOLD) {
    return (Array.isArray(events) ? events : [])
        .filter((event) => eventTitleSmartMatch(event?.title || event?.participants, query, threshold))
        .map((event) => ({
            event,
            similarity: eventTitleSimilarity(event?.title || event?.participants, query),
        }))
        .sort((a, b) => b.similarity - a.similarity);
}

export const EVENT_BLOCKLIST_FILE = DEFAULT_BLOCKLIST_FILE;
