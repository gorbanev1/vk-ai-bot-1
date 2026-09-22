import { stripKnownVenueNamesFromEventTitle } from './eventVenueInference.js';
import { inferEventSearchTags, inferVenueKey, normalizeEventTags } from './eventSearchTaxonomy.js';
import { evaluatePosterFactForEvent, scorePosterFactMetadataQuality } from './eventPosterMatching.js';
import { getEventPosterSafetyAssessment } from './eventProvenance.js';

const RUSSIAN_FUNCTION_WORDS = new Set([
    'без','близ','в','во','вместо','вне','для','до','за','из','изо','из-за','из-под','к','ко','кроме','между','на','над','о','об','обо','около','от','ото','перед','по','под','при','про','ради','с','со','сквозь','среди','у','через',
    'и','а','но','или','либо','да','же','бы','чтобы','что','как','когда','где','кто','это','этот','эта','эти','тот','та','те','его','ее','её','их','мы','вы','они','он','она','оно','мой','моя','твоя','твой','наш','ваш','все','всё','для','при','после','перед','только','еще','ещё',
]);

// Эти слова описывают формат события, а не его уникальное имя. Исключение
// предотвращает склейку всех «концертов» или «фестивалей» одной даты.
const NON_IDENTITY_EVENT_WORDS = new Set([
    'туса','тусовка','вечеринка','концерт','фестиваль','мероприятие','событие','афиша','шоу','гиг','лайв','выступление','презентация','party','concert','festival','event','show','live','gig','voronezh','воронеж',
]);

function normalizeWord(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/^[-–—_]+|[-–—_]+$/gu, '')
        .trim();
}

export function normalizeAllPartyTitleTokens(value) {
    const stripped = stripKnownVenueNamesFromEventTitle(value) || String(value ?? '');
    return [...new Set(
        stripped
            .normalize('NFKC')
            .toLowerCase()
            .replace(/ё/gu, 'е')
            .replace(/[^\p{L}\p{N}]+/gu, ' ')
            .split(/\s+/u)
            .map(normalizeWord)
            .filter((word) => (
                word.length > 3 &&
                !RUSSIAN_FUNCTION_WORDS.has(word) &&
                !NON_IDENTITY_EVENT_WORDS.has(word) &&
                !/^\d+$/u.test(word)
            )),
    )];
}

export function buildAllPartyMetadataRecord(event, { partyPool = '', sourceKind = '' } = {}) {
    const sourceType = String(event?.sourceType ?? sourceKind ?? '').trim().toLowerCase();
    const eventId = Number(event?.id ?? 0);
    const title = String(event?.title ?? event?.participants ?? '').trim();
    const eventDate = String(event?.eventDate ?? '').trim();
    const venue = String(event?.venue ?? '').trim();
    const sourceUrl = String(event?.sourceUrl ?? event?.detailUrl ?? '').trim();
    return {
        sourceType,
        eventId,
        partyPool: String(partyPool ?? event?.partyPool ?? '').trim().toLowerCase(),
        title,
        eventDate,
        venue,
        venueKey: String(event?.venueKey || inferVenueKey(venue)).trim(),
        tags: [...new Set([...normalizeEventTags(event?.eventTags), ...inferEventSearchTags(event)])].slice(0, 16),
        sourceUrl,
        titleTokens: normalizeAllPartyTitleTokens(title),
        isQtickets: sourceType === 'qtickets',
    };
}

export function allPartyMetadataKey(record) {
    return `${String(record?.sourceType ?? '').trim().toLowerCase()}:${Number(record?.eventId ?? 0)}`;
}

function compatibleAllPartyPools(left, right) {
    const a = String(left?.partyPool || '').trim().toLowerCase();
    const b = String(right?.partyPool || '').trim().toLowerCase();
    // Unknown/legacy pool values cannot prove conflicting identity.
    if (!a || !b || a === b) return true;
    // QTickets is a shared aggregator, but must never bridge the two pools.
    return a === 'qtickets' || b === 'qtickets';
}

export function findAllPartySharedTitleWord(left, right) {
    if (!left || !right) return '';
    if (!compatibleAllPartyPools(left, right)) return '';
    if (String(left.eventDate ?? '') !== String(right.eventDate ?? '')) return '';
    const rightTokens = new Set(Array.isArray(right.titleTokens) ? right.titleTokens : []);
    return (Array.isArray(left.titleTokens) ? left.titleTokens : [])
        .filter((word) => rightTokens.has(word))
        .sort((a, b) => b.length - a.length || a.localeCompare(b, 'ru'))[0] || '';
}

function eventRichness(event) {
    const fields = [event?.title, event?.venue, event?.participants, event?.price, event?.description, event?.sourceUrl];
    let score = fields.reduce((sum, value) => sum + String(value ?? '').trim().length, 0);
    const poster = getEventPosterSafetyAssessment(event);
    if (poster.accepted) {
        // V188.99: within the same V188.88 source-priority tier, prefer the
        // event whose selected picture is actually relevant and richly described.
        score += 2_000 + Number(poster.match?.score || 0) * 10 + Number(poster.metadataQuality || 0) * 12;
    } else if (Array.isArray(event?.imagePaths) && event.imagePaths.length) {
        score -= 500;
    }
    return score;
}

function aggregatePosterDonorForWinner(winner, members) {
    const candidates = [];
    for (const item of members) {
        const event = item?.event || item;
        if (!event || event === winner) continue;
        const safety = getEventPosterSafetyAssessment(event);
        if (!safety.accepted || !safety.fact) continue;
        const rematch = evaluatePosterFactForEvent(winner, safety.fact);
        if (!rematch.accepted) continue;
        const selectedPath = String(safety.boundPath || '').trim();
        if (!selectedPath) continue;
        const metadataQuality = scorePosterFactMetadataQuality(safety.fact);
        candidates.push({
            event,
            fact: safety.fact,
            path: selectedPath,
            match: rematch,
            metadataQuality,
            score: Number(rematch.score || 0) * 100 + metadataQuality * 3 +
                Number(safety.fact?.posterConfidence || 0) + Math.round(Number(safety.fact?.textReadability || 0) / 2),
        });
    }
    candidates.sort((left, right) => (
        right.score - left.score ||
        right.metadataQuality - left.metadataQuality ||
        String(left.path).localeCompare(String(right.path), 'en')
    ));
    return candidates[0] || null;
}

function winnerRank(event) {
    const type = String(event?.sourceType ?? '').trim().toLowerCase();
    if (type === 'qtickets') return 3;
    if (String(event?.partyPool ?? '').trim().toLowerCase() === 'primary') return 2;
    return 1;
}

function chooseWinner(events) {
    return [...events].sort((left, right) => (
        winnerRank(right) - winnerRank(left) ||
        eventRichness(right) - eventRichness(left) ||
        Number(left?.id ?? 0) - Number(right?.id ?? 0)
    ))[0];
}

/**
 * Realtime dedupe only for «Вообще все тусы».
 * Rule: same event date + at least one shared standalone title word >3 chars.
 * Venue is retained in metadata/audit but never blocks or creates a duplicate.
 * QTickets wins a duplicate group. If its own poster is absent, a proven poster
 * from a duplicate member may be carried as verifiedImagePaths without changing
 * QTickets title/text/source identity.
 */
export function dedupeAllPartiesRealtime(events, metadataByKey = new Map()) {
    const source = Array.isArray(events) ? events.filter(Boolean) : [];
    const metadata = source.map((event) => {
        const key = `${String(event?.sourceType ?? '').trim().toLowerCase()}:${Number(event?.id ?? 0)}`;
        return metadataByKey.get(key) || buildAllPartyMetadataRecord(event, { partyPool: event?.partyPool });
    });
    const parent = source.map((_, index) => index);
    const find = (index) => {
        let current = index;
        while (parent[current] !== current) {
            parent[current] = parent[parent[current]];
            current = parent[current];
        }
        return current;
    };
    const union = (left, right) => {
        const a = find(left);
        const b = find(right);
        if (a !== b) parent[b] = a;
    };
    const matches = [];
    const byDate = new Map();
    metadata.forEach((record, index) => {
        if (!record.eventDate) return;
        if (!byDate.has(record.eventDate)) byDate.set(record.eventDate, []);
        byDate.get(record.eventDate).push(index);
    });
    for (const [eventDate, indexes] of byDate) {
        for (let a = 0; a < indexes.length; a += 1) {
            for (let b = a + 1; b < indexes.length; b += 1) {
                const leftIndex = indexes[a];
                const rightIndex = indexes[b];
                const word = findAllPartySharedTitleWord(metadata[leftIndex], metadata[rightIndex]);
                if (!word) continue;
                const leftRoot = find(leftIndex);
                const rightRoot = find(rightIndex);
                if (leftRoot === rightRoot) continue;
                const leftMembers = indexes.filter((index) => find(index) === leftRoot);
                const rightMembers = indexes.filter((index) => find(index) === rightRoot);
                // Union-find transitivity must not bypass pool or title checks.
                const groupCompatible = leftMembers.every((leftMember) =>
                    rightMembers.every((rightMember) => Boolean(
                        findAllPartySharedTitleWord(metadata[leftMember], metadata[rightMember]),
                    )),
                );
                if (!groupCompatible) continue;
                union(leftIndex, rightIndex);
                matches.push({ eventDate, word, leftIndex, rightIndex });
            }
        }
    }
    const groups = new Map();
    source.forEach((event, index) => {
        const root = find(index);
        if (!groups.has(root)) groups.set(root, []);
        groups.get(root).push({ event, meta: metadata[index], index });
    });
    const output = [];
    const auditGroups = [];
    for (const members of groups.values()) {
        const winner = chooseWinner(members.map((item) => item.event));
        let finalEvent = winner;
        if (String(winner?.sourceType ?? '').toLowerCase() === 'qtickets') {
            const ownPoster = getEventPosterSafetyAssessment(winner);
            if (!ownPoster.accepted) {
                // Keep the V188.88 QTickets card identity, but only borrow a
                // picture when the donor's selected Vision fact strictly matches
                // the QTickets event too. Transfer the binding metadata together
                // with the path so verifiedImagePaths can never become a bypass.
                const donor = aggregatePosterDonorForWinner(winner, members);
                if (donor) {
                    finalEvent = {
                        ...winner,
                        verifiedImagePaths: [donor.path],
                        posterImageIndex: Number(donor.fact?.index || 0),
                        posterMatchStatus: 'verified_title_date_poster',
                        posterMatchReason: `all-party-donor:${donor.match.reason}`,
                        posterVisionFacts: Array.isArray(donor.event?.posterVisionFacts)
                            ? donor.event.posterVisionFacts.map((fact) => ({ ...fact }))
                            : [{ ...donor.fact }],
                    };
                }
            }
        }
        output.push(finalEvent);
        if (members.length > 1) {
            auditGroups.push({
                date: String(winner?.eventDate ?? ''),
                keep: allPartyMetadataKey(buildAllPartyMetadataRecord(winner)),
                keepSourceType: String(winner?.sourceType ?? ''),
                members: members.map((item) => ({
                    key: allPartyMetadataKey(item.meta),
                    title: item.meta.title,
                    venue: item.meta.venue,
                    sourceType: item.meta.sourceType,
                })),
            });
        }
    }
    output.sort((left, right) => (
        String(left?.eventDate ?? '').localeCompare(String(right?.eventDate ?? ''), 'en') ||
        String(left?.eventTime ?? '23:59').localeCompare(String(right?.eventTime ?? '23:59'), 'en') ||
        String(left?.title ?? '').localeCompare(String(right?.title ?? ''), 'ru')
    ));
    return { events: output, groups: auditGroups, pairMatches: matches };
}


export function parseAllPartiesRequest(value) {
    const raw = String(value ?? '').normalize('NFKC').trim();
    const normalized = raw.toLowerCase().replace(/ё/gu, 'е').replace(/\s+/gu, ' ');
    const match = normalized.match(/^(?:вообще\s+все\s+тус(?:ы|овки)?|все\s+вообще\s+тус(?:ы|овки)?|общ(?:ие|ая)\s+тус(?:ы|овки)?)(?:\s+(.+))?$/u);
    if (!match) return { matched: false, rangeText: '', commandText: raw };
    return {
        matched: true,
        rangeText: String(match[1] ?? '').trim(),
        commandText: raw,
    };
}
