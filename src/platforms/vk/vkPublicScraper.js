/**
 * Скрейпер публичных VK-страниц. Переиспользует общий браузер и строгую проверку событий.
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createHash, randomInt } from 'node:crypto';
import { extname, join } from 'node:path';

import {
    findExistingAnnouncementEvidence,
    finalizeManualParserSeenItem,
    getManualParserSeenItem,
    isManualParserSeenItemFinalStatus,
    markManualParserSeenItemFailed,
    markManualParserSeenItemProcessing,
    upsertManualParserSeenItem,
    getVkEventsForPostRefresh,
    getVkPostMeta,
    getVkScraperState,
    getVkUpcomingEvents,
    persistVkSourceAndEvents,
    updateStoredEventRecordFromReparse,
    updateVkScraperState,
} from '../../infrastructure/database/index.js';

import {
    browserDownloadBuffer,
    openScraperPage,
    settleScraperPage,
    waitForManualAccess,
} from '../../infrastructure/browser/browserGrabber.js';

import {
    explainPublicPostEventCandidate,
    parsePublicPostLocally,
    publicPostLooksLikeEventCandidate,
    validatePublicAiEvents,
} from '../../features/events/publicPostLocalParser.js';

import {
    prepareEventImages,
    assignEventImageIndexesFromFacts,
    applyPosterDerivedVenueFallback,
    parseIndexedImageFacts,
    filterEventsWithAnnouncementImages,
} from '../../features/events/eventAssets.js';

import {
    isScraperTargetClosedError,
} from '../../features/scrapers/browserRecoveryPolicy.js';

import {
    getManualParserProcessingConcurrency,
    parserCandidatePreview,
    runManualParserPoolUntilSettled,
} from '../../features/scrapers/manualProcessingPool.js';

import {
    rankEventImageCandidates,
} from '../../features/events/eventImageSelection.js';

import {
    cleanVkEventText,
} from '../../features/events/eventText.js';
import {
    sanitizeEventBodyText,
} from '../../features/events/eventTextSanitation.js';
import {
    attachVkChildSourceProvenance,
    boundedVkEventSourceLinks,
    classifyVkEventSourceUrl,
    resolveVkShortUrlControlled,
} from '../../features/events/vkEventLinkEnrichment.js';
import {
    mergeVkCapturedImageMedia,
} from '../../features/events/vkCapturedMediaMerge.js';

import {
    classifyVkSourcePageHealth,
} from './vkSourcePageHealth.js';

// The staged parser is serialized into page.evaluate() and is the stable
// structure based fallback for immutable VK DOM snapshots.  Keep the legacy
// extractor below as the exact contour; the staged parser is only admitted
// when that contour cannot recover a post, so adaptive/heuristic recovery
// never changes a healthy exact result.
import { extractVkPublicDomStaged } from './vkStagedDomParser.js';

import {
    explainStrictEventRecord,
} from '../../features/events/eventValidation.js';

import {
    appendEventIngestAudit,
} from '../../features/events/eventIngestAudit.js';

import {
    shouldPreserveStoredEventsOnEmptyReparse,
} from '../../features/events/sourceEventPersistence.js';

import {
    mergeStoredEventWithFreshSource,
    selectFreshEventForStoredEvent,
} from '../../features/events/eventSourceRefresh.js';

import {
    runEventOperationWithRetries,
} from '../../features/events/eventRetry.js';

import {
    storedImageResultIsReusable,
    textEventsAreComplete,
    visionSkipReason,
} from '../../features/events/eventVisionPolicy.js';

import {
    extractRawDateMentions,
    isEventDateConsistentWithSource,
    parseVkPublishedAtLabel,
} from '../../features/events/publicPostDateEvidence.js';

import {
    createSourceTextFingerprint,
    fingerprintRemoteImages,
    imageFingerprintSetsEqual,
    parseImageFingerprints,
    sourceTextSimilarity,
    isLikelyVkNonPosterUiImageUrl,
} from '../../features/events/sourcePostFingerprint.js';


import {
    explainSecondaryPartyTextGate,
    secondaryJointVisionAccepted,
} from '../../features/events/secondaryPartyAdmission.js';
import { createVkPublicCaptureHash } from '../../features/events/vkPublicContentHash.js';
import { shouldSkipUnchangedCapturedItem } from '../../features/scrapers/manualParserCleanSkip.js';

const VK_PARSER_VERSION = 'vk-public-parser-multi-announcement-poster-repair-v18861';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HTML_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;
const MAX_IMAGES_PER_POST = 12;
const DEFAULT_USER_AGENT = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'AppleWebKit/537.36 (KHTML, like Gecko)',
    'Chrome/126.0.0.0 Safari/537.36',
].join(' ');
const activeRunPromises = new Map();
const keptManualPages = new Map();
const manualLiveLoops = new Map();

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

function sleep(milliseconds) {
    return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function clampInteger(value, minimum, maximum, fallback) {
    const parsed = Number(value);

    if (!Number.isFinite(parsed)) {
        return fallback;
    }

    return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function normalizeScreenName(value) {
    const source = String(value ?? '').trim();
    const match = source.match(
        /^(?:https?:\/\/)?(?:www\.)?(?:vk\.com|vk\.ru|m\.vk\.com)\/([A-Za-z0-9_.-]+)\/?(?:\?.*)?$/iu,
    );
    const screenName = (match?.[1] ?? source.replace(/^@/u, '')).trim();

    if (!/^[A-Za-z0-9_.-]{2,}$/u.test(screenName)) {
        throw new Error(`Некорректное имя VK-паблика: ${source}`);
    }

    return screenName;
}

function decodeHtmlEntities(value) {
    const named = {
        amp: '&', apos: "'", gt: '>', lt: '<', nbsp: ' ', quot: '"',
        laquo: '«', raquo: '»', mdash: '—', ndash: '–', hellip: '…', shy: '',
    };

    return String(value ?? '').replace(
        /&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/giu,
        (entity, code) => {
            const lower = String(code).toLowerCase();

            if (lower.startsWith('#x')) {
                const point = Number.parseInt(lower.slice(2), 16);
                return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
            }

            if (lower.startsWith('#')) {
                const point = Number.parseInt(lower.slice(1), 10);
                return Number.isFinite(point) ? String.fromCodePoint(point) : entity;
            }

            return Object.hasOwn(named, lower) ? named[lower] : entity;
        },
    );
}

function htmlToText(value) {
    return decodeHtmlEntities(
        String(value ?? '')
            .replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, '')
            .replace(/<style\b[^>]*>[\s\S]*?<\/style>/giu, '')
            .replace(/<br\s*\/?>/giu, '\n')
            .replace(/<\/(?:div|p|li|blockquote|h[1-6])\s*>/giu, '\n')
            .replace(/<[^>]+>/gu, ''),
    )
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n[ \t]+/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

function cleanPublicPostText(value, screenName = '') {
    const normalizedSource = String(screenName ?? '').trim().toLowerCase();
    const lines = cleanVkEventText(value)
        .split('\n')
        .map((line) => line.replace(/^действия\s+(?=\d)/iu, '').trim())
        .filter(Boolean);

    while (lines.length) {
        const first = lines[0];
        const isDieselHeading = normalizedSource === 'rb_diesel' &&
            /^rock\s+bar\s+diesel(?:\s*&\s*diesel\s+hall)?$/iu.test(first);
        const isOverlockHeading = normalizedSource === 'overlockbar' &&
            /^(?:overlock|overlock\s+bar)$/iu.test(first);

        if (!isDieselHeading && !isOverlockHeading) {
            break;
        }

        lines.shift();
    }

    return lines.join('\n').trim().slice(0, 12_000);
}

const VK_SOURCE_VALIDATION_EVIDENCE = new Map([
    ['rb_diesel', 'Rock Bar DIESEL & DIESEL Hall, Воронеж'],
    ['overlockbar', 'Overlock Bar, Воронеж'],
    ['vavilone_rb', 'The Last of Vavilone, Воронеж'],
    ['liverpool_pub_vrn', 'Liverpool Pub, Воронеж'],
    ['idmamaanarchy', 'Паб Мама Анархия, Воронеж'],
    ['meetbowling.club', 'Митбоулинг Клуб, Воронеж'],
]);

function buildVkValidationSourceText(post) {
    const source = String(post?.screenName ?? '').trim().toLowerCase();
    return [
        String(post?.text ?? '').trim(),
        VK_SOURCE_VALIDATION_EVIDENCE.get(source) || '',
    ].filter(Boolean).join('\n');
}

function getAttribute(tag, attributeName) {
    const pattern = new RegExp(
        `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
        'iu',
    );
    const match = String(tag ?? '').match(pattern);
    return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? '');
}

async function readResponseBuffer(response, maximumBytes) {
    const length = Number(response.headers.get('content-length') ?? 0);

    if (length > maximumBytes) {
        throw new Error(`Ответ слишком большой: ${length} байт`);
    }

    const buffer = Buffer.from(await response.arrayBuffer());

    if (buffer.length > maximumBytes) {
        throw new Error(`Ответ превысил ${maximumBytes} байт`);
    }

    return buffer;
}

async function fetchWithTimeout(url, {
    timeoutMs = 35_000,
    maximumBytes = MAX_HTML_BYTES,
    accept = 'text/html,application/xhtml+xml',
} = {}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);

    try {
        const response = await fetch(url, {
            redirect: 'follow',
            signal: controller.signal,
            headers: {
                accept,
                'accept-language': 'ru,en;q=0.8',
                'cache-control': 'no-cache',
                pragma: 'no-cache',
                'user-agent': DEFAULT_USER_AGENT,
            },
        });

        if (!response.ok) {
            throw new Error(`HTTP ${response.status} ${response.statusText}`);
        }

        return {
            buffer: await readResponseBuffer(response, maximumBytes),
            contentType: response.headers.get('content-type') ?? '',
            finalUrl: response.url,
        };
    } finally {
        clearTimeout(timer);
    }
}

function extractPostText(block) {
    const patterns = [
        /<div\b[^>]*class=(?:"[^"]*\bpi_text\b[^"]*"|'[^']*\bpi_text\b[^']*')[^>]*>([\s\S]*?)<\/div>/iu,
        /<div\b[^>]*class=(?:"[^"]*\bwall_post_text\b[^"]*"|'[^']*\bwall_post_text\b[^']*')[^>]*>([\s\S]*?)<\/div>/iu,
        /<div\b[^>]*class=(?:"[^"]*\bpost_text\b[^"]*"|'[^']*\bpost_text\b[^']*')[^>]*>([\s\S]*?)<\/div>/iu,
        /<div\b[^>]*class=(?:"[^"]*\bwi_body\b[^"]*"|'[^']*\bwi_body\b[^']*')[^>]*>([\s\S]*?)<\/div>/iu,
        /<div\b[^>]*data-testid=(?:"post_content"|'post_content')[^>]*>([\s\S]*?)<\/div>/iu,
    ];

    for (const pattern of patterns) {
        const match = block.match(pattern);
        const text = cleanVkEventText(htmlToText(match?.[1] ?? ''));

        if (text.length >= 3) {
            return text;
        }
    }

    // Последний резервный вариант: берём текст блока и отрезаем интерфейсные хвосты.
    return cleanVkEventText(
        htmlToText(block)
            .replace(/^(?:Rock Bar DIESEL[^\n]*\n)+/iu, ''),
    );
}

function extractImageUrls(block) {
    const candidates = [];
    const seen = new Set();
    const add = (value, { width = 0, height = 0, mediaHint = 'dom-generic', marker = '' } = {}) => {
        let url = decodeHtmlEntities(String(value ?? '').trim());

        if (url.startsWith('//')) {
            url = `https:${url}`;
        }

        const fingerprint = `${marker} ${url}`.toLowerCase();
        if (
            !/^https:\/\//iu.test(url) ||
            !/(?:userapi|vkuser|vkcdn|sun\d+-\d+\.userapi|pp\.userapi)/iu.test(url) ||
            isLikelyVkNonPosterUiImageUrl(url) || // also rejects ava=1
            /avatar|profile|emoji|reaction|sticker|icon|badge|logo|favicon|smile/iu.test(fingerprint) ||
            seen.has(url)
        ) {
            return;
        }

        seen.add(url);
        candidates.push({
            url,
            width: Number(width) || 0,
            height: Number(height) || 0,
            mediaHint,
        });
    };

    for (const tag of String(block ?? '').match(/<(?:img|source|div)\b[^>]*>/giu) ?? []) {
        const tagName = String(tag.match(/^<([a-z0-9]+)/iu)?.[1] ?? '').toLowerCase();
        const marker = [
            getAttribute(tag, 'class'),
            getAttribute(tag, 'id'),
            getAttribute(tag, 'data-testid'),
            getAttribute(tag, 'alt'),
            getAttribute(tag, 'aria-label'),
            getAttribute(tag, 'role'),
        ].join(' ').toLowerCase();
        const isUi = /avatar|profile|emoji|reaction|sticker|icon|badge|logo|favicon|smile/iu.test(marker);
        const isMediaMarker = /photo|media|image|attachment|poster|gallery|picture|thumb/iu.test(marker);
        const width = Number.parseInt(getAttribute(tag, 'width'), 10) || 0;
        const height = Number.parseInt(getAttribute(tag, 'height'), 10) || 0;

        if (isUi) continue;

        // У произвольных div не читаем data-url/src: там VK хранит много UI-
        // ресурсов. Фоновую картинку div берём только у явно media-контейнера.
        if (tagName !== 'div') {
            const hint = isMediaMarker ? 'dom-media' : 'dom-generic';
            add(getAttribute(tag, 'src'), { width, height, mediaHint: hint, marker });
            add(getAttribute(tag, 'data-src'), { width, height, mediaHint: hint, marker });
            add(getAttribute(tag, 'data-original'), { width, height, mediaHint: hint, marker });
            add(getAttribute(tag, 'data-lazy-src'), { width, height, mediaHint: hint, marker });
            for (const attribute of ['srcset', 'data-srcset']) {
                const values = String(getAttribute(tag, attribute) || '')
                    .split(',')
                    .map((entry) => entry.trim().split(/\s+/)[0])
                    .filter(Boolean)
                    .reverse();
                for (const value of values) {
                    add(value, { width, height, mediaHint: hint, marker });
                }
            }
        }

        if (isMediaMarker) {
            const style = getAttribute(tag, 'style');
            const bg = style.match(/background-image\s*:\s*url\((?:'([^']+)'|"([^"]+)"|([^\)]+))\)/iu);
            add(bg?.[1] ?? bg?.[2] ?? bg?.[3] ?? '', {
                width,
                height,
                mediaHint: 'dom-media',
                marker,
            });
        }
    }

    return rankEventImageCandidates(candidates, { limit: MAX_IMAGES_PER_POST })
        .map((candidate) => candidate.url);
}

function extractPublishedAt(block, {
    ownerId = 0,
    postId = 0,
    now = new Date(),
} = {}) {
    const timeTag = String(block ?? '').match(/<time\b[^>]*>/iu)?.[0] ?? '';
    const datetime = getAttribute(timeTag, 'datetime');
    const parsed = Date.parse(datetime);

    if (Number.isFinite(parsed)) {
        return Math.floor(parsed / 1000);
    }

    const unix = String(block ?? '').match(/\bdata-(?:time|date)=(?:"(\d{9,12})"|'(\d{9,12})')/iu);
    const value = Number(unix?.[1] ?? unix?.[2] ?? 0);

    if (Number.isFinite(value) && value > 0) {
        return value;
    }

    const expectedWall = ownerId && postId
        ? `wall${Number(ownerId)}_${Number(postId)}`.toLowerCase()
        : '';

    // У старого/мобильного VK дата поста часто не <time datetime>, а обычная
    // ссылка «7 авг» / «6 дек 2024» на сам wall-post. Берём только ссылку
    // ТЕКУЩЕГО поста, чтобы не принять дату события или соседней записи.
    if (expectedWall) {
        const anchorPattern = /<a\b[^>]*>[\s\S]*?<\/a>/giu;
        let anchor;

        while ((anchor = anchorPattern.exec(String(block ?? ''))) !== null) {
            const openingTag = anchor[0].match(/^<a\b[^>]*>/iu)?.[0] ?? '';
            const href = getAttribute(openingTag, 'href').toLowerCase();

            if (!href.includes(expectedWall)) {
                continue;
            }

            const label = htmlToText(anchor[0]);
            const fromLabel = parseVkPublishedAtLabel(label, { now });

            if (fromLabel > 0) {
                return fromLabel;
            }
        }
    }

    return 0;
}

function splitVkPostBlocks(html) {
    const source = String(html ?? '');
    const matches = [];
    const pattern = /(?:id|data-post-id|data-post)=(?:"(?:post)?(-?\d+)[_:](-?\d+)"|'(?:post)?(-?\d+)[_:](-?\d+)')|\bwall(-?\d+)_(-?\d+)\b/giu;
    let match;

    while ((match = pattern.exec(source)) !== null) {
        const ownerId = Number(match[1] ?? match[3] ?? match[5] ?? 0);
        const postId = Math.abs(Number(match[2] ?? match[4] ?? match[6] ?? 0));

        if (!postId) {
            continue;
        }

        matches.push({ index: match.index, ownerId, postId });
    }

    const uniqueStarts = [];
    const seen = new Set();

    for (const item of matches) {
        const key = `${item.ownerId}:${item.postId}`;

        if (!seen.has(key)) {
            seen.add(key);
            uniqueStarts.push(item);
        }
    }

    return uniqueStarts.map((item, index) => ({
        ...item,
        block: source.slice(item.index, uniqueStarts[index + 1]?.index ?? source.length),
    }));
}

function inferExpectedVkWallOwnerId(html, screenName) {
    const source = String(html ?? '');
    const name = String(screenName ?? '').trim();
    if (!source || !name) return 0;

    // The SPA bootstrap contains the canonical entity id for the page being
    // captured. Legacy regex parsing scans the whole serialized document,
    // which also contains localization/examples with unrelated `wall...`
    // strings. Restrict legacy fallback rows to the actual page owner.
    const exactNeedle = `"screenName":"${name}"`;
    let markerIndex = source.indexOf(exactNeedle);
    if (markerIndex < 0) {
        const escapedName = name.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&');
        const match = new RegExp(`"screenName"\\s*:\\s*"${escapedName}"`, 'u').exec(source);
        markerIndex = match?.index ?? -1;
    }
    if (markerIndex < 0) return 0;

    const routerWindow = source.slice(markerIndex, markerIndex + 1_600);
    const entityId = Number(routerWindow.match(/"entityId"\s*:\s*(\d+)/u)?.[1] || 0);
    const screenType = String(routerWindow.match(/"screenType"\s*:\s*"([^"]+)"/u)?.[1] || '').toLowerCase();
    if (!Number.isSafeInteger(entityId) || entityId <= 0) return 0;
    return screenType === 'group' ? -entityId : entityId;
}

export function parseVkPublicHtml(html, screenName) {
    const posts = [];
    const expectedOwnerId = inferExpectedVkWallOwnerId(html, screenName);

    for (const item of splitVkPostBlocks(html)) {
        if (expectedOwnerId && Number(item.ownerId) !== expectedOwnerId) {
            continue;
        }
        const text = cleanPublicPostText(
            extractPostText(item.block),
            screenName,
        );

        if (!text) {
            continue;
        }

        const ownerId = item.ownerId || 0;
        posts.push({
            screenName,
            ownerId,
            postId: item.postId,
            sourceUrl: ownerId
                ? `https://vk.ru/wall${ownerId}_${item.postId}`
                : `https://vk.ru/${screenName}?w=wall-${item.postId}`,
            publishedAt: extractPublishedAt(item.block, { ownerId, postId: item.postId }),
            text,
            imageUrls: extractImageUrls(item.block),
        });
    }

    const unique = new Map();

    for (const post of posts) {
        unique.set(post.postId, post);
    }

    return [...unique.values()].sort((left, right) => right.postId - left.postId);
}


export async function extractExactVkPostsFromDomSnapshot(page, html, screenName, { selectorContract = null } = {}) {
    if (!page || page.isClosed() || !String(html || '').trim()) return [];
    const snapshotResult = await page.evaluate(({ snapshotHtml, currentScreenName, selectorContract }) => {
        const doc = new DOMParser().parseFromString(String(snapshotHtml || ''), 'text/html');
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
        const resolveUrl = (value) => {
            const raw = String(value || '').trim();
            if (!raw || raw.startsWith('data:')) return '';
            try { return new URL(raw, 'https://vk.ru/').href; } catch { return ''; }
        };
        const parseIdentity = (value) => {
            const match = String(value || '').match(/(?:post|wall)?(-?\d+)[_:](\d+)/iu);
            if (!match) return null;
            const ownerId = Number(match[1]);
            const postId = Number(match[2]);
            return Number.isFinite(ownerId) && Number.isFinite(postId) && postId > 0
                ? { ownerId, postId }
                : null;
        };
        const contract = selectorContract?.selectorContract || selectorContract || {};
        // parser-all/final-DOM mode may intentionally skip disk baseline
        // persistence. Derive the same conservative selector contract directly
        // from the immutable HTML in that case; never guess a selector that has
        // no matching node in this exact snapshot.
        const inlineSelectorCandidates = {
            postRoot: ['[data-testid="post"][data-post-id]', '[data-testid*="post"][data-post-id]', 'article[data-post-id]', '[role="article"][data-post-id]'],
            content: ['[data-testid="post-content-container"]', '[data-testid*="post-content"]', '[class*="post-content-container"]'],
            image: ['img[data-testid="primary-attachment-image-content"]', 'img[class*="primary-attachment-image-content"]', '[data-testid*="attachment"] img', '[class*="primary-attachment"] img'],
            published: ['[data-testid="post_date_block_preview"]', '[data-testid*="post_date"]', 'time[datetime]'],
        };
        const inlineContract = Object.fromEntries(Object.entries(inlineSelectorCandidates).map(([field, candidates]) => {
            for (const candidate of candidates) {
                let nodes = [];
                try { nodes = [...doc.querySelectorAll(candidate)]; } catch {}
                const usable = field === 'postRoot'
                    ? nodes.some((node) => /-?\d+[_:]\d+/u.test(node.getAttribute('data-post-id') || ''))
                    : nodes.length > 0;
                if (usable) return [field, { selected: candidate, evidence: 'observed-in-immutable-dom' }];
            }
            return [field, { selected: '', evidence: 'absent-in-immutable-dom' }];
        }));
        const effectiveContract = Object.keys(contract).length ? contract : inlineContract;
        const observedSelector = (field, fallback) => {
            const selected = String(effectiveContract?.[field]?.selected || '').trim();
            if (!selected) return fallback;
            try { return doc.querySelectorAll(selected).length ? selected : fallback; } catch { return fallback; }
        };
        const postRootSelector = observedSelector('postRoot', '[data-testid="post"][data-post-id]');
        const contentSelector = observedSelector('content', '[data-testid="post-content-container"]');
        const imageSelector = observedSelector('image', 'img[data-testid="primary-attachment-image-content"]');
        const publishedSelector = observedSelector('published', '[data-testid="post_date_block_preview"]');
        const exactPostRoot = (node) => node?.closest?.(postRootSelector) || null;
        const nodeMarker = (node) => [
            String(node?.className || ''),
            node?.getAttribute?.('data-testid') || '',
            node?.getAttribute?.('role') || '',
            node?.getAttribute?.('aria-label') || '',
            node?.getAttribute?.('alt') || '',
        ].join(' ').toLowerCase();
        const uiMarker = /avatar|profile|author|emoji|reaction|sticker|icon|badge|logo|favicon|smile|post-header|post_date|date_block|views|like|comment|share/iu;
        const mediaMarker = /primary-attachment-image-content|primary-attachment|photo|media|attachment|poster|gallery|picture/iu;
        const photoAttachmentKey = (node) => {
            const anchor = node?.closest?.('a[href]');
            const href = String(anchor?.href || anchor?.getAttribute?.('href') || '');
            const match = href.match(/(?:^|[/?&])(?:z=)?(photo-?\d+_\d+)/iu);
            return String(match?.[1] || '').toLowerCase();
        };
        const domContextFor = (node) => {
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
            for (let depth = 0; current && depth < 16; depth += 1, current = current.parentElement) {
                const tag = String(current.tagName || '').toLowerCase();
                const id = String(current.id || current.getAttribute?.('id') || '').trim();
                const testId = String(current.getAttribute?.('data-testid') || '').trim();
                const classes = String(current.className || '').trim().split(/\s+/u).filter(Boolean);
                const selector = `${tag}${id ? `#${id}` : ''}${classes.length ? `.${classes.join('.')}` : ''}${testId ? `[data-testid=\"${testId}\"]` : ''}`;
                path.push(selector);
                ancestorChain.push({ depth, tagName: tag, id, className: String(current.className || ''), attributes: readAttributes(current), selector });
            }
            const allSameTag = node.ownerDocument?.querySelectorAll?.(String(node.tagName || '').toLowerCase()) || [];
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
                documentOrdinal: Array.prototype.indexOf.call(allSameTag, node),
                siblingIndex: siblings.indexOf(node),
                nearbyText: String(node.parentElement?.innerText || node.parentElement?.textContent || '').replace(/\s+/gu, ' ').trim(),
                outerHtml: String(node.outerHTML || ''),
            };
        };
        const dimensionsFromUrl = (value) => {
            const source = String(value || '');
            let width = 0;
            let height = 0;
            for (const match of source.matchAll(/(?:^|[?&,=])(?:as=)?(\d{2,5})x(\d{2,5})(?=$|[,&])/gu)) {
                width = Math.max(width, Number(match[1]) || 0);
                height = Math.max(height, Number(match[2]) || 0);
            }
            return { width, height };
        };
        const imageIsLargeEnough = (node, value, explicitMedia = false) => {
            const fromUrl = dimensionsFromUrl(value);
            const width = Math.max(Number.parseInt(node?.getAttribute?.('width') || '', 10) || 0, fromUrl.width);
            const height = Math.max(Number.parseInt(node?.getAttribute?.('height') || '', 10) || 0, fromUrl.height);
            // Current VK often serializes attachment images without width/height
            // attributes. A structural primary/photo attachment is accepted when
            // dimensions are unavailable; generic images need >=300x300.
            if (explicitMedia) return (!width || !height) || Math.max(width, height) >= 48;
            return width >= 300 && height >= 300;
        };
        const addImage = (list, node, value) => {
            const url = resolveUrl(value);
            if (!url) return;
            const marker = `${nodeMarker(node)} ${nodeMarker(node?.parentElement)} ${nodeMarker(node?.parentElement?.parentElement)}`;
            if (uiMarker.test(marker) || !mediaMarker.test(marker)) return;
            if (!/(?:vkuserphoto|userapi|vkcdn|okcdn|\.jpe?g(?:\?|$)|\.png(?:\?|$)|\.webp(?:\?|$))/iu.test(url)) return;
            if (!imageIsLargeEnough(node, url, true)) return;
            const attachmentKey = photoAttachmentKey(node);
            const duplicate = list.some((item) => (
                attachmentKey
                    ? String(item?.attachmentKey || '') === attachmentKey
                    : (!item?.attachmentKey && String(item?.url || '') === url)
            ));
            if (duplicate) return;
            list.push({ url, attachmentKey, vkPhotoId: attachmentKey, domContext: domContextFor(node) });
        };
        const nestingLevel = (node) => {
            const value = Number(node?.getAttribute?.('data-post-nesting-lvl') || 0);
            return Number.isFinite(value) ? value : 0;
        };
        const nestedAncestorWithin = (node, outerPost) => {
            const nested = node?.closest?.('[data-post-nesting-lvl]') || null;
            return nested && nested !== outerPost && outerPost.contains(nested) ? nested : null;
        };
        const ownOuterDescendants = (outerPost, selector) => [...outerPost.querySelectorAll(selector)]
            .filter((node) => exactPostRoot(node) === outerPost && !nestedAncestorWithin(node, outerPost));
        const stripUiAndNested = (node, currentNested = null) => {
            const clone = node.cloneNode(true);
            for (const nested of [...clone.querySelectorAll('[data-post-nesting-lvl]')]) {
                if (!currentNested || nestingLevel(nested) > nestingLevel(currentNested)) nested.remove();
            }
            for (const ui of clone.querySelectorAll(
                '[data-testid="post-header"], [data-testid^="post_footer_action_"], [data-testid="post_date_block_preview"], button, [role="button"]'
            )) ui.remove();
            return clean(clone.textContent || '');
        };
        const readContentText = (scope, outerPost, { nested = false } = {}) => {
            const candidates = [];
            for (const content of scope.querySelectorAll(contentSelector)) {
                if (exactPostRoot(content) !== outerPost && !nested) continue;
                if (!nested && nestedAncestorWithin(content, outerPost)) continue;
                const expanded = [...content.querySelectorAll(
                    '[data-testid="showmoretext-in-expanded"], [data-testid="showmoretext-in"], [data-testid="showmoretext"]'
                )];
                const preferred = expanded.length ? expanded : [content];
                for (const node of preferred) {
                    if (!nested && nestedAncestorWithin(node, outerPost)) continue;
                    const text = stripUiAndNested(node, nested ? scope : null);
                    if (text.length >= 3 && !candidates.includes(text)) candidates.push(text);
                }
            }
            return candidates.sort((a, b) => b.length - a.length)[0] || '';
        };
        const deepestRepost = (outerPost) => [...outerPost.querySelectorAll('[data-post-nesting-lvl]')]
            .filter((node) => node !== outerPost)
            .sort((left, right) => {
                const levelDiff = nestingLevel(right) - nestingLevel(left);
                if (levelDiff) return levelDiff;
                const leftText = clean(left.textContent || '').length;
                const rightText = clean(right.textContent || '').length;
                return rightText - leftText;
            })[0] || null;
        const collectImages = (scope, outerPost, { nested = false } = {}) => {
            const imageUrls = [];
            const selectors = [
                imageSelector,
                'img[class*="primary-attachment-image-content"]',
                '[data-testid*="attachment"] img',
                '[class*="primary-attachment"] img',
                '[class*="Photo"] img',
                '[class*="photo"] img',
            ].join(', ');
            for (const image of scope.querySelectorAll(selectors)) {
                if (!nested) {
                    if (exactPostRoot(image) !== outerPost || nestedAncestorWithin(image, outerPost)) continue;
                } else if (!scope.contains(image)) {
                    continue;
                }
                for (const value of [
                    image.getAttribute('src'),
                    image.getAttribute('data-src'),
                    image.getAttribute('data-original'),
                    image.getAttribute('data-lazy-src'),
                ]) addImage(imageUrls, image, value);
                for (const entry of String(image.getAttribute('srcset') || image.getAttribute('data-srcset') || '').split(',')) {
                    addImage(imageUrls, image, entry.trim().split(/\s+/u)[0]);
                }
            }
            return imageUrls.slice(0, 12);
        };

        const result = [];
        const seen = new Set();
        const posts = [...doc.querySelectorAll(postRootSelector)]
            .filter((post) => nestingLevel(post) <= 0);

        for (const post of posts) {
            const identity = parseIdentity(post.getAttribute('data-post-id'));
            if (!identity) continue;
            const key = `${identity.ownerId}_${identity.postId}`;
            if (seen.has(key)) continue;
            seen.add(key);

            const contentText = readContentText(post, post, { nested: false });
            const nested = deepestRepost(post);
            const repostText = nested ? readContentText(nested, post, { nested: true }) : '';
            const text = [
                contentText,
                repostText && !contentText.includes(repostText)
                    ? `[Репост/вложенный пост VK]\n${repostText}`
                    : '',
            ].filter(Boolean).join('\n\n').slice(0, 12_000);
            if (!text) continue;

            // V188.68: capture is lossless across repost layers. The original
            // wall/repost media is kept even when the outer message also has a
            // decorative image. Selection happens later with provenance-aware
            // ranking instead of deleting nested candidates at capture time.
            const outerImages = collectImages(post, post, { nested: false });
            const nestedImages = nested ? collectImages(nested, post, { nested: true }) : [];
            const imageMedia = [
                ...nestedImages.map((item) => ({ ...item, origin: 'repost-wall', repostDepth: Math.max(1, nestingLevel(nested)) })),
                ...outerImages.map((item) => ({ ...item, origin: 'outer-message', repostDepth: 0 })),
            ].filter((item, index, rows) => rows.findIndex((other) => (
                item.attachmentKey
                    ? other.attachmentKey === item.attachmentKey
                    : (!other.attachmentKey && other.url === item.url)
            )) === index).slice(0, 12);
            const imageUrls = imageMedia.map((item) => item.url);
            const imageOrigin = nestedImages.length
                ? (outerImages.length ? 'nested-repost+outer' : 'nested-repost')
                : (outerImages.length ? 'outer-primary' : 'none');
            const eventLinks = [...post.querySelectorAll('a[href]')]
                .map((anchor) => {
                    const raw = String(anchor.getAttribute('href') || '').trim();
                    if (!raw) return null;
                    let url = '';
                    try { url = new URL(raw, location.href).href; } catch { return null; }
                    const anchorText = clean(anchor.textContent || anchor.getAttribute('aria-label') || '');
                    let context = anchorText;
                    let node = anchor.parentElement;
                    for (let depth = 0; node && depth < 4 && post.contains(node); depth += 1, node = node.parentElement) {
                        const candidate = clean(node.textContent || '');
                        if (candidate.length >= anchorText.length && candidate.length <= 900) context = candidate;
                    }
                    return { url, text: anchorText.slice(0, 300), context: context.slice(0, 900) };
                })
                .filter(Boolean)
                .filter((item, index, rows) => rows.findIndex((other) => other.url === item.url) === index)
                .slice(0, 80);
            const links = eventLinks.map((item) => item.url);

            const dateNode = ownOuterDescendants(post, publishedSelector)[0] || null;
            const publishedLabel = clean([
                dateNode?.getAttribute?.('aria-label') || '',
                dateNode?.getAttribute?.('title') || '',
                dateNode?.textContent || '',
            ].find(Boolean) || '');
            const timeNode = ownOuterDescendants(post, 'time[datetime]')[0] || null;
            const parsedTime = Date.parse(timeNode?.getAttribute('datetime') || '');

            result.push({
                screenName: currentScreenName,
                ownerId: identity.ownerId,
                postId: identity.postId,
                sourceUrl: `https://vk.ru/wall${identity.ownerId}_${identity.postId}`,
                publishedAt: Number.isFinite(parsedTime) ? Math.floor(parsedTime / 1000) : 0,
                publishedLabel,
                contentText,
                repostText,
                text,
                links,
                eventLinks,
                imageUrls,
                imageMedia,
                imageOrigin,
                domAudit: domContextFor(post),
                parserPass: 'snapshot-exact-current-dom',
            });
        }
        return {
            items: result,
            diagnostics: {
                postTestIdCount: doc.querySelectorAll('[data-testid="post"]').length,
                postIdCount: doc.querySelectorAll('[data-post-id]').length,
                selectorContractProvided: Boolean(selectorContract),
                selectorContractSource: selectorContract ? 'baseline' : 'immutable-inline',
                selectorContractSelected: {
                    postRoot: postRootSelector,
                    content: contentSelector,
                    image: imageSelector,
                    published: publishedSelector,
                },
                exactRootCount: posts.length,
                contentContainerCount: doc.querySelectorAll('[data-testid="post-content-container"], [class*="post-content-container"]').length,
                primaryAttachmentCount: doc.querySelectorAll('[data-testid="primary-attachment-image-content"], [class*="primary-attachment-image-content"]').length,
                dateBlockCount: doc.querySelectorAll('[data-testid="post_date_block_preview"]').length,
                parsedCount: result.length,
            },
        };
    }, { snapshotHtml: String(html), currentScreenName: screenName, selectorContract });

    // If the exact current-DOM contract is absent (VK occasionally ships a
    // class/data-testid variant), run the self-contained staged parser against
    // this same immutable HTML. This keeps stage 2/3 recovery reproducible
    // and prevents a live-DOM read from changing post identity after the
    // snapshot barrier.
    let snapshotItems = Array.isArray(snapshotResult?.items) ? snapshotResult.items : [];
    let stagedDiagnostics = {};
    if (!snapshotItems.length) {
        const staged = await page.evaluate(extractVkPublicDomStaged, {
            screenName: String(screenName || ''),
            snapshotHtml: String(html),
            baseUrl: 'https://vk.ru/',
        }).catch(() => null);
        stagedDiagnostics = staged?.signature || {};
        snapshotItems = (Array.isArray(staged?.posts) ? staged.posts : []).map((post) => ({
            ...post,
            imageMedia: (Array.isArray(post?.ownMedia) && post.ownMedia.length
                ? post.ownMedia
                : (Array.isArray(post?.imageUrls) ? post.imageUrls : []).map((url, mediaIndex) => ({ url, mediaIndex })))
                .map((item) => ({ ...item, origin: 'staged-dom', repostDepth: Number(post?.repostDepth || 0) }))
                .filter((item) => item?.url),
            imageUrls: Array.isArray(post?.imageUrls) ? post.imageUrls : [],
            links: Array.isArray(post?.links) ? post.links : [],
            eventLinks: Array.isArray(post?.eventLinks) ? post.eventLinks : [],
            parserPass: `vk-staged-dom-v18832-stage-${Number(post?.parserStage || staged?.stage || 0)}`,
        }));
    }
    const normalized = snapshotItems
        .map((post) => ({
            ...post,
            publishedAt: Number(post.publishedAt) > 0
                ? Number(post.publishedAt)
                : parseVkPublishedAtLabel(post.publishedLabel),
            contentText: cleanPublicPostText(post.contentText, screenName),
            repostText: cleanPublicPostText(post.repostText, screenName),
            text: cleanPublicPostText(post.text, screenName),
            links: [...new Set((Array.isArray(post.links) ? post.links : []).map(String).filter(Boolean))],
            eventLinks: (Array.isArray(post.eventLinks) ? post.eventLinks : []).filter((item) => item?.url),
            imageMedia: (Array.isArray(post.imageMedia) ? post.imageMedia : [])
                .map((item) => ({
                    ...item,
                    url: String(item?.url || '').trim(),
                    attachmentKey: String(item?.attachmentKey || '').trim().toLowerCase(),
                }))
                .filter((item) => item.url),
            imageUrls: (Array.isArray(post.imageMedia) && post.imageMedia.length
                ? post.imageMedia.map((item) => String(item?.url || '').trim())
                : (Array.isArray(post.imageUrls) ? post.imageUrls : []).map(String)
            ).filter(Boolean),
        }))
        .filter((post) => post.text.length >= 3);
    Object.defineProperty(normalized, 'snapshotDiagnostics', {
        value: { ...(snapshotResult?.diagnostics || {}), ...(stagedDiagnostics || {}), stagedFallbackUsed: Boolean(stagedDiagnostics && Object.keys(stagedDiagnostics).length) },
        enumerable: false,
    });
    return normalized;
}

async function extractRenderedVkPosts(page, screenName, { snapshotHtml = '' } = {}) {
    const rawPosts = await page.evaluate(({ currentScreenName, immutableSnapshotHtml, baseUrl }) => {
        const snapshotMode = Boolean(String(immutableSnapshotHtml || '').trim());
        const rootDocument = snapshotMode
            ? new DOMParser().parseFromString(String(immutableSnapshotHtml), 'text/html')
            : document;
        const unique = new Map();
        const anchors = [
            ...rootDocument.querySelectorAll('a[href*="wall"]'),
        ];

        function structuralTokens(node) {
            return String(node?.className || '')
                .split(/\s+/u)
                .map((token) => token.trim())
                .filter((token) => token.length >= 2 && token.length <= 100)
                .map((token) => token.replace(/[0-9a-f]{8,}/giu, '#').replace(/\d{2,}/gu, '#'))
                .sort()
                .slice(0, 10);
        }

        function repeatedSignature(node) {
            return [
                String(node?.tagName || '').toLowerCase(),
                String(node?.getAttribute?.('role') || '').toLowerCase(),
                String(node?.getAttribute?.('data-testid') || '').toLowerCase().replace(/\d+/gu, '#'),
                structuralTokens(node).join('.'),
                [...node?.children || []].slice(0, 8).map((child) => String(child.tagName || '').toLowerCase()).join(','),
            ].join('|');
        }

        function repeatedSiblingCount(node) {
            const parent = node?.parentElement;
            if (!parent) return 0;
            const signature = repeatedSignature(node);
            let count = 0;
            for (const sibling of [...parent.children || []].slice(0, 180)) {
                if (repeatedSignature(sibling) === signature) count += 1;
            }
            return count;
        }

        function genericContainerScore(node) {
            if (!node || node.closest?.('aside, nav, [role="navigation"]')) return -100;
            const rect = snapshotMode
                ? { width: 900, height: 120, left: 120, right: 1020 }
                : (node.getBoundingClientRect?.() || { width: 0, height: 0, left: 0, right: 0 });
            if (!snapshotMode && (rect.width < 220 || rect.height < 30)) return -100;
            const text = String(node.innerText || node.textContent || '').trim();
            if (text.length < 3 || text.length > 30_000) return -100;
            const wallLinks = node.querySelectorAll?.('a[href*="wall"]')?.length ?? 0;
            const media = node.querySelectorAll?.('img, picture, video')?.length ?? 0;
            const repeats = repeatedSiblingCount(node);
            const viewportWidth = snapshotMode ? 1200 : Math.max(1, window.innerWidth || rootDocument.documentElement?.clientWidth || 1);
            const center = (Number(rect.left || 0) + Number(rect.right || (rect.left + rect.width))) / 2;
            const central = center >= viewportWidth * 0.14 && center <= viewportWidth * 0.90;
            const marker = `${node.className || ''} ${node.getAttribute?.('data-testid') || ''}`;
            let score = 0;
            score += Math.min(42, repeats * 7);
            if (wallLinks) score += Math.min(18, wallLinks * 6);
            if (media) score += Math.min(10, media * 2);
            if (text.length >= 20) score += 4;
            if (text.length >= 120) score += 3;
            if (central) score += 5;
            // Semantic class names help when present, but are never required.
            if (/(?:post|wall|feed|item|entry|row)/iu.test(marker)) score += 3;
            return score;
        }

        function findContainer(anchor) {
            const exact = anchor.closest(
                '[data-testid="post"][data-post-id], [data-testid="post"][data-post], [data-post-id]',
            );
            if (exact) return { container: exact, pass: 'pass1-exact' };

            const adaptive = anchor.closest(
                '[data-post], article, .Post, .post, .wall_item, .feed_row, [data-testid*="post"]',
            );
            if (adaptive) return { container: adaptive, pass: 'pass2-adaptive' };

            let node = anchor.parentElement;
            let best = null;
            let bestScore = -1;
            for (let depth = 0; node && depth < 10; depth += 1) {
                const score = genericContainerScore(node);
                if (score > bestScore) {
                    best = node;
                    bestScore = score;
                }
                node = node.parentElement;
            }

            return {
                container: bestScore >= 8 ? best : anchor.parentElement,
                pass: 'pass3-heuristic',
            };
        }

        // page.evaluate runs in the browser realm and cannot see Node/ESM
        // imports from this module. Keep this browser-safe copy aligned with
        // sourcePostFingerprint.js::isLikelyVkNonPosterUiImageUrl.
        function isLikelyVkProfileAvatarUrlInPage(value) {
            const url = String(value ?? '').trim();
            if (!url) return false;
            return /(?:[?&])ava=1(?:&|$)/iu.test(url) ||
                /(?:^|[/?&._-])avatar(?:[/?&._=-]|$)/iu.test(url);
        }

        function isLikelyVkNonPosterUiImageUrlInPage(value) {
            const url = String(value ?? '').trim();
            if (!url) return false;
            if (isLikelyVkProfileAvatarUrlInPage(url)) return true;
            if (/(?:[?&])type=(?:audio|emoji|reaction|sticker|gift|icon)(?:&|$)/iu.test(url)) return true;
            if (/(?:^|[/?&._-])(?:emoji|reaction|sticker|favicon|badge|smile)(?:[/?&._=-]|$)/iu.test(url)) return true;

            const sizes = [...url.matchAll(/(?:^|[?&,=])(?:size=|cs=)?(\d{1,4})x(\d{1,4})(?=$|[,&])/giu)]
                .map((match) => [Number(match[1]), Number(match[2])])
                .filter(([width, height]) => width > 0 && height > 0);
            if (sizes.length && Math.max(...sizes.map(([width, height]) => Math.max(width, height))) <= 160) {
                return true;
            }
            return false;
        }

        function cleanText(value) {
            return String(value || '')
                .replace(/\u00a0/g, ' ')
                .replace(/[ \t]+\n/g, '\n')
                .replace(/\n[ \t]+/g, '\n')
                .replace(/\n{3,}/g, '\n\n')
                .trim()
                .slice(0, 12_000);
        }

        function parseContainerPostIdentity(value) {
            const raw = String(value || '');
            const match = raw.match(/(?:post|wall)?(-?\d+)[_:](-?\d+)/i);
            if (!match) return null;
            const ownerId = Number(match[1]);
            const postId = Math.abs(Number(match[2]));
            return Number.isFinite(ownerId) && postId
                ? { ownerId, postId }
                : null;
        }

        function readContainerPostIdentity(container) {
            for (const name of ['data-post-id', 'data-post', 'id']) {
                const parsed = parseContainerPostIdentity(container?.getAttribute?.(name));
                if (parsed) return parsed;
            }
            return null;
        }

        function isLikelyPostPermalink(anchor) {
            const text = String(anchor?.innerText || anchor?.textContent || '')
                .replace(/\s+/g, ' ')
                .trim();
            const marker = [
                String(anchor?.className || ''),
                anchor?.getAttribute?.('data-testid') || '',
                anchor?.getAttribute?.('aria-label') || '',
                anchor?.getAttribute?.('title') || '',
            ].join(' ').toLowerCase();

            return Boolean(
                anchor?.querySelector?.('time') ||
                /(?:post.*date|date.*post|rel_date|post_link|postheader|post_header)/i.test(marker) ||
                /^(?:сегодня|вчера)(?:\s+в)?(?:\s+\d{1,2}:\d{2})?$/i.test(text) ||
                /^\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?(?:\s+(?:в\s*)?\d{1,2}:\d{2})?$/i.test(text) ||
                /^\d{1,2}\s+[а-яё]{3,12}(?:\s+\d{2,4})?(?:\s+(?:в\s*)?\d{1,2}:\d{2})?$/i.test(text)
            );
        }

        for (const anchor of anchors) {
            const href = anchor.href || anchor.getAttribute('href') || '';
            const match = href.match(/wall(-?\d+)_(\d+)/i);

            if (!match) {
                continue;
            }

            const anchorOwnerId = Number(match[1]);
            const anchorPostId = Number(match[2]);
            const located = findContainer(anchor);
            const container = located?.container || null;
            const parserPass = located?.pass || 'pass3-heuristic';

            if (!container || !anchorPostId) {
                continue;
            }

            /*
             * Пост может содержать ссылки на ДРУГИЕ wall-записи (анонс,
             * розыгрыш, прошлый пост). Старый обход принимал каждую такую
             * ссылку за отдельную публикацию и сохранял один и тот же DOM-
             * контейнер под чужим post_id. Сначала доверяем identity самого
             * контейнера; если его нет — только явному permalink/date anchor.
             */
            const containerIdentity = readContainerPostIdentity(container);
            if (
                containerIdentity &&
                (containerIdentity.ownerId !== anchorOwnerId || containerIdentity.postId !== anchorPostId)
            ) {
                continue;
            }
            if (!containerIdentity && !isLikelyPostPermalink(anchor)) {
                continue;
            }

            const ownerId = containerIdentity?.ownerId ?? anchorOwnerId;
            const postId = containerIdentity?.postId ?? anchorPostId;

            const textNode = container.querySelector(
                '[data-testid="post_content"], [class*="post-content-container"], [class*="showmoretext-in-expanded"], .wall_post_text, .post_text, .pi_text, [class*="PostText"], [class*="postText"]',
            );
            const primaryText = cleanText(
                textNode?.innerText ||
                textNode?.textContent ||
                container.innerText ||
                container.textContent ||
                '',
            );
            const nestedTextCandidates = [...container.querySelectorAll(
                '[data-post-nesting-lvl] [data-testid="post_content"], [data-post-nesting-lvl] [class*="post-content-container"], [data-post-nesting-lvl] [class*="showmoretext-in-expanded"], [data-post-nesting-lvl]'
            )].map((node) => ({
                text: cleanText(node.innerText || node.textContent || ''),
                level: Number(node.closest?.('[data-post-nesting-lvl]')?.getAttribute?.('data-post-nesting-lvl') || 0),
                depth: (() => {
                    let current = node;
                    let value = 0;
                    while (current && current !== container) {
                        value += 1;
                        current = current.parentElement;
                        if (value > 20) break;
                    }
                    return value;
                })(),
            })).filter((item) => item.text.length >= 3)
                .sort((left, right) => right.level - left.level || right.depth - left.depth || right.text.length - left.text.length);
            const deepestNestedText = nestedTextCandidates[0]?.text || '';
            const text = cleanText([
                primaryText,
                deepestNestedText && !primaryText.includes(deepestNestedText)
                    ? `[Вложенный репост VK]\n${deepestNestedText}`
                    : '',
            ].filter(Boolean).join('\n\n'));

            if (text.length < 3) {
                continue;
            }

            const imageCandidates = [];
            const absoluteUrl = (value) => {
                const raw = String(value || '').trim();
                if (!raw || raw.startsWith('data:') || raw.startsWith('blob:')) return '';
                try {
                    return new URL(raw, baseUrl).href;
                } catch {
                    return '';
                }
            };
            const srcsetUrls = (value) => String(value || '')
                .split(',')
                .map((entry) => entry.trim().split(/\s+/)[0])
                .filter(Boolean)
                .reverse();
            const nodeMarker = (node) => [
                String(node?.className || ''),
                node?.getAttribute?.('id') || '',
                node?.getAttribute?.('data-testid') || '',
                node?.getAttribute?.('alt') || '',
                node?.getAttribute?.('aria-label') || '',
                node?.getAttribute?.('role') || '',
            ].join(' ').toLowerCase();
            const isUiMarker = (value) => /avatar|profile|emoji|reaction|sticker|icon|badge|logo|favicon|smile/i.test(String(value || ''));
            const isMediaMarker = (value) => /photo|media|image|attachment|poster|gallery|picture|thumb/i.test(String(value || ''));
            const mediaContext = (node) => {
                let current = node;
                for (let depth = 0; current && depth < 5; depth += 1) {
                    const marker = nodeMarker(current);
                    if (isUiMarker(marker)) return { isUi: true, isMedia: false };
                    if (isMediaMarker(marker)) return { isUi: false, isMedia: true };
                    current = current.parentElement;
                }
                return { isUi: false, isMedia: false };
            };
            const hasPhotoAnchor = (node) => {
                const anchor = node?.closest?.('a[href]');
                const href = String(anchor?.href || anchor?.getAttribute?.('href') || '');
                return /(?:\bphoto-?\d+_\d+|[?&]z=photo-?\d+_\d+)/i.test(href);
            };
            const photoAttachmentKey = (node) => {
                const anchor = node?.closest?.('a[href]');
                const href = String(anchor?.href || anchor?.getAttribute?.('href') || '');
                const match = href.match(/(?:^|[/?&])(?:z=)?(photo-?\d+_\d+)/i);
                return String(match?.[1] || '').toLowerCase();
            };
            const domContextFor = (node) => {
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
                    if (current === container) break;
                }
                const allSameTag = node.ownerDocument?.querySelectorAll?.(String(node.tagName || '').toLowerCase()) || [];
                const documentOrdinal = Array.prototype.indexOf.call(allSameTag, node);
                const siblings = node.parentElement ? Array.from(node.parentElement.children || []) : [];
                const siblingIndex = siblings.indexOf(node);
                return {
                    tagName: String(node.tagName || '').toLowerCase(),
                    id: String(node.id || node.getAttribute?.('id') || ''),
                    className: String(node.className || ''),
                    attributes: readAttributes(node),
                    anchorHref: String(anchor?.getAttribute?.('href') || anchor?.href || ''),
                    selectorPath: path.join(' > ').slice(0, 12000),
                    ancestorChain,
                    documentOrdinal,
                    siblingIndex,
                    nearbyText: String(node.parentElement?.innerText || node.parentElement?.textContent || '').replace(/\s+/gu, ' ').trim(),
                    outerHtml: String(node.outerHTML || ''),
                };
            };
            const postNestingLevel = (node) => {
                let current = node;
                let level = 0;
                let depth = 0;
                while (current && depth < 12) {
                    const value = Number(current.getAttribute?.('data-post-nesting-lvl') || 0);
                    if (Number.isFinite(value) && value > level) level = value;
                    if (current === container) break;
                    current = current.parentElement;
                    depth += 1;
                }
                return level;
            };
            const isNestedMedia = (node) => {
                if (postNestingLevel(node) > 0) return true;
                const nestedPost = node?.closest?.('[data-testid="post"]');
                return Boolean(nestedPost && nestedPost !== container && container.contains(nestedPost));
            };
            const isPrimaryAttachment = (node) => {
                let current = node;
                for (let depth = 0; current && depth < 7; depth += 1) {
                    if (/primary-attachment-image-content/iu.test(nodeMarker(current))) return true;
                    if (current === container) break;
                    current = current.parentElement;
                }
                return false;
            };
            const imageAdmission = (width, height, explicitMedia) => {
                const w = Number(width) || 0;
                const h = Number(height) || 0;
                if (w >= 300 && h >= 300) return true;
                // A stable photo anchor may expose only a 72x72 virtualized
                // thumbnail. Keep it so photos.getById can resolve full bytes.
                // DOMParser has no layout/natural dimensions. In immutable
                // snapshot mode a non-UI image inside a verified post container
                // is retained even when dimensions are unavailable; dropping it
                // here loses the only poster before vision can inspect it.
                return explicitMedia && (snapshotMode || (!w || !h) ||
                    (Math.max(w, h) >= 48 && Math.min(w, h) >= 48));
            };
            const mediaHintFor = (node, { photoAnchor = false, media = false } = {}) => {
                const nested = isNestedMedia(node);
                const primary = isPrimaryAttachment(node);
                if (!nested && primary) return 'outer-primary';
                if (!nested && photoAnchor) return 'outer-photo-anchor';
                if (!nested && media) return 'outer-media';
                if (!nested) return 'outer-generic';
                if (primary) return 'nested-primary';
                if (photoAnchor) return 'nested-photo-anchor';
                return 'nested-media';
            };
            const addImageCandidate = (value, {
                width = 0,
                height = 0,
                mediaHint = 'dom-generic',
                marker = '',
                attachmentKey = '',
                domContext = {},
                explicitMedia = false,
            } = {}) => {
                const url = absoluteUrl(value);
                const fingerprint = `${marker} ${url}`.toLowerCase();
                const nonPosterUiUrl = isLikelyVkNonPosterUiImageUrlInPage(url);
                if (
                    !/^https:\/\//i.test(url) ||
                    !/(?:userapi|vkuser|vkcdn|sun\d+-\d+\.userapi|pp\.userapi)/i.test(url) ||
                    (nonPosterUiUrl && !(snapshotMode && explicitMedia &&
                        !isLikelyVkProfileAvatarUrlInPage(url))) ||
                    isUiMarker(fingerprint)
                ) return;

                imageCandidates.push({
                    url,
                    width: Number(width) || 0,
                    height: Number(height) || 0,
                    mediaHint,
                    attachmentKey: String(attachmentKey || '').trim().toLowerCase(),
                    domContext,
                    order: imageCandidates.length,
                });
            };

            for (const image of container.querySelectorAll('img')) {
                const rect = snapshotMode ? { width: 0, height: 0 } : (image.getBoundingClientRect?.() || { width: 0, height: 0 });
                const width = Math.max(Number(image.naturalWidth || 0), Number(image.getAttribute?.('width') || 0), Number(rect.width || 0));
                const height = Math.max(Number(image.naturalHeight || 0), Number(image.getAttribute?.('height') || 0), Number(rect.height || 0));
                const marker = nodeMarker(image);
                const context = mediaContext(image);
                const photoAnchor = hasPhotoAnchor(image);
                const attachmentKey = photoAttachmentKey(image);
                const explicitMedia = snapshotMode
                    ? (!context.isUi)
                    : (photoAnchor || context.isMedia || isPrimaryAttachment(image));

                if (context.isUi || isUiMarker(marker) || !imageAdmission(width, height, explicitMedia)) {
                    continue;
                }

                const mediaHint = mediaHintFor(image, { photoAnchor, media: context.isMedia });
                for (const candidate of [
                    image.currentSrc,
                    ...srcsetUrls(image.getAttribute('srcset')),
                    ...srcsetUrls(image.getAttribute('data-srcset')),
                    image.getAttribute('data-original'),
                    image.getAttribute('data-lazy-src'),
                    image.getAttribute('data-src'),
                    image.src,
                ]) {
                    addImageCandidate(candidate, { width, height, mediaHint, marker, attachmentKey, explicitMedia, domContext: domContextFor(image) });
                }
            }

            for (const source of container.querySelectorAll('picture source[srcset], source[data-srcset]')) {
                const picture = source.closest?.('picture');
                const image = picture?.querySelector?.('img');
                const rect = snapshotMode ? { width: 0, height: 0 } : (image?.getBoundingClientRect?.() || { width: 0, height: 0 });
                const width = Math.max(Number(image?.naturalWidth || 0), Number(image?.getAttribute?.('width') || 0), Number(rect.width || 0));
                const height = Math.max(Number(image?.naturalHeight || 0), Number(image?.getAttribute?.('height') || 0), Number(rect.height || 0));
                const marker = `${nodeMarker(source)} ${nodeMarker(picture)}`;
                const context = mediaContext(source);
                const photoAnchor = hasPhotoAnchor(source);
                const attachmentKey = photoAttachmentKey(source);
                const explicitMedia = snapshotMode
                    ? (!context.isUi)
                    : (photoAnchor || context.isMedia || isPrimaryAttachment(source));
                if (context.isUi || !imageAdmission(width, height, explicitMedia)) continue;
                const mediaHint = mediaHintFor(source, { photoAnchor, media: context.isMedia });

                for (const candidate of [
                    ...srcsetUrls(source.getAttribute('srcset')),
                    ...srcsetUrls(source.getAttribute('data-srcset')),
                ]) {
                    addImageCandidate(candidate, { width, height, mediaHint, marker, attachmentKey, explicitMedia, domContext: domContextFor(image) });
                }
            }

            // Background-image читаем только у узлов, которые действительно
            // похожи на media/photo-контейнер. Обход всех больших div раньше
            // подмешивал аватары, логотипы и служебные иконки VK.
            for (const node of container.querySelectorAll('*')) {
                const context = mediaContext(node);
                const photoAnchor = hasPhotoAnchor(node);
                const attachmentKey = photoAttachmentKey(node);
                const explicitMedia = snapshotMode
                    ? (!context.isUi)
                    : (context.isMedia || photoAnchor || isPrimaryAttachment(node));
                if (context.isUi || !explicitMedia) continue;

                const rect = snapshotMode ? { width: 0, height: 0 } : (node.getBoundingClientRect?.() || { width: 0, height: 0 });
                const width = Math.max(Number(node.getAttribute?.('width') || 0), Number(rect.width || 0));
                const height = Math.max(Number(node.getAttribute?.('height') || 0), Number(rect.height || 0));
                if (!imageAdmission(width, height, explicitMedia)) continue;
                const marker = nodeMarker(node);
                const mediaHint = mediaHintFor(node, { photoAnchor, media: context.isMedia });

                for (const attr of ['data-background-image', 'data-original', 'data-src']) {
                    addImageCandidate(node.getAttribute?.(attr), { width, height, mediaHint, marker, attachmentKey, domContext: domContextFor(node) });
                }
                const background = snapshotMode
                    ? String(node.style?.backgroundImage || node.getAttribute?.('style') || '')
                    : (getComputedStyle(node).backgroundImage || '');
                for (const match of background.matchAll(/url\(["']?([^"')]+)["']?\)/gi)) {
                    addImageCandidate(match[1], { width, height, mediaHint, marker, attachmentKey, explicitMedia, domContext: domContextFor(node) });
                }
            }

            // V188.68: original repost-wall media is preferred over decorative
            // outer-message media, but no layer is discarded. This preserves
            // the poster inside a repost while still keeping outer attachments
            // available for later vision/matching.
            const hintWeight = {
                'nested-primary': 8_000_000_000,
                'nested-photo-anchor': 7_500_000_000,
                'outer-primary': 7_000_000_000,
                'nested-media': 6_500_000_000,
                'outer-photo-anchor': 6_000_000_000,
                'outer-media': 5_500_000_000,
                'outer-generic': 4_000_000_000,
            };
            const byUrl = new Map();
            for (const candidate of imageCandidates) {
                const area = Math.max(0, candidate.width * candidate.height);
                const ratio = candidate.width && candidate.height
                    ? candidate.width / candidate.height
                    : 1;
                let score = (hintWeight[candidate.mediaHint] || 0) + Math.min(area, 100_000_000);
                if (candidate.mediaHint === 'outer-generic' && (candidate.width < 300 || candidate.height < 300 || area < 90_000)) score -= 4_000_000_000;
                if (!candidate.attachmentKey && (candidate.width < 120 || candidate.height < 120 || area < 30_000)) score -= 2_000_000_000;
                if (ratio > 2.8 || ratio < 0.25) score -= 150_000_000;
                const identityKey = candidate.attachmentKey
                    ? `attachment:${candidate.attachmentKey}`
                    : `url:${candidate.url}`;
                const previous = byUrl.get(identityKey);
                if (!previous || score > previous.score) byUrl.set(identityKey, { ...candidate, score });
            }
            const rankedImageCandidates = [...byUrl.values()]
                .sort((left, right) => right.score - left.score || left.order - right.order);
            const rankedMedia = rankedImageCandidates.slice(0, 12);
            const imageCandidateAudit = rankedImageCandidates.slice(0, 40).map((candidate, rank) => ({
                rank: rank + 1,
                selectedForVision: rank < 12,
                url: candidate.url,
                attachmentKey: candidate.attachmentKey || '',
                vkPhotoId: candidate.attachmentKey || '',
                mediaHint: candidate.mediaHint || '',
                width: Number(candidate.width) || 0,
                height: Number(candidate.height) || 0,
                score: Number(candidate.score) || 0,
                marker: String(candidate.marker || '').slice(0, 1200),
                domContext: candidate.domContext || {},
            }));
            const imageUrls = rankedMedia.map((candidate) => candidate.url);
            const imageMedia = rankedMedia.map((candidate) => ({
                url: candidate.url,
                origin: candidate.mediaHint.startsWith('nested-') ? 'repost-wall' : 'outer-message',
                repostDepth: candidate.mediaHint.startsWith('nested-') ? Math.max(1, postNestingLevel(container)) : 0,
                mediaHint: candidate.mediaHint,
                attachmentKey: candidate.attachmentKey || '',
                vkPhotoId: candidate.attachmentKey || '',
                width: Number(candidate.width) || 0,
                height: Number(candidate.height) || 0,
                domContext: candidate.domContext || {},
            }));

            const timeNode = container.querySelector('time[datetime]');
            const parsedTime = Date.parse(timeNode?.getAttribute('datetime') || '');
            const unixCarrier = container.matches?.('[data-time], [data-date], [data-timestamp]')
                ? container
                : container.querySelector('[data-time], [data-date], [data-timestamp]');
            const unixCandidate = Number(
                unixCarrier?.getAttribute?.('data-time') ||
                unixCarrier?.getAttribute?.('data-timestamp') ||
                unixCarrier?.getAttribute?.('data-date') ||
                0,
            );
            const publishedAt = Number.isFinite(parsedTime)
                ? Math.floor(parsedTime / 1000)
                : Number.isFinite(unixCandidate) && unixCandidate >= 1_000_000_000
                    ? Math.floor(unixCandidate > 10_000_000_000 ? unixCandidate / 1000 : unixCandidate)
                    : 0;
            const wallKey = `wall${ownerId}_${postId}`.toLowerCase();
            const publishedLabel = [...container.querySelectorAll('a[href*="wall"]')]
                .map((item) => ({
                    href: String(item.href || item.getAttribute('href') || '').toLowerCase(),
                    values: [
                        String(item.innerText || item.textContent || '').replace(/\s+/g, ' ').trim(),
                        String(item.getAttribute('title') || '').replace(/\s+/g, ' ').trim(),
                        String(item.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim(),
                    ].filter(Boolean),
                }))
                .filter((item) => item.href.includes(wallKey))
                .flatMap((item) => item.values)
                .find((label) => (
                    /^(?:сегодня|вчера)(?:\s+в)?(?:\s+\d{1,2}:\d{2})?$/i.test(label) ||
                    /^\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?(?:\s+(?:в\s*)?\d{1,2}:\d{2})?$/i.test(label) ||
                    /^\d{1,2}\s+[а-яё]{3,12}(?:\s+\d{2,4})?(?:\s+(?:в\s*)?\d{1,2}:\d{2})?$/i.test(label)
                )) || '';
            const eventLinks = [...container.querySelectorAll('a[href]')]
                .map((anchor) => {
                    const raw = String(anchor.href || anchor.getAttribute('href') || '').trim();
                    if (!raw) return null;
                    let url = '';
                    try { url = new URL(raw, baseUrl).href; } catch { return null; }
                    const anchorText = String(anchor.innerText || anchor.textContent || anchor.getAttribute('aria-label') || '').replace(/\s+/g, ' ').trim();
                    let context = anchorText;
                    let node = anchor.parentElement;
                    for (let depth = 0; node && depth < 4 && container.contains(node); depth += 1, node = node.parentElement) {
                        const candidate = String(node.innerText || node.textContent || '').replace(/\s+/g, ' ').trim();
                        if (candidate.length >= anchorText.length && candidate.length <= 900) context = candidate;
                    }
                    return { url, text: anchorText.slice(0, 300), context: context.slice(0, 900) };
                })
                .filter(Boolean)
                .filter((item, index, rows) => rows.findIndex((other) => other.url === item.url) === index)
                .slice(0, 80);
            const links = eventLinks.map((item) => item.url);
            const key = `${ownerId}_${postId}`;

            unique.set(key, {
                screenName: currentScreenName,
                ownerId,
                postId,
                sourceUrl: `https://vk.ru/wall${ownerId}_${postId}`,
                publishedAt,
                publishedLabel,
                text,
                links,
                eventLinks,
                imageUrls,
                imageMedia,
                imageCandidateAudit,
                imageOrigin: imageMedia.some((item) => item.origin === 'repost-wall') ? 'nested-repost' : (imageUrls.length ? 'outer-primary' : 'none'),
                domAudit: domContextFor(container),
                parserPass,
            });
        }

        return [...unique.values()];
    }, {
        currentScreenName: screenName,
        immutableSnapshotHtml: String(snapshotHtml || ''),
        baseUrl: `https://vk.ru/${screenName}`,
    });

    return rawPosts
        .map((post) => ({
            ...post,
            publishedAt: Number(post.publishedAt) > 0
                ? Number(post.publishedAt)
                : parseVkPublishedAtLabel(post.publishedLabel),
            text: cleanPublicPostText(post.text, screenName),
        }))
        .filter((post) => post.text.length >= 3);
}


async function primeLatestVkPostMedia(page, targetCount) {
    const safeTarget = Math.max(1, Math.min(20, Math.trunc(Number(targetCount) || 20)));
    let visited = 0;

    for (let index = 0; index < safeTarget; index += 1) {
        const primed = await page.evaluate((postIndex) => {
            const containers = [];
            const seen = new Set();
            const anchors = [...document.querySelectorAll('a[href*="wall"]')];

            for (const anchor of anchors) {
                const href = String(anchor.href || anchor.getAttribute('href') || '');
                if (!/wall-?\d+_\d+/iu.test(href)) continue;

                let container = anchor.closest(
                    '[data-post-id], [data-post], article, .Post, .post, .wall_item, .feed_row',
                );
                if (!container) {
                    let node = anchor.parentElement;
                    for (let depth = 0; node && depth < 9; depth += 1) {
                        const text = String(node.innerText || node.textContent || '').trim();
                        if (text.length >= 20 && (node.querySelectorAll?.('a[href*="wall"]')?.length ?? 0) >= 1) {
                            container = node;
                            break;
                        }
                        node = node.parentElement;
                    }
                }
                if (!container || seen.has(container)) continue;
                seen.add(container);
                containers.push(container);
            }

            const target = containers[postIndex];
            if (!target) return { found: false, photoCount: 0 };
            for (const image of target.querySelectorAll('img')) {
                try {
                    image.loading = 'eager';
                    image.decoding = 'async';
                } catch {}
            }
            target.scrollIntoView({ block: 'center', behavior: 'instant' });
            const contentImage = [...target.querySelectorAll('img')].find((image) => {
                const rect = image.getBoundingClientRect?.() || { width: 0, height: 0 };
                return rect.width >= 100 || rect.height >= 100;
            });
            contentImage?.scrollIntoView?.({ block: 'nearest', behavior: 'instant' });
            const photoAnchors = [...target.querySelectorAll('a[href]')]
                .filter((anchor) => /(?:\bphoto-?\d+_\d+|[?&]z=photo-?\d+_\d+)/i.test(String(anchor.href || anchor.getAttribute('href') || '')))
                .filter((anchor, anchorIndex, rows) => rows.findIndex((other) => String(other.href || other.getAttribute('href') || '') === String(anchor.href || anchor.getAttribute('href') || '')) === anchorIndex);
            return { found: true, photoCount: photoAnchors.length };
        }, index).catch(() => false);

        if (!primed?.found) break;
        visited += 1;
        const photoCount = Math.min(MAX_IMAGES_PER_POST, Number(primed.photoCount) || 0);
        // VK photo grids lazily reuse/virtualize <img src> nodes. Touch each
        // attachment in turn so currentSrc is hydrated before the immutable DOM
        // snapshot is taken. Without this, one grid cell may serialize the
        // previous neighbour's image (observed on rb_diesel/13738: the
        // STONEHAND slot inherited the CWT thumbnail).
        for (let photoIndex = 0; photoIndex < photoCount; photoIndex += 1) {
            await page.evaluate(({ postIndex, photoIndex }) => {
                const containers = [];
                const seen = new Set();
                for (const anchor of [...document.querySelectorAll('a[href*="wall"]')]) {
                    const href = String(anchor.href || anchor.getAttribute('href') || '');
                    if (!/wall-?\d+_\d+/i.test(href)) continue;
                    let container = anchor.closest('[data-post-id], [data-post], article, .Post, .post, .wall_item, .feed_row');
                    if (!container) continue;
                    if (seen.has(container)) continue;
                    seen.add(container);
                    containers.push(container);
                }
                const target = containers[postIndex];
                if (!target) return false;
                const photoAnchors = [...target.querySelectorAll('a[href]')]
                    .filter((item) => /(?:\bphoto-?\d+_\d+|[?&]z=photo-?\d+_\d+)/i.test(String(item.href || item.getAttribute('href') || '')))
                    .filter((item, itemIndex, rows) => rows.findIndex((other) => String(other.href || other.getAttribute('href') || '') === String(item.href || item.getAttribute('href') || '')) === itemIndex);
                const photo = photoAnchors[photoIndex];
                if (!photo) return false;
                for (const image of photo.querySelectorAll('img')) {
                    try {
                        image.loading = 'eager';
                        image.decoding = 'async';
                    } catch {}
                }
                photo.scrollIntoView({ block: 'nearest', inline: 'center', behavior: 'instant' });
                return true;
            }, { postIndex: index, photoIndex }).catch(() => false);
            await page.waitForTimeout(90);
        }
        await page.waitForTimeout(180);
    }

    return visited;
}

async function saveVkDebug(page, dataDirectory, screenName) {
    const directory = join(dataDirectory, 'scraper-debug');
    mkdirSync(directory, { recursive: true });
    const stamp = Date.now();
    const screenshotPath = join(directory, `vk-${screenName}-${stamp}.png`);
    const htmlPath = join(directory, `vk-${screenName}-${stamp}.html`);

    await page.screenshot({ path: screenshotPath, fullPage: true });
    writeFileSync(htmlPath, await page.content(), 'utf8');

    return { screenshotPath, htmlPath };
}


async function inspectVkSourcePageHealth(page) {
    if (!page || page.isClosed?.() || typeof page.evaluate !== 'function') {
        return { ready: false, reload: false, reason: 'page-closed' };
    }
    try {
        const state = await page.evaluate(() => {
            const contentRoot = document.querySelector('main, [role="main"], #page_body, .page_body') || document.body;
            return {
                bodyText: String(document.body?.innerText || document.body?.textContent || '').slice(0, 12_000),
                postCount: document.querySelectorAll(
                    '[data-testid="post"][data-post-id], [data-post-id], [data-post], article, .Post, .wall_item, .feed_row',
                ).length,
                wallAnchorCount: document.querySelectorAll('a[href*="wall"]').length,
                mainTextChars: String(contentRoot?.innerText || contentRoot?.textContent || '').trim().length,
                contentImageCount: contentRoot?.querySelectorAll?.('img, picture, video, [style*="background-image"]')?.length || 0,
                readyState: document.readyState || '',
            };
        });
        return classifyVkSourcePageHealth(state || {});
    } catch (error) {
        if (isScraperTargetClosedError(error)) {
            return { ready: false, reload: false, reason: 'page-closed' };
        }
        return { ready: false, reload: false, reason: 'health-inspection-failed' };
    }
}

async function refreshVkSourcePageIfUnready({
    page,
    screenName,
    dataDirectory,
    diagnostics = null,
    reloadState = null,
    forceReason = '',
    progressObserved = false,
} = {}) {
    if (!page || page.isClosed?.() || typeof page.reload !== 'function') return false;
    const state = reloadState && typeof reloadState === 'object'
        ? reloadState
        : { count: 0, max: 2 };
    const maximum = Math.max(0, Math.min(3, Number(state.max) || 2));
    if (Number(state.count) >= maximum) return false;

    // A real scrollable wall is positive load evidence. Do not reinterpret an
    // already interactive/scrolled source as an "empty page" merely because a
    // selector/parser contour temporarily returned zero rows after a DOM change.
    if (progressObserved) {
        diagnostics?.log?.('source.capture.page-reload.skipped', {
            sourceId: `vk:${screenName}`,
            reason: 'scroll-progress-observed',
            forceReason: String(forceReason || ''),
        });
        return false;
    }

    // V188.83: the presence of a real scroll range is itself positive loading
    // evidence. This protects changed-but-rendered VK DOM from a false reload
    // before pass2/pass3 get a chance to inspect it.
    const scrollable = await page.evaluate(() => {
        const root = document.scrollingElement || document.documentElement || document.body;
        return Number(root?.scrollHeight || 0) > Number(root?.clientHeight || window.innerHeight || 0) + 40;
    }).catch(() => false);
    if (scrollable) {
        diagnostics?.log?.('source.capture.page-reload.skipped', {
            sourceId: `vk:${screenName}`,
            reason: 'scroll-range-observed',
            forceReason: String(forceReason || ''),
        });
        return false;
    }

    const health = await inspectVkSourcePageHealth(page);
    diagnostics?.log?.('source.capture.page-health', {
        sourceId: `vk:${screenName}`,
        health,
        forceReason: String(forceReason || ''),
        reloadAttempt: Number(state.count || 0),
        maximum,
    });
    // V188.79: a parser miss is NOT by itself a reason to refresh a visibly
    // healthy wall. Exact selectors can miss after a VK DOM change, while the
    // structural/heuristic contours can still recover the same immutable DOM.
    // Reload only when page-health itself says the page is actually empty or
    // errored. If it is still loading, a zero-post signal only schedules the
    // mandatory delayed recheck below.
    const recoveryCandidate = health.reload || (
        Boolean(forceReason) &&
        !health.ready &&
        health.reason !== 'access-gate'
    );
    if (!recoveryCandidate) {
        if (forceReason) {
            diagnostics?.log?.('source.capture.page-reload.skipped', {
                sourceId: `vk:${screenName}`,
                reason: health.ready ? 'healthy-page-parser-miss' : health.reason,
                forceReason: String(forceReason || ''),
                health,
            });
        }
        return false;
    }

    // Legacy regression marker only: VK_PUBLIC_RELOAD_BACKOFF_MS, 10_000, 15_000, 12_000.
    // V188.86: every automatic reload attempt waits a fresh random 10–20s.
    // The SAME DOM is rechecked after the wait; if posts/text appeared, reload
    // is cancelled. Maximum attempts remain three per source page.
    const reloadBackoffMs = randomInt(10_000, 20_001);
    diagnostics?.log?.('source.capture.page-reload.pending', {
        sourceId: `vk:${screenName}`,
        reason: forceReason || health.reason,
        healthReason: health.reason,
        attempt: Number(state.count || 0) + 1,
        maximum,
        reloadBackoffMs,
    });

    // Do not refresh merely because the first health check ran before VK
    // finished lazy-rendering. Wait at least ten seconds and inspect the SAME
    // page again. If it recovered, keep it and continue without navigation.
    await new Promise((resolveReloadBackoff) => setTimeout(resolveReloadBackoff, reloadBackoffMs));
    if (page.isClosed?.()) {
        diagnostics?.log?.('source.capture.page-reload.cancelled', {
            sourceId: `vk:${screenName}`,
            reason: 'page-closed-during-backoff',
            attempt: Number(state.count || 0) + 1,
            reloadBackoffMs,
        });
        return false;
    }

    const recheckedHealth = await inspectVkSourcePageHealth(page);
    diagnostics?.log?.('source.capture.page-health.recheck', {
        sourceId: `vk:${screenName}`,
        before: health,
        after: recheckedHealth,
        forceReason: String(forceReason || ''),
        waitedMs: reloadBackoffMs,
    });

    if (recheckedHealth.ready || recheckedHealth.reason === 'access-gate' || !recheckedHealth.reload) {
        diagnostics?.log?.('source.capture.page-reload.cancelled', {
            sourceId: `vk:${screenName}`,
            reason: recheckedHealth.ready ? 'page-recovered-during-wait' : recheckedHealth.reason,
            forceReason: String(forceReason || ''),
            healthBefore: health,
            healthAfter: recheckedHealth,
            reloadBackoffMs,
        });
        return false;
    }

    state.count = Number(state.count || 0) + 1;
    console.warn(
        '[VK SOURCE PAGE RELOAD]',
        `source=vk.ru/${screenName}`,
        `reason=${forceReason || recheckedHealth.reason}`,
        `attempt=${state.count}/${maximum}`,
        `waitedMs=${reloadBackoffMs}`,
    );
    diagnostics?.log?.('source.capture.page-reload', {
        sourceId: `vk:${screenName}`,
        reason: forceReason || recheckedHealth.reason,
        healthReason: recheckedHealth.reason,
        initialHealthReason: health.reason,
        attempt: state.count,
        maximum,
        reloadBackoffMs,
    });

    // V188.74: keep forensic DOM on both sides of every actual automatic
    // refresh. Recovered/healthy pages never enter this branch.
    await diagnostics?.captureDomSnapshot?.({
        sourceId: `vk:${screenName}`,
        page,
        label: `pre-reload-${state.count}`,
        metadata: {
            reason: forceReason || recheckedHealth.reason,
            healthBefore: health,
            healthAfter: recheckedHealth,
            attempt: state.count,
            maximum,
        },
    });

    await page.reload({
        waitUntil: 'domcontentloaded',
        timeout: clampInteger(process.env.VK_PUBLIC_RELOAD_TIMEOUT_MS, 5_000, 60_000, 25_000),
    });
    await page.waitForTimeout?.(randomInt(10_000, 20_001));
    await waitForManualAccess({ page, source: 'VK', dataDirectory });
    await diagnostics?.captureDomSnapshot?.({
        sourceId: `vk:${screenName}`,
        page,
        label: `post-reload-${state.count}`,
        metadata: {
            reason: forceReason || health.reason,
            attempt: state.count,
            maximum,
        },
    });
    return true;
}

async function collectVkPostsWithBrowser({
    screenName,
    targetCount,
    stopAtPostId = 0,
    dataDirectory,
    notifyAttention,
    keepPageOpen = false,
    deferClose = false,
    diagnostics = null,
    recoveryScrollSteps = 0,
    snapshotEveryScroll = false,
    minimumPageLifetimeMs = 0,
}) {
    const collected = new Map();
    let page = null;
    let stableIterations = 0;
    let previousSize = 0;
    let completedSuccessfully = false;
    let stoppedByOwner = false;
    let openedAtMs = 0;
    let progressSnapshotSequence = 0;
    let successfulScrollObserved = false;
    const pageReloadState = { count: 0, max: 3 };

    let fullDomHtml = '';
    // Selector evidence captured before the first scroll; exact parsing may
    // consume it when available and safely falls back to current VK selectors.
    let baselineSelectorContract = null;
    let snapshotExactCount = 0;
    let captureDomPath = '';
    const parserReport = {
        comparisons: [],
        exactErrors: [],
        interrupted: false,
        interruptionReason: '',
    };

    const buildResult = () => {
        const result = [...collected.values()]
            .sort((left, right) => right.postId - left.postId)
            .slice(0, targetCount);
        Object.defineProperty(result, 'stoppedByOwner', {
            value: stoppedByOwner,
            enumerable: false,
        });
        Object.defineProperty(result, 'sourcePage', {
            value: page,
            enumerable: false,
        });
        Object.defineProperty(result, 'fullDomHtml', {
            value: fullDomHtml,
            enumerable: false,
        });
        Object.defineProperty(result, 'snapshotExactCount', {
            value: snapshotExactCount,
            enumerable: false,
        });
        Object.defineProperty(result, 'captureDomPath', {
            value: captureDomPath,
            enumerable: false,
        });
        Object.defineProperty(result, 'parserReport', {
            value: parserReport,
            enumerable: false,
        });
        return result;
    };

    try {
        try {
            page = await openScraperPage({
                url: `https://vk.ru/${screenName}`,
                source: 'VK',
                dataDirectory,
                notifyAttention,
                reuseKey: (keepPageOpen || deferClose) ? `vk-public:${screenName}` : '',
            });
            openedAtMs = Date.now();
        } catch (error) {
            if (keepPageOpen && isScraperTargetClosedError(error)) {
                stoppedByOwner = true;
                console.log(
                    '[VK MANUAL PARSER FINISH BY CLOSE]',
                    `source=vk.ru/${screenName}`,
                    'stage=open',
                    'collected=0',
                );
                return buildResult();
            }
            throw error;
        }

        try {
            await waitForManualAccess({
                page,
                source: 'VK',
                dataDirectory,
            });
            await page.waitForTimeout?.(500);
            await refreshVkSourcePageIfUnready({
                page,
                screenName,
                dataDirectory,
                diagnostics,
                reloadState: pageReloadState,
            });
            // One per-source structural baseline BEFORE this scraper's first scroll.
            if (diagnostics?.captureVkStructureBaseline) {
                const baseline = await diagnostics.captureVkStructureBaseline({
                    page, sourceId: `vk:${screenName}`, label: 'before-first-scroll',
                });
                baselineSelectorContract = baseline?.selectorContract || null;
            }

            for (let iteration = 0; iteration < 120; iteration += 1) {
                await waitForManualAccess({
                    page,
                    source: 'VK',
                    dataDirectory,
                });

                // Capture the unmodified rendered DOM at EVERY observed scroll position
                // BEFORE live element extraction. The fixture has its own immutable
                // per-iteration manifest, independent of snapshotEveryScroll.
                try {
                    fullDomHtml = diagnostics?.captureVkDomFixture
                        ? (await diagnostics.captureVkDomFixture({
                            page, sourceId: `vk:${screenName}`,
                            label: `scroll-${String(iteration + 1).padStart(3, '0')}`,
                            metadata: { phase: 'before-live-extraction', iteration, targetCount },
                        })).html
                        : await page.content();
                    if (snapshotEveryScroll && diagnostics?.captureDomSnapshot) {
                        progressSnapshotSequence += 1;
                        await diagnostics.captureDomSnapshot({
                            sourceId: `vk:${screenName}`,
                            page,
                            html: fullDomHtml,
                            label: `scroll-step-${String(progressSnapshotSequence).padStart(3, '0')}`,
                            metadata: {
                                phase: 'progressive-scroll-capture',
                                iteration,
                                collected: collected.size,
                                targetCount,
                                openedAtMs,
                            },
                        });
                    }
                } catch (error) {
                    // An enabled fixture must never fail silently while parsing continues.
                    if (diagnostics?.captureVkDomFixture) throw error;
                }

                // Every contour must consume the exact immutable DOM captured
                // immediately above. Reading the live page here allowed VK
                // lazy rendering to mutate identity/media between the snapshot
                // and adaptive/heuristic extraction.
                const posts = await extractRenderedVkPosts(page, screenName, { snapshotHtml: fullDomHtml });

                if (!posts.length) {
                    const reloaded = await refreshVkSourcePageIfUnready({
                        page,
                        screenName,
                        dataDirectory,
                        diagnostics,
                        reloadState: pageReloadState,
                        forceReason: 'parser-zero-posts',
                        progressObserved: successfulScrollObserved,
                    });
                    if (reloaded) {
                        stableIterations = 0;
                        previousSize = collected.size;
                        continue;
                    }
                }

                for (const post of posts) {
                    collected.set(`${post.ownerId}_${post.postId}`, post);
                }

                const reachedKnownPost = stopAtPostId > 0 &&
                    posts.some((post) => post.postId <= stopAtPostId);

                if (collected.size >= targetCount || reachedKnownPost) {
                    break;
                }

                if (collected.size === previousSize) {
                    stableIterations += 1;
                } else {
                    stableIterations = 0;
                    previousSize = collected.size;
                }

                // A partially rendered wall can expose one or two posts and an
                // error banner. Zero-post recovery alone misses that case. When
                // progress stalls, inspect page health and refresh only if VK
                // actually reports an error/empty DOM; healthy short walls are
                // left alone.
                if (stableIterations >= 2) {
                    const reloaded = await refreshVkSourcePageIfUnready({
                        page,
                        screenName,
                        dataDirectory,
                        diagnostics,
                        reloadState: pageReloadState,
                        progressObserved: successfulScrollObserved,
                    });
                    if (reloaded) {
                        stableIterations = 0;
                        previousSize = collected.size;
                        continue;
                    }
                }

                if (stableIterations >= 8) {
                    break;
                }

                const scrollState = await page.evaluate(() => {
                    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
                    const scrollHeight = Number(scrollingElement?.scrollHeight || 0);
                    const clientHeight = Number(scrollingElement?.clientHeight || window.innerHeight || 0);
                    window.scrollBy({
                        top: Math.max(650, window.innerHeight * 0.9),
                        behavior: 'smooth',
                    });
                    return {
                        scrollable: scrollHeight > clientHeight + 4,
                        scrollHeight,
                        clientHeight,
                    };
                }).catch(() => null);
                if (scrollState?.scrollable) {
                    successfulScrollObserved = true;
                }
                await page.waitForTimeout(clampInteger(
                    process.env.VK_PUBLIC_SCROLL_DELAY_MS,
                    500,
                    5000,
                    1200,
                ));
            }

            const safeRecoveryScrollSteps = Math.max(0, Math.min(20, Math.trunc(Number(recoveryScrollSteps) || 0)));
            if (safeRecoveryScrollSteps > 0) {
                diagnostics?.log?.('source.capture.recovery-scroll.start', {
                    sourceId: `vk:${screenName}`,
                    scrollSteps: safeRecoveryScrollSteps,
                });
                await settleScraperPage({
                    page,
                    source: `VK vk.ru/${screenName} recovery`,
                    scrollSteps: safeRecoveryScrollSteps,
                    scrollDelayMs: clampInteger(
                        process.env.VK_PUBLIC_RECOVERY_SCROLL_DELAY_MS,
                        500,
                        5000,
                        1100,
                    ),
                    mediaWaitMs: clampInteger(
                        Number(process.env.VK_PUBLIC_RECOVERY_MEDIA_WAIT_SECONDS) * 1000,
                        1000,
                        30_000,
                        5000,
                    ),
                    holdMs: 0,
                });
                try {
                    fullDomHtml = await page.content();
                } catch {}
                diagnostics?.log?.('source.capture.recovery-scroll.finish', {
                    sourceId: `vk:${screenName}`,
                    scrollSteps: safeRecoveryScrollSteps,
                    retainedDomChars: fullDomHtml.length,
                });
            }

            const visitedPosts = await primeLatestVkPostMedia(page, targetCount);
            const mediaWaitMs = keepPageOpen
                ? clampInteger(
                    Number(process.env.VK_PUBLIC_MANUAL_MEDIA_WAIT_SECONDS) * 1000,
                    0,
                    10_000,
                    1500,
                )
                : clampInteger(
                    Number(process.env.VK_PUBLIC_MEDIA_WAIT_SECONDS) * 1000,
                    1000,
                    60_000,
                    10_000,
                );
            const pageHoldMs = keepPageOpen
                ? 0
                : clampInteger(
                    Number(process.env.VK_PUBLIC_PAGE_HOLD_SECONDS) * 1000,
                    180_000,
                    300_000,
                    180_000,
                );

            await settleScraperPage({
                page,
                source: `VK vk.ru/${screenName}`,
                scrollSteps: 0,
                mediaWaitMs,
                holdMs: pageHoldMs,
            });

            const requestedMinimumLifetimeMs = Math.max(0, Number(minimumPageLifetimeMs) || 0);
            if (!keepPageOpen && openedAtMs > 0 && requestedMinimumLifetimeMs > 0) {
                let remainingLifetimeMs = requestedMinimumLifetimeMs - (Date.now() - openedAtMs);
                while (remainingLifetimeMs > 0 && !page.isClosed?.()) {
                    const dwellSliceMs = Math.min(15_000, remainingLifetimeMs);
                    await page.waitForTimeout?.(dwellSliceMs);
                    remainingLifetimeMs = requestedMinimumLifetimeMs - (Date.now() - openedAtMs);
                    if (snapshotEveryScroll && diagnostics?.captureDomSnapshot && !page.isClosed?.()) {
                        progressSnapshotSequence += 1;
                        const dwellHtml = await page.content().catch(() => '');
                        if (dwellHtml) {
                            fullDomHtml = dwellHtml;
                            await diagnostics.captureDomSnapshot({
                                sourceId: `vk:${screenName}`,
                                page,
                                html: dwellHtml,
                                label: `dwell-${String(progressSnapshotSequence).padStart(3, '0')}`,
                                metadata: {
                                    phase: 'minimum-tab-lifetime',
                                    minimumPageLifetimeMs: requestedMinimumLifetimeMs,
                                    elapsedMs: Date.now() - openedAtMs,
                                    remainingLifetimeMs: Math.max(0, remainingLifetimeMs),
                                },
                            });
                        }
                    }
                }
            }

            // The exact contour consumes this immutable full-DOM snapshot and
            // diagnostics persist the identical HTML. The rendered adaptive and
            // heuristic contours below still read the live page for lazy-loaded
            // media; do not report them as consuming the same immutable snapshot.
            fullDomHtml = diagnostics?.captureVkDomFixture
                ? (await diagnostics.captureVkDomFixture({
                    page, sourceId: `vk:${screenName}`, label: 'capture-complete',
                    metadata: { phase: 'before-exact-extraction', targetCount },
                })).html
                : await page.content();
            // Persist the immutable page snapshot BEFORE Stage 1 reads it. The
            // exact parser below consumes this very same string, so the trace can
            // always reproduce what Stage 1 actually saw.
            if (diagnostics?.captureDomSnapshot) {
                captureDomPath = await diagnostics.captureDomSnapshot({
                    sourceId: `vk:${screenName}`,
                    page,
                    html: fullDomHtml,
                    label: 'capture-complete',
                    metadata: {
                        phase: 'raw-before-exact',
                        renderedCollected: collected.size,
                        targetCount,
                    },
                }) || '';
            }
            const currentDomExactPosts = await extractExactVkPostsFromDomSnapshot(
                page,
                fullDomHtml,
                screenName,
                { selectorContract: baselineSelectorContract },
            ).catch((exactError) => {
                parserReport.exactErrors.push({
                    at: new Date().toISOString(),
                    message: String(exactError?.message ?? exactError),
                    name: String(exactError?.name ?? ''),
                });
                diagnostics?.log?.('parser.exact.error', {
                    sourceId: `vk:${screenName}`,
                    error: exactError,
                    action: 'continue-with-legacy-and-adaptive-heuristic',
                });
                return [];
            });
            const snapshotExactPosts = currentDomExactPosts.length
                ? currentDomExactPosts
                : parseVkPublicHtml(fullDomHtml, screenName).map((post) => ({
                    ...post,
                    parserPass: 'snapshot-exact-legacy-regex',
                }));
            snapshotExactCount = snapshotExactPosts.length;

            // Re-run the adaptive/heuristic extractor against the same immutable
            // snapshot. Live lazy media is refreshed separately only when an
            // explicit media-hydration path requests it.
            // All parser contours must consume the exact immutable HTML that was
            // persisted and handed to Stage 1. This keeps adaptive/heuristic
            // recovery reproducible and prevents live lazy-DOM drift from
            // changing identity or media membership after the snapshot barrier.
            const finalPosts = await extractRenderedVkPosts(page, screenName, { snapshotHtml: fullDomHtml });
            parserReport.immutableSnapshot = {
                path: captureDomPath,
                chars: fullDomHtml.length,
                bytes: Buffer.byteLength(fullDomHtml, 'utf8'),
                sha256: createHash('sha256').update(fullDomHtml, 'utf8').digest('hex'),
                baselineSelectorContract: baselineSelectorContract || null,
                baselineSelectorContractUsed: Boolean(baselineSelectorContract),
                sameSnapshotForAllThreeContours: true,
                mediaRefreshFromLiveDom: false,
            };
            parserReport.reloadCount = Number(pageReloadState.count || 0);
            parserReport.contourCounts = {
                exact: snapshotExactPosts.length,
                structural: finalPosts.filter((post) => String(post?.parserPass || '').split('+').includes('pass2-adaptive')).length,
                heuristic: finalPosts.filter((post) => String(post?.parserPass || '').split('+').includes('pass3-heuristic')).length,
            };
            const exactIdsForDiagnostics = new Set(snapshotExactPosts.map((post) => `${Number(post.ownerId || 0)}_${Number(post.postId || 0)}`));
            const renderedIdsForDiagnostics = new Set(finalPosts.map((post) => `${Number(post.ownerId || 0)}_${Number(post.postId || 0)}`));
            const renderedOnlyIds = [...renderedIdsForDiagnostics].filter((id) => !exactIdsForDiagnostics.has(id)).slice(0, 40);
            const exactOnlyIds = [...exactIdsForDiagnostics].filter((id) => !renderedIdsForDiagnostics.has(id)).slice(0, 40);
            const parserComparison = {
                sourceId: `vk:${screenName}`,
                exactCurrentDomCount: currentDomExactPosts.length,
                exactDiagnostics: currentDomExactPosts?.snapshotDiagnostics || {},
                exactLegacyRegexUsed: currentDomExactPosts.length === 0 && snapshotExactPosts.length > 0,
                exactCount: snapshotExactPosts.length,
                adaptiveCount: finalPosts.length,
                adaptivePasses: [...new Set(finalPosts.map((post) => String(post?.parserPass || 'unknown')))].slice(0, 12),
                renderedOnlyIds,
                exactOnlyIds,
                fallbackUsed: currentDomExactPosts.length === 0,
                exactMissedSome: renderedOnlyIds.length > 0,
                exactFailureReason: currentDomExactPosts.length
                    ? ''
                    : (parserReport.exactErrors.at(-1)?.message || 'current-dom-exact-returned-zero'),
            };
            parserReport.comparisons.push(parserComparison);
            diagnostics?.log?.('parser.compare', parserComparison);
            if (currentDomExactPosts.length === 0 && snapshotExactPosts.length) {
                diagnostics?.log?.('parser.fallback.used', {
                    sourceId: `vk:${screenName}`,
                    fallbackPass: 'snapshot-exact-legacy-regex',
                    reason: 'current-dom-exact-returned-zero',
                    recoveredIds: [...exactIdsForDiagnostics].slice(0, 40),
                });
            } else if (renderedOnlyIds.length) {
                diagnostics?.log?.('parser.fallback.used', {
                    sourceId: `vk:${screenName}`,
                    fallbackPass: 'snapshot-adaptive-heuristic',
                    reason: 'same-snapshot-structural-or-heuristic-recovered-posts-missing-from-exact',
                    recoveredIds: renderedOnlyIds,
                });
            }
            const exactById = new Map(snapshotExactPosts.map((post) => [
                `${Number(post.ownerId || 0)}_${Number(post.postId || 0)}`,
                post,
            ]));
            for (const renderedPost of finalPosts) {
                const key = `${Number(renderedPost.ownerId || 0)}_${Number(renderedPost.postId || 0)}`;
                const exact = exactById.get(key) || snapshotExactPosts.find((post) => Number(post.postId) === Number(renderedPost.postId));
                const mergedMedia = exact
                    ? mergeVkCapturedImageMedia(exact?.imageMedia, renderedPost?.imageMedia, { strictIdentity: true })
                    : mergeVkCapturedImageMedia([], renderedPost?.imageMedia);
                const merged = exact
                    ? {
                        ...exact,
                        ...renderedPost,
                        text: String(exact?.parserPass || '').includes('snapshot-exact-current-dom')
                            ? (String(exact.text || '').trim() || String(renderedPost.text || '').trim())
                            : (String(renderedPost.text || '').trim() || String(exact.text || '').trim()),
                        publishedAt: Number(renderedPost.publishedAt || exact.publishedAt || 0),
                        contentText: String(exact?.contentText || '').trim() || String(renderedPost?.contentText || '').trim(),
                        repostText: String(exact?.repostText || '').trim() || String(renderedPost?.repostText || '').trim(),
                        // Snapshot owns ordering/identity, rendered DOM owns the
                        // fresher currentSrc for the same photo attachment. VK
                        // sometimes serializes a stale thumbnail src in one cell
                        // of a multi-photo grid; attachmentKey lets us replace
                        // only that cell instead of losing the real poster.
                        links: [...new Set([...(exact?.links || []), ...(renderedPost?.links || [])])],
                        eventLinks: [...new Map([
                            ...(exact?.eventLinks || []),
                            ...(renderedPost?.eventLinks || []),
                        ].filter((item) => item?.url).map((item) => [String(item.url), item])).values()],
                        imageUrls: mergedMedia.length
                            ? mergedMedia.map((item) => item.url)
                            : [...new Set([...(exact?.imageUrls || []), ...(renderedPost?.imageUrls || [])])].slice(0, MAX_IMAGES_PER_POST),
                        imageMedia: mergedMedia,
                        imageOrigin: exact?.imageOrigin || renderedPost?.imageOrigin || '',
                        parserPass: `snapshot-exact+${renderedPost.parserPass || 'rendered'}`,
                    }
                    : {
                        ...renderedPost,
                        imageUrls: mergedMedia.length ? mergedMedia.map((item) => item.url) : renderedPost.imageUrls,
                        imageMedia: mergedMedia.length ? mergedMedia : renderedPost.imageMedia,
                        parserPass: renderedPost.parserPass || 'rendered',
                    };
                collected.set(`${merged.ownerId}_${merged.postId}`, merged);
            }

            // Exact-only recovery is admitted only when rendered extraction found
            // nothing at all; this prevents nested repost wall ids from polluting
            // a healthy outer-post result set.
            if (!finalPosts.length && snapshotExactPosts.length) {
                for (const post of snapshotExactPosts.slice(0, targetCount)) {
                    collected.set(`${post.ownerId}_${post.postId}`, {
                        ...post,
                        parserPass: 'snapshot-exact',
                    });
                }
            }

            // V188.141: Record the DOM already present after the native finite
            // public pass. Additional scrolls solely for the forensic snapshot
            // must never extend the capture barrier for later VK sources.
            if (diagnostics?.captureVkFinalDomSnapshot && diagnostics.finalDomOnly && !page.isClosed?.()) {
                try {
                    await diagnostics.captureVkFinalDomSnapshot({
                        page, sourceId: `vk:${screenName}`, sourceKind: 'vk-public',
                        direction: 'down',
                        preparation: {
                            status: 'native-capture-finished-no-extra-pagination',
                            direction: 'down', prepared: false, steps: 0,
                            controlsCompleted: 0, progress: [],
                            note: 'Snapshot after the native finite pass; no additional pagination or claim of whole-wall completeness.',
                        },
                    });
                } catch (finalCaptureError) {
                    diagnostics.log?.('vk.final-fixture.capture-error', {
                        sourceId: `vk:${screenName}`, error: finalCaptureError,
                    });
                }
            }

            console.log(
                '[VK PUBLIC PAGE CAPTURED]',
                `source=vk.ru/${screenName}`,
                `target=${targetCount}`,
                `viewportPosts=${visitedPosts}`,
                `snapshotExact=${snapshotExactCount}`,
                `collected=${collected.size}`,
                `holdMs=${pageHoldMs}`,
            );
        } catch (error) {
            if (keepPageOpen && isScraperTargetClosedError(error)) {
                stoppedByOwner = true;
                parserReport.interrupted = true;
                parserReport.interruptionReason = 'browser-target-closed';
                diagnostics?.log?.('source.capture.interrupted', {
                    sourceId: `vk:${screenName}`,
                    collected: collected.size,
                    retainedDomChars: fullDomHtml.length,
                    reason: parserReport.interruptionReason,
                });
                console.log(
                    '[VK MANUAL PARSER FINISH BY CLOSE]',
                    `source=vk.ru/${screenName}`,
                    `collected=${collected.size}`,
                );
            } else {
                parserReport.interrupted = true;
                parserReport.interruptionReason = `capture-error:${String(error?.message ?? error).slice(0, 500)}`;
                if (fullDomHtml && diagnostics?.captureDomSnapshot) {
                    captureDomPath = await diagnostics.captureDomSnapshot({
                        sourceId: `vk:${screenName}`,
                        page,
                        html: fullDomHtml,
                        label: 'capture-error-last-known',
                        metadata: {
                            phase: 'last-known-full-dom-before-error',
                            collected: collected.size,
                            error: String(error?.message ?? error).slice(0, 500),
                        },
                    }) || captureDomPath;
                }
                if (error && typeof error === 'object') {
                    error.manualCaptureDomPath = captureDomPath;
                    error.manualParserReport = parserReport;
                }
                // Finite parser-all keeps successful tabs alive until raw cache
                // persistence, but a failed capture must not leave the broken
                // page around. Close it so the retry opens a genuinely fresh tab
                // in the same persistent Chromium context.
                if (!keepPageOpen && page && !page.isClosed()) {
                    await page.close().catch(() => {});
                    page = null;
                }
                throw error;
            }
        }

        if (!collected.size && !stoppedByOwner) {
            const debug = await saveVkDebug(page, dataDirectory, screenName);
            if (!keepPageOpen && page && !page.isClosed()) {
                await page.close().catch(() => {});
                page = null;
            }
            throw new Error(
                'VK: публикации не найдены в открытой странице. ' +
                `Диагностика сохранена: ${debug.screenshotPath}`,
            );
        }

        completedSuccessfully = !stoppedByOwner;
        return buildResult();
    } finally {
        if (
            page &&
            keepPageOpen && completedSuccessfully &&
            !page.isClosed()
        ) {
            keptManualPages.set(screenName, page);
            page.once('close', () => {
                if (keptManualPages.get(screenName) === page) keptManualPages.delete(screenName);
                const loop = manualLiveLoops.get(screenName);
                if (loop?.page === page) manualLiveLoops.delete(screenName);
            });
            await page.bringToFront().catch(() => {});
            console.log(
                '[VK SCRAPER TAB KEPT OPEN]',
                `source=vk.ru/${screenName}`,
                'samePass=true',
                'autoClose=false',
            );
        } else if (page && !page.isClosed() && !deferClose) {
            await page.close().catch(() => {});
        }
    }
}

function parseVkWallDescriptor(value) {
    const match = String(value ?? '').match(/wall(-?\d+)_(\d+)/iu);
    if (!match) return null;
    const ownerId = Number(match[1]);
    const postId = Number(match[2]);
    return Number.isFinite(ownerId) && postId > 0
        ? { ownerId, postId, sourceUrl: `https://vk.ru/wall${ownerId}_${postId}` }
        : null;
}

function normalizeEventMatchText(value) {
    return String(value ?? '')
        .toLowerCase()
        .replace(/ё/gu, 'е')
        .replace(/[^a-zа-я0-9]+/giu, ' ')
        .replace(/\s+/gu, ' ')
        .trim();
}

function eventDateSearchTokens(eventDate) {
    const value = String(eventDate ?? '').trim();
    const match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/u);
    if (!match) return [];
    const [, year, month, day] = match;
    const numericDay = String(Number(day));
    const numericMonth = String(Number(month));
    const monthNames = [
        '',
        'января', 'февраля', 'марта', 'апреля', 'мая', 'июня',
        'июля', 'августа', 'сентября', 'октября', 'ноября', 'декабря',
    ];
    const monthName = monthNames[Number(month)] || '';
    return [...new Set([
        `${day}.${month}.${year}`,
        `${numericDay}.${numericMonth}.${year}`,
        `${day}.${month}`,
        `${numericDay}.${numericMonth}`,
        `${day}/${month}/${year}`,
        `${numericDay}/${numericMonth}/${year}`,
        monthName ? `${numericDay} ${monthName} ${year}` : '',
        monthName ? `${numericDay} ${monthName}` : '',
    ].filter(Boolean).map(normalizeEventMatchText))];
}

function eventKeywordTokens(event) {
    const stop = new Set([
        'концерт', 'вечеринка', 'туса', 'тусовка', 'мероприятие', 'анонс',
        'воронеж', 'сегодня', 'завтра', 'бар', 'клуб', 'рок', 'рокбар',
        'the', 'and', 'with', 'live', 'music',
    ]);
    return [...new Set(
        normalizeEventMatchText([
            event?.title,
            event?.participants,
        ].filter(Boolean).join(' '))
            .split(' ')
            .filter((token) => token.length >= 4 && !stop.has(token)),
    )].slice(0, 14);
}

function scoreVkPosterRecoveryPost(post, event) {
    const text = normalizeEventMatchText(post?.text);
    if (!text) return -1;

    const dateTokens = eventDateSearchTokens(event?.eventDate);
    const keywordTokens = eventKeywordTokens(event);
    const venueTokens = normalizeEventMatchText(event?.venue)
        .split(' ')
        .filter((token) => token.length >= 4)
        .slice(0, 8);

    const dateHits = dateTokens.filter((token) => token && text.includes(token)).length;
    const keywordHits = keywordTokens.filter((token) => text.includes(token)).length;
    const venueHits = venueTokens.filter((token) => text.includes(token)).length;

    let score = 0;
    if (dateHits) score += 220 + Math.min(80, (dateHits - 1) * 20);
    score += Math.min(180, keywordHits * 45);
    score += Math.min(60, venueHits * 20);
    if (keywordTokens.length && keywordHits >= Math.min(2, keywordTokens.length)) score += 70;

    /*
     * Без даты допускаем только очень сильное совпадение названия/участников.
     * Это защищает от случайной соседней фотки в том же паблике.
     */
    if (!dateHits && keywordHits < Math.min(3, Math.max(2, keywordTokens.length))) {
        return -1;
    }

    return score;
}

async function primeVkPostMediaByIdentity(page, ownerId, postId) {
    return page.evaluate(({ ownerId: targetOwner, postId: targetPost }) => {
        const wallToken = `wall${targetOwner}_${targetPost}`.toLowerCase();
        const anchors = [...document.querySelectorAll('a[href*="wall"]')];
        const anchor = anchors.find((item) => {
            const href = String(item.href || item.getAttribute('href') || '').toLowerCase();
            return href.includes(wallToken);
        });
        if (!anchor) return false;

        let container = anchor.closest(
            '[data-post-id], [data-post], article, .Post, .post, .wall_item, .feed_row, .wall_post_cont',
        );
        if (!container) {
            let node = anchor.parentElement;
            for (let depth = 0; node && depth < 9; depth += 1) {
                const text = String(node.innerText || node.textContent || '').trim();
                if (text.length >= 20 && (node.querySelectorAll?.('a[href*="wall"]')?.length ?? 0) >= 1) {
                    container = node;
                    break;
                }
                node = node.parentElement;
            }
        }
        if (!container) return false;
        for (const image of container.querySelectorAll('img')) {
            try {
                image.loading = 'eager';
                image.decoding = 'async';
            } catch {}
        }
        container.scrollIntoView({ block: 'center', behavior: 'smooth' });
        return true;
    }, { ownerId, postId }).catch(() => false);
}

async function findRepostWallUrlOnPage(page, sourceUrl) {
    return page.evaluate((rawSourceUrl) => {
        const sourceMatch = String(rawSourceUrl || '').match(/wall(-?\d+)_(\d+)/i);
        const sourceToken = sourceMatch
            ? `wall${sourceMatch[1]}_${sourceMatch[2]}`.toLowerCase()
            : '';
        const absolute = (href) => {
            try {
                return new URL(String(href || ''), location.href).href;
            } catch {
                return '';
            }
        };
        const canonicalWall = (href) => {
            const match = String(href || '').match(/wall(-?\d+)_(\d+)/i);
            return match ? `https://vk.ru/wall${match[1]}_${match[2]}` : '';
        };

        let sourceContainer = null;
        if (sourceToken) {
            const sourceAnchor = [...document.querySelectorAll('a[href*="wall"]')].find((anchor) => (
                absolute(anchor.getAttribute('href') || anchor.href).toLowerCase().includes(sourceToken)
            ));
            sourceContainer = sourceAnchor?.closest?.(
                '[data-post-id], [data-post], article, .Post, .post, .wall_item, .feed_row, .wall_post_cont',
            ) || null;
        }
        sourceContainer ||= document.querySelector(
            '[data-post-id], [data-post], article, .Post, .wall_post_cont, .post',
        );
        if (!sourceContainer) return '';

        const candidates = [];
        for (const anchor of sourceContainer.querySelectorAll('a[href*="wall"]')) {
            const canonical = canonicalWall(anchor.getAttribute('href') || anchor.href);
            if (!canonical || canonical.toLowerCase().includes(sourceToken)) continue;
            let score = 0;
            let node = anchor;
            for (let depth = 0; node && node !== sourceContainer.parentElement && depth < 7; depth += 1) {
                const marker = [
                    String(node.className || ''),
                    node.getAttribute?.('data-testid') || '',
                    node.getAttribute?.('aria-label') || '',
                ].join(' ').toLowerCase();
                if (/repost|copy|wall_copy|copy_history|shared|quote/i.test(marker)) score += 100;
                node = node.parentElement;
            }
            const linkText = String(anchor.innerText || anchor.textContent || '').trim();
            if (/\d{1,2}[:.]\d{2}|сегодня|вчера|\d{1,2}\s+[а-яё]+/i.test(linkText)) score += 15;
            candidates.push({ canonical, score });
        }

        candidates.sort((left, right) => right.score - left.score);
        return candidates[0]?.canonical || '';
    }, sourceUrl).catch(() => '');
}

function communityUrlForOwnerId(ownerId) {
    const value = Number(ownerId);
    if (!Number.isFinite(value) || value === 0) return '';
    return value < 0
        ? `https://vk.ru/club${Math.abs(value)}`
        : `https://vk.ru/id${value}`;
}

/**
 * V146: если точный wall/repost не содержит реальной афиши, браузер проходит
 * цепочку "исходная ссылка -> оригинал репоста -> паблик оригинала" и медленно
 * листает паблик до поста, который совпадает с датой/названием события.
 */
export async function recoverVkEventPosterWithBrowser({
    sourceUrl,
    event,
    relatedWallUrls = [],
    dataDirectory = './data',
    notifyAttention = null,
    maxScrollSteps = 50,
    requireSpecificAnnouncement = false,
} = {}) {
    const sourceDescriptor = parseVkWallDescriptor(sourceUrl);
    if (!sourceDescriptor) return null;

    const page = await openScraperPage({
        url: sourceDescriptor.sourceUrl,
        source: 'VK EVENT POSTER RECOVERY',
        dataDirectory,
        notifyAttention,
        waitUntil: 'domcontentloaded',
        reuseKey: '',
        navigationTimeoutMs: 45_000,
        manualAccessTimeoutMs: 45_000,
    });
    const parserPageOpenedAt = Date.now();
    const minimumParserPageLifetimeMs = 180_000;

    const navigate = async (url, label) => {
        await page.goto(url, {
            waitUntil: 'domcontentloaded',
            timeout: 45_000,
        });
        await waitForManualAccess({
            page,
            source: `VK ${label}`,
            dataDirectory,
        });
        await page.bringToFront().catch(() => {});
        await page.waitForTimeout(900);
    };

    try {
        await waitForManualAccess({
            page,
            source: 'VK event source',
            dataDirectory,
        });
        await primeVkPostMediaByIdentity(
            page,
            sourceDescriptor.ownerId,
            sourceDescriptor.postId,
        );
        await page.waitForTimeout(900);

        const apiRelated = [...new Set(
            (Array.isArray(relatedWallUrls) ? relatedWallUrls : [])
                .map((value) => parseVkWallDescriptor(value)?.sourceUrl || '')
                .filter((value) => value && value !== sourceDescriptor.sourceUrl),
        )];
        const domRelated = await findRepostWallUrlOnPage(page, sourceDescriptor.sourceUrl);
        const originalUrl = apiRelated[0] || domRelated || sourceDescriptor.sourceUrl;
        const originalDescriptor = parseVkWallDescriptor(originalUrl) || sourceDescriptor;
        const excludedPostKeys = new Set(
            requireSpecificAnnouncement
                ? [
                    `${Number(sourceDescriptor.ownerId)}_${Number(sourceDescriptor.postId)}`,
                    `${Number(originalDescriptor.ownerId)}_${Number(originalDescriptor.postId)}`,
                ]
                : [],
        );

        if (originalUrl !== sourceDescriptor.sourceUrl) {
            console.log(
                '[VK EVENT REPOST FOLLOW]',
                `source=${sourceDescriptor.sourceUrl}`,
                `original=${originalUrl}`,
            );
            await navigate(originalUrl, 'repost original');
            await primeVkPostMediaByIdentity(
                page,
                originalDescriptor.ownerId,
                originalDescriptor.postId,
            );
            await page.waitForTimeout(1000);

            if (!requireSpecificAnnouncement) {
                const directPosts = await extractRenderedVkPosts(page, '');
                const direct = directPosts
                    .map((post) => ({ post, score: scoreVkPosterRecoveryPost(post, event) }))
                    .filter((item) => item.score >= 0)
                    .sort((left, right) => right.score - left.score)[0];
                if (direct?.post && direct.score >= 220) {
                    await primeVkPostMediaByIdentity(page, direct.post.ownerId, direct.post.postId);
                    await page.waitForTimeout(1000);
                    const refreshedDirectPosts = await extractRenderedVkPosts(page, '');
                    const refreshedDirect = refreshedDirectPosts.find((post) => (
                        Number(post.ownerId) === Number(direct.post.ownerId) &&
                        Number(post.postId) === Number(direct.post.postId)
                    )) || direct.post;
                    if (Array.isArray(refreshedDirect.imageUrls) && refreshedDirect.imageUrls.length) {
                        return {
                            imageUrls: refreshedDirect.imageUrls,
                            matchedPostUrl: refreshedDirect.sourceUrl,
                            originalUrl,
                            communityUrl: '',
                            score: direct.score,
                            method: 'repost-original-post',
                        };
                    }
                }
            }
        }

        const communityUrl = communityUrlForOwnerId(originalDescriptor.ownerId);
        if (!communityUrl) return null;

        console.log(
            '[VK EVENT COMMUNITY SEARCH]',
            `community=${communityUrl}`,
            `event=${String(event?.eventDate || '')}`,
            `title=${JSON.stringify(String(event?.title || ''))}`,
            `specific=${requireSpecificAnnouncement ? 'yes' : 'no'}`,
        );
        await navigate(communityUrl, 'repost community');

        const collected = new Map();
        let stableRounds = 0;
        let previousSize = 0;
        const safeSteps = Math.max(1, Math.min(80, Number(maxScrollSteps) || 50));
        for (let step = 0; step < safeSteps; step += 1) {
            const posts = await extractRenderedVkPosts(page, '');
            for (const post of posts) {
                collected.set(`${post.ownerId}_${post.postId}`, post);
            }

            const ranked = [...collected.values()]
                .filter((post) => !excludedPostKeys.has(`${Number(post?.ownerId)}_${Number(post?.postId)}`))
                .map((post) => ({ post, score: scoreVkPosterRecoveryPost(post, event) }))
                .filter((item) => item.score >= 0)
                .sort((left, right) => right.score - left.score);

            const best = ranked[0];
            if (best && best.score >= 260) {
                await primeVkPostMediaByIdentity(page, best.post.ownerId, best.post.postId);
                await page.waitForTimeout(1200);
                const refreshed = await extractRenderedVkPosts(page, '');
                const updated = refreshed.find((post) => (
                    Number(post.ownerId) === Number(best.post.ownerId) &&
                    Number(post.postId) === Number(best.post.postId)
                )) || best.post;
                if (Array.isArray(updated.imageUrls) && updated.imageUrls.length) {
                    console.log(
                        '[VK EVENT COMMUNITY POSTER FOUND]',
                        `post=${updated.sourceUrl}`,
                        `score=${best.score}`,
                        `images=${updated.imageUrls.length}`,
                        `step=${step}`,
                    );
                    return {
                        imageUrls: updated.imageUrls,
                        matchedPostUrl: updated.sourceUrl,
                        originalUrl,
                        communityUrl,
                        score: best.score,
                        method: 'repost-community-scroll',
                    };
                }
            }

            if (collected.size === previousSize) stableRounds += 1;
            else {
                previousSize = collected.size;
                stableRounds = 0;
            }
            if (stableRounds >= 8) break;

            await page.evaluate(() => {
                window.scrollBy({
                    top: Math.max(650, window.innerHeight * 0.82),
                    behavior: 'smooth',
                });
            }).catch(() => {});
            await page.waitForTimeout(clampInteger(
                process.env.VK_EVENT_POSTER_RECOVERY_SCROLL_DELAY_MS,
                600,
                4000,
                1100,
            ));
        }

        console.warn(
            '[VK EVENT COMMUNITY POSTER NOT FOUND]',
            `community=${communityUrl}`,
            `scanned=${collected.size}`,
            `event=${String(event?.eventDate || '')}`,
        );
        return null;
    } finally {
        // V188.83: every finite parser/recovery tab obeys the same hard minimum
        // lifetime as the main VK/TG/QTickets collectors. Do not trade source
        // stability for speed; parallel workers provide the acceleration.
        const remainingLifetimeMs = minimumParserPageLifetimeMs - (Date.now() - parserPageOpenedAt);
        if (remainingLifetimeMs > 0) {
            await page.waitForTimeout(remainingLifetimeMs).catch(() => new Promise((resolve) => setTimeout(resolve, remainingLifetimeMs)));
        }
        await page.close().catch(() => {});
    }
}

async function collectInitialPosts({
    screenName,
    targetCount,
    dataDirectory,
    notifyAttention,
    keepPageOpen = false,
    deferClose = false,
    diagnostics = null,
    recoveryScrollSteps = 0,
    snapshotEveryScroll = false,
    minimumPageLifetimeMs = 0,
}) {
    return collectVkPostsWithBrowser({
        screenName,
        targetCount,
        dataDirectory,
        notifyAttention,
        keepPageOpen,
        deferClose,
        diagnostics,
        recoveryScrollSteps,
        snapshotEveryScroll,
        minimumPageLifetimeMs,
    });
}

async function collectNewPosts({
    screenName,
    lastPostId,
    dataDirectory,
    notifyAttention,
    keepPageOpen = false,
    deferClose = false,
    diagnostics = null,
    recoveryScrollSteps = 0,
    snapshotEveryScroll = false,
    minimumPageLifetimeMs = 0,
}) {
    const posts = await collectVkPostsWithBrowser({
        screenName,
        targetCount: 20,
        stopAtPostId: lastPostId,
        dataDirectory,
        notifyAttention,
        keepPageOpen,
        deferClose,
        diagnostics,
        recoveryScrollSteps,
        snapshotEveryScroll,
        minimumPageLifetimeMs,
    });

    return posts.sort((left, right) => left.postId - right.postId);
}

function hashPost(post) {
    // New verified media identity changes the ledger hash even when text is unchanged.
    return createVkPublicCaptureHash(post);
}

function parseStoredStringArray(value) {
    try {
        const parsed = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed)
            ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean)
            : [];
    } catch {
        return [];
    }
}

function sanitizeVkPosterImageUrls(values) {
    return [...new Set((Array.isArray(values) ? values : [])
        .map((value) => String(value ?? '').trim())
        .filter((url) => /^https?:\/\//iu.test(url))
        .filter((url) => !isLikelyVkNonPosterUiImageUrl(url)))]
        .slice(0, MAX_IMAGES_PER_POST);
}

function knownUiImageHashes(fingerprints) {
    return new Set((Array.isArray(fingerprints) ? fingerprints : [])
        .filter((item) => isLikelyVkNonPosterUiImageUrl(item?.url))
        .map((item) => String(item?.sha256 ?? '').trim())
        .filter((value) => /^[a-f0-9]{64}$/iu.test(value)));
}

function removeKnownUiImagePaths(imagePaths, {
    dataDirectory,
    rejectedHashes,
} = {}) {
    const hashes = rejectedHashes instanceof Set ? rejectedHashes : new Set();
    if (!hashes.size) return Array.isArray(imagePaths) ? imagePaths : [];
    return (Array.isArray(imagePaths) ? imagePaths : []).filter((relativePath) => {
        const clean = String(relativePath ?? '').trim();
        if (!clean) return false;
        try {
            const absolute = join(dataDirectory, clean);
            if (!existsSync(absolute)) return false;
            const digest = createHash('sha256').update(readFileSync(absolute)).digest('hex');
            return !hashes.has(digest);
        } catch {
            return false;
        }
    });
}

function guessImageExtension(contentType, url) {
    const type = String(contentType ?? '').toLowerCase();

    if (type.includes('png')) return '.png';
    if (type.includes('webp')) return '.webp';
    if (type.includes('gif')) return '.gif';
    if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';

    try {
        const fromUrl = extname(new URL(url).pathname).toLowerCase();
        return /^\.(?:jpe?g|png|webp|gif)$/u.test(fromUrl)
            ? fromUrl.replace('.jpeg', '.jpg')
            : '.jpg';
    } catch {
        return '.jpg';
    }
}

async function downloadEventImages({
    screenName,
    postId,
    imageUrls,
    dataDirectory,
    notifyAttention,
}) {
    if (!Array.isArray(imageUrls) || !imageUrls.length) {
        return [];
    }

    const targetDirectory = join(dataDirectory, 'vk_announcements', screenName);
    mkdirSync(targetDirectory, { recursive: true });
    const paths = [];

    for (let index = 0; index < imageUrls.length; index += 1) {
        try {
            const response = await browserDownloadBuffer({
                url: imageUrls[index],
                dataDirectory,
                notifyAttention,
                source: 'VK image',
                maximumBytes: MAX_IMAGE_BYTES,
            });
            const extension = guessImageExtension(response.contentType, response.finalUrl);
            const relativePath = join('vk_announcements', screenName, `${postId}-${index + 1}${extension}`);
            writeFileSync(join(dataDirectory, relativePath), response.buffer);
            paths.push(relativePath.replace(/\\/gu, '/'));
        } catch (error) {
            console.error('[VK HTML IMAGE ERROR]', `post=${screenName}/${postId}`, String(error?.message ?? error));
        }
    }

    return paths;
}

async function fetchVkImageDirect(url, timeoutMs = 30_000) {
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(5_000, Number(timeoutMs) || 30_000)),
        headers: {
            'user-agent': DEFAULT_USER_AGENT,
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
    });
    if (!response.ok) throw new Error(`VK image fingerprint: HTTP ${response.status}`);
    const advertisedBytes = Number(response.headers.get('content-length') || 0);
    if (advertisedBytes > MAX_IMAGE_BYTES) {
        throw new Error(`VK image fingerprint: файл превысил ${MAX_IMAGE_BYTES} байт`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`VK image fingerprint: файл превысил ${MAX_IMAGE_BYTES} байт`);
    }
    return {
        buffer,
        contentType: response.headers.get('content-type') || '',
        finalUrl: response.url || url,
    };
}

async function fingerprintVkPostImages(post, {
    dataDirectory,
    notifyAttention,
    browserFallback = true,
    onAttemptError = null,
    onRecovered = null,
    onFallback = null,
    onRejected = null,
}) {
    if (!Array.isArray(post?.imageUrls) || !post.imageUrls.length) return [];
    return fingerprintRemoteImages({
        imageUrls: post.imageUrls,
        maximum: MAX_IMAGES_PER_POST,
        posterOnly: true,
        fetchBuffer: browserFallback
            ? (url) => browserDownloadBuffer({
                url,
                dataDirectory,
                notifyAttention,
                source: 'VK image fingerprint',
                maximumBytes: MAX_IMAGE_BYTES,
                timeoutMs: 30_000,
            })
            : (url) => fetchVkImageDirect(url, 30_000),
        onAttemptError,
        onRecovered,
        onFallback,
        onRejected,
    });
}


async function captureBoundedLinkedVkSourcesForPosts(posts, {
    screenName,
    dataDirectory,
    notifyAttention,
    maximumPerParent = 12,
    maximumPerRun = 36,
} = {}) {
    const list = Array.isArray(posts) ? posts : [];
    const visited = new Set();
    let opened = 0;
    let enrichmentPage = null;
    const reuseKey = `vk-public-event-enrichment:${String(screenName || 'source')}`;

    const captureEventPage = async (page, sourceUrl) => page.evaluate((url) => {
        const main = document.querySelector('main, [role="main"]') || document.body;
        const text = String(main?.innerText || main?.textContent || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+\n/g, '\n')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, 12_000);
        const imageMedia = [];
        for (const image of [...main.querySelectorAll('img')]) {
            const rect = image.getBoundingClientRect?.() || { width: 0, height: 0 };
            const width = Math.max(Number(image.naturalWidth || 0), Number(rect.width || 0));
            const height = Math.max(Number(image.naturalHeight || 0), Number(rect.height || 0));
            if (Math.min(width, height) < 240 || width * height < 120_000) continue;
            const candidate = String(image.currentSrc || image.src || image.getAttribute('data-src') || '').trim();
            if (!/^https?:\/\//i.test(candidate)) continue;
            if (!imageMedia.some((item) => item.url === candidate)) {
                imageMedia.push({ url: candidate, origin: 'linked-event-page', repostDepth: 0, width, height });
            }
            if (imageMedia.length >= 6) break;
        }
        return { sourceUrl: url, text, imageUrls: imageMedia.map((item) => item.url), imageMedia };
    }, sourceUrl).catch(() => null);

    try {
        for (const post of list) {
            if (opened >= maximumPerRun) break;
            const rawLinks = boundedVkEventSourceLinks(post?.eventLinks || post?.links, { maximum: maximumPerParent });
            if (!rawLinks.length) continue;
            const text = sanitizeEventBodyText(post?.text || '');
            const dateCount = extractRawDateMentions(text).length;
            const localChildren = parsePublicPostLocally({ ...post, text });
            const scheduleLike = Boolean(
                dateCount >= 2 ||
                /(?:расписани|афиш[аи]\s+(?:на|месяц|недел)|программа\s+(?:на|мероприятий)|diesel\s+hall|bar\s*\/\s*hall)/iu.test(text)
            );
            if (!scheduleLike) continue;

            // If the parent already deterministically yielded all visible date
            // slots, link browsing adds no value and is intentionally skipped.
            if (dateCount >= 2 && localChildren.length >= dateCount) continue;

            const linkedSources = [];
            const resolvedLinks = [];
            for (const rawLink of rawLinks) {
                if (opened >= maximumPerRun || linkedSources.length >= maximumPerParent) break;
                let link = rawLink;
                if (link.short) {
                    const resolved = await resolveVkShortUrlControlled(link.url);
                    if (!resolved) continue;
                    link = { ...link, ...resolved, short: false };
                }
                const parentCanonical = classifyVkEventSourceUrl(post?.sourceUrl)?.url || String(post?.sourceUrl || '');
                if (!link?.url || link.url === parentCanonical || visited.has(link.url)) continue;
                visited.add(link.url);
                resolvedLinks.push({ ...rawLink, url: link.url, kind: link.kind, short: false });

                // A community page is an allowed endpoint but is not a specific
                // event source. Never turn its latest arbitrary wall post into a
                // child event. Specific wall/event pages are the enrichment unit.
                if (!['wall', 'event'].includes(link.kind)) continue;
                opened += 1;
                try {
                    enrichmentPage = await openScraperPage({
                        url: link.url,
                        source: 'VK EVENT LINK ENRICHMENT',
                        dataDirectory,
                        notifyAttention,
                        reuseKey,
                        navigationTimeoutMs: 30_000,
                        manualAccessTimeoutMs: 30_000,
                    });
                    await settleScraperPage({
                        page: enrichmentPage,
                        source: 'VK EVENT LINK ENRICHMENT',
                        scrollSteps: 0,
                        mediaWaitMs: 2_500,
                        holdMs: 100,
                    });
                    let source = null;
                    if (link.kind === 'wall') {
                        const html = await enrichmentPage.content();
                        const exact = await extractExactVkPostsFromDomSnapshot(enrichmentPage, html, screenName);
                        const rendered = await extractRenderedVkPosts(enrichmentPage, screenName);
                        const candidates = [...exact, ...rendered];
                        source = candidates.find((candidate) => (
                            classifyVkEventSourceUrl(candidate?.sourceUrl)?.url === link.url
                        )) || null;
                    } else if (link.kind === 'event') {
                        source = await captureEventPage(enrichmentPage, link.url);
                    }
                    if (source?.text) {
                        linkedSources.push({
                            ...source,
                            sourceUrl: link.url,
                            linkKind: link.kind,
                            parentSourceUrl: String(post?.sourceUrl || ''),
                            parentItemId: String(post?.postId || ''),
                        });
                    }
                } catch (error) {
                    console.warn('[VK EVENT LINK ENRICHMENT ERROR]', `parent=${post?.sourceUrl || ''}`, `link=${link.url}`, String(error?.message || error));
                }
            }

            if (resolvedLinks.length) {
                post.eventLinks = [...new Map([
                    ...(Array.isArray(post.eventLinks) ? post.eventLinks : []),
                    ...resolvedLinks,
                ].filter((item) => item?.url).map((item) => [String(item.url), item])).values()];
            }
            if (linkedSources.length) {
                post.linkedSources = linkedSources;
                const linkedMedia = linkedSources.flatMap((source) => (
                    (Array.isArray(source?.imageMedia) ? source.imageMedia : []).map((item) => ({
                        ...item,
                        origin: 'linked-wall',
                        linkedSourceUrl: source.sourceUrl,
                    }))
                ));
                post.imageMedia = [...new Map([
                    ...(Array.isArray(post.imageMedia) ? post.imageMedia : []),
                    ...linkedMedia,
                ].filter((item) => item?.url).map((item) => [String(item.url), item])).values()].slice(0, MAX_IMAGES_PER_POST);
                post.imageUrls = [...new Set([
                    ...(Array.isArray(post.imageUrls) ? post.imageUrls : []),
                    ...linkedSources.flatMap((source) => Array.isArray(source?.imageUrls) ? source.imageUrls : []),
                ])].slice(0, MAX_IMAGES_PER_POST);
            }
        }
    } finally {
        if (enrichmentPage && !enrichmentPage.isClosed()) {
            await enrichmentPage.close().catch(() => {});
        }
    }

    return { opened, visited: visited.size };
}

function mergeLinkedLocalEvents(parentEvents, linkedSources, parentPost) {
    const result = (Array.isArray(parentEvents) ? parentEvents : []).map((event) => ({ ...event }));
    for (const source of Array.isArray(linkedSources) ? linkedSources : []) {
        const linkedEvents = parsePublicPostLocally({
            ...parentPost,
            text: sanitizeEventBodyText(source?.text || ''),
            sourceUrl: source?.sourceUrl || parentPost?.sourceUrl,
            publishedAt: Number(source?.publishedAt || parentPost?.publishedAt || 0),
        });
        for (const child of linkedEvents) {
            const direct = {
                ...child,
                canonicalPostUrl: String(source?.sourceUrl || ''),
                linkedSourceUrl: String(source?.sourceUrl || ''),
                sourceOriginalUrl: String(parentPost?.sourceUrl || ''),
                sourceItemId: String(parentPost?.postId || ''),
                canonicalOrigin: 'schedule-child-link',
                provenanceSourceType: 'vk',
                parseMethod: `${String(child?.parseMethod || 'local')}_linked_vk_v18868`,
            };
            const same = result.findIndex((existing) => (
                String(existing?.eventDate || '') === String(direct?.eventDate || '') &&
                (!existing?.eventTime || !direct?.eventTime || String(existing.eventTime) === String(direct.eventTime)) &&
                [existing?.title, existing?.participants].filter(Boolean).join(' ').toLowerCase()
                    .split(/[^\p{L}\p{N}]+/u).filter((token) => token.length >= 4)
                    .some((token) => [direct?.title, direct?.participants].filter(Boolean).join(' ').toLowerCase().includes(token))
            ));
            if (same >= 0) {
                const existing = result[same];
                result[same] = {
                    ...existing,
                    canonicalPostUrl: direct.canonicalPostUrl || existing.canonicalPostUrl,
                    linkedSourceUrl: direct.linkedSourceUrl,
                    sourceOriginalUrl: direct.sourceOriginalUrl,
                    sourceItemId: direct.sourceItemId,
                    canonicalOrigin: direct.canonicalOrigin,
                    provenanceSourceType: 'vk',
                    title: String(direct.title || '').length > String(existing.title || '').length ? direct.title : existing.title,
                    venue: String(direct.venue || '').length > String(existing.venue || '').length ? direct.venue : existing.venue,
                    participants: String(direct.participants || '').length > String(existing.participants || '').length ? direct.participants : existing.participants,
                    description: String(direct.description || '').length > String(existing.description || '').length ? direct.description : existing.description,
                };
            } else {
                result.push(direct);
            }
        }
    }
    return result;
}


function buildVkEventMediaAudit({
    post,
    visionImageUrls,
    imageFingerprints,
    imageFacts,
    events,
    posterBindingAudit,
}) {
    const facts = parseIndexedImageFacts(imageFacts);
    const factByIndex = new Map(facts.map((item) => [Number(item.index), item]));
    const sourcePaths = [...new Set((Array.isArray(events) ? events : []).flatMap((event) => (
        Array.isArray(event?._sourceImagePaths) ? event._sourceImagePaths : []
    )))];
    const media = Array.isArray(post?.imageMedia) ? post.imageMedia : [];
    const urls = Array.isArray(visionImageUrls) ? visionImageUrls : [];
    const fingerprints = Array.isArray(imageFingerprints) ? imageFingerprints : [];
    const bindings = Array.isArray(posterBindingAudit) ? posterBindingAudit : [];

    return urls.map((url, offset) => {
        const imageIndex = offset + 1;
        const original = media.find((item) => String(item?.url || '') === String(url || '')) || {};
        const localPath = sourcePaths.find((value) => new RegExp(`-${imageIndex}\\.[^.]+$`, 'u').test(String(value))) || '';
        const fingerprint = fingerprints.find((item) => String(item?.url || '') === String(url || '')) || fingerprints[offset] || null;
        const imageBindings = bindings.filter((item) => Number(item?.imageIndex || 0) === imageIndex);
        const selectedBindings = imageBindings.filter((item) => item?.accepted).map((item) => ({
            eventDate: String(item?.eventDate || ''),
            title: String(item?.title || ''),
            score: Number(item?.score || 0),
            reason: String(item?.reason || ''),
        }));
        const vision = factByIndex.get(imageIndex) || null;
        return {
            ...original,
            imageIndex,
            url: String(url || original?.url || ''),
            localPath,
            fingerprint,
            vision,
            bindingCandidates: imageBindings.map((item) => ({
                eventDate: String(item?.eventDate || ''),
                title: String(item?.title || ''),
                accepted: Boolean(item?.accepted),
                score: Number(item?.score || 0),
                reason: String(item?.reason || ''),
            })),
            selectedEvents: selectedBindings,
            finalVerdict: selectedBindings.length
                ? 'selected-poster'
                : vision?.poster === false
                    ? 'rejected-not-poster'
                    : vision?.poster === true
                        ? 'poster-not-matched-to-event'
                        : 'unclassified',
        };
    });
}

async function processPost(post, {
    dataDirectory,
    downloadImages,
    extractEventsWithAi,
    extractImageFactsWithAi,
    notifyAttention,
    timeZone,
    manualRun = false,
    forceKnownMediaRefresh = false,
    forceReprocess = false,
    ledgerContext = null,
    traceAi = null,
}) {
    post = { ...post, text: sanitizeEventBodyText(cleanPublicPostText(post.text, post.screenName)) };
    traceAi?.('provenance', { canonicalOrigin: 'direct-wall', canonicalPostUrl: String(post.sourceUrl || '') });
    console.log('[EVENT PROVENANCE]', `source=vk:${post.screenName}/${post.postId}`, 'origin=direct-wall', `url=${String(post.sourceUrl || '')}`);
    const previous = getVkPostMeta({ screenName: post.screenName, postId: post.postId });
    let storedEventsBefore = forceKnownMediaRefresh
        ? getVkEventsForPostRefresh({ screenName: post.screenName, postId: post.postId })
        : [];
    const originalStoredEvents = getVkEventsForPostRefresh({ screenName: post.screenName, postId: post.postId });
    traceAi?.('forensics.before', { post, previous, previousEvents: originalStoredEvents,
        decision: { forceKnownMediaRefresh, downloadImages, manualRun } });
    const existingAnnouncement = findExistingAnnouncementEvidence({ rawText: post.text, sourceUrl: post.sourceUrl });
    if (existingAnnouncement && !(existingAnnouncement.sourceType === 'vk-public' && existingAnnouncement.sourceKey === String(post.screenName) && existingAnnouncement.itemId === String(post.postId))) {
        traceAi?.('database.skip', { reason: 'existing-announcement', match: existingAnnouncement });
        return { changed: false, eventCount: 0, skippedKnownAnnouncement: true };
    }
    const originalPublishedAt = Number(post?.publishedAt ?? 0);
    if (originalPublishedAt <= 0) {
        const storedPublishedAt = Number(previous?.publishedAt ?? 0);
        post = {
            ...post,
            publishedAt: storedPublishedAt > 0 ? storedPublishedAt : 0,
            publishedAtSource: storedPublishedAt > 0
                ? 'stored-v185-fallback'
                : 'missing-source-date-v185',
        };
        console.warn(
            '[VK PUBLIC PUBLISHED DATE FALLBACK]',
            `post=${post.screenName}/${post.postId}`,
            `source=${post.publishedAtSource}`,
            `publishedAt=${post.publishedAt}`,
        );
    }

    const previousImageFingerprints = parseImageFingerprints(previous?.imageFingerprintsJson);
    const rejectedStoredUiHashes = knownUiImageHashes(previousImageFingerprints);
    if (storedEventsBefore.length && rejectedStoredUiHashes.size) {
        storedEventsBefore = storedEventsBefore.map((event) => {
            const before = Array.isArray(event?.imagePaths) ? event.imagePaths : [];
            const clean = removeKnownUiImagePaths(before, {
                dataDirectory,
                rejectedHashes: rejectedStoredUiHashes,
            });
            return {
                ...event,
                imagePaths: clean,
                _hadRejectedUiImage: clean.length !== before.length,
            };
        });
    }
    const currentPosterUrls = sanitizeVkPosterImageUrls(post.imageUrls);
    const storedPosterUrls = sanitizeVkPosterImageUrls(parseStoredStringArray(previous?.imageUrlsJson));
    const cleanPosterUrls = forceKnownMediaRefresh
        ? [...new Set([...currentPosterUrls, ...storedPosterUrls])].slice(0, MAX_IMAGES_PER_POST)
        : currentPosterUrls;
    if (forceKnownMediaRefresh && storedPosterUrls.length && cleanPosterUrls.length > currentPosterUrls.length) {
        console.log(
            '[VK EVENT MEDIA STORED URL FALLBACK]',
            `post=${post.screenName}/${post.postId}`,
            `current=${currentPosterUrls.length}`,
            `stored=${storedPosterUrls.length}`,
            `effective=${cleanPosterUrls.length}`,
        );
    }
    post = { ...post, imageUrls: cleanPosterUrls };

    const contentHash = hashPost(post);
    const fingerprintsBackfilled = Boolean(
        previous?.textFingerprint &&
        (!Array.isArray(post?.imageUrls) || !post.imageUrls.length || previousImageFingerprints.length),
    );

    // v2 includes proven media identity, repost text and links. An older
    // source hash must be reprocessed once, never interpreted as proof that
    // all current media was analyzed.
    const unchangedPost = String(previous?.contentHash || '') === contentHash;
    if (unchangedPost && fingerprintsBackfilled && !forceReprocess) {
        const previousImagePaths = removeKnownUiImagePaths(
            parseStoredStringArray(previous.imagePathsJson),
            { dataDirectory, rejectedHashes: rejectedStoredUiHashes },
        );
        const onlyGeneratedFallbacks = previousImagePaths.length > 0 && previousImagePaths.every((path) => /-event-\d+\.png$/iu.test(path));
        const hasMissingLocalImage = previousImagePaths.some((path) => !existsSync(join(dataDirectory, path)));
        const needsImageRecovery = Number(previous.eventCount ?? 0) > 0 &&
            (Number(previous?.eventsWithoutImages ?? 0) > 0 ||
                !previousImagePaths.length || onlyGeneratedFallbacks || hasMissingLocalImage);
        if (!forceKnownMediaRefresh && !needsImageRecovery && Number(previous?.eventCount ?? 0) > 0) {
            return { changed: false, eventCount: Number(previous.eventCount ?? 0) };
        }
        if (forceKnownMediaRefresh && Number(previous?.eventCount ?? 0) > 0) {
            console.log(
                '[VK EVENT MEDIA FULL RECHECK]',
                `post=${post.screenName}/${post.postId}`,
                `sourceImages=${Array.isArray(post.imageUrls) ? post.imageUrls.length : 0}`,
                `storedImages=${previousImagePaths.length}`,
                `storedEvents=${Number(previous.eventCount ?? 0)}`,
            );
        } else if (needsImageRecovery) {
            console.log('[VK EVENT MEDIA RETRY]', `post=${post.screenName}/${post.postId}`, `sourceImages=${post.imageUrls.length}`, `storedImages=${previousImagePaths.length}`);
        } else {
            console.log('[VK EVENT RECHECK]', `post=${post.screenName}/${post.postId}`, 'reason=previous-pass-produced-no-announcement');
        }
    }

    const textFingerprint = createSourceTextFingerprint(post.text);
    const textSimilarity = previous?.rawText ? sourceTextSimilarity(previous.rawText, post.text) : 0;
    const nearDuplicateText = Boolean(previous && textSimilarity >= 0.90);
    const exactKnownAnnouncementText = Boolean(
        Number(previous?.eventCount ?? 0) > 0 &&
        cleanPublicPostText(previous?.rawText ?? '', post.screenName) === post.text
    );
    const todayIso = currentIsoDate(timeZone);
    let textOnlyLocalEvents = parsePublicPostLocally({
        text: post.text,
        publishedAt: post.publishedAt,
        screenName: post.screenName,
    });
    if (Array.isArray(post?.linkedSources) && post.linkedSources.length) {
        textOnlyLocalEvents = mergeLinkedLocalEvents(textOnlyLocalEvents, post.linkedSources, post);
    }
    textOnlyLocalEvents = textOnlyLocalEvents.map((event) => ({
        ...event,
        parseMethod: String(event.parseMethod ?? 'local').replace(/^local/u, 'vk_html_local'),
    }));
    const validationSourceText = buildVkValidationSourceText(post);
    const textComplete = textEventsAreComplete(textOnlyLocalEvents, {
        sourceText: validationSourceText,
        publishedAt: post.publishedAt,
        todayIso,
        timeZone,
    });
    const retryTrace = [];
    let rejectedVisionImages = 0;

    // Афиша обязательна: проверяем изображения независимо от того, насколько
    // полным показался текстовый парсинг.
    const imageFingerprints = await fingerprintVkPostImages(post, {
            dataDirectory,
            notifyAttention,
            browserFallback: !manualRun,
            onAttemptError: ({ round, maxRounds, willRetry, delayMs, errorMessage, url = '' }) => {
                const row = {
                    stage: 'image-fingerprint', round, maxRounds, willRetry, delayMs,
                    error: String(errorMessage ?? '').slice(0, 1200),
                    url: String(url ?? '').slice(0, 1500),
                };
                retryTrace.push(row);
                appendEventIngestAudit({
                    dataDirectory, sourceType: 'vk-public', sourceKey: post.screenName,
                    itemId: post.postId, sourceUrl: post.sourceUrl,
                    status: 'retry-error', reason: 'image-fingerprint', rawText: post.text, details: row,
                });
            },
            onRecovered: ({ round, maxRounds, url = '' }) => {
                const row = {
                    stage: 'image-fingerprint', recovered: true, round, maxRounds,
                    url: String(url ?? '').slice(0, 1500),
                };
                retryTrace.push(row);
                appendEventIngestAudit({
                    dataDirectory, sourceType: 'vk-public', sourceKey: post.screenName,
                    itemId: post.postId, sourceUrl: post.sourceUrl,
                    status: 'retry-recovered', reason: 'image-fingerprint', rawText: post.text, details: row,
                });
            },
            onFallback: ({ url, attempts, error, admitted, reason }) => {
                const row = {
                    stage: 'image-fingerprint', fallback: 'url-fingerprint-v186', attempts,
                    admitted: Boolean(admitted), reason: String(reason ?? ''),
                    url: String(url ?? '').slice(0, 1500),
                    error: String(error?.message ?? error ?? '').slice(0, 1200),
                };
                retryTrace.push(row);
                appendEventIngestAudit({
                    dataDirectory, sourceType: 'vk-public', sourceKey: post.screenName,
                    itemId: post.postId, sourceUrl: post.sourceUrl,
                    status: admitted ? 'retry-fallback' : 'image-skipped',
                    reason: admitted ? 'image-fingerprint-url-fallback' : 'poster-size-unverified-after-five-rounds',
                    rawText: post.text, details: row,
                });
            },
            onRejected: ({ url, fingerprint, reason }) => {
                rejectedVisionImages += 1;
                const row = {
                    stage: 'image-admission', reason,
                    url: String(url ?? '').slice(0, 1500),
                    width: Number(fingerprint?.width) || 0,
                    height: Number(fingerprint?.height) || 0,
                    bytes: Number(fingerprint?.bytes) || 0,
                };
                retryTrace.push(row);
                appendEventIngestAudit({
                    dataDirectory, sourceType: 'vk-public', sourceKey: post.screenName,
                    itemId: post.postId, sourceUrl: post.sourceUrl,
                    status: 'image-skipped', reason: 'not-large-poster-like', rawText: post.text, details: row,
                });
            },
        });

    const imageChanged = !imageFingerprintSetsEqual(previousImageFingerprints, imageFingerprints);
    const storedImageReusable = storedImageResultIsReusable({
        previousEventCount: previous?.eventCount,
        previousFingerprints: previousImageFingerprints,
        currentFingerprints: imageFingerprints,
    });
    const visionImageUrls = [...new Set(imageFingerprints
        .map((item) => String(item?.url ?? '').trim())
        .filter((url) => /^https?:\/\//iu.test(url)))];
    const skipVisionReason = forceKnownMediaRefresh &&
        visionImageUrls.length > 0 &&
        typeof extractImageFactsWithAi === 'function'
        ? ''
        : visionSkipReason({
            textComplete,
            storedImageReusable,
            eligibleImageCount: visionImageUrls.length,
            hasVision: typeof extractImageFactsWithAi === 'function',
        });

    let enrichedPost = post;
    let imageFacts = String(post?.__posterGateFacts || '').trim();
    const needsMultiEventPosterMapping = Boolean(
        textOnlyLocalEvents.length > 1 &&
        visionImageUrls.length > 0 &&
        typeof extractImageFactsWithAi === 'function'
    );
    // V188.73: every source that is known to contain an event and media needs
    // explicit poster classification. Size/source membership is not enough.
    const needsEventPosterVerification = Boolean(
        textOnlyLocalEvents.length > 0 &&
        visionImageUrls.length > 0 &&
        typeof extractImageFactsWithAi === 'function'
    );
    const shouldRunVision = Boolean(
        !imageFacts && (
            needsEventPosterVerification ||
            needsMultiEventPosterMapping ||
            (!skipVisionReason && (forceKnownMediaRefresh || !exactKnownAnnouncementText || imageChanged))
        )
    );
    traceAi?.('media.inventory', {
        sourceUrl: post.sourceUrl,
        eventCandidates: textOnlyLocalEvents.length,
        imageCount: visionImageUrls.length,
        imageMedia: Array.isArray(post.imageMedia) ? post.imageMedia : [],
        domCandidateAudit: Array.isArray(post.imageCandidateAudit) ? post.imageCandidateAudit : [],
        visionImageUrls,
        imageFingerprints,
        needsEventPosterVerification,
        needsMultiEventPosterMapping,
        shouldRunVision,
        skipVisionReason,
    });
    if (needsMultiEventPosterMapping && shouldRunVision) {
        console.log(
            '[VK MULTI-EVENT POSTER VISION]',
            `post=${post.screenName}/${post.postId}`,
            `events=${textOnlyLocalEvents.length}`,
            `images=${visionImageUrls.length}`,
            'reason=child-poster-binding-required',
        );
    }
    if (shouldRunVision) {
        try {
            imageFacts = String(await runEventOperationWithRetries(
                () => extractImageFactsWithAi({
                    ...post,
                    imageUrls: visionImageUrls,
                    imageFingerprints,
                    __aiTrace: traceAi,
                }),
                {
                    label: `vk-public-vision:${post.screenName}/${post.postId}`,
                    maxAttempts: 1,
                    onAttemptError: ({ round, maxRounds, willRetry, delayMs, errorMessage }) => {
                        const row = { stage: 'vision', round, maxRounds, willRetry, delayMs, error: errorMessage };
                        retryTrace.push(row);
                        traceAi?.('vision.retry', row);
                        appendEventIngestAudit({
                            dataDirectory, sourceType: 'vk-public', sourceKey: post.screenName,
                            itemId: post.postId, sourceUrl: post.sourceUrl,
                            status: 'retry-error', reason: 'vision', rawText: post.text, details: row,
                        });
                    },
                    onRecovered: ({ round, maxRounds }) => {
                        const row = { stage: 'vision', recovered: true, round, maxRounds };
                        retryTrace.push(row);
                        traceAi?.('vision.recovered', row);
                        appendEventIngestAudit({
                            dataDirectory, sourceType: 'vk-public', sourceKey: post.screenName,
                            itemId: post.postId, sourceUrl: post.sourceUrl,
                            status: 'retry-recovered', reason: 'vision', rawText: post.text, details: row,
                        });
                    },
                },
            ) ?? '').trim();
        } catch (error) {
            console.error('[VK PUBLIC VISION ERROR]', `post=${post.screenName}/${post.postId}`, String(error?.message ?? error));
        }
    }
    if (!imageFacts && String(post?.__posterGateFacts || '').trim()) {
        imageFacts = String(post.__posterGateFacts).trim();
    }
    traceAi?.('vision.response', {
        sourceUrl: post.sourceUrl,
        imageCount: visionImageUrls.length,
        responseText: imageFacts,
        parsedFacts: parseIndexedImageFacts(imageFacts),
    });
    if (imageFacts) {
        enrichedPost = { ...post, text: [post.text, '[Факты с афиши]', imageFacts].filter(Boolean).join('\n\n') };
    }

    let parsedEvents = imageFacts
        ? parsePublicPostLocally({ text: enrichedPost.text, publishedAt: post.publishedAt, screenName: post.screenName })
            .map((event) => ({
                ...event,
                parseMethod: String(event.parseMethod ?? 'local').replace(/^local/u, 'vk_html_local'),
            }))
        : textOnlyLocalEvents;
    const localParsedCount = parsedEvents.length;

    const canCallAi = typeof extractEventsWithAi === 'function' &&
        (forceKnownMediaRefresh || !exactKnownAnnouncementText) &&
        (publicPostLooksLikeEventCandidate(enrichedPost) || Boolean(imageFacts));
    let aiRawCount = 0;
    let aiValidatedCount = 0;
    let aiError = '';
    if (canCallAi) {
        try {
            const aiEvents = await runEventOperationWithRetries(
                () => extractEventsWithAi({ ...enrichedPost, __aiTrace: traceAi }),
                {
                    label: `vk-public-ai:${post.screenName}/${post.postId}`,
                    maxAttempts: 1,
                    onAttemptError: ({ round, maxRounds, willRetry, delayMs, errorMessage }) => {
                        const row = { stage: 'ai-extraction', round, maxRounds, willRetry, delayMs, error: errorMessage };
                        retryTrace.push(row);
                        traceAi?.('text.retry', row);
                        appendEventIngestAudit({
                            dataDirectory, sourceType: 'vk-public', sourceKey: post.screenName,
                            itemId: post.postId, sourceUrl: post.sourceUrl,
                            status: 'retry-error', reason: 'ai-extraction', rawText: post.text, details: row,
                        });
                    },
                    onRecovered: ({ round, maxRounds }) => {
                        const row = { stage: 'ai-extraction', recovered: true, round, maxRounds };
                        retryTrace.push(row);
                        traceAi?.('text.recovered', row);
                        appendEventIngestAudit({
                            dataDirectory, sourceType: 'vk-public', sourceKey: post.screenName,
                            itemId: post.postId, sourceUrl: post.sourceUrl,
                            status: 'retry-recovered', reason: 'ai-extraction', rawText: post.text, details: row,
                        });
                    },
                },
            );
            aiRawCount = Array.isArray(aiEvents) ? aiEvents.length : 0;
            const validated = validatePublicAiEvents(aiEvents, enrichedPost)
                .map((event) => ({ ...event, parseMethod: `vk_html_${event.parseMethod || 'ai_validated'}` }));
            aiValidatedCount = validated.length;
            if (validated.length) {
                const localParsedCountBeforeAi = parsedEvents.length;
                // A valid AI response is authoritative for event cardinality.
                // The local parser is only a fallback when AI fails or returns
                // no valid events; keeping a richer local split here could
                // create extra cards that AI explicitly merged into one programme.
                parsedEvents = validated;
                traceAi?.('text.selection', {
                    reason: 'ai-authoritative-cardinality',
                    localParsedCount: localParsedCountBeforeAi,
                    aiValidatedCount: validated.length,
                });
            }
        } catch (error) {
            aiError = String(error?.message ?? error);
            console.error('[VK PUBLIC AI ERROR]', `post=${post.screenName}/${post.postId}`, aiError);
        }
    }

    const finalValidationSourceText = buildVkValidationSourceText({ ...post, text: enrichedPost.text });
    const rejectedEvents = [];
    const posterBindingAudit = [];
    let events = parsedEvents.filter((event) => {
        if (String(event?.eventDate ?? '') < todayIso) {
            rejectedEvents.push({ event, reason: 'event-date-before-today' });
            return false;
        }
        if (!isEventDateConsistentWithSource({
            eventDate: event?.eventDate,
            sourceText: enrichedPost.text,
            publishedAt: post.publishedAt,
            timeZone,
        })) {
            rejectedEvents.push({ event, reason: 'event-date-not-supported-by-source' });
            return false;
        }
        const strict = explainStrictEventRecord(event, { sourceText: finalValidationSourceText });
        if (!strict.ok) {
            rejectedEvents.push({ event, reason: `strict:${strict.reason}` });
            return false;
        }
        return true;
    });

    if (events.length) {
        events = attachVkChildSourceProvenance(events, post.eventLinks || post.links, {
            parentSourceUrl: post.sourceUrl,
            parentItemId: post.postId,
            maximum: 12,
        });
        events = assignEventImageIndexesFromFacts(events, imageFacts, {
            onAudit: ({ event, imageIndex, accepted, reason, score, imageType, poster, posterConfidence, textReadability, facts }) => {
                const eventLabel = `${event?.eventDate || '?'} ${String(event?.title || '').slice(0, 80)}`;
                const row = {
                    eventDate: event?.eventDate || '',
                    title: event?.title || '',
                    imageIndex,
                    accepted: Boolean(accepted),
                    reason,
                    score: Number(score || 0),
                    imageType: imageType || '',
                    poster,
                    posterConfidence,
                    textReadability,
                    facts: facts || null,
                };
                posterBindingAudit.push(row);
                console.log('[EVENT POSTER MATCH]', eventLabel, `image=${imageIndex || 'none'}`, accepted ? `accepted:${reason}` : `rejected:${reason}`, `score=${Number(score || 0)}`);
                traceAi?.('poster.binding', row);
            },
        });
        events = applyPosterDerivedVenueFallback(events);
        events = await prepareEventImages({
            events,
            sourceKey: post.screenName,
            itemId: post.postId,
            // Keep poster numbering identical between vision [IMAGE N] and
            // downloaded files; rejected DOM/API images must not shift indexes.
            imageUrls: visionImageUrls,
            dataDirectory,
            targetFolder: 'vk_announcements',
            sourceLabel: `VK vk.ru/${post.screenName}`,
            notifyAttention,
            allowBrowserFallback: !manualRun,
            shareSourceImagesAcrossEvents: true,
        });
        events = filterEventsWithAnnouncementImages(events, {
            onRejected: (event, reason) => rejectedEvents.push({ event, reason }),
        });
    }

    let storedMediaRepairCandidates = [];
    if (
        forceKnownMediaRefresh &&
        storedEventsBefore.length > 0 &&
        events.length < storedEventsBefore.length &&
        visionImageUrls.length > 0
    ) {
        let mappedStoredEvents = assignEventImageIndexesFromFacts(storedEventsBefore, imageFacts);
        mappedStoredEvents = await prepareEventImages({
            events: mappedStoredEvents,
            sourceKey: post.screenName,
            itemId: post.postId,
            imageUrls: visionImageUrls,
            dataDirectory,
            targetFolder: 'vk_announcements',
            sourceLabel: `VK vk.ru/${post.screenName}`,
            notifyAttention,
            allowBrowserFallback: !manualRun,
            shareSourceImagesAcrossEvents: true,
        });
        storedMediaRepairCandidates = mappedStoredEvents.filter((event) => (
            Array.isArray(event?.imagePaths) && event.imagePaths.length > 0
        ));
        console.log(
            '[VK EVENT STORED MEDIA REPAIR]',
            `post=${post.screenName}/${post.postId}`,
            `stored=${storedEventsBefore.length}`,
            `mapped=${storedMediaRepairCandidates.length}`,
            `freshEvents=${events.length}`,
        );
    }

    const previousImagePaths = removeKnownUiImagePaths(
        parseStoredStringArray(previous?.imagePathsJson),
        { dataDirectory, rejectedHashes: rejectedStoredUiHashes },
    );
    const newImagePaths = [...new Set(events.flatMap((event) => (
        Array.isArray(event?._sourceImagePaths) && event._sourceImagePaths.length
            ? event._sourceImagePaths
            : event?.imagePaths ?? []
    )))];
    const preserveStoredEvents = shouldPreserveStoredEventsOnEmptyReparse({
        previousEventCount: previous?.eventCount,
        acceptedEventCount: events.length,
    });
    /*
     * Parser-all is also a repair pass. If an old post already produced N
     * events, a transient/partial AI reparse that only recovers <N events must
     * never delete the unmatched rows. Instead update only confidently matched
     * events (including their fresh poster) and keep the rest intact.
     *
     * If the new pass discovers >= the stored count, replacing the post is
     * intentional: this is how old "digest collapsed into one event" rows are
     * expanded into the full multi-announcement schedule.
     */
    const protectPartialKnownRefresh = Boolean(
        forceKnownMediaRefresh &&
        storedEventsBefore.length > 0 &&
        events.length > 0 &&
        events.length < storedEventsBefore.length
    );
    const imagePaths = preserveStoredEvents ? previousImagePaths : newImagePaths;
    const effectiveEventCount = preserveStoredEvents
        ? Number(previous.eventCount)
        : protectPartialKnownRefresh
            ? storedEventsBefore.length
            : events.length;
    const fetchedAt = Math.floor(Date.now() / 1000);
    const sourceMediaAudit = buildVkEventMediaAudit({
        post,
        visionImageUrls,
        imageFingerprints,
        imageFacts,
        events: events.length ? events : storedMediaRepairCandidates,
        posterBindingAudit,
    });
    traceAi?.('media.audit', {
        sourceUrl: post.sourceUrl,
        postId: post.postId,
        media: sourceMediaAudit,
        eventResults: events.map((event) => ({
            eventDate: event?.eventDate || '',
            title: event?.title || '',
            posterImageIndex: Number(event?.posterImageIndex || 0),
            posterMatchStatus: event?.posterMatchStatus || '',
            posterMatchReason: event?.posterMatchReason || '',
            imagePaths: Array.isArray(event?.imagePaths) ? event.imagePaths : [],
        })),
    });

    traceAi?.('forensics.before-db-write', {
        post, previous, previousEvents: originalStoredEvents, events, parsedEvents, rejectedEvents,
        posterBindingAudit, sourceMediaAudit, imagePaths, imageFacts: parseIndexedImageFacts(imageFacts),
        decision: { preserveStoredEvents, protectPartialKnownRefresh, effectiveEventCount, forceKnownMediaRefresh },
    });
    const candidate = publicPostLooksLikeEventCandidate(enrichedPost) || Boolean(imageFacts);
    const ledgerToCommit = ledgerContext &&
        !(candidate && canCallAi && aiError && !effectiveEventCount)
        ? { ...ledgerContext, parseStatus: effectiveEventCount > 0 ? 'processed_event' : 'processed_not_event' }
        : null;
    let databaseWriteMode = preserveStoredEvents ? 'preserve-empty-reparse' : 'replace';
    let mediaRefreshMatched = 0;
    await runEventOperationWithRetries(() => persistVkSourceAndEvents({
        source: {
            screenName: post.screenName,
            ownerId: post.ownerId,
            postId: post.postId,
            sourceUrl: post.sourceUrl,
            publishedAt: post.publishedAt,
            rawText: post.text,
            imageUrls: post.imageUrls,
            imagePaths,
            // V188.73: persist the complete media decision audit in the same
            // source row: DOM identity -> local file -> vision facts -> binding.
            imageMedia: sourceMediaAudit.length ? sourceMediaAudit : (Array.isArray(post.imageMedia) ? post.imageMedia : []),
            contentHash,
            textFingerprint,
            imageFingerprints,
            imageVisionFacts: parseIndexedImageFacts(imageFacts),
            parseStatus: effectiveEventCount ? 'event' : 'not_event',
            fetchedAt,
        },
        ledger: ledgerToCommit,
        replacement: !preserveStoredEvents && !protectPartialKnownRefresh ? {
            screenName: post.screenName,
            postId: post.postId,
            sourceUrl: post.sourceUrl,
            imagePaths,
            events,
            updatedAt: fetchedAt,
        } : null,
        updateEvents: () => {
            if (forceKnownMediaRefresh && (preserveStoredEvents || protectPartialKnownRefresh)) {
                for (const stored of storedEventsBefore) {
                    const repair = selectFreshEventForStoredEvent(stored, storedMediaRepairCandidates);
                    if (repair?.imagePaths?.length) {
                        const merged = mergeStoredEventWithFreshSource(stored, repair, {
                            sourceUrl: post.sourceUrl,
                            parseMethod: 'parser_all_media_refresh_v18861',
                        });
                        mediaRefreshMatched += updateStoredEventRecordFromReparse({
                            sourceType: 'vk', id: stored.id, event: merged, updatedAt: fetchedAt,
                        });
                    } else if (stored?._hadRejectedUiImage) {
                        mediaRefreshMatched += updateStoredEventRecordFromReparse({
                            sourceType: 'vk', id: stored.id,
                            event: {
                                ...stored,
                                sourceUrl: post.sourceUrl,
                                parseMethod: 'parser_all_remove_vk_ui_image_v18861',
                            },
                            updatedAt: fetchedAt,
                        });
                    }
                }
            }
            if (!preserveStoredEvents && protectPartialKnownRefresh) {
                databaseWriteMode = 'merge-partial-media-refresh';
                for (const stored of storedEventsBefore) {
                    const selected = selectFreshEventForStoredEvent(stored, events);
                    if (!selected || !Array.isArray(selected?.imagePaths) || !selected.imagePaths.length) continue;
                    const merged = mergeStoredEventWithFreshSource(stored, selected, {
                        sourceUrl: post.sourceUrl,
                        parseMethod: 'parser_all_media_refresh_v18861',
                    });
                    mediaRefreshMatched += updateStoredEventRecordFromReparse({
                        sourceType: 'vk', id: stored.id, event: merged, updatedAt: fetchedAt,
                    });
                }
            }
        },
    }), { label: `vk-source-and-events-db:${post.screenName}/${post.postId}` });
    traceAi?.('forensics.after-db-write', {
        post, previous: getVkPostMeta({ screenName: post.screenName, postId: post.postId }),
        previousSource: previous,
        previousEvents: originalStoredEvents,
        events: getVkEventsForPostRefresh({ screenName: post.screenName, postId: post.postId }),
        decision: { databaseWriteMode, preserveStoredEvents, protectPartialKnownRefresh,
            effectiveEventCount, mediaRefreshMatched, imagePaths },
    });
    traceAi?.('database.write', {
        sourceTable: 'vk_source_posts',
        eventTable: 'vk_events',
        screenName: post.screenName,
        postId: post.postId,
        effectiveEventCount,
        acceptedEventCount: events.length,
        storedEventCountBefore: storedEventsBefore.length,
        forceKnownMediaRefresh,
        protectPartialKnownRefresh,
        mediaRefreshMatched,
        databaseWriteMode,
        preserveStoredEvents,
        imagePathCount: imagePaths.length,
        eventIds: events.map((event, index) => ({ index, date: event?.eventDate || '', title: String(event?.title || '').slice(0, 160) })),
    });

    appendEventIngestAudit({
        dataDirectory,
        sourceType: 'vk-public',
        sourceKey: post.screenName,
        itemId: post.postId,
        sourceUrl: post.sourceUrl,
        status: effectiveEventCount ? 'stored-event' : 'rejected-or-not-event',
        reason: preserveStoredEvents
            ? 'preserved-existing-events-after-empty-reparse'
            : effectiveEventCount
                ? 'stored-in-vk_events'
                : parsedEvents.length
                    ? 'parsed-events-rejected-by-final-validation'
                    : candidate
                        ? 'candidate-produced-no-events'
                        : 'not-an-event-candidate',
        rawText: post.text,
        details: {
            parserVersion: VK_PARSER_VERSION,
            publishedAt: Number(post.publishedAt ?? 0),
            originalPublishedAt,
            publishedAtSource: String(post.publishedAtSource ?? (originalPublishedAt > 0 ? 'browser-dom-or-api' : 'unknown')),
            imageCount: Array.isArray(post.imageUrls) ? post.imageUrls.length : 0,
            visionEligibleImageCount: visionImageUrls.length,
            rejectedVisionImages,
            textComplete,
            visionSkipReason: shouldRunVision ? '' : (skipVisionReason || (exactKnownAnnouncementText && !imageChanged ? 'exact-known-announcement' : '')),
            storedImageReusable,
            forceKnownMediaRefresh,
            storedEventCountBefore: storedEventsBefore.length,
            protectPartialKnownRefresh,
            mediaRefreshMatched,
            databaseWriteMode,
            preserveStoredEvents,
            imageFacts: Boolean(imageFacts),
            nearDuplicateText,
            imageChanged,
            candidate,
            aiEligible: canCallAi,
            aiRawCount,
            aiValidatedCount,
            aiError,
            localParsedCount,
            parsedCount: parsedEvents.length,
            acceptedCount: effectiveEventCount,
            rejectedEvents: rejectedEvents.map(({ event, reason }) => ({
                title: String(event?.title ?? ''),
                eventDate: String(event?.eventDate ?? ''),
                venue: String(event?.venue ?? ''),
                parseMethod: String(event?.parseMethod ?? ''),
                reason,
            })),
            retryTrace,
        },
    });

    return {
        changed: true,
        eventCount: effectiveEventCount,
        ledgerFinalized: Boolean(ledgerToCommit),
        eventsCreatedCount: storedEventsBefore.length > 0 ? 0 : effectiveEventCount,
        eventsUpdatedCount: storedEventsBefore.length > 0 ? effectiveEventCount : 0,
        candidate,
        visionCheckedImageCount: shouldRunVision ? visionImageUrls.length : 0,
        posterMatchAcceptedCount: posterBindingAudit.filter((item) => item?.accepted).length,
        posterMatchRejectedCount: posterBindingAudit.filter((item) => !item?.accepted).length,
        aiError,
        unresolved: Boolean(candidate && canCallAi && aiError && !effectiveEventCount),
    };
}

function startVkManualLiveParser({
    screenName,
    dataDirectory,
    downloadImages,
    extractEventsWithAi,
    extractImageFactsWithAi,
    notifyAttention,
    timeZone,
    hydratePostsWithApi,
}) {
    const page = keptManualPages.get(screenName);
    if (!page || page.isClosed()) return;
    const existing = manualLiveLoops.get(screenName);
    if (existing?.page === page) return;

    const token = { page, stopped: false };
    manualLiveLoops.set(screenName, token);
    const pollMs = clampInteger(process.env.VK_PUBLIC_MANUAL_LIVE_POLL_MS, 750, 10_000, 1800);

    const poll = async () => {
        if (token.stopped || page.isClosed() || manualLiveLoops.get(screenName) !== token) return;
        try {
            let posts = await extractRenderedVkPosts(page, screenName);
            if (typeof hydratePostsWithApi === 'function' && posts.length) {
                try {
                    const hydrated = await hydratePostsWithApi(posts.slice(0, 100));
                    if (Array.isArray(hydrated) && hydrated.length) posts = hydrated;
                } catch (error) {
                    console.warn('[VK MANUAL LIVE HYDRATION ERROR]', `source=${screenName}`, String(error?.message ?? error));
                }
            }
            posts = posts.sort((left, right) => left.postId - right.postId);
            let changedPosts = 0;
            let eventsFound = 0;
            for (const post of posts) {
                const result = await processPost(post, {
                    dataDirectory,
                    downloadImages,
                    extractEventsWithAi,
                    extractImageFactsWithAi,
                    notifyAttention,
                    timeZone,
                    manualRun: true,
                });
                if (result.changed) {
                    changedPosts += 1;
                    eventsFound += result.eventCount;
                }
            }
            if (changedPosts > 0) {
                const state = getVkScraperState(screenName);
                const lastPostId = Math.max(
                    Number(state?.lastPostId ?? 0),
                    ...posts.map((post) => Number(post.postId) || 0),
                    0,
                );
                const ownerId = posts.find((post) => post.ownerId)?.ownerId ?? Number(state?.ownerId ?? 0);
                const now = Math.floor(Date.now() / 1000);
                updateVkScraperState({
                    screenName,
                    ownerId,
                    lastPostId,
                    lastSuccessAt: now,
                    lastAttemptAt: now,
                    lastError: '',
                    initialCompleted: true,
                    postsSeen: Number(state?.postsSeen ?? 0) + changedPosts,
                    eventsFound: Number(state?.eventsFound ?? 0) + eventsFound,
                });
                console.log(
                    '[VK MANUAL SCROLL LIVE PARSER]',
                    `source=vk.ru/${screenName}`,
                    `changed=${changedPosts}`,
                    `events=${eventsFound}`,
                );
            }
        } catch (error) {
            if (!page.isClosed()) {
                console.warn('[VK MANUAL LIVE PARSER ERROR]', `source=${screenName}`, String(error?.message ?? error));
            }
        }
        const timer = setTimeout(poll, pollMs);
        timer.unref?.();
    };

    page.once('close', () => {
        token.stopped = true;
        if (manualLiveLoops.get(screenName) === token) manualLiveLoops.delete(screenName);
    });
    console.log('[VK MANUAL LIVE PARSER STARTED]', `source=vk.ru/${screenName}`, `pollMs=${pollMs}`);
    const timer = setTimeout(poll, pollMs);
    timer.unref?.();
}

export function createVkPublicScraper({
    screenName: screenNameInput,
    dataDirectory,
    initialPosts = 20,
    intervalHours = 24,
    downloadImages = true,
    extractEventsWithAi = null,
    extractImageFactsWithAi = null,
    notifyAttention = null,
    timeZone = 'Europe/Moscow',
    hydratePostsWithApi = null,
    snapshotEveryScroll = false,
    minimumPageLifetimeMs = 0,
    partyPool = 'primary',
} = {}) {
    const screenName = normalizeScreenName(screenNameInput || 'rb_diesel');
    const safeInitialPosts = clampInteger(initialPosts, 1, 20, 20);
    const intervalMs = clampInteger(
        Number(intervalHours) * 60 * 60 * 1000,
        60 * 60 * 1000,
        30 * ONE_DAY_MS,
        ONE_DAY_MS,
    );
    const safeDataDirectory = String(dataDirectory ?? '').trim();
    const secondaryMode = String(partyPool ?? '').trim().toLowerCase() === 'secondary';

    if (!safeDataDirectory) {
        throw new Error('Для VK HTML-парсера не указана папка data.');
    }

    async function run({
        forceInitial = false,
        refreshKnownMedia = false,
        keepPageOpen = false,
        deadlineAt = 0,
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
        singleOpenPerRun = false,
    } = {}) {
        if (activeRunPromises.has(screenName)) {
            return activeRunPromises.get(screenName);
        }

        let finiteSourcePage = null;
        const runPromise = (async () => {
            const startedAt = Math.floor(Date.now() / 1000);
            const sourceId = `vk:${screenName}`;
            const ledgerRunId = `${sourceId}:${startedAt}:${process.pid}`;
            const state = getVkScraperState(screenName);
            const databaseLooksEmpty = Number(state?.storedPosts ?? 0) === 0;
            const initialMode = forceInitial || !state?.initialCompleted || databaseLooksEmpty;
            let posts;
            try {
                const maxCaptureAttempts = (keepPageOpen || singleOpenPerRun)
                    ? 1
                    : clampInteger(process.env.VK_PUBLIC_CAPTURE_ATTEMPTS, 1, 3, 2);
                const recoveryScrollSteps = clampInteger(
                    process.env.VK_PUBLIC_RECOVERY_SCROLL_STEPS,
                    1,
                    20,
                    8,
                );
                const retryDelayMs = clampInteger(
                    process.env.VK_PUBLIC_CAPTURE_RETRY_DELAY_MS,
                    250,
                    15_000,
                    1500,
                );
                let lastCaptureError = null;

                for (let captureAttempt = 1; captureAttempt <= maxCaptureAttempts; captureAttempt += 1) {
                    try {
                        posts = initialMode
                            ? await collectInitialPosts({
                                screenName,
                                targetCount: safeInitialPosts,
                                dataDirectory: safeDataDirectory,
                                notifyAttention,
                                keepPageOpen,
                                deferClose: !keepPageOpen,
                                diagnostics,
                                recoveryScrollSteps: captureAttempt > 1 ? recoveryScrollSteps : 0,
                                snapshotEveryScroll: Boolean(snapshotEveryScroll),
                                minimumPageLifetimeMs: Math.max(0, Number(minimumPageLifetimeMs) || 0),
                            })
                            : await collectNewPosts({
                                screenName,
                                lastPostId: Number(state?.lastPostId ?? 0),
                                dataDirectory: safeDataDirectory,
                                notifyAttention,
                                keepPageOpen,
                                deferClose: !keepPageOpen,
                                diagnostics,
                                recoveryScrollSteps: captureAttempt > 1 ? recoveryScrollSteps : 0,
                                snapshotEveryScroll: Boolean(snapshotEveryScroll),
                                minimumPageLifetimeMs: Math.max(0, Number(minimumPageLifetimeMs) || 0),
                            });
                        if (captureAttempt > 1) {
                            diagnostics?.log?.('source.capture.retry-success', {
                                sourceId: `vk:${screenName}`,
                                attempt: captureAttempt,
                                maxAttempts: maxCaptureAttempts,
                                recoveryScrollSteps,
                            });
                        }
                        lastCaptureError = null;
                        break;
                    } catch (error) {
                        lastCaptureError = error;
                        diagnostics?.log?.('source.capture.retry-failure', {
                            sourceId: `vk:${screenName}`,
                            attempt: captureAttempt,
                            maxAttempts: maxCaptureAttempts,
                            willRetry: captureAttempt < maxCaptureAttempts,
                            error,
                        });
                        if (captureAttempt >= maxCaptureAttempts) throw error;
                        console.warn(
                            '[VK PUBLIC CAPTURE RETRY]',
                            `source=vk.ru/${screenName}`,
                            `attempt=${captureAttempt + 1}/${maxCaptureAttempts}`,
                            `recoveryScrollSteps=${recoveryScrollSteps}`,
                            String(error?.message ?? error).slice(0, 500),
                        );
                        await new Promise((resolveRetryDelay) => setTimeout(resolveRetryDelay, retryDelayMs));
                    }
                }

                if (!posts && lastCaptureError) throw lastCaptureError;
            } catch (captureError) {
                const domPath = String(captureError?.manualCaptureDomPath || '');
                const cachePath = diagnostics?.cacheSource?.({
                    sourceId,
                    kind: 'vk-public',
                    items: [],
                    metadata: {
                        screenName,
                        initialMode,
                        stoppedByOwner: false,
                        domPath,
                        captureError: String(captureError?.message ?? captureError).slice(0, 1000),
                    },
                }) || '';
                const parserReportPath = diagnostics?.saveParserReport?.({
                    sourceId,
                    kind: 'vk-public',
                    report: {
                        ...(captureError?.manualParserReport || {}),
                        domPath,
                        cachePath,
                        captureError: String(captureError?.message ?? captureError).slice(0, 1000),
                    },
                }) || '';
                await onCaptureComplete?.({
                    sourceId,
                    kind: 'vk-public',
                    itemCount: 0,
                    cachePath,
                    domPath,
                    parserReportPath,
                    error: String(captureError?.message ?? captureError).slice(0, 1000),
                    prefilterStats: { structuralCandidateCount: 0, databaseSkippedCount: 0, trashCount: 0, aiQueueCount: 0 },
                    candidatePreviews: [],
                });
                throw captureError;
            }

            finiteSourcePage = !keepPageOpen ? posts?.sourcePage : null;
            const capturedFullDomHtml = String(posts?.fullDomHtml || '');
            const capturedSnapshotExactCount = Number(posts?.snapshotExactCount || 0);
            const stoppedByOwner = Boolean(posts?.stoppedByOwner);

            if (!posts.length) {
                if (stoppedByOwner) {
                    const sourceId = `vk:${screenName}`;
                    const now = Math.floor(Date.now() / 1000);
                    const domPath = capturedFullDomHtml
                        ? await diagnostics?.captureDomSnapshot?.({
                            sourceId,
                            html: capturedFullDomHtml,
                            label: 'capture-interrupted',
                            metadata: {
                                phase: 'last-known-full-dom',
                                stoppedByOwner: true,
                                itemCount: 0,
                            },
                        }) || ''
                        : '';
                    const cachePath = diagnostics?.cacheSource?.({
                        sourceId,
                        kind: 'vk-public',
                        items: [],
                        metadata: {
                            screenName,
                            initialMode,
                            stoppedByOwner: true,
                            domPath,
                            captureError: 'browser-target-closed-before-posts-finalized',
                        },
                    }) || '';
                    const parserReportPath = diagnostics?.saveParserReport?.({
                        sourceId,
                        kind: 'vk-public',
                        report: {
                            ...(posts?.parserReport || {}),
                            domPath,
                            cachePath,
                            exactNotRunReason: 'browser-target-closed-before-final-exact',
                        },
                    }) || '';
                    await onCaptureComplete?.({
                        sourceId,
                        kind: 'vk-public',
                        itemCount: 0,
                        cachePath,
                        domPath,
                        parserReportPath,
                        error: 'browser-target-closed-before-posts-finalized',
                        prefilterStats: { structuralCandidateCount: 0, databaseSkippedCount: 0, trashCount: 0, aiQueueCount: 0 },
                        candidatePreviews: [],
                    });
                    updateVkScraperState({
                        screenName,
                        ownerId: Number(state?.ownerId ?? 0),
                        lastPostId: Number(state?.lastPostId ?? 0),
                        lastSuccessAt: Number(state?.lastSuccessAt ?? 0),
                        lastAttemptAt: now,
                        lastError: '',
                        initialCompleted: Boolean(state?.initialCompleted),
                        postsSeen: Number(state?.postsSeen ?? 0),
                        eventsFound: Number(state?.eventsFound ?? 0),
                    });
                    return {
                        screenName,
                        mode: initialMode ? 'initial' : 'daily',
                        fetchedPosts: 0,
                        changedPosts: 0,
                        eventsFound: 0,
                        lastPostId: Number(state?.lastPostId ?? 0),
                        stoppedByOwner: true,
                    };
                }
                throw new Error(`VK HTML не вернул публикации vk.ru/${screenName}.`);
            }

            for (const post of posts) {
                diagnostics?.recordPosterPost?.('vk.dom-post-captured', {
                    sourceId, itemId: String(post?.postId ?? ''), post,
                    previous: getVkPostMeta({ screenName, postId: post?.postId }),
                    previousEvents: getVkEventsForPostRefresh({ screenName, postId: post?.postId }),
                    phase: 'browser-dom-before-optional-api-hydration',
                });
            }
            if (typeof hydratePostsWithApi === 'function') {
                try {
                    const hydrated = await hydratePostsWithApi(posts.slice(0, 20));
                    if (Array.isArray(hydrated) && hydrated.length) posts = hydrated.slice(0, 20);
                } catch (error) {
                    console.warn(
                        '[VK PUBLIC API MEDIA HYDRATION ERROR]',
                        `source=vk.ru/${screenName}`,
                        String(error?.message ?? error),
                    );
                }
            }

            const orderedPosts = [...posts].sort((left, right) => left.postId - right.postId);
            for (const post of orderedPosts) {
                diagnostics?.recordPosterPost?.('vk.post-after-hydration', {
                    sourceId, itemId: String(post?.postId ?? ''), post,
                    previous: getVkPostMeta({ screenName, postId: post?.postId }),
                    previousEvents: getVkEventsForPostRefresh({ screenName, postId: post?.postId }),
                });
            }
            const candidateDecisions = new Map();
            const candidateIds = new Set();
            const posterGateRequests = [];
            let structuralCandidateCount = 0;
            let databaseSkippedCount = 0;
            let databaseRefreshCount = 0;
            let aiRejectedCount = 0;
            let trashCount = 0;
            let incrementalKnownSkippedCount = 0;
            let incrementalNewCount = 0;
            for (const post of orderedPosts) {
                const itemId = String(post?.postId ?? '');
                const ledgerBefore = getManualParserSeenItem({ sourceId, itemId });
                const rawContentHash = hashPost(post);
                // Same source+post ID, completed status and identical captured
                // content. Never skip an edited date or a newly observed poster.
                const incrementalKnown = shouldSkipUnchangedCapturedItem({
                    incrementalOnly,
                    previous: ledgerBefore,
                    contentHash: rawContentHash,
                    isFinalStatus: isManualParserSeenItemFinalStatus,
                });
                upsertManualParserSeenItem({
                    sourceId, sourceKind: 'vk-public', itemId,
                    sourceUrl: String(post?.sourceUrl || ''),
                    observedAt: Number(post?.publishedAt || 0),
                    rawText: String(post?.text || ''),
                    attachments: Array.isArray(post?.imageUrls) ? post.imageUrls : [],
                    contentHash: rawContentHash,
                    parseStatus: incrementalKnown ? String(ledgerBefore.parseStatus) : 'captured',
                });
                if (incrementalKnown) incrementalKnownSkippedCount += 1;
                else incrementalNewCount += 1;
                const secondaryTextGate = !incrementalKnown && secondaryMode
                    ? explainSecondaryPartyTextGate({
                        text: String(post?.text || ''),
                        publishedAt: Number(post?.publishedAt || 0),
                        referenceNow: post?.referenceNow,
                        timeZone,
                    })
                    : null;
                const decision = incrementalKnown
                    ? { candidate: false, aiEligible: false, score: -1000, reasons: ['clean-mode-content-hash-known'], evidence: { contentHashMatched: true }, aiAdmission: { rejectionReason: 'clean-mode-content-hash-known', dateSource: 'not-evaluated', contentHashMatched: true } }
                    : secondaryMode
                        ? {
                            candidate: Boolean(secondaryTextGate?.visionEligible),
                            aiEligible: false,
                            score: Number(secondaryTextGate?.eventIntentConfidence || 0) + Number(secondaryTextGate?.titleConfidence || 0),
                            reasons: [secondaryTextGate?.route || 'blocked', ...(secondaryTextGate?.eventIntentReasons || [])],
                            evidence: secondaryTextGate || {},
                            aiAdmission: {
                                eligible: false,
                                admissionPath: 'secondary-text-pre-gate',
                                rejectionReason: secondaryTextGate?.visionEligible ? 'awaiting-joint-text-image-ai' : secondaryTextGate?.rejectionReason || 'secondary-pre-ai-gate-rejected',
                                dateSource: 'semantic-post-text-only',
                                secondaryTextGate,
                            },
                        }
                        : explainPublicPostEventCandidate(post);
                if (decision.candidate) structuralCandidateCount += 1;
                const existingEvidence = decision.candidate
                    ? findExistingAnnouncementEvidence({ rawText: post?.text, sourceUrl: post?.sourceUrl })
                    : null;
                // Full secondary reparse is intentionally exhaustive: retain the
                // previous DB match for audit, but never let it suppress processing.
                const existing = (secondaryMode || (incrementalOnly && !incrementalKnown))
                    ? null : existingEvidence;
                const sourceOwnedExisting = Boolean(
                    existingEvidence &&
                    existingEvidence.sourceType === 'vk-public' &&
                    existingEvidence.sourceKey === String(screenName) &&
                    existingEvidence.itemId === itemId
                );
                const hasCurrentPosterCandidate = Array.isArray(post?.imageUrls) &&
                    post.imageUrls.some((value) => {
                        const url = String(value ?? '').trim();
                        return /^https?:\/\//iu.test(url) && !isLikelyVkNonPosterUiImageUrl(url);
                    });
                /*
                 * V188.60: explicit manual parser runs are repair passes, not
                 * merely "new event" scans. A DB-known VK post with current
                 * poster media must go through vision again so a stale avatar
                 * or missing image can be replaced.
                 */
                const refreshKnownMediaCandidate = Boolean(
                    refreshKnownMedia &&
                    sourceOwnedExisting &&
                    decision.aiEligible
                );
                if (existing && !refreshKnownMediaCandidate) databaseSkippedCount += 1;
                if (refreshKnownMediaCandidate) databaseRefreshCount += 1;
                if (decision.candidate && !decision.aiEligible && !secondaryMode) aiRejectedCount += 1;
                if (!decision.candidate && !incrementalKnown) trashCount += 1;
                const aiCandidate = secondaryMode
                    ? false
                    : Boolean(
                        refreshKnownMediaCandidate ||
                        (decision.aiEligible && !existing)
                    );
                const priority = (aiCandidate || (secondaryMode && secondaryTextGate?.visionEligible)) ? decision.score : -1000;
                const posterGateImageUrls = [...new Set((Array.isArray(post?.imageUrls) ? post.imageUrls : [])
                    .map((value) => String(value ?? '').trim())
                    .filter((url) => /^https?:\/\//iu.test(url) && !isLikelyVkNonPosterUiImageUrl(url)))]
                    .slice(0, 12);
                const posterGatePending = secondaryMode
                    ? Boolean(!incrementalKnown && secondaryTextGate?.visionEligible && !existing && posterGateImageUrls.length)
                    : Boolean(
                        !incrementalKnown &&
                        !decision.aiEligible &&
                        posterGateImageUrls.length &&
                        (!existing || (refreshKnownMedia && sourceOwnedExisting))
                    );
                candidateDecisions.set(itemId, {
                    ...decision,
                    existing,
                    existingEvidence,
                    sourceOwnedExisting,
                    refreshKnownMediaCandidate,
                    aiCandidate,
                    priority,
                    bodyAiEligible: Boolean(decision.aiEligible),
                    posterGatePending,
                    posterGateImageUrls,
                    incrementalKnown,
                    ledgerBefore,
                    secondaryTextGate,
                });
                if (posterGatePending) {
                    posterGateRequests.push({
                        itemId,
                        source: `vk.ru/${screenName}`,
                        sourceUrl: String(post?.sourceUrl || ''),
                        imageUrls: posterGateImageUrls,
                        priority: Number(decision.score || 0),
                        score: Number(decision.score || 0),
                        preview: parserCandidatePreview(post?.text),
                        sourceText: String(post?.text || ''),
                        secondaryJointGate: secondaryMode,
                        secondaryTextGate,
                    });
                }
                if (aiCandidate) candidateIds.add(itemId);
                diagnostics?.recordPosterPost?.('vk.prefilter-decision', {
                    sourceId, itemId, post, decision: candidateDecisions.get(itemId),
                    previous: getVkPostMeta({ screenName, postId: post?.postId }),
                    previousEvents: getVkEventsForPostRefresh({ screenName, postId: post?.postId }),
                });
                diagnostics?.log?.('item.prefilter', {
                    sourceId,
                    itemId,
                    parserPass: String(post?.parserPass || post?.parseMethod || ''),
                    candidate: decision.candidate,
                    aiEligible: decision.aiEligible,
                    aiCandidate,
                    aiAdmission: decision.aiAdmission,
                    refreshKnownMediaCandidate,
                    score: decision.score,
                    priority,
                    reasons: decision.reasons,
                    evidence: decision.evidence,
                    databaseMatch: existingEvidence,
                    incrementalOnly: Boolean(incrementalOnly),
                    incrementalKnown,
                    incrementalHashMatched: incrementalKnown,
                    secondaryTextGate,
                    semanticBodyText: String(post?.text || ''),
                    domAudit: post?.domAudit || null,
                    preview: parserCandidatePreview(post?.text),
                });
            }

            const linkEnrichmentCandidates = orderedPosts.filter((post) => {
                const decision = candidateDecisions.get(String(post?.postId ?? '')) || {};
                return Boolean(
                    decision.candidate &&
                    !decision.incrementalKnown &&
                    (!decision.existing || decision.refreshKnownMediaCandidate)
                );
            });
            const linkEnrichment = linkEnrichmentCandidates.length
                ? await captureBoundedLinkedVkSourcesForPosts(linkEnrichmentCandidates, {
                    screenName,
                    dataDirectory: safeDataDirectory,
                    notifyAttention,
                    maximumPerParent: 12,
                    maximumPerRun: 36,
                })
                : { opened: 0, visited: 0 };
            diagnostics?.log?.('source.link-enrichment', {
                sourceId,
                candidateCount: linkEnrichmentCandidates.length,
                opened: Number(linkEnrichment?.opened || 0),
                visited: Number(linkEnrichment?.visited || 0),
                depth: 1,
                maximumPerParent: 12,
            });

            const domPath = String(posts?.captureDomPath || '') || await diagnostics?.captureDomSnapshot?.({
                sourceId,
                page: finiteSourcePage,
                html: capturedFullDomHtml || null,
                label: 'capture-complete',
                metadata: {
                    phase: 'fallback-after-exact',
                    itemCount: orderedPosts.length,
                    snapshotExactCount: capturedSnapshotExactCount,
                },
            });
            const cachePath = diagnostics?.cacheSource?.({
                sourceId,
                kind: 'vk-public',
                items: orderedPosts,
                metadata: {
                    screenName,
                    initialMode,
                    stoppedByOwner,
                    domPath,
                },
            }) || '';
            const parserReportPath = diagnostics?.saveParserReport?.({
                sourceId,
                kind: 'vk-public',
                report: {
                    ...(posts?.parserReport || {}),
                    domPath,
                    cachePath,
                    itemCount: orderedPosts.length,
                    snapshotExactCount: capturedSnapshotExactCount,
                    prefilter: orderedPosts.map((post) => {
                        const itemId = String(post?.postId ?? '');
                        const decision = candidateDecisions.get(itemId) || {};
                        return {
                            itemId,
                            parserPass: String(post?.parserPass || post?.parseMethod || ''),
                            candidate: Boolean(decision.candidate),
                            aiEligible: Boolean(decision.aiEligible),
                            aiCandidate: Boolean(decision.aiCandidate),
                            aiAdmission: decision.aiAdmission || null,
                            refreshKnownMediaCandidate: Boolean(decision.refreshKnownMediaCandidate),
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
                kind: 'vk-public',
                itemCount: orderedPosts.length,
                cachePath,
                domPath,
                parserReportPath,
                prefilterStats: {
                    structuralCandidateCount,
                    databaseSkippedCount,
                    databaseRefreshCount,
                    aiRejectedCount,
                    trashCount,
                    aiQueueCount: candidateIds.size,
                    posterGatePendingCount: posterGateRequests.length,
                    incrementalKnownSkippedCount,
                    incrementalNewCount,
                    linkEnrichmentOpened: Number(linkEnrichment?.opened || 0),
                    linkEnrichmentVisited: Number(linkEnrichment?.visited || 0),
                },
                posterGateRequests,
                candidatePreviews: orderedPosts
                    .filter((post) => candidateIds.has(String(post.postId)))
                    .map((post) => {
                        const itemId = String(post.postId);
                        const decision = candidateDecisions.get(itemId) || {};
                        return {
                            itemId,
                            source: `vk.ru/${screenName}`,
                            sourceUrl: String(post?.sourceUrl || ''),
                            preview: parserCandidatePreview(post.text),
                            priority: Number(decision.priority || 0),
                            score: Number(decision.score || 0),
                            reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                            aiAdmission: decision.aiAdmission || null,
                            refreshKnownMediaCandidate: Boolean(decision.refreshKnownMediaCandidate),
                        };
                    }),
                prefilterPreviews: orderedPosts.map((post) => {
                    const itemId = String(post?.postId ?? '');
                    const decision = candidateDecisions.get(itemId) || {};
                    return {
                        itemId,
                        source: `vk.ru/${screenName}`,
                        sourceUrl: String(post?.sourceUrl || ''),
                        preview: parserCandidatePreview(post?.text),
                        candidate: Boolean(decision.candidate),
                        aiEligible: Boolean(decision.aiEligible),
                        aiCandidate: Boolean(decision.aiCandidate),
                        refreshKnownMediaCandidate: Boolean(decision.refreshKnownMediaCandidate),
                        reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                        aiAdmission: decision.aiAdmission || null,
                        databaseMatch: decision.existing || null,
                        incrementalKnown: Boolean(decision.incrementalKnown),
                    };
                }),
            });

            // Browser phase is finished as soon as the raw DOM/posts are cached.
            // Processing must not keep Chromium alive and starts only after the
            // parser-all capture barrier is released by the caller.
            if (!keepPageOpen && finiteSourcePage && !finiteSourcePage.isClosed()) {
                await finiteSourcePage.close().catch(() => {});
                finiteSourcePage = null;
                console.log('[VK SCRAPER SOURCE TAB CLOSED AFTER CACHE]', `source=vk.ru/${screenName}`);
            }
            if (posterGateGate && typeof posterGateGate.then === 'function') {
                await posterGateGate;
            }

            let posterGateCheckedCount = 0;
            let posterGateRescuedCount = 0;
            candidateIds.clear();
            structuralCandidateCount = 0;
            databaseSkippedCount = 0;
            databaseRefreshCount = 0;
            aiRejectedCount = 0;
            trashCount = 0;
            for (const post of orderedPosts) {
                const itemId = String(post?.postId ?? '');
                const before = candidateDecisions.get(itemId) || {};
                const gate = !before.incrementalKnown && before.posterGatePending && typeof getPosterGateResult === 'function'
                    ? getPosterGateResult(sourceId, itemId)
                    : null;
                if (gate?.attempted) {
                    posterGateCheckedCount += 1;
                    post.__posterGateVisionAttempted = true;
                    post.__posterGateFacts = String(gate?.facts || '');
                    post.__posterGateError = String(gate?.error || '');
                }
                const secondaryTextGate = before.secondaryTextGate || null;
                const jointVisionAccepted = Boolean(
                    secondaryMode &&
                    secondaryTextGate?.visionEligible &&
                    gate?.attempted &&
                    secondaryJointVisionAccepted(gate?.facts)
                );
                if (secondaryMode) post.__secondaryJointVisionAccepted = jointVisionAccepted;
                const decision = before.incrementalKnown
                    ? { candidate: false, aiEligible: false, score: -1000, reasons: ['clean-mode-content-hash-known'], evidence: { contentHashMatched: true }, aiAdmission: { rejectionReason: 'clean-mode-content-hash-known', dateSource: 'not-evaluated', contentHashMatched: true } }
                    : secondaryMode
                        ? {
                            candidate: Boolean(secondaryTextGate?.visionEligible),
                            aiEligible: jointVisionAccepted,
                            score: Number(before.score || 0),
                            reasons: [
                                ...(Array.isArray(before.reasons) ? before.reasons : []),
                                jointVisionAccepted ? 'secondary-joint-text-image-ai-accepted' : 'secondary-joint-text-image-ai-rejected',
                            ],
                            evidence: {
                                ...(before.evidence || {}),
                                jointVisionAccepted,
                                posterGateAttempted: Boolean(gate?.attempted),
                            },
                            aiAdmission: {
                                eligible: jointVisionAccepted,
                                admissionPath: 'secondary-joint-text-image',
                                rejectionReason: jointVisionAccepted
                                    ? ''
                                    : !secondaryTextGate?.visionEligible
                                        ? secondaryTextGate?.rejectionReason || 'secondary-pre-ai-gate-rejected'
                                        : !before.posterGateImageUrls?.length
                                            ? 'no-source-media'
                                            : !gate?.attempted
                                                ? 'secondary-joint-vision-not-run'
                                                : 'secondary-joint-ai-rejected',
                                dateSource: 'semantic-post-text-only',
                                secondaryTextGate,
                                jointVisionAccepted,
                                posterVisionAttempted: Boolean(gate?.attempted),
                                posterVisionError: String(gate?.error || ''),
                                posterFacts: String(gate?.facts || ''),
                            },
                        }
                        : explainPublicPostEventCandidate(post);
                if (decision.candidate) structuralCandidateCount += 1;
                const existing = (incrementalOnly && !before.incrementalKnown)
                    ? null : (before.existing || null);
                const sourceOwnedExisting = Boolean(before.sourceOwnedExisting);
                const refreshKnownMediaCandidate = secondaryMode ? false : Boolean(
                    refreshKnownMedia && sourceOwnedExisting && decision.aiEligible
                );
                if (existing && !refreshKnownMediaCandidate) databaseSkippedCount += 1;
                if (refreshKnownMediaCandidate) databaseRefreshCount += 1;
                if (decision.candidate && !decision.aiEligible) aiRejectedCount += 1;
                if (!decision.candidate && !before.incrementalKnown) trashCount += 1;
                const aiCandidate = Boolean(refreshKnownMediaCandidate || (decision.aiEligible && !existing));
                const priority = aiCandidate ? Number(decision.score || 0) : -1000;
                if (secondaryMode && jointVisionAccepted) {
                    posterGateRescuedCount += 1;
                } else if (!secondaryMode && !before.bodyAiEligible && decision.aiEligible && decision?.aiAdmission?.dateSource === 'poster-vision') {
                    posterGateRescuedCount += 1;
                }
                candidateDecisions.set(itemId, {
                    ...before,
                    ...decision,
                    existing,
                    sourceOwnedExisting,
                    refreshKnownMediaCandidate,
                    aiCandidate,
                    priority,
                    jointVisionAccepted,
                });
                if (aiCandidate) candidateIds.add(itemId);
                diagnostics?.log?.('item.admission', {
                    sourceId,
                    itemId,
                    candidate: decision.candidate,
                    aiEligible: decision.aiEligible,
                    aiCandidate,
                    aiAdmission: decision.aiAdmission,
                    secondaryMode,
                    secondaryTextGate,
                    jointVisionAccepted,
                    posterGateAttempted: Boolean(gate?.attempted),
                    posterGateFacts: String(gate?.facts || ''),
                    posterGateError: String(gate?.error || ''),
                    semanticBodyText: String(post?.text || ''),
                    domAudit: post?.domAudit || null,
                    preview: parserCandidatePreview(post?.text),
                });
            }

            const finalCandidatePreviews = orderedPosts
                .filter((post) => candidateIds.has(String(post.postId)))
                .map((post) => {
                    const itemId = String(post.postId);
                    const decision = candidateDecisions.get(itemId) || {};
                    return {
                        itemId, source: `vk.ru/${screenName}`, sourceUrl: String(post?.sourceUrl || ''),
                        preview: parserCandidatePreview(post.text), priority: Number(decision.priority || 0),
                        score: Number(decision.score || 0), reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                        aiAdmission: decision.aiAdmission || null,
                        refreshKnownMediaCandidate: Boolean(decision.refreshKnownMediaCandidate),
                    };
                });
            const finalPrefilterPreviews = orderedPosts.map((post) => {
                const itemId = String(post?.postId ?? '');
                const decision = candidateDecisions.get(itemId) || {};
                return {
                    itemId, source: `vk.ru/${screenName}`, sourceUrl: String(post?.sourceUrl || ''),
                    preview: parserCandidatePreview(post?.text), candidate: Boolean(decision.candidate),
                    aiEligible: Boolean(decision.aiEligible), aiCandidate: Boolean(decision.aiCandidate),
                    refreshKnownMediaCandidate: Boolean(decision.refreshKnownMediaCandidate),
                    reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                    aiAdmission: decision.aiAdmission || null, databaseMatch: decision.existing || null,
                    posterGateAttempted: Boolean(post?.__posterGateVisionAttempted),
                    posterGateError: String(post?.__posterGateError || ''),
                    incrementalKnown: Boolean(decision.incrementalKnown),
                };
            });
            await onAdmissionComplete?.({
                sourceId, kind: 'vk-public', itemCount: orderedPosts.length, cachePath, domPath, parserReportPath,
                prefilterStats: { structuralCandidateCount, databaseSkippedCount, databaseRefreshCount, aiRejectedCount,
                    trashCount, aiQueueCount: candidateIds.size, posterGateCheckedCount, posterGateRescuedCount,
                    incrementalKnownSkippedCount, incrementalNewCount },
                candidatePreviews: finalCandidatePreviews, prefilterPreviews: finalPrefilterPreviews,
            });

            if (processingGate && typeof processingGate.then === 'function') {
                await processingGate;
            }
            diagnostics?.log?.('source.processing.start', {
                sourceId,
                itemCount: orderedPosts.length,
                candidateCount: candidateIds.size,
                structuralCandidateCount,
                databaseSkippedCount,
                databaseRefreshCount,
                aiRejectedCount,
                trashCount,
                concurrency: processingConcurrency,
            });

            let changedPosts = 0;
            let eventsFound = 0;
            let eventsCreatedCount = 0;
            let eventsUpdatedCount = 0;
            let visionCheckedImageCount = 0;
            let posterMatchAcceptedCount = 0;
            let posterMatchRejectedCount = 0;
            let processedPosts = 0;
            let processedLastPostId = Number(state?.lastPostId ?? 0);
            const processingPosts = orderedPosts
                .filter((post) => !incrementalOnly || !candidateDecisions.get(String(post?.postId ?? ''))?.incrementalKnown)
                .sort((left, right) => {
                const leftDecision = candidateDecisions.get(String(left?.postId ?? '')) || {};
                const rightDecision = candidateDecisions.get(String(right?.postId ?? '')) || {};
                return Number(rightDecision.priority ?? -1000) - Number(leftDecision.priority ?? -1000) ||
                    Number(right?.postId || 0) - Number(left?.postId || 0);
            });
            const processingResults = await runManualParserPoolUntilSettled(
                processingPosts,
                async (post) => {
                    const itemId = String(post.postId);
                    const candidate = candidateIds.has(itemId);
                    const decision = candidateDecisions.get(itemId) || {};
                    const recoveringLedger = Boolean(decision.ledgerBefore &&
                        !isManualParserSeenItemFinalStatus(decision.ledgerBefore.parseStatus));
                    markManualParserSeenItemProcessing({ sourceId, itemId, runId: ledgerRunId });
                    // An unavailable poster-gate is an unresolved technical state,
                    // never a confirmed decision that this source contains no event.
                    if (decision.posterGatePending && !decision.incrementalKnown &&
                        !decision.existing && (String(post?.__posterGateError ?? '').trim() ||
                        post?.__posterGateVisionAttempted !== true)) {
                        const error = new Error('Poster recognition unavailable; source event decision unresolved.');
                        error.code = 'POSTER_GATE_UNRESOLVED';
                        throw error;
                    }
                    let result;
                    if (!decision.aiCandidate) {
                        const skippedReason = decision.incrementalKnown
                            ? 'clean-mode-content-hash-known'
                            : decision.existing
                                ? 'database-known'
                                : String(decision?.aiAdmission?.rejectionReason || (decision.candidate ? 'strict-ai-gate-rejected' : 'prefilter-trash'));
                        result = { changed: false, eventCount: 0, candidate: false, skipped: skippedReason };
                        diagnostics?.recordPosterPost?.('vk.post-skipped', { sourceId, itemId, post,
                            previous: getVkPostMeta({ screenName, postId: post.postId }),
                            previousEvents: getVkEventsForPostRefresh({ screenName, postId: post.postId }),
                            decision: { ...decision, skippedReason },
                        });
                        finalizeManualParserSeenItem({
                            sourceId,
                            itemId,
                            runId: ledgerRunId,
                            parseStatus: decision.existing ? 'processed_existing' : 'processed_rejected',
                        });
                        diagnostics?.log?.('item.final-decision', {
                            sourceId,
                            itemId,
                            accepted: false,
                            parseStatus: decision.existing ? 'processed_existing' : 'processed_rejected',
                            reason: skippedReason,
                            semanticBodyText: String(post?.text || ''),
                            secondaryTextGate: decision?.secondaryTextGate || null,
                            jointVisionAccepted: Boolean(decision?.jointVisionAccepted),
                            aiAdmission: decision?.aiAdmission || null,
                            domAudit: post?.domAudit || null,
                        });
                    } else {
                        result = await processPost(post, {
                            dataDirectory: safeDataDirectory,
                            downloadImages: Boolean(downloadImages),
                            extractEventsWithAi,
                            extractImageFactsWithAi,
                            notifyAttention,
                            timeZone,
                            manualRun: keepPageOpen,
                            forceKnownMediaRefresh: Boolean(decision.refreshKnownMediaCandidate),
                            forceReprocess: recoveringLedger,
                            ledgerContext: { sourceId, itemId, runId: ledgerRunId },
                            traceAi: (stage, data = {}) => {
                                if (stage.startsWith('forensics.')) {
                                    diagnostics?.recordPosterPost?.(`vk.${stage}`, { sourceId, itemId, ...data });
                                } else {
                                    diagnostics?.log?.(`item.ai.${stage}`, {
                                        sourceId, itemId, preview: parserCandidatePreview(post?.text), ...data,
                                    });
                                }
                            },
                        });
                        if (!result?.unresolved) {
                            if (!result?.ledgerFinalized) finalizeManualParserSeenItem({
                                sourceId,
                                itemId,
                                runId: ledgerRunId,
                                parseStatus: Number(result?.eventCount || 0) > 0 ? 'processed_event' : 'processed_not_event',
                            });
                            diagnostics?.log?.('item.final-decision', {
                                sourceId,
                                itemId,
                                accepted: Number(result?.eventCount || 0) > 0,
                                parseStatus: Number(result?.eventCount || 0) > 0 ? 'processed_event' : 'processed_not_event',
                                reason: Number(result?.eventCount || 0) > 0 ? 'event-written' : 'main-ai-not-event',
                                eventCount: Number(result?.eventCount || 0),
                                semanticBodyText: String(post?.text || ''),
                                secondaryTextGate: decision?.secondaryTextGate || null,
                                jointVisionAccepted: Boolean(decision?.jointVisionAccepted),
                                aiAdmission: decision?.aiAdmission || null,
                                posterGateFacts: String(post?.__posterGateFacts || ''),
                                domAudit: post?.domAudit || null,
                            });
                        }
                    }
                    processedPosts += 1;
                    if (result.changed) {
                        changedPosts += 1;
                        eventsFound += result.eventCount;
                    }
                    visionCheckedImageCount += Number(result?.visionCheckedImageCount || 0);
                    posterMatchAcceptedCount += Number(result?.posterMatchAcceptedCount || 0);
                    posterMatchRejectedCount += Number(result?.posterMatchRejectedCount || 0);
                    eventsCreatedCount += Number(result?.eventsCreatedCount || 0);
                    eventsUpdatedCount += Number(result?.eventsUpdatedCount || 0);
                    processedLastPostId = Math.max(processedLastPostId, Number(post.postId ?? 0));
                    return { ...result, candidate };
                },
                {
                    concurrency: processingConcurrency,
                    limiter: processingLimiter,
                    getPriority: (post) => Number(candidateDecisions.get(String(post?.postId ?? ''))?.priority ?? -1000),
                    onItemState: async (event) => {
                        const itemId = String(event.item?.postId ?? '');
                        const candidate = candidateIds.has(itemId);
                        if (event.type === 'failed' || event.type === 'rejected' || event.error) {
                            diagnostics?.recordPosterPost?.('vk.post-processing-error', {
                                sourceId, itemId, post: event.item, error: event.error || null,
                                decision: candidateDecisions.get(itemId) || null,
                            });
                        }
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
                            kind: 'vk-public',
                            itemId,
                            source: `vk.ru/${screenName}`,
                            candidate,
                            priority: Number(event.priority || candidateDecisions.get(itemId)?.priority || 0),
                            reasons: candidateDecisions.get(itemId)?.reasons || [],
                            preview: parserCandidatePreview(event.item?.text),
                        });
                    },
                    isUnresolvedValue: (value, post) => (
                        candidateIds.has(String(post?.postId ?? '')) && Boolean(value?.unresolved)
                    ),
                    isRetryableFailure: (error, post) => (
                        candidateIds.has(String(post?.postId ?? '')) &&
                        /(?:gpt|ai|429|5\d\d|timeout|network|fetch|socket|abort)/iu.test(String(error?.message ?? error ?? ''))
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
                const post = processingPosts[index];
                markManualParserSeenItemFailed({
                    sourceId,
                    itemId: String(post?.postId ?? ''),
                    runId: ledgerRunId,
                    error: String(entry?.reason?.message ?? entry?.reason ?? ''),
                });
            });
            const failedProcessingItems = processingResults.filter((item) => item?.status === 'rejected').length;
            const timedOut = false;
            diagnostics?.log?.('source.processing.finish', {
                sourceId,
                processedPosts,
                changedPosts,
                eventsFound,
                failedProcessingItems,
            });

            const lastPostId = processedLastPostId;
            const ownerId = posts.find((post) => post.ownerId)?.ownerId ?? Number(state?.ownerId ?? 0);
            const finishedAt = Math.floor(Date.now() / 1000);

            updateVkScraperState({
                screenName,
                ownerId,
                lastPostId: failedProcessingItems === 0 && !timedOut
                    ? lastPostId : Number(state?.lastPostId ?? 0),
                // Partial processing cannot advance the success cursor: failed
                // items are retryable on the next pass and old events remain.
                lastSuccessAt: failedProcessingItems === 0 && !timedOut
                    ? finishedAt : Number(state?.lastSuccessAt ?? 0),
                lastAttemptAt: startedAt,
                lastError: failedProcessingItems > 0
                    ? `manual-parser-processing-failed:${failedProcessingItems}`
                    : timedOut ? 'manual-parser-deadline-reached' : '',
                initialCompleted: failedProcessingItems === 0 && !timedOut
                    ? true : Boolean(state?.initialCompleted),
                postsSeen: Number(state?.postsSeen ?? 0) + changedPosts,
                eventsFound: Number(state?.eventsFound ?? 0) + eventsFound,
            });

            console.log(
                '[VK HTML SCRAPER]',
                `source=vk.ru/${screenName}`,
                `mode=${initialMode ? 'initial' : 'daily'}`,
                `fetched=${posts.length}`,
                `changed=${changedPosts}`,
                `events=${eventsFound}`,
                `lastPostId=${lastPostId}`,
            );

            if (keepPageOpen && !stoppedByOwner) {
                startVkManualLiveParser({
                    screenName,
                    dataDirectory: safeDataDirectory,
                    downloadImages: Boolean(downloadImages),
                    extractEventsWithAi,
                    extractImageFactsWithAi,
                    notifyAttention,
                    timeZone,
                    hydratePostsWithApi,
                });
            }

            return {
                screenName,
                mode: initialMode ? 'initial' : 'daily',
                fetchedPosts: processedPosts,
                changedPosts,
                eventsFound,
                eventsCreatedCount,
                eventsUpdatedCount,
                visionCheckedImageCount,
                posterMatchAcceptedCount,
                posterMatchRejectedCount,
                databaseRefreshCount,
                incrementalKnownSkippedCount,
                incrementalNewCount,
                timedOut,
                lastPostId,
                stoppedByOwner,
                failedProcessingItems,
            };
        })();

        activeRunPromises.set(screenName, runPromise);

        try {
            return await runPromise;
        } catch (error) {
            const previous = getVkScraperState(screenName);
            const now = Math.floor(Date.now() / 1000);

            updateVkScraperState({
                screenName,
                ownerId: Number(previous?.ownerId ?? 0),
                lastPostId: Number(previous?.lastPostId ?? 0),
                lastSuccessAt: Number(previous?.lastSuccessAt ?? 0),
                lastAttemptAt: now,
                lastError: String(error?.message ?? error).slice(0, 2000),
                initialCompleted: Boolean(previous?.initialCompleted),
                postsSeen: Number(previous?.postsSeen ?? 0),
                eventsFound: Number(previous?.eventsFound ?? 0),
            });
            throw error;
        } finally {
            if (!keepPageOpen && finiteSourcePage && !finiteSourcePage.isClosed()) {
                await finiteSourcePage.close().catch(() => {});
                console.log('[VK SCRAPER SOURCE TAB CLOSED AFTER PROCESSING]', `source=vk.ru/${screenName}`);
            }
            activeRunPromises.delete(screenName);
        }
    }

    async function runIfDue() {
        const state = getVkScraperState(screenName);
        const lastSuccessAt = Number(state?.lastSuccessAt ?? 0) * 1000;
        const databaseLooksEmpty = Number(state?.storedPosts ?? 0) === 0;

        if (!state?.initialCompleted || databaseLooksEmpty || Date.now() - lastSuccessAt >= intervalMs) {
            return run({ forceInitial: !state?.initialCompleted || databaseLooksEmpty });
        }

        return null;
    }

    function start() {
        const firstTimer = setTimeout(() => {
            /*
             * На старте перечитываем настроенный первый проход. Это заменяет
             * старые записи, где в текст попали кнопки VK или датой события
             * ошибочно стал день подведения итогов конкурса.
             */
            run({ forceInitial: true }).catch((error) => {
                console.error('[VK HTML INITIAL ERROR]', String(error?.message ?? error));
            });
        }, 1_500);
        firstTimer.unref();

        const timer = setInterval(() => {
            runIfDue().catch((error) => {
                console.error('[VK HTML DAILY ERROR]', String(error?.message ?? error));
            });
        }, 60 * 60 * 1000);
        timer.unref();
        return timer;
    }

    function getStatus() {
        return getVkScraperState(screenName);
    }

    function getUpcoming(limit = 10) {
        return getVkUpcomingEvents({ screenName, limit });
    }

    return {
        screenName,
        initialPosts: safeInitialPosts,
        intervalHours: intervalMs / (60 * 60 * 1000),
        getStatus,
        getUpcoming,
        run,
        runIfDue,
        start,
    };
}
