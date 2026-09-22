/**
 * Ручной скрейпер VK-бесед. Не открывает беседы сам при старте; вкладку запускает явная команда владельца.
 */
import { createHash } from 'node:crypto';

import {
    finalizeManualParserSeenItem,
    getManualParserSeenItem,
    isManualParserSeenItemFinalStatus,
    markManualParserSeenItemFailed,
    markManualParserSeenItemProcessing,
    upsertManualParserSeenItem,
    getVkChatMessageMeta,
    getVkChatScraperState,
    getVkChatUpcomingEvents,
    persistVkChatSourceAndEvents,
    updateVkChatScraperState,
} from '../../infrastructure/database/index.js';

import {
    openScraperPage,
    settleScraperPage,
} from '../../infrastructure/browser/browserGrabber.js';

import {
    prepareEventImages,
    assignEventImageIndexesFromFacts,
    applyPosterDerivedVenueFallback,
    parseIndexedImageFacts,
    filterEventsWithAnnouncementImages,
} from '../../features/events/eventAssets.js';

import {
    cleanVkEventText,
    paragraphizeEventText,
} from '../../features/events/eventText.js';

import {
    filterVkChatPublicMessageLinks,
    selectVkChatPublicSourceUrl,
} from './vkChatEventSource.js';

import {
    resolveVkChatProvenance,
} from '../../features/events/eventProvenance.js';

import {
    explainStrictEventRecord,
} from '../../features/events/eventValidation.js';

import {
    isCalendarIsoDate,
    isEventDateConsistentWithSource,
} from '../../features/events/publicPostDateEvidence.js';

import {
    appendEventIngestAudit,
} from '../../features/events/eventIngestAudit.js';

import {
    shouldPreserveStoredEventsOnEmptyReparse,
} from '../../features/events/sourceEventPersistence.js';

import {
    explainVkChatEventCandidate,
    hasVkChatRepostEvidence,
    looksLikeVkChatEventCandidate,
} from '../../features/events/eventCandidateRouting.js';

import {
    getManualParserProcessingConcurrency,
    parserCandidatePreview,
    runManualParserPoolUntilSettled,
} from '../../features/scrapers/manualProcessingPool.js';

import {
    captureVkChatObservation,
    assertVkChatSessionActive,
    assertResolvedVkChatAiResult,
    mergeVkChatSnapshotMedia,
    vkChatSourceMediaFingerprint,
    stableVkChatMessageId,
} from './vkChatIngestSafety.js';

const VK_CHAT_PARSER_VERSION = 'vk-chat-diagnostic-priority-v18838';
const ONE_HOUR_MS = 60 * 60 * 1000;
const DEFAULT_LIVE_POLL_MS = 500;
const DEFAULT_POST_SCAN_HOLD_MS = 180_000;
const DEFAULT_SCROLL_BATCH_MESSAGES = 10;
const DEFAULT_SCROLL_BATCH_DELAY_MS = 1200;
const MIN_HISTORY_BACKFILL_MESSAGES = 50;
const HISTORY_BACKFILL_SCROLL_DELAY_MS = 1800;
const HISTORY_BACKFILL_INITIAL_CAPTURE_GRACE_MS = 15_000;
const CONVERSATION_READY_TIMEOUT_MS = 30_000;
const MAX_LIVE_FINGERPRINTS = 20_000;
const activeRuns = new Map();

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function formatErrorText(error) {
    if (typeof error === 'string') {
        return error;
    }

    const parts = [];
    const add = (value) => {
        if (value == null) return;
        if (typeof value === 'string' && value.trim()) {
            parts.push(value.trim());
            return;
        }
        if (typeof value === 'number' || typeof value === 'boolean') {
            parts.push(String(value));
            return;
        }
        try {
            const serialized = JSON.stringify(value);
            if (serialized && serialized !== '{}' && serialized !== '[]') {
                parts.push(serialized);
            }
        } catch {
            // Нечитаемое циклическое поле пропускаем.
        }
    };

    add(error?.message);
    add(error?.code);
    add(error?.cause?.message ?? error?.cause);
    add(error?.response?.status ?? error?.status ?? error?.statusCode);
    add(error?.response?.data);

    if (!parts.length) {
        add(error);
    }

    return parts.join(' | ') || 'Неизвестная ошибка';
}

function clampInteger(value, minimum, maximum, fallback) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function currentIsoDate(timeZone) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(new Date());
    const map = Object.fromEntries(
        parts.map((part) => [part.type, part.value]),
    );
    return `${map.year}-${map.month}-${map.day}`;
}

function normalizeConversationUrl(value) {
    const source = String(value ?? '').trim();
    const stable = source.match(
        /^(?:https?:\/\/)?(?:www\.)?vk\.(?:ru|com)\/im\?(?:[^#\s]*&)?sel=c(\d+)(?:&[^#\s]*)?$/iu,
    );
    const legacy = source.match(
        /^(?:https?:\/\/)?(?:www\.)?vk\.(?:ru|com)\/im\/convo\/(\d+)\/?(?:\?.*)?$/iu,
    );

    const rawNumber = Number(stable?.[1] ?? legacy?.[1] ?? 0);
    const chatId = stable
        ? rawNumber
        : rawNumber >= 2_000_000_000
            ? rawNumber - 2_000_000_000
            : rawNumber;

    if (!Number.isSafeInteger(chatId) || chatId <= 0) {
        throw new Error(`Некорректная ссылка VK-беседы: ${source}`);
    }

    return {
        peerId: 2_000_000_000 + chatId,
        chatId,
        url: `https://vk.ru/im?sel=c${chatId}`,
    };
}

function uniqueStrings(values, maximum = 100) {
    const result = [];

    for (const value of Array.isArray(values) ? values : []) {
        const item = String(value ?? '').trim();

        if (item && !result.includes(item) && result.length < maximum) {
            result.push(item);
        }
    }

    return result;
}

function trimText(value, maximum = 12_000) {
    return String(value ?? '')
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n[ \t]+/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim()
        .slice(0, maximum);
}

export { looksLikeVkChatEventCandidate };

function hashMessage(message) {
    return createHash('sha256')
        .update(JSON.stringify({
            parserVersion: VK_CHAT_PARSER_VERSION,
            text: message.text,
            links: message.links,
            repostUrls: message.repostUrls,
            attachmentLinks: message.attachmentLinks,
            canonicalPostUrl: message.provenance?.canonicalPostUrl || '',
            canonicalOrigin: message.provenance?.canonicalOrigin || '',
            // Stable media identity changes on a new attachment or layer;
            // signed URL variants of a proven VK photo do not force re-inference.
            mediaIdentity: vkChatSourceMediaFingerprint(message),
            createdAt: message.createdAt,
        }))
        .digest('hex');
}

function syntheticMessageId(message) {
    const digest = createHash('sha256')
        .update([
            message.identityHint,
            message.createdAt,
            message.senderId,
            message.text,
        ].join('|'))
        .digest('hex')
        .slice(0, 12);
    return Number.parseInt(digest, 16);
}

function normalizeBrowserMessage(raw, conversationUrl) {
    // A message is normalized once at capture and again before processing.
    // Keep body and embedded post separate across both stages.
    const primaryText = cleanVkEventText(raw?.contentText ?? raw?.text, 12_000);
    const embeddedText = cleanVkEventText(raw?.embeddedText ?? raw?.repostText, 10_000);
    const text = [
        primaryText,
        embeddedText && !primaryText.includes(embeddedText)
            ? `[Репост/вложенный пост VK]\n${embeddedText}`
            : '',
    ].filter(Boolean).join('\n\n').slice(0, 12_000);
    const createdAt = Number(raw?.createdAt ?? 0);
    const senderId = Number(raw?.senderId ?? 0);
    const identityHint = trimText(raw?.identityHint, 500);
    const rawMessageId = Number(raw?.conversationMessageId ?? 0);
    const hasUsableMessageId = Number.isSafeInteger(rawMessageId) && rawMessageId > 0;
    const hasStableConversationMessageId = hasUsableMessageId && raw?.hasStableConversationMessageId !== false;
    const conversationMessageId = hasUsableMessageId
        ? rawMessageId
        : syntheticMessageId({ text, createdAt, senderId, identityHint });
    const links = filterVkChatPublicMessageLinks(
        uniqueStrings(raw?.links),
    );
    const rawRepostUrls = uniqueStrings(raw?.repostUrls);
    const inferredRepostUrls = embeddedText
        ? links.filter((value) => /(?:[?&]w=|\/)wall-?\d+_\d+/iu.test(String(value)))
        : [];
    const repostUrls = uniqueStrings([...rawRepostUrls, ...inferredRepostUrls]);
    const attachmentLinks = uniqueStrings([
        ...(Array.isArray(raw?.attachmentLinks) ? raw.attachmentLinks : []),
        ...links.filter((value) => !repostUrls.includes(value)),
    ]);
    const provenance = resolveVkChatProvenance({
        conversationUrl,
        text,
        repostUrls,
        attachmentLinks,
        links,
    });

    return {
        conversationMessageId,
        hasStableConversationMessageId,
        senderId,
        createdAt,
        // Keep structural fields in the cache. `text` is the combined event
        // evidence for backward compatibility; contentText/repostText let the
        // candidate gate and diagnostics distinguish real body text from a
        // forwarded/wall attachment without ever relying on UI metadata.
        contentText: primaryText,
        repostText: embeddedText,
        embeddedText,
        hasRepostEvidence: Boolean(embeddedText) || hasVkChatRepostEvidence({
            text,
            links: raw?.links,
        }),
        text,
        links,
        repostUrls,
        attachmentLinks,
        provenance,
        imageUrls: uniqueStrings(raw?.imageUrls, Math.max(100, raw?.imageUrls?.length || 0)),
        imageMedia: (Array.isArray(raw?.imageMedia) ? raw.imageMedia : [])
            .map((item) => ({
                url: String(item?.url || '').trim(),
                origin: ['repost-wall', 'outer-message', 'attachment'].includes(String(item?.origin || '').trim())
                    ? String(item.origin).trim()
                    : 'attachment',
                repostDepth: Math.max(0, Number.parseInt(item?.repostDepth, 10) || 0),
                width: Math.max(0, Number(item?.width) || 0),
                height: Math.max(0, Number(item?.height) || 0),
                attachmentKey: String(item?.attachmentKey || '').trim().toLowerCase(),
                mediaHint: String(item?.mediaHint || '').trim(),
                domContext: item?.domContext && typeof item.domContext === 'object' ? item.domContext : {},
            }))
            .filter((item) => item.url && uniqueStrings(raw?.imageUrls, Math.max(100, raw?.imageUrls?.length || 0)).includes(item.url)),
        domAudit: raw?.domAudit && typeof raw.domAudit === 'object' ? raw.domAudit : {},
        parserPass: trimText(raw?.parserPass, 80),
        // Internal poster-gate evidence survives processing-stage normalization.
        __posterGateVisionAttempted: raw?.__posterGateVisionAttempted === true,
        __posterGateFacts: String(raw?.__posterGateFacts ?? ''),
        __posterGateError: String(raw?.__posterGateError ?? ''),
        /*
         * Ссылка на саму беседу персональна и не является источником события.
         * Публикуем только первую обычную ссылку из исходного сообщения.
         */
        sourceUrl: provenance.canonicalPostUrl || selectVkChatPublicSourceUrl(links, text),
    };
}

async function extractRenderedMessages(page, conversationUrl, { snapshotHtml = '' } = {}) {
    if (!page || page.isClosed()) {
        throw new Error('VK chat: вкладка беседы закрыта.');
    }

    const expectedPeerId = normalizeConversationUrl(conversationUrl).peerId;
    const extraction = await page.evaluate(({ targetPeerId, immutableSnapshotHtml, baseUrl }) => {
        const snapshotMode = Boolean(String(immutableSnapshotHtml || '').trim());
        const rootDocument = snapshotMode
            ? new DOMParser().parseFromString(String(immutableSnapshotHtml), 'text/html')
            : document;
        const baseOrigin = (() => { try { return new URL(baseUrl).origin; } catch { return 'https://vk.ru'; } })();
        const layoutRect = (node, fallbackHeight = 72) => snapshotMode
            ? { width: 900, height: fallbackHeight, left: 120, right: 1020, top: 0, bottom: fallbackHeight }
            : (node?.getBoundingClientRect?.() || { width: 0, height: 0, left: 0, right: 0, top: 0, bottom: 0 });
        const PASS_EXACT = 'pass1-exact';
        const PASS_ADAPTIVE = 'pass2-adaptive';
        const PASS_HEURISTIC = 'pass3-heuristic';

        function uniqueNodes(values) {
            return [...new Set((Array.isArray(values) ? values : []).filter(Boolean))];
        }

        function numberFrom(value) {
            const source = String(value ?? '').trim();
            if (!source) return 0;
            const exact = source.match(/^-?\d{1,16}$/u);
            if (exact) {
                const number = Number(exact[0]);
                return Number.isSafeInteger(number) ? number : 0;
            }
            const match = source.match(/(?:^|[^\d])(-?\d{1,16})(?:$|[^\d])/u);
            if (!match) return 0;
            const number = Number(match[1]);
            return Number.isSafeInteger(number) ? number : 0;
        }

        function addUrl(list, value) {
            let url = String(value ?? '').trim();
            if (!url) return '';
            if (url.startsWith('//')) url = `https:${url}`;
            if (url.startsWith('/')) url = `${baseOrigin}${url}`;
            if (/^https?:\/\//iu.test(url) && !list.includes(url)) list.push(url);
            return /^https?:\/\//iu.test(url) ? url : '';
        }

        function cleanRenderedText(value) {
            const source = String(value || '')
                .replace(/\r\n?/gu, '\n')
                .replace(/\u00a0/gu, ' ')
                .replace(/\s+показать\s+(?:ещ[её]|полностью)(?:\s+\d+)?\s+отправить\s+реакцию[\s\S]*$/iu, '')
                .replace(/\s+отправить\s+реакцию\s+[«"']?лайк[»"']?[\s\S]*$/iu, '');
            const uiLine = /^(?:показать\s+(?:ещ[её]|полностью)(?:\s+\d+)?|отправить\s+реакцию(?:\s+.+)?|выбор\s+реакции(?:\s+\d+)?|нравится(?:\s+\d+)?|комментировать|поделиться|ответить|изменить|удалить|ещ[её]|открыть\s+меню|(?:следующий|предыдущий)\s+слайд(?:\s+\d+\s+из\s+\d+)?|\d{1,3}\s*\/\s*\d{1,3}|\d+\s*(?:с|сек|мин|ч|д|нед|мес|г)\.?\s+назад)$/iu;

            return source
                .split('\n')
                .map((line) => line.replace(/[ \t]{2,}/gu, ' ').trim())
                .filter((line) => line && !uiLine.test(line))
                .join('\n')
                .replace(/\n{3,}/gu, '\n\n')
                .trim();
        }

        function isProfileHref(value) {
            try {
                const url = new URL(String(value || ''), baseOrigin);
                if (!/^(?:www\.)?vk\.(?:ru|com)$/iu.test(url.hostname)) return false;
                if (/^\/(?:im|wall|video|clip|photo|audio|market|join|away|feed|friends|groups|search)(?:\/|$|\?)/iu.test(url.pathname)) {
                    return false;
                }
                return /^\/[a-z0-9_.-]{2,}$/iu.test(url.pathname);
            } catch {
                return false;
            }
        }

        function readNumericProfileId(value) {
            try {
                const url = new URL(String(value || ''), baseOrigin);
                const user = url.pathname.match(/^\/id(\d+)\/?$/iu);
                if (user) return Number(user[1]);
                const community = url.pathname.match(/^\/(?:club|public)(\d+)\/?$/iu);
                if (community) return -Number(community[1]);
            } catch {
                // Screen names are intentionally not interpreted as numeric ids.
            }
            return 0;
        }

        function readMainAuthorAnchor(node) {
            const exact = node.querySelector?.(
                '.ConvoMessageHeader__authorLink, [class*="MessageHeader"][class*="author"] a[href], [class*="MessageHeader"] a[href]',
            );
            if (exact && isProfileHref(exact.href || exact.getAttribute?.('href'))) return exact;

            for (const anchor of node.querySelectorAll?.('a[href]') || []) {
                const href = anchor.href || anchor.getAttribute?.('href') || '';
                const marker = [
                    String(anchor.className || ''),
                    anchor.getAttribute?.('data-testid') || '',
                    anchor.getAttribute?.('aria-label') || '',
                ].join(' ').toLowerCase();
                if (/wall|repost|attach|forward|reply|quote|mention/iu.test(marker)) continue;
                if (isProfileHref(href)) return anchor;
            }
            return null;
        }

        function readIdFromNodeAndAncestors(node) {
            let current = node;
            for (let depth = 0; current && depth < 9; depth += 1, current = current.parentElement) {
                const attributes = [
                    current.dataset?.itemkey,
                    current.dataset?.itemKey,
                    current.dataset?.cmid,
                    current.dataset?.messageId,
                    current.dataset?.msgid,
                    current.getAttribute?.('data-itemkey'),
                    current.getAttribute?.('data-item-key'),
                    current.getAttribute?.('data-cmid'),
                    current.getAttribute?.('data-message-id'),
                    current.getAttribute?.('data-msgid'),
                ];
                for (const value of attributes) {
                    const number = numberFrom(value);
                    if (number > 0) return number;
                }

                const id = String(current.id || '');
                if (/^(?:msg|im_msg|message)[^\d]*\d+/iu.test(id)) {
                    const number = numberFrom(id);
                    if (number > 0) return number;
                }
            }
            return 0;
        }

        function readSenderIdFromDom(node) {
            let current = node;
            for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
                for (const value of [
                    current.dataset?.fromId,
                    current.dataset?.senderId,
                    current.dataset?.authorId,
                    current.getAttribute?.('data-from-id'),
                    current.getAttribute?.('data-sender-id'),
                    current.getAttribute?.('data-author-id'),
                ]) {
                    const number = Number(value);
                    if (Number.isSafeInteger(number) && number !== 0) return number;
                }
            }

            const author = readMainAuthorAnchor(node);
            const hrefNumber = readNumericProfileId(author?.getAttribute?.('href'));
            if (hrefNumber !== 0) return hrefNumber;

            // Current VK messenger stores the actual sender id in the avatar mask
            // even when the visible profile URL is a screen name (e.g. /nick_more).
            for (const carrier of node.querySelectorAll?.(
                '[style*="Mask"], [style*="mask"], [clip-path], [id*="Mask"], [id*="mask"]',
            ) || []) {
                const marker = [
                    carrier.getAttribute?.('style') || '',
                    carrier.getAttribute?.('clip-path') || '',
                    carrier.id || '',
                ].join(' ');
                const match = marker.match(/(?:PeerFrame|Mask|mask)[^\d-]*(-?\d{3,16})/u);
                const number = Number(match?.[1] ?? 0);
                if (Number.isSafeInteger(number) && number !== 0) return number;
            }

            return 0;
        }

        function readTimestampFromDom(node) {
            const time = node.querySelector?.('time[datetime], time');
            const datetime = time?.getAttribute?.('datetime') || time?.getAttribute?.('title') || '';
            const parsed = Date.parse(datetime);
            if (Number.isFinite(parsed)) return Math.floor(parsed / 1000);

            let current = node;
            for (let depth = 0; current && depth < 5; depth += 1, current = current.parentElement) {
                for (const value of [
                    current.dataset?.date,
                    current.dataset?.ts,
                    current.dataset?.timestamp,
                    current.getAttribute?.('data-date'),
                    current.getAttribute?.('data-ts'),
                    current.getAttribute?.('data-timestamp'),
                ]) {
                    const number = Number(value);
                    if (Number.isFinite(number) && number > 1_000_000_000) {
                        return number > 10_000_000_000
                            ? Math.floor(number / 1000)
                            : Math.floor(number);
                    }
                }
            }
            return 0;
        }

        function collectReactMetadata(root) {
            const result = {
                conversationMessageId: 0,
                peerId: 0,
                senderId: 0,
                createdAt: 0,
                text: '',
            };
            const queue = [];
            const seen = new Set();
            const seedNodes = [root, root?.parentElement, root?.firstElementChild].filter(Boolean);

            for (const seed of seedNodes) {
                let names = [];
                try {
                    names = Object.getOwnPropertyNames(seed);
                } catch {
                    names = [];
                }
                for (const name of names) {
                    if (!/^__react(?:Fiber|Props|Container|Internal)/iu.test(name)) continue;
                    try {
                        const value = seed[name];
                        if (value && (typeof value === 'object' || typeof value === 'function')) {
                            queue.push({ value, depth: 0 });
                        }
                    } catch {
                        // React internals are opportunistic evidence only.
                    }
                }
            }

            let visited = 0;
            while (queue.length && visited < 420) {
                const { value, depth } = queue.shift();
                if (!value || (typeof value !== 'object' && typeof value !== 'function')) continue;
                if (seen.has(value)) continue;
                seen.add(value);
                visited += 1;

                let keys = [];
                try {
                    keys = Object.keys(value).slice(0, 80);
                } catch {
                    continue;
                }

                for (const key of keys) {
                    let child;
                    try {
                        child = value[key];
                    } catch {
                        continue;
                    }
                    const normalizedKey = String(key).replace(/[-_]/gu, '').toLowerCase();

                    if (!result.conversationMessageId && /^(?:conversationmessageid|cmid)$/u.test(normalizedKey)) {
                        const number = Number(child);
                        if (Number.isSafeInteger(number) && number > 0) result.conversationMessageId = number;
                    }
                    if (!result.peerId && /^(?:peerid|conversationpeerid)$/u.test(normalizedKey)) {
                        const number = Number(child);
                        if (Number.isSafeInteger(number) && number !== 0) result.peerId = number;
                    }
                    if (!result.senderId && /^(?:fromid|senderid|authorid)$/u.test(normalizedKey)) {
                        const number = Number(child);
                        if (Number.isSafeInteger(number) && number !== 0) result.senderId = number;
                    }
                    if (!result.createdAt && /^(?:date|timestamp|createdat)$/u.test(normalizedKey)) {
                        const number = Number(child);
                        if (Number.isFinite(number) && number > 1_000_000_000) {
                            result.createdAt = number > 10_000_000_000
                                ? Math.floor(number / 1000)
                                : Math.floor(number);
                        }
                    }
                    if (!result.text && /^(?:text|message)$/u.test(normalizedKey) && typeof child === 'string') {
                        const text = cleanRenderedText(child);
                        if (text.length >= 2 && text.length <= 12_000) result.text = text;
                    }

                    if (
                        depth < 5 &&
                        child &&
                        (typeof child === 'object' || typeof child === 'function') &&
                        !seen.has(child)
                    ) {
                        queue.push({ value: child, depth: depth + 1 });
                    }
                }

                if (result.conversationMessageId && result.peerId && result.senderId && result.createdAt && result.text) break;
            }

            return result;
        }

        function contentNodeMarker(node) {
            return [
                String(node?.className || ''),
                node?.getAttribute?.('id') || '',
                node?.getAttribute?.('data-testid') || '',
                node?.getAttribute?.('alt') || '',
                node?.getAttribute?.('aria-label') || '',
                node?.getAttribute?.('role') || '',
            ].join(' ').toLowerCase();
        }

        function contentMediaContext(node, root) {
            let current = node;
            let depth = 0;
            while (current && current !== root?.parentElement && depth < 7) {
                const marker = contentNodeMarker(current);
                if (/avatar|profile|emoji|reaction|sticker|icon|badge|logo|favicon|smile|userpic/iu.test(marker)) {
                    return { ui: true, media: false };
                }
                if (/photo|media|image|attachment|poster|gallery|picture|attachwall|repost/iu.test(marker)) {
                    return { ui: false, media: true };
                }
                current = current.parentElement;
                depth += 1;
            }
            return { ui: false, media: false };
        }

        function hasPhotoLink(node) {
            const anchor = node?.closest?.('a[href]');
            const href = String(anchor?.href || anchor?.getAttribute?.('href') || '');
            return /(?:\bphoto-?\d+_\d+|[?&]z=photo-?\d+_\d+)/iu.test(href);
        }

        function isAnnouncementSized(width, height, explicitMedia = false) {
            const w = Number(width) || 0;
            const h = Number(height) || 0;
            // Generic images smaller than 300x300 are UI/noise by default.
            // Explicit VK attachment/photo containers may be rendered smaller,
            // so their natural/rendered size gets a looser admission threshold.
            if (w >= 300 && h >= 300) return true;
            return explicitMedia && ((!w || !h) || (Math.max(w, h) >= 48 && Math.min(w, h) >= 48));
        }

        function mediaProvenance(node, root) {
            let current = node;
            let depth = 0;
            let repostDepth = 0;
            while (current && current !== root?.parentElement && depth < 12) {
                const marker = contentNodeMarker(current);
                const nesting = Number(current.getAttribute?.('data-post-nesting-lvl') || 0);
                if (Number.isFinite(nesting) && nesting > repostDepth) repostDepth = nesting;
                if (/attachwall|repost|forward|fwd|wallpost|wall_post|copy_history/iu.test(marker)) repostDepth = Math.max(repostDepth, 1);
                current = current.parentElement;
                depth += 1;
            }
            return { origin: repostDepth > 0 ? 'repost-wall' : 'outer-message', repostDepth };
        }

        function imageDomContext(node, root) {
            if (!node) return {};
            const anchor = node.closest?.('a[href]') || null;
            const readAttributes = (element) => {
                const attributes = {};
                for (const attribute of Array.from(element?.attributes || [])) {
                    const name = String(attribute?.name || '').trim();
                    if (!name) continue;
                    attributes[name] = String(attribute?.value || '');
                }
                return attributes;
            };
            const path = [];
            const ancestorChain = [];
            let current = node;
            for (let depth = 0; current && depth < 10; depth += 1, current = current.parentElement) {
                const tag = String(current.tagName || '').toLowerCase();
                const id = String(current.id || current.getAttribute?.('id') || '').trim();
                const testId = String(current.getAttribute?.('data-testid') || '').trim();
                const classes = String(current.className || '').trim().split(/\s+/u).filter(Boolean).slice(0, 24);
                const selector = `${tag}${id ? `#${id}` : ''}${classes.length ? `.${classes.join('.')}` : ''}${testId ? `[data-testid=\"${testId}\"]` : ''}`.slice(0, 1800);
                path.push(selector);
                ancestorChain.push({
                    depth,
                    tagName: tag,
                    id,
                    className: String(current.className || ''),
                    attributes: readAttributes(current),
                    selector,
                });
                if (current === root) break;
            }
            const allSameTag = node.ownerDocument?.querySelectorAll?.(String(node.tagName || '').toLowerCase()) || [];
            const documentOrdinal = Array.prototype.indexOf.call(allSameTag, node);
            const siblings = node.parentElement ? Array.from(node.parentElement.children || []) : [];
            return {
                tagName: String(node.tagName || '').toLowerCase(),
                id: String(node.id || node.getAttribute?.('id') || ''),
                className: String(node.className || ''),
                attributes: readAttributes(node),
                dataTestId: String(node.getAttribute?.('data-testid') || ''),
                role: String(node.getAttribute?.('role') || ''),
                alt: String(node.getAttribute?.('alt') || ''),
                title: String(node.getAttribute?.('title') || ''),
                ariaLabel: String(node.getAttribute?.('aria-label') || ''),
                anchorHref: String(anchor?.href || anchor?.getAttribute?.('href') || ''),
                selectorPath: path.join(' > '),
                ancestorChain,
                documentOrdinal,
                siblingIndex: siblings.indexOf(node),
                nearbyText: String(node.parentElement?.innerText || node.parentElement?.textContent || '').replace(/\s+/gu, ' ').trim(),
                outerHtml: String(node.outerHTML || ''),
            };
        }

        function addContentImage(imageUrls, imageMedia, node, value, root, width = 0, height = 0) {
            const url = addUrl(imageUrls, value);
            if (!url) return;
            const provenance = mediaProvenance(node, root);
            const existing = imageMedia.find((item) => item.url === url);
            if (!existing) imageMedia.push({ url, ...provenance, width: Number(width) || 0, height: Number(height) || 0, domContext: imageDomContext(node, root) });
            else if (provenance.repostDepth > Number(existing.repostDepth || 0)) Object.assign(existing, provenance);
        }

        function addContentImages(root, imageUrls, imageMedia) {
            if (!root) return;

            for (const image of root.querySelectorAll?.('img') || []) {
                const imageRect = layoutRect(image);
                const width = Math.max(Number(imageRect.width || 0), Number(image.naturalWidth || 0));
                const height = Math.max(Number(imageRect.height || 0), Number(image.naturalHeight || 0));
                const context = contentMediaContext(image, root);
                const explicitMedia = context.media || hasPhotoLink(image);

                if (context.ui || !isAnnouncementSized(width, height, explicitMedia)) continue;

                for (const value of [
                    image.currentSrc,
                    image.src,
                    image.getAttribute('data-src'),
                    image.getAttribute('data-original'),
                    image.getAttribute('data-lazy-src'),
                ]) {
                    addContentImage(imageUrls, imageMedia, image, value, root, width, height);
                }

                const srcset = String(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '');
                for (const candidate of srcset.split(',')) {
                    addContentImage(imageUrls, imageMedia, image, candidate.trim().split(/\s+/u)[0], root, width, height);
                }
            }

            for (const source of root.querySelectorAll?.('picture source[srcset], source[srcset], source[data-srcset]') || []) {
                const picture = source.closest?.('picture');
                const image = picture?.querySelector?.('img');
                const rect = layoutRect(image);
                const width = Math.max(Number(image?.naturalWidth || 0), Number(rect.width || 0));
                const height = Math.max(Number(image?.naturalHeight || 0), Number(rect.height || 0));
                const context = contentMediaContext(source, root);
                if (context.ui || !isAnnouncementSized(width, height, context.media || hasPhotoLink(source))) continue;
                for (const candidate of String(source.getAttribute('srcset') || source.getAttribute('data-srcset') || '').split(',')) {
                    addContentImage(imageUrls, imageMedia, source, candidate.trim().split(/\s+/u)[0], root, width, height);
                }
            }

            for (const styled of root.querySelectorAll?.('[style*="background-image"]') || []) {
                const rect = layoutRect(styled);
                const context = contentMediaContext(styled, root);
                if (context.ui || !isAnnouncementSized(rect.width, rect.height, context.media || hasPhotoLink(styled))) continue;
                const style = String(styled.getAttribute('style') || '');
                for (const match of style.matchAll(/url\(["']?([^"')]+)["']?\)/giu)) {
                    addContentImage(imageUrls, imageMedia, styled, match[1], root, rect.width, rect.height);
                }
            }
        }

        function embeddedNodeDepth(node, root) {
            let current = node;
            let depth = 0;
            let score = 0;
            while (current && current !== root) {
                const marker = contentNodeMarker(current);
                if (/attachwall|repost|forward|fwd|wallpost|wall_post|postcontent|post__/iu.test(marker)) score += 1;
                const nesting = Number(current.getAttribute?.('data-post-nesting-lvl') || 0);
                if (Number.isFinite(nesting) && nesting > 0) score += nesting * 2;
                current = current.parentElement;
                depth += 1;
                if (depth > 12) break;
            }
            return score;
        }

        function embeddedPostTextFrom(node) {
            const selectors = [
                '.AttachWallNew__message',
                '[class*="AttachWall"] [class*="message"]',
                '[class*="AttachWall"]',
                '[class*="Repost"]',
                '[class*="repost"]',
                '[class*="WallPost"]',
                '[class*="wall_post"]',
                '[class*="PostContent"]',
                '[class*="Post__"]',
                '[class*="ForwardedMessage"] [class*="content"]',
                '[data-post-nesting-lvl]',
                '[data-testid*="repost"]',
                '[data-testid*="wall"]',
                '[data-testid*="post"]',
            ];
            const candidates = [];
            for (const selector of selectors) {
                for (const child of node.querySelectorAll?.(selector) || []) {
                    const text = cleanRenderedText(child.innerText || child.textContent || '');
                    if (text.length < 3 || text.length > 12_000) continue;
                    candidates.push({
                        text,
                        depth: embeddedNodeDepth(child, node),
                        area: (() => {
                            const rect = layoutRect(child);
                            return Number(rect.width || 0) * Number(rect.height || 0);
                        })(),
                    });
                }
            }

            candidates.sort((left, right) => (
                right.depth - left.depth ||
                left.area - right.area ||
                right.text.length - left.text.length
            ));

            const selected = [];
            for (const candidate of candidates) {
                // Deepest specific repost text wins over a larger parent wrapper
                // containing the same text. Keep multiple independent forwards.
                if (selected.some((item) => (
                    item.text === candidate.text ||
                    candidate.text.includes(item.text)
                ))) continue;
                selected.push(candidate);
                if (selected.length >= 4) break;
            }
            return selected.map((item) => item.text).join('\n\n').slice(0, 10_000);
        }

        function rootText(node) {
            const preferredNodes = [
                ...node.querySelectorAll?.(
                    '.ConvoMessageWithoutBubble__text, .MessageText, [class*="MessageText"], [data-testid*="message_text"], [data-testid*="message-text"], [class*="AttachWall"][class*="message"], [class*="AttachWall"] [class*="message"], [class*="ForwardedMessage"] [class*="content"]',
                ) || [],
            ];
            const preferred = preferredNodes
                .map((item) => cleanRenderedText(item.innerText || item.textContent || ''))
                .filter((value) => value.length >= 2);
            const uniquePreferred = preferred.filter((value, index) => (
                preferred.findIndex((candidate) => candidate === value) === index
            ));
            const preferredText = uniquePreferred.join('\n\n').slice(0, 12_000);
            const fullRenderedText = cleanRenderedText(node.innerText || node.textContent || '');

            if (preferredText.length >= Math.min(60, Math.floor(fullRenderedText.length * 0.45))) {
                return preferredText;
            }
            return fullRenderedText;
        }

        function parseRoot(node, pass, useReactEvidence = false) {
            if (!node) return null;
            const rect = layoutRect(node);
            const area = Math.max(1, Number(rect.width || 0) * Number(rect.height || 0));
            const links = [];
            const repostUrls = [];
            const attachmentLinks = [];
            const imageUrls = [];
            const imageMedia = [];
            const embeddedText = embeddedPostTextFrom(node);
            const renderedText = rootText(node);
            const react = useReactEvidence ? collectReactMetadata(node) : null;
            const text = cleanRenderedText(
                renderedText || react?.text || embeddedText,
            );

            for (const anchor of node.querySelectorAll?.('a[href]') || []) {
                const marker = [
                    String(anchor.className || ''),
                    anchor.getAttribute?.('data-testid') || '',
                    anchor.getAttribute?.('aria-label') || '',
                    anchor.getAttribute?.('rel') || '',
                ].join(' ').toLowerCase();
                const href = anchor.href || anchor.getAttribute?.('href') || '';

                // Main sender/profile links are identity metadata. Embedded wall
                // authors are intentionally kept out too; the wall-post link itself
                // is retained and becomes the public source URL downstream.
                if (
                    /avatar|profile|author|sender|messageauthor|from_name|mention/iu.test(marker) ||
                    (isProfileHref(href) && !/wall/iu.test(href))
                ) {
                    continue;
                }

                addUrl(links, href);
                const wallLink = /(?:[?&]w=|\/)wall-?\d+_\d+/iu.test(String(href));
                const repostNode = anchor.closest?.('[class*="AttachWall"], [class*="Repost"], [class*="ForwardedMessage"], [data-testid*="repost"]');
                if (wallLink && repostNode) addUrl(repostUrls, href);
                else addUrl(attachmentLinks, href);
            }

            addContentImages(node, imageUrls, imageMedia);

            const conversationMessageId = readIdFromNodeAndAncestors(node) || Number(react?.conversationMessageId ?? 0);
            const senderId = readSenderIdFromDom(node) || Number(react?.senderId ?? 0);
            const peerId = Number(react?.peerId ?? 0);
            const createdAt = readTimestampFromDom(node) || Number(react?.createdAt ?? 0);
            const identityHint = [
                node.getAttribute?.('data-itemkey') || '',
                node.parentElement?.getAttribute?.('data-itemkey') || '',
                node.getAttribute?.('aria-labelledby') || '',
                String(node.className || '').slice(0, 240),
            ].filter(Boolean).join('|').slice(0, 500);

            return {
                conversationMessageId,
                peerId,
                senderId,
                createdAt,
                text,
                embeddedText,
                links,
                repostUrls,
                attachmentLinks,
                imageUrls, // capture all DOM evidence independently of AI request budget
                imageMedia,
                area,
                identityHint,
                domAudit: imageDomContext(node, node),
                parserPass: pass,
            };
        }

        function itemIsUseful(item) {
            return Boolean(
                item &&
                item.area > 20 &&
                (!item.peerId || !targetPeerId || Number(item.peerId) === Number(targetPeerId)) &&
                (item.text.length >= 2 || item.embeddedText.length >= 2 || item.imageUrls.length > 0 || item.links.length > 0)
            );
        }

        function quality(items) {
            const useful = (Array.isArray(items) ? items : []).filter(itemIsUseful);
            const stableIds = useful.filter((item) => Number(item.conversationMessageId) > 0).length;
            const rich = useful.filter((item) => (
                item.text.length >= 12 || item.embeddedText.length >= 12 || item.imageUrls.length || item.links.length
            )).length;
            return {
                useful: useful.length,
                stableIds,
                stableIdRate: useful.length ? stableIds / useful.length : 0,
                rich,
            };
        }

        function passOneExact() {
            // Snapshot 2026-09-09 (VK Messenger): the CMID is data-itemkey on
            // VirtualScrollItem, while the actual article is one level below it.
            // This is deliberately strict: if these invariants disappear, pass 2
            // takes over instead of pretending that the old schema still matches.
            const history = rootDocument.querySelector('.ConvoHistory');
            const scrollable = history?.querySelector?.('.ConvoHistory__scrollbar[data-scrollbar="scrollable"]');
            const flow = history?.querySelector?.('.ConvoHistory__flow[role="list"]');
            const roots = uniqueNodes([
                ...rootDocument.querySelectorAll(
                    '.ConvoHistory .VirtualScrollItem[data-itemkey] > .ConvoHistory__messageBlock',
                ),
            ]);
            if (!history || !scrollable || !flow || !roots.length) {
                return { ok: false, items: [], reason: 'exact-signature-miss' };
            }

            const items = roots.map((node) => parseRoot(node, PASS_EXACT, false)).filter(itemIsUseful);
            const stats = quality(items);
            return {
                ok: stats.useful > 0 && stats.stableIdRate >= 0.85,
                items,
                reason: `exact useful=${stats.useful} stable=${stats.stableIds}`,
            };
        }

        function normalizeAdaptiveRoot(node) {
            if (!node) return null;
            const keyed = node.matches?.('[data-itemkey]')
                ? node
                : node.closest?.('[data-itemkey]');
            if (keyed) {
                return keyed.querySelector?.('article, [class*="messageBlock"], [class*="MessageBlock"], [aria-labelledby$=":preview"]') || keyed;
            }

            if (node.matches?.('article, [aria-labelledby$=":preview"]')) return node;
            const article = node.closest?.('article');
            if (article) return article;

            let current = node;
            for (let depth = 0; current && depth < 6; depth += 1, current = current.parentElement) {
                const marker = `${current.className || ''} ${current.getAttribute?.('data-testid') || ''}`;
                if (/message(?:block|item|row|cell)|convo.*message|chat.*message/iu.test(marker)) return current;
            }
            return node;
        }

        function passTwoAdaptive() {
            const regionCandidates = uniqueNodes([
                rootDocument.querySelector('.ConvoHistory'),
                ...rootDocument.querySelectorAll('[data-scrollbar="scrollable"]'),
                ...rootDocument.querySelectorAll('[role="list"]'),
            ])
                .filter((node) => !node.closest?.('aside, nav, [role="navigation"]'))
                .map((node) => {
                    const keyed = node.querySelectorAll?.('[data-itemkey]')?.length || 0;
                    const messageHints = node.querySelectorAll?.(
                        '[aria-labelledby$=":preview"], [class*="ConvoMessage"], [class*="ConversationMessage"], [data-testid*="message"]',
                    )?.length || 0;
                    const semantic = listSemanticScore(node);
                    const scrollBonus = node.getAttribute?.('data-scrollbar') === 'scrollable' ? 12 : 0;
                    return { node, score: semantic + Math.min(30, keyed * 3) + Math.min(25, messageHints * 2) + scrollBonus };
                })
                .filter((item) => item.score >= 8)
                .sort((left, right) => right.score - left.score);
            const scopes = regionCandidates.length
                ? regionCandidates.slice(0, 3).map((item) => item.node)
                : [rootDocument];
            const sources = uniqueNodes(scopes.flatMap((scope) => [
                ...scope.querySelectorAll('[data-itemkey]'),
                ...scope.querySelectorAll('[aria-labelledby$=":preview"]'),
                ...scope.querySelectorAll('[class*="ConvoHistory"][class*="message"]'),
                ...scope.querySelectorAll('[class*="ConvoMessage"]'),
                ...scope.querySelectorAll('[class*="ConversationMessage"]'),
                ...scope.querySelectorAll('[data-testid*="message"]'),
            ])).filter((node) => !node.closest?.('aside, nav, [role="navigation"]'));
            const roots = uniqueNodes(sources.map(normalizeAdaptiveRoot));
            const items = roots
                .map((node) => parseRoot(node, PASS_ADAPTIVE, true))
                .filter(itemIsUseful);
            const stats = quality(items);
            return {
                ok: stats.useful > 0 && (stats.stableIdRate >= 0.35 || stats.rich >= Math.max(1, Math.ceil(stats.useful * 0.65))),
                items,
                reason: `adaptive useful=${stats.useful} stable=${stats.stableIds} rich=${stats.rich}`,
            };
        }

        function looksLikeTimeOrDateText(value) {
            const text = String(value || '').trim().toLowerCase();
            if (!text || text.length > 80) return false;
            return /(?:^|\s)(?:сегодня|вчера|позавчера|\d{1,2}:\d{2}|\d{1,2}\s+(?:января|февраля|марта|апреля|мая|июня|июля|августа|сентября|октября|ноября|декабря)|\d{1,2}[./-]\d{1,2})(?:\s|$)/iu.test(text);
        }

        function listSemanticScore(list) {
            if (!list || list.closest?.('aside, nav, [role="navigation"]')) return -1;
            const rect = layoutRect(list, 600);
            if (rect.width < 180 || rect.height < 120) return -1;
            const anchors = [...list.querySelectorAll?.('a[href]') || []];
            const profileLinks = anchors.filter((anchor) => isProfileHref(anchor.href || anchor.getAttribute?.('href'))).length;
            const wallLinks = anchors.filter((anchor) => /\/wall-?\d+_\d+/iu.test(anchor.href || anchor.getAttribute?.('href') || '')).length;
            const text = cleanRenderedText(list.innerText || '').slice(0, 20_000);
            const timeHits = text.split('\n').filter(looksLikeTimeOrDateText).length;
            const media = list.querySelectorAll?.('img, video, picture')?.length || 0;
            const itemHints = list.querySelectorAll?.('[role="listitem"], article, [data-itemkey]')?.length || 0;
            return itemHints * 6 + profileLinks * 2 + wallLinks * 4 + Math.min(20, timeHits * 3) + Math.min(20, media);
        }

        function structuralClassTokens(node) {
            return String(node?.className || '')
                .split(/\s+/u)
                .map((token) => token.trim())
                .filter((token) => token.length >= 2 && token.length <= 100)
                .map((token) => token
                    .replace(/[0-9a-f]{8,}/giu, '#')
                    .replace(/\d{2,}/gu, '#'))
                .sort()
                .slice(0, 10);
        }

        function repeatedBlockSignature(node) {
            const role = String(node?.getAttribute?.('role') || '').toLowerCase();
            const testId = String(node?.getAttribute?.('data-testid') || '')
                .toLowerCase()
                .replace(/\d+/gu, '#')
                .slice(0, 80);
            const childTags = [...node?.children || []]
                .slice(0, 8)
                .map((child) => String(child.tagName || '').toLowerCase())
                .join(',');
            return [
                String(node?.tagName || '').toLowerCase(),
                role,
                testId,
                structuralClassTokens(node).join('.'),
                childTags,
            ].join('|');
        }

        function repeatedBlockEvidence(node) {
            if (!node || node.closest?.('aside, nav, [role="navigation"]')) return -100;
            const rect = layoutRect(node);
            if (rect.width < 160 || rect.height < 18) return -100;
            const text = cleanRenderedText(node.innerText || node.textContent || '');
            if (text.length > 16_000) return -100;
            const media = node.querySelectorAll?.('img, video, picture')?.length || 0;
            const wall = node.querySelectorAll?.('a[href*="wall"]')?.length || 0;
            const profiles = [...node.querySelectorAll?.('a[href]') || []]
                .filter((anchor) => isProfileHref(anchor.href || anchor.getAttribute?.('href'))).length;
            const hasTime = [...node.querySelectorAll?.('time, [class*="date"], [class*="Date"], [class*="time"], [class*="Time"]') || []]
                .some((part) => looksLikeTimeOrDateText(part.innerText || part.textContent || part.getAttribute?.('datetime') || ''));
            const hasStableId = readIdFromNodeAndAncestors(node) > 0;
            const semanticMarker = [
                String(node.className || ''),
                node.getAttribute?.('data-testid') || '',
                node.getAttribute?.('role') || '',
            ].join(' ');
            const viewportWidth = snapshotMode ? 1200 : Math.max(1, window.innerWidth || rootDocument.documentElement?.clientWidth || 1);
            const center = (Number(rect.left || 0) + Number(rect.right || (rect.left + rect.width))) / 2;
            const central = center >= viewportWidth * 0.16 && center <= viewportWidth * 0.88;

            let score = 0;
            if (hasStableId) score += 10;
            if (hasTime) score += 5;
            if (profiles) score += Math.min(5, profiles * 2);
            if (wall) score += Math.min(8, wall * 4);
            if (media) score += Math.min(8, media * 2);
            if (text.length >= 8) score += 2;
            if (text.length >= 40) score += 3;
            if (text.length >= 160) score += 2;
            if (central) score += 4;
            // Human-readable class names are only a weak bonus, never a gate.
            if (/(?:message|msg|convo|chat|post|item|row)/iu.test(semanticMarker)) score += 3;
            return score;
        }

        function discoverRepeatedContentRoots(scope) {
            const rootScope = scope || rootDocument.body;
            const parents = uniqueNodes([
                rootScope,
                ...rootScope.querySelectorAll?.('[role="list"], main, section, div') || [],
            ])
                .filter((node) => !node.closest?.('aside, nav, [role="navigation"]'))
                .slice(0, 700);
            let best = { score: -1, nodes: [] };

            for (const parent of parents) {
                const children = [...parent.children || []]
                    .filter((node) => repeatedBlockEvidence(node) > -100)
                    .slice(0, 180);
                if (children.length < 3) continue;

                const groups = new Map();
                for (const child of children) {
                    const signature = repeatedBlockSignature(child);
                    if (!signature) continue;
                    if (!groups.has(signature)) groups.set(signature, []);
                    groups.get(signature).push(child);
                }

                for (const group of groups.values()) {
                    if (group.length < 3) continue;
                    const scored = group
                        .map((node) => ({ node, score: repeatedBlockEvidence(node) }))
                        .filter((item) => item.score >= 2);
                    if (scored.length < 3) continue;
                    const evidence = scored.reduce((sum, item) => sum + item.score, 0) / scored.length;
                    const score = Math.min(80, scored.length * 6) + evidence;
                    if (score > best.score) {
                        best = {
                            score,
                            nodes: scored.map((item) => item.node),
                        };
                    }
                }
            }

            return best;
        }

        function inferredRootFromAuthor(anchor, list) {
            let current = anchor;
            let best = null;
            let bestScore = -1;

            for (let depth = 0; current && depth < 9 && current !== list.parentElement; depth += 1, current = current.parentElement) {
                if (current.closest?.('aside, nav, [role="navigation"]')) break;
                const rect = layoutRect(current);
                if (rect.width < 120 || rect.height < 18) continue;
                const text = cleanRenderedText(current.innerText || current.textContent || '');
                if (text.length < 2 || text.length > 14_000) continue;
                const anchors = current.querySelectorAll?.('a[href]')?.length || 0;
                const media = current.querySelectorAll?.('img, video, picture')?.length || 0;
                const wall = current.querySelectorAll?.('a[href*="wall"]')?.length || 0;
                const time = [...current.querySelectorAll?.('time, [class*="date"], [class*="Date"], [class*="time"], [class*="Time"]') || []]
                    .some((node) => looksLikeTimeOrDateText(node.innerText || node.textContent || node.getAttribute?.('datetime') || ''));
                const key = readIdFromNodeAndAncestors(current) > 0;
                let score = 0;
                if (key) score += 12;
                if (current.matches?.('article, [role="listitem"]')) score += 7;
                if (time) score += 5;
                if (wall) score += 5;
                if (media) score += 3;
                if (anchors >= 1 && anchors <= 40) score += 2;
                if (text.length >= 20) score += 2;
                if (text.length >= 150) score += 2;
                if (current.parentElement === list || current.closest?.('[role="listitem"]')) score += 3;

                // Prefer the smallest convincing container around the sender, not
                // a giant history/list wrapper that happens to contain everything.
                score -= Math.max(0, Math.log10(Math.max(1, rect.width * rect.height)) - 5.2) * 4;
                if (score > bestScore) {
                    best = current;
                    bestScore = score;
                }
                if (score >= 18) break;
            }
            return bestScore >= 8 ? best : null;
        }

        function passThreeHeuristic() {
            const lists = uniqueNodes([
                ...rootDocument.querySelectorAll('[role="list"]'),
                ...rootDocument.querySelectorAll('[aria-label]'),
            ]).filter((node) => !node.closest?.('aside, nav, [role="navigation"]'));
            const rankedLists = lists
                .map((node) => ({ node, score: listSemanticScore(node) }))
                .filter((item) => item.score >= 8)
                .sort((left, right) => right.score - left.score);
            const primaryList = rankedLists[0]?.node || rootDocument.body;

            const repeatedDiscovery = discoverRepeatedContentRoots(primaryList);
            const anchors = [...primaryList.querySelectorAll?.('a[href]') || []]
                .filter((anchor) => isProfileHref(anchor.href || anchor.getAttribute?.('href')))
                .filter((anchor) => !anchor.closest?.('aside, nav, [role="navigation"]'));
            const roots = uniqueNodes([
                ...repeatedDiscovery.nodes,
                ...anchors.map((anchor) => inferredRootFromAuthor(anchor, primaryList)).filter(Boolean),
            ]);

            // If repeated-sibling discovery and author anchors are both gone,
            // fall back to semantic list items. This branch is still independent
            // from concrete VK class names.
            if (!roots.length) {
                const repeated = [
                    ...primaryList.querySelectorAll?.('[role="listitem"], article, [data-itemkey]') || [],
                ];
                for (const node of repeated) {
                    const rect = layoutRect(node);
                    const text = cleanRenderedText(node.innerText || node.textContent || '');
                    const media = node.querySelectorAll?.('img, video, picture')?.length || 0;
                    if (rect.width >= 160 && rect.height >= 18 && (text.length >= 8 || media > 0)) {
                        roots.push(node);
                    }
                }
            }

            const items = uniqueNodes(roots)
                .map((node) => parseRoot(node, PASS_HEURISTIC, true))
                .filter(itemIsUseful);
            const stats = quality(items);
            return {
                ok: stats.useful > 0,
                items,
                reason: `heuristic useful=${stats.useful} stable=${stats.stableIds} listScore=${rankedLists[0]?.score ?? 0} repeatScore=${repeatedDiscovery.score}`,
            };
        }

        const exact = passOneExact();
        if (exact.ok) {
            return {
                pass: PASS_EXACT,
                reason: exact.reason,
                messages: exact.items,
            };
        }

        const adaptive = passTwoAdaptive();
        if (adaptive.ok) {
            return {
                pass: PASS_ADAPTIVE,
                reason: `${exact.reason}; ${adaptive.reason}`,
                messages: adaptive.items,
            };
        }

        const heuristic = passThreeHeuristic();
        return {
            pass: PASS_HEURISTIC,
            reason: `${exact.reason}; ${adaptive.reason}; ${heuristic.reason}`,
            messages: heuristic.items,
        };
    }, {
        targetPeerId: expectedPeerId,
        immutableSnapshotHtml: String(snapshotHtml || ''),
        baseUrl: conversationUrl,
    });

    const rawMessages = Array.isArray(extraction?.messages)
        ? extraction.messages
        : [];
    const byKey = new Map();

    for (const raw of rawMessages) {
        const normalized = normalizeBrowserMessage(raw, conversationUrl);
        const key = normalized.conversationMessageId;
        const existing = byKey.get(key);
        const normalizedWeight = normalized.text.length + normalized.links.length * 120 + normalized.imageUrls.length * 180;
        const existingWeight = existing
            ? existing.text.length + existing.links.length * 120 + existing.imageUrls.length * 180
            : -1;

        if (!existing || normalizedWeight > existingWeight) {
            byKey.set(key, normalized);
        }
    }

    const result = [...byKey.values()];
    Object.defineProperties(result, {
        parserPass: {
            value: String(extraction?.pass || 'unknown'),
            enumerable: false,
        },
        parserReason: {
            value: String(extraction?.reason || '').slice(0, 1000),
            enumerable: false,
        },
    });
    return result;
}

export async function extractExactMessagesFromDomSnapshot(page, html, conversationUrl) {
    if (!page || page.isClosed() || !String(html || '').trim()) return [];
    const expectedPeerId = normalizeConversationUrl(conversationUrl).peerId;
    const snapshotResult = await page.evaluate(({ snapshotHtml, targetPeerId, baseUrl }) => {
        const doc = new DOMParser().parseFromString(String(snapshotHtml || ''), 'text/html');
        const roots = [...doc.querySelectorAll(
            '.ConvoHistory .VirtualScrollItem[data-itemkey] > article.ConvoHistory__messageBlock, ' +
            '.ConvoHistory .VirtualScrollItem[data-itemkey] > .ConvoHistory__messageBlock, ' +
            '.ConvoHistory .VirtualScrollItem[data-itemkey] article[aria-labelledby]'
        )];
        const unique = [];
        const seen = new Set();
        const resolveUrl = (value) => {
            const raw = String(value || '').trim();
            if (!raw || raw.startsWith('data:')) return '';
            try { return new URL(raw, baseUrl).href; } catch { return ''; }
        };
        const clean = (value) => String(value || '')
            .replace(/\r\n?/gu, '\n')
            .replace(/\u00a0/gu, ' ')
            .split('\n')
            .map((line) => line.replace(/[ \t]{2,}/gu, ' ').trim())
            .filter(Boolean)
            .join('\n')
            .replace(/\n{3,}/gu, '\n\n')
            .trim()
            .slice(0, 12_000);
        const numericProfileId = (href) => {
            try {
                const path = new URL(href, baseUrl).pathname;
                const user = path.match(/^\/id(\d+)\/?$/iu);
                if (user) return Number(user[1]);
                const community = path.match(/^\/(?:club|public)(\d+)\/?$/iu);
                if (community) return -Number(community[1]);
            } catch {}
            return 0;
        };
        const senderFromMask = (root) => {
            for (const node of root.querySelectorAll('[style*="Mask"], [style*="mask"], [clip-path], [id*="Mask"], [id*="mask"]')) {
                const marker = [node.getAttribute('style') || '', node.getAttribute('clip-path') || '', node.id || ''].join(' ');
                const match = marker.match(/(?:PeerFrame|Mask|mask)[^\d-]*(-?\d{3,16})/u);
                const value = Number(match?.[1] || 0);
                if (Number.isSafeInteger(value) && value !== 0) return value;
            }
            return 0;
        };
        const readTimestamp = (root) => {
            const time = root.querySelector('time[datetime], time');
            const parsed = Date.parse(time?.getAttribute('datetime') || time?.getAttribute('title') || '');
            return Number.isFinite(parsed) ? Math.floor(parsed / 1000) : 0;
        };
        const nodeMarker = (node) => [
            String(node?.className || ''),
            node?.getAttribute?.('data-testid') || '',
            node?.getAttribute?.('role') || '',
            node?.getAttribute?.('aria-label') || '',
            node?.getAttribute?.('alt') || '',
        ].join(' ').toLowerCase();
        const uiMarker = /avatar|profile|author(?:link)?|sender|emoji|reaction|sticker|icon|badge|logo|favicon|smile|usersstack|peeravatar|messageheader/iu;
        const mediaMarker = /photoitem|attachphotos|attachesgrid|mediaattachments|attachment(?:s)?|primary-attachment|poster|gallery|picture|video(?:preview|thumb)?/iu;
        const isUiImage = (node, root) => {
            let current = node;
            for (let depth = 0; current && current !== root && depth < 8; depth += 1, current = current.parentElement) {
                if (uiMarker.test(nodeMarker(current))) return true;
            }
            return uiMarker.test(nodeMarker(node));
        };
        const isContentMediaNode = (node, root) => {
            let current = node;
            for (let depth = 0; current && current !== root && depth < 10; depth += 1, current = current.parentElement) {
                if (mediaMarker.test(nodeMarker(current))) return true;
            }
            return mediaMarker.test(nodeMarker(node));
        };
        const dimensionsFromUrl = (value) => {
            const source = String(value || '');
            let maxWidth = 0;
            let maxHeight = 0;
            for (const match of source.matchAll(/(?:^|[?&,=])(?:as=)?(\d{2,5})x(\d{2,5})(?=$|[,&])/gu)) {
                maxWidth = Math.max(maxWidth, Number(match[1]) || 0);
                maxHeight = Math.max(maxHeight, Number(match[2]) || 0);
            }
            return { width: maxWidth, height: maxHeight };
        };
        const imageLooksLargeEnough = (node, value, explicitMedia) => {
            const attrWidth = Number.parseInt(node?.getAttribute?.('width') || '', 10) || 0;
            const attrHeight = Number.parseInt(node?.getAttribute?.('height') || '', 10) || 0;
            const fromUrl = dimensionsFromUrl(value);
            const width = Math.max(attrWidth, fromUrl.width);
            const height = Math.max(attrHeight, fromUrl.height);
            if (explicitMedia) return width === 0 || height === 0 || Math.max(width, height) >= 48;
            return width >= 300 && height >= 300;
        };
        const photoAttachmentKey = (node) => {
            const anchor = node?.closest?.('a[href]');
            const href = String(anchor?.href || anchor?.getAttribute?.('href') || '');
            const match = href.match(/(?:^|[/?&])(?:z=)?(photo-?\d+_\d+)/iu);
            return String(match?.[1] || '').toLowerCase();
        };
        const addImage = (list, mediaList, node, value, root) => {
            const url = resolveUrl(value);
            if (!url || list.includes(url)) return;
            if (!/\.(?:jpe?g|png|webp|gif)(?:\?|$)|(?:vkuserphoto|userapi|okcdn)/iu.test(url)) return;
            if (isUiImage(node, root)) return;
            const explicitMedia = isContentMediaNode(node, root);
            if (!explicitMedia || !imageLooksLargeEnough(node, url, explicitMedia)) return;
            list.push(url);
            const attachmentKey = photoAttachmentKey(node);
            mediaList.push({
                url,
                attachmentKey,
                vkPhotoId: attachmentKey,
                origin: node?.closest?.('[class*="AttachWall"], [class*="Forwarded"], [class*="Repost"]') ? 'repost-wall' : 'outer-message',
                repostDepth: node?.closest?.('[class*="AttachWall"], [class*="Forwarded"], [class*="Repost"]') ? 1 : 0,
                width: Number.parseInt(node?.getAttribute?.('width') || '', 10) || 0,
                height: Number.parseInt(node?.getAttribute?.('height') || '', 10) || 0,
                mediaHint: 'snapshot-exact-attachment',
            });
        };
        const textFromNodes = (nodes) => {
            const values = [];
            for (const node of nodes) {
                const value = clean(node?.textContent || '');
                if (!value || values.some((item) => item === value || item.includes(value))) continue;
                values.push(value);
            }
            return values.join('\n\n').slice(0, 12_000);
        };
        const directMessageText = (root) => {
            const nodes = [...root.querySelectorAll(
                '.MessageText, .ConvoMessageWithoutBubble__text, [data-testid="message_text"], [data-testid="message-text"], [data-testid*="message_text"]'
            )].filter((node) => !node.closest(
                '.ConvoMessageWithoutBubble__forwardedMessages, .ForwardedMessagesList, .ForwardedMessageNew, .AttachWallNew, [class*="forwarded"], [class*="Forwarded"]'
            ));
            return textFromNodes(nodes);
        };
        const embeddedContentText = (root) => {
            // Current VK Messenger DOM: the meaningful repost body is isolated in
            // AttachWallNew__message. Its subtitle ("5 сентября в 11:24"), author,
            // reactions and "Открыть пост" are UI metadata and MUST NOT enter the
            // event-candidate text.
            const exactWallBodies = [...root.querySelectorAll('.AttachWallNew__message')];
            const exactWallText = textFromNodes(exactWallBodies);
            if (exactWallText) return exactWallText;

            const forwardedBodies = [...root.querySelectorAll(
                '.ForwardedMessageNew .MessageText, .ForwardedMessageNew__content .MessageText, ' +
                '[class*="ForwardedMessage"] [class*="MessageText"], [class*="forwarded"] [class*="MessageText"]'
            )];
            const forwardedText = textFromNodes(forwardedBodies);
            if (forwardedText) return forwardedText;

            return '';
        };

        for (const root of roots) {
            const item = root.closest('.VirtualScrollItem[data-itemkey], [data-itemkey]');
            const cmid = Number(String(item?.getAttribute('data-itemkey') || '').match(/^\d{1,16}$/u)?.[0] || 0);
            if (!Number.isSafeInteger(cmid) || cmid <= 0 || seen.has(cmid)) continue;
            seen.add(cmid);

            const author = root.querySelector('.ConvoMessageHeader__authorLink[href], [class*="MessageHeader"] a[href]');
            const authorHref = resolveUrl(author?.getAttribute('href') || '');
            const senderId = numericProfileId(authorHref) || senderFromMask(root);
            const links = [];
            const repostUrls = [];
            const attachmentLinks = [];
            for (const anchor of root.querySelectorAll('a[href]')) {
                const href = resolveUrl(anchor.getAttribute('href'));
                if (!href) continue;
                const marker = nodeMarker(anchor);
                if (uiMarker.test(marker) || (numericProfileId(href) && !/wall-?\d+_\d+/iu.test(href))) continue;
                if (!links.includes(href)) links.push(href);
                const wallLink = /(?:[?&]w=|\/)wall-?\d+_\d+/iu.test(String(href));
                const repostNode = anchor.closest?.('[class*="AttachWall"], [class*="Repost"], [class*="ForwardedMessage"], [data-testid*="repost"]');
                if (wallLink && repostNode && !repostUrls.includes(href)) repostUrls.push(href);
                else if (!attachmentLinks.includes(href)) attachmentLinks.push(href);
            }
            const images = [];
            const imageMedia = [];
            for (const image of root.querySelectorAll('img')) {
                for (const value of [
                    image.getAttribute('src'),
                    image.getAttribute('data-src'),
                    image.getAttribute('data-original'),
                    image.getAttribute('data-lazy-src'),
                ]) addImage(images, imageMedia, image, value, root);
                for (const entry of String(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '').split(',')) {
                    addImage(images, imageMedia, image, entry.trim().split(/\s+/u)[0], root);
                }
            }
            for (const source of root.querySelectorAll('picture source[srcset], source[data-srcset]')) {
                for (const entry of String(source.getAttribute('srcset') || source.getAttribute('data-srcset') || '').split(',')) {
                    addImage(images, imageMedia, source, entry.trim().split(/\s+/u)[0], root);
                }
            }
            for (const node of root.querySelectorAll('[style*="background-image"]')) {
                if (isUiImage(node, root) || !isContentMediaNode(node, root)) continue;
                const style = String(node.getAttribute('style') || '');
                for (const match of style.matchAll(/url\(["']?([^"')]+)["']?\)/giu)) addImage(images, imageMedia, node, match[1], root);
            }

            const primaryText = directMessageText(root);
            const embeddedText = embeddedContentText(root);
            // Service-only messages are intentionally represented by their short
            // service text for diagnostics, but the candidate gate below will not
            // treat interface timestamps/author labels as event evidence.
            const serviceText = root.matches('.ServiceMessage')
                ? clean(root.querySelector('.ServiceMessage__preview')?.textContent || '')
                : '';
            const text = primaryText || serviceText || '';
            unique.push({
                conversationMessageId: cmid,
                peerId: Number(targetPeerId || 0),
                senderId,
                createdAt: readTimestamp(root),
                text,
                embeddedText,
                links,
                repostUrls,
                attachmentLinks,
                imageUrls: images,
                imageMedia,
                identityHint: `snapshot-itemkey:${cmid}`,
                domAudit: (() => {
                    const readAttributes = (element) => Object.fromEntries(Array.from(element?.attributes || []).map((attribute) => [String(attribute.name || ''), String(attribute.value || '')]));
                    const siblings = root.parentElement ? Array.from(root.parentElement.children || []) : [];
                    const anchor = root.closest?.('a[href]') || root.querySelector?.('a[href]') || null;
                    const path = [];
                    const ancestorChain = [];
                    let current = root;
                    for (let depth = 0; current && depth < 16; depth += 1, current = current.parentElement) {
                        const tag = String(current.tagName || '').toLowerCase();
                        const id = String(current.id || current.getAttribute?.('id') || '').trim();
                        const classes = String(current.className || '').trim().split(/\s+/u).filter(Boolean);
                        const testId = String(current.getAttribute?.('data-testid') || '').trim();
                        const selector = `${tag}${id ? `#${id}` : ''}${classes.length ? `.${classes.join('.')}` : ''}${testId ? `[data-testid="${testId}"]` : ''}`;
                        path.push(selector);
                        ancestorChain.push({
                            depth,
                            tagName: tag,
                            id,
                            className: String(current.className || ''),
                            attributes: readAttributes(current),
                            selector,
                        });
                    }
                    const allSameTag = root.ownerDocument?.querySelectorAll?.(String(root.tagName || '').toLowerCase()) || [];
                    return {
                        tagName: String(root.tagName || '').toLowerCase(),
                        id: String(root.id || root.getAttribute?.('id') || ''),
                        className: String(root.className || ''),
                        attributes: readAttributes(root),
                        dataTestId: String(root.getAttribute?.('data-testid') || ''),
                        role: String(root.getAttribute?.('role') || ''),
                        href: String(anchor?.getAttribute?.('href') || anchor?.href || ''),
                        alt: String(root.getAttribute?.('alt') || ''),
                        title: String(root.getAttribute?.('title') || ''),
                        ariaLabel: String(root.getAttribute?.('aria-label') || ''),
                        selectorPath: path.join(' > '),
                        ancestorChain,
                        documentOrdinal: Array.prototype.indexOf.call(allSameTag, root),
                        siblingIndex: siblings.indexOf(root),
                        nearbyText: String(root.parentElement?.textContent || '').replace(/\s+/gu, ' ').trim(),
                        outerHtml: String(root.outerHTML || ''),
                    };
                })(),
                parserPass: 'snapshot-exact',
            });
        }
        return {
            items: unique,
            diagnostics: {
                historyCount: doc.querySelectorAll('.ConvoHistory').length,
                scrollContainerCount: doc.querySelectorAll('.ConvoHistory__scrollbar[data-scrollbar="scrollable"]').length,
                virtualItemCount: doc.querySelectorAll('.VirtualScrollItem[data-itemkey], [data-itemkey]').length,
                messageBlockCount: doc.querySelectorAll('.ConvoHistory__messageBlock').length,
                rootCount: roots.length,
                parsedCount: unique.length,
                validCmidCount: unique.filter((item) => Number(item?.conversationMessageId || 0) > 0).length,
            },
        };
    }, { snapshotHtml: String(html), targetPeerId: expectedPeerId, baseUrl: conversationUrl });

    const normalized = (Array.isArray(snapshotResult?.items) ? snapshotResult.items : [])
        .map((raw) => normalizeBrowserMessage(raw, conversationUrl));
    Object.defineProperty(normalized, 'snapshotDiagnostics', {
        value: snapshotResult?.diagnostics || {},
        enumerable: false,
    });
    return normalized;
}

function mergeSnapshotAndRenderedMessages(snapshotMessages, renderedMessages) {
    const byId = new Map();
    for (const message of Array.isArray(snapshotMessages) ? snapshotMessages : []) {
        byId.set(Number(message?.conversationMessageId || 0), message);
    }
    for (const rendered of Array.isArray(renderedMessages) ? renderedMessages : []) {
        const id = Number(rendered?.conversationMessageId || 0);
        const exact = byId.get(id);
        if (!exact) {
            byId.set(id, rendered);
            continue;
        }
        const mergedMedia = mergeVkChatSnapshotMedia(exact, rendered);
        byId.set(id, {
            ...exact,
            ...rendered,
            senderId: Number(rendered?.senderId || exact?.senderId || 0),
            createdAt: Number(rendered?.createdAt || exact?.createdAt || 0),
            contentText: String(exact?.contentText || '').trim() || String(rendered?.contentText || '').trim(),
            repostText: String(exact?.repostText || exact?.embeddedText || '').trim() || String(rendered?.repostText || rendered?.embeddedText || '').trim(),
            embeddedText: String(exact?.embeddedText || exact?.repostText || '').trim() || String(rendered?.embeddedText || rendered?.repostText || '').trim(),
            hasRepostEvidence: Boolean(exact?.hasRepostEvidence || rendered?.hasRepostEvidence),
            text: String(exact?.text || '').trim() || String(rendered?.text || '').trim(),
            links: [...new Set([...(exact?.links || []), ...(rendered?.links || [])])],
            repostUrls: [...new Set([...(exact?.repostUrls || []), ...(rendered?.repostUrls || [])])],
            attachmentLinks: [...new Set([...(exact?.attachmentLinks || []), ...(rendered?.attachmentLinks || [])])],
            // Exact anchors known media; adaptive can supply later-loaded media
            // ONLY when it exposes a stable VK photo/attachment identity.
            imageMedia: mergedMedia,
            imageUrls: [...new Set(mergedMedia
                .map((item) => String(item?.url || '').trim()).filter(Boolean))],
            parserPass: `snapshot-exact+${rendered?.parserPass || 'rendered'}`,
        });
    }
    return [...byId.values()].filter((message) => Number(message?.conversationMessageId || 0) > 0);
}

async function scrollConversationUp(page, batchMessages = DEFAULT_SCROLL_BATCH_MESSAGES) {
    const safeBatch = clampInteger(
        batchMessages,
        1,
        50,
        DEFAULT_SCROLL_BATCH_MESSAGES,
    );

    return page.evaluate((requestedBatch) => {
        const visible = (node) => {
            const rect = node?.getBoundingClientRect?.();
            return Boolean(rect && rect.height >= 8 && rect.width >= 8);
        };
        const unique = (nodes) => [...new Set(nodes || [])].filter(visible);
        const messageRoots = unique([
            ...document.querySelectorAll('.VirtualScrollItem[data-itemkey]'),
            ...document.querySelectorAll('[data-itemkey] > .ConvoHistory__messageBlock'),
            ...document.querySelectorAll('[role="list"][aria-label] > [role="listitem"] [data-itemkey]'),
            ...document.querySelectorAll('[data-cmid], [data-message-id], [data-msgid]'),
            ...document.querySelectorAll('[data-testid*="message"]'),
        ]);

        function isScrollable(node) {
            if (!node || node === document.body || node === document.documentElement) return false;
            const style = getComputedStyle(node);
            return node.scrollHeight > node.clientHeight + 40 && /auto|scroll/u.test(style.overflowY || '');
        }

        // PASS 1. Exact signature learned from the supplied VK Messenger snapshot.
        // This is intentionally narrow and fastest when VK has not changed its DOM.
        let scrollable = document.querySelector(
            '.ConvoHistory__scrollbar[data-scrollbar="scrollable"]',
        );
        let strategy = 'pass1-exact-scroll';

        // PASS 2. The message markup can drift while its virtual-scroll item and
        // a genuinely scrollable ancestor remain. Recover that ancestor instead
        // of depending on one class name.
        if (!scrollable) {
            strategy = 'pass2-adaptive-scroll';
            const anchor = messageRoots[0] || document.querySelector(
                '[data-itemkey], [role="listitem"] article, [data-testid*="message"]',
            );
            let current = anchor?.parentElement || null;
            while (current && current !== document.body) {
                if (
                    current.getAttribute?.('data-scrollbar') === 'scrollable' ||
                    isScrollable(current)
                ) {
                    scrollable = current;
                    break;
                }
                current = current.parentElement;
            }
        }

        // PASS 3. Pure structural recovery. Score scrollable regions by semantic
        // message signals, so a class rename does not make us scroll the sidebar.
        if (!scrollable) {
            strategy = 'pass3-heuristic-scroll';
            const regions = [...document.querySelectorAll('main, section, div')]
                .filter(isScrollable)
                .map((node) => {
                    const roleItems = node.querySelectorAll?.('[role="listitem"]')?.length || 0;
                    const keyedItems = node.querySelectorAll?.('[data-itemkey]')?.length || 0;
                    const profileLinks = node.querySelectorAll?.('a[href*="/id"], a[href*="vk.ru/"]')?.length || 0;
                    const timeNodes = node.querySelectorAll?.('time, [datetime], [aria-label*=":"]')?.length || 0;
                    const media = node.querySelectorAll?.('img, video, [style*="background-image"]')?.length || 0;
                    const listBonus = node.querySelector?.('[role="list"]') ? 10 : 0;
                    const navPenalty = node.closest?.('nav, aside, [role="navigation"]') ? 30 : 0;
                    const score = Math.min(keyedItems, 30) * 5 +
                        Math.min(roleItems, 30) * 3 +
                        Math.min(profileLinks, 30) +
                        Math.min(timeNodes, 20) +
                        Math.min(media, 20) * 0.25 +
                        listBonus - navPenalty;
                    return { node, score };
                })
                .sort((left, right) => right.score - left.score);
            if (regions[0]?.score > 3) {
                scrollable = regions[0].node;
            }
        }

        const sample = messageRoots.slice(0, Math.max(1, requestedBatch));
        const sampledHeight = sample.reduce((sum, node) => {
            const rect = node.getBoundingClientRect?.();
            return sum + Math.max(24, Number(rect?.height ?? 0));
        }, 0);

        function nudgeUp(target, viewportHeight) {
            const fallback = Math.max(320, viewportHeight * 0.55);
            const delta = Math.max(220, Math.min(
                viewportHeight * 0.95,
                sampledHeight || fallback,
            ));
            const before = target.scrollTop;
            const beforeHeight = target.scrollHeight;
            target.scrollTop = Math.max(0, before - delta);
            target.dispatchEvent?.(new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                deltaY: -Math.max(160, Math.round(delta)),
            }));
            return {
                moved: target.scrollTop !== before,
                atTop: target.scrollTop <= 1,
                requestedBatch,
                delta: Math.round(delta),
                strategy,
                beforeTop: Math.round(before),
                afterTop: Math.round(target.scrollTop),
                beforeHeight: Math.round(beforeHeight),
                afterHeight: Math.round(target.scrollHeight),
            };
        }

        if (scrollable && scrollable !== document.body && scrollable !== document.documentElement) {
            return nudgeUp(scrollable, Math.max(1, scrollable.clientHeight || window.innerHeight));
        }

        strategy = 'pass3-window-scroll';
        const before = window.scrollY;
        const fallback = Math.max(500, window.innerHeight * 0.55);
        const delta = Math.max(300, Math.min(
            window.innerHeight * 0.95,
            sampledHeight || fallback,
        ));
        window.scrollBy(0, -delta);
        window.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: -Math.max(160, Math.round(delta)),
        }));
        return {
            moved: window.scrollY !== before,
            atTop: window.scrollY <= 1,
            requestedBatch,
            delta: Math.round(delta),
            strategy,
            beforeTop: Math.round(before),
            afterTop: Math.round(window.scrollY),
        };
    }, safeBatch);
}


async function inspectConversationNavigationState(page) {
    return page.evaluate(() => {
        const visible = (node) => {
            const rect = node?.getBoundingClientRect?.();
            return Boolean(rect && rect.height >= 8 && rect.width >= 8);
        };
        const messageRoots = [...new Set([
            ...document.querySelectorAll('.VirtualScrollItem[data-itemkey]'),
            ...document.querySelectorAll('[data-itemkey] > .ConvoHistory__messageBlock'),
            ...document.querySelectorAll('[role="list"][aria-label] > [role="listitem"] [data-itemkey]'),
            ...document.querySelectorAll('[data-cmid], [data-message-id], [data-msgid]'),
            ...document.querySelectorAll('[data-testid*="message"]'),
        ])].filter(visible);

        function isScrollable(node) {
            if (!node || node === document.body || node === document.documentElement) return false;
            const style = getComputedStyle(node);
            return node.scrollHeight > node.clientHeight + 40 && /auto|scroll/u.test(style.overflowY || '');
        }

        let scrollable = document.querySelector(
            '.ConvoHistory__scrollbar[data-scrollbar="scrollable"]',
        );
        let strategy = 'pass1-exact-scroll';

        if (!scrollable) {
            strategy = 'pass2-adaptive-scroll';
            const anchor = messageRoots[0] || document.querySelector(
                '[data-itemkey], [role="listitem"] article, [data-testid*="message"]',
            );
            let current = anchor?.parentElement || null;
            while (current && current !== document.body) {
                if (
                    current.getAttribute?.('data-scrollbar') === 'scrollable' ||
                    isScrollable(current)
                ) {
                    scrollable = current;
                    break;
                }
                current = current.parentElement;
            }
        }

        if (!scrollable) {
            strategy = 'pass3-heuristic-scroll';
            const regions = [...document.querySelectorAll('main, section, div')]
                .filter(isScrollable)
                .map((node) => {
                    const roleItems = node.querySelectorAll?.('[role="listitem"]')?.length || 0;
                    const keyedItems = node.querySelectorAll?.('[data-itemkey]')?.length || 0;
                    const timeNodes = node.querySelectorAll?.('time, [datetime], [aria-label*=":"]')?.length || 0;
                    const listBonus = node.querySelector?.('[role="list"]') ? 10 : 0;
                    const navPenalty = node.closest?.('nav, aside, [role="navigation"]') ? 30 : 0;
                    return {
                        node,
                        score: Math.min(keyedItems, 30) * 5 + Math.min(roleItems, 30) * 3 +
                            Math.min(timeNodes, 20) + listBonus - navPenalty,
                    };
                })
                .sort((left, right) => right.score - left.score);
            if (regions[0]?.score > 3) scrollable = regions[0].node;
        }

        const unreadButton = [...document.querySelectorAll('button[aria-label]')].find((node) => (
            /перейти к непрочитанным сообщениям/iu.test(String(node.getAttribute('aria-label') || ''))
        ));
        const unreadLabel = String(unreadButton?.getAttribute('aria-label') || '');
        const unreadCountMatch = unreadLabel.match(/(\d[\d\s]*)\s+сообщ/iu);
        const unreadCount = unreadCountMatch
            ? Number(String(unreadCountMatch[1]).replace(/\s+/gu, '')) || 0
            : 0;
        const unreadSeparator = [...document.querySelectorAll(
            '.ConvoHistory__unreadSeparator, [role="heading"][aria-label="Новые сообщения"]',
        )].find(visible) || null;

        const buildState = (top, clientHeight, scrollHeight) => {
            const safeTop = Math.max(0, Number(top) || 0);
            const safeClientHeight = Math.max(1, Number(clientHeight) || window.innerHeight || 1);
            const safeScrollHeight = Math.max(safeClientHeight, Number(scrollHeight) || safeClientHeight);
            const maxTop = Math.max(0, safeScrollHeight - safeClientHeight);
            const remainingDown = Math.max(0, maxTop - safeTop);
            return {
                strategy,
                scrollTop: Math.round(safeTop),
                clientHeight: Math.round(safeClientHeight),
                scrollHeight: Math.round(safeScrollHeight),
                maxTop: Math.round(maxTop),
                remainingDown: Math.round(remainingDown),
                canScrollDown: remainingDown > 3,
                atBottom: remainingDown <= 3,
                unreadCount,
                hasUnreadSeparator: Boolean(unreadSeparator),
                unreadHint: unreadCount > 0 || Boolean(unreadSeparator),
            };
        };

        if (scrollable && scrollable !== document.body && scrollable !== document.documentElement) {
            return buildState(scrollable.scrollTop, scrollable.clientHeight, scrollable.scrollHeight);
        }

        strategy = 'pass3-window-scroll';
        const scrollingElement = document.scrollingElement || document.documentElement || document.body;
        return buildState(
            Number(scrollingElement?.scrollTop ?? window.scrollY ?? 0),
            Number(scrollingElement?.clientHeight ?? window.innerHeight ?? 1),
            Number(scrollingElement?.scrollHeight ?? document.documentElement?.scrollHeight ?? window.innerHeight ?? 1),
        );
    });
}

async function scrollConversationDown(page, batchMessages = DEFAULT_SCROLL_BATCH_MESSAGES) {
    const safeBatch = clampInteger(
        batchMessages,
        1,
        50,
        DEFAULT_SCROLL_BATCH_MESSAGES,
    );

    return page.evaluate((requestedBatch) => {
        const visible = (node) => {
            const rect = node?.getBoundingClientRect?.();
            return Boolean(rect && rect.height >= 8 && rect.width >= 8);
        };
        const unique = (nodes) => [...new Set(nodes || [])].filter(visible);
        const messageRoots = unique([
            ...document.querySelectorAll('.VirtualScrollItem[data-itemkey]'),
            ...document.querySelectorAll('[data-itemkey] > .ConvoHistory__messageBlock'),
            ...document.querySelectorAll('[role="list"][aria-label] > [role="listitem"] [data-itemkey]'),
            ...document.querySelectorAll('[data-cmid], [data-message-id], [data-msgid]'),
            ...document.querySelectorAll('[data-testid*="message"]'),
        ]);

        function isScrollable(node) {
            if (!node || node === document.body || node === document.documentElement) return false;
            const style = getComputedStyle(node);
            return node.scrollHeight > node.clientHeight + 40 && /auto|scroll/u.test(style.overflowY || '');
        }

        let scrollable = document.querySelector(
            '.ConvoHistory__scrollbar[data-scrollbar="scrollable"]',
        );
        let strategy = 'pass1-exact-scroll';
        if (!scrollable) {
            strategy = 'pass2-adaptive-scroll';
            const anchor = messageRoots[0] || document.querySelector(
                '[data-itemkey], [role="listitem"] article, [data-testid*="message"]',
            );
            let current = anchor?.parentElement || null;
            while (current && current !== document.body) {
                if (
                    current.getAttribute?.('data-scrollbar') === 'scrollable' ||
                    isScrollable(current)
                ) {
                    scrollable = current;
                    break;
                }
                current = current.parentElement;
            }
        }
        if (!scrollable) {
            strategy = 'pass3-heuristic-scroll';
            const regions = [...document.querySelectorAll('main, section, div')]
                .filter(isScrollable)
                .map((node) => {
                    const roleItems = node.querySelectorAll?.('[role="listitem"]')?.length || 0;
                    const keyedItems = node.querySelectorAll?.('[data-itemkey]')?.length || 0;
                    const timeNodes = node.querySelectorAll?.('time, [datetime], [aria-label*=":"]')?.length || 0;
                    const listBonus = node.querySelector?.('[role="list"]') ? 10 : 0;
                    const navPenalty = node.closest?.('nav, aside, [role="navigation"]') ? 30 : 0;
                    return {
                        node,
                        score: Math.min(keyedItems, 30) * 5 + Math.min(roleItems, 30) * 3 +
                            Math.min(timeNodes, 20) + listBonus - navPenalty,
                    };
                })
                .sort((left, right) => right.score - left.score);
            if (regions[0]?.score > 3) scrollable = regions[0].node;
        }

        const sample = messageRoots.slice(-Math.max(1, requestedBatch));
        const sampledHeight = sample.reduce((sum, node) => {
            const rect = node.getBoundingClientRect?.();
            return sum + Math.max(24, Number(rect?.height ?? 0));
        }, 0);

        function nudgeDown(target, viewportHeight) {
            const fallback = Math.max(320, viewportHeight * 0.55);
            const delta = Math.max(220, Math.min(
                viewportHeight * 0.95,
                sampledHeight || fallback,
            ));
            const before = target.scrollTop;
            const beforeHeight = target.scrollHeight;
            const beforeMaxTop = Math.max(0, beforeHeight - target.clientHeight);
            target.scrollTop = Math.min(beforeMaxTop, before + delta);
            target.dispatchEvent?.(new WheelEvent('wheel', {
                bubbles: true,
                cancelable: true,
                deltaY: Math.max(160, Math.round(delta)),
            }));
            const afterMaxTop = Math.max(0, target.scrollHeight - target.clientHeight);
            return {
                moved: target.scrollTop !== before,
                atBottom: target.scrollTop >= afterMaxTop - 2,
                requestedBatch,
                delta: Math.round(delta),
                strategy,
                beforeTop: Math.round(before),
                afterTop: Math.round(target.scrollTop),
                beforeHeight: Math.round(beforeHeight),
                afterHeight: Math.round(target.scrollHeight),
                beforeMaxTop: Math.round(beforeMaxTop),
                afterMaxTop: Math.round(afterMaxTop),
            };
        }

        if (scrollable && scrollable !== document.body && scrollable !== document.documentElement) {
            return nudgeDown(scrollable, Math.max(1, scrollable.clientHeight || window.innerHeight));
        }

        strategy = 'pass3-window-scroll';
        const scrollingElement = document.scrollingElement || document.documentElement || document.body;
        const before = Number(scrollingElement?.scrollTop ?? window.scrollY ?? 0);
        const viewportHeight = Number(scrollingElement?.clientHeight ?? window.innerHeight ?? 1);
        const fallback = Math.max(500, viewportHeight * 0.55);
        const delta = Math.max(300, Math.min(viewportHeight * 0.95, sampledHeight || fallback));
        const beforeHeight = Number(scrollingElement?.scrollHeight ?? document.documentElement?.scrollHeight ?? viewportHeight);
        const beforeMaxTop = Math.max(0, beforeHeight - viewportHeight);
        if (scrollingElement) scrollingElement.scrollTop = Math.min(beforeMaxTop, before + delta);
        else window.scrollBy(0, delta);
        window.dispatchEvent(new WheelEvent('wheel', {
            bubbles: true,
            cancelable: true,
            deltaY: Math.max(160, Math.round(delta)),
        }));
        const afterTop = Number(scrollingElement?.scrollTop ?? window.scrollY ?? 0);
        const afterHeight = Number(scrollingElement?.scrollHeight ?? document.documentElement?.scrollHeight ?? viewportHeight);
        const afterMaxTop = Math.max(0, afterHeight - viewportHeight);
        return {
            moved: afterTop !== before,
            atBottom: afterTop >= afterMaxTop - 2,
            requestedBatch,
            delta: Math.round(delta),
            strategy,
            beforeTop: Math.round(before),
            afterTop: Math.round(afterTop),
            beforeHeight: Math.round(beforeHeight),
            afterHeight: Math.round(afterHeight),
            beforeMaxTop: Math.round(beforeMaxTop),
            afterMaxTop: Math.round(afterMaxTop),
        };
    }, safeBatch);
}

function isTransientBrowserError(error) {
    const message = String(error?.message ?? error).toLowerCase();

    return [
        'execution context was destroyed',
        'target page, context or browser has been closed',
        'page has been closed',
        'browser has been closed',
        'frame was detached',
        'cannot find context',
        'navigation',
        'most likely the page has been closed',
        'вкладка беседы закрыта',
        'net::err_aborted',
        'err_network_changed',
        'err_connection_reset',
        'interrupted by another navigation',
        'timeout 30000ms exceeded',
        'timeout 90000ms exceeded',
    ].some((part) => message.includes(part));
}

function isConversationPage(page, conversationUrl) {
    try {
        // VK freely switches between /im?sel=c22 and
        // /im/convo/2000000022 for the same conversation. Comparing pathname
        // treats that redirect as a different page and can trigger needless
        // goto() loops. Compare the canonical peer id instead.
        const expectedPeerId = normalizeConversationUrl(conversationUrl).peerId;
        const actualPeerId = normalizeConversationUrl(page.url()).peerId;
        return expectedPeerId === actualPeerId;
    } catch {
        return false;
    }
}

async function waitForConversationReady(
    page,
    conversationUrl,
    timeoutMs = CONVERSATION_READY_TIMEOUT_MS,
) {
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        if (!page || page.isClosed()) {
            return false;
        }

        try {
            if (!isConversationPage(page, conversationUrl)) {
                await page.goto(conversationUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30_000,
                });
            }

            const count = await page.locator(
                '.ConvoHistory .VirtualScrollItem[data-itemkey], .ConvoHistory__messageBlock, [role="list"][aria-label] [role="listitem"], [data-cmid], [data-message-id], [data-msgid], .im-mess, [class*="ConvoMessage"], [class*="ConversationMessage"], [class*="MessageBase"], [class*="MessageItem"], [class*="MessageListItem"], [class*="ChatMessage"], [data-testid*="message"]',
            ).count();

            if (count > 0) {
                return true;
            }
        } catch (error) {
            if (!isTransientBrowserError(error)) {
                console.warn(
                    '[VK CHAT READY WAIT]',
                    String(error?.message ?? error),
                );
                return false;
            }
        }

        await sleep(1000);
    }

    return false;
}

async function extractRenderedMessagesWithRetry(
    page,
    conversationUrl,
    attempts = 5,
    { snapshotHtml = '' } = {},
) {
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        if (!page || page.isClosed()) {
            throw new Error('VK chat: вкладка беседы закрыта.');
        }

        try {
            // Snapshot mode is deliberately side-effect free: never navigate,
            // scroll, or re-read the live DOM while one immutable capture is
            // being evaluated by the three parser contours.
            if (!String(snapshotHtml || '').trim() && !isConversationPage(page, conversationUrl)) {
                await page.goto(conversationUrl, {
                    waitUntil: 'domcontentloaded',
                    timeout: 30_000,
                });
                const ready = await waitForConversationReady(
                    page,
                    conversationUrl,
                    CONVERSATION_READY_TIMEOUT_MS,
                );
                if (!ready) {
                    const error = new Error('VK chat: готовность беседы не подтверждена.');
                    error.code = 'VK_CHAT_NOT_READY';
                    throw error;
                }
            }

            return await extractRenderedMessages(page, conversationUrl, { snapshotHtml });
        } catch (error) {
            lastError = error;

            if (!isTransientBrowserError(error) || attempt >= attempts) {
                break;
            }

            await sleep(Math.min(2500, 350 * attempt));
        }
    }

    // A failed extraction is not an observed empty conversation. In particular,
    // browser timeouts must not be finalized downstream as zero events.
    if (lastError) {
        throw lastError;
    }

    const error = new Error('VK chat: извлечение сообщений не выполнено.');
    error.code = 'VK_CHAT_EXTRACTION_FAILED';
    throw error;
}

async function collectMessages({
    conversationUrl,
    targetCount,
    stopAtMessageId,
    dataDirectory,
    notifyAttention,
}) {
    const page = await openScraperPage({
        url: conversationUrl,
        source: 'VK chat',
        dataDirectory,
        notifyAttention,
        reuseKey: `vk-chat:${normalizeConversationUrl(conversationUrl).peerId}`,
    });

    try {
        /*
         * VK часто дорисовывает список сообщений заметно позже события
         * domcontentloaded. Даём интерфейсу загрузиться, после чего выполняем
         * первичный автоматический проход. Вкладку здесь намеренно не закрываем:
         * она передаётся постоянному live-наблюдателю ниже.
         */
        const ready = await waitForConversationReady(
            page,
            conversationUrl,
            CONVERSATION_READY_TIMEOUT_MS,
        );
        if (!ready) {
            const error = new Error('VK chat: готовность беседы не подтверждена.');
            error.code = 'VK_CHAT_NOT_READY';
            throw error;
        }
        const collected = new Map();
        let unchangedRounds = 0;
        let initialMinCmid = 0;
        let downSweepPerformed = false;
        let returnedToInitialFrontier = true;

        if (ready) {
            let downStallRounds = 0;
            for (let downRound = 0; downRound < 120; downRound += 1) {
                const messages = await extractRenderedMessagesWithRetry(page, conversationUrl);
                for (const message of messages) {
                    collected.set(message.conversationMessageId, message);
                }
                const stableCmids = messages
                    .filter((message) => message?.hasStableConversationMessageId)
                    .map((message) => Number(message?.conversationMessageId ?? 0))
                    .filter((value) => Number.isSafeInteger(value) && value > 0);
                if (!initialMinCmid && stableCmids.length) {
                    initialMinCmid = Math.min(...stableCmids);
                }

                const navigationState = await inspectConversationNavigationState(page).catch(() => null);
                const shouldSweepDown = Boolean(
                    downRound > 0 || navigationState?.canScrollDown || navigationState?.unreadHint
                );
                if (!shouldSweepDown || (navigationState?.atBottom && !navigationState?.canScrollDown)) break;

                const scroll = await scrollConversationDown(page).catch((error) => {
                    if (isTransientBrowserError(error)) return { moved: false, atBottom: true };
                    throw error;
                });
                if (scroll?.moved) {
                    downSweepPerformed = true;
                    returnedToInitialFrontier = false;
                    downStallRounds = 0;
                } else {
                    downStallRounds += 1;
                }
                console.log(
                    '[VK CHAT SCHEDULED DOWN SWEEP]',
                    `peer=${normalizeConversationUrl(conversationUrl).peerId}`,
                    `round=${downRound + 1}`,
                    `moved=${Boolean(scroll?.moved)}`,
                    `unread=${Number(navigationState?.unreadCount || 0)}`,
                );
                if (!scroll?.moved && (scroll?.atBottom || downStallRounds >= 3)) break;
                await sleep(700);
            }
        }

        for (let round = 0; round < 50; round += 1) {
            const messages = ready
                ? await extractRenderedMessagesWithRetry(page, conversationUrl)
                : [];
            const beforeSize = collected.size;

            for (const message of messages) {
                collected.set(message.conversationMessageId, message);
            }

            const sorted = [...collected.values()].sort((left, right) => (
                left.conversationMessageId - right.conversationMessageId ||
                left.createdAt - right.createdAt
            ));
            const reachedKnownMessage = stopAtMessageId > 0 && sorted.some(
                (message) => stableVkChatMessageId(message) > 0 &&
                    stableVkChatMessageId(message) <= stopAtMessageId,
            );
            if (downSweepPerformed && !returnedToInitialFrontier) {
                const visibleStableCmids = messages
                    .filter((message) => message?.hasStableConversationMessageId)
                    .map((message) => Number(message?.conversationMessageId ?? 0))
                    .filter((value) => Number.isSafeInteger(value) && value > 0);
                if (
                    (initialMinCmid > 0 && visibleStableCmids.length && Math.min(...visibleStableCmids) <= initialMinCmid) ||
                    (initialMinCmid <= 0 && round > 0)
                ) {
                    returnedToInitialFrontier = true;
                }
            }

            if ((collected.size >= targetCount || reachedKnownMessage) && returnedToInitialFrontier) {
                break;
            }

            if (!ready || !messages.length) {
                break;
            }

            unchangedRounds = collected.size === beforeSize
                ? unchangedRounds + 1
                : 0;

            let scroll;

            try {
                scroll = await scrollConversationUp(page);
            } catch (error) {
                if (isTransientBrowserError(error)) {
                    break;
                }
                throw error;
            }

            if (unchangedRounds >= 4 || (scroll.atTop && !scroll.moved)) {
                break;
            }

            await sleep(1000);
        }

        return {
            page,
            messages: [...collected.values()]
                .sort((left, right) => (
                    left.conversationMessageId - right.conversationMessageId ||
                    left.createdAt - right.createdAt
                ))
                .slice(-targetCount),
        };
    } catch (error) {
        await page.close().catch(() => {});
        throw error;
    }
}

function normalizeEventTime(value) {
    const source = String(value ?? '').trim();
    const match = source.match(/^([01]?\d|2[0-3]):([0-5]\d)$/u);
    return match
        ? `${String(match[1]).padStart(2, '0')}:${match[2]}`
        : null;
}

function normalizeAnnouncement(value, event, rawText, links = [], { includeFullMessage = true } = {}) {
    const source = paragraphizeEventText(value, 900)
        .replace(/\n+/gu, ' ')
        .trim();
    let sentences = source
        .split(/(?<=[.!?])\s+/u)
        .map((sentence) => sentence.trim())
        .filter(Boolean)
        .slice(0, 3);

    if (!sentences.length) {
        sentences = [
            trimText(rawText, 420) || String(event?.title ?? 'Событие'),
        ];
    }

    if (sentences.length === 1) {
        const details = [
            event?.venue ? `Место: ${event.venue}.` : '',
            event?.time ? `Начало в ${event.time}.` : '',
        ].filter(Boolean).join(' ');
        sentences.push(details || 'Подробности указаны в исходном сообщении.');
    }

    const shortAnnouncement = sentences.slice(0, 3).join(' ').slice(0, 900);
    const fullMessage = includeFullMessage ? paragraphizeEventText(rawText, 10_000) : '';
    const sourceLinks = uniqueStrings(links, 20);
    const sections = [shortAnnouncement];

    /*
     * GPT используется только для классификации и короткого резюме.
     * Полный исходный текст и ссылки добавляем локально, поэтому в базе и
     * итоговом анонсе не теряются детали сообщения.
     */
    if (fullMessage && fullMessage !== shortAnnouncement) {
        sections.push(`Полный текст сообщения:\n${fullMessage}`);
    }

    if (sourceLinks.length) {
        sections.push(`Ссылки из сообщения:\n${sourceLinks.join('\n')}`);
    }

    return sections.join('\n\n').slice(0, 12_000);
}

function normalizeAiEvents(aiResult, message, todayIso, rejectedEvents = []) {
    const sourceEvents = Array.isArray(aiResult)
        ? aiResult
        : Array.isArray(aiResult?.events)
            ? aiResult.events
            : [];
    // Poster-gate may be the sole source of a confirmed date when main AI
    // returned events without an additional visualText field.
    const posterGateFacts = message?.__posterGateVisionAttempted === true &&
        !String(message?.__posterGateError ?? '').trim()
        ? String(message?.__posterGateFacts ?? '')
        : '';
    const visualText = trimText(uniqueStrings([
        aiResult?.visualText ?? aiResult?.visual_text ?? '',
        posterGateFacts,
    ], 2).join('\n\n'), 8000);
    const validationSourceText = [
        trimText(message?.text, 12_000),
        visualText ? `[Текст/факты с изображений]\n${visualText}` : '',
    ].filter(Boolean).join('\n\n').slice(0, 18_000);
    const events = [];
    // The chat extractor returns structure metadata once per response (alongside
    // events). Keep that decision on every child row so a multi-announcement can
    // be repaired or audited without replaying the model response.
    const responseStructure = String(
        aiResult?.structure ?? aiResult?.structure_decision ?? '',
    ).trim();
    const responseStructureReason = trimText(
        aiResult?.structure_reason ?? aiResult?.structureReason ?? '',
        1000,
    );

    for (const event of sourceEvents) {
        const eventDate = String(
            event?.date ?? event?.eventDate ?? '',
        ).trim();

        if (!isCalendarIsoDate(eventDate)) {
            rejectedEvents.push({ event, reason: 'invalid-or-missing-event-date' });
            continue;
        }
        if (eventDate < todayIso) {
            rejectedEvents.push({ event, reason: 'event-date-before-today' });
            continue;
        }

        const title = trimText(
            event?.title || event?.name || '',
            500,
        );
        const venue = trimText(event?.venue || event?.place, 500);
        const participants = trimText(event?.participants, 1200);
        const price = trimText(event?.price, 500);
        const eventTime = normalizeEventTime(
            event?.time ?? event?.eventTime,
        );
        const sourceSegment = trimText(
            event?.source_segment ?? event?.sourceSegment ?? event?.segment ?? '',
            5000,
        );
        const announcement = trimText(event?.announcement ?? '', 5000);
        const structureDecision = String(
            event?.structure_decision ?? event?.structureDecision ?? event?.structure ?? responseStructure,
        ).trim();
        const structureReason = trimText(
            event?.structure_reason ?? event?.structureReason ?? responseStructureReason,
            1000,
        );
        const description = normalizeAnnouncement(
            sourceSegment || announcement || event?.description,
            {
                ...event,
                title,
                venue,
                time: eventTime,
            },
            validationSourceText,
            message.links,
            // A child card of a multi-announcement must contain its own AI
            // segment. The complete message remains in vk_chat_source_messages
            // for audit and must not be copied into every child description.
            { includeFullMessage: !(sourceSegment || announcement) },
        );

        const candidate = {
            title,
            eventDate,
            eventTime,
            venue,
            participants,
            price,
            description,
            announcement,
            sourceSegment,
            structureDecision,
            structureReason,
            programItems: Array.isArray(event?.program_items ?? event?.programItems)
                ? (event?.program_items ?? event?.programItems).slice(0, 64).map((item) => ({
                    time: trimText(item?.time, 32),
                    text: trimText(item?.text, 500),
                })).filter((item) => item.time || item.text)
                : [],
            isMultiAnnouncement: Number(
                event?.is_multi_announcement ?? event?.isMultiAnnouncement ??
                (structureDecision === 'multiple_events' ? 1 : 0),
            ) ? 1 : 0,
            evidence: trimText(event?.evidence, 600),
            imageIndexes: [...new Set((Array.isArray(event?.image_indexes)
                ? event.image_indexes
                : Array.isArray(event?.imageIndexes)
                    ? event.imageIndexes
                    : [])
                .map(Number)
                .filter((value) => Number.isInteger(value) && value >= 1 && value <= 12))],
            parseMethod: 'gpt_chat_live_v4',
            status: 'pending',
        };

        if (!isEventDateConsistentWithSource({
            eventDate,
            sourceText: validationSourceText,
            publishedAt: Number(message?.createdAt || 0),
            referenceNow: new Date(),
        })) {
            rejectedEvents.push({ event: candidate, reason: 'event-date-not-grounded-in-source' });
            continue;
        }

        const strict = explainStrictEventRecord(candidate, {
            sourceText: validationSourceText,
            requireEvidence: true,
        });
        if (strict.ok) {
            events.push(candidate);
        } else {
            rejectedEvents.push({ event: candidate, reason: `strict:${strict.reason}` });
        }
    }

    return events;
}

async function processMessage(message, {
    peerId,
    conversationUrl,
    conversationName,
    timeZone,
    dataDirectory,
    analyzeMessageWithAi,
    hydrateMessageEvidence = null,
    notifyAttention,
    traceAi = null,
    forceReprocess = false,
}) {
    const previous = getVkChatMessageMeta({
        peerId,
        conversationMessageId: message.conversationMessageId,
    });
    const refreshProvenance = () => {
        const wallLinks = uniqueStrings((message.links ?? []).filter((value) => /(?:[?&]w=|\/)wall-?\d+_\d+/iu.test(String(value))));
        if (message.hasRepostEvidence || message.embeddedText || message.repostText) {
            message.repostUrls = uniqueStrings([...(message.repostUrls ?? []), ...wallLinks]);
        }
        message.attachmentLinks = uniqueStrings([
            ...(message.attachmentLinks ?? []),
            ...(message.links ?? []).filter((value) => !(message.repostUrls ?? []).includes(value)),
        ]);
        message.provenance = resolveVkChatProvenance({
            peerId, conversationName, conversationMessageId: message.conversationMessageId,
            conversationUrl, text: message.text, repostUrls: message.repostUrls,
            attachmentLinks: message.attachmentLinks, links: message.links, sourceUrl: message.sourceUrl,
        });
        message.sourceUrl = message.provenance.canonicalPostUrl || '';
        traceAi?.('provenance', message.provenance);
        return message.provenance;
    };
    refreshProvenance();
    // Identity of a previous announcement requires the whole captured content,
    // including media and links; matching text alone can hide a new poster.
    const existingAnnouncement = Boolean(Number(previous?.eventCount ?? 0) > 0);
    const exactKnownAnnouncementContent = Boolean(
        existingAnnouncement &&
        typeof previous?.contentHash === 'string' &&
        previous.contentHash === hashMessage(message)
    );
    if (existingAnnouncement && !forceReprocess && exactKnownAnnouncementContent) {
        traceAi?.('database.skip', {
            reason: 'same-source-content-hash',
            eventCount: Number(previous.eventCount ?? 0),
        });
        return {
            changed: false,
            candidateChecked: false,
            eventCount: Number(previous.eventCount ?? 0),
        };
    }

    const rawDecision = explainVkChatEventCandidate(message);
    const rawVisualEvidence = Boolean(rawDecision.evidence?.hasPoster);
    const rawTextCandidate = rawDecision.candidate;
    const rawRepostEvidence = Boolean(message?.hasRepostEvidence) || hasVkChatRepostEvidence(message);

    // Cheap trash rejection must happen before VK API hydration and long before
    // AI. A normal chat line such as "Да, почитала уже" must finish here.
    // Repost evidence is allowed to reach API hydration because the saved DOM
    // can omit the inner wall text; a repost by itself is NOT enough to call AI.
    if (!rawTextCandidate && !rawVisualEvidence && !rawRepostEvidence) {
        appendEventIngestAudit({
            dataDirectory,
            sourceType: 'vk-chat',
            sourceKey: String(peerId),
            itemId: message.conversationMessageId,
            sourceUrl: message.sourceUrl || conversationUrl,
            status: 'skipped',
            reason: 'not-an-event-candidate-pre-hydration',
            rawText: message.text,
            details: {
                parserVersion: VK_CHAT_PARSER_VERSION,
                hasVisualEvidence: false,
                hasRepostEvidence: false,
            },
        });
        return {
            changed: false,
            candidateChecked: false,
            eventCount: 0,
        };
    }

    if (typeof hydrateMessageEvidence === 'function') {
        try {
            const evidence = await hydrateMessageEvidence({
                ...message,
                peerId,
                conversationUrl,
                conversationName,
            });
            if (evidence && typeof evidence === 'object') {
                message.imageUrls = uniqueStrings([
                    ...(message.imageUrls ?? []),
                    ...(Array.isArray(evidence.imageUrls) ? evidence.imageUrls : []),
                ], Number.MAX_SAFE_INTEGER);
                message.links = filterVkChatPublicMessageLinks(uniqueStrings([
                    ...(message.links ?? []),
                    ...(Array.isArray(evidence.links) ? evidence.links : []),
                ], 20));
                const embeddedText = cleanVkEventText(
                    evidence.embeddedText ?? '',
                    12_000,
                );
                if (embeddedText && !String(message.text ?? '').includes(embeddedText)) {
                    message.text = [
                        message.text,
                        `[Репост/вложенный пост VK — API]\n${embeddedText}`,
                    ].filter(Boolean).join('\n\n').slice(0, 12_000);
                }
                message.hasRepostEvidence = Boolean(
                    evidence.hasRepostEvidence || embeddedText,
                );
                message.richEvidenceHydrated = true;
                refreshProvenance();
            }
        } catch (error) {
            console.warn(
                '[VK CHAT EVIDENCE HYDRATE ERROR]',
                `peer=${peerId}`,
                `cmid=${message?.conversationMessageId ?? 0}`,
                formatErrorText(error),
            );
        }
    }


    const hydratedDecision = explainVkChatEventCandidate(message);
    const hasVisualEvidence = Boolean(hydratedDecision.evidence?.hasPoster);
    const hasRepostEvidence = Boolean(message?.hasRepostEvidence) || hasVkChatRepostEvidence(message);
    const textCandidate = Boolean(hydratedDecision.aiEligible);
    traceAi?.('prefilter.post-hydration', {
        candidate: hydratedDecision.candidate,
        aiEligible: hydratedDecision.aiEligible,
        score: hydratedDecision.score,
        reasons: hydratedDecision.reasons,
        evidence: hydratedDecision.evidence,
        aiAdmission: hydratedDecision.aiAdmission,
    });

    // Hydration/repost recovery is cheap evidence recovery. The expensive main-AI
    // stage is stricter: either the recovered BODY or the post-capture poster gate
    // must contain a usable event title/participants plus a today/future event date.
    // Poster presence alone is never enough; the poster must have been read and admitted.
    if (!textCandidate) {
        appendEventIngestAudit({
            dataDirectory,
            sourceType: 'vk-chat',
            sourceKey: String(peerId),
            itemId: message.conversationMessageId,
            sourceUrl: message.sourceUrl || conversationUrl,
            status: 'skipped',
            reason: hydratedDecision.aiAdmission?.rejectionReason || (
                hasRepostEvidence
                    ? 'repost-hydrated-without-strict-ai-evidence'
                    : 'not-an-ai-candidate-post-hydration'
            ),
            rawText: message.text,
            details: {
                parserVersion: VK_CHAT_PARSER_VERSION,
                hasVisualEvidence,
                hasRepostEvidence,
                textCandidate,
                aiAdmission: hydratedDecision.aiAdmission,
            },
        });
        return {
            changed: false,
            candidateChecked: false,
            eventCount: 0,
        };
    }

    let aiEvents = [];

    try {
        traceAi?.('pipeline.start', {
            hasTextCandidate: textCandidate,
            hasVisualEvidence,
            hasRepostEvidence,
            imageCount: Array.isArray(message?.imageUrls) ? message.imageUrls.length : 0,
        });
        const aiStartedAt = Date.now();
        aiEvents = await analyzeMessageWithAi({
            ...message,
            peerId,
            conversationUrl,
            conversationName,
            __aiTrace: traceAi,
        });
        // A failed adapter must not become a successful empty-event response.
        assertResolvedVkChatAiResult(aiEvents);
        traceAi?.('pipeline.finish', {
            durationMs: Math.max(0, Date.now() - aiStartedAt),
            resultCount: Array.isArray(aiEvents)
                ? aiEvents.length
                : (Array.isArray(aiEvents?.events) ? aiEvents.events.length : 0),
        });

        /*
         * AI-adapter может дополнительно гидратировать VK message/repost через
         * API и вернуть картинки/текст, которых браузерный DOM не показал.
         * Подмешиваем эти факты ДО строгой валидации и сохранения в БД.
         */
        if (aiEvents && !Array.isArray(aiEvents) && typeof aiEvents === 'object') {
            const resolvedImages = uniqueStrings([
                ...(message.imageUrls ?? []),
                ...(Array.isArray(aiEvents.resolvedImageUrls) ? aiEvents.resolvedImageUrls : []),
            ], Number.MAX_SAFE_INTEGER);
            const resolvedLinks = filterVkChatPublicMessageLinks(uniqueStrings([
                ...(message.links ?? []),
                ...(Array.isArray(aiEvents.resolvedLinks) ? aiEvents.resolvedLinks : []),
            ], 20));
            const resolvedEmbeddedText = cleanVkEventText(
                aiEvents.resolvedEmbeddedText ?? '',
                12_000,
            );

            message.imageUrls = resolvedImages;
            message.links = resolvedLinks;
            if (resolvedEmbeddedText && !String(message.text ?? '').includes(resolvedEmbeddedText)) {
                message.text = [
                    message.text,
                    `[Репост/вложенный пост VK — API]\n${resolvedEmbeddedText}`,
                ].filter(Boolean).join('\n\n').slice(0, 12_000);
                message.hasRepostEvidence = true;
            }
            refreshProvenance();
        }
    } catch (error) {
        traceAi?.('pipeline.error', {
            error: String(error?.message ?? error ?? '').slice(0, 1600),
        });
        if (error && typeof error === 'object') {
            error.vkChatStage = 'gpt';
        }
        throw error;
    }

    const todayIso = currentIsoDate(timeZone);
    const rejectedEvents = [];
    const posterBindingAudit = [];
    const aiRawEvents = Array.isArray(aiEvents)
        ? aiEvents
        : Array.isArray(aiEvents?.events)
            ? aiEvents.events
            : [];
    let events = normalizeAiEvents(aiEvents, message, todayIso, rejectedEvents);
    const fetchedAt = Math.floor(Date.now() / 1000);

    if (events.length) {
        const imageFacts = trimText(
            (!Array.isArray(aiEvents) && aiEvents && typeof aiEvents === 'object'
                ? (aiEvents.visualText ?? aiEvents.visual_text ?? '')
                : '') || message.__posterGateFacts || '',
            12_000,
        );
        events = assignEventImageIndexesFromFacts(events, imageFacts, {
            onAudit: ({ event, imageIndex, accepted, reason, score, imageType, poster, posterConfidence, textReadability, facts }) => {
                const row = {
                    eventDate: event?.eventDate || '', title: event?.title || '', imageIndex,
                    accepted: Boolean(accepted), reason, score: Number(score || 0), imageType: imageType || '',
                    poster, posterConfidence, textReadability, facts: facts || null,
                };
                posterBindingAudit.push(row);
                console.log('[EVENT POSTER MATCH]', `chat=${peerId}/${message.conversationMessageId}`, `event=${event?.eventDate || '?'} ${String(event?.title || '').slice(0, 80)}`, `image=${imageIndex || 'none'}`, accepted ? `accepted:${reason}` : `rejected:${reason}`, `score=${Number(score || 0)}`);
                traceAi?.('poster.binding', row);
            },
        });
        events = applyPosterDerivedVenueFallback(events);
        events = await prepareEventImages({
            events,
            sourceKey: `vk-chat-${peerId}`,
            itemId: message.conversationMessageId,
            imageUrls: message.imageUrls,
            dataDirectory,
            targetFolder: 'vk_chat_announcements',
            sourceLabel: conversationName,
            notifyAttention,
            shareSourceImagesAcrossEvents: true,
        });
        events = filterEventsWithAnnouncementImages(events, {
            onRejected: (event, reason) => rejectedEvents.push({ event, reason }),
        });
    }

    const previousImagePaths = (() => {
        try {
            const parsed = JSON.parse(String(previous?.imagePathsJson ?? '[]'));
            return Array.isArray(parsed) ? uniqueStrings(parsed) : [];
        } catch {
            return [];
        }
    })();
    const preserveStoredEvents = shouldPreserveStoredEventsOnEmptyReparse({
        previousEventCount: previous?.eventCount,
        acceptedEventCount: events.length,
    });
    const imagePaths = preserveStoredEvents
        ? previousImagePaths
        : uniqueStrings(events.flatMap((event) => (
            Array.isArray(event?._sourceImagePaths) && event._sourceImagePaths.length
                ? event._sourceImagePaths
                : event?.imagePaths ?? []
        )));
    const effectiveEventCount = preserveStoredEvents
        ? Number(previous?.eventCount ?? 0)
        : events.length;
    const parsedImageVisionFacts = parseIndexedImageFacts((!Array.isArray(aiEvents) && aiEvents && typeof aiEvents === 'object' ? (aiEvents.visualText ?? aiEvents.visual_text ?? '') : '') || message.__posterGateFacts || '');
    const sourcePathsForAudit = uniqueStrings(events.flatMap((event) => Array.isArray(event?._sourceImagePaths) ? event._sourceImagePaths : []));
    const sourceMediaAudit = (Array.isArray(message.imageUrls) ? message.imageUrls : []).map((url, offset) => {
        const imageIndex = offset + 1;
        const original = (Array.isArray(message.imageMedia) ? message.imageMedia : []).find((item) => String(item?.url || '') === String(url || '')) || {};
        const localPath = sourcePathsForAudit.find((value) => new RegExp(`-${imageIndex}\\.[^.]+$`, 'u').test(String(value))) || '';
        const candidates = posterBindingAudit.filter((item) => Number(item?.imageIndex || 0) === imageIndex);
        const selectedEvents = candidates.filter((item) => item.accepted).map((item) => ({ eventDate: item.eventDate, title: item.title, score: item.score, reason: item.reason }));
        const vision = parsedImageVisionFacts.find((item) => Number(item?.index || 0) === imageIndex) || null;
        return {
            ...original, imageIndex, url: String(url || ''), localPath, vision,
            bindingCandidates: candidates.map((item) => ({ eventDate: item.eventDate, title: item.title, accepted: item.accepted, score: item.score, reason: item.reason })),
            selectedEvents,
            finalVerdict: selectedEvents.length ? 'selected-poster' : vision?.poster === false ? 'rejected-not-poster' : vision?.poster === true ? 'poster-not-matched-to-event' : 'unclassified',
        };
    });
    traceAi?.('vision.response', { responseText: ((!Array.isArray(aiEvents) && aiEvents && typeof aiEvents === 'object' ? (aiEvents.visualText ?? aiEvents.visual_text ?? '') : '') || message.__posterGateFacts || ''), parsedFacts: parsedImageVisionFacts });
    traceAi?.('media.audit', { media: sourceMediaAudit, eventResults: events.map((event) => ({ eventDate: event?.eventDate || '', title: event?.title || '', posterImageIndex: Number(event?.posterImageIndex || 0), posterMatchStatus: event?.posterMatchStatus || '', imagePaths: Array.isArray(event?.imagePaths) ? event.imagePaths : [] })) });

    // Hash and provenance describe the final hydrated source-message stored below.
    // The pre-AI ledger hash intentionally describes the original DOM capture.
    const provenanceForStorage = refreshProvenance();
    const contentHash = hashMessage(message);
    persistVkChatSourceAndEvents({ source: {
        peerId,
        conversationMessageId: message.conversationMessageId,
        conversationUrl,
        conversationName,
        senderId: message.senderId,
        createdAt: message.createdAt,
        rawText: message.text,
        links: message.links,
        repostUrls: message.repostUrls,
        attachmentLinks: message.attachmentLinks,
        imageUrls: message.imageUrls,
        imagePaths,
        imageMedia: sourceMediaAudit.length ? sourceMediaAudit : (Array.isArray(message.imageMedia) ? message.imageMedia : []),
        imageVisionFacts: parsedImageVisionFacts,
        provenance: provenanceForStorage,
        contentHash,
        parseStatus: effectiveEventCount ? 'event' : 'not_event',
        fetchedAt,
    }, replacement: preserveStoredEvents ? null : {
        peerId,
        conversationMessageId: message.conversationMessageId,
        sourceUrl: message.sourceUrl,
        imagePaths,
        events,
        updatedAt: fetchedAt,
        provenance: provenanceForStorage,
    }});

    traceAi?.('database.write', {
        sourceTable: 'vk_chat_source_messages',
        eventTable: 'vk_chat_events',
        peerId,
        conversationMessageId: message.conversationMessageId,
        effectiveEventCount,
        acceptedEventCount: events.length,
        preserveStoredEvents,
        imagePathCount: imagePaths.length,
        eventIds: events.map((event, index) => ({ index, date: event?.eventDate || '', title: String(event?.title || '').slice(0, 160) })),
    });

    traceAi?.('validation.finish', {
        aiRawCount: aiRawEvents.length,
        acceptedCount: events.length,
        preserveStoredEvents,
        rejected: rejectedEvents.map(({ event, reason }) => ({
            title: String(event?.title ?? event?.name ?? '').slice(0, 160),
            eventDate: String(event?.eventDate ?? event?.date ?? ''),
            reason,
        })),
    });

    appendEventIngestAudit({
        dataDirectory,
        sourceType: 'vk-chat',
        sourceKey: String(peerId),
        itemId: message.conversationMessageId,
        sourceUrl: message.sourceUrl || conversationUrl,
        status: effectiveEventCount ? 'stored-event' : 'rejected-or-not-event',
        reason: preserveStoredEvents
            ? 'preserved-existing-events-after-empty-reparse'
            : events.length
                ? 'stored-in-vk_chat_events'
            : aiRawEvents.length
                ? 'ai-events-rejected-by-final-validation'
                : 'candidate-produced-no-events',
        rawText: message.text,
        details: {
            parserVersion: VK_CHAT_PARSER_VERSION,
            hasVisualEvidence,
            hasRepostEvidence,
            aiRawCount: aiRawEvents.length,
            acceptedCount: events.length,
            preserveStoredEvents,
            rejectedEvents: rejectedEvents.map(({ event, reason }) => ({
                title: String(event?.title ?? event?.name ?? ''),
                eventDate: String(event?.eventDate ?? event?.date ?? ''),
                venue: String(event?.venue ?? event?.place ?? ''),
                reason,
            })),
        },
    });

    return {
        changed: true,
        candidateChecked: true,
        eventCount: effectiveEventCount,
        eventsCreatedCount: Number(previous?.eventCount || 0) > 0 ? 0 : effectiveEventCount,
        eventsUpdatedCount: Number(previous?.eventCount || 0) > 0 ? effectiveEventCount : 0,
        visionCheckedImageCount: parsedImageVisionFacts.length,
        posterMatchAcceptedCount: posterBindingAudit.filter((item) => item?.accepted).length,
        posterMatchRejectedCount: posterBindingAudit.filter((item) => !item?.accepted).length,
    };
}

export function createVkChatEventScraper({
    conversationUrl: conversationUrlInput,
    conversationName,
    dataDirectory,
    initialMessages = 300,
    intervalHours = 1,
    timeZone = 'Europe/Moscow',
    analyzeMessageWithAi,
    hydrateMessageEvidence = null,
    notifyAttention = null,
    liveMonitor = true,
    livePollMs = DEFAULT_LIVE_POLL_MS,
    postScanHoldMs = DEFAULT_POST_SCAN_HOLD_MS,
    scrollBatchMessages = DEFAULT_SCROLL_BATCH_MESSAGES,
    scrollBatchDelayMs = DEFAULT_SCROLL_BATCH_DELAY_MS,
    autoScrollMessages = 0,
    onManualSessionClosed = null,
} = {}) {
    const conversation = normalizeConversationUrl(conversationUrlInput);
    const peerId = conversation.peerId;
    const conversationUrl = conversation.url;
    const safeName = trimText(
        conversationName || `VK-беседа ${peerId}`,
        200,
    );
    const safeInitialMessages = clampInteger(
        initialMessages,
        20,
        5000,
        300,
    );
    const intervalMs = clampInteger(
        Number(intervalHours) * ONE_HOUR_MS,
        ONE_HOUR_MS,
        30 * 24 * ONE_HOUR_MS,
        ONE_HOUR_MS,
    );
    const safeDataDirectory = String(dataDirectory ?? '').trim();
    const liveMonitorEnabled = Boolean(liveMonitor);
    const safeLivePollMs = clampInteger(
        livePollMs,
        500,
        10_000,
        DEFAULT_LIVE_POLL_MS,
    );
    const safePostScanHoldMs = clampInteger(
        postScanHoldMs,
        DEFAULT_POST_SCAN_HOLD_MS,
        60 * 60 * 1000,
        DEFAULT_POST_SCAN_HOLD_MS,
    );
    const safeScrollBatchMessages = clampInteger(
        scrollBatchMessages,
        1,
        50,
        DEFAULT_SCROLL_BATCH_MESSAGES,
    );
    const parsedAutoScrollMessages = clampInteger(
        autoScrollMessages,
        0,
        500,
        0,
    );
    // Generic history-backfill policy: enabling automatic history scrolling for
    // ANY chat means at least fifty genuinely older messages, never a special
    // parser branch for one peer id. Source configuration decides which chats
    // enable the feature.
    const safeAutoScrollMessages = parsedAutoScrollMessages > 0
        ? Math.max(MIN_HISTORY_BACKFILL_MESSAGES, parsedAutoScrollMessages)
        : 0;
    const historyBackfillEnabled = safeAutoScrollMessages > 0;
    const safeScrollBatchDelayMs = clampInteger(
        scrollBatchDelayMs,
        300,
        10_000,
        historyBackfillEnabled ? HISTORY_BACKFILL_SCROLL_DELAY_MS : DEFAULT_SCROLL_BATCH_DELAY_MS,
    );
    let livePage = null;
    let liveMonitorPromise = null;
    let liveMonitorActive = false;
    let manualSessionActive = false;
    let messageProcessingQueue = Promise.resolve();
    let pageOperationQueue = Promise.resolve();
    let progressiveBackfillPromise = null;
    let manualCloseNotificationSent = false;
    let lastMediaSettleAt = 0;
    let lastLoggedParserPass = '';
    const queuedFingerprints = new Map();

    if (!safeDataDirectory) {
        throw new Error('Для VK chat-парсера не указана папка data.');
    }

    if (typeof analyzeMessageWithAi !== 'function') {
        throw new Error('Для VK chat-парсера не передан AI-классификатор.');
    }

    function withPageOperation(task) {
        const operation = pageOperationQueue.then(task, task);
        pageOperationQueue = operation.catch(() => {});
        return operation;
    }

    function logParserPass(rendered, origin) {
        const pass = String(rendered?.parserPass ?? '').trim();
        if (!pass || pass === lastLoggedParserPass) return;
        lastLoggedParserPass = pass;
        console.log(
            '[VK CHAT PARSER PASS]',
            `peer=${peerId}`,
            `pass=${pass}`,
            `origin=${origin}`,
            `details=${String(rendered?.parserReason ?? '').slice(0, 500)}`,
        );
    }

    function rememberFingerprint(message) {
        const key = Number(message?.conversationMessageId ?? 0);
        const fingerprint = hashMessage(message);

        if (queuedFingerprints.get(key) === fingerprint) {
            return false;
        }

        queuedFingerprints.set(key, fingerprint);

        while (queuedFingerprints.size > MAX_LIVE_FINGERPRINTS) {
            const oldestKey = queuedFingerprints.keys().next().value;
            queuedFingerprints.delete(oldestKey);
        }

        return true;
    }

    function queueMessagesForProcessing(messages, origin = 'live') {
        const freshMessages = (Array.isArray(messages) ? messages : [])
            .filter((message) => rememberFingerprint(message))
            .sort((left, right) => (
                left.conversationMessageId - right.conversationMessageId ||
                left.createdAt - right.createdAt
            ));

        if (!freshMessages.length) {
            return Promise.resolve({
                fetchedMessages: 0,
                changedMessages: 0,
                candidatesChecked: 0,
                eventsFound: 0,
                lastMessageId: 0,
                failedItems: 0,
            });
        }

        const batch = messageProcessingQueue.then(async () => {
            let changedMessages = 0;
            let candidatesChecked = 0;
            let eventsFound = 0;
            let lastMessageId = 0;
            let failedItems = 0;

            for (const message of freshMessages) {
                try {
                    const result = await processLiveMessage(message);
                    if (result.changed) changedMessages += 1;
                    if (result.candidateChecked) candidatesChecked += 1;
                    eventsFound += result.eventCount;
                    lastMessageId = Math.max(
                        lastMessageId,
                        stableVkChatMessageId(message),
                    );
                } catch (error) {
                    failedItems += 1;
                    /*
                     * Не удаляем fingerprint после ошибки. Иначе один и тот же
                     * видимый DOM-элемент заново отправляется в GPT каждые
                     * 500 мс и создаёт бесконечный поток одинаковых ошибок.
                     * При следующем ручном запуске карта очищается и сообщение
                     * можно будет проверить повторно.
                     */
                    console.error(
                        error?.vkChatStage === 'gpt'
                            ? '[VK CHAT GPT ERROR]'
                            : '[VK CHAT LIVE MESSAGE ERROR]',
                        `peer=${peerId}`,
                        `cmid=${message.conversationMessageId}`,
                        `origin=${origin}`,
                        formatErrorText(error),
                    );
                }

                await sleep(80);
            }

            if (candidatesChecked || eventsFound) {
                console.log(
                    '[VK CHAT LIVE BATCH]',
                    `peer=${peerId}`,
                    `origin=${origin}`,
                    `visible=${freshMessages.length}`,
                    `checked=${candidatesChecked}`,
                    `events=${eventsFound}`,
                );
            }

            return {
                fetchedMessages: freshMessages.length,
                changedMessages,
                candidatesChecked,
                eventsFound,
                lastMessageId,
                failedItems,
            };
        });

        messageProcessingQueue = batch.catch(() => {});
        return batch;
    }


    async function notifyManualSessionClosed(reason = 'page-closed') {
        if (manualCloseNotificationSent) return;
        manualCloseNotificationSent = true;

        try {
            await messageProcessingQueue.catch(() => {});
        } catch {
            // Очередь уже логирует ошибки отдельных сообщений.
        }

        console.log(
            '[VK CHAT PARSING FINISHED]',
            `peer=${peerId}`,
            `reason=${reason}`,
            'Финал парсинга наступает только после закрытия вкладки/остановки сессии.',
        );

        if (typeof onManualSessionClosed === 'function') {
            try {
                await onManualSessionClosed({
                    peerId,
                    conversationName: safeName,
                    reason,
                });
            } catch (error) {
                console.error(
                    '[VK CHAT AFTER CLOSE ERROR]',
                    `peer=${peerId}`,
                    formatErrorText(error),
                );
            }
        }
    }

    async function sweepUnreadTailForManualSession() {
        if (!manualSessionActive || !livePage || livePage.isClosed()) {
            return { moved: false, captured: 0, returnedToFrontier: true };
        }

        const captured = new Map();
        let initialMinCmid = 0;
        let movedDown = false;
        let returnedToFrontier = true;
        let unreadCount = 0;
        let downStallRounds = 0;

        const captureVisible = async () => {
            const rendered = await withPageOperation(() =>
                extractRenderedMessagesWithRetry(livePage, conversationUrl),
            );
            const stableCmids = rendered
                .filter((message) => message?.hasStableConversationMessageId)
                .map((message) => Number(message?.conversationMessageId ?? 0))
                .filter((value) => Number.isSafeInteger(value) && value > 0);
            if (!initialMinCmid && stableCmids.length) {
                initialMinCmid = Math.min(...stableCmids);
            }
            for (const message of rendered) {
                const key = Number(message?.conversationMessageId ?? 0);
                if (key) captured.set(key, message);
            }
            return { rendered, stableCmids };
        };

        const initial = await captureVisible();
        const initialNavigationState = await withPageOperation(() =>
            inspectConversationNavigationState(livePage),
        ).catch(() => null);
        unreadCount = Number(initialNavigationState?.unreadCount || 0);
        const shouldSweepDown = Boolean(
            initialNavigationState?.canScrollDown || initialNavigationState?.unreadHint
        );

        if (shouldSweepDown) {
            for (let round = 0; round < 160; round += 1) {
                if (!manualSessionActive || !livePage || livePage.isClosed()) break;
                const navigationState = round === 0
                    ? initialNavigationState
                    : await withPageOperation(() => inspectConversationNavigationState(livePage)).catch(() => null);
                unreadCount = Math.max(unreadCount, Number(navigationState?.unreadCount || 0));
                if (navigationState?.atBottom && !navigationState?.canScrollDown) break;

                const scroll = await withPageOperation(() =>
                    scrollConversationDown(livePage, safeScrollBatchMessages),
                ).catch((error) => {
                    if (isTransientBrowserError(error)) return { moved: false, atBottom: true };
                    throw error;
                });
                if (scroll?.moved) {
                    movedDown = true;
                    returnedToFrontier = false;
                    downStallRounds = 0;
                } else {
                    downStallRounds += 1;
                }
                if (!scroll?.moved && (scroll?.atBottom || downStallRounds >= 3)) break;
                await sleep(Math.min(700, safeScrollBatchDelayMs));
                await captureVisible();
                if (scroll?.atBottom) break;
            }
        }

        if (movedDown) {
            let upStallRounds = 0;
            for (let round = 0; round < 160; round += 1) {
                if (!manualSessionActive || !livePage || livePage.isClosed()) break;
                const current = await captureVisible();
                if (
                    initialMinCmid > 0 &&
                    current.stableCmids.length &&
                    Math.min(...current.stableCmids) <= initialMinCmid
                ) {
                    returnedToFrontier = true;
                    break;
                }

                const scroll = await withPageOperation(() =>
                    scrollConversationUp(livePage, safeScrollBatchMessages),
                ).catch((error) => {
                    if (isTransientBrowserError(error)) return { moved: false, atTop: true };
                    throw error;
                });
                if (scroll?.moved) upStallRounds = 0;
                else upStallRounds += 1;
                if (!initialMinCmid && scroll?.moved) returnedToFrontier = true;
                if ((scroll?.atTop && !scroll?.moved) || upStallRounds >= 3) break;
                await sleep(Math.min(700, safeScrollBatchDelayMs));
            }
        }

        const messages = [...captured.values()].sort((left, right) => (
            Number(left?.conversationMessageId ?? 0) - Number(right?.conversationMessageId ?? 0) ||
            Number(left?.createdAt ?? 0) - Number(right?.createdAt ?? 0)
        ));
        if (messages.length) {
            await queueMessagesForProcessing(messages, 'manual-unread-down-up');
        }
        console.log(
            '[VK CHAT MANUAL DOWN-UP SWEEP]',
            `peer=${peerId}`,
            `requested=${shouldSweepDown}`,
            `moved=${movedDown}`,
            `unread=${unreadCount}`,
            `captured=${messages.length}`,
            `returnedToFrontier=${returnedToFrontier}`,
        );
        return {
            moved: movedDown,
            captured: messages.length,
            unreadCount,
            initialMinCmid,
            returnedToFrontier,
        };
    }

    function startProgressiveBackfill() {
        if (!historyBackfillEnabled) {
            console.log(
                '[VK CHAT AUTO SCROLL SKIP]',
                `peer=${peerId}`,
                'mode=manual-only',
            );
            return null;
        }

        if (progressiveBackfillPromise || !manualSessionActive) {
            return progressiveBackfillPromise;
        }

        progressiveBackfillPromise = (async () => {
            const seen = new Set();
            let initialSnapshotCaptured = false;
            let initialMinCmid = 0;
            let loaded = 0;
            let backfilledOlder = 0;
            let unchangedRounds = 0;
            let topStallRounds = 0;
            let round = 0;
            const progressiveStartedAt = Date.now();

            while (
                manualSessionActive &&
                livePage &&
                !livePage.isClosed() &&
                backfilledOlder < safeAutoScrollMessages &&
                round < Math.max(18, Math.ceil(safeAutoScrollMessages / safeScrollBatchMessages) * 8)
            ) {
                round += 1;

                let rendered = [];
                try {
                    rendered = await withPageOperation(() =>
                        extractRenderedMessagesWithRetry(
                            livePage,
                            conversationUrl,
                            5,
                            {},
                        ),
                    );
                } catch (error) {
                    if (isTransientBrowserError(error)) break;
                    throw error;
                }
                logParserPass(rendered, 'progressive-backfill');

                if (!initialSnapshotCaptured && rendered.length > 0) {
                    const stableCmids = rendered
                        .filter((message) => message?.hasStableConversationMessageId)
                        .map((message) => Number(message?.conversationMessageId ?? 0))
                        .filter((value) => Number.isSafeInteger(value) && value > 0);
                    if (stableCmids.length) {
                        initialMinCmid = Math.min(...stableCmids);
                        initialSnapshotCaptured = true;
                        console.log(
                            '[VK CHAT HISTORY INITIAL FRONTIER]',
                            `peer=${peerId}`,
                            `visible=${rendered.length}`,
                            `initialMinCmid=${initialMinCmid}`,
                            `requiredOlder=${safeAutoScrollMessages}`,
                        );
                    }
                }

                if (!initialSnapshotCaptured) {
                    // Synthetic ids are fine for message processing but cannot
                    // prove historical direction. Wait for a stable data-itemkey/
                    // cmid window instead of counting arbitrary virtual redraws.
                    unchangedRounds += 1;
                    await sleep(HISTORY_BACKFILL_SCROLL_DELAY_MS);
                    continue;
                }

                const newlyRendered = rendered
                    .filter((message) => {
                        const key = Number(message?.conversationMessageId ?? 0);
                        if (!key || seen.has(key)) return false;
                        seen.add(key);
                        return true;
                    })
                    .sort((left, right) => (
                        left.conversationMessageId - right.conversationMessageId ||
                        left.createdAt - right.createdAt
                    ));

                const newlyBackfilledOlder = newlyRendered.filter((message) => (
                    message?.hasStableConversationMessageId &&
                    Number(message?.conversationMessageId ?? 0) > 0 &&
                    Number(message.conversationMessageId) < initialMinCmid
                )).length;

                if (newlyRendered.length) {
                    unchangedRounds = 0;
                    topStallRounds = 0;
                    loaded += newlyRendered.length;
                    backfilledOlder += newlyBackfilledOlder;

                    for (let offset = 0; offset < newlyRendered.length; offset += safeScrollBatchMessages) {
                        if (!manualSessionActive || !livePage || livePage.isClosed()) break;
                        const chunk = newlyRendered.slice(offset, offset + safeScrollBatchMessages);
                        await queueMessagesForProcessing(chunk, 'history-backfill');
                        console.log(
                            '[VK CHAT AUTO SCROLL BATCH]',
                            `peer=${peerId}`,
                            `batch=${chunk.length}`,
                            `newOlder=${newlyBackfilledOlder}`,
                            `older=${Math.min(backfilledOlder, safeAutoScrollMessages)}/${safeAutoScrollMessages}`,
                        );
                    }
                } else {
                    unchangedRounds += 1;
                }

                if (
                    !manualSessionActive ||
                    !livePage ||
                    livePage.isClosed() ||
                    backfilledOlder >= safeAutoScrollMessages
                ) {
                    break;
                }

                let scroll = { moved: false, atTop: false };
                try {
                    scroll = await withPageOperation(() => scrollConversationUp(livePage, safeScrollBatchMessages));
                } catch (error) {
                    if (isTransientBrowserError(error)) break;
                    throw error;
                }

                if (scroll.atTop && !scroll.moved) {
                    topStallRounds += 1;
                } else {
                    topStallRounds = 0;
                }
                const confirmedTop = topStallRounds >= 4 && (
                    Date.now() - progressiveStartedAt >= HISTORY_BACKFILL_INITIAL_CAPTURE_GRACE_MS
                );
                if (confirmedTop || unchangedRounds >= 20) {
                    break;
                }

                await sleep(Math.max(HISTORY_BACKFILL_SCROLL_DELAY_MS, safeScrollBatchDelayMs));
                if (livePage && !livePage.isClosed()) {
                    await withPageOperation(() => settleScraperPage({
                        page: livePage,
                        source: `VK chat ${safeName} history-backfill`,
                        scrollSteps: 0,
                        mediaWaitMs: 3_000,
                    })).catch(() => {});
                    lastMediaSettleAt = Date.now();
                }
            }

            console.log(
                '[VK CHAT AUTO SCROLL DONE]',
                `peer=${peerId}`,
                `uniqueLoaded=${loaded}`,
                `olderLoaded=${backfilledOlder}/${safeAutoScrollMessages}`,
                `initialMinCmid=${initialMinCmid || 0}`,
                `tabStillOpen=${Boolean(livePage && !livePage.isClosed())}`,
                'liveMonitorContinues=true',
            );
        })()
            .catch((error) => {
                console.error(
                    '[VK CHAT AUTO SCROLL ERROR]',
                    `peer=${peerId}`,
                    formatErrorText(error),
                );
            })
            .finally(() => {
                progressiveBackfillPromise = null;
            });

        return progressiveBackfillPromise;
    }

    async function openLivePage() {
        const page = await openScraperPage({
            url: conversationUrl,
            source: `VK chat ${safeName}`,
            dataDirectory: safeDataDirectory,
            notifyAttention,
            reuseKey: `vk-chat:${peerId}`,
        });
        const ready = await waitForConversationReady(
            page,
            conversationUrl,
            CONVERSATION_READY_TIMEOUT_MS,
        );
        if (!ready) {
            await page.close().catch(() => {});
            const error = new Error('VK chat: готовность беседы не подтверждена.');
            error.code = 'VK_CHAT_NOT_READY';
            throw error;
        }
        await settleScraperPage({
            page,
            source: `VK chat ${safeName}`,
            scrollSteps: 0,
            mediaWaitMs: 5_000,
        }).catch(() => {});
        lastMediaSettleAt = Date.now();
        livePage = page;
        console.log(
            '[VK CHAT LIVE OPEN]',
            `peer=${peerId}`,
            'Вкладка оставлена открытой для ручной прокрутки.',
        );
        return page;
    }

    function startLiveMonitor(initialPage = null) {
        if (!liveMonitorEnabled) {
            return null;
        }

        liveMonitorActive = true;
        manualSessionActive = true;

        if (initialPage && !initialPage.isClosed()) {
            livePage = initialPage;
        }

        if (liveMonitorPromise) {
            return liveMonitorPromise;
        }

        liveMonitorPromise = (async () => {
            while (liveMonitorActive) {
                /*
                 * Ручная сессия открывает вкладку ровно один раз. Если
                 * пользователь закрыл вкладку, окно или весь браузер, наблюдение
                 * просто завершается. Никаких автоматических повторных открытий.
                 */
                if (!livePage || livePage.isClosed()) {
                    manualSessionActive = false;
                    liveMonitorActive = false;
                    livePage = null;
                    console.log(
                        '[VK CHAT LIVE STOP]',
                        `peer=${peerId}`,
                        'Вкладка закрыта. Повторное открытие отключено.',
                    );
                    await notifyManualSessionClosed('page-closed');
                    break;
                }

                try {
                    if (Date.now() - lastMediaSettleAt >= 8_000) {
                        await withPageOperation(() => settleScraperPage({
                            page: livePage,
                            source: `VK chat ${safeName} live`,
                            scrollSteps: 0,
                            mediaWaitMs: 2_500,
                        })).catch(() => {});
                        lastMediaSettleAt = Date.now();
                    }

                    const rendered = await withPageOperation(() =>
                        extractRenderedMessagesWithRetry(
                            livePage,
                            conversationUrl,
                        ),
                    );

                    /*
                     * Не ждём GPT внутри DOM-цикла: увиденные сообщения
                     * фиксируются в очереди, пока пользователь прокручивает чат.
                     */
                    if (!progressiveBackfillPromise) {
                        void queueMessagesForProcessing(
                            rendered,
                            'manual-scroll',
                        ).catch((error) => {
                            console.error(
                                '[VK CHAT LIVE QUEUE ERROR]',
                                `peer=${peerId}`,
                                formatErrorText(error),
                            );
                        });
                    }

                    await sleep(safeLivePollMs);
                } catch (error) {
                    /*
                     * Любая ошибка вкладки завершает текущую ручную сессию.
                     * Повторный запуск возможен только новой командой пользователя.
                     */
                    manualSessionActive = false;
                    liveMonitorActive = false;
                    livePage = null;
                    console.log(
                        '[VK CHAT LIVE STOP]',
                        `peer=${peerId}`,
                        formatErrorText(error),
                    );
                    await notifyManualSessionClosed(
                        isTransientBrowserError(error) ? 'page-or-browser-closed' : 'monitor-error',
                    );
                    break;
                }
            }
        })();

        liveMonitorPromise = liveMonitorPromise
            .catch(async (error) => {
                manualSessionActive = false;
                liveMonitorActive = false;
                livePage = null;
                console.error(
                    '[VK CHAT LIVE FATAL]',
                    `peer=${peerId}`,
                    formatErrorText(error),
                );
                await notifyManualSessionClosed('live-fatal');
            })
            .finally(() => {
                liveMonitorPromise = null;
            });

        return liveMonitorPromise;
    }

    async function runFiniteManualPass({
        maxDurationMs = 0,
        targetMessages = safeInitialMessages,
        processingGate = null,
        posterGateGate = null,
        getPosterGateResult = null,
        diagnostics = null,
        onCaptureComplete = null,
        onAdmissionComplete = null,
        onProcessingProgress = null,
        processingConcurrency = getManualParserProcessingConcurrency(),
        processingLimiter = null,
        incrementalOnly = false,
        disableHistoryBackfill = false,
    } = {}) {
        const requestedMaxDurationMs = Number(maxDurationMs) || 0;
        const safeMaxDurationMs = requestedMaxDurationMs > 0
            ? clampInteger(requestedMaxDurationMs, 10_000, 60 * 60 * 1000, 10 * 60 * 1000)
            : 0;
        const safeTargetMessages = clampInteger(
            targetMessages,
            20,
            5000,
            safeInitialMessages,
        );
        const finitePassStartedAt = Date.now();
        const deadlineAt = safeMaxDurationMs > 0 ? finitePassStartedAt + safeMaxDurationMs : 0;
        // One message can be observed more than once as VK lazily loads media.
        // Keep a single mutable captured object per CMID and merge later evidence.
        const capturedById = new Map();
        const capturedMessages = [];
        const finiteHistoryBackfillEnabled = historyBackfillEnabled && !disableHistoryBackfill;
        const historyBackfillTarget = finiteHistoryBackfillEnabled ? safeAutoScrollMessages : 0;
        let initialSnapshotCaptured = false;
        let initialFrontierKnown = false;
        let initialMinCmid = 0;
        let initialMaxCmid = 0;
        let historyBackfilledMessages = 0;
        let downSweepPerformed = false;
        let downSweepRequested = false;
        let downSweepUnreadCount = 0;
        let downSweepCapturedMessages = 0;
        let returnedToInitialFrontier = true;
        let upwardScrollsAfterDown = 0;
        let loaded = 0;
        let changedMessages = 0;
        let candidatesChecked = 0;
        let eventsFound = 0;
        let eventsCreatedCount = 0;
        let eventsUpdatedCount = 0;
        let visionCheckedImageCount = 0;
        let posterMatchAcceptedCount = 0;
        let posterMatchRejectedCount = 0;
        let lastMessageId = 0;
        let unchangedRounds = 0;
        let topStallRounds = 0;
        let timedOut = false;
        let reachedTop = false;
        let finitePageReadyAt = 0;
        let failedProcessingItems = 0;
        // These counters are returned outside try/finally.
        let incrementalKnownSkippedCount = 0;
        let incrementalNewCount = 0;
        const parserComparisons = [];
        const parserExactErrors = [];

        // Если до этого была оставлена live-сессия, переводим её в конечный
        // автоматический проход. Никакой ручной прокрутки для parser-all не нужно.
        liveMonitorActive = false;
        if (liveMonitorPromise) {
            await Promise.race([
                liveMonitorPromise.catch(() => {}),
                sleep(2_000),
            ]);
        }

        manualSessionActive = true;
        manualCloseNotificationSent = false;
        queuedFingerprints.clear();

        try {
            if (!livePage || livePage.isClosed()) {
                await openLivePage();
            }
            finitePageReadyAt = Date.now();
            // Baseline before unread down-sweep or history backfill moves the chat.
            if (diagnostics?.captureVkStructureBaseline) {
                await withPageOperation(() => diagnostics.captureVkStructureBaseline({
                    page: livePage, sourceId: `chat:${peerId}`, label: 'before-first-scroll',
                }));
            }

            /*
             * V188.67 unread-tail invariant. VK may open a conversation at the
             * last-read frontier, while unread messages physically live BELOW
             * the initial viewport. The old finite pass immediately scrolled up
             * and could therefore miss the unread tail forever.
             *
             * Detect the actual scroll position plus VK's unread DOM markers,
             * capture the starting frontier, sweep DOWN to the real bottom, then
             * let the normal finite loop walk UP again. No second page/tab is
             * opened for this: the same livePage is used for both directions.
             */
            let initialNavigationState = null;
            try {
                initialNavigationState = await withPageOperation(() =>
                    inspectConversationNavigationState(livePage),
                );
            } catch (error) {
                // Navigation failed: do not report a partial capture as success.
                throw error;
            }
            downSweepUnreadCount = Number(initialNavigationState?.unreadCount || 0);
            downSweepRequested = Boolean(
                initialNavigationState?.canScrollDown || initialNavigationState?.unreadHint
            );

            if (downSweepRequested && livePage && !livePage.isClosed()) {
                let downStallRounds = 0;
                for (let downRound = 0; downRound < 160; downRound += 1) {
                    if (deadlineAt > 0 && Date.now() >= deadlineAt) {
                        timedOut = true;
                        break;
                    }
                    if (!manualSessionActive || !livePage || livePage.isClosed()) break;

                    let downRendered = [];
                    try {
                        const snapshotHtml = diagnostics?.captureVkDomFixture
                            ? (await withPageOperation(() => diagnostics.captureVkDomFixture({
                                page: livePage, sourceId: `chat:${peerId}`,
                                label: `unread-down-${String(downRound + 1).padStart(3, '0')}`,
                                metadata: { phase: 'before-down-sweep-extraction', downRound },
                            }))).html
                            : await withPageOperation(() => livePage.content());
                        if (diagnostics?.captureDomSnapshot) {
                            await diagnostics.captureDomSnapshot({
                                sourceId: `chat:${peerId}`,
                                page: livePage,
                                html: snapshotHtml,
                                label: `unread-down-${String(downRound + 1).padStart(3, '0')}`,
                                metadata: {
                                    phase: 'unread-down-sweep',
                                    round: downRound + 1,
                                    unreadCountAtStart: downSweepUnreadCount,
                                },
                            });
                        }
                        const exactSnapshot = await extractExactMessagesFromDomSnapshot(
                            livePage,
                            snapshotHtml,
                            conversationUrl,
                        ).catch((exactError) => {
                            parserExactErrors.push({
                                round: `down-${downRound + 1}`,
                                at: new Date().toISOString(),
                                name: String(exactError?.name ?? ''),
                                message: String(exactError?.message ?? exactError),
                            });
                            return [];
                        });
                        const liveRendered = await withPageOperation(() =>
                            extractRenderedMessagesWithRetry(livePage, conversationUrl, 5, { snapshotHtml }),
                        );
                        downRendered = mergeSnapshotAndRenderedMessages(exactSnapshot, liveRendered);
                        diagnostics?.log?.('parser.compare', {
                            sourceId: `chat:${peerId}`,
                            phase: 'unread-down-sweep',
                            round: downRound + 1,
                            exactCount: exactSnapshot.length,
                            adaptiveCount: Array.isArray(liveRendered) ? liveRendered.length : 0,
                            mergedCount: downRendered.length,
                        });
                    } catch (error) {
                        // Browser failure invalidates the finite capture.
                        throw error;
                    }
                    logParserPass(downRendered, 'finite-unread-down');

                    const stableCmids = downRendered
                        .filter((message) => message?.hasStableConversationMessageId)
                        .map((message) => Number(message?.conversationMessageId ?? 0))
                        .filter((value) => Number.isSafeInteger(value) && value > 0);
                    if (!initialFrontierKnown && stableCmids.length) {
                        initialMinCmid = Math.min(...stableCmids);
                        initialMaxCmid = Math.max(...stableCmids);
                        initialFrontierKnown = true;
                        initialSnapshotCaptured = true;
                        console.log(
                            '[VK CHAT INITIAL FRONTIER]',
                            `peer=${peerId}`,
                            `minCmid=${initialMinCmid}`,
                            `maxCmid=${initialMaxCmid}`,
                            `unread=${downSweepUnreadCount}`,
                            'direction=down-first',
                        );
                    } else if (!finiteHistoryBackfillEnabled && downRendered.length > 0) {
                        initialSnapshotCaptured = true;
                    }

                    const downFresh = downRendered
                        .filter((message) => captureVkChatObservation(capturedById, message))
                        .sort((left, right) => (
                            left.conversationMessageId - right.conversationMessageId ||
                            left.createdAt - right.createdAt
                        ));
                    if (downFresh.length) {
                        loaded += downFresh.length;
                        downSweepCapturedMessages += downFresh.length;
                        capturedMessages.push(...downFresh);
                        lastMessageId = Math.max(
                            lastMessageId,
                            ...downFresh.map(stableVkChatMessageId),
                            0,
                        );
                    }

                    let navigationState = null;
                    try {
                        navigationState = await withPageOperation(() =>
                            inspectConversationNavigationState(livePage),
                        );
                    } catch (error) {
                        // Browser failure invalidates the finite capture.
                        throw error;
                    }
                    downSweepUnreadCount = Math.max(
                        downSweepUnreadCount,
                        Number(navigationState?.unreadCount || 0),
                    );
                    if (navigationState?.atBottom && !navigationState?.canScrollDown) break;

                    let scroll = { moved: false, atBottom: Boolean(navigationState?.atBottom) };
                    try {
                        scroll = await withPageOperation(() =>
                            scrollConversationDown(livePage, safeScrollBatchMessages),
                        );
                    } catch (error) {
                        // Browser failure invalidates the finite capture.
                        throw error;
                    }
                    if (scroll?.moved) {
                        downSweepPerformed = true;
                        returnedToInitialFrontier = false;
                        downStallRounds = 0;
                    } else {
                        downStallRounds += 1;
                    }
                    diagnostics?.log?.('source.unread.scroll', {
                        sourceId: `chat:${peerId}`,
                        round: downRound + 1,
                        direction: 'down',
                        unreadCount: downSweepUnreadCount,
                        unreadSeparator: Boolean(navigationState?.hasUnreadSeparator),
                        unreadHint: Boolean(navigationState?.unreadHint),
                        strategy: String(scroll?.strategy || navigationState?.strategy || ''),
                        moved: Boolean(scroll?.moved),
                        atBottom: Boolean(scroll?.atBottom),
                        beforeTop: Number(scroll?.beforeTop || 0),
                        afterTop: Number(scroll?.afterTop || 0),
                    });
                    if (scroll?.atBottom || downStallRounds >= 3) {
                        // Capture the final bottom viewport on the next iteration
                        // only when movement happened; otherwise there is nothing
                        // new to observe.
                        if (!scroll?.moved) break;
                    }
                    await sleep(Math.min(700, safeScrollBatchDelayMs));
                }

                console.log(
                    '[VK CHAT UNREAD DOWN SWEEP]',
                    `peer=${peerId}`,
                    `requested=${downSweepRequested}`,
                    `moved=${downSweepPerformed}`,
                    `unread=${downSweepUnreadCount}`,
                    `captured=${downSweepCapturedMessages}`,
                );
            }

            for (let round = 0; round < 250; round += 1) {
                if (deadlineAt > 0 && Date.now() >= deadlineAt) {
                    timedOut = true;
                    break;
                }
                if (!manualSessionActive || !livePage || livePage.isClosed()) {
                    break;
                }

                let rendered = [];
                try {
                    // Serialize the COMPLETE current page first. Exact Stage 1 is
                    // executed from this immutable snapshot; structural/heuristic
                    // contours consume the exact same immutable HTML string.
                    const snapshotHtml = diagnostics?.captureVkDomFixture
                        ? (await withPageOperation(() => diagnostics.captureVkDomFixture({
                            page: livePage, sourceId: `chat:${peerId}`,
                            label: `window-${String(round + 1).padStart(3, '0')}`,
                            metadata: { phase: 'before-exact-extraction', round },
                        }))).html
                        : await withPageOperation(() => livePage.content());
                    // Save the COMPLETE immutable DOM window before Stage 1 reads
                    // a single node from it. The exact parser consumes this same
                    // string, so every decision can be replayed from diagnostics.
                    if (diagnostics?.captureDomSnapshot) {
                        await diagnostics.captureDomSnapshot({
                            sourceId: `chat:${peerId}`,
                            page: livePage,
                            html: snapshotHtml,
                            label: `window-${String(round + 1).padStart(3, '0')}`,
                            metadata: {
                                phase: 'raw-before-exact',
                                round: round + 1,
                                initialMinCmid,
                                historyBackfilledMessages,
                                historyBackfillTarget,
                            },
                        });
                    }
                    let exactSnapshot = [];
                    try {
                        exactSnapshot = await extractExactMessagesFromDomSnapshot(
                            livePage,
                            snapshotHtml,
                            conversationUrl,
                        );
                        diagnostics?.log?.('dom.snapshot.exact-parsed', {
                            sourceId: `chat:${peerId}`,
                            round: round + 1,
                            snapshotExactCount: exactSnapshot.length,
                            snapshotDiagnostics: exactSnapshot?.snapshotDiagnostics || {},
                        });
                    } catch (exactError) {
                        parserExactErrors.push({
                            round: round + 1,
                            at: new Date().toISOString(),
                            name: String(exactError?.name ?? ''),
                            message: String(exactError?.message ?? exactError),
                        });
                        diagnostics?.log?.('parser.exact.error', {
                            sourceId: `chat:${peerId}`,
                            round: round + 1,
                            error: exactError,
                            action: 'continue-with-same-snapshot-structural-heuristic',
                        });
                    }
                    const liveRendered = await withPageOperation(() =>
                        extractRenderedMessagesWithRetry(
                            livePage,
                            conversationUrl,
                            5,
                            { snapshotHtml },
                        ),
                    );
                    rendered = mergeSnapshotAndRenderedMessages(exactSnapshot, liveRendered);
                    const exactIds = new Set(exactSnapshot.map((item) => Number(item?.conversationMessageId || 0)).filter(Boolean));
                    const liveIds = new Set((Array.isArray(liveRendered) ? liveRendered : []).map((item) => Number(item?.conversationMessageId || 0)).filter(Boolean));
                    const liveOnlyIds = [...liveIds].filter((id) => !exactIds.has(id)).slice(0, 40);
                    const exactOnlyIds = [...exactIds].filter((id) => !liveIds.has(id)).slice(0, 40);
                    const parserComparison = {
                        sourceId: `chat:${peerId}`,
                        round: round + 1,
                        exactCount: exactSnapshot.length,
                        exactDiagnostics: exactSnapshot?.snapshotDiagnostics || {},
                        adaptiveCount: Array.isArray(liveRendered) ? liveRendered.length : 0,
                        adaptivePass: String(liveRendered?.parserPass || 'unknown'),
                        adaptiveReason: String(liveRendered?.parserReason || '').slice(0, 1000),
                        mergedCount: rendered.length,
                        liveOnlyIds,
                        exactOnlyIds,
                        fallbackUsed: exactSnapshot.length === 0 && Boolean(liveIds.size),
                        exactMissedSome: liveOnlyIds.length > 0,
                        exactFailureReason: exactSnapshot.length
                            ? ''
                            : (parserExactErrors.at(-1)?.message || String(liveRendered?.parserReason || 'exact-returned-zero').slice(0, 1000)),
                    };
                    parserComparisons.push(parserComparison);
                    diagnostics?.log?.('parser.compare', parserComparison);
                    if (exactSnapshot.length === 0 && liveIds.size) {
                        diagnostics?.log?.('parser.fallback.used', {
                            sourceId: `chat:${peerId}`,
                            round: round + 1,
                            fallbackPass: String(liveRendered?.parserPass || 'unknown'),
                            reason: String(liveRendered?.parserReason || 'exact-returned-zero').slice(0, 1000),
                            recoveredIds: [...liveIds].slice(0, 40),
                        });
                    }
                    Object.defineProperties(rendered, {
                        parserPass: {
                            value: exactSnapshot.length
                                ? `snapshot-exact+${String(liveRendered?.parserPass || 'rendered')}`
                                : String(liveRendered?.parserPass || 'rendered'),
                            enumerable: false,
                        },
                        parserReason: {
                            value: `snapshotExact=${exactSnapshot.length}; ${String(liveRendered?.parserReason || '')}`.slice(0, 1000),
                            enumerable: false,
                        },
                    });
                } catch (error) {
                    // Browser failure invalidates the finite capture.
                    throw error;
                }
                logParserPass(rendered, 'finite-pass');

                const stableCmids = rendered
                    .filter((message) => message?.hasStableConversationMessageId)
                    .map((message) => Number(message?.conversationMessageId ?? 0))
                    .filter((value) => Number.isSafeInteger(value) && value > 0);
                if (!initialFrontierKnown && stableCmids.length) {
                    initialMinCmid = Math.min(...stableCmids);
                    initialMaxCmid = Math.max(...stableCmids);
                    initialFrontierKnown = true;
                    console.log(
                        '[VK CHAT HISTORY INITIAL FRONTIER]',
                        `peer=${peerId}`,
                        `visible=${rendered.length}`,
                        `initialMinCmid=${initialMinCmid}`,
                        `initialMaxCmid=${initialMaxCmid}`,
                        `requiredOlder=${historyBackfillTarget}`,
                    );
                }
                if (!initialSnapshotCaptured && rendered.length > 0) {
                    if (finiteHistoryBackfillEnabled) {
                        initialSnapshotCaptured = initialFrontierKnown;
                    } else {
                        initialSnapshotCaptured = true;
                    }
                }

                if (downSweepPerformed && !returnedToInitialFrontier) {
                    if (initialFrontierKnown && stableCmids.length) {
                        const currentMinCmid = Math.min(...stableCmids);
                        if (currentMinCmid <= initialMinCmid) {
                            returnedToInitialFrontier = true;
                            console.log(
                                '[VK CHAT RETURNED TO INITIAL FRONTIER]',
                                `peer=${peerId}`,
                                `currentMinCmid=${currentMinCmid}`,
                                `initialMinCmid=${initialMinCmid}`,
                            );
                        }
                    } else if (upwardScrollsAfterDown > 0) {
                        returnedToInitialFrontier = true;
                    }
                }

                if (finiteHistoryBackfillEnabled && !initialSnapshotCaptured) {
                    // Do not count synthetic ids as historical progress. A slow
                    // virtual list gets a long readiness window until real cmids
                    // appear or the overall finite-pass deadline is reached.
                    unchangedRounds += 1;
                    await sleep(HISTORY_BACKFILL_SCROLL_DELAY_MS);
                    continue;
                }

                const fresh = rendered
                    .filter((message) => captureVkChatObservation(capturedById, message))
                    .sort((left, right) => (
                        left.conversationMessageId - right.conversationMessageId ||
                        left.createdAt - right.createdAt
                    ));

                if (fresh.length) {
                    unchangedRounds = 0;
                    topStallRounds = 0;
                    loaded += fresh.length;

                    if (finiteHistoryBackfillEnabled) {
                        const olderFresh = fresh.filter((message) => (
                            message?.hasStableConversationMessageId &&
                            Number(message?.conversationMessageId ?? 0) > 0 &&
                            Number(message.conversationMessageId) < initialMinCmid
                        ));
                        historyBackfilledMessages += olderFresh.length;
                        if (olderFresh.length) {
                            console.log(
                                '[VK CHAT HISTORY BACKFILL]',
                                `peer=${peerId}`,
                                `newOlder=${olderFresh.length}`,
                                `loadedOlder=${historyBackfilledMessages}/${historyBackfillTarget}`,
                                `frontier=${initialMinCmid}`,
                            );
                        }
                    }

                    // Capture-only phase. AI is deliberately forbidden while
                    // Chromium is scrolling: first make a durable raw cache.
                    capturedMessages.push(...fresh);
                    lastMessageId = Math.max(
                        lastMessageId,
                        ...fresh.map(stableVkChatMessageId),
                        0,
                    );
                } else {
                    unchangedRounds += 1;
                }

                const normalTargetReached = loaded >= safeTargetMessages;
                const historyTargetReached = finiteHistoryBackfillEnabled &&
                    historyBackfilledMessages >= historyBackfillTarget;
                const scanTargetReached = finiteHistoryBackfillEnabled
                    ? historyTargetReached
                    : (normalTargetReached && returnedToInitialFrontier);
                if (timedOut || scanTargetReached) {
                    break;
                }

                let scroll = { moved: false, atTop: false };
                try {
                    scroll = await withPageOperation(() =>
                        scrollConversationUp(livePage, safeScrollBatchMessages),
                    );
                } catch (error) {
                    // Browser failure invalidates the finite capture.
                    throw error;
                }

                if (downSweepPerformed && scroll?.moved) {
                    upwardScrollsAfterDown += 1;
                }

                const unchangedLimit = finiteHistoryBackfillEnabled ? 20 : 5;
                if (scroll.atTop && !scroll.moved) {
                    topStallRounds += 1;
                } else {
                    topStallRounds = 0;
                }
                const confirmedTop = topStallRounds >= (finiteHistoryBackfillEnabled ? 4 : 1) && (
                    !finiteHistoryBackfillEnabled ||
                    Date.now() - finitePageReadyAt >= HISTORY_BACKFILL_INITIAL_CAPTURE_GRACE_MS
                );
                if (confirmedTop || unchangedRounds >= unchangedLimit) {
                    reachedTop = confirmedTop;
                    break;
                }

                diagnostics?.log?.('source.history.scroll', {
                    sourceId: `chat:${peerId}`,
                    round: round + 1,
                    strategy: String(scroll?.strategy || ''),
                    moved: Boolean(scroll?.moved),
                    atTop: Boolean(scroll?.atTop),
                    delta: Number(scroll?.delta || 0),
                    beforeTop: Number(scroll?.beforeTop || 0),
                    afterTop: Number(scroll?.afterTop || 0),
                    backfilled: historyBackfilledMessages,
                    target: historyBackfillTarget,
                    unchangedRounds,
                    topStallRounds,
                });
                const finiteScrollDelayMs = finiteHistoryBackfillEnabled
                    ? Math.max(HISTORY_BACKFILL_SCROLL_DELAY_MS, safeScrollBatchDelayMs)
                    : Math.min(700, safeScrollBatchDelayMs);
                // The 1.8s history delay is already the deliberate slow-scroll
                // pause requested for VK lazy loading. The previous code then
                // added another 1.8s media settle on every window, doubling the
                // backfill duration even when data-itemkey did not change. Keep
                // the expensive media settle for the final immutable capture.
                await sleep(finiteScrollDelayMs);
                if (!finiteHistoryBackfillEnabled && livePage && !livePage.isClosed()) {
                    await withPageOperation(() => settleScraperPage({
                        page: livePage,
                        source: `VK chat ${safeName} finite-auto-scroll`,
                        scrollSteps: 0,
                        mediaWaitMs: 900,
                    })).catch(() => {});
                    lastMediaSettleAt = Date.now();
                }
            }

            // No artificial dwell after the structural/history target is met.
            // Cache is the phase barrier: as soon as the required raw material
            // is captured, downstream processing may start independently of Chromium.
            let finalDomHtml = '';

            if (livePage && !livePage.isClosed() && (deadlineAt <= 0 || Date.now() < deadlineAt)) {
                await withPageOperation(() => settleScraperPage({
                    page: livePage,
                    source: `VK chat ${safeName} finite-final-capture`,
                    scrollSteps: 0,
                    mediaWaitMs: finiteHistoryBackfillEnabled ? 2500 : 1500,
                })).catch(() => {});
                finalDomHtml = diagnostics?.captureVkDomFixture
                    ? (await withPageOperation(() => diagnostics.captureVkDomFixture({
                        page: livePage, sourceId: `chat:${peerId}`, label: 'capture-complete',
                        metadata: { phase: 'before-final-exact-extraction' },
                    }))).html
                    : await withPageOperation(() => livePage.content());
                const finalSnapshotHtml = finalDomHtml;
                if (finalSnapshotHtml && diagnostics?.captureDomSnapshot) {
                    await diagnostics.captureDomSnapshot({
                        sourceId: `chat:${peerId}`,
                        page: livePage,
                        html: finalSnapshotHtml,
                        label: 'capture-complete',
                        metadata: {
                            phase: 'raw-before-exact',
                            initialMinCmid,
                            initialMaxCmid,
                            downSweepRequested,
                            downSweepPerformed,
                            downSweepUnreadCount,
                            downSweepCapturedMessages,
                            returnedToInitialFrontier,
                            historyBackfilledMessages,
                            historyBackfillTarget,
                        },
                    });
                }
                const finalExactSnapshot = finalSnapshotHtml
                    ? await extractExactMessagesFromDomSnapshot(livePage, finalSnapshotHtml, conversationUrl).catch(() => [])
                    : [];
                diagnostics?.log?.('dom.snapshot.exact-parsed', {
                    sourceId: `chat:${peerId}`,
                    label: 'capture-complete',
                    snapshotExactCount: finalExactSnapshot.length,
                });
                // Final exact and adaptive must parse the same immutable HTML.
                const finalLiveRendered = finalSnapshotHtml
                    ? await withPageOperation(() =>
                        extractRenderedMessagesWithRetry(
                            livePage, conversationUrl, 5,
                            { snapshotHtml: finalSnapshotHtml },
                        ),
                    )
                    : [];
                const finalRendered = mergeSnapshotAndRenderedMessages(finalExactSnapshot, finalLiveRendered);
                const finalFresh = finalRendered
                    .filter((message) => captureVkChatObservation(capturedById, message))
                    .sort((left, right) => (
                        left.conversationMessageId - right.conversationMessageId ||
                        left.createdAt - right.createdAt
                    ));
                if (finalFresh.length) {
                    loaded += finalFresh.length;
                    if (finiteHistoryBackfillEnabled && initialMinCmid > 0) {
                        historyBackfilledMessages += finalFresh.filter((message) => (
                            message?.hasStableConversationMessageId &&
                            Number(message?.conversationMessageId ?? 0) > 0 &&
                            Number(message.conversationMessageId) < initialMinCmid
                        )).length;
                    }
                    capturedMessages.push(...finalFresh);
                    lastMessageId = Math.max(
                        lastMessageId,
                        ...finalFresh.map(stableVkChatMessageId),
                        0,
                    );
                }
            }

            // V188.141: Final forensic DOM is OBSERVATIONAL. The finite native
            // chat pass above already scrolled and captured the requested messages.
            // An extra "drain to top" here used to run 300 more scrolls, blocking
            // the next VK source's capture barrier and its 10-20-second gap.
            // Never scroll again merely to save a diagnostic fixture.
            if (diagnostics?.captureVkFinalDomSnapshot && diagnostics.finalDomOnly &&
                livePage && !livePage.isClosed()) {
                try {
                    await withPageOperation(() => diagnostics.captureVkFinalDomSnapshot({
                        page: livePage, sourceId: `chat:${peerId}`, sourceKind: 'vk-chat',
                        direction: 'up',
                        preparation: {
                            status: 'native-capture-finished-no-extra-pagination',
                            direction: 'up', prepared: false, steps: 0,
                            controlsCompleted: 0, progress: [],
                            note: 'Snapshot of actual page state after the existing finite pass; no additional scroll; history completeness is not claimed.',
                        },
                    }));
                } catch (finalCaptureError) {
                    diagnostics.log?.('vk.final-fixture.capture-error', {
                        sourceId: `chat:${peerId}`, error: finalCaptureError,
                    });
                }
            }

            const sourceId = `chat:${peerId}`;
            const ledgerRunId = `${sourceId}:${Math.floor(finitePassStartedAt / 1000)}:${process.pid}`;
            const orderedCapturedMessages = [...capturedMessages].sort((left, right) => (
                Number(left?.conversationMessageId ?? 0) - Number(right?.conversationMessageId ?? 0) ||
                Number(left?.createdAt ?? 0) - Number(right?.createdAt ?? 0)
            ));
            const candidateDecisions = new Map();
            const candidateIds = new Set();
            const posterGateRequests = [];
            let structuralCandidateCount = 0;
            let databaseSkippedCount = 0;
            let aiRejectedCount = 0;
            let trashCount = 0;
            for (const message of orderedCapturedMessages) {
                const itemId = String(message?.conversationMessageId ?? '');
                message.provenance = resolveVkChatProvenance({
                    peerId,
                    conversationName: safeName,
                    conversationMessageId: message?.conversationMessageId,
                    conversationUrl,
                    text: message?.text,
                    repostUrls: message?.repostUrls,
                    attachmentLinks: message?.attachmentLinks,
                    links: message?.links,
                    sourceUrl: message?.sourceUrl,
                });
                message.sourceUrl = message.provenance.canonicalPostUrl || '';
                const ledgerBefore = getManualParserSeenItem({ sourceId, itemId });
                const rawContentHash = hashMessage(message);
                // Matching CMID without a matching content hash is not unchanged content.
                // Legacy rows with no hash must be reprocessed rather than skipped.
                const incrementalKnown = Boolean(
                    incrementalOnly && ledgerBefore &&
                    isManualParserSeenItemFinalStatus(ledgerBefore.parseStatus) &&
                    ledgerBefore.contentHash && ledgerBefore.contentHash === rawContentHash
                );
                upsertManualParserSeenItem({
                    sourceId, sourceKind: 'vk-chat', itemId, sourceUrl: String(message?.sourceUrl || conversationUrl || ''),
                    observedAt: Number(message?.createdAt || 0), rawText: String(message?.text || ''),
                    attachments: {
                        links: Array.isArray(message?.links) ? message.links : [],
                        repostUrls: Array.isArray(message?.repostUrls) ? message.repostUrls : [],
                        attachmentLinks: Array.isArray(message?.attachmentLinks) ? message.attachmentLinks : [],
                        canonicalPostUrl: String(message?.provenance?.canonicalPostUrl || message?.sourceUrl || ''),
                        canonicalOrigin: String(message?.provenance?.canonicalOrigin || ''),
                        sourceChatId: Number(peerId || 0),
                        sourceChatName: String(safeName || ''),
                        sourceMessageId: Number(message?.conversationMessageId || 0),
                        imageUrls: Array.isArray(message?.imageUrls) ? message.imageUrls : [],
                    },
                    contentHash: rawContentHash, parseStatus: incrementalKnown ? ledgerBefore.parseStatus : 'captured',
                });
                if (incrementalKnown) incrementalKnownSkippedCount += 1;
                else incrementalNewCount += 1;
                const decision = incrementalKnown
                    ? { candidate: false, aiEligible: false, score: -1000, reasons: ['clean-mode-database-known'], evidence: {}, aiAdmission: { rejectionReason: 'clean-mode-database-known', dateSource: 'not-evaluated' } }
                    : explainVkChatEventCandidate(message);
                if (decision.candidate) structuralCandidateCount += 1;
                // Text/URL similarity cannot prove the poster is unchanged.
                // Known identical captures were already skipped by ledger + hash.
                const existing = null;
                if (existing) databaseSkippedCount += 1;
                if (decision.candidate && !decision.aiEligible) aiRejectedCount += 1;
                if (!decision.candidate && !incrementalKnown) trashCount += 1;
                const aiCandidate = Boolean(decision.aiEligible && !existing);
                const priority = aiCandidate ? decision.score : -1000;
                const posterGateImageUrls = [...new Set((Array.isArray(message?.imageUrls) ? message.imageUrls : [])
                    .map((value) => String(value ?? '').trim())
                    .filter((url) => /^https?:\/\//iu.test(url)))]
                    .slice(0, 12);
                const posterGatePending = Boolean(
                    !incrementalKnown && !decision.aiEligible && !existing && posterGateImageUrls.length
                );
                candidateDecisions.set(itemId, {
                    ...decision, existing, aiCandidate, priority, bodyAiEligible: Boolean(decision.aiEligible),
                    posterGatePending, posterGateImageUrls, incrementalKnown, ledgerBefore,
                });
                if (posterGatePending) {
                    posterGateRequests.push({
                        itemId, source: safeName || `VK chat ${peerId}`,
                        sourceUrl: String(message?.sourceUrl || conversationUrl || ''), imageUrls: posterGateImageUrls,
                        priority: Number(decision.score || 0), score: Number(decision.score || 0),
                        preview: parserCandidatePreview(message?.text),
                    });
                }
                if (aiCandidate) candidateIds.add(itemId);
                diagnostics?.log?.('item.prefilter', {
                    sourceId,
                    itemId,
                    parserPass: String(message?.parserPass || ''),
                    candidate: decision.candidate,
                    aiEligible: decision.aiEligible,
                    aiCandidate,
                    aiAdmission: decision.aiAdmission,
                    score: decision.score,
                    priority,
                    reasons: decision.reasons,
                    evidence: decision.evidence,
                    databaseMatch: existing,
                    incrementalOnly: Boolean(incrementalOnly),
                    incrementalKnown,
                    preview: parserCandidatePreview(message?.text),
                });
            }
            const domPath = finalDomHtml
                ? await diagnostics?.captureDomSnapshot?.({
                    sourceId,
                    html: finalDomHtml,
                    label: 'raw-cache-source',
                    metadata: {
                        itemCount: orderedCapturedMessages.length,
                        initialMinCmid,
                        historyBackfilledMessages,
                        historyBackfillTarget,
                    },
                })
                : '';
            const cachePath = diagnostics?.cacheSource?.({
                sourceId,
                kind: 'vk-chat',
                items: orderedCapturedMessages,
                metadata: {
                    peerId,
                    conversationName: safeName,
                    initialMinCmid,
                    initialMaxCmid,
                    downSweepRequested,
                    downSweepPerformed,
                    downSweepUnreadCount,
                    downSweepCapturedMessages,
                    returnedToInitialFrontier,
                    historyBackfilledMessages,
                    historyBackfillTarget,
                    reachedTop,
                    domPath,
                },
            }) || '';
            const parserReportPath = diagnostics?.saveParserReport?.({
                sourceId,
                kind: 'vk-chat',
                report: {
                    peerId,
                    conversationName: safeName,
                    domPath,
                    cachePath,
                    initialMinCmid,
                    initialMaxCmid,
                    downSweepRequested,
                    downSweepPerformed,
                    downSweepUnreadCount,
                    downSweepCapturedMessages,
                    returnedToInitialFrontier,
                    historyBackfilledMessages,
                    historyBackfillTarget,
                    reachedTop,
                    immutableSnapshot: {
                        path: domPath,
                        chars: finalDomHtml.length,
                        bytes: Buffer.byteLength(finalDomHtml, 'utf8'),
                        sha256: finalDomHtml ? createHash('sha256').update(finalDomHtml, 'utf8').digest('hex') : '',
                        sameSnapshotForAllThreeContours: true,
                    },
                    contourCounts: {
                        exact: orderedCapturedMessages.filter((message) => String(message?.parserPass || '').includes('snapshot-exact')).length,
                        structural: orderedCapturedMessages.filter((message) => String(message?.parserPass || '').includes('pass2-adaptive')).length,
                        heuristic: orderedCapturedMessages.filter((message) => String(message?.parserPass || '').includes('pass3-heuristic')).length,
                    },
                    comparisons: parserComparisons,
                    exactErrors: parserExactErrors,
                    prefilter: orderedCapturedMessages.map((message) => {
                        const itemId = String(message?.conversationMessageId ?? '');
                        const decision = candidateDecisions.get(itemId) || {};
                        return {
                            itemId,
                            parserPass: String(message?.parserPass || ''),
                            candidate: Boolean(decision.candidate),
                            aiEligible: Boolean(decision.aiEligible),
                            aiCandidate: Boolean(decision.aiCandidate),
                            aiAdmission: decision.aiAdmission || null,
                            score: Number(decision.score || 0),
                            reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                            databaseMatch: decision.existing || null,
                            incrementalKnown: Boolean(decision.incrementalKnown),
                        };
                    }),
                },
            }) || '';
            await onCaptureComplete?.({
                sourceId,
                kind: 'vk-chat',
                itemCount: orderedCapturedMessages.length,
                cachePath,
                domPath,
                parserReportPath,
                prefilterStats: {
                    structuralCandidateCount,
                    databaseSkippedCount,
                    aiRejectedCount,
                    trashCount,
                    aiQueueCount: candidateIds.size,
                    posterGatePendingCount: posterGateRequests.length,
                    incrementalKnownSkippedCount,
                    incrementalNewCount,
                },
                posterGateRequests,
                candidatePreviews: orderedCapturedMessages
                    .filter((message) => candidateIds.has(String(message?.conversationMessageId ?? '')))
                    .map((message) => {
                        const itemId = String(message?.conversationMessageId ?? '');
                        const decision = candidateDecisions.get(itemId) || {};
                        return {
                            itemId,
                            source: safeName || `VK chat ${peerId}`,
                            sourceUrl: String(message?.sourceUrl || conversationUrl || ''),
                            preview: parserCandidatePreview(message?.text),
                            priority: Number(decision.priority || 0),
                            score: Number(decision.score || 0),
                            reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                            aiAdmission: decision.aiAdmission || null,
                        };
                    }),
                prefilterPreviews: orderedCapturedMessages.map((message) => {
                    const itemId = String(message?.conversationMessageId ?? '');
                    const decision = candidateDecisions.get(itemId) || {};
                    return {
                        itemId,
                        source: safeName || `VK chat ${peerId}`,
                        sourceUrl: String(message?.sourceUrl || conversationUrl || ''),
                        preview: parserCandidatePreview(message?.text),
                        candidate: Boolean(decision.candidate),
                        aiEligible: Boolean(decision.aiEligible),
                        aiCandidate: Boolean(decision.aiCandidate),
                        reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                        aiAdmission: decision.aiAdmission || null,
                        databaseMatch: decision.existing || null,
                        incrementalKnown: Boolean(decision.incrementalKnown),
                    };
                }),
            });

            const cachedPage = livePage;
            livePage = null;
            if (cachedPage && !cachedPage.isClosed()) {
                await cachedPage.close().catch(() => {});
            }
            if (posterGateGate && typeof posterGateGate.then === 'function') {
                await posterGateGate;
            }

            let posterGateCheckedCount = 0;
            let posterGateRescuedCount = 0;
            candidateIds.clear();
            structuralCandidateCount = 0;
            databaseSkippedCount = 0;
            aiRejectedCount = 0;
            trashCount = 0;
            for (const message of orderedCapturedMessages) {
                const itemId = String(message?.conversationMessageId ?? '');
                const before = candidateDecisions.get(itemId) || {};
                const gate = !before.incrementalKnown && before.posterGatePending && typeof getPosterGateResult === 'function'
                    ? getPosterGateResult(sourceId, itemId)
                    : null;
                if (gate?.attempted) {
                    posterGateCheckedCount += 1;
                    message.__posterGateVisionAttempted = true;
                    message.__posterGateFacts = String(gate?.facts || '');
                    message.__posterGateError = String(gate?.error || '');
                }
                const decision = before.incrementalKnown
                    ? { candidate: false, aiEligible: false, score: -1000, reasons: ['clean-mode-database-known'], evidence: {}, aiAdmission: { rejectionReason: 'clean-mode-database-known', dateSource: 'not-evaluated' } }
                    : explainVkChatEventCandidate(message);
                if (decision.candidate) structuralCandidateCount += 1;
                const existing = before.existing || null;
                if (existing) databaseSkippedCount += 1;
                if (decision.candidate && !decision.aiEligible) aiRejectedCount += 1;
                if (!decision.candidate && !before.incrementalKnown) trashCount += 1;
                const aiCandidate = Boolean(decision.aiEligible && !existing);
                const priority = aiCandidate ? decision.score : -1000;
                if (!before.bodyAiEligible && decision.aiEligible && decision?.aiAdmission?.dateSource === 'poster-vision') {
                    posterGateRescuedCount += 1;
                }
                candidateDecisions.set(itemId, { ...before, ...decision, existing, aiCandidate, priority });
                if (aiCandidate) candidateIds.add(itemId);
                diagnostics?.log?.('item.admission', {
                    sourceId, itemId, candidate: decision.candidate, aiEligible: decision.aiEligible, aiCandidate,
                    aiAdmission: decision.aiAdmission, posterGateAttempted: Boolean(gate?.attempted),
                    posterGateError: String(gate?.error || ''), preview: parserCandidatePreview(message?.text),
                });
            }
            const finalCandidatePreviews = orderedCapturedMessages
                .filter((message) => candidateIds.has(String(message?.conversationMessageId ?? '')))
                .map((message) => {
                    const itemId = String(message?.conversationMessageId ?? '');
                    const decision = candidateDecisions.get(itemId) || {};
                    return { itemId, source: safeName || `VK chat ${peerId}`,
                        sourceUrl: String(message?.sourceUrl || conversationUrl || ''), preview: parserCandidatePreview(message?.text),
                        priority: Number(decision.priority || 0), score: Number(decision.score || 0),
                        reasons: Array.isArray(decision.reasons) ? decision.reasons : [], aiAdmission: decision.aiAdmission || null };
                });
            const finalPrefilterPreviews = orderedCapturedMessages.map((message) => {
                const itemId = String(message?.conversationMessageId ?? '');
                const decision = candidateDecisions.get(itemId) || {};
                return { itemId, source: safeName || `VK chat ${peerId}`,
                    sourceUrl: String(message?.sourceUrl || conversationUrl || ''), preview: parserCandidatePreview(message?.text),
                    candidate: Boolean(decision.candidate), aiEligible: Boolean(decision.aiEligible),
                    aiCandidate: Boolean(decision.aiCandidate), reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                    aiAdmission: decision.aiAdmission || null, databaseMatch: decision.existing || null,
                    posterGateAttempted: Boolean(message?.__posterGateVisionAttempted),
                    posterGateError: String(message?.__posterGateError || ''), incrementalKnown: Boolean(decision.incrementalKnown) };
            });
            await onAdmissionComplete?.({
                sourceId, kind: 'vk-chat', itemCount: orderedCapturedMessages.length, cachePath, domPath, parserReportPath,
                prefilterStats: { structuralCandidateCount, databaseSkippedCount, aiRejectedCount, trashCount,
                    aiQueueCount: candidateIds.size, posterGateCheckedCount, posterGateRescuedCount,
                    incrementalKnownSkippedCount, incrementalNewCount },
                candidatePreviews: finalCandidatePreviews, prefilterPreviews: finalPrefilterPreviews,
            });

            if (processingGate && typeof processingGate.then === 'function') {
                await processingGate;
            }
            diagnostics?.log?.('source.processing.start', {
                sourceId,
                itemCount: orderedCapturedMessages.length,
                candidateCount: candidateIds.size,
                structuralCandidateCount,
                databaseSkippedCount,
                aiRejectedCount,
                trashCount,
                concurrency: processingConcurrency,
            });

            const processingMessages = orderedCapturedMessages
                .filter((message) => !incrementalOnly || !candidateDecisions.get(String(message?.conversationMessageId ?? ''))?.incrementalKnown)
                .sort((left, right) => {
                const leftDecision = candidateDecisions.get(String(left?.conversationMessageId ?? '')) || {};
                const rightDecision = candidateDecisions.get(String(right?.conversationMessageId ?? '')) || {};
                return Number(rightDecision.priority ?? -1000) - Number(leftDecision.priority ?? -1000) ||
                    Number(right?.conversationMessageId || 0) - Number(left?.conversationMessageId || 0);
            });
            const processingResults = await runManualParserPoolUntilSettled(
                processingMessages,
                async (message) => {
                    const itemId = String(message?.conversationMessageId ?? '');
                    const decision = candidateDecisions.get(itemId) || {};
                    // Do not finalize a message as "not event" after session shutdown.
                    assertVkChatSessionActive(manualSessionActive);
                    markManualParserSeenItemProcessing({ sourceId, itemId, runId: ledgerRunId });
                    // A poster-gate outage is not a confirmed "no event" decision.
                    if (!decision.existing && !decision.aiCandidate && decision.posterGatePending &&
                        (String(message.__posterGateError ?? '').trim() || !message.__posterGateVisionAttempted)) {
                        const error = new Error('Poster recognition unavailable; event decision unresolved.');
                        error.code = 'POSTER_GATE_UNRESOLVED';
                        throw error;
                    }
                    if (!decision.aiCandidate) {
                        const result = {
                            changed: false,
                            candidateChecked: false,
                            eventCount: 0,
                            skipped: decision.incrementalKnown
                                ? 'clean-mode-database-known'
                                : (decision.existing
                                    ? 'database-known'
                                    : (decision.candidate ? 'strict-ai-gate-rejected' : 'prefilter-trash')),
                        };
                        finalizeManualParserSeenItem({
                            sourceId,
                            itemId,
                            runId: ledgerRunId,
                            parseStatus: decision.existing ? 'processed_existing' : 'processed_rejected',
                        });
                        return result;
                    }
                    const result = await processLiveMessage(message, {
                        forceReprocess: !incrementalOnly,
                        traceAi: (stage, data = {}) => diagnostics?.log?.(`item.ai.${stage}`, {
                            sourceId,
                            itemId,
                            preview: parserCandidatePreview(message?.text),
                            ...data,
                        }),
                    });
                    if (result.changed) changedMessages += 1;
                    if (result.candidateChecked) candidatesChecked += 1;
                    eventsFound += Number(result.eventCount ?? 0);
                    eventsCreatedCount += Number(result?.eventsCreatedCount || 0);
                    eventsUpdatedCount += Number(result?.eventsUpdatedCount || 0);
                    visionCheckedImageCount += Number(result?.visionCheckedImageCount || 0);
                    posterMatchAcceptedCount += Number(result?.posterMatchAcceptedCount || 0);
                    posterMatchRejectedCount += Number(result?.posterMatchRejectedCount || 0);
                    if (!result?.unresolved) {
                        finalizeManualParserSeenItem({
                            sourceId,
                            itemId,
                            runId: ledgerRunId,
                            parseStatus: Number(result?.eventCount || 0) > 0 ? 'processed_event' : 'processed_not_event',
                        });
                    }
                    return result;
                },
                {
                    concurrency: processingConcurrency,
                    limiter: processingLimiter,
                    getPriority: (message) => Number(candidateDecisions.get(String(message?.conversationMessageId ?? ''))?.priority ?? -1000),
                    onItemState: async (event) => {
                        const itemId = String(event.item?.conversationMessageId ?? '');
                        const candidate = candidateIds.has(itemId);
                        diagnostics?.log?.(`item.processing.${event.type}`, {
                            sourceId,
                            itemId,
                            candidate,
                            priority: Number(event.priority || candidateDecisions.get(itemId)?.priority || 0),
                            reasons: candidateDecisions.get(itemId)?.reasons || [],
                            retryCycle: Number(event.retryCycle || 1),
                            preview: parserCandidatePreview(event.item?.text),
                            queueWaitMs: Number(event.queueWaitMs || 0),
                            durationMs: Number(event.durationMs || 0),
                            limiterActive: Number(event.limiterActive || 0),
                            limiterQueued: Number(event.limiterQueued || 0),
                            limiterLimit: Number(event.limiterLimit || 0),
                            error: event.error || null,
                            result: event.value || null,
                        });
                        await onProcessingProgress?.({
                            ...event,
                            sourceId,
                            kind: 'vk-chat',
                            itemId,
                            source: safeName || `VK chat ${peerId}`,
                            candidate,
                            priority: Number(event.priority || candidateDecisions.get(itemId)?.priority || 0),
                            reasons: candidateDecisions.get(itemId)?.reasons || [],
                            preview: parserCandidatePreview(event.item?.text),
                        });
                    },
                    isUnresolvedValue: (value, message) => (
                        candidateIds.has(String(message?.conversationMessageId ?? '')) && Boolean(value?.unresolved)
                    ),
                    isRetryableFailure: (error, message) => (
                        !['POSTER_GATE_UNRESOLVED', 'MANUAL_SESSION_INACTIVE'].includes(error?.code) &&
                        candidateIds.has(String(message?.conversationMessageId ?? '')) &&
                        (String(error?.vkChatStage || '') === 'gpt' || /(?:gpt|ai|429|5\d\d|timeout|network|fetch|socket|abort)/iu.test(String(error?.message ?? error ?? '')))
                    ),
                    retryDelayMs: clampInteger(
                        process.env.MANUAL_PARSER_BACKGROUND_RETRY_MS,
                        5_000,
                        5 * 60 * 1000,
                        15_000,
                    ),
                    onRetryCycle: ({ cycle, pendingCount, elapsedMs, maxRetryCycles, maxRetryElapsedMs }) => diagnostics?.log?.('source.processing.retry-cycle', {
                        sourceId,
                        cycle,
                        pendingCount,
                        elapsedMs,
                        maxRetryCycles,
                        maxRetryElapsedMs,
                    }),
                    onRetryExhausted: ({ cycle, pendingCount, elapsedMs, reason }) => diagnostics?.log?.('source.processing.retry-exhausted', {
                        sourceId,
                        cycle,
                        pendingCount,
                        elapsedMs,
                        reason,
                    }),
                },
            );
            processingResults.forEach((entry, index) => {
                if (entry?.status !== 'rejected') return;
                const message = processingMessages[index];
                markManualParserSeenItemFailed({
                    sourceId,
                    itemId: String(message?.conversationMessageId ?? ''),
                    runId: ledgerRunId,
                    error: String(entry?.reason?.message ?? entry?.reason ?? ''),
                });
            });
            failedProcessingItems = processingResults.filter((item) => item?.status === 'rejected').length;
            diagnostics?.log?.('source.processing.finish', {
                sourceId,
                itemCount: orderedCapturedMessages.length,
                candidatesChecked,
                eventsFound,
                failedProcessingItems,
            });
        } finally {
            manualSessionActive = false;
            liveMonitorActive = false;
            progressiveBackfillPromise = null;

            const page = livePage;
            livePage = null;
            if (page && !page.isClosed()) {
                await page.close().catch(() => {});
            }
            queuedFingerprints.clear();
        }

        const previous = getVkChatScraperState(peerId);
        const now = Math.floor(Date.now() / 1000);
        const processingSucceeded = !timedOut && failedProcessingItems === 0;
        const finitePassError = [
            timedOut ? 'finite-pass-deadline-reached' : '',
            failedProcessingItems > 0
                ? `finite-pass-processing-failed:${failedProcessingItems}` : '',
        ].filter(Boolean).join('; ');
        updateVkChatScraperState({
            peerId,
            conversationUrl,
            conversationName: safeName,
            lastMessageId: Math.max(
                Number(previous?.lastMessageId ?? 0),
                lastMessageId,
            ),
            lastSuccessAt: processingSucceeded
                ? now : Number(previous?.lastSuccessAt ?? 0),
            lastAttemptAt: Math.floor(finitePassStartedAt / 1000),
            lastError: finitePassError,
            initialCompleted: processingSucceeded
                ? true : Boolean(previous?.initialCompleted),
            messagesSeen: Number(previous?.messagesSeen ?? 0),
            candidatesChecked: Number(previous?.candidatesChecked ?? 0),
            eventsFound: Number(previous?.eventsFound ?? 0),
        });

        console.log(
            '[VK CHAT FINITE PASS]',
            `peer=${peerId}`,
            `loaded=${loaded}`,
            `checked=${candidatesChecked}`,
            `events=${eventsFound}`,
            `timedOut=${timedOut}`,
            `reachedTop=${reachedTop}`,
            `historyOlder=${historyBackfilledMessages}/${historyBackfillTarget || 0}`,
            `initialMinCmid=${initialMinCmid || 0}`,
            `initialMaxCmid=${initialMaxCmid || 0}`,
            `downFirst=${downSweepPerformed}`,
            `unreadAtStart=${downSweepUnreadCount}`,
            `downCaptured=${downSweepCapturedMessages}`,
            `returnedToFrontier=${returnedToInitialFrontier}`,
            `durationMs=${Date.now() - finitePassStartedAt}`,
        );

        return {
            peerId,
            mode: 'finite-manual',
            fetchedMessages: loaded,
            changedMessages,
            candidatesChecked,
            eventsFound,
            eventsCreatedCount,
            eventsUpdatedCount,
            visionCheckedImageCount,
            posterMatchAcceptedCount,
            posterMatchRejectedCount,
            lastMessageId,
            timedOut,
            reachedTop,
            historyBackfilledMessages,
            historyBackfillTarget,
            incrementalKnownSkippedCount,
            incrementalNewCount,
            initialMinCmid,
            initialMaxCmid,
            downSweepRequested,
            downSweepPerformed,
            downSweepUnreadCount,
            downSweepCapturedMessages,
            returnedToInitialFrontier,
            // Backward-compatible result aliases for older UI/tests.
            priorityBackfilledMessages: historyBackfilledMessages,
            priorityBackfillTarget: historyBackfillTarget,
            stoppedByOwner: false,
            failedProcessingItems,
        };
    }

    async function startManualSession() {
        manualSessionActive = true;
        liveMonitorActive = true;
        manualCloseNotificationSent = false;
        queuedFingerprints.clear();

        try {
            if (!livePage || livePage.isClosed()) {
                await openLivePage();
            }

            await sweepUnreadTailForManualSession();
            void startProgressiveBackfill();
            startLiveMonitor(livePage);
        } catch (error) {
            manualSessionActive = false;
            liveMonitorActive = false;
            throw error;
        }

        return {
            peerId,
            conversationName: safeName,
            conversationUrl,
            active: true,
        };
    }

    async function stopManualSession({
        closePage = true,
        notifyClose = true,
        waitForBackfill = true,
    } = {}) {
        manualSessionActive = false;
        liveMonitorActive = false;
        queuedFingerprints.clear();

        const page = livePage;
        livePage = null;

        if (closePage && page && !page.isClosed()) {
            await page.close().catch(() => {});
        }

        if (waitForBackfill) {
            await progressiveBackfillPromise?.catch(() => {});
        }
        if (notifyClose) {
            await notifyManualSessionClosed(closePage ? 'manual-stop-close' : 'manual-stop');
        }

        return {
            peerId,
            conversationName: safeName,
            active: false,
        };
    }

    async function run({ forceInitial = false } = {}) {
        if (activeRuns.has(peerId)) {
            return activeRuns.get(peerId);
        }

        const promise = (async () => {
            const startedAt = Math.floor(Date.now() / 1000);
            const state = getVkChatScraperState(peerId);
            const initialMode = forceInitial || !state?.initialCompleted;
            let page = livePage && !livePage.isClosed()
                ? livePage
                : null;
            let messages = [];

            if (page) {
                try {
                    messages = await withPageOperation(() =>
                        extractRenderedMessagesWithRetry(page, conversationUrl),
                    );
                } catch (error) {
                    // A browser failure is not an observed empty conversation.
                    throw error;
                }
            } else {
                const collected = await collectMessages({
                    conversationUrl,
                    targetCount: initialMode ? safeInitialMessages : 120,
                    stopAtMessageId: initialMode
                        ? 0
                        : Number(state?.lastMessageId ?? 0),
                    dataDirectory: safeDataDirectory,
                    notifyAttention,
                });
                page = collected.page;
                messages = collected.messages;
            }

            // Scheduled mode has no live monitor to activate processing for it.
            // Open a scoped processing session only for the duration of this batch.
            const wasManualSessionActive = manualSessionActive;
            if (!liveMonitorEnabled) manualSessionActive = true;
            else startLiveMonitor(page);
            let batchResult;
            try {
                // Errors from individual workers are accounted for by failedItems.
                // Reconsider prior fingerprints when a new scheduled attempt starts.
                if (!liveMonitorEnabled) queuedFingerprints.clear();
                batchResult = await queueMessagesForProcessing(
                    messages,
                    initialMode ? 'initial' : 'scheduled',
                );
            } finally {
                if (!liveMonitorEnabled) {
                    manualSessionActive = wasManualSessionActive;
                    if (page && !page.isClosed()) await page.close().catch(() => {});
                }
            }
            const changedMessages = batchResult.changedMessages;
            const candidatesChecked = batchResult.candidatesChecked;
            const eventsFound = batchResult.eventsFound;

            /*
             * Даже после завершения первичного прохода гарантированно держим
             * вкладку открытой минимум 180 секунд. Live-наблюдатель продолжает
             * работать и после возврата run(), поэтому вкладка остаётся открытой
             * до остановки приложения или закрытия владельцем. После закрытия
             * этот же источник автоматически не переоткрывается.
             */
            if (liveMonitorEnabled) {
                await sleep(safePostScanHoldMs);
            }

            const processingSucceeded = batchResult.failedItems === 0;
            const lastMessageId = Math.max(
                Number(state?.lastMessageId ?? 0),
                ...(processingSucceeded ? messages.map(stableVkChatMessageId) : []),
                processingSucceeded ? Number(batchResult.lastMessageId ?? 0) : 0,
                0,
            );
            const finishedAt = Math.floor(Date.now() / 1000);

            const latestState = getVkChatScraperState(peerId);
            updateVkChatScraperState({
                peerId,
                conversationUrl,
                conversationName: safeName,
                lastMessageId: processingSucceeded
                    ? Math.max(Number(latestState?.lastMessageId ?? 0), lastMessageId)
                    : Number(state?.lastMessageId ?? 0),
                lastSuccessAt: processingSucceeded
                    ? finishedAt : Number(state?.lastSuccessAt ?? 0),
                lastAttemptAt: startedAt,
                lastError: processingSucceeded ? '' : `scheduled-processing-failed:${batchResult.failedItems}`,
                initialCompleted: processingSucceeded
                    ? true : Boolean(state?.initialCompleted),
                messagesSeen: Number(latestState?.messagesSeen ?? 0),
                candidatesChecked: Number(latestState?.candidatesChecked ?? 0),
                eventsFound: Number(latestState?.eventsFound ?? 0),
            });

            console.log(
                '[VK CHAT SCRAPER]',
                `peer=${peerId}`,
                `mode=${initialMode ? 'initial' : 'hourly'}`,
                `fetched=${messages.length}`,
                `checked=${candidatesChecked}`,
                `events=${eventsFound}`,
                `lastMessageId=${lastMessageId}`,
                `failedItems=${batchResult.failedItems}`,
            );

            return {
                peerId,
                mode: initialMode ? 'initial' : 'hourly',
                fetchedMessages: messages.length,
                changedMessages,
                candidatesChecked,
                eventsFound,
                lastMessageId: processingSucceeded ? lastMessageId : Number(state?.lastMessageId ?? 0),
                failedItems: batchResult.failedItems,
                ok: processingSucceeded,
            };
        })();

        activeRuns.set(peerId, promise);

        try {
            return await promise;
        } catch (error) {
            const previous = getVkChatScraperState(peerId);
            updateVkChatScraperState({
                peerId,
                conversationUrl,
                conversationName: safeName,
                lastMessageId: Number(previous?.lastMessageId ?? 0),
                lastSuccessAt: Number(previous?.lastSuccessAt ?? 0),
                lastAttemptAt: Math.floor(Date.now() / 1000),
                lastError: String(error?.message ?? error).slice(0, 2000),
                initialCompleted: Boolean(previous?.initialCompleted),
                messagesSeen: Number(previous?.messagesSeen ?? 0),
                candidatesChecked: Number(previous?.candidatesChecked ?? 0),
                eventsFound: Number(previous?.eventsFound ?? 0),
            });
            throw error;
        } finally {
            activeRuns.delete(peerId);
        }
    }

    async function runIfDue() {
        const state = getVkChatScraperState(peerId);
        const lastSuccessAt = Number(state?.lastSuccessAt ?? 0) * 1000;

        if (!state?.initialCompleted || Date.now() - lastSuccessAt >= intervalMs) {
            return run({ forceInitial: !state?.initialCompleted });
        }

        return null;
    }

    async function processLiveMessage(message, { traceAi = null, forceReprocess = false } = {}) {
        assertVkChatSessionActive(manualSessionActive);

        const normalized = normalizeBrowserMessage({
            ...message,
            conversationMessageId: Number(message?.conversationMessageId),
        }, conversationUrl);
        const result = await processMessage(normalized, {
            peerId,
            conversationUrl,
            conversationName: safeName,
            timeZone,
            dataDirectory: safeDataDirectory,
            analyzeMessageWithAi,
            hydrateMessageEvidence,
            notifyAttention,
            traceAi,
            forceReprocess,
        });

        if (result.changed || result.candidateChecked) {
            const state = getVkChatScraperState(peerId);
            updateVkChatScraperState({
                peerId,
                conversationUrl,
                conversationName: safeName,
                lastMessageId: Math.max(
                    Number(state?.lastMessageId ?? 0),
                    stableVkChatMessageId(normalized),
                ),
                lastSuccessAt: Number(state?.lastSuccessAt ?? 0),
                lastAttemptAt: Number(state?.lastAttemptAt ?? 0),
                lastError: String(state?.lastError ?? ''),
                initialCompleted: Boolean(state?.initialCompleted),
                messagesSeen: Number(state?.messagesSeen ?? 0) + (result.changed ? 1 : 0),
                candidatesChecked: Number(state?.candidatesChecked ?? 0) + (result.candidateChecked ? 1 : 0),
                eventsFound: Number(state?.eventsFound ?? 0) + result.eventCount,
            });
        }

        return result;
    }

    function start(delayMs = 4_000) {
        const safeStartDelayMs = clampInteger(
            delayMs,
            1_000,
            10 * 60 * 1000,
            4_000,
        );
        const firstTimer = setTimeout(() => {
            const initialState = getVkChatScraperState(peerId);
            const firstRun = liveMonitorEnabled
                ? run({ forceInitial: !initialState?.initialCompleted })
                : runIfDue();

            firstRun.catch((error) => {
                console.error(
                    '[VK CHAT INITIAL ERROR]',
                    `peer=${peerId}`,
                    String(error?.message ?? error),
                );
            });
        }, safeStartDelayMs);
        firstTimer.unref();

        const timer = setInterval(() => {
            runIfDue().catch((error) => {
                console.error(
                    '[VK CHAT HOURLY ERROR]',
                    `peer=${peerId}`,
                    String(error?.message ?? error),
                );
            });
        }, ONE_HOUR_MS);
        timer.unref();
        return timer;
    }

    return {
        peerId,
        conversationUrl,
        conversationName: safeName,
        initialMessages: safeInitialMessages,
        autoScrollMessages: safeAutoScrollMessages,
        intervalHours: intervalMs / ONE_HOUR_MS,
        liveMonitorEnabled,
        livePollMs: safeLivePollMs,
        postScanHoldMs: safePostScanHoldMs,
        getStatus: () => getVkChatScraperState(peerId),
        getUpcoming: (limit = 10) => getVkChatUpcomingEvents({ peerId, limit }),
        isManualSessionActive: () => manualSessionActive,
        runFiniteManualPass,
        startManualSession,
        stopManualSession,
        processLiveMessage,
        run,
        runIfDue,
        start,
    };
}
