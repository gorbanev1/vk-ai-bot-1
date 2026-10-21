import {
    eventTitleSimilarity,
    normalizeEventMatchTitle,
} from './eventModeration.js';

const GENERIC_QUERY_TOKENS = new Set([
    'туса', 'тусовка', 'тусы', 'событие', 'мероприятие',
    'концерт', 'gig', 'гиг', 'party', 'вечеринка',
    'show', 'шоу', 'live', 'выступление', 'фестиваль',
]);

function tokens(value) {
    return normalizeEventMatchTitle(value)
        .split(/\s+/u)
        .map((token) => token.trim())
        .filter(Boolean);
}

function substantiveTokens(value) {
    const raw = tokens(value);
    const filtered = raw.filter((token) => !GENERIC_QUERY_TOKENS.has(token));
    return filtered.length ? filtered : raw;
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

function tokenSimilarity(left, right) {
    const a = String(left ?? '').trim();
    const b = String(right ?? '').trim();
    if (!a || !b) return 0;
    if (a === b) return 1;
    const shorter = a.length <= b.length ? a : b;
    const longer = a.length > b.length ? a : b;
    if (shorter.length >= 4 && longer.includes(shorter)) return 0.97;
    const longest = Math.max(a.length, b.length);
    return longest ? Math.max(0, 1 - (levenshteinDistance(a, b) / longest)) : 0;
}

function scoreTextField(candidateValue, query) {
    const candidate = normalizeEventMatchTitle(candidateValue);
    const normalizedQuery = normalizeEventMatchTitle(query);
    if (!candidate || !normalizedQuery) {
        return {
            score: 0,
            exact: false,
            contains: false,
            tokenCoverage: 0,
            bestTokenSimilarity: 0,
            matchedTokens: 0,
        };
    }

    const exact = candidate === normalizedQuery;
    const contains = normalizedQuery.length >= 3 && (
        candidate.includes(normalizedQuery) || normalizedQuery.includes(candidate)
    );
    const queryTokens = substantiveTokens(normalizedQuery);
    const candidateTokens = substantiveTokens(candidate);
    const perQueryToken = queryTokens.map((queryToken) => (
        candidateTokens.reduce((best, candidateToken) => Math.max(best, tokenSimilarity(queryToken, candidateToken)), 0)
    ));
    const matchedTokens = perQueryToken.filter((score) => score >= 0.72).length;
    const fuzzyMatchedTokens = perQueryToken.filter((score) => score >= 0.55).length;
    const tokenCoverage = queryTokens.length ? matchedTokens / queryTokens.length : 0;
    const fuzzyTokenCoverage = queryTokens.length ? fuzzyMatchedTokens / queryTokens.length : 0;
    const bestTokenSimilarity = perQueryToken.length ? Math.max(...perQueryToken) : 0;
    const meanTokenSimilarity = perQueryToken.length
        ? perQueryToken.reduce((sum, score) => sum + score, 0) / perQueryToken.length
        : 0;
    const fuzzy = eventTitleSimilarity(candidate, normalizedQuery);

    let score = Math.max(
        fuzzy,
        fuzzy * 0.60 + meanTokenSimilarity * 0.40,
        tokenCoverage * 0.90,
        fuzzyTokenCoverage * 0.72,
        bestTokenSimilarity >= 0.55 ? 0.40 + bestTokenSimilarity * 0.45 : 0,
    );
    if (exact) score = 1;
    else if (contains) score = Math.max(score, 0.98);
    else if (tokenCoverage === 1 && queryTokens.length > 0) score = Math.max(score, 0.92);
    else if (fuzzyTokenCoverage === 1 && queryTokens.length > 0) score = Math.max(score, 0.70 + meanTokenSimilarity * 0.20);
    else if (bestTokenSimilarity >= 0.80) score = Math.max(score, 0.76);
    else if (bestTokenSimilarity >= 0.55 && queryTokens.length === 1) score = Math.max(score, 0.62);

    return {
        score: Math.min(1, score),
        exact,
        contains,
        tokenCoverage,
        fuzzyTokenCoverage,
        bestTokenSimilarity,
        matchedTokens,
    };
}

export function rankOwnerEventModerationCandidates(events, query, { limit = 9 } = {}) {
    const normalizedQuery = normalizeEventMatchTitle(query);
    if (!normalizedQuery) return [];
    return (Array.isArray(events) ? events : [])
        .filter(Boolean)
        .map((event) => {
            const title = String(event?.title || '').trim();
            const participants = String(event?.participants || '').trim();
            const titleMatch = scoreTextField(title, normalizedQuery);
            const participantsMatch = scoreTextField(participants, normalizedQuery);
            const combinedMatch = scoreTextField([title, participants].filter(Boolean).join(' '), normalizedQuery);
            const best = [titleMatch, participantsMatch, combinedMatch]
                .sort((left, right) => right.score - left.score)[0];
            return {
                event,
                title: title || participants || 'без названия',
                similarity: best.score,
                exact: titleMatch.exact || participantsMatch.exact,
                contains: titleMatch.contains || participantsMatch.contains || combinedMatch.contains,
                tokenCoverage: Math.max(titleMatch.tokenCoverage, participantsMatch.tokenCoverage, combinedMatch.tokenCoverage),
                fuzzyTokenCoverage: Math.max(titleMatch.fuzzyTokenCoverage, participantsMatch.fuzzyTokenCoverage, combinedMatch.fuzzyTokenCoverage),
                bestTokenSimilarity: Math.max(titleMatch.bestTokenSimilarity, participantsMatch.bestTokenSimilarity, combinedMatch.bestTokenSimilarity),
            };
        })
        // This is an owner-only candidate search, not an auto-delete gate. It is
        // intentionally recall-heavy: weak-but-plausible matches are shown with
        // numbers and the owner chooses what to delete/edit.
        .filter((item) => (
            item.exact ||
            item.contains ||
            item.tokenCoverage > 0 ||
            item.fuzzyTokenCoverage > 0 ||
            item.bestTokenSimilarity >= 0.55 ||
            item.similarity >= 0.42
        ))
        .sort((left, right) => (
            Number(right.exact) - Number(left.exact) ||
            Number(right.contains) - Number(left.contains) ||
            right.tokenCoverage - left.tokenCoverage ||
            right.fuzzyTokenCoverage - left.fuzzyTokenCoverage ||
            right.bestTokenSimilarity - left.bestTokenSimilarity ||
            right.similarity - left.similarity ||
            String(left.event?.eventDate || '').localeCompare(String(right.event?.eventDate || '')) ||
            left.title.localeCompare(right.title, 'ru')
        ))
        .slice(0, Math.max(1, Math.min(9, Number(limit) || 9)));
}

export function parseOwnerEventNumberSelection(value, {
    action = 'delete',
    max = 9,
} = {}) {
    const clean = String(value ?? '').trim().toLowerCase();
    if (!clean) return null;
    if (/^(?:отмена|отменить|нет|cancel|назад)$/iu.test(clean)) return { action: 'cancel', indexes: [] };
    const verb = action === 'edit'
        ? '(?:исправить|исправь|редактировать|редактируй)'
        : '(?:удалить|удали|убрать|убери)';
    const prefixed = clean.match(new RegExp(`^${verb}\\s+(.+)$`, 'iu'));
    const payload = prefixed ? prefixed[1].trim() : (/^\d+(?:[\s,;]+\d+)*$/u.test(clean) ? clean : '');
    if (!payload) return null;

    let numbers = [];
    // The owner explicitly asked for compact forms like "удалить 123".
    // Candidate lists are capped at 9, so every digit unambiguously means an
    // item number rather than item #123.
    if (/^[1-9]{2,9}$/u.test(payload) && !/[\s,;]/u.test(payload)) {
        numbers = Array.from(payload).map(Number);
    } else {
        numbers = [...payload.matchAll(/\d+/gu)].map((match) => Number(match[0]));
    }
    numbers = [...new Set(numbers)].filter((number) => Number.isInteger(number) && number >= 1 && number <= max);
    if (!numbers.length) return { action: 'invalid', indexes: [] };
    if (action === 'edit' && numbers.length !== 1) return { action: 'invalid', indexes: [] };
    return { action: 'select', indexes: numbers.map((number) => number - 1) };
}
