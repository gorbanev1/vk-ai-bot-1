function clean(value, maximum = 20000) {
    return String(value ?? '')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+/gu, ' ')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, maximum);
}

function tokens(value) {
    return new Set(clean(value, 20_000)
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[^\p{L}\p{N}]+/gu, ' ')
        .split(/\s+/u)
        .filter((token) => token.length >= 3)
        .slice(0, 180));
}

function tokenSimilarity(left, right) {
    const a = tokens(left);
    const b = tokens(right);
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const token of a) if (b.has(token)) intersection += 1;
    return intersection / Math.max(1, Math.min(a.size, b.size));
}

function eventDateSignals(post) {
    const date = clean(post?.eventDate, 20);
    const match = date.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (!match) return [];
    const [, year, month, day] = match;
    const numericDay = String(Number(day));
    const numericMonth = String(Number(month));
    const monthNames = [
        '', 'январ', 'феврал', 'март', 'апрел', 'ма', 'июн', 'июл', 'август', 'сентябр', 'октябр', 'ноябр', 'декабр',
    ];
    return [
        `${day}.${month}`,
        `${numericDay}.${numericMonth}`,
        `${day}/${month}`,
        `${numericDay}/${numericMonth}`,
        `${day}.${month}.${year}`,
        `${numericDay} ${monthNames[Number(month)] || ''}`.trim(),
    ].filter(Boolean);
}

function extractSeedTitle(post) {
    const explicit = clean(post?.eventTitle || post?.title, 700);
    if (explicit) return explicit;
    const text = clean(post?.text, 5000);
    const labeled = text.match(/(?:^|\n)\s*(?:название|title)\s*[:—–-]\s*([^\n]+)/iu)?.[1];
    if (labeled) return clean(labeled, 700);
    return clean(text.split('\n')[0], 700);
}

function scoreRelatedPost(candidate, { selectedPost, ownerText }) {
    const text = clean(candidate?.text, 20_000);
    if (!text) return -100;
    const method = clean(candidate?.extractionMethod, 200);
    if (/vk-whole-page-fallback/iu.test(method)) return -100;

    const selectedText = clean(selectedPost?.text, 20_000);
    const seedTitle = extractSeedTitle(selectedPost);
    let score = 0;

    if (candidate?.matchesSourceUrl) score += 9;
    if (/vk-structured-event-first-pass/iu.test(method)) score += 7;
    if (/exact-(?:bootstrap|visible)/iu.test(method)) score += 8;

    const titleSimilarity = tokenSimilarity(seedTitle, text);
    const selectedSimilarity = tokenSimilarity(selectedText, text);
    const ownerSimilarity = ownerText ? tokenSimilarity(ownerText, text) : 0;
    score += titleSimilarity * 14;
    score += selectedSimilarity * 10;
    score += ownerSimilarity * 12;

    const normalizedText = text.toLowerCase().replace(/ё/gu, 'е');
    for (const signal of eventDateSignals(selectedPost)) {
        if (normalizedText.includes(signal.toLowerCase().replace(/ё/gu, 'е'))) {
            score += 7;
            break;
        }
    }

    if (/(?:^|\n)\s*(?:где|место|локаци(?:я|и)|площадка)\s*[:—–-]/iu.test(text)) score += 2;
    if (/(?:^|\n)\s*(?:сколько|цена|стоимость|вход|билеты?)\s*[:—–-]/iu.test(text)) score += 2;
    if (/(?:концерт|вечерин|тус|фест|выступ|шоу|мероприяти|doors?|двери)/iu.test(text)) score += 1.5;

    return score;
}

function uniqueTexts(parts) {
    const seen = new Set();
    const result = [];
    for (const value of parts) {
        const text = clean(value, 20_000);
        if (!text) continue;
        const key = text
            .normalize('NFKC')
            .toLowerCase()
            .replace(/ё/gu, 'е')
            .replace(/\s+/gu, ' ')
            .trim();
        if (!key || seen.has(key)) continue;
        seen.add(key);
        result.push(text);
    }
    return result;
}

/**
 * Trusted owner input is not a moderation problem. The job is to harvest as
 * much corroborating event data as possible without mixing unrelated posts.
 * We keep the selected post as the anchor, then add only strongly related
 * loaded posts (same direct wall, structured event metadata, title/date/text
 * overlap). This is deterministic and does not depend on AI availability.
 */
export function buildTrustedOwnerEventEvidence({
    selectedPost = null,
    linkData = null,
    ownerText = '',
    directImageUrls = [],
    maximumRelatedPosts = 4,
} = {}) {
    const anchor = selectedPost && typeof selectedPost === 'object'
        ? selectedPost
        : {
            text: clean(linkData?.text, 20_000),
            imageUrls: Array.isArray(linkData?.imageUrls) ? linkData.imageUrls : [],
            selectionMethod: 'trusted-owner-page-fallback',
        };
    const posts = Array.isArray(linkData?.posts) ? linkData.posts : [];
    const anchorId = clean(anchor?.id, 300);
    const ranked = posts
        .filter((post) => post && typeof post === 'object')
        .filter((post) => clean(post?.id, 300) !== anchorId || clean(post?.text, 20_000) !== clean(anchor?.text, 20_000))
        .map((post) => ({
            post,
            score: scoreRelatedPost(post, { selectedPost: anchor, ownerText: clean(ownerText, 8000) }),
        }))
        .filter((item) => item.score >= 6)
        .sort((left, right) => right.score - left.score || Number(right.post?.publishedAt || 0) - Number(left.post?.publishedAt || 0))
        .slice(0, Math.max(1, Math.min(8, Number(maximumRelatedPosts) || 4)));

    const pageDescription = clean(linkData?.description, 8000);
    const textParts = uniqueTexts([
        anchor?.text,
        ...ranked.map(({ post }) => post?.text),
        pageDescription && tokenSimilarity(pageDescription, anchor?.text || ownerText) >= 0.2
            ? pageDescription
            : '',
    ]);
    const imageUrls = [...new Set([
        ...(Array.isArray(directImageUrls) ? directImageUrls : []),
        ...(Array.isArray(anchor?.imageUrls) ? anchor.imageUrls : []),
        ...ranked.flatMap(({ post }) => Array.isArray(post?.imageUrls) ? post.imageUrls : []),
        ...(Array.isArray(linkData?.imageUrls) ? linkData.imageUrls : []),
        linkData?.imageUrl,
    ].map((value) => clean(value, 4000)).filter((value) => /^https?:\/\//iu.test(value)))].slice(0, 12);

    return {
        ...anchor,
        text: textParts.join('\n\n').slice(0, 45_000),
        imageUrls,
        selectionMethod: [anchor?.selectionMethod, 'trusted-owner-deep-evidence-v18819'].filter(Boolean).join('+'),
        relatedEvidence: ranked.map(({ post, score }) => ({
            id: clean(post?.id, 300),
            score: Number(score.toFixed(3)),
            extractionMethod: clean(post?.extractionMethod, 200),
            textChars: clean(post?.text, 20_000).length,
            imageCount: Array.isArray(post?.imageUrls) ? post.imageUrls.length : 0,
        })),
    };
}
