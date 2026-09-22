import { inferVenueKey } from './eventSearchTaxonomy.js';

const GENERIC_TITLE_TOKENS = new Set([
    'party','вечеринка','вечеринку','туса','тусовка','тусовки','event','events','событие','события',
    'concert','концерт','концерта','gig','show','шоу','festival','фестиваль','fest','live','music','музыка',
    'dj','djs','rock','рок','metal','метал','металл','bar','бар','club','клуб','pub','паб','hall','холл',
    'воронеж','vrn',
]);

function normalize(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[«»„“”"'`´]/gu, ' ')
        .replace(/[^a-zа-я0-9]+/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function tokens(value, { generic = false } = {}) {
    return normalize(value)
        .split(' ')
        .filter((token) => token.length >= 3 && !/^\d+$/u.test(token))
        .filter((token) => !generic || !GENERIC_TITLE_TOKENS.has(token));
}

function tokenMetrics(left, right, { generic = false } = {}) {
    const a = [...new Set(tokens(left, { generic }))];
    const b = [...new Set(tokens(right, { generic }))];
    if (!a.length || !b.length) return { common: 0, smaller: Math.min(a.length, b.length), coverage: 0, strong: false };
    const bSet = new Set(b);
    const commonTokens = a.filter((token) => bSet.has(token));
    const smaller = Math.min(a.length, b.length);
    const required = smaller >= 3 ? 2 : 1;
    const oneStrongToken = smaller === 1 && commonTokens.some((token) => token.length >= 5);
    return {
        common: commonTokens.length,
        smaller,
        coverage: commonTokens.length / smaller,
        strong: commonTokens.length >= required && (smaller > 1 || oneStrongToken),
        commonTokens,
    };
}

function normalizeUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        url.hash = '';
        for (const key of [...url.searchParams.keys()]) {
            if (/^(?:utm_|ref$|from$|w$)/iu.test(key)) url.searchParams.delete(key);
        }
        return url.toString().replace(/\/$/u, '').toLowerCase();
    } catch {
        return raw.replace(/\/$/u, '').toLowerCase();
    }
}

function compactPosterFacts(facts) {
    return (Array.isArray(facts) ? facts : []).slice(0, 24).map((fact) => ({
        index: Number(fact?.index || 0),
        title: String(fact?.title || '').trim(),
        date: String(fact?.date || fact?.dates || '').trim(),
        venue: String(fact?.venue || '').trim(),
        participants: String(fact?.participants || '').trim(),
        text: String(fact?.recognizedText || fact?.text || '').trim().slice(0, 1200),
        poster: fact?.poster === true,
    }));
}

function hashableText(value) {
    return normalize(value).split(' ').slice(0, 160).join(' ');
}

export function buildPermanentEventFingerprint(event = {}) {
    const canonicalPostUrl = normalizeUrl(event?.canonicalPostUrl || event?.sourceOriginalUrl || event?.sourceUrl || event?.detailUrl);
    const sourceUrl = normalizeUrl(event?.sourceUrl || event?.detailUrl || event?.sourceOriginalUrl);
    return {
        version: 1,
        eventDate: String(event?.eventDate || event?.date || '').trim(),
        title: String(event?.title || '').trim(),
        venue: String(event?.venue || '').trim(),
        venueKey: String(event?.venueKey || inferVenueKey(event?.venue)).trim(),
        participants: String(event?.participants || '').trim(),
        description: String(event?.description || event?.announcement || '').trim().slice(0, 6000),
        evidence: String(event?.evidence || '').trim().slice(0, 3000),
        sourceText: String(event?.sourceText || event?.rawText || '').trim().slice(0, 8000),
        sourceType: String(event?.sourceType || event?.provenanceSourceType || '').trim(),
        sourceItemId: String(event?.sourceItemId || event?.externalId || '').trim(),
        sourceUrl,
        canonicalPostUrl,
        posterVisionFacts: compactPosterFacts(event?.posterVisionFacts),
        eventTags: Array.isArray(event?.eventTags) ? [...new Set(event.eventTags.map((item) => String(item || '').trim()).filter(Boolean))].slice(0, 16) : [],
    };
}

function posterSupport(event, block) {
    const eventFacts = compactPosterFacts(event?.posterVisionFacts);
    const blockFacts = compactPosterFacts(block?.posterVisionFacts);
    let date = false;
    let title = false;
    let venue = false;
    let participants = false;
    for (const left of eventFacts) {
        for (const right of blockFacts) {
            if (!date && left.date && right.date && normalize(left.date) === normalize(right.date)) date = true;
            if (!title && tokenMetrics(left.title, right.title, { generic: true }).strong) title = true;
            if (!venue && inferVenueKey(left.venue) && inferVenueKey(left.venue) === inferVenueKey(right.venue)) venue = true;
            if (!participants && tokenMetrics(left.participants, right.participants).strong) participants = true;
        }
    }
    return { date, title, venue, participants };
}

export function compareEventToPermanentFingerprint(event = {}, rawBlock = {}) {
    const block = rawBlock?.fingerprint && typeof rawBlock.fingerprint === 'object' ? rawBlock.fingerprint : rawBlock;
    const candidate = buildPermanentEventFingerprint(event);
    const reasons = [];
    if (!candidate.eventDate || !block?.eventDate || candidate.eventDate !== String(block.eventDate).trim()) {
        return { matched: false, score: 0, reasons: ['date-mismatch-or-missing'] };
    }
    reasons.push('same-date');

    const title = tokenMetrics(candidate.title, block.title, { generic: true });
    const participants = tokenMetrics(candidate.participants, block.participants);
    const candidateVenueKey = candidate.venueKey || inferVenueKey(candidate.venue);
    const blockVenueKey = String(block.venueKey || inferVenueKey(block.venue)).trim();
    const venueMatch = Boolean(candidateVenueKey && blockVenueKey && candidateVenueKey === blockVenueKey);
    const sourceMatch = Boolean(
        (candidate.canonicalPostUrl && block.canonicalPostUrl && candidate.canonicalPostUrl === normalizeUrl(block.canonicalPostUrl)) ||
        (candidate.sourceUrl && block.sourceUrl && candidate.sourceUrl === normalizeUrl(block.sourceUrl)) ||
        (candidate.sourceItemId && block.sourceItemId && candidate.sourceItemId === String(block.sourceItemId).trim())
    );
    const exactTitle = Boolean(normalize(candidate.title) && normalize(candidate.title) === normalize(block.title));
    const textSimilarity = tokenMetrics(
        hashableText(`${candidate.description} ${candidate.evidence}`),
        hashableText(`${block.description || ''} ${block.evidence || ''}`),
    );
    const poster = posterSupport(candidate, block);

    if (sourceMatch) reasons.push('same-source-lineage');
    if (exactTitle) reasons.push('exact-title');
    else if (title.strong) reasons.push(`title-tokens:${title.common}`);
    if (participants.strong) reasons.push(`participants:${participants.common}`);
    if (venueMatch) reasons.push(`venue:${candidateVenueKey}`);
    if (textSimilarity.strong && textSimilarity.coverage >= 0.45) reasons.push('body-overlap');
    if (poster.date) reasons.push('poster-date');
    if (poster.title) reasons.push('poster-title');
    if (poster.venue) reasons.push('poster-venue');
    if (poster.participants) reasons.push('poster-participants');

    let score = 40; // exact calendar day is mandatory and strongest base signal.
    if (sourceMatch) score += 35;
    if (exactTitle) score += 35;
    else if (title.strong) score += Math.min(30, 12 + title.common * 8);
    if (participants.strong) score += 16;
    if (venueMatch) score += 12;
    if (textSimilarity.strong && textSimilarity.coverage >= 0.45) score += 10;
    if (poster.date) score += 14;
    if (poster.title) score += 10;
    if (poster.venue) score += 6;
    if (poster.participants) score += 6;

    // Fail closed: a date alone is never enough. Exact source lineage still
    // needs one event-specific signal so a multi-announcement post does not
    // blacklist every child card from that source.
    const strongIdentity = exactTitle || title.strong || participants.strong || poster.title || poster.participants;
    const bodyIdentity = textSimilarity.strong && textSimilarity.coverage >= 0.60;
    const matched = (strongIdentity || bodyIdentity) && (
        exactTitle ||
        (sourceMatch && score >= 80) ||
        (!sourceMatch && strongIdentity && score >= 90) ||
        (poster.date && strongIdentity && score >= 82)
    );
    return { matched, score, reasons };
}

export function permanentEventFingerprintLabel(rawBlock = {}) {
    const block = rawBlock?.fingerprint && typeof rawBlock.fingerprint === 'object' ? rawBlock.fingerprint : rawBlock;
    return [block?.eventDate, block?.title, block?.venue].map((item) => String(item || '').trim()).filter(Boolean).join(' · ');
}
