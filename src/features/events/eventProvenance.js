import { evaluatePosterFactForEvent, scorePosterFactMetadataQuality } from './eventPosterMatching.js';

function clean(value, maximum = 4000) {
    return String(value ?? '').trim().slice(0, maximum);
}

function parseHttpUrl(value) {
    const source = clean(value);
    if (!source) return null;
    try {
        const url = new URL(source);
        if (!/^https?:$/iu.test(url.protocol)) return null;
        return url;
    } catch {
        return null;
    }
}

export function canonicalVkWallUrl(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return '';
    const host = parsed.hostname.toLowerCase().replace(/^(?:www\.|m\.)/u, '');
    if (host !== 'vk.ru' && host !== 'vk.com') return '';
    const direct = parsed.pathname.match(/^\/wall(-?\d+_\d+)\/?$/iu);
    // VK share links may encode a post as ?w=wall-123_456.
    const encoded = String(parsed.searchParams.get('w') || '').match(/^wall(-?\d+_\d+)$/iu);
    const match = direct || encoded;
    return match ? `https://vk.ru/wall${match[1].toLowerCase()}` : '';
}

export function canonicalTelegramPostUrl(value) {
    const parsed = parseHttpUrl(value);
    if (!parsed) return '';
    const host = parsed.hostname.toLowerCase().replace(/^www\./u, '');
    if (host !== 't.me' && host !== 'telegram.me') return '';
    const parts = parsed.pathname.split('/').filter(Boolean);
    const offset = parts[0]?.toLowerCase() === 's' ? 1 : 0;
    const channel = parts[offset] || '';
    const postId = Number(parts[offset + 1] || 0);
    if (!channel || !Number.isInteger(postId) || postId <= 0) return '';
    return `https://t.me/${channel}/${postId}`;
}

export function canonicalPostUrl(value) {
    return canonicalVkWallUrl(value) || canonicalTelegramPostUrl(value) || '';
}

export function extractHttpUrls(value) {
    return (String(value ?? '').match(/https?:\/\/[^\s<>"'«»]+/giu) ?? [])
        .map((url) => url.replace(/[),.;!?]+$/gu, ''));
}

function firstCanonical(values, platform = '') {
    for (const value of Array.isArray(values) ? values : []) {
        const url = platform === 'vk' ? canonicalVkWallUrl(value) : canonicalPostUrl(value);
        if (url) return url;
    }
    return '';
}

export function resolveVkChatProvenance({
    peerId = 0,
    conversationName = '',
    conversationMessageId = 0,
    conversationUrl = '',
    text = '',
    repostUrls = [],
    attachmentLinks = [],
    links = [],
    sourceUrl = '',
} = {}) {
    const canonicalFromRepost = firstCanonical(repostUrls, 'vk');
    const canonicalFromText = firstCanonical(extractHttpUrls(text), 'vk');
    const canonicalFromAttachment = firstCanonical(attachmentLinks, 'vk');
    const canonicalFromLinks = firstCanonical(links, 'vk');
    const canonicalFromSource = canonicalVkWallUrl(sourceUrl);
    const canonical = canonicalFromRepost || canonicalFromText || canonicalFromAttachment || canonicalFromLinks || canonicalFromSource;
    let canonicalOrigin = 'chat-message-only';
    if (canonicalFromRepost) canonicalOrigin = 'chat-repost';
    else if (canonicalFromText) canonicalOrigin = 'chat-link';
    else if (canonicalFromAttachment || canonicalFromLinks || canonicalFromSource) canonicalOrigin = 'chat-attachment';

    return {
        canonicalPostUrl: canonical,
        sourceType: 'vk_chat',
        sourceChatId: Number(peerId) || 0,
        sourceChatName: clean(conversationName, 500),
        sourceMessageId: Number(conversationMessageId) || 0,
        sourceItemId: `${Number(peerId) || 0}:${Number(conversationMessageId) || 0}`,
        sourceOriginalUrl: clean(conversationUrl || sourceUrl, 2000),
        canonicalOrigin,
    };
}

export function buildEventProvenance({
    sourceType = '',
    sourceUrl = '',
    sourceName = '',
    sourceItemId = '',
    messageId = 0,
    postId = 0,
    peerId = 0,
    conversationMessageId = 0,
    conversationName = '',
    conversationUrl = '',
    text = '',
    repostUrls = [],
    attachmentLinks = [],
    links = [],
} = {}) {
    const type = clean(sourceType, 60).toLowerCase();
    if (type === 'vk_chat' || type === 'vk-chat') {
        return resolveVkChatProvenance({
            peerId,
            conversationName: conversationName || sourceName,
            conversationMessageId,
            conversationUrl,
            text,
            repostUrls,
            attachmentLinks,
            links,
            sourceUrl,
        });
    }
    if (type === 'telegram' || type === 'tg') {
        const canonical = canonicalTelegramPostUrl(sourceUrl);
        return {
            canonicalPostUrl: canonical,
            sourceType: 'telegram',
            sourceChatId: 0,
            sourceChatName: clean(sourceName, 500),
            sourceMessageId: Number(messageId) || 0,
            sourceItemId: clean(sourceItemId || messageId, 500),
            sourceOriginalUrl: clean(sourceUrl, 2000),
            canonicalOrigin: canonical ? 'telegram-post' : 'telegram-post-missing-url',
        };
    }
    if (type === 'vk' || type === 'vk_wall' || type === 'vk-public') {
        const canonical = canonicalVkWallUrl(sourceUrl);
        return {
            canonicalPostUrl: canonical,
            sourceType: 'vk_wall',
            sourceChatId: 0,
            sourceChatName: '',
            sourceMessageId: 0,
            sourceItemId: clean(sourceItemId || postId, 500),
            sourceOriginalUrl: clean(sourceUrl, 2000),
            canonicalOrigin: canonical ? 'direct-wall' : 'direct-wall-missing-url',
        };
    }
    return {
        canonicalPostUrl: canonicalPostUrl(sourceUrl),
        sourceType: 'manual',
        sourceChatId: 0,
        sourceChatName: '',
        sourceMessageId: Number(messageId) || 0,
        sourceItemId: clean(sourceItemId, 500),
        sourceOriginalUrl: clean(sourceUrl, 2000),
        canonicalOrigin: canonicalPostUrl(sourceUrl) ? 'manual-linked-post' : 'manual',
    };
}

export function coalesceEventProvenance(incoming = {}, existing = {}) {
    const pick = (a, b) => clean(a) || clean(b);
    return {
        canonicalPostUrl: pick(incoming.canonicalPostUrl, existing.canonicalPostUrl),
        sourceType: pick(incoming.provenanceSourceType ?? incoming.sourceType, existing.provenanceSourceType ?? existing.sourceType),
        sourceChatId: Number(incoming.sourceChatId || existing.sourceChatId || 0),
        sourceChatName: pick(incoming.sourceChatName, existing.sourceChatName),
        sourceMessageId: Number(incoming.sourceMessageId || existing.sourceMessageId || 0),
        sourceItemId: pick(incoming.sourceItemId, existing.sourceItemId),
        sourceOriginalUrl: pick(incoming.sourceOriginalUrl, existing.sourceOriginalUrl),
        canonicalOrigin: pick(incoming.canonicalOrigin, existing.canonicalOrigin),
    };
}

function parsePosterVisionFactsForSafety(event) {
    const direct = Array.isArray(event?.posterVisionFacts) ? event.posterVisionFacts : null;
    if (direct) return direct;
    const raw = event?.posterVisionFactsJson ?? event?.poster_vision_facts_json;
    if (!raw) return [];
    try {
        const parsed = typeof raw === 'string' ? JSON.parse(raw) : raw;
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function factExplicitlyConfirmsPoster(fact) {
    if (!fact || typeof fact !== 'object') return false;
    // An explicit negative Vision decision always wins over a stale fallback
    // marker that may have been persisted by an earlier parser pass.
    if (fact.poster === false) return false;
    // eventAssets creates this marker only when the source yielded exactly one
    // event and one downloaded image. It is still an explicit, path-bound
    // ownership decision; multi-announcement posts never receive the marker.
    if (fact.fallbackBinding === 'single-event-single-image' &&
        Number(fact.sourceEventCount || 0) === 1 &&
        Number(fact.sourceImageCount || 0) === 1 &&
        String(fact.imageType || '') === 'source-image-fallback' &&
        clean(fact.imagePath, 4000)) return true;
    if (fact.poster === true) return Number(fact.posterConfidence ?? 100) >= 55;
    const text = clean(fact.text, 5000).toLowerCase().replace(/ё/gu, 'е');
    return /(?:это\s+)?афиша\s+события\s*:\s*да(?:\b|[.!;,])/iu.test(text) ||
        /это\s+афиша\s+события\s*[-—–]\s*да(?:\b|[.!;,])/iu.test(text);
}

export function eventHasPositivePosterVisionEvidence(event) {
    return parsePosterVisionFactsForSafety(event).some(factExplicitlyConfirmsPoster);
}

// One explicit owner decision binds exactly one stored image to one event.
// It does not rewrite OCR/Vision facts, apply to other events or survive a
// change in the event's title/date. A later source reparse is not an
// authorization to silently make the same decision for a different card.
function ownerConfirmedPosterForExactEvent(event, fact, selectedIndex, bindingPaths) {
    const proof = fact?.ownerConfirmedBinding;
    if (!proof || proof.decision !== 'yes' ||
        Number(event?.id || 0) !== Number(proof.eventId || 0) ||
        Number(selectedIndex) !== Number(proof.imageIndex || 0) ||
        String(event?.eventDate || '') !== String(proof.eventDate || '') ||
        String(event?.title || '').trim() !== String(proof.eventTitle || '').trim()) return false;
    const proofPath = normalizePosterBindingPath(proof.imagePath);
    return Boolean(proofPath && bindingPaths.includes(proofPath) &&
        normalizePosterBindingPath(fact.imagePath) === proofPath);
}

function normalizePosterBindingPath(value) {
    return clean(value, 4000)
        .replace(/\\+/gu, '/')
        .replace(/^\.\/+/u, '')
        .replace(/\/{2,}/gu, '/');
}

function eventPosterBindingPaths(event) {
    return [...new Set([
        ...(Array.isArray(event?.verifiedImagePaths) ? event.verifiedImagePaths : []),
        ...(Array.isArray(event?.imagePaths) ? event.imagePaths : []),
    ].map(normalizePosterBindingPath).filter(Boolean))];
}

// Some pre-V188.99 rows have a trusted status and fully path-bound Vision
// metadata, but their selected index was persisted as zero. Recover ONLY a
// unique, explicitly proven binding. Never infer from image position or status
// alone; review/no-safe rows and conflicting candidates remain text-only.
function recoverSinglePathBoundPosterIndex(event, facts, status) {
    if (status !== 'verified_single_event_source_media' && status !== 'exact_poster_match') return 0;
    const paths = eventPosterBindingPaths(event);
    if (paths.length !== 1) return 0;
    const matches = facts.filter((fact) => {
        const index = Number(fact?.index || 0);
        return Number.isSafeInteger(index) && index > 0 &&
            normalizePosterBindingPath(fact?.imagePath) === paths[0] &&
            factExplicitlyConfirmsPoster(fact) &&
            evaluatePosterFactForEvent(event, fact).accepted;
    });
    return matches.length === 1 ? Number(matches[0].index) : 0;
}

export function getEventPosterSafetyAssessment(event) {
    const status = clean(event?.posterMatchStatus).toLowerCase();
    const fallbackReason = clean(event?.posterMatchReason).toLowerCase();
    if (status === 'verified_single_event_source_media' && fallbackReason === 'single-event-single-source-image-fallback') {
        const paths = eventPosterBindingPaths(event);
        const facts = parsePosterVisionFactsForSafety(event);
        const selectedIndex = Number(event?.posterImageIndex || 0);
        const selectedFact = facts.find((fact) => Number(fact?.index || 0) === selectedIndex) || null;
        const factPath = normalizePosterBindingPath(selectedFact?.imagePath);
        const generated = /(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(factPath);
        const accepted = paths.length === 1 && selectedIndex === 1 &&
            (selectedFact?.imageType === 'source-image-fallback' || selectedFact?.sourceMediaBinding === true) &&
            selectedFact?.fallbackBinding === 'single-event-single-image' &&
            Number(selectedFact?.sourceEventCount || 0) === 1 &&
            Number(selectedFact?.sourceImageCount || 0) === 1 &&
            (selectedFact?.poster !== false || selectedFact?.sourceMediaBinding === true) &&
            Boolean(factPath) && paths.includes(factPath) && !generated;
        return {
            accepted,
            status,
            reason: accepted ? 'single-event-single-source-image-fallback' : 'invalid-single-source-image-fallback',
            metadataQuality: accepted ? scorePosterFactMetadataQuality(selectedFact) : 0,
            fact: accepted ? selectedFact : null,
            match: null,
            selectedIndex: accepted ? selectedIndex : 0,
            recoveredMissingIndex: false,
            boundPath: accepted ? factPath : '',
            ownerConfirmed: false,
        };
    }
    // The parser may not receive a Vision [IMAGE N] block on its first pass.
    // When it has exactly one event and exactly one real source image,
    // eventAssets records this narrow, non-shareable binding explicitly.
    // Multi-announcement posts never get this status.
    if (status === 'single_event_single_source_image') {
        const paths = eventPosterBindingPaths(event);
        const selectedIndex = Number(event?.posterImageIndex || 0);
        const path = paths.length === 1 ? paths[0] : '';
        const generated = /(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(path);
        if (paths.length !== 1 || selectedIndex !== 1 || generated) {
            return { accepted: false, status, reason: 'invalid-single-source-image-fallback', metadataQuality: 0, fact: null, match: null, boundPath: '' };
        }
        return {
            accepted: true,
            status,
            reason: 'single-event-single-source-image-fallback',
            metadataQuality: 0,
            fact: null,
            match: null,
            selectedIndex,
            recoveredMissingIndex: false,
            boundPath: path,
            ownerConfirmed: false,
        };
    }
    const trustedStatuses = new Set([
        'exact_poster_match',
        'verified_multi_event_poster',
        'verified_title_date_poster',
        'verified_single_event_source_media',
        'legacy_manual_poster',
    ]);
    if (!trustedStatuses.has(status)) {
        return { accepted: false, status, reason: 'untrusted-poster-status', metadataQuality: 0, fact: null, match: null };
    }

    // V188.99: public rendering requires concrete persisted metadata for the
    // selected image. Historical status alone is no longer enough. Metadata-poor
    // legacy images remain in storage and can be repaired by the explicit owner
    // backfill command, but until then they are text-only instead of risking a
    // wrong picture in the card.
    const facts = parsePosterVisionFactsForSafety(event);
    const storedIndex = Number(event?.posterImageIndex || 0);
    const recoveredIndex = storedIndex === 0
        ? recoverSinglePathBoundPosterIndex(event, facts, status)
        : 0;
    const selectedIndex = storedIndex || recoveredIndex;
    if (!Number.isInteger(selectedIndex) || selectedIndex <= 0) {
        return { accepted: false, status, reason: 'missing-selected-poster-index', metadataQuality: 0, fact: null, match: null };
    }
    const selectedFact = facts.find((fact) => Number(fact?.index || 0) === selectedIndex) || null;
    if (!selectedFact) {
        return { accepted: false, status, reason: 'missing-selected-poster-metadata', metadataQuality: 0, fact: null, match: null };
    }
    const bindingPaths = eventPosterBindingPaths(event);
    const ownerConfirmed = ownerConfirmedPosterForExactEvent(event, selectedFact, selectedIndex, bindingPaths);
    if (!ownerConfirmed && !factExplicitlyConfirmsPoster(selectedFact) && selectedFact?.sourceMediaBinding !== true) {
        return { accepted: false, status, reason: 'poster-not-confirmed-by-metadata', metadataQuality: scorePosterFactMetadataQuality(selectedFact), fact: selectedFact, match: null, boundPath: '' };
    }

    // V188.99 final guard: metadata must identify the exact file that can be
    // rendered. A matching [IMAGE N] fact is not enough if imagePaths /
    // verifiedImagePaths points to another file. Historical facts without an
    // imagePath are intentionally text-only until the explicit metadata backfill
    // enriches them. This closes the last path-level bypass.
    const factPath = normalizePosterBindingPath(selectedFact?.imagePath);
    if (!factPath) {
        return { accepted: false, status, reason: 'missing-selected-poster-path-metadata', metadataQuality: scorePosterFactMetadataQuality(selectedFact), fact: selectedFact, match: null, boundPath: '' };
    }
    if (!bindingPaths.includes(factPath)) {
        return { accepted: false, status, reason: 'selected-poster-path-mismatch', metadataQuality: scorePosterFactMetadataQuality(selectedFact), fact: selectedFact, match: null, boundPath: '' };
    }

    const match = evaluatePosterFactForEvent(event, selectedFact);
    const metadataQuality = scorePosterFactMetadataQuality(selectedFact);
    const accepted = ownerConfirmed || Boolean(match.accepted) || selectedFact?.sourceMediaBinding === true;
    return {
        accepted,
        status,
        reason: ownerConfirmed ? 'owner-confirmed-this-event-and-image' : (match.accepted ? match.reason : match.reason || 'poster-metadata-mismatch'),
        metadataQuality,
        fact: selectedFact,
        match,
        selectedIndex,
        recoveredMissingIndex: Boolean(recoveredIndex),
        boundPath: accepted ? factPath : '',
        ownerConfirmed,
    };
}

export function eventHasSafePosterMatch(event) {
    return getEventPosterSafetyAssessment(event).accepted;
}

export function formatEventProvenance(event, { compact = false } = {}) {
    const type = clean(event?.provenanceSourceType || event?.sourceType || event?.source_type).toLowerCase();
    const canonicalStored = clean(event?.canonicalPostUrl || event?.canonical_post_url);
    const canonical = canonicalStored || (type === 'vk_chat' || type === 'vk-chat' ? '' : canonicalPostUrl(event?.sourceUrl) || clean(event?.sourceUrl));
    const chatName = clean(event?.sourceChatName || event?.source_chat_name || event?.sourceName || 'Беседа', 500);
    const cmid = Number(event?.sourceMessageId || event?.source_message_id || event?.conversationMessageId || 0);
    const fromChat = type === 'vk_chat' || type === 'vk-chat';

    if (canonical) {
        if (fromChat) {
            return compact
                ? `🔗 ${canonical.replace(/^https?:\/\//iu, '')} (из беседы «${chatName}»)`
                : `Источник:\n${canonical}\nИз беседы «${chatName}», сообщение #${cmid || '?'}`;
        }
        return compact
            ? `🔗 ${canonical.replace(/^https?:\/\//iu, '')}`
            : `Источник:\n${canonical}`;
    }
    if (fromChat) {
        return compact
            ? `💬 Беседа «${chatName}», сообщение #${cmid || '?'}`
            : `Источник:\n💬 Беседа «${chatName}» — сообщение #${cmid || '?'}`;
    }
    const original = clean(event?.sourceOriginalUrl || event?.source_original_url || event?.sourceUrl);
    if (original) return compact ? `🔗 ${original.replace(/^https?:\/\//iu, '')}` : `Источник:\n${original}`;
    return compact ? 'Источник: не указан' : 'Источник:\nне указан';
}
