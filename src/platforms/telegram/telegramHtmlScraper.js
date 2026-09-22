/**
 * Скрейпер публичных Telegram-каналов через браузер: читает посты, сохраняет источники и передаёт только строгие события.
 */
import {
    existsSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    extname,
    join,
} from 'node:path';

import {
    findExistingAnnouncementEvidence,
    finalizeManualParserSeenItem,
    getManualParserSeenItem,
    isManualParserSeenItemFinalStatus,
    markManualParserSeenItemFailed,
    markManualParserSeenItemProcessing,
    upsertManualParserSeenItem,
    getTelegramPostMeta,
    getTelegramScraperState,
    getTelegramUpcomingEvents,
    persistTelegramSourceAndEvents,
    updateTelegramScraperState,
} from '../../infrastructure/database/index.js';

import {
    browserDownloadBuffer,
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
    isScraperTargetClosedError,
} from '../../features/scrapers/browserRecoveryPolicy.js';

import {
    getManualParserProcessingConcurrency,
    parserCandidatePreview,
    runManualParserPool,
} from '../../features/scrapers/manualProcessingPool.js';

import {
    explainPublicPostEventCandidate,
    parsePublicPostLocally,
    publicPostLooksLikeEventCandidate,
    validatePublicAiEvents,
} from '../../features/events/publicPostLocalParser.js';

import {
    isEventDateConsistentWithSource,
} from '../../features/events/publicPostDateEvidence.js';

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
    runEventOperationWithRetries,
} from '../../features/events/eventRetry.js';

import {
    storedImageResultIsReusable,
    textEventsAreComplete,
    visionSkipReason,
} from '../../features/events/eventVisionPolicy.js';

import {
    createSourceTextFingerprint,
    fingerprintRemoteImages,
    imageFingerprintSetsEqual,
    parseImageFingerprints,
    sourceTextSimilarity,
} from '../../features/events/sourcePostFingerprint.js';

import {
    createStableSourceContentHash,
    sourceContentHashMatches,
} from '../../features/events/sourceContentHash.js';

import { shouldSkipUnchangedCapturedItem } from '../../features/scrapers/manualParserCleanSkip.js';

import {
    explainSecondaryPartyTextGate,
    secondaryJointVisionAccepted,
} from '../../features/events/secondaryPartyAdmission.js';

const DEFAULT_USER_AGENT = [
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
    'AppleWebKit/537.36 (KHTML, like Gecko)',
    'Chrome/126.0.0.0 Safari/537.36',
].join(' ');

const TELEGRAM_BASE_URL = 'https://t.me';
const TELEGRAM_PARSER_VERSION = 'telegram-playwright-v187-stable-content-hash';
const TELEGRAM_LEGACY_HASH_VERSIONS = Object.freeze([
    'telegram-playwright-v185-ingest-audit',
    'telegram-playwright-v186-five-pass-retry',
    'telegram-playwright-v186-five-round-token-safe-vision',
]);

export {
    explainPublicPostEventCandidate,
    parsePublicPostLocally,
    publicPostLooksLikeEventCandidate,
    validatePublicAiEvents,
} from '../../features/events/publicPostLocalParser.js';
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const MAX_HTML_BYTES = 5 * 1024 * 1024;
const MAX_IMAGE_BYTES = 12 * 1024 * 1024;
const MAX_IMAGES_PER_POST = 12;
const MAX_PAGES_PER_RUN = 30;

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
    return new Promise((resolve) => {
        setTimeout(resolve, milliseconds);
    });
}

function clampInteger(value, minimum, maximum, fallback) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return fallback;
    }

    return Math.min(
        maximum,
        Math.max(minimum, Math.trunc(number)),
    );
}

function normalizeChannel(value) {
    const source = String(value ?? '').trim();

    if (!source) {
        return '';
    }

    const match = source.match(
        /^(?:https?:\/\/)?(?:www\.)?t\.me\/(?:s\/)?([A-Za-z0-9_]{5,})\/?(?:\?.*)?$/iu,
    );

    const channel = match?.[1] ?? source.replace(/^@/u, '');

    if (!/^[A-Za-z0-9_]{5,}$/u.test(channel)) {
        throw new Error(`Некорректное имя Telegram-канала: ${source}`);
    }

    return channel;
}

function decodeHtmlEntities(value) {
    const named = {
        amp: '&',
        apos: "'",
        gt: '>',
        hellip: '…',
        laquo: '«',
        lt: '<',
        mdash: '—',
        middot: '·',
        nbsp: ' ',
        ndash: '–',
        quot: '"',
        raquo: '»',
        shy: '',
    };

    return String(value ?? '').replace(
        /&(#x?[0-9a-f]+|[a-z][a-z0-9]+);/giu,
        (entity, code) => {
            const lower = String(code).toLowerCase();

            if (lower.startsWith('#x')) {
                const point = Number.parseInt(lower.slice(2), 16);
                return Number.isFinite(point)
                    ? String.fromCodePoint(point)
                    : entity;
            }

            if (lower.startsWith('#')) {
                const point = Number.parseInt(lower.slice(1), 10);
                return Number.isFinite(point)
                    ? String.fromCodePoint(point)
                    : entity;
            }

            return Object.hasOwn(named, lower)
                ? named[lower]
                : entity;
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
            .replace(/<li\b[^>]*>/giu, '• ')
            .replace(/<[^>]+>/gu, ''),
    )
        .replace(/\u00a0/gu, ' ')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n[ \t]+/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

function getAttribute(tag, attributeName) {
    const pattern = new RegExp(
        `\\b${attributeName}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
        'iu',
    );
    const match = String(tag ?? '').match(pattern);
    return decodeHtmlEntities(match?.[1] ?? match?.[2] ?? '');
}

function splitMessageBlocks(html) {
    const source = String(html ?? '');
    const starts = [];
    const pattern = /<div\b[^>]*class=(?:"[^"]*\btgme_widget_message_wrap\b[^"]*"|'[^']*\btgme_widget_message_wrap\b[^']*')[^>]*>/giu;
    let match;

    while ((match = pattern.exec(source)) !== null) {
        starts.push(match.index);
    }

    return starts.map((start, index) => {
        const end = starts[index + 1] ?? source.length;
        return source.slice(start, end);
    });
}

function extractTextBlock(block) {
    const source = String(block ?? '');
    const startMatch = source.match(
        /<div\b[^>]*class=(?:"[^"]*\btgme_widget_message_text\b[^"]*"|'[^']*\btgme_widget_message_text\b[^']*')[^>]*>/iu,
    );

    if (!startMatch || startMatch.index === undefined) {
        return '';
    }

    const contentStart = startMatch.index + startMatch[0].length;
    const tail = source.slice(contentStart);
    const footerIndex = tail.search(
        /<div\b[^>]*class=(?:"[^"]*\btgme_widget_message_(?:footer|views|info)\b[^"]*"|'[^']*\btgme_widget_message_(?:footer|views|info)\b[^']*')[^>]*>/iu,
    );
    const content = footerIndex >= 0 ? tail.slice(0, footerIndex) : tail;

    return htmlToText(content);
}

function extractImageUrls(block) {
    const urls = [];
    const source = String(block ?? '');
    const pushUrl = (value) => {
        const url = decodeHtmlEntities(value).trim().replace(/^['"]|['"]$/gu, '');
        if (!/^https:\/\//iu.test(url) || urls.includes(url)) return;
        urls.push(url);
    };
    const tags = source.match(
        /<(?:a|div)\b[^>]*class=(?:"[^"]*\btgme_widget_message_(?:photo_wrap|video_thumb)\b[^"]*"|'[^']*\btgme_widget_message_(?:photo_wrap|video_thumb)\b[^']*')[^>]*>/giu,
    ) ?? [];

    for (const tag of tags) {
        const style = getAttribute(tag, 'style');
        const match = style.match(
            /background-image\s*:\s*url\((?:'([^']+)'|"([^"]+)"|([^\)]+))\)/iu,
        );
        pushUrl(match?.[1] ?? match?.[2] ?? match?.[3] ?? '');
        if (urls.length >= MAX_IMAGES_PER_POST) return urls.slice(0, MAX_IMAGES_PER_POST);
    }

    // Telegram occasionally changes the public widget from CSS background-image
    // to real <img>/<source> elements. Keep this as the second DOM contour so a
    // harmless markup change does not turn a fully loaded post into "no media".
    const mediaTags = source.match(/<(?:img|source)\b[^>]*>/giu) ?? [];
    for (const tag of mediaTags) {
        const srcset = getAttribute(tag, 'srcset') || getAttribute(tag, 'data-srcset');
        if (srcset) {
            const candidates = srcset.split(',')
                .map((part) => part.trim().split(/\s+/u)[0])
                .filter(Boolean);
            // srcset is normally ordered from smaller to larger variants.
            for (const candidate of candidates.reverse()) pushUrl(candidate);
        }
        pushUrl(getAttribute(tag, 'src') || getAttribute(tag, 'data-src'));
        if (urls.length >= MAX_IMAGES_PER_POST) break;
    }

    return urls.slice(0, MAX_IMAGES_PER_POST);
}

export function parseTelegramPublicHtml(html, expectedChannel) {
    const posts = [];

    for (const block of splitMessageBlocks(html)) {
        const dataPostMatch = block.match(
            /\bdata-post=(?:"([A-Za-z0-9_]+)\/(\d+)"|'([A-Za-z0-9_]+)\/(\d+)')/iu,
        );
        const channel = dataPostMatch?.[1] ?? dataPostMatch?.[3] ?? '';
        const messageId = Number(
            dataPostMatch?.[2] ?? dataPostMatch?.[4] ?? 0,
        );

        if (
            !messageId ||
            channel.toLowerCase() !== expectedChannel.toLowerCase()
        ) {
            continue;
        }

        const timeTag = block.match(/<time\b[^>]*>/iu)?.[0] ?? '';
        const datetime = getAttribute(timeTag, 'datetime');
        const publishedAt = Number.isFinite(Date.parse(datetime))
            ? Math.floor(Date.parse(datetime) / 1000)
            : 0;
        const text = extractTextBlock(block);
        const imageUrls = extractImageUrls(block);
        const sourceUrl = `${TELEGRAM_BASE_URL}/${channel}/${messageId}`;

        posts.push({
            channel,
            messageId,
            sourceUrl,
            publishedAt,
            text,
            imageUrls,
        });
    }

    const unique = new Map();

    for (const post of posts) {
        unique.set(post.messageId, post);
    }

    return [...unique.values()].sort(
        (left, right) => right.messageId - left.messageId,
    );
}


function hashPost(post) {
    return createStableSourceContentHash(post);
}

function guessImageExtension(contentType, url) {
    const type = String(contentType ?? '').toLowerCase();

    if (type.includes('png')) return '.png';
    if (type.includes('webp')) return '.webp';
    if (type.includes('gif')) return '.gif';
    if (type.includes('jpeg') || type.includes('jpg')) return '.jpg';

    const fromUrl = extname(new URL(url).pathname).toLowerCase();
    return /^\.(?:jpe?g|png|webp|gif)$/u.test(fromUrl)
        ? fromUrl.replace('.jpeg', '.jpg')
        : '.jpg';
}

async function readResponseBuffer(response, maximumBytes) {
    const length = Number(response.headers.get('content-length') ?? 0);

    if (length > maximumBytes) {
        throw new Error(`Ответ слишком большой: ${length} байт`);
    }

    const reader = response.body?.getReader();

    if (!reader) {
        const buffer = Buffer.from(await response.arrayBuffer());

        if (buffer.length > maximumBytes) {
            throw new Error(`Ответ слишком большой: ${buffer.length} байт`);
        }

        return buffer;
    }

    const chunks = [];
    let total = 0;

    while (true) {
        const { done, value } = await reader.read();

        if (done) {
            break;
        }

        total += value.byteLength;

        if (total > maximumBytes) {
            await reader.cancel();
            throw new Error(`Ответ превысил ${maximumBytes} байт`);
        }

        chunks.push(Buffer.from(value));
    }

    return Buffer.concat(chunks);
}

async function fetchWithTimeout(url, {
    timeoutMs = 30_000,
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

        const buffer = await readResponseBuffer(response, maximumBytes);

        return {
            buffer,
            contentType: response.headers.get('content-type') ?? '',
            finalUrl: response.url,
        };
    } finally {
        clearTimeout(timer);
    }
}

async function fetchHtmlPage({
    channel,
    beforeId = null,
    dataDirectory,
    notifyAttention,
    keepPageOpen = false,
    deferClose = false,
    diagnostics = null,
    snapshotEveryScroll = false,
    minimumPageLifetimeMs = 0,
}) {
    const url = new URL(`${TELEGRAM_BASE_URL}/s/${channel}`);

    if (beforeId) {
        url.searchParams.set('before', String(beforeId));
    }

    let page = null;
    let completedSuccessfully = false;
    let stoppedByOwner = false;
    let fallbackHtml = '';
    let openedAtMs = 0;
    let progressSnapshotSequence = 0;

    try {
        try {
            page = await openScraperPage({
                url: url.toString(),
                source: 'Telegram',
                dataDirectory,
                notifyAttention,
                reuseKey: (keepPageOpen || deferClose) ? `telegram-public:${channel}` : '',
            });
            openedAtMs = Date.now();
        } catch (error) {
            if (keepPageOpen && isScraperTargetClosedError(error)) {
                return { html: '', stoppedByOwner: true, page: null };
            }
            throw error;
        }

        try {
            await page.waitForSelector('.tgme_widget_message', {
                timeout: 30_000,
            }).catch(() => {});

            // Снимок до длинной прокрутки нужен как страховка: если владелец
            // закроет окно во время прохода, уже увиденные посты не теряются.
            fallbackHtml = await page.content().catch(() => '');

            const renderScrollSteps = clampInteger(
                process.env.TELEGRAM_HTML_RENDER_SCROLL_STEPS,
                0,
                50,
                10,
            );
            const mediaWaitMs = keepPageOpen
                ? clampInteger(
                    Number(process.env.TELEGRAM_MANUAL_MEDIA_WAIT_SECONDS) * 1000,
                    0,
                    10_000,
                    1500,
                )
                : clampInteger(
                    Number(process.env.TELEGRAM_HTML_MEDIA_WAIT_SECONDS) * 1000,
                    1000,
                    60_000,
                    10_000,
                );
            const pageHoldMs = keepPageOpen
                ? 0
                : clampInteger(
                    Number(process.env.TELEGRAM_HTML_PAGE_HOLD_SECONDS) * 1000,
                    180_000,
                    300_000,
                    180_000,
                );

            await settleScraperPage({
                page,
                source: `Telegram @${channel}`,
                scrollSteps: renderScrollSteps,
                scrollDelayMs: clampInteger(
                    process.env.TELEGRAM_HTML_RENDER_SCROLL_DELAY_MS,
                    300,
                    5000,
                    900,
                ),
                // История публичного Telegram читается от новых сообщений к старым.
                // Поэтому для догрузки архива двигаемся ВВЕРХ, а не вниз.
                scrollDirection: 'up',
                mediaWaitMs,
                holdMs: pageHoldMs,
                onScrollStep: (keepPageOpen || snapshotEveryScroll)
                    ? async () => {
                        fallbackHtml = await page.content().catch(() => fallbackHtml);
                        if (snapshotEveryScroll && fallbackHtml && diagnostics?.captureDomSnapshot) {
                            progressSnapshotSequence += 1;
                            await diagnostics.captureDomSnapshot({
                                sourceId: `tg:${channel}`,
                                page,
                                html: fallbackHtml,
                                label: `scroll-step-${String(progressSnapshotSequence).padStart(3, '0')}`,
                                metadata: {
                                    phase: 'progressive-scroll-capture',
                                    channel,
                                    beforeId,
                                    openedAtMs,
                                },
                            });
                        }
                    }
                    : null,
            });

            const requestedMinimumLifetimeMs = Math.max(0, Number(minimumPageLifetimeMs) || 0);
            if (!keepPageOpen && openedAtMs > 0 && requestedMinimumLifetimeMs > 0) {
                let remainingMs = requestedMinimumLifetimeMs - (Date.now() - openedAtMs);
                while (remainingMs > 0 && !page.isClosed?.()) {
                    await page.waitForTimeout?.(Math.min(15_000, remainingMs));
                    remainingMs = requestedMinimumLifetimeMs - (Date.now() - openedAtMs);
                    if (snapshotEveryScroll && diagnostics?.captureDomSnapshot && !page.isClosed?.()) {
                        const dwellHtml = await page.content().catch(() => '');
                        if (dwellHtml) {
                            fallbackHtml = dwellHtml;
                            progressSnapshotSequence += 1;
                            await diagnostics.captureDomSnapshot({
                                sourceId: `tg:${channel}`,
                                page,
                                html: dwellHtml,
                                label: `dwell-${String(progressSnapshotSequence).padStart(3, '0')}`,
                                metadata: {
                                    phase: 'minimum-tab-lifetime',
                                    minimumPageLifetimeMs: requestedMinimumLifetimeMs,
                                    elapsedMs: Date.now() - openedAtMs,
                                    remainingMs: Math.max(0, remainingMs),
                                },
                            });
                        }
                    }
                }
            }

            const html = await page.content();
            if (snapshotEveryScroll && diagnostics?.captureDomSnapshot) {
                progressSnapshotSequence += 1;
                await diagnostics.captureDomSnapshot({
                    sourceId: `tg:${channel}`,
                    page,
                    html,
                    label: 'capture-complete',
                    metadata: { phase: 'immutable-final-snapshot', channel, beforeId, openedAtMs },
                });
            }
            // V188.141: Capture the page after its existing pagination, without
            // a second 50-step crawl solely for a diagnostic fixture.
            // Each ?before= page is a bounded HTML page, not whole channel history.
            if (diagnostics?.captureVkFinalDomSnapshot && diagnostics.finalDomOnly && !page.isClosed?.()) {
                try {
                    await diagnostics.captureVkFinalDomSnapshot({ page,
                        sourceId: `tg:${channel}:before:${beforeId || 'latest'}`,
                        sourceKind: 'telegram-public-html-page', direction: 'up',
                        preparation: {
                            status: 'native-capture-finished-no-extra-pagination',
                            direction: 'up', prepared: false, steps: 0,
                            controlsCompleted: 0, progress: [],
                            note: 'Current DOM of this one Telegram HTML page after native processing; no extra pagination.',
                        },
                    });
                } catch (finalCaptureError) {
                    diagnostics.log?.('dom.final-fixture.capture-error', {
                        sourceId: `tg:${channel}`, beforeId, error: finalCaptureError,
                    });
                }
            }
            const parsedCount = parseTelegramPublicHtml(html, channel).length;
            console.log(
                '[TG HTML PAGE CAPTURED]',
                `channel=@${channel}`,
                `before=${beforeId || 'latest'}`,
                `posts=${parsedCount}`,
                `holdMs=${pageHoldMs}`,
            );
            completedSuccessfully = true;
            return { html, stoppedByOwner: false, page };
        } catch (error) {
            if (keepPageOpen && isScraperTargetClosedError(error)) {
                stoppedByOwner = true;
                console.log(
                    '[TG MANUAL PARSER FINISH BY CLOSE]',
                    `channel=@${channel}`,
                    `before=${beforeId || 'latest'}`,
                    `fallbackBytes=${Buffer.byteLength(fallbackHtml || '', 'utf8')}`,
                );
                return { html: fallbackHtml, stoppedByOwner: true, page };
            }
            throw error;
        }
    } finally {
        if (
            page &&
            keepPageOpen && completedSuccessfully &&
            !stoppedByOwner &&
            !page.isClosed()
        ) {
            if (keptManualPages.get(channel) !== page) {
                keptManualPages.set(channel, page);
                page.once('close', () => {
                    if (keptManualPages.get(channel) === page) keptManualPages.delete(channel);
                    const loop = manualLiveLoops.get(channel);
                    if (loop?.page === page) manualLiveLoops.delete(channel);
                });
            }
            await page.bringToFront().catch(() => {});
            console.log(
                '[TG SCRAPER TAB KEPT OPEN]',
                `channel=@${channel}`,
                `before=${beforeId || 'latest'}`,
                'samePass=true',
                'autoClose=false',
            );
        } else if (page && !page.isClosed() && !deferClose) {
            await page.close().catch(() => {});
        }
    }
}

async function downloadEventImages({
    channel,
    messageId,
    imageUrls,
    dataDirectory,
    notifyAttention,
}) {
    if (!Array.isArray(imageUrls) || !imageUrls.length) {
        return [];
    }

    const targetDirectory = join(
        dataDirectory,
        'telegram_announcements',
        channel,
    );
    mkdirSync(targetDirectory, { recursive: true });
    const paths = [];

    for (let index = 0; index < imageUrls.length; index += 1) {
        const imageUrl = imageUrls[index];

        try {
            const response = await browserDownloadBuffer({
                url: imageUrl,
                dataDirectory,
                notifyAttention,
                source: 'Telegram image',
                maximumBytes: MAX_IMAGE_BYTES,
            });
            const extension = guessImageExtension(
                response.contentType,
                response.finalUrl,
            );
            const relativePath = join(
                'telegram_announcements',
                channel,
                `${messageId}-${index + 1}${extension}`,
            );
            const absolutePath = join(dataDirectory, relativePath);
            writeFileSync(absolutePath, response.buffer);
            paths.push(relativePath.replace(/\\/gu, '/'));
        } catch (error) {
            console.error(
                '[TG HTML IMAGE ERROR]',
                `post=${channel}/${messageId}`,
                String(error?.message ?? error),
            );
        }
    }

    return paths;
}

async function collectInitialPosts({
    channel,
    targetCount,
    dataDirectory,
    notifyAttention,
    keepPageOpen = false,
    deferClose = false,
    diagnostics = null,
    snapshotEveryScroll = false,
    minimumPageLifetimeMs = 0,
}) {
    const collected = new Map();
    let beforeId = null;
    let manualPage = null;
    let stoppedByOwner = false;
    let fullDomHtml = '';

    for (let pageIndex = 0; pageIndex < MAX_PAGES_PER_RUN; pageIndex += 1) {
        if (keepPageOpen && manualPage?.isClosed?.()) {
            stoppedByOwner = true;
            break;
        }

        const capture = await fetchHtmlPage({
            channel,
            beforeId,
            dataDirectory,
            notifyAttention,
            // Весь before= проход идёт в ОДНОЙ reusable вкладке.
            keepPageOpen,
            deferClose,
            diagnostics,
            snapshotEveryScroll,
            minimumPageLifetimeMs,
        });
        if (capture?.page) manualPage = capture.page;
        fullDomHtml = String(capture?.html || fullDomHtml || '');
        const posts = parseTelegramPublicHtml(capture?.html || '', channel);

        for (const post of posts) {
            collected.set(post.messageId, post);
        }

        if (capture?.stoppedByOwner) {
            stoppedByOwner = true;
            break;
        }
        if (!posts.length || collected.size >= targetCount) {
            break;
        }

        const oldestId = Math.min(...posts.map((post) => post.messageId));
        if (!oldestId || oldestId === beforeId) {
            break;
        }

        beforeId = oldestId;
        await sleep(1_200);
    }

    const result = [...collected.values()]
        .sort((left, right) => right.messageId - left.messageId)
        .slice(0, targetCount);
    Object.defineProperty(result, 'stoppedByOwner', {
        value: stoppedByOwner,
        enumerable: false,
    });
    Object.defineProperty(result, 'sourcePage', {
        value: manualPage,
        enumerable: false,
    });
    Object.defineProperty(result, 'fullDomHtml', {
        value: fullDomHtml,
        enumerable: false,
    });
    return result;
}

async function collectNewPosts({
    channel,
    lastMessageId,
    dataDirectory,
    notifyAttention,
    keepPageOpen = false,
    deferClose = false,
    diagnostics = null,
    snapshotEveryScroll = false,
    minimumPageLifetimeMs = 0,
}) {
    const collected = new Map();
    let beforeId = null;
    let manualPage = null;
    let stoppedByOwner = false;
    let fullDomHtml = '';

    for (let pageIndex = 0; pageIndex < 10; pageIndex += 1) {
        if (keepPageOpen && manualPage?.isClosed?.()) {
            stoppedByOwner = true;
            break;
        }

        const capture = await fetchHtmlPage({
            channel,
            beforeId,
            dataDirectory,
            notifyAttention,
            keepPageOpen,
            deferClose,
            diagnostics,
            snapshotEveryScroll,
            minimumPageLifetimeMs,
        });
        if (capture?.page) manualPage = capture.page;
        fullDomHtml = String(capture?.html || fullDomHtml || '');
        const posts = parseTelegramPublicHtml(capture?.html || '', channel);

        /*
         * Повторно проверяем и последние уже известные сообщения. Telegram-
         * анонсы часто редактируют после публикации: меняют состав, цену или
         * время. content_hash ниже не даст лишний раз писать неизменённые посты.
         */
        for (const post of posts) {
            collected.set(post.messageId, post);
        }

        if (capture?.stoppedByOwner) {
            stoppedByOwner = true;
            break;
        }
        if (!posts.length) {
            break;
        }

        const oldestId = Math.min(...posts.map((post) => post.messageId));
        if (
            posts.some((post) => post.messageId <= lastMessageId) ||
            !oldestId ||
            oldestId === beforeId
        ) {
            break;
        }

        beforeId = oldestId;
        await sleep(1_200);
    }

    const result = [...collected.values()].sort(
        (left, right) => left.messageId - right.messageId,
    );
    Object.defineProperty(result, 'stoppedByOwner', {
        value: stoppedByOwner,
        enumerable: false,
    });
    Object.defineProperty(result, 'sourcePage', {
        value: manualPage,
        enumerable: false,
    });
    Object.defineProperty(result, 'fullDomHtml', {
        value: fullDomHtml,
        enumerable: false,
    });
    return result;
}

async function fetchTelegramImageDirect(url, timeoutMs = 30_000) {
    const response = await fetch(url, {
        redirect: 'follow',
        signal: AbortSignal.timeout(Math.max(5_000, Number(timeoutMs) || 30_000)),
        headers: {
            'user-agent': DEFAULT_USER_AGENT,
            accept: 'image/avif,image/webp,image/apng,image/*,*/*;q=0.8',
        },
    });
    if (!response.ok) throw new Error(`Telegram image fingerprint: HTTP ${response.status}`);
    const advertisedBytes = Number(response.headers.get('content-length') || 0);
    if (advertisedBytes > MAX_IMAGE_BYTES) {
        throw new Error(`Telegram image fingerprint: файл превысил ${MAX_IMAGE_BYTES} байт`);
    }
    const buffer = Buffer.from(await response.arrayBuffer());
    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`Telegram image fingerprint: файл превысил ${MAX_IMAGE_BYTES} байт`);
    }
    return {
        buffer,
        contentType: response.headers.get('content-type') || '',
        finalUrl: response.url || url,
    };
}

async function fingerprintTelegramPostImages(post, {
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
                source: 'Telegram image fingerprint',
                maximumBytes: MAX_IMAGE_BYTES,
                timeoutMs: 30_000,
            })
            : (url) => fetchTelegramImageDirect(url, 30_000),
        onAttemptError,
        onRecovered,
        onFallback,
        onRejected,
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
    forceReprocess = false,
    ledgerContext = null,
    traceAi = null,
}) {
    console.log('[EVENT PROVENANCE]', `source=telegram:${post.channel}/${post.messageId}`, 'origin=telegram-post', `url=${String(post.sourceUrl || '')}`);
    const contentHash = hashPost(post);
    const previous = getTelegramPostMeta({
        channel: post.channel,
        messageId: post.messageId,
    });
    const previousImageFingerprints = parseImageFingerprints(previous?.imageFingerprintsJson);
    const previousImagePaths = (() => {
        try {
            const parsed = JSON.parse(String(previous?.imagePathsJson ?? '[]'));
            return Array.isArray(parsed) ? parsed.map((item) => String(item ?? '').trim()).filter(Boolean) : [];
        } catch { return []; }
    })();
    const fingerprintsBackfilled = Boolean(
        previous?.textFingerprint &&
        (!Array.isArray(post?.imageUrls) || !post.imageUrls.length || previousImageFingerprints.length),
    );
    const onlyGeneratedFallbacks = previousImagePaths.length > 0 && previousImagePaths.every((path) => /-event-\d+\.png$/iu.test(path));
    const hasMissingLocalImage = previousImagePaths.some((path) => !existsSync(join(dataDirectory, path)));
    const needsStrictImageRevalidation = Number(previous?.eventCount ?? 0) > 0 && (
        Number(previous?.eventsWithoutImages ?? 0) > 0 ||
        !previousImagePaths.length || onlyGeneratedFallbacks || hasMissingLocalImage
    );

    if (sourceContentHashMatches(previous?.contentHash, post, {
        legacyParserVersions: TELEGRAM_LEGACY_HASH_VERSIONS,
    }) && fingerprintsBackfilled && !needsStrictImageRevalidation && !forceReprocess) {
        return { changed: false, eventCount: Number(previous.eventCount ?? 0) };
    }

    const textFingerprint = createSourceTextFingerprint(post.text);
    const textSimilarity = previous?.rawText
        ? sourceTextSimilarity(previous.rawText, post.text)
        : 0;
    const nearDuplicateText = Boolean(previous && textSimilarity >= 0.90);
    const todayIso = currentIsoDate(timeZone);
    const textOnlyLocalEvents = parsePublicPostLocally(post);
    const textComplete = textEventsAreComplete(textOnlyLocalEvents, {
        sourceText: post.text,
        publishedAt: post.publishedAt,
        todayIso,
        timeZone,
    });
    const retryTrace = [];
    let rejectedVisionImages = 0;

    // Афиша — обязательная часть source evidence. Даже при полном тексте
    // проверяем реальные изображения поста и читаем их через vision.
    const imageFingerprints = await fingerprintTelegramPostImages(post, {
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
                    dataDirectory, sourceType: 'telegram-public', sourceKey: post.channel,
                    itemId: post.messageId, sourceUrl: post.sourceUrl,
                    status: 'retry-error', reason: 'image-fingerprint', rawText: post.text,
                    details: row,
                });
            },
            onRecovered: ({ round, maxRounds, url = '' }) => {
                const row = {
                    stage: 'image-fingerprint', recovered: true, round, maxRounds,
                    url: String(url ?? '').slice(0, 1500),
                };
                retryTrace.push(row);
                appendEventIngestAudit({
                    dataDirectory, sourceType: 'telegram-public', sourceKey: post.channel,
                    itemId: post.messageId, sourceUrl: post.sourceUrl,
                    status: 'retry-recovered', reason: 'image-fingerprint', rawText: post.text,
                    details: row,
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
                    dataDirectory, sourceType: 'telegram-public', sourceKey: post.channel,
                    itemId: post.messageId, sourceUrl: post.sourceUrl,
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
                    dataDirectory, sourceType: 'telegram-public', sourceKey: post.channel,
                    itemId: post.messageId, sourceUrl: post.sourceUrl,
                    status: 'image-skipped', reason: 'not-large-poster-like', rawText: post.text,
                    details: row,
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
    const skipVisionReason = visionSkipReason({
        textComplete,
        storedImageReusable,
        eligibleImageCount: visionImageUrls.length,
        hasVision: typeof extractImageFactsWithAi === 'function',
    });

    let enrichedPost = post;
    let imageFacts = String(post?.__posterGateFacts || '').trim();
    const shouldRunVision = Boolean(
        !imageFacts &&
        !skipVisionReason &&
        (!nearDuplicateText || imageChanged)
    );
    if (shouldRunVision) {
        try {
            imageFacts = String(await runEventOperationWithRetries(
                () => extractImageFactsWithAi({
                    ...post,
                    imageUrls: visionImageUrls,
                    imageFingerprints,
                }),
                {
                    label: `telegram-public-vision:${post.channel}/${post.messageId}`,
                    maxAttempts: 1,
                    onAttemptError: ({ round, maxRounds, willRetry, delayMs, errorMessage }) => {
                        const row = { stage: 'vision', round, maxRounds, willRetry, delayMs, error: errorMessage };
                        retryTrace.push(row);
                        appendEventIngestAudit({
                            dataDirectory, sourceType: 'telegram-public', sourceKey: post.channel,
                            itemId: post.messageId, sourceUrl: post.sourceUrl,
                            status: 'retry-error', reason: 'vision', rawText: post.text, details: row,
                        });
                    },
                    onRecovered: ({ round, maxRounds }) => {
                        const row = { stage: 'vision', recovered: true, round, maxRounds };
                        retryTrace.push(row);
                        appendEventIngestAudit({
                            dataDirectory, sourceType: 'telegram-public', sourceKey: post.channel,
                            itemId: post.messageId, sourceUrl: post.sourceUrl,
                            status: 'retry-recovered', reason: 'vision', rawText: post.text, details: row,
                        });
                    },
                },
            ) ?? '').trim();
        } catch (error) {
            console.error('[TG HTML VISION ERROR]', `post=${post.channel}/${post.messageId}`, String(error?.message ?? error));
        }
    }

    if (!imageFacts && String(post?.__posterGateFacts || '').trim()) {
        imageFacts = String(post.__posterGateFacts).trim();
    }

    if (imageFacts) {
        enrichedPost = {
            ...post,
            text: [post.text, '[Факты с афиши]', imageFacts].filter(Boolean).join('\n\n'),
        };
    }

    let events = imageFacts ? parsePublicPostLocally(enrichedPost) : textOnlyLocalEvents;
    const localParsedCount = events.length;
    // После чтения афиши финальная семантическая сверка нужна даже если текст
    // сам по себе выглядел полным: poster facts могут исправить дату/место/title.
    const canCallAi = typeof extractEventsWithAi === 'function' &&
        (!nearDuplicateText || imageChanged) &&
        (publicPostLooksLikeEventCandidate(enrichedPost) || Boolean(imageFacts));
    let aiRawCount = 0;
    let aiValidatedCount = 0;
    let aiError = '';

    if (canCallAi) {
        try {
            const aiEvents = await runEventOperationWithRetries(
                () => extractEventsWithAi(enrichedPost),
                {
                    label: `telegram-public-ai:${post.channel}/${post.messageId}`,
                    maxAttempts: 1,
                    onAttemptError: ({ round, maxRounds, willRetry, delayMs, errorMessage }) => {
                        const row = { stage: 'ai-extraction', round, maxRounds, willRetry, delayMs, error: errorMessage };
                        retryTrace.push(row);
                        appendEventIngestAudit({
                            dataDirectory, sourceType: 'telegram-public', sourceKey: post.channel,
                            itemId: post.messageId, sourceUrl: post.sourceUrl,
                            status: 'retry-error', reason: 'ai-extraction', rawText: post.text, details: row,
                        });
                    },
                    onRecovered: ({ round, maxRounds }) => {
                        const row = { stage: 'ai-extraction', recovered: true, round, maxRounds };
                        retryTrace.push(row);
                        appendEventIngestAudit({
                            dataDirectory, sourceType: 'telegram-public', sourceKey: post.channel,
                            itemId: post.messageId, sourceUrl: post.sourceUrl,
                            status: 'retry-recovered', reason: 'ai-extraction', rawText: post.text, details: row,
                        });
                    },
                },
            );
            aiRawCount = Array.isArray(aiEvents) ? aiEvents.length : 0;
            const validated = validatePublicAiEvents(aiEvents, enrichedPost).map((event) => ({
                ...event,
                structureDecision: String(aiEvents?.[0]?._structure || aiEvents?.[0]?.structure || '').trim(),
                structureReason: String(aiEvents?.[0]?._structureReason || aiEvents?.[0]?.structure_reason || '').trim(),
            }));
            aiValidatedCount = validated.length;
            if (validated.length) events = validated;
        } catch (error) {
            aiError = String(error?.message ?? error);
            console.error('[TG HTML GIGACHAT ERROR]', `post=${post.channel}/${post.messageId}`, aiError);
        }
    }

    const parsedEvents = events;
    const rejectedEvents = [];
    events = parsedEvents.filter((event) => {
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
        const strict = explainStrictEventRecord(event, { sourceText: enrichedPost.text });
        if (!strict.ok) {
            rejectedEvents.push({ event, reason: `strict:${strict.reason}` });
            return false;
        }
        return true;
    });

    const posterBindingAudit = [];
    if (events.length) {
        events = assignEventImageIndexesFromFacts(events, imageFacts, {
            onAudit: ({ event, imageIndex, accepted, reason, score, imageType, poster, posterConfidence, textReadability, facts }) => {
                const eventLabel = `${event?.eventDate || '?'} ${String(event?.title || '').slice(0, 80)}`;
                console.log('[EVENT POSTER MATCH]', eventLabel, `image=${imageIndex || 'none'}`, accepted ? `accepted:${reason}` : `rejected:${reason}`);
                const row = {
                    eventDate: event?.eventDate || '',
                    title: event?.title || '',
                    imageIndex,
                    accepted: Boolean(accepted),
                    reason: String(reason || ''),
                    score: Number(score || 0),
                    imageType: String(imageType || ''),
                    poster,
                    posterConfidence,
                    textReadability,
                    facts: facts || null,
                };
                posterBindingAudit.push(row);
                traceAi?.('poster.binding', row);
            },
        });
        events = applyPosterDerivedVenueFallback(events);
        events = await prepareEventImages({
            events,
            sourceKey: post.channel,
            itemId: post.messageId,
            // imageIndexes from vision refer to this exact admitted list.
            // Using the wider DOM list here would shift indexes whenever an
            // avatar/UI image had been rejected before vision.
            imageUrls: visionImageUrls,
            dataDirectory,
            targetFolder: 'telegram_announcements',
            sourceLabel: `Telegram @${post.channel}`,
            notifyAttention,
            allowBrowserFallback: !manualRun,
            shareSourceImagesAcrossEvents: true,
        });
        events = filterEventsWithAnnouncementImages(events, {
            onRejected: (event, reason) => rejectedEvents.push({ event, reason }),
        });
    }

    const newImagePaths = [...new Set(events.flatMap((event) => (
        Array.isArray(event?._sourceImagePaths) && event._sourceImagePaths.length
            ? event._sourceImagePaths
            : event?.imagePaths ?? []
    )))];
    // Same poster already produced DB rows earlier: never erase them merely because
    // this pass intentionally skipped paid vision.
    const preserveStoredEvents = shouldPreserveStoredEventsOnEmptyReparse({
        previousEventCount: previous?.eventCount,
        acceptedEventCount: events.length,
    });
    const imagePaths = preserveStoredEvents ? previousImagePaths : newImagePaths;
    const effectiveEventCount = preserveStoredEvents ? Number(previous.eventCount) : events.length;
    const fetchedAt = Math.floor(Date.now() / 1000);

    const candidate = publicPostLooksLikeEventCandidate(enrichedPost) || Boolean(imageFacts);
    const ledgerToCommit = ledgerContext &&
        !(candidate && canCallAi && aiError && !effectiveEventCount)
        ? { ...ledgerContext, parseStatus: effectiveEventCount > 0 ? 'processed_event' : 'processed_not_event' }
        : null;
    await runEventOperationWithRetries(
        () => persistTelegramSourceAndEvents({
            source: {
            channel: post.channel,
            messageId: post.messageId,
            sourceUrl: post.sourceUrl,
            publishedAt: post.publishedAt,
            rawText: post.text,
            imageUrls: post.imageUrls,
            imagePaths,
            contentHash,
            textFingerprint,
            imageFingerprints,
            imageVisionFacts: parseIndexedImageFacts(imageFacts),
            parseStatus: effectiveEventCount ? 'event' : 'not_event',
            fetchedAt,
            },
            ledger: ledgerToCommit,
            replacement: preserveStoredEvents ? null : {
            channel: post.channel,
            messageId: post.messageId,
            sourceUrl: post.sourceUrl,
            imagePaths,
            events,
            updatedAt: fetchedAt,
            },
        }),
        { label: `telegram-source-and-events-db:${post.channel}/${post.messageId}` },
    );

    appendEventIngestAudit({
        dataDirectory,
        sourceType: 'telegram-public',
        sourceKey: post.channel,
        itemId: post.messageId,
        sourceUrl: post.sourceUrl,
        status: effectiveEventCount ? 'stored-event' : 'rejected-or-not-event',
        reason: preserveStoredEvents
            ? 'preserved-existing-events-after-empty-reparse'
            : effectiveEventCount
                ? 'stored-in-telegram_events'
                : parsedEvents.length
                    ? 'parsed-events-rejected-by-final-validation'
                    : candidate
                        ? 'candidate-produced-no-events'
                        : 'not-an-event-candidate',
        rawText: post.text,
        details: {
            parserVersion: TELEGRAM_PARSER_VERSION,
            publishedAt: Number(post.publishedAt ?? 0),
            imageCount: Array.isArray(post.imageUrls) ? post.imageUrls.length : 0,
            visionEligibleImageCount: visionImageUrls.length,
            rejectedVisionImages,
            textComplete,
            visionSkipReason: shouldRunVision ? '' : (skipVisionReason || (nearDuplicateText && !imageChanged ? 'unchanged-near-duplicate' : '')),
            storedImageReusable,
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
        eventsCreatedCount: Number(previous?.eventCount || 0) > 0 ? 0 : effectiveEventCount,
        eventsUpdatedCount: Number(previous?.eventCount || 0) > 0 ? effectiveEventCount : 0,
        visionCheckedImageCount: shouldRunVision ? visionImageUrls.length : 0,
        posterMatchAcceptedCount: posterBindingAudit.filter((item) => item?.accepted).length,
        posterMatchRejectedCount: posterBindingAudit.filter((item) => !item?.accepted).length,
        candidate,
        aiError,
        unresolved: Boolean(candidate && canCallAi && aiError && !effectiveEventCount),
    };
}

function startTelegramManualLiveParser({
    channel,
    dataDirectory,
    downloadImages,
    extractEventsWithAi,
    extractImageFactsWithAi,
    notifyAttention,
    timeZone,
}) {
    const page = keptManualPages.get(channel);
    if (!page || page.isClosed()) return;
    const existing = manualLiveLoops.get(channel);
    if (existing?.page === page) return;

    const token = { page, stopped: false };
    manualLiveLoops.set(channel, token);
    const pollMs = clampInteger(
        process.env.TELEGRAM_MANUAL_LIVE_POLL_MS,
        750,
        10_000,
        1800,
    );

    const poll = async () => {
        if (token.stopped || page.isClosed() || manualLiveLoops.get(channel) !== token) return;
        try {
            const html = await page.content();
            const posts = parseTelegramPublicHtml(html, channel)
                .sort((left, right) => left.messageId - right.messageId);
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
                const state = getTelegramScraperState(channel);
                const lastMessageId = Math.max(
                    Number(state?.lastMessageId ?? 0),
                    ...posts.map((post) => Number(post.messageId) || 0),
                    0,
                );
                updateTelegramScraperState({
                    channel,
                    lastMessageId,
                    lastSuccessAt: Math.floor(Date.now() / 1000),
                    lastAttemptAt: Math.floor(Date.now() / 1000),
                    lastError: '',
                    initialCompleted: true,
                    postsSeen: Number(state?.postsSeen ?? 0) + changedPosts,
                    eventsFound: Number(state?.eventsFound ?? 0) + eventsFound,
                });
                console.log(
                    '[TG MANUAL SCROLL LIVE PARSER]',
                    `channel=@${channel}`,
                    `changed=${changedPosts}`,
                    `events=${eventsFound}`,
                );
            }
        } catch (error) {
            if (!page.isClosed()) {
                console.warn('[TG MANUAL LIVE PARSER ERROR]', `channel=@${channel}`, String(error?.message ?? error));
            }
        }
        const timer = setTimeout(poll, pollMs);
        timer.unref?.();
    };

    page.once('close', () => {
        token.stopped = true;
        if (manualLiveLoops.get(channel) === token) manualLiveLoops.delete(channel);
    });
    console.log('[TG MANUAL LIVE PARSER STARTED]', `channel=@${channel}`, `pollMs=${pollMs}`);
    const timer = setTimeout(poll, pollMs);
    timer.unref?.();
}

export function createTelegramHtmlScraper({
    channel: channelInput,
    dataDirectory,
    initialMessages = 20,
    intervalHours = 24,
    downloadImages = true,
    extractEventsWithAi = null,
    extractImageFactsWithAi = null,
    notifyAttention = null,
    timeZone = 'Europe/Moscow',
    snapshotEveryScroll = false,
    minimumPageLifetimeMs = 0,
    partyPool = 'primary',
} = {}) {
    const channel = normalizeChannel(channelInput || 'kurazhcity');
    const safeInitialMessages = clampInteger(
        initialMessages,
        1,
        20,
        20,
    );
    const intervalMs = clampInteger(
        Number(intervalHours) * 60 * 60 * 1000,
        60 * 60 * 1000,
        30 * ONE_DAY_MS,
        ONE_DAY_MS,
    );
    const safeDataDirectory = String(dataDirectory ?? '').trim();
    const secondaryMode = String(partyPool ?? '').trim().toLowerCase() === 'secondary';

    if (!safeDataDirectory) {
        throw new Error('Для Telegram HTML-парсера не указана папка data.');
    }

    async function run({
        forceInitial = false,
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
    } = {}) {
        if (activeRunPromises.has(channel)) {
            return activeRunPromises.get(channel);
        }

        let finiteSourcePage = null;
        const runPromise = (async () => {
            const startedAt = Math.floor(Date.now() / 1000);
            const state = getTelegramScraperState(channel);
            const initialMode = forceInitial || !state?.initialCompleted;
            const posts = initialMode
                ? await collectInitialPosts({
                    channel,
                    targetCount: safeInitialMessages,
                    dataDirectory: safeDataDirectory,
                    notifyAttention,
                    keepPageOpen,
                    deferClose: !keepPageOpen,
                    diagnostics,
                    snapshotEveryScroll: Boolean(snapshotEveryScroll),
                    minimumPageLifetimeMs: Math.max(0, Number(minimumPageLifetimeMs) || 0),
                })
                : await collectNewPosts({
                    channel,
                    lastMessageId: Number(state?.lastMessageId ?? 0),
                    dataDirectory: safeDataDirectory,
                    notifyAttention,
                    keepPageOpen,
                    deferClose: !keepPageOpen,
                    diagnostics,
                    snapshotEveryScroll: Boolean(snapshotEveryScroll),
                    minimumPageLifetimeMs: Math.max(0, Number(minimumPageLifetimeMs) || 0),
                });

            finiteSourcePage = !keepPageOpen ? posts?.sourcePage : null;
            const stoppedByOwner = Boolean(posts?.stoppedByOwner);

            if (!posts.length) {
                if (stoppedByOwner) {
                    const now = Math.floor(Date.now() / 1000);
                    updateTelegramScraperState({
                        channel,
                        lastMessageId: Number(state?.lastMessageId ?? 0),
                        lastSuccessAt: Number(state?.lastSuccessAt ?? 0),
                        lastAttemptAt: now,
                        lastError: '',
                        initialCompleted: Boolean(state?.initialCompleted),
                        postsSeen: Number(state?.postsSeen ?? 0),
                        eventsFound: Number(state?.eventsFound ?? 0),
                    });
                    return {
                        channel,
                        mode: initialMode ? 'initial' : 'daily',
                        fetchedPosts: 0,
                        changedPosts: 0,
                        eventsFound: 0,
                        lastMessageId: Number(state?.lastMessageId ?? 0),
                        stoppedByOwner: true,
                    };
                }
                throw new Error(
                    `Telegram не вернул публикации канала @${channel}. ` +
                    'Возможно, изменился HTML или временно сработала защита.',
                );
            }

            const sourceId = `tg:${channel}`;
            const ledgerRunId = `${sourceId}:${startedAt}:${process.pid}`;
            const orderedPosts = [...posts].sort(
                (left, right) => left.messageId - right.messageId,
            );
            const candidateDecisions = new Map();
            const candidateIds = new Set();
            const posterGateRequests = [];
            let structuralCandidateCount = 0;
            let databaseSkippedCount = 0;
            let aiRejectedCount = 0;
            let trashCount = 0;
            let incrementalKnownSkippedCount = 0;
            let incrementalNewCount = 0;
            for (const post of orderedPosts) {
                const itemId = String(post?.messageId ?? '');
                const ledgerBefore = getManualParserSeenItem({ sourceId, itemId });
                const rawContentHash = hashPost(post);
                const incrementalKnown = shouldSkipUnchangedCapturedItem({
                    incrementalOnly,
                    previous: ledgerBefore,
                    contentHash: rawContentHash,
                    isFinalStatus: isManualParserSeenItemFinalStatus,
                });
                upsertManualParserSeenItem({
                    sourceId, sourceKind: 'telegram', itemId,
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
                // Full secondary reparse means reparse ALL captured posts. Existing
                // DB evidence is retained in audit, but does not suppress AI.
                const existing = (secondaryMode || (incrementalOnly && !incrementalKnown))
                    ? null : existingEvidence;
                if (existing) databaseSkippedCount += 1;
                if (decision.candidate && !decision.aiEligible && !secondaryMode) aiRejectedCount += 1;
                if (!decision.candidate && !incrementalKnown) trashCount += 1;
                const aiCandidate = secondaryMode ? false : Boolean(decision.aiEligible && !existing);
                const priority = (aiCandidate || (secondaryMode && secondaryTextGate?.visionEligible)) ? decision.score : -1000;
                const posterGateImageUrls = [...new Set((Array.isArray(post?.imageUrls) ? post.imageUrls : [])
                    .map((value) => String(value ?? '').trim())
                    .filter((url) => /^https?:\/\//iu.test(url)))]
                    .slice(0, 12);
                const posterGatePending = secondaryMode
                    ? Boolean(!incrementalKnown && secondaryTextGate?.visionEligible && !existing && posterGateImageUrls.length)
                    : Boolean(!incrementalKnown && !decision.aiEligible && !existing && posterGateImageUrls.length);
                candidateDecisions.set(itemId, {
                    ...decision, existing, existingEvidence, aiCandidate, priority, bodyAiEligible: Boolean(decision.aiEligible),
                    posterGatePending, posterGateImageUrls, incrementalKnown, ledgerBefore, secondaryTextGate,
                });
                if (posterGatePending) {
                    posterGateRequests.push({
                        itemId, source: `t.me/${channel}`, sourceUrl: String(post?.sourceUrl || ''),
                        imageUrls: posterGateImageUrls, priority: Number(decision.score || 0),
                        score: Number(decision.score || 0), preview: parserCandidatePreview(post?.text),
                        sourceText: String(post?.text || ''),
                        secondaryJointGate: secondaryMode,
                        secondaryTextGate,
                    });
                }
                if (aiCandidate) candidateIds.add(itemId);
                diagnostics?.log?.('item.prefilter', {
                    sourceId,
                    itemId,
                    parserPass: String(post?.parserPass || post?.parseMethod || 'telegram-html'),
                    candidate: decision.candidate,
                    aiEligible: decision.aiEligible,
                    aiCandidate,
                    aiAdmission: decision.aiAdmission,
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
            const capturedFullDomHtml = String(posts?.fullDomHtml || '');
            const domPath = await diagnostics?.captureDomSnapshot?.({
                sourceId,
                page: capturedFullDomHtml ? null : finiteSourcePage,
                html: capturedFullDomHtml || null,
                label: 'capture-complete',
                metadata: { itemCount: orderedPosts.length, parser: 'parseTelegramPublicHtml' },
            });
            const cachePath = diagnostics?.cacheSource?.({
                sourceId,
                kind: 'telegram',
                items: orderedPosts,
                metadata: {
                    channel,
                    initialMode,
                    stoppedByOwner,
                    domPath,
                },
            }) || '';
            const parserReportPath = diagnostics?.saveParserReport?.({
                sourceId,
                kind: 'telegram',
                report: {
                    channel,
                    domPath,
                    cachePath,
                    parser: 'parseTelegramPublicHtml',
                    itemCount: orderedPosts.length,
                    prefilter: orderedPosts.map((post) => {
                        const itemId = String(post?.messageId ?? '');
                        const decision = candidateDecisions.get(itemId) || {};
                        return {
                            itemId,
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
                kind: 'telegram',
                itemCount: orderedPosts.length,
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
                candidatePreviews: orderedPosts
                    .filter((post) => candidateIds.has(String(post.messageId)))
                    .map((post) => {
                        const itemId = String(post.messageId);
                        const decision = candidateDecisions.get(itemId) || {};
                        return {
                            itemId,
                            source: `t.me/${channel}`,
                            sourceUrl: String(post?.sourceUrl || ''),
                            preview: parserCandidatePreview(post.text),
                            priority: Number(decision.priority || 0),
                            score: Number(decision.score || 0),
                            reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                            aiAdmission: decision.aiAdmission || null,
                        };
                    }),
                prefilterPreviews: orderedPosts.map((post) => {
                    const itemId = String(post?.messageId ?? '');
                    const decision = candidateDecisions.get(itemId) || {};
                    return {
                        itemId,
                        source: `t.me/${channel}`,
                        sourceUrl: String(post?.sourceUrl || ''),
                        preview: parserCandidatePreview(post?.text),
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

            if (!keepPageOpen && finiteSourcePage && !finiteSourcePage.isClosed()) {
                await finiteSourcePage.close().catch(() => {});
                finiteSourcePage = null;
                console.log('[TG SCRAPER SOURCE TAB CLOSED AFTER CACHE]', `channel=@${channel}`);
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
            for (const post of orderedPosts) {
                const itemId = String(post?.messageId ?? '');
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
                if (existing) databaseSkippedCount += 1;
                if (decision.candidate && !decision.aiEligible) aiRejectedCount += 1;
                if (!decision.candidate && !before.incrementalKnown) trashCount += 1;
                const aiCandidate = Boolean(decision.aiEligible && !existing);
                const priority = aiCandidate ? Number(decision.score || 0) : -1000;
                if (secondaryMode && jointVisionAccepted) {
                    posterGateRescuedCount += 1;
                } else if (!secondaryMode && !before.bodyAiEligible && decision.aiEligible && decision?.aiAdmission?.dateSource === 'poster-vision') {
                    posterGateRescuedCount += 1;
                }
                candidateDecisions.set(itemId, { ...before, ...decision, existing, aiCandidate, priority, jointVisionAccepted });
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
                .filter((post) => candidateIds.has(String(post.messageId)))
                .map((post) => {
                    const itemId = String(post.messageId);
                    const decision = candidateDecisions.get(itemId) || {};
                    return { itemId, source: `t.me/${channel}`, sourceUrl: String(post?.sourceUrl || ''),
                        preview: parserCandidatePreview(post.text), priority: Number(decision.priority || 0),
                        score: Number(decision.score || 0), reasons: Array.isArray(decision.reasons) ? decision.reasons : [],
                        aiAdmission: decision.aiAdmission || null };
                });
            const finalPrefilterPreviews = orderedPosts.map((post) => {
                const itemId = String(post?.messageId ?? '');
                const decision = candidateDecisions.get(itemId) || {};
                return { itemId, source: `t.me/${channel}`, sourceUrl: String(post?.sourceUrl || ''),
                    preview: parserCandidatePreview(post?.text), candidate: Boolean(decision.candidate),
                    aiEligible: Boolean(decision.aiEligible), aiCandidate: Boolean(decision.aiCandidate),
                    reasons: Array.isArray(decision.reasons) ? decision.reasons : [], aiAdmission: decision.aiAdmission || null,
                    databaseMatch: decision.existing || null, posterGateAttempted: Boolean(post?.__posterGateVisionAttempted),
                    posterGateError: String(post?.__posterGateError || ''), incrementalKnown: Boolean(decision.incrementalKnown) };
            });
            await onAdmissionComplete?.({
                sourceId, kind: 'telegram', itemCount: orderedPosts.length, cachePath, domPath, parserReportPath,
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
                itemCount: orderedPosts.length,
                candidateCount: candidateIds.size,
                structuralCandidateCount,
                databaseSkippedCount,
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
            let processedLastMessageId = Number(state?.lastMessageId ?? 0);
            const processingPosts = orderedPosts
                .filter((post) => !incrementalOnly || !candidateDecisions.get(String(post?.messageId ?? ''))?.incrementalKnown)
                .sort((left, right) => {
                const leftDecision = candidateDecisions.get(String(left?.messageId ?? '')) || {};
                const rightDecision = candidateDecisions.get(String(right?.messageId ?? '')) || {};
                return Number(rightDecision.priority || -1000) - Number(leftDecision.priority || -1000) ||
                    Number(right?.messageId || 0) - Number(left?.messageId || 0);
            });
            const processingResults = await runManualParserPool(
                processingPosts,
                async (post) => {
                    const itemId = String(post.messageId);
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
                            forceReprocess: recoveringLedger,
                            ledgerContext: { sourceId, itemId, runId: ledgerRunId },
                            traceAi: (stage, data = {}) => diagnostics?.log?.(`item.ai.${stage}`, {
                                sourceId,
                                itemId,
                                preview: parserCandidatePreview(post?.text),
                                ...data,
                            }),
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
                    eventsCreatedCount += Number(result?.eventsCreatedCount || 0);
                    eventsUpdatedCount += Number(result?.eventsUpdatedCount || 0);
                    visionCheckedImageCount += Number(result?.visionCheckedImageCount || 0);
                    posterMatchAcceptedCount += Number(result?.posterMatchAcceptedCount || 0);
                    posterMatchRejectedCount += Number(result?.posterMatchRejectedCount || 0);
                    processedLastMessageId = Math.max(
                        processedLastMessageId,
                        Number(post.messageId ?? 0),
                    );
                    return { ...result, candidate };
                },
                {
                    concurrency: processingConcurrency,
                    limiter: processingLimiter,
                    getPriority: (post) => Number(candidateDecisions.get(String(post?.messageId ?? ''))?.priority ?? -1000),
                    onItemState: async (event) => {
                        const itemId = String(event.item?.messageId ?? '');
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
                            kind: 'telegram',
                            itemId,
                            source: `t.me/${channel}`,
                            candidate,
                            priority: Number(event.priority || candidateDecisions.get(itemId)?.priority || 0),
                            reasons: candidateDecisions.get(itemId)?.reasons || [],
                            preview: parserCandidatePreview(event.item?.text),
                        });
                    },
                },
            );
            processingResults.forEach((entry, index) => {
                if (entry?.status !== 'rejected') return;
                const post = processingPosts[index];
                markManualParserSeenItemFailed({
                    sourceId,
                    itemId: String(post?.messageId ?? ''),
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
                eventsCreatedCount,
                eventsUpdatedCount,
                visionCheckedImageCount,
                posterMatchAcceptedCount,
                posterMatchRejectedCount,
                failedProcessingItems,
            });

            const lastMessageId = processedLastMessageId;
            const finishedAt = Math.floor(Date.now() / 1000);

            updateTelegramScraperState({
                channel,
                lastMessageId: failedProcessingItems === 0 && !timedOut
                    ? lastMessageId : Number(state?.lastMessageId ?? 0),
                // Partial processing cannot advance the success cursor: failed
                // items are retryable on the next pass and old events remain.
                lastSuccessAt: failedProcessingItems === 0 && !timedOut
                    ? finishedAt : Number(state?.lastSuccessAt ?? 0),
                lastAttemptAt: startedAt,
                lastError: failedProcessingItems > 0
                    ? `manual-parser-processing-failed:${failedProcessingItems}`
                    : timedOut ? 'manual-parser-deadline-reached' : '',
                initialCompleted: failedProcessingItems === 0 && !timedOut
                    ? initialMode || Boolean(state?.initialCompleted)
                    : Boolean(state?.initialCompleted),
                postsSeen: Number(state?.postsSeen ?? 0) + changedPosts,
                eventsFound: Number(state?.eventsFound ?? 0) + eventsFound,
            });

            console.log(
                '[TG HTML SCRAPER]',
                `channel=@${channel}`,
                `mode=${initialMode ? 'initial' : 'daily'}`,
                `fetched=${posts.length}`,
                `changed=${changedPosts}`,
                `events=${eventsFound}`,
                `lastMessageId=${lastMessageId}`,
            );

            if (keepPageOpen && !stoppedByOwner) {
                startTelegramManualLiveParser({
                    channel,
                    dataDirectory: safeDataDirectory,
                    downloadImages: Boolean(downloadImages),
                    extractEventsWithAi,
                    extractImageFactsWithAi,
                    notifyAttention,
                    timeZone,
                });
            }

            return {
                channel,
                mode: initialMode ? 'initial' : 'daily',
                fetchedPosts: processedPosts,
                changedPosts,
                eventsFound,
                eventsCreatedCount,
                eventsUpdatedCount,
                visionCheckedImageCount,
                posterMatchAcceptedCount,
                posterMatchRejectedCount,
                incrementalKnownSkippedCount,
                incrementalNewCount,
                timedOut,
                lastMessageId,
                stoppedByOwner,
                failedProcessingItems,
            };
        })();

        activeRunPromises.set(channel, runPromise);

        try {
            return await runPromise;
        } catch (error) {
            const previous = getTelegramScraperState(channel);
            const now = Math.floor(Date.now() / 1000);

            updateTelegramScraperState({
                channel,
                lastMessageId: Number(previous?.lastMessageId ?? 0),
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
                console.log('[TG SCRAPER SOURCE TAB CLOSED AFTER PROCESSING]', `channel=@${channel}`);
            }
            activeRunPromises.delete(channel);
        }
    }

    async function runIfDue() {
        const state = getTelegramScraperState(channel);
        const lastSuccessAt = Number(state?.lastSuccessAt ?? 0) * 1000;
        const databaseLooksEmpty = Number(state?.storedPosts ?? 0) === 0;

        if (
            !state?.initialCompleted ||
            databaseLooksEmpty ||
            Date.now() - lastSuccessAt >= intervalMs
        ) {
            return run({
                forceInitial: !state?.initialCompleted || databaseLooksEmpty,
            });
        }

        return null;
    }

    function start() {
        const firstTimer = setTimeout(() => {
            runIfDue().catch((error) => {
                console.error(
                    '[TG HTML INITIAL ERROR]',
                    String(error?.message ?? error),
                );
            });
        }, 1_000);
        firstTimer.unref();

        const timer = setInterval(() => {
            runIfDue().catch((error) => {
                console.error(
                    '[TG HTML DAILY ERROR]',
                    String(error?.message ?? error),
                );
            });
        }, 60 * 60 * 1000);
        timer.unref();

        return timer;
    }

    function getStatus() {
        return getTelegramScraperState(channel);
    }

    function getUpcoming(limit = 10) {
        return getTelegramUpcomingEvents({
            channel,
            limit,
        });
    }

    return {
        channel,
        initialMessages: safeInitialMessages,
        intervalHours: intervalMs / (60 * 60 * 1000),
        getStatus,
        getUpcoming,
        run,
        runIfDue,
        start,
    };
}
