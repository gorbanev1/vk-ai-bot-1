import {
    findDirectParticipantReference,
    getParticipantIdentityGroupId,
    participantBelongsToIdentityGroup,
    normalizeParticipantAlias,
    normalizedNameSimilarity,
    PARTICIPANT_NAME_PART_MIN_SCORE,
    participantNamePartSimilarity,
} from '../personality/roastCommandRouting.js';

const STOP_WORDS = new Set([
    'а', 'без', 'бы', 'был', 'была', 'были', 'быть', 'в', 'вам', 'вас',
    'весь', 'все', 'всегда', 'всё', 'где', 'для', 'до', 'его', 'ее', 'её',
    'если', 'есть', 'же', 'за', 'зачем', 'и', 'из', 'или', 'им', 'как', 'какой',
    'когда', 'кто', 'ли', 'мне', 'на', 'над', 'не', 'него', 'ней', 'нет', 'но',
    'о', 'об', 'он', 'она', 'они', 'от', 'по', 'под', 'почему', 'про', 'с',
    'со', 'так', 'такой', 'там', 'тебе', 'то', 'тот', 'ты', 'у', 'уже',
    'хочет', 'что', 'чего', 'это', 'этот', 'эта', 'я', 'гигорейв', 'gpt',
]);

const NORMALIZED_STOP_WORDS = new Set(
    [...STOP_WORDS].map((word) => normalizeParticipantAlias(word)).filter(Boolean),
);

const BOT_SELF_TARGET_PATTERN = /(?:^|[\s,;:!?])(?:ты|тебя|тебе|тобой|твой|твоя|твоё|твое|твои|у\s+тебя|про\s+себя|о\s+себе|сам\s+себя|свои?\s+(?:сообщени(?:е|я|й)|ответ(?:ы|ов)?|реплик(?:и|у|ах)?))(?=$|[\s,;:!?])/iu;

const PARTICIPANT_QUESTION_PATTERN = /(?:\?|\b(?:почему|зачем|кто\s+такой|кто\s+такая|что\s+думаешь\s+(?:о|про)|расскажи\s+(?:о|про)|какой\s+он|какая\s+она|чего\s+он|чего\s+она|из-за\s+чего|отчего|постоянно|всё\s+время|все\s+время|любит|ненавидит|хочет|делает|вед[её]т\s+себя|общается|пишет)\b)/iu;

function compact(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function uniqueAliases(participant) {
    const aliases = [
        participant?.displayName,
        participant?.externalUserId,
        ...(Array.isArray(participant?.aliases) ? participant.aliases : []),
    ];
    const result = new Set();

    for (const raw of aliases) {
        const clean = compact(raw);

        if (!clean) {
            continue;
        }

        result.add(clean);

        for (const token of clean.split(/[\s,;|/()[\]{}]+/u)) {
            if (token.length >= 2) {
                result.add(token);
            }
        }
    }

    return [...result];
}

function jaroSimilarity(left, right) {
    const a = String(left ?? '');
    const b = String(right ?? '');

    if (a === b) {
        return a ? 1 : 0;
    }

    if (!a || !b) {
        return 0;
    }

    const range = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
    const leftMatches = new Array(a.length).fill(false);
    const rightMatches = new Array(b.length).fill(false);
    let matches = 0;

    for (let i = 0; i < a.length; i += 1) {
        const start = Math.max(0, i - range);
        const end = Math.min(i + range + 1, b.length);

        for (let j = start; j < end; j += 1) {
            if (rightMatches[j] || a[i] !== b[j]) {
                continue;
            }

            leftMatches[i] = true;
            rightMatches[j] = true;
            matches += 1;
            break;
        }
    }

    if (!matches) {
        return 0;
    }

    const leftSequence = [];
    const rightSequence = [];

    for (let i = 0; i < a.length; i += 1) {
        if (leftMatches[i]) {
            leftSequence.push(a[i]);
        }
    }

    for (let i = 0; i < b.length; i += 1) {
        if (rightMatches[i]) {
            rightSequence.push(b[i]);
        }
    }

    let transpositions = 0;

    for (let i = 0; i < leftSequence.length; i += 1) {
        if (leftSequence[i] !== rightSequence[i]) {
            transpositions += 1;
        }
    }

    return (
        matches / a.length +
        matches / b.length +
        (matches - transpositions / 2) / matches
    ) / 3;
}

function jaroWinklerSimilarity(left, right) {
    const a = normalizeParticipantAlias(left).replace(/\s+/gu, '');
    const b = normalizeParticipantAlias(right).replace(/\s+/gu, '');

    if (!a || !b) {
        return 0;
    }

    const jaro = jaroSimilarity(a, b);
    let prefix = 0;

    while (
        prefix < 4 &&
        prefix < a.length &&
        prefix < b.length &&
        a[prefix] === b[prefix]
    ) {
        prefix += 1;
    }

    return jaro + prefix * 0.1 * (1 - jaro);
}

function commonPrefixScore(left, right) {
    const a = normalizeParticipantAlias(left).replace(/\s+/gu, '');
    const b = normalizeParticipantAlias(right).replace(/\s+/gu, '');

    if (!a || !b) {
        return 0;
    }

    let prefix = 0;

    while (
        prefix < a.length &&
        prefix < b.length &&
        a[prefix] === b[prefix]
    ) {
        prefix += 1;
    }

    if (prefix < 3) {
        return 0;
    }

    const coverage = prefix / Math.min(a.length, b.length);
    return Math.min(0.94, 0.55 + coverage * 0.39);
}

function scorePhraseAgainstAlias(phrase, alias) {
    const normalizedPhrase = normalizeParticipantAlias(phrase);
    const normalizedAlias = normalizeParticipantAlias(alias);

    if (!normalizedPhrase || !normalizedAlias) {
        return 0;
    }

    const aliasTokens = normalizedAlias.split(' ').filter(Boolean);
    const phraseTokens = normalizedPhrase.split(' ').filter(Boolean);
    const candidates = [normalizedAlias, ...aliasTokens];
    let best = 0;

    for (const candidate of candidates) {
        const editScore = normalizedNameSimilarity(normalizedPhrase, candidate);
        const winklerScore = jaroWinklerSimilarity(normalizedPhrase, candidate);
        const prefixScore = commonPrefixScore(normalizedPhrase, candidate);
        best = Math.max(best, editScore, winklerScore, prefixScore);
    }

    if (phraseTokens.length > 1 && aliasTokens.length > 1) {
        const coverage = phraseTokens.map((phraseToken) => Math.max(
            ...aliasTokens.map((aliasToken) => Math.max(
                normalizedNameSimilarity(phraseToken, aliasToken),
                jaroWinklerSimilarity(phraseToken, aliasToken),
                commonPrefixScore(phraseToken, aliasToken),
            )),
            0,
        ));
        const average = coverage.reduce((sum, value) => sum + value, 0) /
            coverage.length;
        best = Math.max(best, average);
    }

    return Math.max(0, Math.min(1, best));
}

function extractCandidatePhrases(question) {
    const directReferences = compact(question).match(
        /(?:\[id\d+\|[^\]]+\]|@[\p{L}\p{N}_.-]{2,64})/giu,
    ) ?? [];
    const words = compact(question)
        .replace(/\[id\d+\|[^\]]+\]/giu, ' ')
        .match(/[\p{L}\p{N}_-]{3,64}/gu) ?? [];
    const phrases = new Set(directReferences);

    for (let index = 0; index < words.length; index += 1) {
        const normalizedWord = normalizeParticipantAlias(words[index]);

        if (!normalizedWord || NORMALIZED_STOP_WORDS.has(normalizedWord)) {
            continue;
        }

        phrases.add(words[index]);

        for (let size = 2; size <= 3; size += 1) {
            const slice = words.slice(index, index + size);

            if (slice.length !== size) {
                continue;
            }

            const normalizedSlice = slice.map(normalizeParticipantAlias);

            if (normalizedSlice.some((token) => !token || NORMALIZED_STOP_WORDS.has(token))) {
                continue;
            }

            phrases.add(slice.join(' '));
        }
    }

    return [...phrases];
}

function rankQuestionMatches(question, participants) {
    const phrases = extractCandidatePhrases(question);
    const ranked = [];

    for (const participant of participants) {
        let bestScore = 0;
        let bestPartScore = 0;
        let bestPhrase = '';
        let bestAlias = '';

        for (const phrase of phrases) {
            const partScore = participantNamePartSimilarity(phrase, participant);
            if (partScore > bestPartScore) bestPartScore = partScore;
            for (const alias of uniqueAliases(participant)) {
                const score = scorePhraseAgainstAlias(phrase, alias);

                if (score > bestScore) {
                    bestScore = score;
                    bestPhrase = phrase;
                    bestAlias = alias;
                }
            }
        }

        // Fuzzy/Jaro/prefix scoring may rank candidates, but it is never enough
        // to accept a person by itself. At least one name/alias part must have
        // Strictly more than 80% normalized similarity (or an explicit identity group).
        if (bestScore > 0 && bestPartScore > PARTICIPANT_NAME_PART_MIN_SCORE) {
            ranked.push({
                participant,
                score: Number(Math.max(bestScore, bestPartScore).toFixed(6)),
                partScore: Number(bestPartScore.toFixed(6)),
                matchedPhrase: bestPhrase,
                matchedAlias: bestAlias,
            });
        }
    }

    return ranked.sort((left, right) =>
        right.score - left.score ||
        Number(right.participant?.lastSeenAt ?? 0) - Number(left.participant?.lastSeenAt ?? 0) ||
        Number(left.participant?.userId ?? 0) - Number(right.participant?.userId ?? 0));
}

export function looksLikeBotSelfTargetQuestion(value) {
    const question = compact(value);
    return Boolean(question && BOT_SELF_TARGET_PATTERN.test(question));
}

export function looksLikeParticipantQuestion(value) {
    const question = compact(value);
    return Boolean(
        question &&
        !looksLikeBotSelfTargetQuestion(question) &&
        PARTICIPANT_QUESTION_PATTERN.test(question)
    );
}

export function resolveParticipantReferenceTarget(reference, participants, {
    minimumScore = PARTICIPANT_NAME_PART_MIN_SCORE,
} = {}) {
    const safeParticipants = Array.isArray(participants)
        ? participants.filter((participant) => Number(participant?.userId) > 0)
        : [];
    const cleanReference = compact(reference);

    if (!cleanReference || !safeParticipants.length) {
        return {
            matched: false,
            participant: null,
            score: 0,
            matchedPhrase: '',
            matchedAlias: '',
            ranking: [],
        };
    }

    const directCandidates = extractCandidatePhrases(cleanReference);

    for (const candidate of directCandidates) {
        const direct = findDirectParticipantReference(candidate, safeParticipants);

        if (direct) {
            return {
                matched: true,
                participant: direct,
                score: 1,
                matchedPhrase: candidate,
                matchedAlias: candidate,
                ranking: [{ participant: direct, score: 1, partScore: 1 }],
            };
        }
    }

    // Before applying a standalone project nickname/first-name bridge, prefer
    // an exact multi-word name/alias from the roster. Thus «Тимофей» keeps the
    // configured Timasin default, while an explicit «Тимофей Другой» can still
    // resolve to that different participant if such a full name actually exists.
    const exactNameCandidates = [...directCandidates].sort((left, right) =>
        normalizeParticipantAlias(right).split(' ').length -
        normalizeParticipantAlias(left).split(' ').length ||
        String(right).length - String(left).length);
    for (const candidate of exactNameCandidates) {
        const normalizedCandidate = normalizeParticipantAlias(candidate);
        if (!normalizedCandidate || !normalizedCandidate.includes(' ')) continue;
        const exactParticipant = safeParticipants.find((participant) =>
            uniqueAliases(participant).some((alias) =>
                normalizeParticipantAlias(alias) === normalizedCandidate));
        if (!exactParticipant) continue;
        return {
            matched: true,
            participant: exactParticipant,
            score: 1,
            matchedPhrase: candidate,
            matchedAlias: candidate,
            ranking: [{ participant: exactParticipant, score: 1, partScore: 1 }],
        };
    }

    // Explicit project identity aliases are resolved before generic fuzzy name
    // ranking. This is required for one human represented by multiple VK IDs:
    // «Тимасин»/«Тимофей» means the configured Timasin identity group, not an
    // arbitrary participant who merely shares the first name.
    for (const candidate of directCandidates) {
        const groupId = getParticipantIdentityGroupId(candidate);
        if (!groupId) continue;
        const groupParticipants = safeParticipants
            .filter((participant) => participantBelongsToIdentityGroup(participant, groupId))
            .sort((left, right) =>
                Number(right?.lastSeenAt || 0) - Number(left?.lastSeenAt || 0) ||
                Number(left?.userId || 0) - Number(right?.userId || 0));
        if (!groupParticipants.length) continue;
        return {
            matched: true,
            participant: groupParticipants[0],
            score: 1,
            matchedPhrase: candidate,
            matchedAlias: candidate,
            identityGroupId: groupId,
            ranking: groupParticipants.map((participant) => ({
                participant,
                score: 1,
                partScore: 1,
            })),
        };
    }

    const ranking = rankQuestionMatches(cleanReference, safeParticipants);
    const top = ranking[0];

    if (
        !top ||
        top.score < minimumScore ||
        Number(top.partScore || 0) <= PARTICIPANT_NAME_PART_MIN_SCORE
    ) {
        return {
            matched: false,
            participant: null,
            score: top?.score ?? 0,
            matchedPhrase: top?.matchedPhrase ?? '',
            matchedAlias: top?.matchedAlias ?? '',
            ranking,
        };
    }

    return {
        matched: true,
        participant: top.participant,
        score: top.score,
        matchedPhrase: top.matchedPhrase,
        matchedAlias: top.matchedAlias,
        ambiguous: Boolean(
            ranking[1] && top.score - ranking[1].score < 0.025,
        ),
        ranking,
    };
}

export function resolveParticipantQuestionTarget(question, participants, {
    minimumScore = PARTICIPANT_NAME_PART_MIN_SCORE,
} = {}) {
    if (!looksLikeParticipantQuestion(question)) {
        return {
            matched: false,
            participant: null,
            score: 0,
            matchedPhrase: '',
            matchedAlias: '',
            ranking: [],
        };
    }

    return resolveParticipantReferenceTarget(
        question,
        participants,
        { minimumScore },
    );
}

function buildParticipantMentionAliases(participant, matchedPhrase = '') {
    const aliases = uniqueAliases({
        ...participant,
        aliases: [
            matchedPhrase,
            ...(Array.isArray(participant?.aliases) ? participant.aliases : []),
        ],
    });
    const result = new Set();

    for (const alias of aliases) {
        const clean = compact(alias);
        const normalized = normalizeParticipantAlias(clean);

        if (!normalized || /^\d+$/u.test(normalized)) {
            continue;
        }

        if (normalized.length >= 3) {
            result.add(clean);
        }
    }

    return [...result];
}

function extractMentionCandidates(text) {
    const source = compact(text);
    const directReferences = source.match(
        /(?:\[id\d+\|[^\]]+\]|@[\p{L}\p{N}_.-]{2,64})/giu,
    ) ?? [];
    const words = source.match(/[\p{L}\p{N}_-]{3,64}/gu) ?? [];
    const candidates = new Set(directReferences);

    for (let index = 0; index < words.length; index += 1) {
        candidates.add(words[index]);

        for (let size = 2; size <= 3; size += 1) {
            const slice = words.slice(index, index + size);

            if (slice.length === size) {
                candidates.add(slice.join(' '));
            }
        }
    }

    return [...candidates];
}

function normalizedTextIncludesAlias(text, alias) {
    const normalizedText = ` ${normalizeParticipantAlias(text)} `;
    const normalizedAlias = normalizeParticipantAlias(alias);

    return Boolean(
        normalizedAlias &&
        normalizedText.includes(` ${normalizedAlias} `),
    );
}

function directParticipantMentionScore(text, participant) {
    const source = String(text ?? '');
    const ids = new Set([
        Number(participant?.userId),
        Number(participant?.externalUserId),
        ...(Array.isArray(participant?.userIds) ? participant.userIds.map(Number) : []),
    ].filter((value) => Number.isSafeInteger(value) && value > 0));

    for (const id of ids) {
        if (new RegExp(`\\[id${id}\\|`, 'iu').test(source)) {
            return {
                score: 1,
                matchedText: `[id${id}|…]`,
                matchedAlias: String(id),
                method: 'direct-vk-id',
            };
        }
    }

    const aliases = buildParticipantMentionAliases(participant);

    for (const alias of aliases) {
        const clean = compact(alias).replace(/^@/u, '');

        if (
            clean &&
            new RegExp(`(^|[^\\p{L}\\p{N}_])@${escapeRegExpLocal(clean)}(?=$|[^\\p{L}\\p{N}_])`, 'iu').test(source)
        ) {
            return {
                score: 1,
                matchedText: `@${clean}`,
                matchedAlias: alias,
                method: 'direct-username',
            };
        }
    }

    return null;
}

function escapeRegExpLocal(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function findParticipantMentionMatches(
    messages,
    participant,
    matchedPhrase = '',
    {
        minimumScore = PARTICIPANT_NAME_PART_MIN_SCORE,
        excludeTargetAuthor = true,
    } = {},
) {
    const aliases = buildParticipantMentionAliases(
        participant,
        matchedPhrase,
    );
    const targetUserIds = new Set([
        Number(participant?.userId),
        ...(Array.isArray(participant?.userIds) ? participant.userIds.map(Number) : []),
    ].filter((value) => Number.isSafeInteger(value) && value > 0));
    const result = [];

    for (const message of Array.isArray(messages) ? messages : []) {
        const senderId = Number(message?.senderId);
        const text = compact(message?.text);

        if (
            !text ||
            (
                excludeTargetAuthor &&
                targetUserIds.has(senderId)
            )
        ) {
            continue;
        }

        const direct = directParticipantMentionScore(text, participant);

        if (direct) {
            result.push({
                message,
                ...direct,
            });
            continue;
        }

        let best = null;

        for (const alias of aliases) {
            if (normalizedTextIncludesAlias(text, alias)) {
                best = {
                    score: 0.99,
                    matchedText: alias,
                    matchedAlias: alias,
                    method: 'exact-alias',
                };
                break;
            }
        }

        if (!best) {
            const candidates = extractMentionCandidates(text);

            for (const candidate of candidates) {
                for (const alias of aliases) {
                    const fuzzyScore = scorePhraseAgainstAlias(candidate, alias);
                    const partScore = participantNamePartSimilarity(candidate, participant);
                    if (partScore <= minimumScore) continue;
                    const score = Math.max(partScore, Math.min(fuzzyScore, 0.999));

                    const candidateTokens = normalizeParticipantAlias(candidate).split(' ').filter(Boolean).length;
                    const bestTokens = best
                        ? normalizeParticipantAlias(best.matchedText).split(' ').filter(Boolean).length
                        : Number.POSITIVE_INFINITY;
                    const candidateLength = normalizeParticipantAlias(candidate).length;
                    const bestLength = best ? normalizeParticipantAlias(best.matchedText).length : Number.POSITIVE_INFINITY;

                    if (
                        !best ||
                        score > best.score ||
                        (
                            score === best.score &&
                            (
                                candidateTokens < bestTokens ||
                                (candidateTokens === bestTokens && candidateLength < bestLength)
                            )
                        )
                    ) {
                        best = {
                            score,
                            matchedText: candidate,
                            matchedAlias: alias,
                            method: 'fuzzy-alias',
                        };
                    }
                }
            }
        }

        if (best && best.score > minimumScore) {
            result.push({
                message,
                ...best,
                score: Number(best.score.toFixed(6)),
            });
        }
    }

    return result;
}

export function buildParticipantMentionContextWindows(
    messages,
    matches,
    { radius = 10 } = {},
) {
    const source = Array.isArray(messages) ? messages : [];
    const safeRadius = Math.max(0, Math.trunc(Number(radius) || 0));
    if (!source.length || !Array.isArray(matches) || !matches.length) return [];

    const matchByMessage = new Map();
    for (const match of matches) {
        const message = match?.message;
        if (!message) continue;
        const bucket = matchByMessage.get(message) || [];
        bucket.push(match);
        matchByMessage.set(message, bucket);
    }

    const intervals = [];
    for (let index = 0; index < source.length; index += 1) {
        if (!matchByMessage.has(source[index])) continue;
        intervals.push({
            start: Math.max(0, index - safeRadius),
            end: Math.min(source.length - 1, index + safeRadius),
        });
    }
    if (!intervals.length) return [];

    intervals.sort((left, right) => left.start - right.start || left.end - right.end);
    const merged = [];
    for (const interval of intervals) {
        const previous = merged.at(-1);
        if (previous && interval.start <= previous.end + 1) {
            previous.end = Math.max(previous.end, interval.end);
        } else {
            merged.push({ ...interval });
        }
    }

    return merged.map((interval, windowIndex) => ({
        windowIndex,
        startIndex: interval.start,
        endIndex: interval.end,
        messages: source.slice(interval.start, interval.end + 1),
        matches: source.slice(interval.start, interval.end + 1)
            .flatMap((message) => matchByMessage.get(message) || []),
    }));
}
