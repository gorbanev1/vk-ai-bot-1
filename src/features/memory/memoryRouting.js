import { parseBotIdentityProvocation } from '../personality/botIdentityProvocationRouting.js';

/**
 * Команды явной памяти: запомнить, забыть, поиск похожих записей и формат контекста для модели.
 */
const REMEMBER_PREFIX = /^(?:пожалуйста\s+)?(?:(?:можешь\s+)?(?:запомни(?:те|ть)?|запоминай(?:те)?|запомнить)|(?:запиши(?:те)?|сохрани(?:те)?)\s+(?:это\s+)?в\s+память|(?:добавь(?:те)?|внеси(?:те)?)\s+(?:это\s+)?в\s+память|(?:зафиксируй(?:те)?|держи(?:те)?)\s+(?:это\s+)?в\s+памяти|помни)(?=$|[\s:,.!?—–-])/iu;

const FORGET_PREFIX = /^(?:пожалуйста\s+)?(?:(?:можешь\s+)?(?:ра[зс]помни(?:те|ть)?|раззапомни(?:те|ть)?|забудь(?:те)?|забыть)|(?:удали(?:те)?|сотри(?:те)?)\s+(?:это\s+)?(?:из|с)\s+памяти|(?:очисти(?:те)?|почисти(?:те)?)\s+(?:всю\s+)?память(?:\s+(?:от|про|о|об|по\s+теме))?|(?:не\s+помни(?:те)?)(?:\s+больше)?)(?=$|[\s:,.!?—–-])/iu;

const FORGET_LEADING_NOISE = /^(?:(?:все|всё|всю\s+информацию|все\s+записи|всё\s+про|все\s+про)\s+)?(?:(?:ключевое\s+)?слово\s+)?(?:(?:про|о|об|обо|насч[её]т|по\s+теме)\s+)?/iu;

const REPLY_POINTER = /^(?:это|вот\s+это|это\s+сообщение|сообщение|его|её|ее)$/iu;

const STORED_BOT_PREFIX = /^(?:(?:\[club\d+\|)?(?:гигорейв|гигарейв|гигорейф|гигарейф|гигорэйв)(?:\])?|@gigor(?:e|a)?(?:y|i)ve?)\s*(?:[:,.!?—–-]+\s*)?/iu;

const MEMORY_DATABASE_SCAN_PATTERNS = [
    /^(?:просканируй|сканируй|пересканируй|проверь)\s+(?:(?:всю|полную)\s+)?(?:(?:базу|бд)(?:\s+сообщений)?\s+)?(?:на|по)\s+(?:(?:слово|команду|команды)\s+)?[«"'`]?(?:запомни(?:ть)?|запоминай|запомнить)[»"'`]?$/iu,
    /^(?:импортируй|собери|перенеси)\s+(?:все\s+)?(?:(?:команды|сообщения)\s+)?(?:запомни(?:ть)?|запоминай|запомнить)\s+(?:из|с)\s+(?:базы|бд|истории|сообщений)$/iu,
    /^(?:обнови|пересобери)\s+память\s+(?:из|по)\s+(?:базе|базы|бд|истории|сообщениям)$/iu,
];

const REMEMBER_COMMAND_MARKER = /(?:запомни|запоминай|запомнить|(?:запиши|сохрани|добавь|внеси)\s+(?:это\s+)?в\s+память|(?:зафиксируй|держи)\s+(?:это\s+)?в\s+памяти|помни)/iu;

const STOP_WORDS = new Set([
    'а', 'без', 'бы', 'был', 'была', 'были', 'было', 'быть', 'в', 'вам',
    'вас', 'весь', 'во', 'вот', 'все', 'всего', 'всех', 'вы', 'где', 'да',
    'для', 'до', 'его', 'ее', 'её', 'если', 'есть', 'еще', 'ещё', 'же', 'за',
    'зачем', 'здесь', 'и', 'из', 'или', 'им', 'их', 'как', 'какая', 'какие',
    'какой', 'кем', 'когда', 'кого', 'который', 'кто', 'ли', 'мне', 'может',
    'можно', 'мой', 'моя', 'мы', 'на', 'над', 'надо', 'наш', 'не', 'него',
    'нее', 'неё', 'нет', 'ни', 'них', 'но', 'о', 'об', 'она', 'они', 'оно',
    'от', 'по', 'под', 'почему', 'про', 'расскажи', 'с', 'со', 'так', 'такое',
    'такой', 'там', 'тебе', 'тебя', 'то', 'того', 'тоже', 'тот', 'ты', 'у',
    'уже', 'чего', 'чем', 'что', 'эта', 'эти', 'это', 'этот', 'я',
    'значит', 'означает', 'такое', 'такой', 'такая', 'такие', 'известно',
    'напомни', 'объясни', 'скажи', 'расскажи', 'знаешь', 'помнишь',
    'гигорейв', 'gpt', 'про', 'подробно', 'подробнее', 'детально',
]);

const RUSSIAN_ENDINGS = [
    'иями', 'ями', 'ами', 'евами', 'овами', 'иями', 'ого', 'его', 'ому',
    'ему', 'ыми', 'ими', 'иях', 'ах', 'ях', 'ов', 'ев', 'ей', 'ий', 'ый',
    'ой', 'ая', 'яя', 'ое', 'ее', 'ие', 'ые', 'ую', 'юю', 'ам', 'ям', 'ом',
    'ем', 'им', 'ым', 'их', 'ых', 'ою', 'ею', 'ы', 'и', 'а', 'я', 'у', 'ю',
    'е', 'о', 'ь',
];

export function isMemoryDatabaseScanCommand(text) {
    const value = String(text ?? '')
        .normalize('NFKC')
        .trim()
        .replace(/\s+/gu, ' ');

    return MEMORY_DATABASE_SCAN_PATTERNS.some((pattern) => pattern.test(value));
}

export function containsRememberCommandMarker(text) {
    return REMEMBER_COMMAND_MARKER.test(String(text ?? ''));
}

export function parseStoredRememberCommand(text) {
    const raw = String(text ?? '').normalize('NFKC').trim();

    if (!raw) {
        return {
            matched: false,
            body: '',
            useReply: false,
            commandText: '',
        };
    }

    const candidates = [raw];
    const withoutBotPrefix = raw.replace(STORED_BOT_PREFIX, '').trim();

    if (withoutBotPrefix && withoutBotPrefix !== raw) {
        candidates.unshift(withoutBotPrefix);
    }

    for (const candidate of candidates) {
        const parsed = parseRememberCommand(candidate);

        if (parsed.matched) {
            return {
                ...parsed,
                commandText: candidate,
            };
        }
    }

    return {
        matched: false,
        body: '',
        useReply: false,
        commandText: '',
    };
}

export function parseRememberCommand(text) {
    const value = String(text ?? '').trim();

    if (parseBotIdentityProvocation(value).matched) {
        return {
            matched: false,
            body: '',
            useReply: false,
            blockedAsBotIdentityProvocation: true,
        };
    }

    const match = value.match(REMEMBER_PREFIX);

    if (!match) {
        return {
            matched: false,
            body: '',
            useReply: false,
        };
    }

    const body = value
        .slice(match[0].length)
        .replace(/^[\s:,.!?—–-]+/u, '')
        .replace(/^что\s+/iu, '')
        .trim();

    return {
        matched: true,
        body,
        useReply: !body || REPLY_POINTER.test(body),
    };
}


export function parseForgetCommand(text) {
    const value = String(text ?? '').normalize('NFKC').trim();
    const match = value.match(FORGET_PREFIX);

    if (!match) {
        return {
            matched: false,
            body: '',
            useReply: false,
        };
    }

    const body = value
        .slice(match[0].length)
        .replace(/^[\s:,.!?—–-]+/u, '')
        .replace(FORGET_LEADING_NOISE, '')
        .trim();

    return {
        matched: true,
        body,
        useReply: !body || REPLY_POINTER.test(body),
    };
}

export function normalizeMemoryText(text) {
    return String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/https?:\/\/\S+/giu, ' ')
        .replace(/\[[^\]|]+\|([^\]]+)\]/gu, '$1')
        .replace(/[^\p{L}\p{N}_@.+-]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function stemToken(token) {
    const value = String(token ?? '');

    if (value.length < 5 || /\d/u.test(value) || value.startsWith('@')) {
        return value;
    }

    for (const ending of RUSSIAN_ENDINGS) {
        if (value.endsWith(ending) && value.length - ending.length >= 4) {
            return value.slice(0, -ending.length);
        }
    }

    return value;
}

export function tokenizeMemoryText(text, { keepStopWords = false } = {}) {
    const normalized = normalizeMemoryText(text);

    if (!normalized) {
        return [];
    }

    const result = [];
    const seen = new Set();

    for (const token of normalized.split(' ')) {
        if (!token || token.length < 2) {
            continue;
        }

        if (!keepStopWords && STOP_WORDS.has(token)) {
            continue;
        }

        if (!seen.has(token)) {
            result.push(token);
            seen.add(token);
        }
    }

    return result;
}

function buildPhrases(tokens) {
    const phrases = [];

    for (let size = Math.min(4, tokens.length); size >= 2; size -= 1) {
        for (let index = 0; index <= tokens.length - size; index += 1) {
            phrases.push(tokens.slice(index, index + size).join(' '));
        }
    }

    return phrases;
}

function tokenMatches(queryToken, memoryToken) {
    if (queryToken === memoryToken) {
        return 'exact';
    }

    const queryStem = stemToken(queryToken);
    const memoryStem = stemToken(memoryToken);

    if (
        queryStem.length >= 4 &&
        memoryStem.length >= 4 &&
        queryStem === memoryStem
    ) {
        return 'stem';
    }

    if (
        queryToken.length >= 5 &&
        memoryToken.length >= 5 &&
        (
            queryToken.startsWith(memoryToken) ||
            memoryToken.startsWith(queryToken)
        )
    ) {
        return 'prefix';
    }

    return null;
}

export function rankMemoryEntries(entries, query, {
    limit = 5,
    minimumScore = 8,
} = {}) {
    const queryTokens = tokenizeMemoryText(query);

    if (!queryTokens.length) {
        return {
            queryTokens: [],
            matches: [],
        };
    }

    const preparedEntries = entries.map((entry) => {
        const normalizedText = normalizeMemoryText(
            entry.memoryText ?? entry.normalizedText ?? entry.rawMessage,
        );
        const tokens = tokenizeMemoryText(normalizedText, {
            keepStopWords: true,
        });

        return {
            entry,
            normalizedText,
            tokens,
        };
    });
    const documentFrequency = new Map();

    for (const { tokens } of preparedEntries) {
        for (const token of new Set(tokens)) {
            documentFrequency.set(
                token,
                Number(documentFrequency.get(token) ?? 0) + 1,
            );
        }
    }

    const queryPhrases = buildPhrases(queryTokens);
    const matches = [];

    for (const prepared of preparedEntries) {
        let score = 0;
        let exactMatches = 0;
        let fuzzyMatches = 0;
        const matchTerms = [];

        for (const queryToken of queryTokens) {
            let bestMatch = null;
            let matchedMemoryToken = '';

            for (const memoryToken of prepared.tokens) {
                const kind = tokenMatches(queryToken, memoryToken);

                if (!kind) {
                    continue;
                }

                if (
                    bestMatch === null ||
                    (kind === 'exact' && bestMatch !== 'exact') ||
                    (kind === 'stem' && bestMatch === 'prefix')
                ) {
                    bestMatch = kind;
                    matchedMemoryToken = memoryToken;
                }
            }

            if (!bestMatch) {
                continue;
            }

            const frequency = Number(
                documentFrequency.get(matchedMemoryToken) ?? 1,
            );
            const rarity = 1 / (1 + Math.log2(Math.max(1, frequency)));

            if (bestMatch === 'exact') {
                score += 6 * rarity;
                exactMatches += 1;
            } else if (bestMatch === 'stem') {
                score += 3.2 * rarity;
                fuzzyMatches += 1;
            } else {
                score += 1.8 * rarity;
                fuzzyMatches += 1;
            }

            matchTerms.push(queryToken);
        }

        for (const phrase of queryPhrases) {
            if (prepared.normalizedText.includes(phrase)) {
                score += Math.min(12, 4 + phrase.split(' ').length * 2);
            }
        }

        const matchedCount = exactMatches + fuzzyMatches;
        const coverage = matchedCount / queryTokens.length;
        score += coverage * 8;

        if (queryTokens.length === 1 && exactMatches === 1) {
            score += 3;
        }

        if (
            score < minimumScore ||
            matchedCount === 0 ||
            (exactMatches === 0 && fuzzyMatches < 2)
        ) {
            continue;
        }

        matches.push({
            ...prepared.entry,
            score: Number(score.toFixed(3)),
            matchTerms: [...new Set(matchTerms)],
            coverage: Number(coverage.toFixed(3)),
        });
    }

    matches.sort((left, right) =>
        right.score - left.score ||
        Number(right.createdAt ?? 0) - Number(left.createdAt ?? 0) ||
        Number(right.id ?? 0) - Number(left.id ?? 0),
    );

    return {
        queryTokens,
        matches: matches.slice(0, Math.max(1, Number(limit) || 5)),
    };
}


function extractDefinitionSubjectTokens(text) {
    const source = String(text ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .trim();

    if (!source) {
        return [];
    }

    const firstLine = source.split(/[\n.!?]/u, 1)[0].trim();
    const patterns = [
        /^(.{2,120}?)\s+(?:это|значит|означает|является|называется)\s+/iu,
        /^(.{2,120}?)\s*(?:—|–|-)\s+/u,
        /^(.{2,120}?):\s+/u,
    ];

    for (const pattern of patterns) {
        const match = firstLine.match(pattern);

        if (!match) {
            continue;
        }

        const tokens = tokenizeMemoryText(match[1]);

        if (tokens.length) {
            return tokens.slice(0, 8);
        }
    }

    return [];
}

export function findMemoriesToForget(entries, query, {
    limit = 5000,
} = {}) {
    const queryTokens = tokenizeMemoryText(query);
    const normalizedQuery = normalizeMemoryText(query);

    if (!queryTokens.length || !normalizedQuery) {
        return {
            queryTokens: [],
            matches: [],
        };
    }

    const ranked = rankMemoryEntries(entries, query, {
        limit: Math.max(1, Number(limit) || 5000),
        minimumScore: 5,
    });
    const rankedById = new Map(
        ranked.matches.map((entry) => [Number(entry.id), entry]),
    );
    const matches = [];

    for (const entry of entries) {
        const id = Number(entry.id);
        const normalizedText = normalizeMemoryText(
            entry.memoryText ?? entry.normalizedText ?? entry.rawMessage,
        );
        const memoryTokens = tokenizeMemoryText(normalizedText, {
            keepStopWords: true,
        });
        const definitionTokens = extractDefinitionSubjectTokens(
            entry.memoryText ?? entry.rawMessage,
        );
        const reasons = [];
        let score = Number(rankedById.get(id)?.score ?? 0);
        let matchedTokens = 0;

        if (
            normalizedText === normalizedQuery ||
            normalizedText.includes(normalizedQuery)
        ) {
            score += normalizedText === normalizedQuery ? 30 : 18;
            reasons.push(
                normalizedText === normalizedQuery
                    ? 'полное совпадение'
                    : 'ключевая фраза в записи',
            );
        }

        for (const queryToken of queryTokens) {
            const memoryMatch = memoryTokens.some((memoryToken) =>
                tokenMatches(queryToken, memoryToken),
            );
            const definitionMatch = definitionTokens.some((definitionToken) =>
                tokenMatches(queryToken, definitionToken),
            );

            if (memoryMatch) {
                matchedTokens += 1;
            }

            if (definitionMatch) {
                score += 16;
                reasons.push(`определение: ${queryToken}`);
            }
        }

        const coverage = matchedTokens / queryTokens.length;

        if (coverage === 1) {
            score += 10;
            reasons.push('совпали все ключевые слова');
        } else if (matchedTokens > 0) {
            score += coverage * 5;
        }

        if (rankedById.has(id)) {
            reasons.push('смысловое совпадение');
        }

        const definitionMatched = reasons.some((reason) =>
            reason.startsWith('определение:'),
        );
        const rankedMatchIsStrong = rankedById.has(id) && (
            queryTokens.length === 1 ||
            coverage >= 0.66
        );
        const shouldForget = (
            definitionMatched ||
            normalizedText.includes(normalizedQuery) ||
            coverage === 1 ||
            rankedMatchIsStrong
        );

        if (!shouldForget) {
            continue;
        }

        matches.push({
            ...entry,
            score: Number(score.toFixed(3)),
            matchTerms: [...new Set([
                ...(rankedById.get(id)?.matchTerms ?? []),
                ...queryTokens.filter((queryToken) =>
                    memoryTokens.some((memoryToken) =>
                        tokenMatches(queryToken, memoryToken),
                    ),
                ),
            ])],
            reasons: [...new Set(reasons)],
        });
    }

    matches.sort((left, right) =>
        right.score - left.score ||
        Number(right.updatedAt ?? right.createdAt ?? 0) -
            Number(left.updatedAt ?? left.createdAt ?? 0) ||
        Number(right.id ?? 0) - Number(left.id ?? 0),
    );

    return {
        queryTokens,
        matches: matches.slice(0, Math.max(1, Number(limit) || 5000)),
    };
}

export function formatMemoryContext(matches, {
    maxCharacters = 9000,
} = {}) {
    const lines = [];
    let used = 0;

    for (const match of matches) {
        const date = Number(match.createdAt ?? 0) > 0
            ? new Date(Number(match.createdAt) * 1000).toISOString()
            : 'дата неизвестна';
        const text = String(match.memoryText ?? match.rawMessage ?? '')
            .trim()
            .slice(0, 3500);
        const author = String(match.authorName ?? '').trim() ||
            `VK ${Number(match.authorId ?? 0)}`;
        const block = [
            `[Сохранённая память; автор ${author}; ${date}]`,
            text,
        ].join('\n');

        if (used + block.length > maxCharacters) {
            break;
        }

        lines.push(block);
        used += block.length + 2;
    }

    return lines.join('\n\n');
}
