/**
 * Deterministic, auditable poster-to-event matching.
 *
 * V188.99 contract (supersedes the permissive V188.93 date-only fallback):
 * - date/day+month remains a mandatory hard signal for poster binding;
 * - title/participants must additionally prove event identity before a picture
 *   can enter a public card; date-only posters are audit candidates only;
 * - common words (party/concert/bar/club/etc.) never create identity;
 * - one schedule image may legitimately belong to several child events when
 *   the image metadata explicitly contains several matching dates;
 * - if two images remain equally plausible for one event, do not guess: mark
 *   the event for owner review instead of silently replacing the poster.
 */

function normalizeImageMatchText(value) {
    return String(value ?? '')
        .normalize('NFKC')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[^a-zа-я0-9]+/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

const WEAK_IDENTITY_TOKENS = new Set([
    'концерт','гиг','gig','пати','party','вечеринка','туса','тусовка','шоу','show','live',
    'фестиваль','фест','event','событие','мероприятие','выступление','презентация',
    'альбом','альбома','программа','воронеж','воронеже','воронежа','группа','группы',
    'bar','бар','pub','паб','club','клуб','hall','холл','rock','рок','кафе','ресторан',
    'центр','площадка','сцена','дом','дк','арт','музыка','music','dj','диджей',
    'январь','января','янв','февраль','февраля','фев','март','марта','мар',
    'апрель','апреля','апр','май','мая','июнь','июня','июн','июль','июля','июл',
    'август','августа','авг','сентябрь','сентября','сен','сент','октябрь','октября','окт',
    'ноябрь','ноября','ноя','декабрь','декабря','дек',
]);

const NON_POSTER_TYPES = /(?:ordinary[- ]?photo|event[- ]?photo|concert[- ]?photo|photo|фото|обычн\w*\s+фото|репортаж|logo|логотип|avatar|аватар|album[- ]?cover|обложк|ui|interface|интерфейс|sticker|emoji)/iu;
const POSTER_TYPES = /(?:poster|афиш|flyer|флаер|announcement|анонс|event[- ]?visual)/iu;

const MONTHS = new Map([
    ['1',1],['01',1],['январь',1],['января',1],['янв',1],['january',1],['jan',1],
    ['2',2],['02',2],['февраль',2],['февраля',2],['фев',2],['february',2],['feb',2],
    ['3',3],['03',3],['март',3],['марта',3],['мар',3],['march',3],['mar',3],
    ['4',4],['04',4],['апрель',4],['апреля',4],['апр',4],['april',4],['apr',4],
    ['5',5],['05',5],['май',5],['мая',5],['may',5],
    ['6',6],['06',6],['июнь',6],['июня',6],['июн',6],['june',6],['jun',6],
    ['7',7],['07',7],['июль',7],['июля',7],['июл',7],['july',7],['jul',7],
    ['8',8],['08',8],['август',8],['августа',8],['авг',8],['august',8],['aug',8],
    ['9',9],['09',9],['сентябрь',9],['сентября',9],['сен',9],['сент',9],['september',9],['sep',9],['sept',9],
    ['10',10],['октябрь',10],['октября',10],['окт',10],['october',10],['oct',10],
    ['11',11],['ноябрь',11],['ноября',11],['ноя',11],['november',11],['nov',11],
    ['12',12],['декабрь',12],['декабря',12],['дек',12],['december',12],['dec',12],
]);

function imageMatchTokens(value) {
    return normalizeImageMatchText(value)
        .split(' ')
        .filter((token) => token.length >= 3 && !/^\d+$/u.test(token) && !WEAK_IDENTITY_TOKENS.has(token));
}

function readFactField(text, names) {
    const escaped = names.map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')).join('|');
    const match = String(text ?? '').match(new RegExp(`(?:^|[\\n;])[ \\t]*(?:${escaped})[ \\t]*:[ \\t]*([^;\\r\\n]*)`, 'iu'));
    return String(match?.[1] ?? '').trim();
}

function readPercentField(text, names) {
    const raw = readFactField(text, names);
    const value = Number(String(raw).match(/\d{1,3}/u)?.[0] || NaN);
    return Number.isFinite(value) ? Math.max(0, Math.min(100, value)) : null;
}

function readTagFactField(text) {
    const match = String(text ?? '').match(
        /(?:^|[\n;])[ \t]*(?:Теги|Жанры|Tags)[ \t]*:[ \t]*([\s\S]*?)(?=(?:[\n;][ \t]*(?:Распознанный текст|OCR|Текст на изображении|Причина|Почему|Reason)[ \t]*:)|$)/iu,
    );
    return String(match?.[1] ?? '').trim();
}

function inferPosterFlag(posterRaw, imageType) {
    if (/^(?:да|yes|true|poster)(?:\s|$)/iu.test(posterRaw)) return true;
    if (/^(?:нет|no|false)(?:\s|$)/iu.test(posterRaw)) return false;
    if (NON_POSTER_TYPES.test(imageType)) return false;
    if (POSTER_TYPES.test(imageType)) return true;
    return null;
}

export function parseIndexedImageFacts(imageFacts) {
    const text = String(imageFacts ?? '');
    const matches = [...text.matchAll(/\[IMAGE\s+(\d+)\]/giu)];
    return matches.map((match, offset) => {
        const blockText = text.slice(match.index + match[0].length, matches[offset + 1]?.index ?? text.length).trim();
        const imageType = readFactField(blockText, ['Тип изображения', 'Тип', 'Image type']);
        const posterRaw = readFactField(blockText, ['Это афиша события', 'Афиша', 'Poster']);
        // Durable outcome for each image that produced an IMAGE block. This
        // distinguishes an inspected image with no event metadata from an
        // image that was never inspected or failed before returning a block.
        const metadataFields = [
            readFactField(blockText, ['Название', 'Событие']),
            readFactField(blockText, ['Дата', 'Даты']),
            readFactField(blockText, ['Время']),
            readFactField(blockText, ['Место', 'Площадка', 'Venue']),
            readFactField(blockText, ['Участники', 'Исполнители', 'Артисты']),
            readFactField(blockText, ['Цена', 'Стоимость', 'Price']),
            readFactField(blockText, ['Распознанный текст', 'OCR', 'Текст на изображении'])];
        const hasMetadata = metadataFields.some((value) => String(value ?? '').trim());
        const explicitFailure = /(?:ошибк|error|не удалось|failed|timeout|недоступ)/iu.test(blockText);
        const visionStatus = explicitFailure ? 'error' : (hasMetadata ? 'metadata_found' : 'metadata_not_found');
        return {
            index: Number(match[1]),
            text: blockText,
            visionStatus,
            visionInspected: true,
            imageType,
            poster: inferPosterFlag(posterRaw, imageType),
            posterConfidence: readPercentField(blockText, ['Уверенность афиши', 'Уверенность', 'Poster confidence']),
            textReadability: readPercentField(blockText, ['Читаемость текста', 'Читаемость', 'Text readability']),
            title: readFactField(blockText, ['Название', 'Событие']),
            dates: readFactField(blockText, ['Дата', 'Даты']),
            time: readFactField(blockText, ['Время']),
            startTime: readFactField(blockText, ['Начало', 'Время начала', 'Start']) || readFactField(blockText, ['Время']),
            endTime: readFactField(blockText, ['Окончание', 'Время окончания', 'End']),
            venue: readFactField(blockText, ['Место', 'Площадка', 'Venue']),
            city: readFactField(blockText, ['Город', 'City']),
            locality: readFactField(blockText, ['Населенный пункт', 'Населённый пункт', 'Locality']),
            address: readFactField(blockText, ['Адрес', 'Address']),
            participants: readFactField(blockText, ['Участники', 'Исполнители', 'Артисты']),
            price: readFactField(blockText, ['Цена', 'Стоимость', 'Price']),
            age: readFactField(blockText, ['Возраст', 'Возрастное ограничение', 'Age']),
            program: readFactField(blockText, ['Программа', 'Program']),
            tags: readTagFactField(blockText)
                .split(/[,;|]/u).map((value) => value.trim()).filter(Boolean).slice(0, 16),
            recognizedText: readFactField(blockText, ['Распознанный текст', 'OCR', 'Текст на изображении']),
            reason: readFactField(blockText, ['Причина', 'Почему', 'Reason']),
        };
    }).filter((item) => Number.isInteger(item.index) && item.index > 0 && item.text);
}

function dateKey(day, month) {
    const d = Number(day);
    const m = Number(month);
    if (!Number.isInteger(d) || !Number.isInteger(m) || d < 1 || d > 31 || m < 1 || m > 12) return '';
    return `${String(d).padStart(2, '0')}-${String(m).padStart(2, '0')}`;
}

export function extractPosterDateKeys(value) {
    const source = String(value ?? '').normalize('NFKC').toLowerCase().replace(/ё/gu, 'е');
    const result = new Set();
    for (const match of source.matchAll(/(?<!\d)([0-3]?\d)[.\/-]([01]?\d)(?:[.\/-](?:20)?\d{2,4})?(?!\d)/gu)) {
        const key = dateKey(match[1], match[2]);
        if (key) result.add(key);
    }
    for (const match of source.matchAll(/(?<![\p{L}\p{N}])([0-3]?\d)\s+(январ(?:ь|я)|янв|феврал(?:ь|я)|фев|март(?:а)?|мар|апрел(?:ь|я)|апр|ма(?:й|я)|июн(?:ь|я)?|июл(?:ь|я)?|август(?:а)?|авг|сентябр(?:ь|я)|сен|сент|октябр(?:ь|я)|окт|ноябр(?:ь|я)|ноя|декабр(?:ь|я)|дек|january|jan|february|feb|march|mar|april|apr|may|june|jun|july|jul|august|aug|september|sep|sept|october|oct|november|nov|december|dec)(?![\p{L}\p{N}])/giu)) {
        const month = MONTHS.get(String(match[2]).toLowerCase());
        const key = dateKey(match[1], month);
        if (key) result.add(key);
    }
    return [...result];
}

function eventDateKey(eventDate) {
    const match = String(eventDate ?? '').trim().match(/^\d{4}-(\d{2})-(\d{2})$/u);
    return match ? dateKey(match[2], match[1]) : '';
}

function identityTokensForEvent(event) {
    const venueTokens = new Set(imageMatchTokens(event?.venue || ''));
    // V188.94: do not erase a distinctive title token merely because the same
    // word also appears in the venue (e.g. "Malina Party" at Malina Lounge).
    // Date is already the hard binding signal; title tokens are additional
    // identity/ranking evidence and must remain available for comparison.
    const titleTokens = imageMatchTokens(event?.title || '');
    const participantTokens = imageMatchTokens(event?.participants || '');
    return {
        titleTokens: [...new Set(titleTokens)],
        participantTokens: [...new Set(participantTokens)],
        venueTokens: [...venueTokens],
    };
}

function posterIdentityAudit(event, block) {
    const { titleTokens, participantTokens, venueTokens } = identityTokensForEvent(event);
    const blockTitleTokens = new Set(imageMatchTokens(block?.title || ''));
    const blockParticipantTokens = new Set(imageMatchTokens(block?.participants || ''));
    const identityPool = new Set([...blockTitleTokens, ...blockParticipantTokens]);
    const titleHits = titleTokens.filter((token) => identityPool.has(token));
    const participantHits = participantTokens.filter((token) => identityPool.has(token));
    const identityHits = [...new Set([...titleHits, ...participantHits])];
    const venueText = normalizeImageMatchText(block?.venue || '');
    const venueHits = venueTokens.filter((token) => venueText.includes(token));
    const eventTitleSize = new Set(titleTokens).size;
    const titleCoverage = eventTitleSize ? titleHits.length / eventTitleSize : 0;
    const eventIdentitySize = new Set([...titleTokens, ...participantTokens]).size;
    const enoughTitle = titleHits.length >= 1 && (
        eventTitleSize <= 2 ||
        titleCoverage >= 0.6 ||
        titleHits.length >= 2
    );
    return { titleTokens, participantTokens, titleHits, participantHits, identityHits, venueHits, titleCoverage, eventIdentitySize, enoughTitle };
}

export function evaluatePosterFactForEvent(event, block) {
    if (!block) return { accepted: false, score: -1000, reason: 'missing-facts', dateMatched: false };
    if (block.poster !== true) {
        return {
            accepted: false,
            score: block.poster === false ? -1000 : -500,
            reason: block.poster === false ? 'not-a-poster' : 'poster-not-confirmed',
            dateMatched: false,
        };
    }
    if (NON_POSTER_TYPES.test(block.imageType || '')) {
        return { accepted: false, score: -1000, reason: 'non-poster-image-type', dateMatched: false };
    }
    if (Number.isFinite(block.posterConfidence) && block.posterConfidence < 55) {
        return { accepted: false, score: -200, reason: 'poster-confidence-too-low', dateMatched: false };
    }

    // A post that produced exactly one event and exactly one downloaded source
    // image has an unambiguous event-to-media binding even when the first Vision
    // pass returned no structured OCR. This marker is created only by the
    // single-event/single-image fallback in eventAssets.js and is path-bound, so
    // it cannot spray one gallery image across a multi-announcement schedule.
    if (block.fallbackBinding === 'single-event-single-image' &&
        Number(block.sourceEventCount || 0) === 1 &&
        Number(block.sourceImageCount || 0) === 1 &&
        String(block.imagePath || '').trim() &&
        !/(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(String(block.imagePath || '').replace(/\\+/gu, '/')) &&
        (Array.isArray(event?.imagePaths) ? event.imagePaths : []).some((path) => String(path || '').trim() === String(block.imagePath).trim())) {
        return {
            accepted: true,
            score: 125,
            reason: 'single-event-single-source-image',
            dateMatched: true,
            fallbackBinding: true,
            posterDates: [],
        };
    }

    const wantedDate = eventDateKey(event?.eventDate ?? event?.date);
    const posterDates = extractPosterDateKeys([block.dates, block.recognizedText, block.text].filter(Boolean).join('\n'));
    const dateMatched = Boolean(wantedDate && posterDates.includes(wantedDate));
    if (!dateMatched) return { accepted: false, score: 0, reason: 'no-date-match', dateMatched: false, posterDates };

    const identity = posterIdentityAudit(event, block);
    const confidence = Number.isFinite(block.posterConfidence) ? block.posterConfidence : 70;
    const readability = Number.isFinite(block.textReadability) ? block.textReadability : 65;
    const qualityBonus = Math.round(confidence / 10) + Math.round(readability / 20);
    const hitBonus = identity.titleHits.length * 22 + identity.participantHits.length * 12 + identity.venueHits.length * 2;

    if (identity.enoughTitle) {
        return {
            accepted: true,
            score: 170 + hitBonus + qualityBonus,
            reason: identity.titleHits.length >= 2 ? 'date+title-majority' : 'date+distinctive-title',
            dateMatched: true,
            ...identity,
            posterDates,
        };
    }
    if (identity.identityHits.length >= 2) {
        return { accepted: true, score: 145 + hitBonus + qualityBonus, reason: 'date+identity-tokens', dateMatched: true, ...identity, posterDates };
    }
    if (identity.identityHits.length === 1 && identity.eventIdentitySize <= 2) {
        return { accepted: true, score: 130 + hitBonus + qualityBonus, reason: 'date+distinctive-identity', dateMatched: true, ...identity, posterDates };
    }
    return {
        accepted: false,
        score: 20 + hitBonus + qualityBonus,
        reason: identity.identityHits.length ? 'identity-too-weak' : 'date-without-event-identity',
        dateMatched: true,
        ...identity,
        posterDates,
    };
}

export function scorePosterFactMetadataQuality(fact) {
    if (!fact || typeof fact !== 'object') return 0;
    let score = 0;
    if (fact.poster === true) score += 8;
    if (String(fact.imageType || '').trim()) score += 4;
    if (Number.isFinite(Number(fact.posterConfidence))) score += 8;
    if (Number.isFinite(Number(fact.textReadability))) score += 8;
    if (String(fact.title || '').trim()) score += 15;
    if (extractPosterDateKeys([fact.dates, fact.recognizedText, fact.text].filter(Boolean).join('\n')).length) score += 18;
    if (String(fact.participants || '').trim()) score += 12;
    if (String(fact.venue || '').trim()) score += 6;
    if (String(fact.city || fact.locality || '').trim()) score += 3;
    if (String(fact.address || '').trim()) score += 3;
    if (String(fact.startTime || fact.time || '').trim()) score += 3;
    if (String(fact.recognizedText || '').trim()) score += 7;
    if (String(fact.program || '').trim()) score += 2;
    if (String(fact.reason || '').trim()) score += 1;
    if (/^[a-f0-9]{64}$/iu.test(String(fact.imageSha256 || '').trim())) score += 3;
    if (String(fact.imagePath || '').trim()) score += 1;
    if (String(fact.imageFilename || '').trim()) score += 1;
    return Math.min(100, score);
}

export function selectBestCompatiblePosterFact(event, facts, { preferredIndex = 0 } = {}) {
    const rows = (Array.isArray(facts) ? facts : [])
        .map((fact) => ({ fact, match: evaluatePosterFactForEvent(event, fact) }))
        .filter((item) => item.match.accepted)
        .sort((left, right) => (
            Number(Number(right.fact?.index || 0) === Number(preferredIndex || 0)) - Number(Number(left.fact?.index || 0) === Number(preferredIndex || 0)) ||
            right.match.score - left.match.score ||
            Number(right.fact?.posterConfidence || 0) - Number(left.fact?.posterConfidence || 0) ||
            Number(right.fact?.textReadability || 0) - Number(left.fact?.textReadability || 0) ||
            Number(left.fact?.index || 0) - Number(right.fact?.index || 0)
        ));
    const best = rows[0] || null;
    if (!best) return null;
    const second = rows[1] || null;
    const preferredWins = Number(best.fact?.index || 0) === Number(preferredIndex || 0) && Number(preferredIndex || 0) > 0;
    const strongIdentityLead = Number(best.match?.titleHits?.length || 0) > Number(second?.match?.titleHits?.length || 0) ||
        Number(best.match?.identityHits?.length || 0) > Number(second?.match?.identityHits?.length || 0);
    const scoreLead = second ? best.match.score - second.match.score : 999;
    const ambiguous = Boolean(second && !preferredWins && !strongIdentityLead && scoreLead < 18);
    return {
        ...best,
        ambiguous,
        candidates: rows.slice(0, 4),
    };
}

export function posterBindingIsMetadataCompatible(event, facts, imageIndex) {
    const index = Number(imageIndex || 0);
    if (!Number.isInteger(index) || index <= 0) return false;
    const fact = (Array.isArray(facts) ? facts : []).find((item) => Number(item?.index || 0) === index);
    return Boolean(fact && evaluatePosterFactForEvent(event, fact).accepted);
}

export function assignEventImageIndexesFromFacts(events, imageFacts, { onAudit = null } = {}) {
    return assignEventImageIndexesFromParsedFacts(events, parseIndexedImageFacts(imageFacts), { onAudit });
}

export function assignEventImageIndexesFromParsedFacts(events, parsedFacts, { onAudit = null } = {}) {
    const sourceEvents = Array.isArray(events) ? events : [];
    const blocks = (Array.isArray(parsedFacts) ? parsedFacts : [])
        .filter((item) => Number.isInteger(Number(item?.index)) && Number(item.index) > 0)
        .map((item) => ({ ...item, index: Number(item.index) }));
    if (!sourceEvents.length) return sourceEvents;
    if (!blocks.length) {
        return sourceEvents.map((event) => ({
            ...event,
            imageIndexes: [],
            posterImageIndex: 0,
            posterMatchStatus: 'no_safe_poster',
            posterMatchReason: 'missing-vision-facts',
            posterVisionFacts: [],
        }));
    }

    // V188.93 intentionally does NOT globally reserve an image for one event.
    // A single schedule poster can contain 18 and 19 September and is valid for
    // both child cards when both dates are explicitly present in its metadata.
    return sourceEvents.map((event) => {
        const preferred = (Array.isArray(event?.imageIndexes) ? event.imageIndexes : [])
            .map(Number).find((value) => Number.isInteger(value) && value > 0) || 0;
        const selection = selectBestCompatiblePosterFact(event, blocks, { preferredIndex: preferred });
        const candidates = selection?.candidates || [];
        for (const item of candidates) {
            onAudit?.({
                event,
                imageIndex: item.fact.index,
                accepted: Boolean(selection && !selection.ambiguous && item.fact.index === selection.fact.index),
                candidateAccepted: true,
                reason: selection?.ambiguous && item.fact.index === selection.fact.index
                    ? `owner-review-required:${item.match.reason}`
                    : item.match.reason,
                score: item.match.score,
                imageType: item.fact.imageType || '',
                poster: item.fact.poster,
                posterConfidence: item.fact.posterConfidence,
                textReadability: item.fact.textReadability,
                facts: item.fact,
            });
        }
        if (!selection) {
            onAudit?.({ event, imageIndex: 0, accepted: false, candidateAccepted: false, reason: 'no-safe-poster', score: 0 });
            return {
                ...event,
                imageIndexes: [], posterImageIndex: 0,
                posterMatchStatus: 'no_safe_poster', posterMatchReason: 'no-safe-poster',
                posterVisionFacts: blocks,
            };
        }
        if (selection.ambiguous) {
            const reviewCandidates = selection.candidates.map((item) => ({
                index: Number(item.fact.index), score: Number(item.match.score || 0), reason: item.match.reason,
                title: String(item.fact.title || ''), dates: String(item.fact.dates || ''),
            }));
            return {
                ...event,
                imageIndexes: [], posterImageIndex: 0,
                posterMatchStatus: 'poster_review_required',
                posterMatchReason: 'multiple-date-compatible-posters',
                posterReviewCandidates: reviewCandidates,
                posterVisionFacts: blocks,
            };
        }
        return {
            ...event,
            imageIndexes: [selection.fact.index],
            posterImageIndex: selection.fact.index,
            posterMatchStatus: sourceEvents.length > 1 ? 'verified_multi_event_poster' : 'verified_single_event_source_media',
            posterMatchReason: selection.match.reason,
            posterReviewCandidates: [],
            posterVisionFacts: blocks,
        };
    });
}

export function applyPosterDerivedVenueFallback(events) {
    return (Array.isArray(events) ? events : []).map((event) => {
        const currentVenue = String(event?.venue ?? '').trim();
        if (currentVenue && currentVenue !== 'место не указано') {
            return { ...event, venue: currentVenue, venueSource: String(event?.venueSource || 'structured-or-text') };
        }
        const selectedIndex = Number(event?.posterImageIndex || 0);
        const blocks = Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : [];
        const selected = blocks.find((block) => Number(block?.index || 0) === selectedIndex);
        const posterVenue = String(selected?.venue ?? '').trim();
        if (posterVenue) return { ...event, venue: posterVenue, venueSource: 'poster' };
        return { ...event, venue: currentVenue, venueSource: String(event?.venueSource || '') };
    });
}
