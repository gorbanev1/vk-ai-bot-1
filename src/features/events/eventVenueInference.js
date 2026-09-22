/**
 * Deterministic venue inference for event announcements.
 *
 * Goals:
 * - recognize a small set of important Voronezh venues in any common spelling/case;
 * - treat explicit venue-type phrases (bar/pub/club/hall/bowling/etc.) as locations;
 * - collect ambiguous prepositional candidates ("в ...", "на ...") for a later AI audit,
 *   without blindly promoting every phrase after a preposition to a venue.
 */

function clean(value, maximum = 1000) {
    return String(value ?? '')
        .normalize('NFKC')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+/gu, ' ')
        .trim()
        .slice(0, maximum);
}

function normalized(value) {
    return clean(value, 20_000)
        .toLowerCase()
        .replace(/ё/gu, 'е');
}

const KNOWN_VENUES = Object.freeze([
    {
        id: 'tupik',
        canonical: 'Тупик',
        patterns: [
            /(?<![\p{L}\p{N}_])тупик(?:е|а|у|ом|и)?(?![\p{L}\p{N}_])/iu,
        ],
    },
    {
        id: 'sto-ruchev',
        canonical: 'Сто Ручьёв',
        patterns: [
            /(?<![\p{L}\p{N}_])(?:сто|100)\s+руч(?:ь?е|ь?ё|е)?в(?:а|е|у|ом|ы)?(?![\p{L}\p{N}_])/iu,
            /(?<![\p{L}\p{N}_])(?:сто|100)\s+ручь[её]в(?![\p{L}\p{N}_])/iu,
            /(?<![\p{L}\p{N}_])ста\s+ручь(?:ях|ев|ям|ями|я)(?![\p{L}\p{N}_])/iu,
        ],
    },
    {
        id: 'vavilone',
        canonical: 'The Last of Vavilone',
        patterns: [
            /\b(?:the\s+)?last\s+of\s+vavilone\b/iu,
            /(?<![\p{L}\p{N}_])(?:зэ\s+)?ласт\s+оф\s+вавилон(?:е|а|у|ом)?(?![\p{L}\p{N}_])/iu,
            /\bvavilone\b/iu,
        ],
    },
    {
        id: 'diesel-hall',
        canonical: 'DIESEL HALL',
        patterns: [
            /(?<![\p{L}\p{N}_])(?:diesel|дизел(?:ь|я|е|ю|ем)?)\s*(?:hall|холл(?:е|а|у|ом)?)(?![\p{L}\p{N}_])/iu,
        ],
    },
    {
        id: 'diesel-bar',
        canonical: 'Rock Bar DIESEL',
        patterns: [
            /(?<![\p{L}\p{N}_])(?:diesel|дизел(?:ь|я|е|ю|ем)?)\s*(?:bar|бар(?:е|а|у|ом)?)(?![\p{L}\p{N}_])/iu,
            /(?<![\p{L}\p{N}_])(?:bar|бар(?:е|а|у|ом)?)\s*(?:diesel|дизел(?:ь|я|е|ю|ем)?)(?![\p{L}\p{N}_])/iu,
        ],
    },
    {
        id: 'overlock',
        canonical: 'Overlock Bar',
        patterns: [
            /\boverlock(?:\s+bar)?\b/iu,
            /(?<![\p{L}\p{N}_])оверлок(?:е|а|у|ом)?(?:\s+бар(?:е|а|у|ом)?)?(?![\p{L}\p{N}_])/iu,
        ],
    },
    {
        id: 'meet-bowling',
        canonical: 'Meet Bowling',
        patterns: [
            /\bmeet\s*bowling\b/iu,
            /(?<![\p{L}\p{N}_])мит\s*боулинг(?:е|а|у|ом)?(?![\p{L}\p{N}_])/iu,
            /(?<![\p{L}\p{N}_])митбоулинг(?:е|а|у|ом)?(?![\p{L}\p{N}_])/iu,
        ],
    },
    {
        id: 'liverpool',
        canonical: 'Liverpool Pub',
        patterns: [
            /(?<![\p{L}\p{N}_])liverpool(?:\s+(?:pub|bar))?(?![\p{L}\p{N}_])/iu,
            /(?<![\p{L}\p{N}_])ливерпул(?:ь|я|е|ю|ем)?(?:\s+(?:паб|бар)(?:е|а|у|ом)?)?(?![\p{L}\p{N}_])/iu,
            /(?<![\p{L}\p{N}_])(?:паб|бар)\s+ливерпул(?:ь|я|е|ю|ем)?(?![\p{L}\p{N}_])/iu,
        ],
    },
    {
        id: 'mama-anarchy',
        canonical: 'Паб Мама Анархия',
        patterns: [
            /(?<![\p{L}\p{N}_])(?:паб\s+)?мам(?:а|ы|е|у|ой|ою)?\s+анархи(?:я|и|ю|ей|е)?(?![\p{L}\p{N}_])/iu,
        ],
    },
    {
        id: 'kotelnaya',
        canonical: 'Котельная',
        patterns: [
            /(?<![\p{L}\p{N}_])котельн(?:ая|ой|ую|ою|ые|ых|ым|ыми)(?![\p{L}\p{N}_])/iu,
        ],
    },
    {
        id: 'bashnya',
        canonical: 'Башня',
        patterns: [
            /(?<![\p{L}\p{N}_])башн(?:я|е|и|ю|ей|ею)(?![\p{L}\p{N}_])/iu,
        ],
    },
]);


/**
 * V188.86: known venue names are metadata, not event identity/title.
 * Remove them before title comparison/render normalization so strings like
 * "STONEHAND (ВОРОНЕЖ) DIESEL HALL" and "STONEHAND" resolve to one title.
 */
export function stripKnownVenueNamesFromEventTitle(value) {
    const original = clean(value, 500);
    if (!original) return '';
    let result = original
        .replace(/\(\s*(?:г\.?\s*)?(?:воронеж|vrn)\s*\)/giu, ' ')
        .replace(/(?:^|[\s,;|—–-])(?:г\.?\s*)?(?:воронеж|vrn)(?=$|[\s,;|—–-])/giu, ' ');

    for (const venue of KNOWN_VENUES) {
        for (const pattern of venue.patterns) {
            const flags = [...new Set(`${pattern.flags}g`.split(''))].join('');
            result = result.replace(new RegExp(pattern.source, flags), ' ');
        }
    }

    return result
        .replace(/\s+(?:в|во|на)\s*$/iu, ' ')
        .replace(/^[\s,;:|—–-]+|[\s,;:|—–-]+$/gu, '')
        .replace(/\s{2,}/gu, ' ')
        .trim();
}

const VENUE_TYPE_PATTERN = /(?<![\p{L}\p{N}_])(?:бар(?:е|а|у|ом)?|паб(?:е|а|у|ом)?|клуб(?:е|а|у|ом)?|холл(?:е|а|у|ом)?|hall|club|pub|bar|bowling|боулинг(?:е|а|у|ом)?|лофт(?:е|а|у|ом)?|ресторан(?:е|а|у|ом)?|кафе|пространств(?:о|е|а)|площадк(?:а|е|и|у|ой)|арт[- ]?пространств(?:о|е|а)|двор(?:е|а|у|ом)?|галере(?:я|е|и|ю)|театр(?:е|а|у|ом)?|стадио?н(?:е|а|у|ом)?|центр(?:е|а|у|ом)?)(?![\p{L}\p{N}_])/iu;
const ADDRESS_PATTERN = /(?<![\p{L}\p{N}_])(?:ул(?:ица|\.)?|просп(?:ект|\.)?|пр[- ]?т|переул(?:ок|\.)?|пер\.|наб(?:ережная|\.)?|пл(?:ощадь|\.)?|шоссе|бульвар|бул\.)\s+[\p{L}0-9 ."«»'’-]{2,80}?\s+\d+[\p{L}]?(?:\s*[/к]\s*\d+)?(?![\p{L}\p{N}_])/iu;
const TEMPORAL_OR_ABSTRACT = /^(?:ноч(?:ь|и|ью)|утр(?:о|а|ом)|вечер(?:е|а|ом)?|день|дн[её]м|полноч(?:ь|и)|сентябр(?:е|я)|октябр(?:е|я)|ноябр(?:е|я)|декабр(?:е|я)|январ(?:е|я)|феврал(?:е|я)|март(?:е|а)|апрел(?:е|я)|ма[ейя]|июн(?:е|я)|июл(?:е|я)|август(?:е|а)|итог(?:е|ах)|комментар(?:иях|ии)|пост(?:е|у)|анонс(?:е|у)|сообщени(?:и|е)|эфир(?:е)|интернет(?:е)|сети|групп(?:е|у)|сообществ(?:е|о)|личк(?:е|у)|директ(?:е)?|telegram|vk)$/iu;
const GENERIC_CITY_ONLY = /^(?:г\.?\s*)?(?:воронеж|москва|санкт[- ]?петербург|спб)$/iu;
const LABELED_VENUE_PATTERN = /^(?:📍\s*)?(?:место|где|локаци(?:я|и)|площадк(?:а|и)|venue)\s*[:—–-]\s*(.+)$/iu;
const LABELED_ADDRESS_PATTERN = /^(?:📍\s*)?(?:адрес)\s*[:—–-]\s*(.+)$/iu;

function extractNearbyAddress(source, index, length) {
    const left = Math.max(0, index - 80);
    const right = Math.min(source.length, index + length + 180);
    const context = source.slice(left, right);
    const parenthesized = context.match(/\(([^()]{3,120})\)/u)?.[1] || '';
    if (parenthesized && (ADDRESS_PATTERN.test(parenthesized) || /\bворонеж\b/iu.test(parenthesized))) {
        return clean(parenthesized, 140);
    }
    const address = context.match(ADDRESS_PATTERN)?.[0] || '';
    return clean(address, 140);
}

function withAddress(canonical, address) {
    if (!address) return canonical;
    if (normalized(canonical).includes(normalized(address))) return canonical;
    return `${canonical}, ${address}`;
}

function findKnownVenue(text) {
    const source = clean(text, 20_000);
    for (const venue of KNOWN_VENUES) {
        for (const pattern of venue.patterns) {
            const match = source.match(pattern);
            if (!match || match.index == null) continue;
            const address = extractNearbyAddress(source, match.index, match[0].length);
            return {
                venue: withAddress(venue.canonical, address),
                canonical: venue.canonical,
                method: `known:${venue.id}`,
                confidence: 1,
                evidence: clean(match[0], 160),
                address,
            };
        }
    }
    return null;
}

function cleanCandidate(value) {
    return clean(value, 180)
        .replace(/^[\s"«»'()\[\],;:—–-]+|[\s"«»'()\[\],;:—–-]+$/gu, '')
        .replace(/\s{2,}/gu, ' ')
        .trim();
}

function cleanLabeledVenueValue(value) {
    return cleanCandidate(
        clean(value, 400)
            .replace(/\(\s*https?:\/\/[^)]+\)/giu, ' ')
            .replace(/https?:\/\/\S+/giu, ' ')
            .replace(/\s+(?:двери|начало|старт|вход|цена|стоимость)\s*[:—–-].*$/iu, '')
            .replace(/\s{2,}/gu, ' '),
    );
}

function isGenericCityOnly(value) {
    return GENERIC_CITY_ONLY.test(normalized(cleanCandidate(value)));
}

function findLabeledVenue(text) {
    const source = clean(text, 20_000);
    const lines = source.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
    let fallbackAddress = null;

    for (const line of lines) {
        const venueMatch = line.match(LABELED_VENUE_PATTERN);
        if (venueMatch) {
            const candidate = cleanLabeledVenueValue(venueMatch[1]);
            if (!candidate || isGenericCityOnly(candidate)) continue;
            if (/^(?:нет|не\s+указан(?:о|а)?|неизвестно|unknown|tbd)$/iu.test(candidate)) continue;
            const address = candidate.match(ADDRESS_PATTERN)?.[0] || '';
            return {
                venue: candidate,
                canonical: candidate,
                method: 'explicit-labeled-venue',
                confidence: address ? 0.98 : 0.96,
                evidence: clean(line, 220),
                address: clean(address, 140),
            };
        }

        const addressMatch = line.match(LABELED_ADDRESS_PATTERN);
        if (!addressMatch || fallbackAddress) continue;
        const candidate = cleanLabeledVenueValue(addressMatch[1]);
        if (!candidate || isGenericCityOnly(candidate)) continue;
        if (!/\d/u.test(candidate) && !ADDRESS_PATTERN.test(candidate)) continue;
        fallbackAddress = {
            venue: candidate,
            canonical: candidate,
            method: 'explicit-labeled-address',
            confidence: 0.94,
            evidence: clean(line, 220),
            address: clean(candidate, 140),
        };
    }

    return fallbackAddress;
}

/**
 * Collects phrases governed by Russian prepositions в/во/на. These are candidates,
 * not facts: callers should only auto-accept candidates with explicit venue markers.
 */
export function collectVenueContextCandidates(text, { maximum = 12 } = {}) {
    const source = clean(text, 20_000);
    const result = [];
    const seen = new Set();
    const pattern = /(?:^|[\s(«"'—–-])(?:в|во|на)\s+([^\n.!?;:]{1,120})/giu;
    let match;
    while ((match = pattern.exec(source)) && result.length < maximum) {
        let candidate = String(match[1] || '')
            .split(/\s+(?:чтобы|где|когда|котор|если|а\s+потом|и\s+потом|с\s+\d{1,2}:[0-5]\d|в\s+\d{1,2}:[0-5]\d)\b/iu)[0]
            .replace(/\([^)]{0,160}\).*$/u, (whole) => whole) // keep immediate address parentheses
            .trim();
        const parenthesisCut = candidate.match(/^(.{1,80}?\([^)]{2,120}\))/u)?.[1];
        if (parenthesisCut) candidate = parenthesisCut;
        else candidate = candidate.split(/\s{2,}|\s+[—–-]\s+/u)[0];
        candidate = cleanCandidate(candidate);
        if (!candidate || candidate.length < 2 || candidate.length > 150) continue;
        if (/^\d{1,2}(?::|\.)\d{2}\b/u.test(candidate)) continue;
        if (TEMPORAL_OR_ABSTRACT.test(normalized(candidate))) continue;
        if (!/[\p{L}]/u.test(candidate)) continue;
        const key = normalized(candidate);
        if (seen.has(key)) continue;
        seen.add(key);
        const hasVenueType = VENUE_TYPE_PATTERN.test(candidate);
        const hasAddress = ADDRESS_PATTERN.test(candidate);
        const startsCapitalized = /^[A-ZА-ЯЁ][\p{L}0-9"«»'’-]/u.test(candidate);
        result.push({
            text: candidate,
            hasVenueType,
            hasAddress,
            startsCapitalized,
            confidence: hasAddress ? 0.92 : hasVenueType ? 0.86 : startsCapitalized ? 0.56 : 0.35,
        });
    }
    return result;
}

function findTypedVenue(text) {
    const source = clean(text, 20_000);
    const candidates = collectVenueContextCandidates(source);
    const best = candidates.find((item) => item.hasAddress || item.hasVenueType);
    if (best) {
        return {
            venue: best.text,
            canonical: best.text,
            method: best.hasAddress ? 'preposition-address' : 'preposition-venue-type',
            confidence: best.confidence,
            evidence: best.text,
            address: best.hasAddress ? best.text.match(ADDRESS_PATTERN)?.[0] || '' : '',
        };
    }

    const lines = source.split(/\n+/u).map((line) => line.trim()).filter(Boolean);
    for (const line of lines) {
        if (!VENUE_TYPE_PATTERN.test(line)) continue;
        // Explicit standalone venue lines such as "Паб Мама Анархия" or "DIESEL HALL".
        const fragments = line.split(/[|;•]/u).map(cleanCandidate).filter(Boolean);
        const fragment = fragments.find((value) => (
            VENUE_TYPE_PATTERN.test(value) &&
            value.length <= 110 &&
            !/(?:\b(?:будет|будем|идем|идём|приходи|приходите|играем|танцуем|слушаем|любим|ищем|открываем|закрываем)\b|[.!?].{3,})/iu.test(value)
        ));
        if (!fragment) continue;
        if (/^(?:билеты?|вход|цена|стоимость)(?:\s|:|$)/iu.test(fragment)) continue;
        const address = fragment.match(ADDRESS_PATTERN)?.[0] || extractNearbyAddress(source, source.indexOf(fragment), fragment.length);
        return {
            venue: address && !normalized(fragment).includes(normalized(address))
                ? `${fragment}, ${address}`
                : fragment,
            canonical: fragment,
            method: 'explicit-venue-type',
            confidence: 0.88,
            evidence: fragment,
            address: clean(address, 140),
        };
    }
    return null;
}

export function inferEventVenueFromText(text) {
    const known = findKnownVenue(text);
    if (known) {
        return {
            ...known,
            candidates: collectVenueContextCandidates(text),
        };
    }
    const labeled = findLabeledVenue(text);
    if (labeled) {
        return {
            ...labeled,
            candidates: collectVenueContextCandidates(text),
        };
    }
    const typed = findTypedVenue(text);
    return {
        ...(typed || {
            venue: '',
            canonical: '',
            method: '',
            confidence: 0,
            evidence: '',
            address: '',
        }),
        candidates: collectVenueContextCandidates(text),
    };
}

export function buildVenueSemanticAuditContext(text) {
    const inference = inferEventVenueFromText(text);
    return {
        deterministicVenue: inference.venue,
        deterministicMethod: inference.method,
        deterministicConfidence: inference.confidence,
        candidates: inference.candidates,
    };
}

export function knownVenueCatalog() {
    return KNOWN_VENUES.map(({ id, canonical }) => ({ id, canonical }));
}
