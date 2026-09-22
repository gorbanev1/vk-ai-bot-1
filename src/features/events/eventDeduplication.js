/**
 * Объединяет одинаковые события из разных источников, сохраняя лучший текст, ссылки и метаданные.
 */
import {
    enrichEventMetadata,
    extractContentLinks,
} from './eventMetadata.js';

const GENERIC_WORDS = new Set([
    'анонс',
    'встреча',
    'действия',
    'мероприятие',
    'событие',
    'концерт',
    'вечеринка',
    'туса',
    'тусовка',
    'воронеж',
    'воронеже',
    'город',
    'бар',
    'club',
    'клуб',
    'hall',
    'rock',
    'действия',
    'авторы',
    'автор',
    'новые',
    'сообщения',
    'поддержке',
    'двери',
    'билеты',
    'вход',
    'начало',
    'старт',
    'пройдет',
    'состоится',
]);

const STOP_WORDS = new Set([
    'а', 'без', 'бы', 'в', 'вам', 'вас', 'весь', 'во', 'вот', 'все', 'всех',
    'вы', 'где', 'для', 'до', 'его', 'ее', 'ещё', 'же', 'за', 'и', 'из', 'или',
    'им', 'их', 'к', 'как', 'когда', 'кто', 'мы', 'на', 'над', 'нас', 'не', 'но',
    'о', 'об', 'от', 'по', 'под', 'при', 'про', 'с', 'со', 'так', 'там', 'то',
    'у', 'уже', 'что', 'это', 'этот', 'эта', 'этом', 'будет', 'будут', 'можно',
    'наш', 'наша', 'ваш', 'ваша', 'свой', 'свои', 'самый', 'самая', 'очень',
]);

const SOURCE_HEADING_PATTERNS = [
    /^rock\s+bar\s+diesel(?:\s*&\s*diesel\s+hall)?$/iu,
    /^diesel(?:\s+bar|\s+hall)?$/iu,
    /^overlock(?:\s+bar)?$/iu,
    /^город\s+куража$/iu,
    /^действия$/iu,
    /^мероприятие$/iu,
    /^событие$/iu,
    /^это\s+будет\s+незабываемо!?$/iu,
];

function normalizeUrl(value) {
    const raw = String(value ?? '').trim();

    if (!raw) {
        return '';
    }

    return raw
        .replace(/^https?:\/\/(?:m\.)?/iu, '')
        .replace(/^www\./iu, '')
        .replace(/^vk\.ru\//iu, 'vk.com/')
        .replace(/[?#].*$/u, '')
        .replace(/\/+$/u, '')
        .toLowerCase();
}

function normalizeText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/https?:\/\/\S+/giu, ' ')
        .replace(/(?:vk\.cc|t\.me|vk\.(?:com|ru))\/\S+/giu, ' ')
        .replace(/[«»„“”"'`´]/gu, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function tokenize(value, { removeGeneric = false } = {}) {
    const result = [];

    for (const token of normalizeText(value).split(' ')) {
        if (!token || token.length < 2 || STOP_WORDS.has(token)) {
            continue;
        }

        if (removeGeneric && GENERIC_WORDS.has(token)) {
            continue;
        }

        result.push(token);
    }

    return [...new Set(result)];
}

function distinctiveTokens(event) {
    const title = SOURCE_HEADING_PATTERNS.some((pattern) => (
        pattern.test(String(event?.title ?? '').trim())
    ))
        ? ''
        : String(event?.title ?? '');
    const combined = [
        title,
        event?.participants,
        event?.description,
    ].filter(Boolean).join(' ');

    return tokenize(combined, { removeGeneric: true })
        .filter((token) => (
            token.length >= 4 &&
            !/^\d{1,4}$/u.test(token) &&
            !/^(?:август|июль|июнь|сентябрь|октябрь|ноябрь|декабрь|январь|февраль|март|апрель|май)$/u.test(token)
        ))
        .slice(0, 160);
}

function sharedDistinctiveTokenStats(left, right) {
    const leftTokens = distinctiveTokens(left);
    const rightTokens = distinctiveTokens(right);
    const leftSet = new Set(leftTokens);
    const rightSet = new Set(rightTokens);
    const shared = [...leftSet].filter((token) => rightSet.has(token));
    const denominator = Math.max(1, Math.min(leftSet.size, rightSet.size));

    return {
        shared,
        count: shared.length,
        containment: shared.length / denominator,
    };
}

function isMeaningfulEventLink(value) {
    const normalized = normalizeUrl(value);

    if (!normalized) {
        return false;
    }

    if (/^vk\.cc\//u.test(normalized)) {
        return true;
    }

    if (/^t\.me\/[^/]+\/\d+/u.test(normalized)) {
        return true;
    }

    if (/^vk\.com\/wall-?\d+_\d+/u.test(normalized)) {
        return true;
    }

    if (
        /^vk\.com\/(?:im|photo|video|id|club|public|event)/u.test(normalized) ||
        /^vk\.com\/[^/?#]+$/u.test(normalized)
    ) {
        return false;
    }

    return true;
}

function contentLinkSet(event) {
    const explicit = Array.isArray(event?.contentLinks)
        ? event.contentLinks
        : [];
    const extracted = extractContentLinks([
        event?.title,
        event?.description,
        event?.participants,
        event?.price,
    ].filter(Boolean).join('\n'));
    const source = normalizeUrl(event?.sourceUrl);

    return new Set([...explicit, ...extracted]
        .map((value) => normalizeUrl(value))
        .filter((value) => (
            value &&
            value !== source &&
            isMeaningfulEventLink(value)
        )));
}

function sharedContentLinks(left, right) {
    const leftLinks = contentLinkSet(left);
    const rightLinks = contentLinkSet(right);
    return [...leftLinks].filter((link) => rightLinks.has(link));
}

function tokenSimilarity(leftValue, rightValue, options = {}) {
    const left = tokenize(leftValue, options);
    const right = tokenize(rightValue, options);

    if (!left.length || !right.length) {
        return 0;
    }

    const leftSet = new Set(left);
    const rightSet = new Set(right);
    let intersection = 0;

    for (const token of leftSet) {
        if (rightSet.has(token)) {
            intersection += 1;
        }
    }

    const union = leftSet.size + rightSet.size - intersection;
    const jaccard = union ? intersection / union : 0;
    const containment = intersection / Math.min(leftSet.size, rightSet.size);

    return Math.max(jaccard, (jaccard * 0.58) + (containment * 0.42));
}

function trigrams(value) {
    const normalized = normalizeText(value).replace(/\s+/gu, ' ');

    if (normalized.length < 3) {
        return normalized ? [normalized] : [];
    }

    const result = [];

    for (let index = 0; index <= normalized.length - 3; index += 1) {
        result.push(normalized.slice(index, index + 3));
    }

    return result;
}

function trigramSimilarity(leftValue, rightValue) {
    const left = trigrams(leftValue);
    const right = trigrams(rightValue);

    if (!left.length || !right.length) {
        return 0;
    }

    const rightCounts = new Map();

    for (const item of right) {
        rightCounts.set(item, (rightCounts.get(item) ?? 0) + 1);
    }

    let intersection = 0;

    for (const item of left) {
        const count = rightCounts.get(item) ?? 0;

        if (count > 0) {
            intersection += 1;
            rightCounts.set(item, count - 1);
        }
    }

    return (2 * intersection) / (left.length + right.length);
}

function textSimilarity(leftValue, rightValue, options = {}) {
    const left = normalizeText(leftValue);
    const right = normalizeText(rightValue);

    if (!left || !right) {
        return 0;
    }

    if (left === right) {
        return 1;
    }

    if (left.length >= 8 && right.length >= 8 && (
        left.includes(right) || right.includes(left)
    )) {
        const ratio = Math.min(left.length, right.length) /
            Math.max(left.length, right.length);
        return Math.max(0.82, ratio);
    }

    const tokenScore = tokenSimilarity(left, right, options);
    const trigramScore = trigramSimilarity(left, right);

    return Math.max(
        tokenScore,
        (tokenScore * 0.68) + (trigramScore * 0.32),
    );
}

function parseTime(value) {
    const match = String(value ?? '').match(/^(\d{1,2}):(\d{2})$/u);

    if (!match) {
        return null;
    }

    const hours = Number(match[1]);
    const minutes = Number(match[2]);

    if (hours > 23 || minutes > 59) {
        return null;
    }

    return (hours * 60) + minutes;
}

function timeSimilarity(leftValue, rightValue) {
    const left = parseTime(leftValue);
    const right = parseTime(rightValue);

    if (left === null && right === null) {
        return 0.62;
    }

    if (left === null || right === null) {
        return 0.56;
    }

    const difference = Math.abs(left - right);

    if (difference === 0) {
        return 1;
    }

    if (difference <= 15) {
        return 0.92;
    }

    if (difference <= 30) {
        return 0.76;
    }

    if (difference <= 60) {
        return 0.38;
    }

    return 0;
}

function neutralFieldSimilarity(leftValue, rightValue, options = {}) {
    const left = normalizeText(leftValue);
    const right = normalizeText(rightValue);

    if (!left && !right) {
        return 0.48;
    }

    if (!left || !right) {
        return 0.54;
    }

    return textSimilarity(left, right, options);
}

function eventSourceKey(event) {
    const normalizedUrl = normalizeUrl(event?.sourceUrl);

    if (normalizedUrl) {
        return `url:${normalizedUrl}`;
    }

    return [
        String(event?.sourceType ?? ''),
        String(event?.sourceName ?? ''),
        String(event?.id ?? ''),
    ].join(':').toLowerCase();
}

function sourceSimilarity(left, right) {
    const leftUrl = normalizeUrl(left?.sourceUrl);
    const rightUrl = normalizeUrl(right?.sourceUrl);

    if (leftUrl && rightUrl && leftUrl === rightUrl) {
        return 1;
    }

    return 0;
}

const WEAK_EVENT_TITLE_RE = /^(?:(?:музыкальн(?:ое|ый)\s+)?(?:мероприятие|событие|концерт|вечеринка|туса|афиша)|(?:\d{1,2}\s+(?:январ(?:я|ь)|феврал(?:я|ь)|март(?:а)?|апрел(?:я|ь)|ма(?:я|й)|июн(?:я|ь)|июл(?:я|ь)|август(?:а)?|сентябр(?:я|ь)|октябр(?:я|ь)|ноябр(?:я|ь)|декабр(?:я|ь))(?:\s+20\d{2})?(?:\s*[,;]\s*|\s+)(?:в\s*)?(?:[01]?\d|2[0-3]):[0-5]\d|\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?(?:\s+(?:[01]?\d|2[0-3]):[0-5]\d)?))$/iu;

function isWeakEventIdentityCard(event) {
    const title = String(event?.title ?? '').trim();
    if (!title || WEAK_EVENT_TITLE_RE.test(title)) return true;
    const meaningful = tokenize(title, { removeGeneric: true })
        .filter((token) => token.length >= 2 && !/^\d{1,4}$/u.test(token));
    return meaningful.length === 0;
}

function publisherIdentity(event) {
    const sourceName = normalizeText(event?.sourceName).replace(/^@/u, '');
    if (!sourceName) return '';
    const sourceType = normalizeText(event?.sourceType) || 'source';
    return `${sourceType}:${sourceName}`;
}

export function compareEventsForDuplicate(leftInput, rightInput) {
    if (!leftInput || !rightInput) {
        return {
            duplicate: false,
            score: 0,
            reasons: [],
        };
    }

    const left = enrichEventMetadata(leftInput);
    const right = enrichEventMetadata(rightInput);

    if (
        !left.eventDate ||
        !right.eventDate ||
        String(left.eventDate) !== String(right.eventDate)
    ) {
        return {
            duplicate: false,
            score: 0,
            reasons: ['different-date'],
        };
    }

    const title = textSimilarity(left.title, right.title, {
        removeGeneric: true,
    });
    const description = textSimilarity(
        left.description,
        right.description,
    );
    const descriptionIdentity = tokenSimilarity(
        left.description,
        right.description,
        { removeGeneric: true },
    );
    const participants = neutralFieldSimilarity(
        left.participants,
        right.participants,
        { removeGeneric: true },
    );
    const venue = neutralFieldSimilarity(left.venue, right.venue, {
        removeGeneric: true,
    });
    const time = timeSimilarity(left.eventTime, right.eventTime);
    const source = sourceSimilarity(left, right);
    const sharedLinks = sharedContentLinks(left, right);
    const distinctive = sharedDistinctiveTokenStats(left, right);
    const leftPublisher = publisherIdentity(left);
    const rightPublisher = publisherIdentity(right);
    const samePublisher = Boolean(leftPublisher && rightPublisher && leftPublisher === rightPublisher);
    const publisherScheduleStub = samePublisher && time >= 0.92 && venue >= 0.90 &&
        (isWeakEventIdentityCard(left) !== isWeakEventIdentityCard(right));

    const score = (
        (title * 0.20) +
        (description * 0.27) +
        (participants * 0.14) +
        (venue * 0.10) +
        (time * 0.12) +
        (source * 0.04) +
        (Math.min(1, distinctive.containment) * 0.08) +
        (sharedLinks.length ? 0.05 : 0)
    );

    const semanticAnchor = Math.max(
        title,
        description,
        participants,
        distinctive.containment,
    );
    const sameTicketOrEventLink = (
        sharedLinks.length > 0 &&
        time >= 0.38
    );
    const exactSource = (
        source === 1 &&
        time >= 0.38 &&
        (
            title >= 0.52 ||
            descriptionIdentity >= 0.55 ||
            participants >= 0.62 ||
            distinctive.count >= 2
        )
    );
    const descriptionMatch = (
        description >= 0.70 &&
        descriptionIdentity >= 0.62 &&
        time >= 0.38
    );
    const identityMatch = (
        title >= 0.76 &&
        time >= 0.56 &&
        (
            participants >= 0.62 ||
            venue >= 0.62 ||
            description >= 0.46 ||
            distinctive.count >= 2
        )
    );
    const lineupVenueMatch = (
        participants >= 0.80 &&
        venue >= 0.68 &&
        time >= 0.76
    );
    const rareTokenMatch = (
        time >= 0.76 &&
        distinctive.count >= 3 &&
        distinctive.containment >= 0.34 &&
        (
            description >= 0.42 ||
            descriptionIdentity >= 0.48 ||
            title >= 0.35
        )
    );
    const exactTimeStrongContent = (
        time === 1 &&
        descriptionIdentity >= 0.58 &&
        distinctive.count >= 2
    );
    const weightedMatch = (
        score >= 0.64 &&
        semanticAnchor >= 0.60 &&
        time >= 0.38
    );

    const duplicate = publisherScheduleStub || sameTicketOrEventLink || exactSource ||
        descriptionMatch || identityMatch || lineupVenueMatch ||
        rareTokenMatch || exactTimeStrongContent || weightedMatch;
    const reasons = [];

    if (publisherScheduleStub) reasons.push('same-publisher-schedule-stub');
    if (sameTicketOrEventLink) reasons.push('shared-content-link');
    if (exactSource) reasons.push('same-source-url');
    if (descriptionMatch) reasons.push('description');
    if (identityMatch) reasons.push('title-identity');
    if (lineupVenueMatch) reasons.push('lineup-venue');
    if (rareTokenMatch) reasons.push('distinctive-tokens');
    if (exactTimeStrongContent) reasons.push('exact-time-content');
    if (weightedMatch) reasons.push('weighted');

    return {
        duplicate,
        score,
        reasons,
        components: {
            title,
            description,
            descriptionIdentity,
            participants,
            venue,
            time,
            source,
            sharedLinks,
            distinctiveCount: distinctive.count,
            distinctiveContainment: distinctive.containment,
            distinctiveTokens: distinctive.shared.slice(0, 12),
        },
    };
}

function titleQuality(value, event = {}) {
    const raw = String(value ?? '').trim();
    const normalized = normalizeText(raw);

    if (!normalized) {
        return -100;
    }

    let score = Math.min(30, tokenize(raw, { removeGeneric: true }).length * 6);
    score += Math.min(18, raw.length / 8);

    if (SOURCE_HEADING_PATTERNS.some((pattern) => pattern.test(raw))) {
        score -= 35;
    }

    if (normalizeText(event?.sourceName) === normalized) {
        score -= 24;
    }

    if (normalizeText(event?.venue) === normalized) {
        score -= 18;
    }

    if (/^[\p{Lu}\d\s&._-]+$/u.test(raw) && raw.length <= 40) {
        score -= 2;
    }

    return score;
}

function chooseBestTitle(leftEvent, rightEvent) {
    const leftScore = titleQuality(leftEvent?.title, leftEvent);
    const rightScore = titleQuality(rightEvent?.title, rightEvent);

    if (rightScore > leftScore) {
        return String(rightEvent?.title ?? '').trim();
    }

    return String(leftEvent?.title ?? '').trim();
}

function richness(value) {
    const text = String(value ?? '').trim();

    if (!text) {
        return 0;
    }

    const tokens = tokenize(text);
    const informationMarks = (
        (/(?:\d{1,2}:[0-5]\d)/u.test(text) ? 12 : 0) +
        (/(?:руб|₽|р\.|бесплат|донат|вход)/iu.test(text) ? 10 : 0) +
        (/(?:ул\.|улиц|площад|набереж|пирс|бар|клуб|hall)/iu.test(text) ? 8 : 0)
    );

    return Math.min(80, text.length / 15) +
        Math.min(45, tokens.length * 1.5) +
        informationMarks;
}

function chooseRicher(leftValue, rightValue) {
    const left = String(leftValue ?? '').trim();
    const right = String(rightValue ?? '').trim();

    if (!left) return right;
    if (!right) return left;

    const similarity = textSimilarity(left, right);

    if (similarity >= 0.72) {
        return richness(right) > richness(left) ? right : left;
    }

    return richness(right) > richness(left) ? right : left;
}

function splitList(value) {
    return String(value ?? '')
        .split(/[,;\n|]+/u)
        .map((item) => item.trim())
        .filter(Boolean);
}

function mergeListField(leftValue, rightValue, maximumLength = 1200) {
    const items = [];

    for (const candidate of [...splitList(leftValue), ...splitList(rightValue)]) {
        const normalized = normalizeText(candidate);

        if (!normalized) {
            continue;
        }

        const duplicateIndex = items.findIndex((item) => {
            const score = textSimilarity(item, candidate, {
                removeGeneric: true,
            });
            return score >= 0.82;
        });

        if (duplicateIndex >= 0) {
            if (richness(candidate) > richness(items[duplicateIndex])) {
                items[duplicateIndex] = candidate;
            }
            continue;
        }

        items.push(candidate);
    }

    return items.join(', ').slice(0, maximumLength).trim();
}

function sourcePriority(source) {
    const url = normalizeUrl(source?.sourceUrl);
    const sourceType = String(source?.sourceType ?? '');
    let score = 0;

    /*
     * Публичный пост всегда предпочтительнее записи из личной беседы.
     * Ссылка на беседу персональная и не должна становиться основным источником.
     */
    if (sourceType === 'vk') score += 120;
    if (sourceType === 'telegram') score += 110;
    if (sourceType === 'vk_chat') score += 20;

    if (/^(?:t\.me|vk\.com\/wall)/u.test(url)) {
        score += 35;
    } else if (url) {
        score += 12;
    }

    if (/^vk\.com\/im(?:\/|\?|$)/u.test(url)) {
        score -= 100;
    }

    return score;
}

function eventSources(event) {
    const existing = Array.isArray(event?.mergedSources)
        ? event.mergedSources
        : [];
    const own = {
        sourceType: String(event?.sourceType ?? ''),
        sourceName: String(event?.sourceName ?? ''),
        sourceUrl: String(event?.sourceUrl ?? ''),
    };

    return [...existing, own].filter((source) => (
        source.sourceType || source.sourceName || source.sourceUrl
    ));
}

function mergeSources(left, right) {
    const map = new Map();

    for (const source of [...eventSources(left), ...eventSources(right)]) {
        const key = normalizeUrl(source.sourceUrl) || [
            source.sourceType,
            normalizeText(source.sourceName),
        ].join(':');
        const current = map.get(key);

        if (!current || sourcePriority(source) > sourcePriority(current)) {
            map.set(key, {
                sourceType: String(source.sourceType ?? ''),
                sourceName: String(source.sourceName ?? ''),
                sourceUrl: String(source.sourceUrl ?? ''),
            });
        }
    }

    return [...map.values()].sort((leftSource, rightSource) => (
        sourcePriority(rightSource) - sourcePriority(leftSource)
    ));
}

function choosePrimarySource(sources, fallbackEvent) {
    return sources[0] ?? {
        sourceType: String(fallbackEvent?.sourceType ?? ''),
        sourceName: String(fallbackEvent?.sourceName ?? ''),
        sourceUrl: String(fallbackEvent?.sourceUrl ?? ''),
    };
}

function mergeEventTime(leftEvent, rightEvent) {
    const left = String(leftEvent?.eventTime ?? '').trim();
    const right = String(rightEvent?.eventTime ?? '').trim();

    if (!left) return right || null;
    if (!right) return left || null;
    if (left === right) return left;

    const leftMinutes = parseTime(left);
    const rightMinutes = parseTime(right);

    if (leftMinutes === null) return right;
    if (rightMinutes === null) return left;

    return richness(rightEvent?.description) > richness(leftEvent?.description)
        ? right
        : left;
}

function mergeEventPair(leftInput, rightInput, comparison) {
    const leftEvent = enrichEventMetadata(leftInput);
    const rightEvent = enrichEventMetadata(rightInput);
    const sources = mergeSources(leftEvent, rightEvent);
    const primarySource = choosePrimarySource(sources, leftEvent);
    const imagePaths = [...new Set([
        ...(Array.isArray(leftEvent?.imagePaths) ? leftEvent.imagePaths : []),
        ...(Array.isArray(rightEvent?.imagePaths) ? rightEvent.imagePaths : []),
    ].map((item) => String(item ?? '').trim()).filter(Boolean))];
    const duplicateIds = [...new Set([
        ...(Array.isArray(leftEvent?.duplicateIds) ? leftEvent.duplicateIds : []),
        eventSourceKey(leftEvent),
        ...(Array.isArray(rightEvent?.duplicateIds) ? rightEvent.duplicateIds : []),
        eventSourceKey(rightEvent),
    ])];
    const dedupeMembers = [
        ...(Array.isArray(leftEvent?.dedupeMembers)
            ? leftEvent.dedupeMembers
            : [leftEvent]),
        ...(Array.isArray(rightEvent?.dedupeMembers)
            ? rightEvent.dedupeMembers
            : [rightEvent]),
    ].map((event) => ({
        ...event,
        dedupeMembers: undefined,
    }));
    const contentLinks = [...new Set([
        ...(Array.isArray(leftEvent?.contentLinks) ? leftEvent.contentLinks : []),
        ...(Array.isArray(rightEvent?.contentLinks) ? rightEvent.contentLinks : []),
    ])];

    return enrichEventMetadata({
        ...leftEvent,
        title: chooseBestTitle(leftEvent, rightEvent),
        eventTime: mergeEventTime(leftEvent, rightEvent),
        venue: chooseRicher(leftEvent?.venue, rightEvent?.venue),
        participants: mergeListField(
            leftEvent?.participants,
            rightEvent?.participants,
        ),
        price: chooseRicher(leftEvent?.price, rightEvent?.price),
        description: chooseRicher(
            leftEvent?.description,
            rightEvent?.description,
        ),
        ageRestriction: chooseRicher(
            leftEvent?.ageRestriction,
            rightEvent?.ageRestriction,
        ),
        eventType: chooseRicher(
            leftEvent?.eventType,
            rightEvent?.eventType,
        ),
        contentLinks,
        imagePaths,
        sourceType: primarySource.sourceType,
        sourceName: primarySource.sourceName,
        sourceUrl: primarySource.sourceUrl,
        mergedSources: sources,
        duplicateIds,
        duplicateCount: duplicateIds.length,
        dedupeMembers,
        dedupeScore: Math.max(
            Number(leftEvent?.dedupeScore ?? 0),
            Number(comparison?.score ?? 0),
        ),
        dedupeReasons: [...new Set([
            ...(Array.isArray(leftEvent?.dedupeReasons)
                ? leftEvent.dedupeReasons
                : []),
            ...(Array.isArray(comparison?.reasons)
                ? comparison.reasons
                : []),
        ])],
    });
}

function eventSortKey(event) {
    return `${event?.eventDate ?? ''} ${event?.eventTime ?? '23:59'} ` +
        `${normalizeText(event?.title)}`;
}

function bestClusterComparison(cluster, event) {
    const members = Array.isArray(cluster?.dedupeMembers)
        ? cluster.dedupeMembers
        : [cluster];
    let best = compareEventsForDuplicate(cluster, event);

    for (const member of members) {
        const comparison = compareEventsForDuplicate(member, event);

        if (
            comparison.duplicate &&
            (!best.duplicate || comparison.score > best.score)
        ) {
            best = comparison;
        }
    }

    return best;
}

export function deduplicateUpcomingEvents(events) {
    const input = Array.isArray(events)
        ? events.filter(Boolean).map((event) => enrichEventMetadata(event))
        : [];
    const sorted = [...input].sort((left, right) => (
        eventSortKey(left).localeCompare(eventSortKey(right), 'ru')
    ));
    const clusters = [];
    const merges = [];

    for (const event of sorted) {
        let bestClusterIndex = -1;
        let bestComparison = null;

        for (let index = clusters.length - 1; index >= 0; index -= 1) {
            const cluster = clusters[index];

            if (String(cluster.eventDate) !== String(event.eventDate)) {
                if (String(cluster.eventDate) < String(event.eventDate)) {
                    break;
                }
                continue;
            }

            const comparison = bestClusterComparison(cluster, event);

            if (
                comparison.duplicate &&
                (!bestComparison || comparison.score > bestComparison.score)
            ) {
                bestClusterIndex = index;
                bestComparison = comparison;
            }
        }

        if (bestClusterIndex < 0) {
            clusters.push({
                ...event,
                mergedSources: mergeSources(event, {}),
                duplicateIds: [eventSourceKey(event)],
                duplicateCount: 1,
                dedupeMembers: [event],
            });
            continue;
        }

        const before = clusters[bestClusterIndex];
        const merged = mergeEventPair(before, event, bestComparison);
        clusters[bestClusterIndex] = merged;
        merges.push({
            eventDate: String(event.eventDate ?? ''),
            leftTitle: String(before.title ?? ''),
            rightTitle: String(event.title ?? ''),
            resultTitle: String(merged.title ?? ''),
            score: Number(bestComparison.score.toFixed(3)),
            reasons: bestComparison.reasons,
            sharedLinks: bestComparison.components?.sharedLinks ?? [],
            distinctiveTokens:
                bestComparison.components?.distinctiveTokens ?? [],
        });
    }

    /*
     * Вторая сверка делает результат независимым от порядка источников.
     * Она схлопывает кластеры, которые стали очевидными дублями только после
     * объединения дополнительных участников, ссылок и текста анонса.
     */
    let changed = true;

    while (changed) {
        changed = false;

        outer:
        for (let leftIndex = 0; leftIndex < clusters.length; leftIndex += 1) {
            for (
                let rightIndex = leftIndex + 1;
                rightIndex < clusters.length;
                rightIndex += 1
            ) {
                if (
                    String(clusters[leftIndex].eventDate) !==
                    String(clusters[rightIndex].eventDate)
                ) {
                    continue;
                }

                const comparison = bestClusterComparison(
                    clusters[leftIndex],
                    clusters[rightIndex],
                );

                if (!comparison.duplicate) {
                    continue;
                }

                const before = clusters[leftIndex];
                const right = clusters[rightIndex];
                const merged = mergeEventPair(before, right, comparison);
                clusters[leftIndex] = merged;
                clusters.splice(rightIndex, 1);
                merges.push({
                    eventDate: String(merged.eventDate ?? ''),
                    leftTitle: String(before.title ?? ''),
                    rightTitle: String(right.title ?? ''),
                    resultTitle: String(merged.title ?? ''),
                    score: Number(comparison.score.toFixed(3)),
                    reasons: comparison.reasons,
                    sharedLinks: comparison.components?.sharedLinks ?? [],
                    distinctiveTokens:
                        comparison.components?.distinctiveTokens ?? [],
                });
                changed = true;
                break outer;
            }
        }
    }

    clusters.sort((left, right) => (
        eventSortKey(left).localeCompare(eventSortKey(right), 'ru')
    ));

    return {
        events: clusters.map((event) => {
            const { dedupeMembers, ...publicEvent } = event;
            return publicEvent;
        }),
        merges,
        inputCount: input.length,
        outputCount: clusters.length,
        mergedCount: input.length - clusters.length,
    };
}

export const eventDeduplicationInternals = {
    normalizeText,
    normalizeUrl,
    textSimilarity,
    timeSimilarity,
    titleQuality,
};
