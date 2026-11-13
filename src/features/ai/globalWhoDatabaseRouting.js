const BOT_PREFIX = /^(?:а\s+)?(?:ну\s+)?(?:гигорейв[,:]?\s+)?(?:скажи\s+)?/iu;
const WHO_EXPLICIT = /^кто\s+(?:так(?:ой|ая|ое|ие)|это|за)\s+(.+?)\s*[?!.]*$/iu;
const WHO_SIMPLE = /^кто\s+(.+?)\s*[?!.]*$/iu;
// История сообщений включается только явными формулировками про то, что
// писали/говорили/обсуждали, либо прямой просьбой найти сообщения.
// Обычные knowledge-запросы вроде «расскажи про riddim» и
// «что известно про riddim» обязаны оставаться в обычном AI/web route.
const GLOBAL_TOPIC = /^(?:что\s+(?:говорили|писали|обсуждали)\s+(?:про|о|об)|найди\s+(?:всё\s+)?(?:сообщения|переписку|упоминания)\s*(?:про|о|об)?)\s+(.+?)\s*[?!.]*$/iu;
const CONVERSATION_ANALYSIS = /(?:проанализ(?:ируй|ировать)|разбери|изучи|посмотри|исследуй|что\s+обсуждал[иа]?|что\s+писал[иа]?|что\s+говорил[иа]?|найди).*(?:переписк|чат|конф|бесед|сообщени)/iu;
const CONVERSATION_REFERENCE = /(?:переписк|чат|конф|бесед|сообщени)/iu;
const GLOBAL_SCOPE_MARKER = /(?:по\s+всей\s+базе|во\s+всех\s+(?:чатах|беседах|конфах)|по\s+всем\s+(?:чатам|беседам|конфам)|вс(?:я|ю)\s+баз(?:а|у)\s+сообщений)/iu;
// Capture explicitly listed alternatives even if the user says "incidents
// involving X or Y" instead of "about X or Y".
const EXPLICIT_ALTERNATIVES = /(?:^|[\s,;])([\p{L}\p{N}_-]+(?:\s+(?:\u0438\u043b\u0438|\u043b\u0438\u0431\u043e|\u0438)\s+[\p{L}\p{N}_-]+)+)(?=\s*(?:[?!.]|$|\s+(?:\u0432|\u0437\u0430)\s+\d{4}))/iu;
const TRAILING_PERSON_TARGET = /(?:^|[\s,;])(?:\u0441|\u0441\u043e|\u0443|\u043e|\u043e\u0431)\s+([\p{L}\p{N}_-]{4,})(?=\s*[?!.]*$)/iu;
const FOCUS_MARKER = /(?:^|\s)(?:про|о|об|насч[её]т|по\s+теме)\s+(.+?)\s*[?!.]*$/iu;

const QUERY_STOP_WORDS = new Set([
    'кто', 'что', 'такой', 'такая', 'такое', 'такие', 'это', 'за',
    'про', 'об', 'обо', 'в', 'во', 'на', 'по', 'из', 'для', 'и', 'или',
    'переписка', 'переписку', 'переписке', 'чат', 'чате', 'беседа', 'беседу',
    'конфа', 'конфу', 'сообщение', 'сообщения', 'сообщений',
    'проанализируй', 'проанализировать', 'разбери', 'изучи', 'найди',
    'скажи', 'расскажи', 'всё', 'все', 'всей', 'тут', 'здесь', 'вообще',
]);

const CLAUSE_MARKERS = /(?:^|[^\p{L}\p{N}_])(?:сегодня|завтра|вчера|сейчас|потом|когда|куда|где|зачем|почему|ид[её]т|пойд[её]т|будет|был[аи]?|хочет|может|любит|знает|видел[аи]?|писал[аи]?|говорил[аи]?|сделал[аи]?|прид[её]т|поедет|едет|гуляет|гулять|идти)(?=$|[^\p{L}\p{N}_])/iu;

function cleanTerm(value) {
    return String(value ?? '')
        .replace(/[«»"'`]+/gu, '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function stripBotPrefix(value) {
    return String(value ?? '').replace(BOT_PREFIX, '').trim();
}

function uniqueTerms(values) {
    const result = [];
    const seen = new Set();
    for (const value of values) {
        const clean = cleanTerm(value);
        if (!clean) continue;
        const key = clean.toLocaleLowerCase('ru-RU');
        if (seen.has(key)) continue;
        seen.add(key);
        result.push(clean);
    }
    return result;
}


function expandSearchToken(value) {
    const token = cleanTerm(value);
    if (!token) return [];
    const variants = [token];
    if (/^[\p{L}\p{N}_]{5,}$/u.test(token)) {
        const stem = token.replace(/(?:ться|тись|ть|ти)$/iu, '');
        if (stem.length >= 4 && stem !== token) variants.push(stem);
    }
    // Inflected personal names such as Vladislavom -> Vladislav must match the
    // same archived messages as the nominative spelling.
    if (/^[\p{L}\p{N}_]{7,}$/u.test(token)) {
        const nameStem = token.replace(/(?:\u0430\u043c\u0438|\u044f\u043c\u0438|\u043e\u043c|\u0435\u043c|\u0430|\u044f|\u0443|\u044e|\u0435|\u0438|\u044b)$/iu, '');
        if (nameStem.length >= 6 && nameStem !== token) variants.push(nameStem);
    }
    // Both variants of the chat nickname are common: Владислейв / Владислэйв.
    for (const item of [...variants]) {
        if (/\u0432\u043b\u0430\u0434\u0438\u0441\u043b[\u0435\u044d]\u0439\u0432/iu.test(item)) {
            variants.push(item.replace(/\u0435(?=\u0439\u0432)/iu, '\u044d'));
            variants.push(item.replace(/\u044d(?=\u0439\u0432)/iu, '\u0435'));
        }
    }
    return uniqueTerms(variants);
}

function buildFocusedSearchTerms(value) {
    const full = cleanTerm(value);
    if (!full) return [];
    const tokens = full.split(/\s+/u)
        .map((token) => token.replace(/[^\p{L}\p{N}_]+/gu, ''))
        .filter((token) => token.length >= 3)
        .filter((token) => !QUERY_STOP_WORDS.has(token.toLocaleLowerCase('ru-RU')));
    return uniqueTerms([full, ...tokens.flatMap(expandSearchToken)]).slice(0, 10);
}

// A disjunction is a set of separate search queries (OR), never a request to
// load all archived messages or to search for the words "or"/"или".
function buildAlternativeSearchTerms(value) {
    const candidates = cleanTerm(value)
        .split(/\s+(?:\u0438\u043b\u0438|\u043b\u0438\u0431\u043e|\u0438)\s+/iu)
        .map((part) => part.replace(/[^\p{L}\p{N}_-]+/gu, '').trim())
        .filter((part) => part.length >= 4)
        .filter((part) => !QUERY_STOP_WORDS.has(part.toLocaleLowerCase('ru-RU')));
    return uniqueTerms(candidates.flatMap(expandSearchToken)).slice(0, 24);
}

function buildClauseSearchTerms(value) {
    const text = cleanTerm(value)
        .replace(/[,:;!?()[\]{}]+/gu, ' ')
        .replace(/[—–-]+/gu, ' ');
    const tokens = text.split(/\s+/u)
        .map((token) => token.replace(/[^\p{L}\p{N}_]+/gu, ''))
        .filter((token) => token.length >= 3)
        .filter((token) => !QUERY_STOP_WORDS.has(token.toLocaleLowerCase('ru-RU')));

    // Prefer content-bearing words. A short conversational question such as
    // "кто сегодня идет гулять" must search the message DB instead of being
    // misread as the literal entity name "сегодня идет гулять".
    const meaningful = tokens.filter((token) => !/^(?:сегодня|завтра|вчера|сейчас|идет|идёт|пойдет|пойдёт|будет)$/iu.test(token));
    return uniqueTerms((meaningful.length ? meaningful : tokens).flatMap(expandSearchToken)).slice(0, 8);
}


function escapeRegex(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

export function messageTextMatchesRetrievalTerm(text, term, { allowPrefix = false } = {}) {
    const source = String(text ?? '');
    const clean = cleanTerm(term);
    if (!source || !clean) return false;
    const escaped = escapeRegex(clean);
    const leftBoundary = '(?:^|[^\\p{L}\\p{N}_])';
    if (allowPrefix && !/\s/u.test(clean)) {
        return new RegExp(`${leftBoundary}${escaped}`, 'iu').test(source);
    }
    const suffix = /\s/u.test(clean)
        ? ''
        : '(?:а|я|у|ю|е|и|ы|ой|ом|ем|ов|ев|ам|ям|ами|ями|ах|ях)?';
    const rightBoundary = '(?=$|[^\\p{L}\\p{N}_])';
    return new RegExp(`${leftBoundary}${escaped}${suffix}${rightBoundary}`, 'iu').test(source);
}

export function parseDatabaseMessageRetrievalQuery(value) {
    const original = String(value ?? '').replace(/\s+/gu, ' ').trim();
    if (!original) return { matched: false, kind: '', scope: '', term: '', searchTerms: [] };
    const text = stripBotPrefix(original);

    const explicitWho = text.match(WHO_EXPLICIT);
    if (explicitWho) {
        const term = cleanTerm(explicitWho[1])
            .replace(/^(?:это|же|вообще)\s+/iu, '')
            .replace(/\s+(?:вообще|здесь|тут)$/iu, '')
            .trim();
        if (term.length >= 2 && term.length <= 120) {
            return {
                matched: true,
                kind: 'identity',
                scope: 'global',
                term,
                searchTerms: buildFocusedSearchTerms(term),
            };
        }
    }

    const simpleWho = text.match(WHO_SIMPLE);
    if (simpleWho) {
        const tail = cleanTerm(simpleWho[1]);
        if (tail.length >= 2 && tail.length <= 180) {
            if (!CLAUSE_MARKERS.test(tail) && tail.split(/\s+/u).length <= 5) {
                return {
                    matched: true,
                    kind: 'identity',
                    scope: 'global',
                    term: tail,
                    searchTerms: buildFocusedSearchTerms(tail),
                };
            }
            const searchTerms = buildClauseSearchTerms(tail);
            if (searchTerms.length) {
                return {
                    matched: true,
                    kind: 'question',
                    scope: 'current-peer',
                    term: tail,
                    searchTerms,
                };
            }
        }
    }

    const topic = text.match(GLOBAL_TOPIC);
    if (topic) {
        const term = cleanTerm(topic[1]);
        if (term.length >= 2 && term.length <= 180) {
            return {
                matched: true,
                kind: 'topic',
                scope: 'global',
                term,
                searchTerms: buildFocusedSearchTerms(term),
            };
        }
    }

    if (CONVERSATION_REFERENCE.test(text) && CONVERSATION_ANALYSIS.test(text)) {
        const alternatives = cleanTerm(text.match(EXPLICIT_ALTERNATIVES)?.[1] || '');
        const focus = cleanTerm(alternatives ||
            text.match(FOCUS_MARKER)?.[1] ||
            text.match(TRAILING_PERSON_TARGET)?.[1] || '');
        const scope = GLOBAL_SCOPE_MARKER.test(text) ? 'global' : 'current-peer';
        return {
            matched: true,
            kind: 'conversation-analysis',
            scope,
            term: focus,
            searchTerms: alternatives ? buildAlternativeSearchTerms(alternatives)
                : (focus ? buildFocusedSearchTerms(focus) : []),
        };
    }

    return { matched: false, kind: '', scope: '', term: '', searchTerms: [] };
}

export function parseGlobalWhoDatabaseQuery(value) {
    const parsed = parseDatabaseMessageRetrievalQuery(value);
    if (!parsed.matched || parsed.kind !== 'identity') {
        return { matched: false, term: '' };
    }
    return { matched: true, term: parsed.term };
}

export function buildGlobalWhoMessageKey(message) {
    return [
        Number(message?.peerId ?? 0),
        Number(message?.conversationMessageId ?? 0),
        Number(message?.senderId ?? 0),
        String(message?.text ?? '').trim(),
    ].join('\u0000');
}
