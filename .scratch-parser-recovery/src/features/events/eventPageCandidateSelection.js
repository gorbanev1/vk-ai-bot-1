const EVENT_PATTERN = /(?:концерт|вечерин|тус(?:а|овк)|гиг|фест|фестиваль|выступ|шоу|дидже|\bdj\b|live|двери|начало|старт|билет|вход|лайн-?ап|участник|маркет|квиз|лекци|спектакл|показ|открыт(?:ый|ого)\s+микрофон|рейв|сейшн)/iu;
const DATE_PATTERN = /(?:\d{1,2}\.\d{1,2}(?:\.\d{4})?|\d{1,2}\s+(?:январ|феврал|март|апрел|ма[йя]|июн|июл|август|сентябр|октябр|ноябр|декабр))/iu;
const TIME_PATTERN = /(?:^|\D)(?:[01]?\d|2[0-3]):\d{2}(?:\D|$)/u;
const STRUCTURED_PATTERN = /^(?:когда|дата|время|где|место|адрес|кто|участники|поч[её]м|цена|стоимость|вход|билеты?)\s*(?::|;|：|[—–-])/imu;
const NON_EVENT_PATTERN = /(?:итоги\s+(?:розыгрыша|конкурса)|результат(?:ы)?\s+(?:розыгрыша|конкурса)|фотоотч[её]т|как\s+это\s+было|распаковочк|новый\s+релиз|слушаем\s+везде|реклама|помогаем\s+с\s+документами|начать\s+чат)/iu;

function clean(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/https?:\/\/\S+/gu, ' ')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function tokens(value) {
    return new Set(clean(value)
        .split(' ')
        .filter((token) => token.length >= 3 && !/^(?:это|для|что|как|или|при|все|всех|тут|там|будет|будут)$/u.test(token))
        .slice(0, 120));
}

export function scoreEventPagePost(post, hint = '') {
    const text = String(post?.text ?? '').trim();
    if (!text) return -100;
    let score = 0;
    if (DATE_PATTERN.test(text)) score += 8;
    if (TIME_PATTERN.test(text)) score += 2;
    if (EVENT_PATTERN.test(text)) score += 7;
    if (STRUCTURED_PATTERN.test(text)) score += 8;
    if (Array.isArray(post?.imageUrls) && post.imageUrls.length) score += 2;
    if (text.length >= 120) score += 1;
    if (text.length >= 500) score += 1;
    if (NON_EVENT_PATTERN.test(text)) score -= 14;

    const hintTokens = tokens(hint);
    if (hintTokens.size) {
        const postTokens = tokens(text);
        let overlap = 0;
        for (const token of hintTokens) if (postTokens.has(token)) overlap += 1;
        const ratio = overlap / Math.max(1, hintTokens.size);
        score += overlap * 4 + Math.round(ratio * 20);
        if (!overlap && hintTokens.size >= 2) score -= 5;
    }
    return score;
}

export function selectEventPagePostCandidates(posts, {
    hint = '',
    maximum = 20,
    minimumScore = 6,
} = {}) {
    const source = Array.isArray(posts) ? posts : [];
    const scored = source.map((post, index) => ({
        ...post,
        _feedIndex: Number.isInteger(post?.index) ? post.index : index,
        _candidateScore: scoreEventPagePost(post, hint),
    }));
    const hintPresent = clean(hint).length >= 3;
    const threshold = hintPresent ? Math.max(3, minimumScore - 2) : minimumScore;
    return scored
        .filter((post) => post._candidateScore >= threshold)
        .sort((left, right) => (
            right._candidateScore - left._candidateScore ||
            left._feedIndex - right._feedIndex
        ))
        .slice(0, Math.max(1, Math.min(20, Number(maximum) || 20)));
}
