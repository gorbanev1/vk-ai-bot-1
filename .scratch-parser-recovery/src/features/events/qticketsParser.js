/**
 * Детеминированный парсер HTML афиши QTickets.
 *
 * Модуль намеренно не знает ни о Playwright, ни о SQLite. Благодаря этому
 * селекторы и нормализацию можно проверять на сохранённых HTML-снимках, а
 * браузерный оркестратор остаётся отдельным слоем.
 */

export const QTICKETS_CITY_URL = 'https://voronezh.qtickets.events/';
export const QTICKETS_SOURCE_TYPE = 'qtickets';
export const QTICKETS_SOURCE_NAME = 'QTickets — Воронеж';
export const QTICKETS_TIME_ZONE = 'Europe/Moscow';

const RUSSIAN_MONTHS = new Map([
    ['января', 1], ['январь', 1], ['январе', 1],
    ['февраля', 2], ['февраль', 2], ['феврале', 2],
    ['марта', 3], ['март', 3], ['марте', 3],
    ['апреля', 4], ['апрель', 4], ['апреле', 4],
    ['мая', 5], ['май', 5], ['мае', 5],
    ['июня', 6], ['июнь', 6], ['июне', 6],
    ['июля', 7], ['июль', 7], ['июле', 7],
    ['августа', 8], ['август', 8], ['августе', 8],
    ['сентября', 9], ['сентябрь', 9], ['сентябре', 9],
    ['октября', 10], ['октябрь', 10], ['октябре', 10],
    ['ноября', 11], ['ноябрь', 11], ['ноябре', 11],
    ['декабря', 12], ['декабрь', 12], ['декабре', 12],
]);

const MONTH_WORDS = [...RUSSIAN_MONTHS.keys()]
    .sort((left, right) => right.length - left.length)
    .join('|');

function escapeRegExp(value) {
    return String(value ?? '').replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
}

function normalizeWhitespace(value) {
    return String(value ?? '')
        .replace(/\u00a0/gu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

export function decodeHtmlEntities(value) {
    return String(value ?? '')
        .replace(/&#(\d+);/gu, (_, code) => {
            const number = Number(code);
            return Number.isFinite(number) ? String.fromCodePoint(number) : _;
        })
        .replace(/&#x([\da-f]+);/giu, (_, code) => {
            const number = Number.parseInt(code, 16);
            return Number.isFinite(number) ? String.fromCodePoint(number) : _;
        })
        .replace(/&(nbsp|amp|lt|gt|quot|apos);/giu, (_, name) => ({
            nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'",
        }[String(name).toLowerCase()] || _));
}

export function stripHtml(value) {
    return normalizeWhitespace(
        decodeHtmlEntities(String(value ?? '')
            .replace(/<!--[\s\S]*?-->/gu, ' ')
            .replace(/<br\s*\/?>/giu, '\n')
            .replace(/<[^>]+>/gu, ' ')),
    );
}

function readAttribute(openTag, attribute) {
    const pattern = new RegExp(
        `\\b${escapeRegExp(attribute)}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s>]+))`,
        'iu',
    );
    const match = String(openTag ?? '').match(pattern);
    return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim();
}

function hasClass(openTag, className) {
    const classes = readAttribute(openTag, 'class');
    return new RegExp(`(?:^|\\s)${escapeRegExp(className)}(?:\\s|$)`, 'iu').test(classes);
}

function extractTagBlocks(html, tagName) {
    const pattern = new RegExp(
        `<${escapeRegExp(tagName)}\\b[^>]*>[\\s\\S]*?<\\/${escapeRegExp(tagName)}>`,
        'giu',
    );
    return [...String(html ?? '').matchAll(pattern)].map((match) => match[0]);
}

function extractBlocksWithClass(html, tagName, className) {
    const source = String(html ?? '');
    const pattern = new RegExp(
        `<${escapeRegExp(tagName)}\\b[^>]*\\bclass\\s*=\\s*(?:"[^"]*\\b${escapeRegExp(className)}\\b[^"]*"|'[^']*\\b${escapeRegExp(className)}\\b[^']*')`,
        'giu',
    );
    const blocks = [];
    for (const match of source.matchAll(pattern)) {
        const openTag = match[0];
        const close = `</${tagName}>`;
        const closeIndex = source.toLowerCase().indexOf(close.toLowerCase(), Number(match.index) + openTag.length);
        blocks.push(closeIndex >= 0
            ? source.slice(Number(match.index), closeIndex + close.length)
            : openTag);
    }
    return blocks;
}

function extractFirstText(html, tagName, className = '') {
    const blocks = className
        ? extractBlocksWithClass(html, tagName, className)
        : extractTagBlocks(html, tagName);
    return stripHtml(blocks[0] || '');
}

function extractOpenTags(html, tagName) {
    const pattern = new RegExp(`<${escapeRegExp(tagName)}\\b[^>]*>`, 'giu');
    return [...String(html ?? '').matchAll(pattern)].map((match) => match[0]);
}

function unique(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean))];
}

function resolveHttpUrl(value, baseUrl = QTICKETS_CITY_URL) {
    const source = decodeHtmlEntities(String(value ?? '').trim());
    if (!source) return '';
    try {
        const url = new URL(source, baseUrl);
        if (!/^https?:$/iu.test(url.protocol)) return '';
        return url.toString();
    } catch {
        return '';
    }
}

export function isQticketsUrl(value) {
    try {
        const url = new URL(String(value ?? '').trim());
        const host = url.hostname.toLowerCase().replace(/^www\./u, '');
        return host === 'qtickets.events' || host.endsWith('.qtickets.events');
    } catch {
        return false;
    }
}

export function normalizeQticketsDetailUrl(value, baseUrl = QTICKETS_CITY_URL) {
    const resolved = resolveHttpUrl(value, baseUrl);
    if (!resolved || !isQticketsUrl(resolved)) return '';
    const url = new URL(resolved);
    url.hash = '';
    url.search = '';
    return url.toString().replace(/\/+$/u, '') || `${url.origin}/`;
}

function extractBackgroundImageUrls(html, baseUrl) {
    const urls = [];
    const pattern = /background-image\s*:\s*url\(\s*["']?([^"')\s]+)["']?\s*\)/giu;
    for (const match of String(html ?? '').matchAll(pattern)) {
        const url = resolveHttpUrl(match[1], baseUrl);
        if (url) urls.push(url);
    }
    return urls;
}

function extractImageUrls(html, baseUrl) {
    const urls = [];
    for (const tag of extractOpenTags(html, 'img')) {
        for (const attribute of ['src', 'data-src', 'data-original', 'data-lazy-src']) {
            const url = resolveHttpUrl(readAttribute(tag, attribute), baseUrl);
            if (url) urls.push(url);
        }
        const srcset = readAttribute(tag, 'srcset');
        if (srcset) {
            const last = srcset.split(',').map((item) => item.trim().split(/\s+/u)[0]).filter(Boolean).at(-1);
            const url = resolveHttpUrl(last, baseUrl);
            if (url) urls.push(url);
        }
    }
    return unique([...urls, ...extractBackgroundImageUrls(html, baseUrl)]).slice(0, 12);
}

function extractJsonLdObjects(html) {
    const objects = [];
    const scripts = new RegExp(
        `<script\\b[^>]*type\\s*=\\s*["']application/ld\\+json["'][^>]*>([\\s\\S]*?)<\\/script>`,
        'giu',
    );
    for (const match of String(html ?? '').matchAll(scripts)) {
        const text = decodeHtmlEntities(match[1]).trim();
        if (!text) continue;
        try {
            const parsed = JSON.parse(text);
            const values = Array.isArray(parsed) ? parsed : [parsed];
            for (const value of values) {
                if (value && typeof value === 'object' && Array.isArray(value['@graph'])) {
                    objects.push(...value['@graph'].filter(Boolean));
                } else if (value && typeof value === 'object') {
                    objects.push(value);
                }
            }
        } catch {
            // На странице могут быть служебные/обрезанные JSON-LD блоки.
        }
    }
    return objects;
}

function findJsonLdEvent(objects) {
    return (Array.isArray(objects) ? objects : []).find((item) => {
        const type = Array.isArray(item?.['@type']) ? item['@type'].join(' ') : item?.['@type'];
        return /event/iu.test(String(type ?? ''));
    }) || null;
}

function currentReferenceDate(value) {
    const source = value instanceof Date ? value : new Date(value || Date.now());
    if (Number.isNaN(source.getTime())) return new Date();
    return source;
}

function datePartsInTimeZone(date, timeZone = QTICKETS_TIME_ZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        hourCycle: 'h23',
    }).formatToParts(date);
    return Object.fromEntries(parts
        .filter((part) => part.type !== 'literal')
        .map((part) => [part.type, part.value]));
}

function makeIsoDate(year, month, day) {
    const candidate = `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    const date = new Date(`${candidate}T00:00:00Z`);
    return date.getUTCFullYear() === Number(year) &&
        date.getUTCMonth() + 1 === Number(month) &&
        date.getUTCDate() === Number(day)
        ? candidate
        : '';
}

function parseIsoDateTime(value, { timeZone = QTICKETS_TIME_ZONE } = {}) {
    const source = String(value ?? '').trim();
    if (!source) return null;
    if (/^\d{4}-\d{2}-\d{2}$/u.test(source)) return { date: source, time: '' };
    const parsed = new Date(source);
    if (Number.isNaN(parsed.getTime())) return null;
    const parts = datePartsInTimeZone(parsed, timeZone);
    const date = makeIsoDate(Number(parts.year), Number(parts.month), Number(parts.day));
    return date
        ? { date, time: `${parts.hour}:${parts.minute}` }
        : null;
}

function parseRussianDateTokens(value, { referenceDate = new Date() } = {}) {
    const text = normalizeWhitespace(value).toLowerCase().replace(/ё/gu, 'е');
    const result = [];
    const pattern = new RegExp(
        `(\\d{1,2})\\s+(${MONTH_WORDS})(?:\\s+(\\d{4}))?`,
        'giu',
    );
    const reference = currentReferenceDate(referenceDate);
    const referenceParts = datePartsInTimeZone(reference);
    const currentYear = Number(referenceParts.year);
    for (const match of text.matchAll(pattern)) {
        const day = Number(match[1]);
        const month = RUSSIAN_MONTHS.get(String(match[2]).toLowerCase());
        let year = match[3] ? Number(match[3]) : currentYear;
        let date = makeIsoDate(year, month, day);
        if (!match[3] && date && date < `${currentYear}-${String(referenceParts.month).padStart(2, '0')}-${String(referenceParts.day).padStart(2, '0')}`) {
            year += 1;
            date = makeIsoDate(year, month, day);
        }
        if (date) result.push({ date, token: match[0] });
    }
    return result;
}

function extractTime(value) {
    const match = normalizeWhitespace(value).match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/u);
    return match ? `${String(match[1]).padStart(2, '0')}:${match[2]}` : '';
}

function parseDateInfo(values, { referenceDate = new Date(), timeZone = QTICKETS_TIME_ZONE } = {}) {
    const candidates = (Array.isArray(values) ? values : [])
        .map((value) => String(value ?? '').trim())
        .filter(Boolean);
    for (const value of candidates) {
        const iso = parseIsoDateTime(value, { timeZone });
        if (iso) return { ...iso, endDate: iso.date, label: value };
    }
    for (const value of candidates) {
        const tokens = parseRussianDateTokens(value, { referenceDate });
        if (!tokens.length) continue;
        return {
            date: tokens[0].date,
            endDate: tokens.at(-1).date,
            time: extractTime(value),
            label: value,
        };
    }
    return { date: '', endDate: '', time: '', label: '' };
}

function jsonLdLocation(event) {
    const location = Array.isArray(event?.location) ? event.location[0] : event?.location;
    if (!location) return { name: '', address: '' };
    if (typeof location === 'string') return { name: location, address: '' };
    const address = typeof location.address === 'string'
        ? location.address
        : [location.address?.addressLocality, location.address?.streetAddress, location.address?.postalCode]
            .filter(Boolean)
            .join(', ');
    return {
        name: normalizeWhitespace(location.name || ''),
        address: normalizeWhitespace(address),
    };
}

function jsonLdOffers(event) {
    const offers = Array.isArray(event?.offers) ? event.offers[0] : event?.offers;
    if (!offers || typeof offers !== 'object') return { price: '', url: '' };
    const rawPrice = String(offers.price ?? offers.lowPrice ?? '').trim();
    const currency = String(offers.priceCurrency ?? '').toUpperCase();
    const price = rawPrice
        ? `от ${rawPrice.replace(/\.0+$/u, '')} ${currency === 'RUB' || !currency ? 'руб.' : currency}`
        : '';
    return { price, url: resolveHttpUrl(offers.url) };
}

function findTicketUrl(html, sourceUrl, jsonLdUrl = '') {
    const candidate = resolveHttpUrl(jsonLdUrl);
    if (candidate && candidate !== sourceUrl) return candidate;
    for (const block of extractTagBlocks(html, 'a')) {
        const openTag = block.match(/^<a\b[^>]*>/iu)?.[0] || '';
        const href = resolveHttpUrl(readAttribute(openTag, 'href'));
        const text = stripHtml(block).toLowerCase();
        if (href && /(?:купить|билет|ticket|qtickets\.ru)/iu.test(`${text} ${href}`) && href !== sourceUrl) {
            return href;
        }
    }
    return '';
}

function findMetaContent(html, property) {
    for (const tag of extractOpenTags(html, 'meta')) {
        const name = readAttribute(tag, 'property') || readAttribute(tag, 'name');
        if (name.toLowerCase() !== property.toLowerCase()) continue;
        return readAttribute(tag, 'content');
    }
    return '';
}

function findDetailVenue(html, bodyText, title) {
    const structuredBlocks = [
        ...extractBlocksWithClass(html, 'div', 'place-name'),
        ...extractBlocksWithClass(html, 'span', 'place-name'),
        ...extractBlocksWithClass(html, 'div', 'venue'),
        ...extractBlocksWithClass(html, 'div', 'address'),
    ].map(stripHtml).filter(Boolean);
    if (structuredBlocks.length) return unique(structuredBlocks).slice(0, 2).join(', ');

    const headings = extractTagBlocks(html, 'h2')
        .concat(extractTagBlocks(html, 'h3'))
        .map(stripHtml)
        .filter((value) => value && value !== title && !/организатор|купить|билет/iu.test(value));
    const addressMatch = String(bodyText ?? '').match(/(?:^|\n)((?:Воронеж,?\s+)?(?:ул\.?|улица|проспект|пр-т|пл\.?|набережная|Московский\s+проспект)[^\n]{2,160})/iu);
    const address = normalizeWhitespace(addressMatch?.[1] || '');
    return unique([headings[0] || '', address]).slice(0, 2).join(', ');
}

function findDescription(html, bodyText, jsonLdDescription, metaDescription) {
    const preferred = normalizeWhitespace(jsonLdDescription || metaDescription);
    if (preferred) return preferred.slice(0, 6000);
    const paragraphs = extractTagBlocks(html, 'p')
        .map(stripHtml)
        .filter((value) => value.length >= 35)
        .filter((value) => !/^(?:купить|организатор|вконтакте|поделиться)/iu.test(value));
    return normalizeWhitespace(paragraphs.join('\n\n') || bodyText).slice(0, 6000);
}

export function parseQticketsListingHtml(html, {
    baseUrl = QTICKETS_CITY_URL,
    referenceDate = new Date(),
    timeZone = QTICKETS_TIME_ZONE,
} = {}) {
    const cards = [];
    const items = extractBlocksWithClass(html, 'li', 'item');
    for (const item of items) {
        const anchorBlock = extractTagBlocks(item, 'a').find((block) => {
            const openTag = block.match(/^<a\b[^>]*>/iu)?.[0] || '';
            return Boolean(normalizeQticketsDetailUrl(readAttribute(openTag, 'href'), baseUrl));
        });
        if (!anchorBlock) continue;
        const anchorOpen = anchorBlock.match(/^<a\b[^>]*>/iu)?.[0] || '';
        const detailUrl = normalizeQticketsDetailUrl(readAttribute(anchorOpen, 'href'), baseUrl);
        if (!detailUrl) continue;
        const dateTime = extractTagBlocks(item, 'time')[0] || '';
        const dateOpen = dateTime.match(/^<time\b[^>]*>/iu)?.[0] || '';
        const dateLabel = extractFirstText(item, 'span', 'event-date') || stripHtml(dateTime);
        const dateInfo = parseDateInfo([
            readAttribute(dateOpen, 'datetime'),
            dateLabel,
        ], { referenceDate, timeZone });
        const idMatch = readAttribute(anchorOpen, 'onclick').match(/loadEvent\(\s*["']?(\d+)/iu) ||
            detailUrl.match(/\/(\d+)(?:-|$)/u);
        const title = extractFirstText(item, 'h2') || stripHtml(anchorBlock);
        const imageUrls = extractImageUrls(item, baseUrl);
        cards.push({
            externalId: String(idMatch?.[1] || detailUrl.split('/').at(-1) || '').trim(),
            detailUrl,
            title: title.slice(0, 500),
            eventDate: dateInfo.date,
            eventEndDate: dateInfo.endDate || dateInfo.date,
            eventTime: dateInfo.time || extractTime(dateLabel),
            dateLabel: dateLabel.slice(0, 240),
            venue: extractFirstText(item, 'span', 'place-name') || extractFirstText(item, 'div', 'place-name'),
            price: extractFirstText(item, 'div', 'price') || extractFirstText(item, 'span', 'price'),
            eventType: extractFirstText(item, 'div', 'type') || extractFirstText(item, 'span', 'type'),
            imageUrls,
            listingUrl: resolveHttpUrl(baseUrl, baseUrl),
            sourceText: stripHtml(item).slice(0, 4000),
            parseMethod: 'qtickets-listing-card-v1',
        });
    }
    // V188.85: recover canonical numeric detail links even when QTickets
    // moved them outside the historical `<li class="item">` wrapper.
    for (const anchorBlock of extractTagBlocks(html, 'a')) {
        const anchorOpen = anchorBlock.match(/^<a\b[^>]*>/iu)?.[0] || '';
        const detailUrl = normalizeQticketsDetailUrl(readAttribute(anchorOpen, 'href'), baseUrl);
        if (!detailUrl || cards.some((card) => card.detailUrl === detailUrl)) continue;
        const idMatch = readAttribute(anchorOpen, 'onclick').match(/loadEvent\(\s*["']?(\d+)/iu) || detailUrl.match(/\/(\d+)(?:-|$)/u);
        if (!idMatch) continue;
        const label = stripHtml(anchorBlock);
        const dateInfo = parseDateInfo([label], { referenceDate, timeZone });
        cards.push({
            externalId: String(idMatch[1] || '').trim(), detailUrl,
            title: label.slice(0, 500) || 'Мероприятие',
            eventDate: dateInfo.date, eventEndDate: dateInfo.endDate || dateInfo.date,
            eventTime: dateInfo.time || extractTime(label), dateLabel: dateInfo.label || '',
            venue: '', price: '', eventType: '',
            imageUrls: extractImageUrls(anchorBlock, baseUrl).slice(0, 1),
            listingUrl: resolveHttpUrl(baseUrl, baseUrl), sourceText: label.slice(0, 4000),
            parseMethod: 'qtickets-listing-link-recovery-v18885',
        });
    }

    const seen = new Set();
    return cards.filter((card) => {
        if (!card.detailUrl || seen.has(card.detailUrl)) return false;
        seen.add(card.detailUrl);
        return true;
    });
}

export function parseQticketsDetailHtml(html, sourceUrl, {
    referenceDate = new Date(),
    timeZone = QTICKETS_TIME_ZONE,
    fallbackCard = null,
} = {}) {
    const detailUrl = normalizeQticketsDetailUrl(sourceUrl, sourceUrl || QTICKETS_CITY_URL) || String(sourceUrl ?? '').trim();
    const objects = extractJsonLdObjects(html);
    const jsonLd = findJsonLdEvent(objects) || {};
    const bodyHtml = extractTagBlocks(html, 'body')[0] || String(html ?? '');
    const bodyText = stripHtml(bodyHtml);
    const title = extractFirstText(html, 'h1') || normalizeWhitespace(jsonLd.name || findMetaContent(html, 'og:title')) || String(fallbackCard?.title || '').trim();
    const timeBlocks = extractTagBlocks(html, 'time');
    const timeCandidates = timeBlocks.flatMap((block) => {
        const open = block.match(/^<time\b[^>]*>/iu)?.[0] || '';
        return [readAttribute(open, 'datetime'), stripHtml(block)];
    });
    const jsonStart = String(jsonLd.startDate || '').trim();
    const jsonEnd = String(jsonLd.endDate || '').trim();
    const dateInfo = parseDateInfo([
        jsonStart,
        ...timeCandidates,
        bodyText,
        fallbackCard?.dateLabel,
        fallbackCard?.eventDate,
    ], { referenceDate, timeZone });
    const endInfo = parseDateInfo([jsonEnd], { referenceDate, timeZone });
    const location = jsonLdLocation(jsonLd);
    const venue = unique([
        location.name,
        location.address,
        findDetailVenue(html, bodyText, title),
        fallbackCard?.venue,
    ]).slice(0, 2).join(', ');
    const offers = jsonLdOffers(jsonLd);
    const bodyPrice = bodyText.match(/(?:купить|билет(?:ы|ов)?)[^\n]{0,80}?от\s*([\d\s]+)\s*(?:руб\.?|₽)/iu);
    const price = offers.price || (bodyPrice ? `от ${normalizeWhitespace(bodyPrice[1])} руб.` : String(fallbackCard?.price || '').trim());
    const ageRestriction = bodyText.match(/(?:^|\s)(?:0|6|12|16|18)\s*\+(?=\s|$)/u)?.[0]?.trim().replace(/\s+/gu, '') || '';
    const jsonImages = Array.isArray(jsonLd.image) ? jsonLd.image : [jsonLd.image];
    // Exactly one authoritative poster per QTickets event. JSON-LD/OG comes
    // before page images, so trailing sponsor/ad banners cannot enter the card.
    const authoritativeImage = unique([
        ...jsonImages.map((value) => resolveHttpUrl(value, detailUrl)),
        resolveHttpUrl(findMetaContent(html, 'og:image'), detailUrl),
        ...extractImageUrls(html, detailUrl),
        ...(Array.isArray(fallbackCard?.imageUrls) ? fallbackCard.imageUrls : []),
    ])[0] || '';
    const imageUrls = authoritativeImage ? [authoritativeImage] : [];
    const ticketUrl = findTicketUrl(html, detailUrl, offers.url);
    const eventType = normalizeWhitespace(jsonLd.genre || extractFirstText(html, 'div', 'type') || fallbackCard?.eventType || '');
    const description = findDescription(html, bodyText, jsonLd.description, findMetaContent(html, 'description'));
    const idMatch = detailUrl.match(/\/(\d+)(?:-|$)/u);
    const externalId = String(fallbackCard?.externalId || idMatch?.[1] || detailUrl.split('/').at(-1) || '').trim();
    return {
        externalId,
        detailUrl,
        title: title.slice(0, 500),
        eventDate: dateInfo.date || String(fallbackCard?.eventDate || '').trim(),
        eventEndDate: endInfo.date || dateInfo.endDate || String(fallbackCard?.eventEndDate || dateInfo.date || '').trim(),
        eventTime: dateInfo.time || extractTime(bodyText) || String(fallbackCard?.eventTime || '').trim(),
        dateLabel: dateInfo.label || String(fallbackCard?.dateLabel || '').trim(),
        venue: venue.slice(0, 500),
        price: price.slice(0, 240),
        eventType: eventType.slice(0, 160),
        ageRestriction,
        participants: '',
        description,
        evidence: bodyText.slice(0, 4000),
        sourceText: bodyText.slice(0, 12_000),
        imageUrls,
        ticketUrl,
        parseMethod: 'qtickets-detail-page-v1',
    };
}

export function mergeQticketsCardAndDetail(card = {}, detail = {}, {
    listingUrl = QTICKETS_CITY_URL,
} = {}) {
    const detailUrl = normalizeQticketsDetailUrl(detail.detailUrl || card.detailUrl, listingUrl);
    const pick = (...values) => values.map((value) => String(value ?? '').trim()).find(Boolean) || '';
    const eventDate = pick(detail.eventDate, card.eventDate);
    const eventEndDate = pick(detail.eventEndDate, card.eventEndDate, eventDate);
    return {
        ...card,
        ...detail,
        externalId: pick(detail.externalId, card.externalId, detailUrl),
        detailUrl,
        listingUrl,
        title: pick(detail.title, card.title, 'Мероприятие'),
        eventDate,
        eventEndDate,
        eventTime: pick(detail.eventTime, card.eventTime) || null,
        dateLabel: pick(detail.dateLabel, card.dateLabel, eventDate),
        venue: pick(detail.venue, card.venue, 'место не указано'),
        participants: pick(detail.participants, card.participants),
        price: pick(detail.price, card.price),
        description: pick(detail.description, card.description),
        evidence: pick(detail.evidence, card.sourceText, card.evidence),
        sourceText: pick(detail.sourceText, card.sourceText),
        sourceUrl: detailUrl,
        canonicalPostUrl: detailUrl,
        sourceType: QTICKETS_SOURCE_TYPE,
        provenanceSourceType: QTICKETS_SOURCE_TYPE,
        sourceName: QTICKETS_SOURCE_NAME,
        sourceItemId: pick(detail.externalId, card.externalId, detailUrl),
        sourceOriginalUrl: detailUrl,
        canonicalOrigin: 'qtickets-detail-page',
        venueSource: 'qtickets-detail-page',
        posterMatchStatus: Array.isArray(detail.imagePaths) && detail.imagePaths.length
            ? 'legacy_manual_poster'
            : pick(detail.posterMatchStatus, card.posterMatchStatus),
        posterMatchReason: Array.isArray(detail.imagePaths) && detail.imagePaths.length
            ? 'qtickets-detail-image'
            : pick(detail.posterMatchReason, card.posterMatchReason),
        posterImageIndex: Array.isArray(detail.imagePaths) && detail.imagePaths.length ? 1 : Number(detail.posterImageIndex || card.posterImageIndex || 0),
        imageUrls: unique([
            ...(Array.isArray(detail.imageUrls) ? detail.imageUrls : []),
            ...(Array.isArray(card.imageUrls) ? card.imageUrls : []),
        ]).slice(0, 1),
        ticketUrl: pick(detail.ticketUrl, card.ticketUrl),
        parseMethod: pick(detail.parseMethod, card.parseMethod, 'qtickets-detail-page-v1'),
        status: 'approved',
    };
}
