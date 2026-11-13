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

// Conversation labels coming from VK are often internal identifiers rather
// than names a reader can recognise. Do not leak those identifiers into a
// public event source line; a canonical post URL is sufficient provenance.
export function getMeaningfulEventChatName(event) {
    const value = clean(event?.sourceChatName || event?.source_chat_name || event?.sourceName);
    if (!value) return '';
    const normalized = value.replace(/[«»"']/gu, '').trim();
    if (/^(?:(?:vk|вк)[- ]?)?(?:беседа|чат)(?:\s*(?:№|#)?\s*\d+)?$/iu.test(normalized)) return '';
    if (/^(?:вконтакте\s+)?(?:чат|беседа)\s*(?:№|#)\s*\d+$/iu.test(normalized)) return '';
    if (/^(?:chat|conversation|peer)[: _-]?\d+$/iu.test(normalized)) return '';
    if (/^\d{5,}$/u.test(normalized)) return '';
    if (/^(?:source|unknown|unnamed|без названия|неизвестно)$/iu.test(normalized)) return '';
    return clean(normalized, 500);
}

/**
 * Select the original VK wall post from a repost chain. VK exposes the same
 * wall URL in several layers (outer repost, embedded repost, message text).
 * A conversation URL is deliberately never accepted.  In a chain the
 * innermost wall URL is the one with the deepest explicit repost marker; when
 * markers are unavailable, preserving first-seen order is deterministic.
 */
export function canonicalVkOriginFromRepostChain(values = [], text = '') {
    const candidates = [];
    const add = (value, depth = 0) => {
        const url = canonicalVkWallUrl(value);
        if (!url) return;
        const existing = candidates.find((item) => item.url === url);
        if (existing) existing.depth = Math.max(existing.depth, Number(depth) || 0);
        else candidates.push({ url, depth: Number(depth) || 0 });
    };
    const refs = Array.isArray(values) ? values : [];
    refs.forEach((value) => {
        if (value && typeof value === 'object') {
            add(value.url || value.href, value.depth || value.repostDepth || 0);
        } else {
            add(value, 0);
        }
    });
    for (const value of extractHttpUrls(text)) add(value, 0);
    return candidates.sort((a, b) => b.depth - a.depth)[0]?.url || '';
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
    const canonicalFromRepost = canonicalVkOriginFromRepostChain(repostUrls, text);
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
        // Keep the conversation URL only as provenance metadata. It must never
        // become the public/source URL when a wall post is available.
        // A private /im URL is useful only as an internal chat locator. Never
        // expose it as the event's original/public source when no wall post
        // was found; the formatter will then show a message-only provenance.
        sourceOriginalUrl: clean(canonical || canonicalVkWallUrl(sourceUrl), 2000),
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

function hasUnsafeOrContradictoryPosterFactAtPath(facts, path) {
    if (!path) return false;
    const sameFileFacts = (Array.isArray(facts) ? facts : []).filter((fact) => normalizePosterBindingPath(fact?.imagePath) === path);
    return sameFileFacts.some((fact) => {
        if (/(?:avatar|аватар|logo|логотип|album[- ]?cover|обложк)/iu.test(String(fact?.imageType || ''))) return true;
        // Vision may allow an ordinary photo for a mono event. The dangerous
        // case is a NEGATIVE fact #2 plus POSITIVE fact #1 bound to the SAME file.
        return fact?.poster === false && sameFileFacts.some((positive) => positive?.poster === true &&
            Number(positive?.index || 0) !== Number(fact?.index || 0));
    });
}
export function getEventPosterSafetyAssessment(event) {
    const status = clean(event?.posterMatchStatus).toLowerCase();
    const fallbackReason = clean(event?.posterMatchReason).toLowerCase();
    // A mono-announcement owns its source photo even when Vision cannot read
    // event metadata from it. Keep this limited to an explicit mono source
    // binding and the exact selected local image; multi-announcements still
    // require a per-event poster match.
    const monoBindingPaths = eventPosterBindingPaths(event);
    const monoSelectedIndex = Number(event?.posterImageIndex || 0);
    const bindingFacts = parsePosterVisionFactsForSafety(event);
    // Reject UI identities and conflicting index-to-file bindings, but do not
    // change the existing policy for an ordinary source photo on a mono post.
    const isExplicitlyRejectedFile = (path) => hasUnsafeOrContradictoryPosterFactAtPath(bindingFacts, path);
    const monoSelectedFact = bindingFacts.find((fact) => Number(fact?.index || 0) === monoSelectedIndex) || null;
    const isExplicitMultiAnnouncement = event?.isMultiAnnouncement === true ||
        (Object.hasOwn(event || {}, 'is_multi_announcement') && Number(event.is_multi_announcement) !== 0) ||
        bindingFacts.some((fact) => fact?.fallbackBinding === 'multi-event-shared-source-image' &&
            Number(fact?.sourceEventCount || 0) > 1);
    const explicitMonoAnnouncement = !isExplicitMultiAnnouncement && (
        event?.isMultiAnnouncement === false ||
        (Object.hasOwn(event || {}, 'is_multi_announcement') && Number(event.is_multi_announcement) === 0)
    );
    if (explicitMonoAnnouncement) {
        const factPath = normalizePosterBindingPath(monoSelectedFact?.imagePath);
        const sourcePaths = (Array.isArray(event?.imagePaths) ? event.imagePaths : [])
            .map(normalizePosterBindingPath).filter(Boolean);
        const selectedPath = factPath && monoBindingPaths.includes(factPath)
            ? factPath
            : sourcePaths[monoSelectedIndex > 0 ? monoSelectedIndex - 1 : 0] || '';
        const generated = /(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(selectedPath);
        if (selectedPath && isExplicitlyRejectedFile(selectedPath)) {
            return { accepted: false, status, reason: 'selected-file-explicitly-rejected-as-poster', metadataQuality: 0, fact: monoSelectedFact, match: null, boundPath: '' };
        }
        if (selectedPath && monoBindingPaths.includes(selectedPath) && !generated) {
            const ownerConfirmed = ownerConfirmedPosterForExactEvent(event, monoSelectedFact, monoSelectedIndex || Math.max(1, sourcePaths.indexOf(selectedPath) + 1), monoBindingPaths);
            const ownerApprovalDoesNotMatch = monoSelectedFact?.ownerConfirmedBinding?.decision === 'yes' && !ownerConfirmed;
            // An owner approval belongs to this exact event identity. A stale
            // approval must not fall through to the generic mono-image path.
            if (!ownerApprovalDoesNotMatch) {
                return {
                    accepted: true, status, reason: 'mono-announcement-source-image',
                    metadataQuality: scorePosterFactMetadataQuality(monoSelectedFact), fact: monoSelectedFact,
                    match: null, selectedIndex: monoSelectedIndex || Math.max(1, sourcePaths.indexOf(selectedPath) + 1),
                    recoveredMissingIndex: false, boundPath: selectedPath, ownerConfirmed,
                };
            }
        }
    }
    // QTickets detail pages expose one authoritative poster URL and do not
    // pass through the VK/Telegram Vision block contract. Keep this fallback
    // deliberately narrow: one detail image, one selected index, no generated
    // path. The renderer still checks that the file exists and has poster-sized
    // dimensions before sending it.
    if (String(event?.sourceType ?? event?.provenanceSourceType ?? '').trim().toLowerCase() === 'qtickets' &&
        status === 'legacy_manual_poster') {
        const paths = eventPosterBindingPaths(event);
        const selectedIndex = Number(event?.posterImageIndex || 0);
        const path = paths.length === 1 ? paths[0] : '';
        const generated = /(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(path);
        const accepted = paths.length === 1 && selectedIndex === 1 && Boolean(path) && !generated;
        return {
            accepted,
            status,
            reason: accepted ? 'qtickets-detail-image' : 'invalid-qtickets-detail-image',
            metadataQuality: accepted ? 100 : 0,
            fact: null,
            match: null,
            selectedIndex: accepted ? selectedIndex : 0,
            recoveredMissingIndex: false,
            boundPath: accepted ? path : '',
            ownerConfirmed: false,
        };
    }
    if (status === 'shared_multi_event_source_image' && fallbackReason === 'multi-event-shared-source-image') {
        const paths = eventPosterBindingPaths(event);
        const facts = parsePosterVisionFactsForSafety(event);
        const selectedIndex = Number(event?.posterImageIndex || 0);
        const selectedFact = facts.find((fact) => Number(fact?.index || 0) === selectedIndex) || null;
        const factPath = normalizePosterBindingPath(selectedFact?.imagePath);
        const generated = /(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(factPath);
        const accepted = Boolean(
            Boolean(event?.isMultiAnnouncement ?? event?.is_multi_announcement) &&
            paths.length === 1 && selectedIndex > 0 &&
            selectedFact?.fallbackBinding === 'multi-event-shared-source-image' &&
            selectedFact?.sourceMediaBinding === true &&
            Number(selectedFact?.sourceEventCount || 0) > 1 &&
            Number(selectedFact?.sourceImageCount || 0) === 1 &&
            factPath && paths[0] === factPath && !generated
        );
        return {
            accepted,
            status,
            reason: accepted ? 'multi-event-shared-source-image' : 'invalid-multi-event-shared-source-image',
            metadataQuality: 0,
            fact: accepted ? selectedFact : null,
            match: null,
            selectedIndex: accepted ? selectedIndex : 0,
            recoveredMissingIndex: false,
            boundPath: accepted ? factPath : '',
            ownerConfirmed: false,
        };
    }
    if (status === 'verified_single_event_source_media' && (
        fallbackReason === 'single-event-single-source-image-fallback' ||
        fallbackReason === 'single-event-source-media-fallback'
    )) {
        const paths = eventPosterBindingPaths(event);
        const facts = parsePosterVisionFactsForSafety(event);
        const selectedIndex = Number(event?.posterImageIndex || 0);
        const selectedFact = facts.find((fact) => Number(fact?.index || 0) === selectedIndex) || null;
        const factPath = normalizePosterBindingPath(selectedFact?.imagePath);
        const generated = /(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(factPath);
        const fallbackBinding = String(selectedFact?.fallbackBinding || '').trim();
        const accepted = (fallbackBinding === 'single-event-source-media' ? paths.length > 0 : paths.length === 1) && selectedIndex > 0 &&
            (selectedFact?.imageType === 'source-image-fallback' || selectedFact?.sourceMediaBinding === true) &&
            (selectedFact?.fallbackBinding === 'single-event-single-image' || selectedFact?.fallbackBinding === 'single-event-source-media') &&
            Number(selectedFact?.sourceEventCount || 0) === 1 &&
            Number(selectedFact?.sourceImageCount || 0) >= 1 &&
            selectedFact?.poster !== false &&
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
    // A singleton source-media binding keeps the original file available for
    // audit/delivery, but it is never proof that the file is a poster. An
    // explicit Vision negative must therefore remain negative here.
    if (selectedFact?.poster === false) {
        return { accepted: false, status, reason: 'vision-explicitly-not-poster', metadataQuality: scorePosterFactMetadataQuality(selectedFact), fact: selectedFact, match: null, boundPath: '' };
    }
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
    if (isExplicitlyRejectedFile(factPath)) {
        return { accepted: false, status, reason: 'selected-file-explicitly-rejected-as-poster', metadataQuality: scorePosterFactMetadataQuality(selectedFact), fact: selectedFact, match: null, boundPath: '' };
    }
    if (!bindingPaths.includes(factPath)) {
        return { accepted: false, status, reason: 'selected-poster-path-mismatch', metadataQuality: scorePosterFactMetadataQuality(selectedFact), fact: selectedFact, match: null, boundPath: '' };
    }

    const match = evaluatePosterFactForEvent(event, selectedFact);
    const metadataQuality = scorePosterFactMetadataQuality(selectedFact);
    const sourceImageCount = Number(selectedFact?.sourceImageCount || 0);
    const inspected = selectedFact?.visionInspected === true || Boolean(selectedFact?.visionStatus && selectedFact.visionStatus !== 'not_run');
    const sourceMediaFallback = selectedFact?.sourceMediaBinding === true &&
        Number(selectedFact?.sourceEventCount || 0) === 1 &&
        sourceImageCount === 1 &&
        (!inspected || factExplicitlyConfirmsPoster(selectedFact));
    // A source-media binding proves that the file came from the post; it does
    // not prove that a gallery photo is an event poster. Multi-image galleries
    // need an explicit positive Vision match before any image can be shown.
    const accepted = selectedFact?.poster !== false && (ownerConfirmed || Boolean(match.accepted) || sourceMediaFallback);
    return {
        accepted,
        status,
        reason: ownerConfirmed ? 'owner-confirmed-this-event-and-image' : (match.accepted ? match.reason : sourceMediaFallback ? 'single-event-single-source-image-fallback' : match.reason || 'poster-metadata-mismatch'),
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

export function getEventSourceMediaBindingAssessment(event) {
    if (Boolean(event?.isMultiAnnouncement ?? event?.is_multi_announcement)) {
        return { accepted: false, paths: [], reason: 'multi-announcement-needs-image-match' };
    }
    const facts = parsePosterVisionFactsForSafety(event);
    const paths = eventPosterBindingPaths(event).filter((path) =>
        !/(?:^|\/)event_message_cards\/|(?:^|\/)event_generated_fallbacks\/|-event-\d+\.png$/iu.test(path));
    const selectedIndex = Number(event?.posterImageIndex ?? event?.poster_image_index ?? 0);
    const status = clean(event?.posterMatchStatus).toLowerCase();
    const reason = clean(event?.posterMatchReason).toLowerCase();
    // A targeted owner verification can be persisted without Vision facts when
    // the source attachment was independently matched to this single event.
    // Keep this narrow: one real path, selected index 1, and an explicit
    // owner/source-photo reason are required.
    const ownerVerifiedSourceBinding = status === 'verified_single_event_source_media' &&
        /owner[- ](?:verified|confirmed)/iu.test(reason) &&
        selectedIndex === 1 && paths.length === 1;
    if (ownerVerifiedSourceBinding) {
        return { accepted: true, paths, boundPath: paths[0], fact: null,
            reason: 'owner-verified-source-media-binding' };
    }
    const fallbackFacts = facts.filter((item) =>
        ['single-event-single-image', 'single-event-source-media'].includes(item?.fallbackBinding) &&
        item?.sourceMediaBinding === true && Number(item?.sourceEventCount || 0) === 1);
    const fact = fallbackFacts.find((item) =>
        selectedIndex > 0 && Number(item?.index || 0) === selectedIndex &&
        paths.includes(normalizePosterBindingPath(item?.imagePath))) ||
        fallbackFacts.find((item) => paths.includes(normalizePosterBindingPath(item?.imagePath))) ||
        fallbackFacts.find((item) => selectedIndex > 0 && Number(item?.index || 0) === selectedIndex) ||
        fallbackFacts[0] || null;
    const boundPath = normalizePosterBindingPath(fact?.imagePath);
    const explicitlyRejected = hasUnsafeOrContradictoryPosterFactAtPath(facts, boundPath);
    const accepted = Boolean(!explicitlyRejected && fact && boundPath && paths.includes(boundPath) && paths.length > 0 &&
        Number(fact.sourceImageCount || 0) >= paths.length);
    return { accepted, paths: accepted ? paths : [], boundPath: accepted ? boundPath : '', fact,
        reason: accepted ? 'single-event-source-media-binding' : 'no-single-event-source-media-binding' };
}

export function formatEventProvenance(event, { compact = false } = {}) {
    const type = clean(event?.provenanceSourceType || event?.sourceType || event?.source_type).toLowerCase();
    const canonicalStored = canonicalPostUrl(event?.canonicalPostUrl || event?.canonical_post_url);
    const canonical = canonicalStored || (type === 'vk_chat' || type === 'vk-chat' ? '' : canonicalPostUrl(event?.sourceUrl) || clean(event?.sourceUrl));
    const chatName = getMeaningfulEventChatName(event);
    const cmid = Number(event?.sourceMessageId || event?.source_message_id || event?.conversationMessageId || 0);
    const fromChat = type === 'vk_chat' || type === 'vk-chat';

    if (canonical) {
        if (fromChat) {
            if (!chatName) return compact ? `🔗 ${canonical}` : `Источник:\n${canonical}`;
            return compact
                ? `🔗 ${canonical} (из беседы «${chatName}»)`
                : `Источник:\n${canonical}\nИз беседы «${chatName}», сообщение #${cmid || '?'}`;
        }
        return compact
            ? `🔗 ${canonical}`
            : `Источник:\n${canonical}`;
    }
    if (fromChat) {
        if (!chatName) {
            return compact
                ? (cmid ? `💬 Сообщение #${cmid}` : 'Источник: не указан')
                : `Источник:\n${cmid ? `💬 Сообщение #${cmid}` : 'не указан'}`;
        }
        return compact
            ? `💬 Беседа «${chatName}», сообщение #${cmid || '?'}`
            : `Источник:\n💬 Беседа «${chatName}» — сообщение #${cmid || '?'}`;
    }
    const original = clean(event?.sourceOriginalUrl || event?.source_original_url || event?.sourceUrl);
    if (original) return compact ? `🔗 ${original}` : `Источник:\n${original}`;
    return compact ? 'Источник: не указан' : 'Источник:\nне указан';
}
