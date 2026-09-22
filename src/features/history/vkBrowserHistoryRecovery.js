import { mkdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

let persistentContext = null;
let persistentPage = null;
let launchPromise = null;

function getProfileDirectory() {
    const base = String(
        process.env.LOCALAPPDATA ||
        process.env.APPDATA ||
        homedir(),
    ).trim();
    const configured = String(process.env.VK_HISTORY_BROWSER_PROFILE_DIR ?? '').trim();
    return configured || join(base, 'Gigorave', 'vk-history-browser');
}

function normalizeBrowserMessage(raw, peerId) {
    if (!raw || typeof raw !== 'object') return null;

    const cmid = Number(
        raw.conversation_message_id ??
        raw.conversationMessageId ??
        raw.cmid ??
        raw.conversationMessageID ??
        0,
    );
    if (!Number.isSafeInteger(cmid) || cmid <= 0) return null;

    const rawPeerId = Number(raw.peer_id ?? raw.peerId ?? 0);
    // Raw VK message objects normally carry peer_id. Require it here so
    // conversation-list/network payloads from other chats cannot be imported
    // accidentally. DOM fallback below is scoped to the opened chat page.
    if (!Number.isSafeInteger(rawPeerId) || rawPeerId !== Number(peerId)) {
        return null;
    }

    const senderId = Number(
        raw.from_id ??
        raw.fromId ??
        raw.sender_id ??
        raw.senderId ??
        raw.author_id ??
        raw.authorId ??
        0,
    );
    const createdAt = Number(raw.date ?? raw.created_at ?? raw.createdAt ?? 0);
    const text = String(raw.text ?? raw.message ?? raw.body ?? '').trim();

    return {
        peerId: Number(peerId),
        senderId: Number.isSafeInteger(senderId) ? senderId : 0,
        conversationMessageId: cmid,
        text,
        createdAt: Number.isFinite(createdAt) && createdAt > 0
            ? createdAt
            : Math.floor(Date.now() / 1000),
    };
}

function collectMessagesFromPayload(payload, peerId, destination, depth = 0) {
    if (depth > 12 || payload == null) return;

    if (Array.isArray(payload)) {
        for (const item of payload) {
            collectMessagesFromPayload(item, peerId, destination, depth + 1);
        }
        return;
    }

    if (typeof payload !== 'object') return;

    const normalized = normalizeBrowserMessage(payload, peerId);
    if (normalized) {
        destination.set(normalized.conversationMessageId, normalized);
    }

    for (const value of Object.values(payload)) {
        if (value && (typeof value === 'object')) {
            collectMessagesFromPayload(value, peerId, destination, depth + 1);
        }
    }
}

async function ensureBrowser(logger = console) {
    if (persistentContext && persistentPage && !persistentPage.isClosed()) {
        return { context: persistentContext, page: persistentPage };
    }
    if (launchPromise) return launchPromise;

    launchPromise = (async () => {
        const { chromium } = await import('playwright');
        const profileDirectory = getProfileDirectory();
        mkdirSync(profileDirectory, { recursive: true });

        let context;
        try {
            context = await chromium.launchPersistentContext(profileDirectory, {
                channel: 'chrome',
                headless: false,
                viewport: null,
                args: [
                    '--disable-blink-features=AutomationControlled',
                    '--start-maximized',
                ],
            });
        } catch (error) {
            logger.warn?.(
                '[VK BROWSER RECOVERY CHROME FALLBACK]',
                String(error?.message ?? error).slice(0, 400),
            );
            context = await chromium.launchPersistentContext(profileDirectory, {
                headless: false,
                viewport: null,
            });
        }

        const pages = context.pages();
        const page = pages[0] || await context.newPage();
        persistentContext = context;
        persistentPage = page;
        context.on('close', () => {
            persistentContext = null;
            persistentPage = null;
        });
        return { context, page };
    })().finally(() => {
        launchPromise = null;
    });

    return launchPromise;
}

async function looksLoggedOut(page) {
    const url = String(page.url() ?? '');
    if (/id\.vk\.com|login|join|auth/iu.test(url) && !/\/im(?:\?|\/)/iu.test(url)) {
        return true;
    }

    return page.evaluate(() => Boolean(
        document.querySelector('input[name="login"], input[name="email"], input[type="tel"]') &&
        !document.querySelector('[data-cmid], [data-conversation-message-id], .im-mess, [class*="ConvoHistory"]')
    )).catch(() => false);
}

async function extractDomMessages(page, peerId) {
    return page.evaluate((targetPeerId) => {
        const result = [];
        const selectors = [
            '[data-cmid]',
            '[data-conversation-message-id]',
            '.im-mess',
            '[class*="ConvoHistory__message"]',
            '[class*="Message"]',
        ];
        const nodes = [...new Set(selectors.flatMap((selector) => [
            ...document.querySelectorAll(selector),
        ]))];

        const numberFrom = (value) => {
            const match = String(value ?? '').match(/-?\d+/u);
            return match ? Number(match[0]) : 0;
        };

        for (const node of nodes) {
            const html = String(node.outerHTML ?? '');
            const cmid = numberFrom(
                node.getAttribute?.('data-cmid') ||
                node.getAttribute?.('data-conversation-message-id') ||
                html.match(/(?:conversation_message_id|conversationMessageId|cmid)[^\d]{0,15}(\d+)/iu)?.[1],
            );
            if (!Number.isSafeInteger(cmid) || cmid <= 0) continue;

            const rawPeer = numberFrom(
                node.getAttribute?.('data-peer-id') ||
                node.getAttribute?.('data-peer') ||
                html.match(/(?:peer_id|peerId)[^\d-]{0,15}(-?\d+)/iu)?.[1],
            );
            if (rawPeer > 0 && rawPeer !== Number(targetPeerId)) continue;

            const senderId = numberFrom(
                node.getAttribute?.('data-from-id') ||
                node.getAttribute?.('data-sender-id') ||
                node.getAttribute?.('data-author-id') ||
                html.match(/(?:from_id|fromId|sender_id|senderId|author_id|authorId)[^\d-]{0,15}(-?\d+)/iu)?.[1] ||
                html.match(/href=["'][^"']*\/id(\d+)/iu)?.[1],
            );
            const timestamp = numberFrom(
                node.getAttribute?.('data-date') ||
                node.getAttribute?.('data-ts') ||
                node.querySelector?.('time')?.getAttribute?.('datetime') ||
                html.match(/(?:date|timestamp|created_at)[^\d]{0,15}(\d{10,13})/iu)?.[1],
            );
            const createdAt = timestamp > 10_000_000_000
                ? Math.floor(timestamp / 1000)
                : timestamp;
            const textNode = node.querySelector?.(
                '.im-mess--text, [class*="MessageText"], [class*="messageText"], [class*="Text"]',
            );
            const text = String(textNode?.innerText || node.innerText || '')
                .replace(/\s+/gu, ' ')
                .trim()
                .slice(0, 20_000);

            result.push({
                peerId: Number(targetPeerId),
                senderId: Number.isSafeInteger(senderId) ? senderId : 0,
                conversationMessageId: cmid,
                text,
                createdAt: Number.isFinite(createdAt) && createdAt > 0
                    ? createdAt
                    : Math.floor(Date.now() / 1000),
            });
        }

        return result;
    }, Number(peerId)).catch(() => []);
}

async function scrollHistoryUp(page) {
    return page.evaluate(() => {
        const candidates = [...document.querySelectorAll('div, main, section')]
            .map((element) => {
                const style = getComputedStyle(element);
                const delta = element.scrollHeight - element.clientHeight;
                const overflow = `${style.overflowY} ${style.overflow}`;
                const messageCount = element.querySelectorAll(
                    '[data-cmid], [data-conversation-message-id], .im-mess, [class*="ConvoHistory__message"]',
                ).length;
                return { element, delta, overflow, messageCount };
            })
            .filter((item) => item.delta > 300 && /auto|scroll/iu.test(item.overflow))
            .sort((left, right) => (
                (right.messageCount * 1_000_000 + right.delta) -
                (left.messageCount * 1_000_000 + left.delta)
            ));

        const target = candidates[0]?.element || document.scrollingElement || document.documentElement;
        const before = Number(target.scrollTop || 0);
        target.scrollTop = 0;
        target.dispatchEvent(new Event('scroll', { bubbles: true }));
        window.scrollTo(0, 0);

        return {
            before,
            after: Number(target.scrollTop || 0),
            scrollHeight: Number(target.scrollHeight || 0),
            clientHeight: Number(target.clientHeight || 0),
            messageCount: Number(candidates[0]?.messageCount || 0),
        };
    }).catch(() => null);
}

export async function recoverVkHistoryThroughBrowser({
    peerId,
    saveMessage,
    logger = console,
    maxScrollCycles = Number(process.env.VK_HISTORY_BROWSER_MAX_SCROLLS || 900),
    cutoffTimestamp = 0,
    maxMessages = Number.POSITIVE_INFINITY,
} = {}) {
    const numericPeer = Number(peerId);
    if (!Number.isSafeInteger(numericPeer) || numericPeer < 2_000_000_000) {
        throw new Error(`Invalid VK browser history peer: ${peerId}`);
    }
    if (typeof saveMessage !== 'function') {
        throw new TypeError('saveMessage callback is required');
    }

    const safeCutoffTimestamp = Math.max(0, Number(cutoffTimestamp) || 0);
    const numericMaxMessages = Number(maxMessages);
    const safeMaxMessages = Number.isSafeInteger(numericMaxMessages) && numericMaxMessages > 0
        ? numericMaxMessages
        : Number.POSITIVE_INFINITY;

    const { page } = await ensureBrowser(logger);
    const chatId = numericPeer - 2_000_000_000;
    const captured = new Map();

    const responseListener = async (response) => {
        try {
            const url = String(response.url() ?? '');
            if (!/vk\.com/iu.test(url)) return;
            const contentType = String(response.headers()?.['content-type'] ?? '');
            if (!/json|javascript|text/iu.test(contentType)) return;
            const body = await response.text();
            if (!body || body.length > 25_000_000) return;
            if (!/(conversation_message_id|"cmid"|from_id)/u.test(body)) return;
            let payload;
            try {
                payload = JSON.parse(body);
            } catch {
                return;
            }
            collectMessagesFromPayload(payload, numericPeer, captured);
        } catch {
            // Network interception is opportunistic; DOM extraction is a fallback.
        }
    };

    page.on('response', responseListener);

    try {
        const urls = [
            `https://vk.com/im?sel=c${chatId}`,
        ];
        let opened = false;
        for (const url of urls) {
            try {
                await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 45_000 });
                await page.waitForTimeout(2_500);
                opened = true;
                if (!(await looksLoggedOut(page))) break;
            } catch (error) {
                logger.warn?.(
                    '[VK BROWSER RECOVERY NAV ERROR]',
                    `url=${url}`,
                    String(error?.message ?? error).slice(0, 300),
                );
            }
        }

        if (!opened || await looksLoggedOut(page)) {
            logger.warn?.(
                '[VK BROWSER RECOVERY LOGIN REQUIRED]',
                `peer=${numericPeer}`,
                `profile=${getProfileDirectory()}`,
                'Chrome window left open. Sign in to VK once; the next recovery cycle will continue automatically.',
            );
            return {
                ok: false,
                loginRequired: true,
                captured: 0,
                saved: 0,
                reachedCutoff: false,
                reachedLimit: false,
            };
        }

        logger.log?.(
            '[VK BROWSER RECOVERY START]',
            `peer=${numericPeer}`,
            `chatId=${chatId}`,
            `cutoff=${safeCutoffTimestamp || 'none'}`,
            `max=${Number.isFinite(safeMaxMessages) ? safeMaxMessages : 'unlimited'}`,
        );

        let previousOldest = Number.POSITIVE_INFINITY;
        let stagnantCycles = 0;
        let saved = 0;
        let reachedCutoff = false;
        let reachedLimit = false;
        const hardLimit = Math.max(20, Math.min(10_000, Number(maxScrollCycles) || 900));

        for (let cycle = 1; cycle <= hardLimit; cycle += 1) {
            const domMessages = await extractDomMessages(page, numericPeer);
            for (const message of domMessages) {
                captured.set(message.conversationMessageId, message);
            }

            const unsaved = [...captured.values()]
                .filter((message) => !message.__historyWindowChecked)
                .sort((left, right) => (
                    Number(right.createdAt || 0) - Number(left.createdAt || 0) ||
                    Number(right.conversationMessageId || 0) - Number(left.conversationMessageId || 0)
                ));

            for (const message of unsaved) {
                message.__historyWindowChecked = true;
                if (
                    safeCutoffTimestamp > 0 &&
                    Number(message.createdAt || 0) > 0 &&
                    Number(message.createdAt) < safeCutoffTimestamp
                ) {
                    continue;
                }
                if (saved >= safeMaxMessages) {
                    reachedLimit = true;
                    break;
                }
                saveMessage(message);
                saved += 1;
            }

            if (saved >= safeMaxMessages) reachedLimit = true;

            const domCreatedAt = domMessages
                .map((message) => Number(message?.createdAt || 0))
                .filter((timestamp) => Number.isFinite(timestamp) && timestamp > 0);
            if (
                safeCutoffTimestamp > 0 &&
                domCreatedAt.some((timestamp) => timestamp < safeCutoffTimestamp)
            ) {
                reachedCutoff = true;
            }

            const cmids = [...captured.keys()].filter((value) => Number.isSafeInteger(value));
            const oldest = cmids.length ? Math.min(...cmids) : Number.POSITIVE_INFINITY;
            if (oldest < previousOldest) {
                previousOldest = oldest;
                stagnantCycles = 0;
            } else {
                stagnantCycles += 1;
            }

            if (cycle === 1 || cycle % 10 === 0 || reachedCutoff || reachedLimit) {
                logger.log?.(
                    '[VK BROWSER RECOVERY PROGRESS]',
                    `peer=${numericPeer}`,
                    `cycle=${cycle}`,
                    `captured=${captured.size}`,
                    `checked=${saved}`,
                    `oldestCmid=${Number.isFinite(oldest) ? oldest : 0}`,
                    `cutoffReached=${reachedCutoff ? 'yes' : 'no'}`,
                    `limitReached=${reachedLimit ? 'yes' : 'no'}`,
                    `stagnant=${stagnantCycles}`,
                );
            }

            if (reachedCutoff || reachedLimit || oldest === 1 || stagnantCycles >= 18) break;

            await scrollHistoryUp(page);
            try {
                await page.keyboard.press('Home');
                await page.mouse.wheel(0, -18_000);
            } catch {
                // Continue with JS scrolling only.
            }
            await page.waitForTimeout(850);
        }

        logger.log?.(
            '[VK BROWSER RECOVERY DONE]',
            `peer=${numericPeer}`,
            `captured=${captured.size}`,
            `checked=${saved}`,
            `oldestCmid=${captured.size ? Math.min(...captured.keys()) : 0}`,
            `cutoffReached=${reachedCutoff ? 'yes' : 'no'}`,
            `limitReached=${reachedLimit ? 'yes' : 'no'}`,
        );

        return {
            ok: true,
            loginRequired: false,
            captured: captured.size,
            saved,
            reachedCutoff,
            reachedLimit,
        };
    } finally {
        page.off('response', responseListener);
    }
}

