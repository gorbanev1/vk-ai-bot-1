/**
 * Браузерный QTickets-скрейпер для города Воронеж.
 *
 * Проход состоит из двух явно разделённых фаз:
 *  1. открыть страницу города и собрать все ссылки карточек;
 *  2. открыть каждую ссылку в собственной управляемой вкладке и снять detail
 *     HTML. Успешные вкладки по умолчанию остаются открытыми для владельца.
 */
import {
    acquireScraperBrowserActivityLease,
    openScraperPage,
    openScraperTab,
    settleScraperPage,
} from '../../infrastructure/browser/browserGrabber.js';

import {
    prepareEventImages,
} from '../../features/events/eventAssets.js';

import {
    getQticketsUpcomingEvents,
    getQticketsListingCardHashes,
    saveQticketsListingCardHashes,
    replaceQticketsEvents,
} from '../../infrastructure/database/index.js';
import { createParserAttemptPacer } from '../../features/ai/dateFreeParserPolicy.js';
import { createQticketsDomSnapshot } from './qticketsDomSnapshot.js';

import {
    QTICKETS_CITY_URL,
    QTICKETS_SOURCE_NAME,
    QTICKETS_TIME_ZONE,
    mergeQticketsCardAndDetail,
    parseQticketsDetailHtml,
    parseQticketsListingHtml,
    qticketsListingCardHash,
} from '../../features/events/qticketsParser.js';
import {
    qticketsEventHasConflictingCity,
} from '../../features/events/qticketsRouting.js';

const DEFAULT_NAVIGATION_TIMEOUT_MS = 90_000;
const DEFAULT_DETAIL_CONCURRENCY = 6;
const DEFAULT_MAX_CARDS = 500;
const DEFAULT_MAX_MORE_CLICKS = 30;
const DEFAULT_IMAGE_DIRECTORY = 'qtickets_event_announcements';
const MINIMUM_PARSER_PAGE_LIFETIME_MS = 180_000;
const DEFAULT_REFRESH_BACKOFF_MS = 12_000;

function clampInteger(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

function readBoolean(value, fallback) {
    const normalized = String(value ?? '').trim().toLowerCase();
    if (!normalized) return fallback;
    if (['1', 'true', 'yes', 'on', 'да'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'нет'].includes(normalized)) return false;
    return fallback;
}


async function waitForMinimumPageLifetime(page, openedAtMs, minimumMs = MINIMUM_PARSER_PAGE_LIFETIME_MS) {
    if (!page || page.isClosed?.() || !openedAtMs) return;
    const target = Math.max(MINIMUM_PARSER_PAGE_LIFETIME_MS, Number(minimumMs) || 0);
    while (!page.isClosed?.()) {
        const remaining = target - (Date.now() - openedAtMs);
        if (remaining <= 0) return;
        await page.waitForTimeout(Math.min(5_000, remaining)).catch(() => {});
    }
}

async function mapWithConcurrency(items, concurrency, worker) {
    const source = Array.isArray(items) ? items : [];
    const result = new Array(source.length);
    let cursor = 0;
    const workers = Array.from({
        length: Math.min(source.length, Math.max(1, concurrency)),
    }, async () => {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= source.length) return;
            result[index] = await worker(source[index], index);
        }
    });
    await Promise.all(workers);
    return result;
}

async function waitForListingMore(page) {
    const locator = page.locator('a, button').filter({
        hasText: /ещ[её]\s+мероприятия|показать\s+ещ[её]/iu,
    }).first();
    if (!(await locator.count().catch(() => 0))) return false;
    if (!(await locator.isVisible().catch(() => false))) return false;
    await locator.scrollIntoViewIfNeeded().catch(() => {});
    await locator.click({ timeout: 10_000 }).catch(() => null);
    return true;
}

async function collectListingCards(page, {
    listingUrl,
    referenceDate,
    timeZone,
    maxMoreClicks = DEFAULT_MAX_MORE_CLICKS,
} = {}) {
    let html = await page.content();
    let cards = parseQticketsListingHtml(html, {
        baseUrl: listingUrl,
        referenceDate,
        timeZone,
    });
    const audit = {
        initialHtmlBytes: Buffer.byteLength(html, 'utf8'),
        initialNumericDetailLinks: countNumericDetailLinks(html, listingUrl),
        moreClicks: 0,
        stagnantClicks: 0,
        rounds: [{ numericDetailLinks: countNumericDetailLinks(html, listingUrl), parsedCards: cards.length }],
        capReached: false,
    };
    let stalledClicks = 0;

    for (let click = 0; click < maxMoreClicks; click += 1) {
        const clicked = await waitForListingMore(page);
        if (!clicked) break;
        audit.moreClicks += 1;
        await page.waitForTimeout(800);
        html = await page.content();
        const next = parseQticketsListingHtml(html, {
            baseUrl: listingUrl,
            referenceDate,
            timeZone,
        });
        audit.rounds.push({ numericDetailLinks: countNumericDetailLinks(html, listingUrl), parsedCards: next.length });
        if (next.length <= cards.length) {
            stalledClicks += 1;
            audit.stagnantClicks += 1;
            if (stalledClicks >= 2) break;
        } else {
            stalledClicks = 0;
            cards = next;
        }
    }
    audit.capReached = audit.moreClicks >= maxMoreClicks;

    return {
        html,
        cards,
        audit,
    };
}

function countNumericDetailLinks(html, baseUrl = QTICKETS_CITY_URL) {
    const links = String(html ?? '').match(/<a\b[^>]*>/giu) || [];
    let count = 0;
    for (const tag of links) {
        const href = tag.match(/\bhref\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/iu);
        const target = String(href?.[1] || href?.[2] || href?.[3] || '').trim();
        const resolved = (() => { try { return new URL(target, baseUrl); } catch { return null; } })();
        if (!resolved || !/\.qtickets\.events$/iu.test(resolved.hostname)) continue;
        if (/\/(?:\d+)(?:-|$)/u.test(resolved.pathname)) count += 1;
    }
    return count;
}

async function parseOneDetailCard(card, index, {
    listingUrl,
    dataDirectory,
    notifyAttention,
    timeZone,
    referenceDate,
    keepEventTabsOpen,
    navigationTimeoutMs,
    beforeAttempt,
    domSnapshot,
} = {}) {
    const sourceLabel = `${QTICKETS_SOURCE_NAME} · карточка ${index + 1}`;
    let page = null;
    let detailTabsOpened = 0;
    let openedAtMs = 0;
    try {
        await beforeAttempt?.('text');
        page = await openScraperTab({
            url: card.detailUrl,
            source: sourceLabel,
            dataDirectory,
            notifyAttention,
            waitUntil: 'domcontentloaded',
            navigationTimeoutMs,
            bringToFront: false,
        });
        detailTabsOpened = 1;
        openedAtMs = Date.now();
        await page.waitForLoadState('networkidle', { timeout: 8_000 }).catch(() => {});
        await page.waitForSelector('h1, main, body', { timeout: 15_000 }).catch(() => {});
        await page.waitForTimeout(350);

        const html = await page.content();
        domSnapshot?.savePage({
            kind: 'detail',
            url: card.detailUrl,
            html,
            metadata: {
                id: card.externalId || `card-${index + 1}`,
                title: card.title || '',
                cardIndex: index + 1,
                parseStage: 'captured-before-parse',
            },
        });
        const detail = parseQticketsDetailHtml(html, card.detailUrl, {
            referenceDate,
            timeZone,
            fallbackCard: card,
        });
        let event = mergeQticketsCardAndDetail(card, detail, { listingUrl });

        const imageUrls = Array.isArray(event.imageUrls)
            ? event.imageUrls.slice(0, 1)
            : [];
        if (imageUrls.length) {
            try {
                const [prepared] = await prepareEventImages({
                    events: [{ ...event, imagePaths: [], imageIndexes: [1] }],
                    sourceKey: 'qtickets-voronezh',
                    itemId: event.externalId || `card-${index + 1}`,
                    imageUrls,
                    dataDirectory,
                    targetFolder: DEFAULT_IMAGE_DIRECTORY,
                    sourceLabel: QTICKETS_SOURCE_NAME,
                    notifyAttention,
                    maxSourceImages: 1,
                    generateFallback: false,
                });
                if (prepared) event = prepared;
            } catch (error) {
                console.warn(
                    '[QTICKETS IMAGE ERROR]',
                    `url=${card.detailUrl}`,
                    String(error?.message ?? error),
                );
            }
        }

        return {
            event: mergeQticketsCardAndDetail(card, {
                ...event,
                listingUrl,
            }, { listingUrl }),
            detailTabsOpened,
            error: null,
        };
    } catch (error) {
        if (page && !page.isClosed()) {
            const errorHtml = await page.content().catch(() => '');
            if (errorHtml) {
                domSnapshot?.savePage({
                    kind: 'detail-error',
                    url: card.detailUrl,
                    html: errorHtml,
                    metadata: {
                        id: card.externalId || `card-${index + 1}`,
                        title: card.title || '',
                        cardIndex: index + 1,
                        error: String(error?.message ?? error),
                    },
                });
            }
        }
        domSnapshot?.record({
            kind: 'detail-error',
            url: card.detailUrl,
            metadata: {
                id: card.externalId || `card-${index + 1}`,
                title: card.title || '',
                cardIndex: index + 1,
                error: String(error?.message ?? error),
            },
        });
        console.warn(
            '[QTICKETS DETAIL ERROR]',
            `url=${card.detailUrl}`,
            String(error?.message ?? error),
        );
        return {
            event: mergeQticketsCardAndDetail(card, {
                ...card,
                parseMethod: 'qtickets-card-fallback-after-detail-error',
                sourceText: card.sourceText,
                listingUrl,
            }, { listingUrl }),
            detailTabsOpened,
            error,
        };
    } finally {
        if (!keepEventTabsOpen && page && !page.isClosed()) {
            await waitForMinimumPageLifetime(page, openedAtMs);
            await page.close().catch(() => {});
        }
    }
}

export function createQticketsScraper({
    cityUrl = QTICKETS_CITY_URL,
    dataDirectory = './data',
    notifyAttention,
    timeZone = QTICKETS_TIME_ZONE,
    keepEventTabsOpen = readBoolean(process.env.QTICKETS_KEEP_EVENT_TABS_OPEN, true),
    detailConcurrency = clampInteger(
        process.env.QTICKETS_DETAIL_CONCURRENCY,
        1,
        20,
        DEFAULT_DETAIL_CONCURRENCY,
    ),
    maxCards = clampInteger(
        process.env.QTICKETS_MAX_CARDS,
        1,
        2000,
        DEFAULT_MAX_CARDS,
    ),
    maxMoreClicks = clampInteger(
        process.env.QTICKETS_MAX_MORE_CLICKS,
        1,
        100,
        DEFAULT_MAX_MORE_CLICKS,
    ),
    navigationTimeoutMs = clampInteger(
        process.env.QTICKETS_NAVIGATION_TIMEOUT_MS,
        5_000,
        180_000,
        DEFAULT_NAVIGATION_TIMEOUT_MS,
    ),
} = {}) {
    const listingUrl = String(cityUrl || QTICKETS_CITY_URL).trim() || QTICKETS_CITY_URL;

    return {
        id: 'qtickets:voronezh',
        label: QTICKETS_SOURCE_NAME,
        url: listingUrl,
        async run({
            keepEventTabsOpen: keepTabs = keepEventTabsOpen,
            refreshListing = true,
            incrementalOnly = false,
            turboMode = 'turbo3',
        } = {}) {
            const releaseLease = acquireScraperBrowserActivityLease({
                reason: 'qtickets-voronezh',
            });
            const runId = new Date().toISOString().replace(/[:.]/gu, '-') + `-${Math.random().toString(16).slice(2, 8)}`;
            const domSnapshot = createQticketsDomSnapshot({ dataDirectory, runId });
            let runStatus = 'failed';
            const runMetrics = { listingUrl, incrementalOnly: Boolean(incrementalOnly), turboMode: turboMode || 'turbo3' };
            let listingPage = null;
            let listingOpenedAtMs = 0;
            try {
                listingPage = await openScraperPage({
                    url: listingUrl,
                    source: QTICKETS_SOURCE_NAME,
                    dataDirectory,
                    notifyAttention,
                    waitUntil: 'domcontentloaded',
                    reuseKey: 'qtickets:voronezh:listing',
                    navigationTimeoutMs,
                });
                listingOpenedAtMs = Date.now();
                if (refreshListing) {
                    // Wait the required 10–15 seconds, then reload ONLY if the
                    // page still has no positive render evidence. A real scroll
                    // range means the listing DOM has loaded and must not be
                    // destroyed by a recovery refresh just because selectors
                    // changed.
                    const refreshBackoffMs = clampInteger(
                        process.env.QTICKETS_REFRESH_BACKOFF_MS,
                        10_000,
                        15_000,
                        DEFAULT_REFRESH_BACKOFF_MS,
                    );
                    await listingPage.waitForTimeout(refreshBackoffMs).catch(() => {});
                    const loadEvidence = await listingPage.evaluate(() => {
                        const root = document.scrollingElement || document.documentElement || document.body;
                        const scrollable = Number(root?.scrollHeight || 0) > Number(root?.clientHeight || window.innerHeight || 0) + 40;
                        const eventLinks = document.querySelectorAll('a[href*="qtickets.events/"]').length;
                        return { scrollable, eventLinks };
                    }).catch(() => ({ scrollable: false, eventLinks: 0 }));
                    if (!loadEvidence.scrollable && Number(loadEvidence.eventLinks || 0) === 0) {
                        await listingPage.reload({
                            waitUntil: 'domcontentloaded',
                            timeout: navigationTimeoutMs,
                        }).catch(() => {});
                        await listingPage.waitForTimeout(refreshBackoffMs).catch(() => {});
                    } else {
                        console.log(
                            '[QTICKETS REFRESH SKIPPED]',
                            `scroll=${loadEvidence.scrollable ? 'yes' : 'no'}`,
                            `links=${Number(loadEvidence.eventLinks || 0)}`,
                        );
                    }
                }
                await settleScraperPage({
                    page: listingPage,
                    source: QTICKETS_SOURCE_NAME,
                    scrollSteps: 4,
                    scrollDelayMs: 400,
                    mediaWaitMs: 4_000,
                });

                const referenceDate = new Date();
                const collected = await collectListingCards(listingPage, {
                    listingUrl,
                    referenceDate,
                    timeZone,
                    maxMoreClicks,
                });
                const listingSnapshot = domSnapshot.savePage({
                    kind: 'listing',
                    url: listingUrl,
                    html: collected.html,
                    metadata: {
                        parsedCardCount: collected.cards.length,
                        audit: collected.audit,
                        parseStage: 'fully-expanded-listing',
                    },
                });
                runMetrics.listingSnapshot = listingSnapshot;
                runMetrics.listingCardCount = collected.cards.length;
                runMetrics.listingAudit = collected.audit;
                const cards = collected.cards.slice(0, maxCards);
                const oldHashes = incrementalOnly
                    ? getQticketsListingCardHashes(cards.map((card) => card.detailUrl))
                    : new Map();
                const hashCard = qticketsListingCardHash;
                const cardsToOpen = incrementalOnly ? cards.filter((card) => {
                    const previousHash = oldHashes.get(card.detailUrl);
                    return previousHash !== hashCard(card);
                }) : cards;
                const skippedUnchanged = cards.length - cardsToOpen.length;
                const beforeAttempt = createParserAttemptPacer({ mode: turboMode || 'turbo3' });
                console.log(
                    '[QTICKETS LISTING CAPTURED]',
                    `url=${listingUrl}`,
                    `cards=${collected.cards.length}`,
                    `selected=${cards.length}`,
                    `incremental=${Boolean(incrementalOnly)}`,
                    `unchangedSkipped=${skippedUnchanged}`,
                    `turbo=${turboMode || 'default'}`,
                    `domRounds=${collected.audit.rounds.length}`,
                    `domLinksInitial=${collected.audit.initialNumericDetailLinks}`,
                    `domLinksFinal=${collected.audit.rounds.at(-1)?.numericDetailLinks || 0}`,
                    `domMoreClicks=${collected.audit.moreClicks}`,
                    `domCapReached=${collected.audit.capReached}`,
                    `maxMoreClicks=${maxMoreClicks}`,
                );
                const listingParseMethods = cards.reduce((counts, card) => {
                    const method = String(card.parseMethod || 'unknown');
                    counts[method] = Number(counts[method] || 0) + 1;
                    return counts;
                }, {});
                console.log('[QTICKETS DOM AUDIT]', JSON.stringify({ ...collected.audit, parsedCards: cards.length, listingParseMethods }));

                const detailResults = await mapWithConcurrency(
                    cardsToOpen,
                    detailConcurrency,
                    (card, index) => parseOneDetailCard(card, index, {
                        listingUrl,
                        dataDirectory,
                        notifyAttention,
                        timeZone,
                        referenceDate,
                        keepEventTabsOpen: Boolean(keepTabs),
                        navigationTimeoutMs,
                        beforeAttempt,
                        domSnapshot,
                    }),
                );
                const cachedByUrl = new Map(incrementalOnly
                    ? getQticketsUpcomingEvents({ fromDate: '0000-00-00', limit: 2000 }).map((event) => [event.detailUrl, event])
                    : []);
                const unchangedEvents = incrementalOnly ? cards
                    .filter((card) => oldHashes.get(card.detailUrl) === hashCard(card) && cachedByUrl.has(card.detailUrl))
                    .map((card) => cachedByUrl.get(card.detailUrl))
                    .filter(Boolean) : [];
                const currentDate = new Intl.DateTimeFormat('en-CA', {
                    timeZone, year: 'numeric', month: '2-digit', day: '2-digit',
                }).format(new Date());
                const parsedEvents = [...unchangedEvents, ...detailResults
                    .map((result) => result?.event)
                    .filter((event) => String(event?.eventDate ?? '').trim())];
                const cardByUrl = new Map(cards.map((card) => [card.detailUrl, card]));
                const successfulDetailUrls = new Set(detailResults
                    .filter((result) => !result?.error && result?.event?.detailUrl)
                    .map((result) => String(result.event.detailUrl)));
                for (const event of parsedEvents) {
                    const card = cardByUrl.get(String(event.detailUrl || event.sourceUrl || ''));
                    if (card && successfulDetailUrls.has(String(event.detailUrl || ''))) event.listingCardHash = hashCard(card);
                }
                const futureEvents = parsedEvents.filter((event) => String(event.eventDate) >= currentDate);
                const cityRejected = futureEvents.filter(qticketsEventHasConflictingCity).length;
                const pastRejected = parsedEvents.length - futureEvents.length;
                const events = futureEvents.filter((event) => !qticketsEventHasConflictingCity(event));
                const successfulCards = cards
                    .filter((card) => successfulDetailUrls.has(card.detailUrl))
                    .map((card) => ({ detailUrl: card.detailUrl, cardHash: hashCard(card) }));
                const processedCardsSaved = saveQticketsListingCardHashes(successfulCards, { listingUrl });
                const storage = replaceQticketsEvents(events, {
                    listingUrl,
                });
                const errors = detailResults.filter((result) => result?.error).length;
                runMetrics.selectedCards = cards.length;
                runMetrics.detailCardsOpened = cardsToOpen.length;
                runMetrics.detailErrors = errors;
                runMetrics.eventsParsed = events.length;
                runMetrics.eventsStored = events.length;
                const detailTabsOpened = detailResults.reduce(
                    (sum, result) => sum + Number(result?.detailTabsOpened || 0),
                    0,
                );

                console.log(
                    '[QTICKETS SCRAPER COMPLETE]',
                    `cards=${cards.length}`,
                    `tabs=${detailTabsOpened}`,
                    `events=${events.length}`,
                    `cityRejected=${cityRejected}`,
                    `pastRejected=${pastRejected}`,
                    `errors=${errors}`,
                    `inserted=${storage.inserted}`,
                    `updated=${storage.updated}`,
                    `ignored=${storage.ignored}`,
                    `processedCards=${processedCardsSaved}`,
                    `tabsKeptOpen=${Boolean(keepTabs)}`,
                );
                runStatus = errors ? 'completed-with-detail-errors' : 'completed';
                return {
                    ok: true,
                    listingUrl,
                    listingPageOpen: Boolean(listingPage && !listingPage.isClosed()),
                    listingCards: collected.cards.length,
                    selectedCards: cards.length,
                    detailCardsOpened: cardsToOpen.length,
                    unchangedCardsSkipped: skippedUnchanged,
                    processedCardsSaved,
                    detailTabsOpened,
                    eventsParsed: events.length,
                    cityRejected,
                    pastRejected,
                    detailErrors: errors,
                    tabsKeptOpen: Boolean(keepTabs),
                    storage,
                };
            } catch (error) {
                runMetrics.fatalError = String(error?.message ?? error);
                throw error;
            } finally {
                const snapshotResult = domSnapshot.finish(runStatus, runMetrics);
                console.log('[QTICKETS DOM SNAPSHOT]', JSON.stringify(snapshotResult));
                if (!keepTabs && listingPage && !listingPage.isClosed()) {
                    await waitForMinimumPageLifetime(listingPage, listingOpenedAtMs);
                    await listingPage.close().catch(() => {});
                }
                releaseLease();
            }
        },
        getUpcoming({ fromDate = '0000-00-00', limit = 500 } = {}) {
            return getQticketsUpcomingEvents({ fromDate, limit });
        },
    };
}

