/**
 * Единый постоянный Playwright-контекст для ручного просмотра и скрейперов. Вкладки намеренно могут оставаться открытыми для проверки владельцем.
 */
import {
    existsSync,
    mkdirSync,
    writeFileSync,
} from 'node:fs';
import {
    join,
    resolve,
} from 'node:path';

import { chromium } from 'playwright';

import {
    isScraperTargetClosedError,
} from '../../features/scrapers/browserRecoveryPolicy.js';

import {
    extractVkExactWallPostsFromBootstrap,
    extractVkStructuredBootstrapSourcesFromHtml,
    extractVkStructuredEventsFromBootstrap,
    formatVkStructuredEventEvidence,
} from '../../features/events/vkStructuredEventEvidence.js';

const DEFAULT_TIMEOUT_MS = 90_000;
const MANUAL_WAIT_MS = 15 * 60 * 1000;
const MANUAL_EVENT_AUTO_POST_LIMIT = 20;
const EVENT_REVIEW_MINIMUM_OPEN_MS = 180_000;
const EVENT_REVIEW_MEDIA_WAIT_MS = 20_000;

let contextPromise = null;
let contextDirectory = '';
let attentionCallback = null;
const reusablePages = new Map();
const managedPages = new Set();
const intentionalContextCloses = new WeakSet();
let browserCloseGeneration = 0;
let browserActivityLeases = 0;
let orphanCleanupTimer = null;
const configuredBrowserIdleCloseMs = Number(process.env.SCRAPER_BROWSER_IDLE_CLOSE_MS);
const ORPHAN_BROWSER_IDLE_CLOSE_MS = Number.isFinite(configuredBrowserIdleCloseMs)
    ? Math.max(10 * 60_000, Math.trunc(configuredBrowserIdleCloseMs))
    : 10 * 60_000;
const configuredPostParserBlankCloseMs = Number(process.env.SCRAPER_POST_PARSER_BLANK_CLOSE_MS);
const POST_PARSER_BLANK_CLOSE_MS = Number.isFinite(configuredPostParserBlankCloseMs)
    ? Math.max(500, Math.min(15_000, Math.trunc(configuredPostParserBlankCloseMs)))
    : 1500;

function scheduleOrphanBrowserCleanup(context, delayMs = ORPHAN_BROWSER_IDLE_CLOSE_MS) {
    if (orphanCleanupTimer) {
        clearTimeout(orphanCleanupTimer);
        orphanCleanupTimer = null;
    }

    orphanCleanupTimer = setTimeout(async () => {
        orphanCleanupTimer = null;
        if (browserActivityLeases > 0 || managedPages.size > 0) return;
        try {
            const pages = context.pages().filter((page) => !page.isClosed());
            const meaningfulPages = pages.filter((page) => {
                const url = String(page.url?.() ?? '');
                return url && url !== 'about:blank' && url !== 'chrome://newtab/';
            });
            if (meaningfulPages.length > 0) return;

            console.log(
                '[SCRAPER BROWSER IDLE CLOSE]',
                `idleMs=${Math.max(0, Number(delayMs) || 0)}`,
                'no active scraper lease or meaningful source page remains',
            );
            intentionalContextCloses.add(context);
            await context.close().catch(() => {});
        } catch {
            // Context уже закрыт владельцем/Chrome — дополнительная очистка не нужна.
        }
    }, Math.max(0, Number(delayMs) || ORPHAN_BROWSER_IDLE_CLOSE_MS));
    orphanCleanupTimer.unref?.();
}

function attachManagedPage(context, page) {
    if (!page || managedPages.has(page)) return;
    managedPages.add(page);
    page.once('close', () => {
        managedPages.delete(page);
        scheduleOrphanBrowserCleanup(
            context,
            browserActivityLeases === 0
                ? POST_PARSER_BLANK_CLOSE_MS
                : ORPHAN_BROWSER_IDLE_CLOSE_MS,
        );
    });
}

/**
 * Держит persistent Chromium живым на всём протяжении источника, включая
 * обработку уже снятого DOM, скачивание картинок и vision/AI. Без lease раннее
 * закрытие последней вкладки могло через доли секунды закрыть context, после
 * чего image fallback снова запускал пустой Chromium и parser-all выглядел
 * зависшим.
 */
export function acquireScraperBrowserActivityLease({ reason = '' } = {}) {
    browserActivityLeases += 1;
    if (orphanCleanupTimer) {
        clearTimeout(orphanCleanupTimer);
        orphanCleanupTimer = null;
    }
    console.log(
        '[SCRAPER BROWSER LEASE ACQUIRE]',
        `active=${browserActivityLeases}`,
        `reason=${String(reason || 'scraper-run')}`,
    );

    let released = false;
    return () => {
        if (released) return;
        released = true;
        browserActivityLeases = Math.max(0, browserActivityLeases - 1);
        console.log(
            '[SCRAPER BROWSER LEASE RELEASE]',
            `active=${browserActivityLeases}`,
            `reason=${String(reason || 'scraper-run')}`,
        );
        if (browserActivityLeases !== 0) return;
        const currentPromise = contextPromise;
        if (!currentPromise) return;
        void currentPromise.then((context) => {
            if (context) scheduleOrphanBrowserCleanup(context, POST_PARSER_BLANK_CLOSE_MS);
        }).catch(() => {});
    };
}

function readBoolean(value, fallback = false) {
    const normalized = String(value ?? '').trim().toLowerCase();

    if (!normalized) return fallback;
    if (['1', 'true', 'yes', 'on', 'да'].includes(normalized)) return true;
    if (['0', 'false', 'no', 'off', 'нет'].includes(normalized)) return false;
    return fallback;
}

function normalizeBodyText(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim()
        .toLowerCase();
}

function findInstalledBrowserExecutable() {
    const configured = String(
        process.env.SCRAPER_BROWSER_EXECUTABLE_PATH ?? '',
    ).trim();
    const candidates = [
        configured,
        '/usr/bin/chromium',
        '/usr/bin/chromium-browser',
        '/usr/bin/google-chrome',
        '/usr/bin/google-chrome-stable',
        process.env.PROGRAMFILES
            ? join(process.env.PROGRAMFILES, 'Google', 'Chrome', 'Application', 'chrome.exe')
            : '',
        process.env['PROGRAMFILES(X86)']
            ? join(process.env['PROGRAMFILES(X86)'], 'Google', 'Chrome', 'Application', 'chrome.exe')
            : '',
        process.env.LOCALAPPDATA
            ? join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe')
            : '',
        process.env.PROGRAMFILES
            ? join(process.env.PROGRAMFILES, 'Microsoft', 'Edge', 'Application', 'msedge.exe')
            : '',
        process.env['PROGRAMFILES(X86)']
            ? join(process.env['PROGRAMFILES(X86)'], 'Microsoft', 'Edge', 'Application', 'msedge.exe')
            : '',
    ].filter(Boolean);

    return candidates.find((candidate) => existsSync(candidate)) || '';
}

async function launchContext(dataDirectory) {
    const profileDirectory = resolve(
        dataDirectory,
        'scraper-browser-profile',
    );
    mkdirSync(profileDirectory, { recursive: true });

    const headless = readBoolean(
        process.env.SCRAPER_BROWSER_HEADLESS,
        false,
    );

    const executablePath = findInstalledBrowserExecutable();
    const context = await chromium.launchPersistentContext(
        profileDirectory,
        {
            ...(executablePath ? { executablePath } : {}),
            headless,
            viewport: headless
                ? { width: 1440, height: 1100 }
                : null,
            locale: 'ru-RU',
            timezoneId: 'Europe/Moscow',
            acceptDownloads: true,
            ignoreHTTPSErrors: false,
        },
    );

    context.setDefaultTimeout(30_000);
    context.setDefaultNavigationTimeout(DEFAULT_TIMEOUT_MS);

    context.once('close', () => {
        if (orphanCleanupTimer) {
            clearTimeout(orphanCleanupTimer);
            orphanCleanupTimer = null;
        }
        const intentional = intentionalContextCloses.has(context);
        if (!intentional) {
            browserCloseGeneration += 1;
            console.log(
                '[SCRAPER OWNER STOP]',
                `generation=${browserCloseGeneration}`,
                'persistent browser context was closed outside scraper cleanup',
            );
        }
        contextPromise = null;
        contextDirectory = '';
    });

    return context;
}

async function isBrowserContextUsable(context) {
    if (!context) return false;

    try {
        const browser = context.browser?.();
        if (browser && typeof browser.isConnected === 'function' && !browser.isConnected()) {
            return false;
        }

        // cookies() — дешёвая CDP-операция, которая надёжно падает, если
        // persistent context уже умер, даже если событие `close` ещё не успело
        // обнулить contextPromise.
        await context.cookies();
        return true;
    } catch {
        return false;
    }
}

export async function getScraperBrowserContext({
    dataDirectory,
    notifyAttention,
}) {
    const safeDirectory = resolve(String(dataDirectory ?? './data'));

    if (typeof notifyAttention === 'function') {
        attentionCallback = notifyAttention;
    }

    if (contextPromise && contextDirectory === safeDirectory) {
        const existingContext = await contextPromise.catch(() => null);
        if (await isBrowserContextUsable(existingContext)) {
            return existingContext;
        }

        console.warn(
            '[SCRAPER BROWSER RECOVERY]',
            'cached persistent context is dead; relaunching',
        );
        contextPromise = null;
        contextDirectory = '';
    }

    if (!contextPromise || contextDirectory !== safeDirectory) {
        contextDirectory = safeDirectory;
        contextPromise = launchContext(safeDirectory).catch((error) => {
            contextPromise = null;
            contextDirectory = '';
            throw error;
        });
    }

    return contextPromise;
}

export function getScraperBrowserCloseGeneration() {
    return browserCloseGeneration;
}

export async function resetDeadScraperBrowserContext({
    reason = '',
} = {}) {
    const existingPromise = contextPromise;
    const existingContext = existingPromise
        ? await existingPromise.catch(() => null)
        : null;

    if (existingContext && await isBrowserContextUsable(existingContext)) {
        // Живой контекст специально не закрываем: в нём могут находиться
        // вкладки, которые владелец оставил для ручного просмотра.
        return false;
    }

    contextPromise = null;
    contextDirectory = '';
    console.warn(
        '[SCRAPER BROWSER RECOVERY]',
        `dead context reset${reason ? ` reason=${reason}` : ''}`,
    );
    return true;
}


export async function forceCloseScraperBrowserContext({
    reason = '',
} = {}) {
    const existingPromise = contextPromise;
    const existingContext = existingPromise
        ? await existingPromise.catch(() => null)
        : null;

    // Сбрасываем ссылки до close(), чтобы новые команды не переиспользовали
    // контекст, который уже принудительно завершается по дедлайну парсера.
    contextPromise = null;
    contextDirectory = '';
    reusablePages.clear();

    if (!existingContext) {
        return false;
    }

    console.warn(
        '[SCRAPER BROWSER FORCE CLOSE]',
        `reason=${reason || 'manual-parser-deadline'}`,
    );

    try {
        intentionalContextCloses.add(existingContext);
        await existingContext.close();
    } catch {
        // Если пользователь уже закрыл Chromium, это нормальное завершение.
    }

    managedPages.clear();
    browserCloseGeneration += 1;
    return true;
}

async function inspectAccessState(page, source) {
    const url = page.url().toLowerCase();
    const bodyText = normalizeBodyText(
        await page.locator('body').innerText().catch(() => ''),
    );

    const commonChallenge = [
        'captcha',
        'капча',
        'verify you are human',
        'подтвердите, что вы не робот',
        'проверка безопасности',
        'security check',
        'unusual activity',
        'слишком много запросов',
        'подтвердите действие',
    ].some((marker) => bodyText.includes(marker));

    const challengeUrl = [
        'captcha',
        'challenge',
        'verify',
        'security_check',
    ].some((marker) => url.includes(marker));

    if (commonChallenge || challengeUrl) {
        return {
            blocked: true,
            reason: 'защитная проверка или CAPTCHA',
        };
    }

    if (String(source).toUpperCase().startsWith('VK')) {
        const hasWallLink = await page
            .locator('a[href*="wall"]')
            .count()
            .catch(() => 0);
        const loginUrl = /(?:login|authorize|oauth)/u.test(url);
        const loginText = [
            'войти в vk',
            'вход вконтакте',
            'введите телефон или почту',
            'sign in to vk',
        ].some((marker) => bodyText.includes(marker));

        if ((loginUrl || loginText) && hasWallLink === 0) {
            return {
                blocked: true,
                reason: 'требуется вход в VK',
            };
        }
    }

    return {
        blocked: false,
        reason: '',
    };
}

async function saveAttentionArtifacts(page, source, dataDirectory) {
    const directory = resolve(
        dataDirectory,
        'scraper-captcha',
    );
    mkdirSync(directory, { recursive: true });

    const stamp = Date.now();
    const safeSource = String(source)
        .toLowerCase()
        .replace(/[^a-z0-9_-]+/gu, '-');
    const screenshotPath = join(
        directory,
        `${safeSource}-${stamp}.png`,
    );
    const htmlPath = join(
        directory,
        `${safeSource}-${stamp}.html`,
    );

    await page.screenshot({
        path: screenshotPath,
        fullPage: true,
    });
    writeFileSync(htmlPath, await page.content(), 'utf8');

    return {
        screenshotPath,
        htmlPath,
    };
}

export async function waitForManualAccess({
    page,
    source,
    dataDirectory,
    timeoutMs = MANUAL_WAIT_MS,
}) {
    let state = await inspectAccessState(page, source);

    if (!state.blocked) {
        return;
    }

    const artifacts = await saveAttentionArtifacts(
        page,
        source,
        dataDirectory,
    );

    await page.bringToFront().catch(() => {});

    const message = [
        `⚠️ ${source}: ${state.reason}.`,
        'На компьютере открыто окно Chromium.',
        'Пройди вход или проверку вручную в этом окне.',
        'После успешного прохождения грабер продолжит работу сам.',
    ].join('\n');

    console.warn('[SCRAPER MANUAL ACTION]', message);
    console.warn('[SCRAPER SCREENSHOT]', artifacts.screenshotPath);

    if (typeof attentionCallback === 'function') {
        await attentionCallback({
            source,
            message,
            screenshotPath: artifacts.screenshotPath,
            htmlPath: artifacts.htmlPath,
        }).catch((error) => {
            console.error(
                '[SCRAPER ATTENTION NOTIFY ERROR]',
                String(error?.message ?? error),
            );
        });
    }

    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
        await page.waitForTimeout(2500);
        state = await inspectAccessState(page, source);

        if (!state.blocked) {
            await page.waitForTimeout(1500);
            return;
        }
    }

    throw new Error(
        `${source}: ручная проверка не пройдена за ` +
        `${Math.round(timeoutMs / 60_000)} минут.`,
    );
}

async function closeUnexpectedBlankScraperPages(context, keepPage) {
    if (!context) return 0;
    const blanks = context.pages().filter((candidate) => (
        candidate !== keepPage &&
        !candidate.isClosed() &&
        !managedPages.has(candidate) &&
        ['about:blank', 'chrome://newtab/'].includes(String(candidate.url?.() ?? ''))
    ));
    if (!blanks.length) return 0;

    await Promise.all(blanks.map((candidate) => candidate.close().catch(() => {})));
    console.log(
        '[SCRAPER BLANK TAB CLEANUP]',
        `closed=${blanks.length}`,
        'kept only the active source page',
    );
    return blanks.length;
}

export async function openScraperPage({
    url,
    source,
    dataDirectory,
    notifyAttention,
    waitUntil = 'domcontentloaded',
    reuseKey = '',
    navigationTimeoutMs = DEFAULT_TIMEOUT_MS,
    manualAccessTimeoutMs = MANUAL_WAIT_MS,
}) {
    const context = await getScraperBrowserContext({
        dataDirectory,
        notifyAttention,
    });
    const normalizedReuseKey = String(reuseKey ?? '').trim();
    let page = normalizedReuseKey ? reusablePages.get(normalizedReuseKey) : null;

    if (page?.isClosed?.()) {
        reusablePages.delete(normalizedReuseKey);
        page = null;
    }
    if (!page) {
        /*
         * launchPersistentContext() обычно сам создаёт первую about:blank
         * вкладку. Раньше мы поверх неё всегда делали context.newPage(), из-за
         * чего рядом с рабочим источником постоянно висела пустая вкладка, а
         * после закрытия источника владелец видел пустое окно Chrome. Для
         * ручного reusable-источника забираем стартовую пустую вкладку себе.
         */
        // Всегда забираем уже существующую пустую стартовую вкладку, а не
        // создаём поверх неё новую. Это важно и для конечного parser-all:
        // context.request может ещё работать после закрытия source tabs, но
        // пользователь не должен видеть бесконечные пустые окна Chromium.
        page = context.pages().find((candidate) => (
            !candidate.isClosed() &&
            !managedPages.has(candidate) &&
            ['about:blank', 'chrome://newtab/'].includes(String(candidate.url?.() ?? ''))
        )) || null;
        if (!page) page = await context.newPage();

        attachManagedPage(context, page);
        if (normalizedReuseKey) {
            reusablePages.set(normalizedReuseKey, page);
            page.once('close', () => {
                if (reusablePages.get(normalizedReuseKey) === page) {
                    reusablePages.delete(normalizedReuseKey);
                }
            });
        }
    } else {
        attachManagedPage(context, page);
    }

    try {
        const currentUrl = String(page.url?.() ?? '');
        if (!currentUrl || currentUrl === 'about:blank' || currentUrl !== String(url)) {
            await page.goto(url, {
                waitUntil,
                timeout: Math.max(5_000, Number(navigationTimeoutMs) || DEFAULT_TIMEOUT_MS),
            });
        }
        await waitForManualAccess({
            page,
            source,
            dataDirectory,
            timeoutMs: Math.max(5_000, Number(manualAccessTimeoutMs) || MANUAL_WAIT_MS),
        });
        await closeUnexpectedBlankScraperPages(context, page);
        if (normalizedReuseKey) await page.bringToFront().catch(() => {});
        return page;
    } catch (error) {
        if (normalizedReuseKey && reusablePages.get(normalizedReuseKey) === page) {
            reusablePages.delete(normalizedReuseKey);
        }
        await page.close().catch(() => {});
        throw error;
    }
}

/**
 * Открывает отдельную управляемую вкладку, не трогая остальные вкладки
 * постоянного scraper-контекста. Нужна источникам вроде QTickets, где
 * сначала снимается список ссылок, а затем каждая карточка должна быть
 * реально открыта в собственной вкладке для проверки и парсинга.
 */
export async function openScraperTab({
    url,
    source,
    dataDirectory,
    notifyAttention,
    waitUntil = 'domcontentloaded',
    navigationTimeoutMs = DEFAULT_TIMEOUT_MS,
    manualAccessTimeoutMs = MANUAL_WAIT_MS,
    bringToFront = false,
}) {
    const context = await getScraperBrowserContext({
        dataDirectory,
        notifyAttention,
    });
    const page = await context.newPage();
    attachManagedPage(context, page);

    try {
        await page.goto(url, {
            waitUntil,
            timeout: Math.max(5_000, Number(navigationTimeoutMs) || DEFAULT_TIMEOUT_MS),
        });
        await waitForManualAccess({
            page,
            source,
            dataDirectory,
            timeoutMs: Math.max(5_000, Number(manualAccessTimeoutMs) || MANUAL_WAIT_MS),
        });
        if (bringToFront) await page.bringToFront().catch(() => {});
        return page;
    } catch (error) {
        await page.close().catch(() => {});
        throw error;
    }
}



export async function openPinnedScraperPage({
    url,
    source,
    dataDirectory = './data',
    notifyAttention,
    scrollSteps = 0,
    mediaWaitMs = 0,
}) {
    const page = await openScraperPage({
        url,
        source,
        dataDirectory,
        notifyAttention,
        waitUntil: 'domcontentloaded',
        reuseKey: `pinned:${source}:${url}`,
    });

    if (scrollSteps > 0 || mediaWaitMs > 0) {
        await settleScraperPage({
            page,
            source,
            scrollSteps,
            scrollDelayMs: 500,
            mediaWaitMs,
            holdMs: 0,
        });
    }

    await page.bringToFront().catch(() => {});
    console.warn(
        '[SCRAPER PINNED TAB OPEN]',
        `source=${source}`,
        `url=${page.url()}`,
        'autoClose=false',
    );

    page.once('close', () => {
        console.log(
            '[SCRAPER PINNED TAB CLOSED BY USER/CHROME]',
            `source=${source}`,
        );
    });

    // ВАЖНО: намеренно не вызываем page.close(). Вкладка принадлежит владельцу
    // и живёт до тех пор, пока он сам её не закроет (либо не закроется Chrome).
    return page;
}

/**
 * Даёт динамической ленте время реально отрисовать lazy-media перед чтением DOM.
 * Особенно важно для t.me/s/* и современного VK: HTML появляется раньше картинок.
 */
export async function settleScraperPage({
    page,
    source = 'SCRAPER',
    scrollSteps = 0,
    scrollDelayMs = 450,
    scrollDirection = 'down',
    mediaWaitMs = 10_000,
    holdMs = 0,
    onScrollStep = null,
} = {}) {
    if (!page) {
        return {
            imageCount: 0,
            loadedImages: 0,
            pendingImages: 0,
            backgroundCount: 0,
        };
    }

    const safeScrollSteps = Math.max(0, Math.min(60, Math.trunc(Number(scrollSteps) || 0)));
    const safeScrollDelayMs = Math.max(100, Math.min(5000, Math.trunc(Number(scrollDelayMs) || 450)));
    const safeScrollDirection = String(scrollDirection || '').toLowerCase() === 'up'
        ? 'up'
        : 'down';
    const safeMediaWaitMs = Math.max(0, Math.min(60_000, Math.trunc(Number(mediaWaitMs) || 0)));
    const safeHoldMs = Math.max(0, Math.min(5 * 60_000, Math.trunc(Number(holdMs) || 0)));

    await page.waitForLoadState('domcontentloaded').catch(() => {});
    await page.waitForLoadState('networkidle', {
        timeout: Math.min(5000, Math.max(1000, safeMediaWaitMs || 1000)),
    }).catch(() => {});

    for (let step = 0; step < safeScrollSteps; step += 1) {
        await page.evaluate((direction) => {
            const amount = Math.max(500, window.innerHeight * 0.72);
            const scrollingElement = document.scrollingElement || document.documentElement || document.body;

            /*
             * Telegram public history grows upward: on first render the browser
             * may already be at the newest/bottom chunk. If it happened to land
             * at scrollTop=0, jump once to the bottom and then walk upward.
             * VK/public feeds keep the default downward direction.
             */
            if (direction === 'up') {
                if (scrollingElement && Number(scrollingElement.scrollTop || 0) <= 4) {
                    scrollingElement.scrollTop = Math.max(
                        0,
                        Number(scrollingElement.scrollHeight || 0) - Number(scrollingElement.clientHeight || 0),
                    );
                }
                window.scrollBy({
                    top: -amount,
                    behavior: 'smooth',
                });
                return;
            }

            window.scrollBy({
                top: amount,
                behavior: 'smooth',
            });
        }, safeScrollDirection).catch(() => {});

        // Manual parsers can snapshot already-rendered content immediately after
        // each scroll. If the owner closes Chromium during the following wait,
        // the caller still has the last successful snapshot and can flush it to
        // SQLite instead of losing the whole pass.
        if (typeof onScrollStep === 'function') {
            await onScrollStep({ page, step, phase: 'after-scroll' }).catch(() => {});
        }

        await page.waitForTimeout(safeScrollDelayMs);

        if (typeof onScrollStep === 'function') {
            await onScrollStep({ page, step, phase: 'after-wait' }).catch(() => {});
        }
    }

    // Явно инициируем загрузку background-image, которые Telegram/VK часто
    // держат вне <img> и подгружают только после попадания элемента в viewport.
    await page.evaluate(async (timeoutMs) => {
        const urls = [];
        const seen = new Set();
        for (const node of document.querySelectorAll('*')) {
            const style = getComputedStyle(node);
            const value = String(style?.backgroundImage || '');
            const matches = [...value.matchAll(/url\(["']?([^"')]+)["']?\)/giu)];
            for (const match of matches) {
                const url = String(match?.[1] || '').trim();
                if (!/^https?:\/\//iu.test(url) || seen.has(url)) continue;
                seen.add(url);
                urls.push(url);
                if (urls.length >= 80) break;
            }
            if (urls.length >= 80) break;
        }

        if (!urls.length || timeoutMs <= 0) return;

        await Promise.race([
            Promise.allSettled(urls.map((url) => new Promise((resolve) => {
                const image = new Image();
                const done = () => resolve();
                image.onload = done;
                image.onerror = done;
                image.src = url;
                if (image.complete) done();
            }))),
            new Promise((resolve) => setTimeout(resolve, timeoutMs)),
        ]);
    }, safeMediaWaitMs).catch(() => {});

    const deadline = Date.now() + safeMediaWaitMs;
    let mediaState = {
        imageCount: 0,
        loadedImages: 0,
        pendingImages: 0,
        backgroundCount: 0,
    };

    do {
        mediaState = await page.evaluate(() => {
            const images = [...document.images].filter((image) => Boolean(image.currentSrc || image.src));
            const backgroundUrls = new Set();
            for (const node of document.querySelectorAll('*')) {
                const value = String(getComputedStyle(node)?.backgroundImage || '');
                for (const match of value.matchAll(/url\(["']?([^"')]+)["']?\)/giu)) {
                    const url = String(match?.[1] || '').trim();
                    if (/^https?:\/\//iu.test(url)) backgroundUrls.add(url);
                }
                if (backgroundUrls.size >= 80) break;
            }

            const loadedImages = images.filter((image) => image.complete && image.naturalWidth > 0).length;
            const pendingImages = images.filter((image) => !image.complete).length;
            return {
                imageCount: images.length,
                loadedImages,
                pendingImages,
                backgroundCount: backgroundUrls.size,
            };
        }).catch(() => mediaState);

        if (!mediaState.pendingImages || Date.now() >= deadline) break;
        await page.waitForTimeout(300);
    } while (Date.now() < deadline);

    if (safeHoldMs > 0) {
        await page.waitForTimeout(safeHoldMs);
    }

    console.log(
        '[SCRAPER PAGE SETTLED]',
        `source=${source}`,
        `images=${mediaState.loadedImages}/${mediaState.imageCount}`,
        `pending=${mediaState.pendingImages}`,
        `backgrounds=${mediaState.backgroundCount}`,
        `scroll=${safeScrollDirection}`,
        `holdMs=${safeHoldMs}`,
    );

    return mediaState;
}

export async function browserDownloadBuffer({
    url,
    dataDirectory,
    notifyAttention,
    source,
    maximumBytes,
    timeoutMs = DEFAULT_TIMEOUT_MS,
}) {
    const context = await getScraperBrowserContext({
        dataDirectory,
        notifyAttention,
    });
    const response = await context.request.get(url, {
        timeout: Math.max(5_000, Number(timeoutMs) || DEFAULT_TIMEOUT_MS),
        failOnStatusCode: true,
    });
    const body = await response.body();

    if (body.length > maximumBytes) {
        throw new Error(
            `${source}: файл превысил ${maximumBytes} байт`,
        );
    }

    return {
        buffer: body,
        contentType: response.headers()['content-type'] ?? '',
        finalUrl: response.url(),
    };
}

/*
 * Ручная/пользовательская ссылка на событие обрабатывается конечным проходом.
 * Вкладка закрывается после снимка по умолчанию; режим keepPageOpen существует
 * только для явной ручной диагностики.
 */


async function captureVkStructuredEventEvidence(page, trace = null) {
    if (!page || page.isClosed?.()) {
        return { events: [], exactWallPosts: [] };
    }
    trace?.('browser.vk_structured.capture.begin', { url: page.url?.() || '' });

    const runtimeSources = await page.evaluate(() => {
        if (!/(?:^|\.)vk\.(?:ru|com)$/i.test(location.hostname)) return [];
        const values = [];
        const add = (value) => {
            if (!value || typeof value !== 'object') return;
            try {
                // Snapshot immediately: VK's SPA can consume/replace these
                // objects a few seconds after DOMContentLoaded.
                values.push(JSON.parse(JSON.stringify(value)));
            } catch {}
        };
        add(window?.cur?.apiPrefetchCache);
        add(window?.apiPrefetchCache);
        add(window?.vk?.routerState);
        for (const key of ['group', 'groupInfo', 'community', 'event', 'entity']) {
            add(window?.cur?.[key]);
        }
        return values.slice(0, 120);
    }).catch(() => []);

    trace?.('browser.vk_structured.runtime_sources', {
        count: runtimeSources.length,
        sources: runtimeSources,
    });

    let htmlSources = [];
    let html = '';
    try {
        html = await page.content();
        trace?.('browser.vk_structured.raw_html', {
            url: page.url?.() || '',
            length: html.length,
            html,
        });
        htmlSources = extractVkStructuredBootstrapSourcesFromHtml(html, { maximum: 120 });
    } catch (error) {
        trace?.('browser.vk_structured.raw_html_error', { error });
        htmlSources = [];
    }
    trace?.('browser.vk_structured.html_sources', {
        count: htmlSources.length,
        sources: htmlSources,
    });

    const firstPassSources = [...runtimeSources, ...htmlSources];
    const exactWallPosts = extractVkExactWallPostsFromBootstrap(firstPassSources, {
        sourceUrl: page.url?.() || '',
        maximum: 4,
    });
    trace?.('browser.vk_exact_bootstrap.posts', {
        count: exactWallPosts.length,
        posts: exactWallPosts,
    });

    let events = extractVkStructuredEventsFromBootstrap(
        firstPassSources,
        { maximum: 8 },
    );

    // Exact VK wall pages often expose only wall.getById in their own bootstrap,
    // while the owner is an event community whose page exposes groups.getById
    // with canonical start_date. Follow that structured event page once through
    // the authenticated Playwright request context. This is still the VK
    // structured first pass; if it fails, generic DOM/body parsing remains the
    // normal fallback.
    if (!events.length) {
        const eventPageUrl = exactWallPosts
            .map((post) => String(post?.eventPageUrl || '').trim())
            .find(Boolean);
        if (eventPageUrl && eventPageUrl !== page.url?.()) {
            trace?.('browser.vk_related_event.begin', {
                sourceUrl: page.url?.() || '',
                eventPageUrl,
            });
            try {
                const response = await page.context().request.get(eventPageUrl, {
                    timeout: 8_000,
                    failOnStatusCode: false,
                });
                const relatedHtml = await response.text();
                const relatedSources = extractVkStructuredBootstrapSourcesFromHtml(
                    relatedHtml,
                    { maximum: 120 },
                );
                const relatedEvents = extractVkStructuredEventsFromBootstrap(
                    relatedSources,
                    { maximum: 8 },
                );
                events = mergeVkStructuredEventCandidates(events, relatedEvents);
                trace?.('browser.vk_related_event.result', {
                    eventPageUrl,
                    finalUrl: response.url(),
                    status: response.status(),
                    htmlLength: relatedHtml.length,
                    sourceCount: relatedSources.length,
                    sources: relatedSources,
                    eventCount: relatedEvents.length,
                    events: relatedEvents,
                });
            } catch (error) {
                trace?.('browser.vk_related_event.error', {
                    eventPageUrl,
                    error,
                });
            }
        }
    }

    trace?.('browser.vk_structured.events', {
        count: events.length,
        events,
    });
    if (events.length) {
        console.log(
            '[MANUAL EVENT VK EARLY STRUCTURED SNAPSHOT]',
            `events=${events.length}`,
            `firstStart=${Number(events[0]?.startAt || 0) || 'none'}`,
            `method=${events[0]?.sourceMethod || 'generic'}`,
        );
    }
    if (exactWallPosts.length) {
        console.log(
            '[MANUAL EVENT VK RAW HTML WALL SNAPSHOT]',
            `posts=${exactWallPosts.length}`,
            `publishedAt=${Number(exactWallPosts[0]?.publishedAt || 0) || 'none'}`,
            `images=${Array.isArray(exactWallPosts[0]?.imageUrls) ? exactWallPosts[0].imageUrls.length : 0}`,
        );
    }
    return { events, exactWallPosts };
}

function mergeVkStructuredEventCandidates(...groups) {
    const deduped = new Map();
    for (const event of groups.flat()) {
        if (!event || !Number(event.startAt || 0)) continue;
        const key = `${Number(event.id || 0)}|${Number(event.startAt || 0)}|${String(event.title || '').trim().toLowerCase()}`;
        const previous = deduped.get(key);
        if (!previous || Number(event.score || 0) > Number(previous.score || 0)) {
            deduped.set(key, event);
        }
    }
    return [...deduped.values()]
        .sort((left, right) => Number(right.score || 0) - Number(left.score || 0) || Number(left.startAt || 0) - Number(right.startAt || 0))
        .slice(0, 8);
}

export async function openEventLinkForReview({
    url,
    dataDirectory = './data',
    notifyAttention,
    keepPageOpen = false,
    // One browser tab per source link in the owner's «бф» future refresh.
    // The ordinary/manual callers retain their original reusable/blank-tab policy.
    separateTab = false,
    navigationTimeoutMs = 45_000,
    manualAccessTimeoutMs = 45_000,
    minimumOpenMs = EVENT_REVIEW_MINIMUM_OPEN_MS,
    trace = null,
}) {
    trace?.('browser.open.begin', {
        url,
        dataDirectory,
        keepPageOpen,
        separateTab,
        navigationTimeoutMs,
        manualAccessTimeoutMs,
        minimumOpenMs,
    });
    // openScraperPage may claim an existing blank tab. For «бф», use the
    // dedicated opener that ALWAYS calls context.newPage() in the same
    // browser context, without recycling or closing other source tabs.
    const page = separateTab
        ? await openScraperTab({
            url,
            source: 'MANUAL EVENT',
            dataDirectory,
            notifyAttention,
            waitUntil: 'domcontentloaded',
            navigationTimeoutMs,
            manualAccessTimeoutMs,
        })
        : await openScraperPage({
            url,
            source: 'MANUAL EVENT',
            dataDirectory,
            notifyAttention,
            waitUntil: 'domcontentloaded',
            reuseKey: keepPageOpen ? `manual-event:${url}` : '',
            navigationTimeoutMs,
            manualAccessTimeoutMs,
        });
    if (separateTab) {
        console.log('[FUTURE EVENTS SEPARATE TAB OPENED]', `url=${url}`, `tabs=${page.context().pages().length}`);
    }

    const finiteReviewStartedAt = Date.now();
    // An explicit zero is reserved for the owner-only pipelined future refresh:
    // the page still completes scrolling/media capture, but an already captured
    // source must not occupy a Chromium tab for an unrelated three-minute dwell.
    const safeMinimumOpenMs = keepPageOpen || minimumOpenMs === 0
        ? 0
        : Math.max(
            EVENT_REVIEW_MINIMUM_OPEN_MS,
            Math.min(5 * 60_000, Math.trunc(Number(minimumOpenMs) || EVENT_REVIEW_MINIMUM_OPEN_MS)),
        );

    try {
    trace?.('browser.open.ready', {
        requestedUrl: url,
        finalUrl: page.url?.() || '',
    });
    await page.bringToFront().catch(() => {});
    await page.waitForTimeout(650);

    // First VK pass happens before any long scrolling or AI work. The SPA can
    // clear apiPrefetchCache after hydration, so delaying this snapshot loses
    // canonical event fields such as start_date.
    // Legacy regression anchor: captureVkStructuredEventEvidence(page) must happen before scrolling.
    const earlyVkEvidence = await captureVkStructuredEventEvidence(page, trace);
    const earlyVkStructuredEvents = Array.isArray(earlyVkEvidence?.events)
        ? earlyVkEvidence.events
        : [];
    const earlyVkExactWallPosts = Array.isArray(earlyVkEvidence?.exactWallPosts)
        ? earlyVkEvidence.exactWallPosts
        : [];
    trace?.('browser.vk_structured.early_result', {
        count: earlyVkStructuredEvents.length,
        exactWallPostCount: earlyVkExactWallPosts.length,
        events: earlyVkStructuredEvents,
        exactWallPosts: earlyVkExactWallPosts,
    });

    /*
     * Автоматически разбираем только первые 20 загруженных постов. Этого
     * достаточно для свежей части ленты и не тратит браузер/AI на древний
     * архив. Для обычной предложки/ручного добавления проход конечный;
     * keepPageOpen используется только если это явно запросил вызывающий код.
     */
    let stableScrollRounds = 0;
    let previousHeight = 0;
    let previousPostCount = 0;
    const automaticScanSteps = earlyVkStructuredEvents.length ? 4 : earlyVkExactWallPosts.length ? 6 : 16;
    for (let step = 0; step < automaticScanSteps; step += 1) {
        const state = await page.evaluate((targetPostCount) => {
            const selectors = [
                '.tgme_widget_message',
                '[data-post]',
                '[data-post-id]',
                '[id^="post-"]',
                '.Post',
                '.wall_post_cont',
                'article',
                '[role="article"]',
            ];
            const postNodes = new Set();
            for (const selector of selectors) {
                for (const node of document.querySelectorAll(selector)) postNodes.add(node);
            }

            // Раскрываем уже загруженные обрезанные тексты, не переходя по
            // обычным ссылкам. Это важно для VK «Показать ещё».
            let expanded = 0;
            for (const node of document.querySelectorAll('button, [role="button"], a')) {
                if (expanded >= targetPostCount) break;
                const label = String(node.innerText || node.textContent || '')
                    .replace(/\s+/g, ' ')
                    .trim();
                if (!/^(?:показать\s+(?:ещ[её]|полностью)|show\s+more)$/i.test(label)) continue;
                if (node.tagName === 'A') {
                    const href = String(node.getAttribute('href') || '').trim();
                    if (href && !href.startsWith('#') && !/^javascript:/i.test(href)) continue;
                }
                try {
                    node.click();
                    expanded += 1;
                } catch {}
            }

            const height = Math.max(
                document.body?.scrollHeight || 0,
                document.documentElement?.scrollHeight || 0,
            );
            const telegramHistory = /(?:^|\.)t\.me$/i.test(location.hostname);
            if (postNodes.size < targetPostCount) {
                const amount = Math.max(700, window.innerHeight * 0.9);
                if (telegramHistory) {
                    const scrollingElement = document.scrollingElement || document.documentElement || document.body;
                    if (scrollingElement && Number(scrollingElement.scrollTop || 0) <= 4) {
                        scrollingElement.scrollTop = Math.max(
                            0,
                            Number(scrollingElement.scrollHeight || 0) - Number(scrollingElement.clientHeight || 0),
                        );
                    }
                    window.scrollBy({
                        top: -amount,
                        behavior: 'smooth',
                    });
                } else {
                    window.scrollBy({
                        top: amount,
                        behavior: 'instant',
                    });
                }
            }
            return {
                height,
                postCount: postNodes.size,
                expanded,
                scrollDirection: telegramHistory ? 'up' : 'down',
            };
        }, MANUAL_EVENT_AUTO_POST_LIMIT).catch((error) => {
            trace?.('browser.scan.step_error', { step, error });
            return {
                height: 0,
                postCount: 0,
                expanded: 0,
                scrollDirection: 'down',
            };
        });
        trace?.('browser.scan.step', {
            step,
            automaticScanSteps,
            state,
            previousHeight,
            previousPostCount,
            stableScrollRounds,
        });

        if (state.postCount >= MANUAL_EVENT_AUTO_POST_LIMIT) {
            break;
        }
        if (
            state.height > 0 &&
            state.height === previousHeight &&
            state.postCount === previousPostCount &&
            state.expanded === 0
        ) {
            stableScrollRounds += 1;
        } else {
            stableScrollRounds = 0;
        }
        previousHeight = state.height;
        previousPostCount = state.postCount;
        if (stableScrollRounds >= (earlyVkStructuredEvents.length || earlyVkExactWallPosts.length ? 2 : 3)) break;
        await page.waitForTimeout(450);
    }

    console.log(
        '[MANUAL EVENT AUTO SCAN]',
        `limit=${MANUAL_EVENT_AUTO_POST_LIMIT}`,
        `direction=${/^(?:https?:\/\/)?(?:www\.)?t\.me\//iu.test(String(page.url() || '')) ? 'up' : 'down'}`,
        earlyVkStructuredEvents.length ? 'vkStructured=early' : 'vkStructured=none',
        earlyVkExactWallPosts.length ? 'vkExactWall=early' : 'vkExactWall=none',
        keepPageOpen ? 'remaining=manual-scroll' : 'remaining=finite-pass',
        `autoClose=${keepPageOpen ? 'false' : 'true'}`,
    );

    // V188.29: любой конечный review/reparse обязан реально дать странице
    // минимум минуту после открытия. DOMContentLoaded приходит слишком рано:
    // VK/TG ещё десятки секунд дорисовывают lazy images, modal media и SPA data.
    // Финальный DOM читаем ТОЛЬКО после этого окна, поэтому вкладка физически
    // не может открыться на полсекунды и тут же закрыться.
    if (!keepPageOpen && safeMinimumOpenMs > 0) {
        await settleScraperPage({
            page,
            source: `EVENT LINK REVIEW ${String(page.url?.() || url)}`,
            scrollSteps: 0,
            mediaWaitMs: EVENT_REVIEW_MEDIA_WAIT_MS,
            holdMs: 0,
        });
        const elapsedMs = Date.now() - finiteReviewStartedAt;
        const remainingMs = Math.max(0, safeMinimumOpenMs - elapsedMs);
        if (remainingMs > 0) {
            console.log(
                '[EVENT LINK MINIMUM DWELL]',
                `minimumMs=${safeMinimumOpenMs}`,
                `elapsedMs=${elapsedMs}`,
                `remainingMs=${remainingMs}`,
                `url=${String(page.url?.() || url)}`,
            );
            await page.waitForTimeout(remainingMs);
        }
        // После минутного окна ещё раз просим браузер закончить текущие media
        // requests, затем уже снимаем окончательный DOM ниже.
        await page.waitForLoadState('networkidle', { timeout: 5_000 }).catch(() => {});
    }
    trace?.('browser.scan.complete', {
        limit: MANUAL_EVENT_AUTO_POST_LIMIT,
        finalUrl: page.url?.() || '',
        earlyStructuredCount: earlyVkStructuredEvents.length,
        earlyExactWallPostCount: earlyVkExactWallPosts.length,
        keepPageOpen,
        stableScrollRounds,
        previousHeight,
        previousPostCount,
    });

    // Diagnostic callers need the exact full DOM that existed immediately
    // before the final visible-DOM extraction. The trace callback may persist
    // this verbatim HTML into a separate .dom.html file. Normal callers pass
    // no trace callback, so there is no extra page.content() cost for them.
    if (trace) {
        try {
            const finalHtml = await page.content();
            trace('browser.final.raw_html', {
                url: page.url?.() || '',
                length: finalHtml.length,
                html: finalHtml,
            });
        } catch (error) {
            trace('browser.final.raw_html_error', { error });
        }
    }

    const extracted = await page.evaluate((postLimit) => {
        const absoluteUrl = (value) => {
            const source = String(value || '').trim();
            if (!source || source.startsWith('data:') || source.startsWith('blob:')) return '';
            try {
                return new URL(source, location.href).href;
            } catch {
                return '';
            }
        };
        const unique = (values, limit = 40) => [...new Set(values.filter(Boolean))].slice(0, limit);
        const cleanText = (value, limit = 12000) => String(value || '')
            .replace(/\u00a0/g, ' ')
            .replace(/[ \t]+/g, ' ')
            .replace(/\n{3,}/g, '\n\n')
            .trim()
            .slice(0, limit);
        const imageUrlsFrom = (root) => {
            const candidates = [];
            const markerOf = (node) => [
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
                    const marker = markerOf(current);
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
            const push = (value, score = 0) => {
                const url = absoluteUrl(value);
                if (!url || !/^https?:\/\//i.test(url)) return;
                candidates.push({ url, score, order: candidates.length });
            };

            for (const image of root.querySelectorAll('img')) {
                const rect = image.getBoundingClientRect?.() || { width: 0, height: 0 };
                const width = Math.max(Number(image.naturalWidth || 0), Number(rect.width || 0));
                const height = Math.max(Number(image.naturalHeight || 0), Number(rect.height || 0));
                const area = Math.max(0, width * height);
                const marker = markerOf(image);
                const context = mediaContext(image);
                const photoAnchor = hasPhotoAnchor(image);
                if (context.isUi || isUiMarker(marker)) continue;
                if (!photoAnchor && !context.isMedia && (Math.max(width, height) < 360 || Math.min(width, height) < 160)) continue;
                const score = (photoAnchor ? 3_000_000_000 : context.isMedia ? 2_000_000_000 : 1_000_000_000) + Math.min(area, 100_000_000);
                const values = [
                    image.currentSrc,
                    image.src,
                    image.getAttribute('data-src'),
                    image.getAttribute('data-original'),
                ];
                const srcset = String(image.getAttribute('srcset') || '')
                    .split(',')
                    .map((entry) => entry.trim().split(/\s+/)[0]);
                for (const value of [...values, ...srcset]) push(value, score);
            }
            for (const node of root.querySelectorAll('[style*="background-image"]')) {
                const marker = markerOf(node);
                const context = mediaContext(node);
                const photoAnchor = hasPhotoAnchor(node);
                if (context.isUi || isUiMarker(marker) || (!context.isMedia && !photoAnchor)) continue;
                const rect = node.getBoundingClientRect?.() || { width: 0, height: 0 };
                const width = Number(rect.width || 0);
                const height = Number(rect.height || 0);
                if (Math.max(width, height) < 160) continue;
                const style = String(node.getAttribute('style') || '');
                const match = style.match(/background-image\s*:\s*url\(["']?([^"')]+)["']?\)/i);
                if (match) push(match[1], (photoAnchor ? 3_000_000_000 : 2_000_000_000) + Math.min(width * height, 100_000_000));
            }
            const byUrl = new Map();
            for (const candidate of candidates) {
                const previous = byUrl.get(candidate.url);
                if (!previous || candidate.score > previous.score) byUrl.set(candidate.url, candidate);
            }
            return [...byUrl.values()]
                .sort((left, right) => right.score - left.score || left.order - right.order)
                .slice(0, 12)
                .map((candidate) => candidate.url);
        };
        const linkUrlsFrom = (root) => unique(
            [...root.querySelectorAll('a[href]')]
                .map((anchor) => absoluteUrl(anchor.getAttribute('href'))),
            40,
        );
        const selectors = [
            '.tgme_widget_message',
            '[data-post]',
            '[data-post-id]',
            '[id^="post-"]',
            '.Post',
            '.wall_post_cont',
            'article',
            '[role="article"]',
        ];
        const nodes = [];
        const seenNodes = new Set();
        for (const selector of selectors) {
            for (const node of document.querySelectorAll(selector)) {
                if (seenNodes.has(node)) continue;
                const nestedInsideKnown = nodes.some((known) => known.contains(node));
                if (nestedInsideKnown) continue;
                seenNodes.add(node);
                nodes.push(node);
            }
        }
        const currentUrl = location.href;
        const currentPostToken = (
            currentUrl.match(/wall-?\d+_\d+/i)?.[0] ||
            currentUrl.match(/\/[^/?#]+\/\d+(?:[/?#]|$)/)?.[0]?.replace(/[/?#]+$/g, '') ||
            ''
        );
        const canonicalPostUrl = (links, nodeId = '') => {
            for (const link of links) {
                const wall = String(link).match(/wall(-?\d+)_(\d+)/i);
                if (wall) return `https://vk.ru/wall${wall[1]}_${wall[2]}`;
                const telegram = String(link).match(/^https?:\/\/t\.me\/(?:s\/)?([A-Za-z0-9_]+)\/(\d+)/i);
                if (telegram) return `https://t.me/${telegram[1]}/${telegram[2]}`;
            }
            const idWall = String(nodeId).match(/(?:post|wall)?(-?\d+)[_:](\d+)/i);
            if (idWall) return `https://vk.ru/wall${idWall[1]}_${idWall[2]}`;
            return '';
        };
        const posts = [];
        const seenPostKeys = new Set();
        for (const node of nodes) {
            const text = cleanText(node.innerText || node.textContent || '', 10000);
            if (text.length < 20) continue;
            const links = linkUrlsFrom(node);
            const nodeId = String(
                node.getAttribute('data-post') ||
                node.getAttribute('data-post-id') ||
                node.id ||
                '',
            ).trim();
            const key = `${nodeId}|${text.slice(0, 240)}`;
            if (seenPostKeys.has(key)) continue;
            seenPostKeys.add(key);
            const imageUrls = imageUrlsFrom(node);
            const sourceUrl = canonicalPostUrl(links, nodeId);
            const timeNode = node.querySelector('time[datetime]');
            const parsedTime = Date.parse(String(timeNode?.getAttribute('datetime') || ''));
            const unixCarrier = node.matches?.('[data-time], [data-date], [data-timestamp]')
                ? node
                : node.querySelector('[data-time], [data-date], [data-timestamp]');
            const unixCandidate = Number(
                unixCarrier?.getAttribute?.('data-time') ||
                unixCarrier?.getAttribute?.('data-timestamp') ||
                unixCarrier?.getAttribute?.('data-date') ||
                0
            );
            const publishedAt = Number.isFinite(parsedTime)
                ? Math.floor(parsedTime / 1000)
                : Number.isFinite(unixCandidate) && unixCandidate >= 1_000_000_000
                    ? Math.floor(unixCandidate > 10_000_000_000 ? unixCandidate / 1000 : unixCandidate)
                    : 0;
            posts.push({
                index: posts.length,
                id: nodeId,
                text,
                links,
                imageUrls,
                sourceUrl,
                publishedAt,
                matchesSourceUrl: Boolean(
                    currentPostToken && (
                        nodeId.includes(currentPostToken) ||
                        links.some((link) => link.includes(currentPostToken))
                    )
                ),
            });
            if (posts.length >= postLimit) break;
        }

        // V188.6: exact VK wall page already contains the same wall.getById
        // response in window.cur.apiPrefetchCache. This bootstrap payload is far
        // more reliable than the visual DOM: it preserves the post timestamp,
        // exact text and real photo attachments even when the new VK modal has
        // no stable selectors or machine-readable time attributes.
        if (currentPostToken && /^wall-?\d+_\d+$/i.test(currentPostToken)) {
            const tokenMatch = currentPostToken.match(/^wall(-?\d+)_(\d+)$/i);
            const targetOwnerId = Number(tokenMatch?.[1] || 0);
            const targetPostId = Number(tokenMatch?.[2] || 0);
            const choosePhotoUrl = (photo) => {
                if (!photo || typeof photo !== 'object') return '';
                const variants = [];
                const add = (url, width = 0, height = 0) => {
                    const clean = absoluteUrl(url);
                    if (!clean) return;
                    variants.push({ clean, area: (Number(width) || 0) * (Number(height) || 0) });
                };
                for (const size of Array.isArray(photo.sizes) ? photo.sizes : []) {
                    add(size?.url || size?.src, size?.width, size?.height);
                }
                add(photo?.orig_photo?.url, photo?.orig_photo?.width || photo?.width, photo?.orig_photo?.height || photo?.height);
                add(photo?.max_size_url, photo?.width, photo?.height);
                for (const [key, value] of Object.entries(photo)) {
                    const legacy = key.match(/^(?:photo|src)_(\d+)$/i);
                    if (legacy) add(value, Number(legacy[1]), Number(legacy[1]));
                }
                variants.sort((left, right) => right.area - left.area);
                return variants[0]?.clean || '';
            };
            const photoUrlsFromWall = (wall) => {
                const urls = [];
                const visit = (item, depth = 0) => {
                    if (!item || depth > 4) return;
                    for (const attachment of Array.isArray(item?.attachments) ? item.attachments : []) {
                        if (String(attachment?.type || '').toLowerCase() !== 'photo') continue;
                        const url = choosePhotoUrl(attachment?.photo || attachment);
                        if (url) urls.push(url);
                    }
                    for (const copy of Array.isArray(item?.copy_history) ? item.copy_history : []) {
                        visit(copy, depth + 1);
                    }
                };
                visit(wall);
                return unique(urls, 8);
            };
            const prefetch = Array.isArray(window?.cur?.apiPrefetchCache)
                ? window.cur.apiPrefetchCache
                : [];
            let bootstrapWall = null;
            for (const entry of prefetch) {
                if (String(entry?.method || '').toLowerCase() !== 'wall.getbyid') continue;
                const items = Array.isArray(entry?.response?.items)
                    ? entry.response.items
                    : Array.isArray(entry?.response)
                        ? entry.response
                        : [];
                bootstrapWall = items.find((wall) => (
                    Number(wall?.owner_id ?? wall?.from_id ?? 0) === targetOwnerId &&
                    Number(wall?.id ?? 0) === targetPostId
                )) || bootstrapWall;
                if (bootstrapWall) break;
            }
            if (bootstrapWall) {
                const copiedText = (Array.isArray(bootstrapWall?.copy_history) ? bootstrapWall.copy_history : [])
                    .map((copy) => cleanText(copy?.text || '', 12000))
                    .filter(Boolean)
                    .join('\n\n');
                const bootstrapText = [cleanText(bootstrapWall?.text || '', 20000), copiedText]
                    .filter(Boolean)
                    .join('\n\n')
                    .trim();
                const bootstrapImages = photoUrlsFromWall(bootstrapWall);
                const canonicalCurrentPostUrl = `https://vk.ru/${currentPostToken}`;
                const bootstrapPost = {
                    index: 0,
                    id: currentPostToken,
                    text: bootstrapText,
                    links: [canonicalCurrentPostUrl],
                    imageUrls: bootstrapImages,
                    sourceUrl: canonicalCurrentPostUrl,
                    publishedAt: Number(bootstrapWall?.date || 0),
                    publishedAtSource: 'vk-page-prefetch-wall-date-v1886',
                    matchesSourceUrl: true,
                    extractionMethod: 'exact-bootstrap-vk-api-prefetch',
                    imageConfidence: bootstrapImages.length ? 'wall-photo' : 'none',
                };
                const duplicateIndex = posts.findIndex((post) => post.matchesSourceUrl);
                if (duplicateIndex >= 0) {
                    const existing = posts[duplicateIndex];
                    posts.splice(duplicateIndex, 1);
                    bootstrapPost.text ||= existing.text;
                    bootstrapPost.imageUrls = bootstrapPost.imageUrls.length
                        ? bootstrapPost.imageUrls
                        : existing.imageUrls;
                }
                posts.unshift(bootstrapPost);
                posts.forEach((post, index) => { post.index = index; });
            }
        }

        // V188.5: новый VK часто показывает прямой wall-пост внутри modal/dialog,
        // который не имеет старых .Post/.wall_post_cont/role=article селекторов.
        // Если URL указывает на exact wall-post, но generic scan его не пометил,
        // находим permalink этого же wall-token и поднимаемся к видимому контейнеру.
        if (currentPostToken && !posts.some((post) => post.matchesSourceUrl)) {
            const canonicalCurrentPostUrl = `https://vk.ru/${currentPostToken}`;
            const exactCandidates = [];
            const pushCandidate = (node, method) => {
                if (!node || node === document.body || node === document.documentElement) return;
                const text = cleanText(node.innerText || node.textContent || '', 30000);
                if (text.length < 20) return;
                const links = linkUrlsFrom(node);
                const imageUrls = imageUrlsFrom(node);
                let score = 0;
                if (links.some((link) => String(link).includes(currentPostToken))) score += 20;
                if (/(?:концерт|вечерин|тус|фест|выступ|мероприяти|билет|вход|афиш|шоу|лекци|маркет|dj)/i.test(text)) score += 8;
                if (/\b\d{1,2}[.\/-]\d{1,2}(?:[.\/-]\d{2,4})?\b/.test(text)) score += 6;
                if (/\b(?:[01]?\d|2[0-3]):[0-5]\d\b/.test(text)) score += 3;
                if (imageUrls.length) score += 2;
                if (text.length > 25000) score -= 8;
                exactCandidates.push({ node, text, links, imageUrls, method, score });
            };

            const matchingAnchors = [...document.querySelectorAll('a[href]')]
                .filter((anchor) => absoluteUrl(anchor.getAttribute('href')).includes(currentPostToken));
            for (const anchor of matchingAnchors.slice(0, 20)) {
                let node = anchor;
                for (let depth = 0; depth < 9 && node?.parentElement; depth += 1) {
                    node = node.parentElement;
                    pushCandidate(node, `permalink-ancestor-${depth + 1}`);
                }
            }

            for (const node of document.querySelectorAll('[role="dialog"], [aria-modal="true"], .vkuiModalRoot__modal, .ModalRoot__modal')) {
                // Для exact URL сам факт открытого modal является сильным сигналом:
                // новый VK не всегда оставляет wall-permalink внутри DOM карточки.
                pushCandidate(node, 'vk-modal-dialog');
            }

            exactCandidates.sort((left, right) => right.score - left.score || left.text.length - right.text.length);
            const rescued = exactCandidates[0];
            if (rescued) {
                posts.unshift({
                    index: 0,
                    id: currentPostToken,
                    text: rescued.text,
                    links: rescued.links,
                    imageUrls: rescued.imageUrls,
                    sourceUrl: canonicalCurrentPostUrl,
                    publishedAt: 0,
                    matchesSourceUrl: true,
                    extractionMethod: `exact-visible-${rescued.method}`,
                });
                posts.forEach((post, index) => { post.index = index; });
            }
        }

        const text = cleanText(document.body?.innerText ?? '', 100000);
        const title = String(
            document.querySelector('meta[property="og:title"]')?.content ||
            document.querySelector('meta[name="twitter:title"]')?.content ||
            document.title ||
            '',
        ).trim();
        const description = String(
            document.querySelector('meta[property="og:description"]')?.content ||
            document.querySelector('meta[name="description"]')?.content ||
            document.querySelector('meta[name="twitter:description"]')?.content ||
            '',
        ).trim();
        const imageUrl = absoluteUrl(
            document.querySelector('meta[property="og:image"]')?.content ||
            document.querySelector('meta[name="twitter:image"]')?.content ||
            '',
        );
        const imageUrls = unique([
            imageUrl,
            ...posts.flatMap((post) => post.imageUrls),
        ], postLimit * 3);

        // VK first-pass evidence. We intentionally return the structured API
        // bootstrap as data rather than teaching the parser one exact HTML
        // template. The Node-side parser recursively searches event-shaped
        // objects and tolerates method/key renames. If no structured event is
        // found, title/description/body/posts below remain the generic fallback.
        const vkHost = /(?:^|\.)vk\.(?:ru|com)$/i.test(location.hostname);
        const vkStructuredBootstrapSources = [];
        if (vkHost) {
            const addSource = (value) => {
                if (!value || typeof value !== 'object') return;
                vkStructuredBootstrapSources.push(value);
            };
            if (Array.isArray(window?.cur?.apiPrefetchCache)) {
                for (const entry of window.cur.apiPrefetchCache.slice(0, 120)) addSource(entry);
            }
            addSource(window?.vk?.routerState);
            for (const key of ['group', 'groupInfo', 'community', 'event', 'entity']) {
                addSource(window?.cur?.[key]);
            }
        }

        return {
            title,
            description,
            text,
            imageUrl,
            imageUrls,
            posts,
            vkStructuredBootstrapSources,
            finalUrl: location.href,
        };
    }, MANUAL_EVENT_AUTO_POST_LIMIT);
    if (earlyVkExactWallPosts.length) {
        const genericPosts = Array.isArray(extracted?.posts) ? extracted.posts : [];
        const exactRecoveredIds = new Set(earlyVkExactWallPosts.map((post) => String(post?.id || '')));
        const keptGeneric = genericPosts.filter((post) => {
            if (!post?.matchesSourceUrl) return true;
            if (exactRecoveredIds.has(String(post?.id || ''))) return false;
            return !String(post?.extractionMethod || '').startsWith('exact-visible-');
        });
        extracted.posts = [...earlyVkExactWallPosts, ...keptGeneric];
        extracted.posts.forEach((post, index) => { post.index = index; });
        const recoveredImages = earlyVkExactWallPosts.flatMap((post) => post?.imageUrls || []);
        extracted.imageUrls = [...new Set([
            ...recoveredImages,
            ...(Array.isArray(extracted?.imageUrls) ? extracted.imageUrls : []),
        ])].slice(0, MANUAL_EVENT_AUTO_POST_LIMIT * 3);
        extracted.imageUrl = recoveredImages[0] || extracted.imageUrl || '';
        trace?.('browser.vk_exact_bootstrap.merged', {
            recovered: earlyVkExactWallPosts,
            postCount: extracted.posts.length,
            imageUrls: extracted.imageUrls,
        });
    }

    trace?.('browser.extract.dom_result', {
        title: extracted?.title || '',
        description: extracted?.description || '',
        text: extracted?.text || '',
        imageUrl: extracted?.imageUrl || '',
        imageUrls: extracted?.imageUrls || [],
        posts: extracted?.posts || [],
        vkStructuredBootstrapSources: extracted?.vkStructuredBootstrapSources || [],
        finalUrl: extracted?.finalUrl || page.url?.() || '',
    });

    const lateVkStructuredEvents = extractVkStructuredEventsFromBootstrap(
        extracted?.vkStructuredBootstrapSources || [],
        { maximum: 8 },
    );
    const vkStructuredEvents = mergeVkStructuredEventCandidates(
        earlyVkStructuredEvents,
        lateVkStructuredEvents,
    );
    trace?.('browser.vk_structured.merged', {
        early: earlyVkStructuredEvents,
        late: lateVkStructuredEvents,
        merged: vkStructuredEvents,
    });
    if (vkStructuredEvents.length) {
        const structuredPosts = vkStructuredEvents.map((event, index) => {
            const evidence = formatVkStructuredEventEvidence(event, { timeZone: 'Europe/Moscow' });
            return {
                index,
                id: event.id ? `vk-event-${event.id}` : `vk-event-structured-${index + 1}`,
                text: evidence.text,
                links: [String(extracted?.finalUrl || url)].filter(Boolean),
                imageUrls: Array.isArray(event.imageUrls) ? event.imageUrls.slice(0, 10) : [],
                sourceUrl: String(extracted?.finalUrl || url),
                publishedAt: 0,
                eventStartAt: Number(event.startAt || 0),
                eventFinishAt: Number(event.finishAt || 0),
                eventDate: evidence.eventDate,
                eventTime: evidence.eventTime,
                matchesSourceUrl: true,
                extractionMethod: 'vk-structured-event-first-pass',
                imageConfidence: event.imageUrls?.length ? 'vk-event-structured' : 'none',
                structuredSourceMethod: event.sourceMethod || '',
            };
        }).filter((post) => post.text);
        const genericPosts = Array.isArray(extracted.posts) ? extracted.posts : [];
        const bodyFallbackText = String(extracted.text || '').trim();
        const bodyFallback = bodyFallbackText.length >= 20
            ? [{
                index: -1,
                id: 'vk-whole-page-fallback',
                text: bodyFallbackText,
                links: [String(extracted?.finalUrl || url)].filter(Boolean),
                imageUrls: (Array.isArray(extracted.imageUrls) ? extracted.imageUrls : []).slice(0, 10),
                sourceUrl: String(extracted?.finalUrl || url),
                publishedAt: 0,
                matchesSourceUrl: false,
                extractionMethod: 'vk-whole-page-fallback',
                imageConfidence: extracted.imageUrls?.length ? 'page-generic' : 'none',
            }]
            : [];
        extracted.posts = [
            ...structuredPosts,
            ...genericPosts,
            ...bodyFallback,
        ];
        extracted.posts.forEach((post, index) => { post.index = index; });
        extracted.structuredEvents = vkStructuredEvents;
        extracted.imageUrls = [...new Set([
            ...(structuredPosts.flatMap((post) => post.imageUrls || [])),
            ...(Array.isArray(extracted.imageUrls) ? extracted.imageUrls : []),
        ])].slice(0, MANUAL_EVENT_AUTO_POST_LIMIT * 3);
        extracted.imageUrl ||= structuredPosts.flatMap((post) => post.imageUrls || [])[0] || '';
        console.log(
            '[MANUAL EVENT VK STRUCTURED FIRST PASS]',
            `events=${vkStructuredEvents.length}`,
            `firstDate=${structuredPosts[0]?.eventDate || 'none'}`,
            `firstTime=${structuredPosts[0]?.eventTime || 'none'}`,
            `method=${vkStructuredEvents[0]?.sourceMethod || 'generic'}`,
        );
    }
    delete extracted.vkStructuredBootstrapSources;

    const exactBootstrapRecovery = Array.isArray(extracted?.posts)
        ? extracted.posts.find((post) => String(post?.extractionMethod || '').startsWith('exact-bootstrap-vk-api-prefetch'))
        : null;
    if (exactBootstrapRecovery) {
        console.log(
            '[MANUAL EVENT VK EXACT BOOTSTRAP RECOVERY]',
            `post=${exactBootstrapRecovery.sourceUrl || 'unknown'}`,
            `publishedAt=${Number(exactBootstrapRecovery.publishedAt || 0)}`,
            `textChars=${String(exactBootstrapRecovery.text || '').length}`,
            `images=${Array.isArray(exactBootstrapRecovery.imageUrls) ? exactBootstrapRecovery.imageUrls.length : 0}`,
        );
    }

    const exactVisibleRecovery = Array.isArray(extracted?.posts)
        ? extracted.posts.find((post) => String(post?.extractionMethod || '').startsWith('exact-visible-'))
        : null;
    if (exactVisibleRecovery) {
        console.log(
            '[MANUAL EVENT VK EXACT VISIBLE RECOVERY]',
            `post=${exactVisibleRecovery.sourceUrl || 'unknown'}`,
            `method=${exactVisibleRecovery.extractionMethod}`,
            `textChars=${String(exactVisibleRecovery.text || '').length}`,
            `images=${Array.isArray(exactVisibleRecovery.imageUrls) ? exactVisibleRecovery.imageUrls.length : 0}`,
        );
    }

    const result = {
        page: keepPageOpen ? page : null,
        ...extracted,
    };
    trace?.('browser.result', {
        ...result,
        page: keepPageOpen ? '[PLAYWRIGHT PAGE KEPT OPEN]' : null,
    });
    return result;
    } catch (error) {
        trace?.('browser.error', {
            url,
            finalUrl: page?.url?.() || '',
            error,
        });
        throw error;
    } finally {
        // Public/event capture is a finite pass by default. Closing the tab is
        // cleanup, not the stop signal. Only an explicitly pinned/manual-live
        // caller may keep this page open.
        const wasClosed = page.isClosed();
        if (!keepPageOpen && !wasClosed) {
            await page.close().catch(() => {});
        }
        trace?.('browser.cleanup', {
            requestedUrl: url,
            finalUrl: page?.url?.() || '',
            keepPageOpen,
            wasClosed,
            isClosed: page.isClosed(),
        });
    }
}
