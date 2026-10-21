/**
 * Serializes browser recovery for VK event sources that were parsed as events
 * but did not receive a local source image. The queue deliberately owns only
 * scheduling/deduplication; the caller re-checks the database before opening
 * a source and performs the actual reparse/update.
 */

function normalizeSourceUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        url.hash = '';
        url.search = '';
        url.pathname = url.pathname.replace(/\/+$/u, '');
        return url.toString();
    } catch {
        return raw.replace(/[#?].*$/u, '').replace(/\/+$/u, '');
    }
}

function isVkWallUrl(value) {
    try {
        const url = new URL(String(value ?? '').trim());
        return /^https?:$/iu.test(url.protocol) && /(?:^|\.)vk\.(?:com|ru)$/iu.test(url.hostname) && /\/(?:wall-?\d+_\d+|wall\d+_\d+)/iu.test(url.pathname);
    } catch {
        return false;
    }
}

export function createVkMissingImageRecoveryQueue({
    processSource,
    sleep = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)),
    random = Math.random,
    minDelayMs = 7_000,
    maxDelayMs = 15_000,
    maxPending = 500,
    maxAttemptsPerSource = 2,
    log = () => {},
} = {}) {
    if (typeof processSource !== 'function') throw new TypeError('processSource is required');
    const pending = new Map();
    const attempts = new Map();
    const active = new Set();
    const idleWaiters = [];
    let running = false;
    let opened = false;

    const resolveIdle = () => {
        if (running || pending.size) return;
        while (idleWaiters.length) idleWaiters.shift()();
    };

    const drain = async () => {
        if (running) return;
        running = true;
        try {
            while (pending.size) {
                const [key, item] = pending.entries().next().value;
                pending.delete(key);
                active.add(item.sourceUrl);
                try {
                    if (opened) {
                        const low = Math.max(0, Number(minDelayMs) || 0);
                        const high = Math.max(low, Number(maxDelayMs) || low);
                        const ratio = Math.min(1, Math.max(0, Number(random()) || 0));
                        const delayMs = low + Math.floor(ratio * (high - low + 1));
                        log('stagger', { sourceUrl: item.sourceUrl, delayMs, pending: pending.size });
                        await sleep(delayMs);
                    }
                    opened = true;
                    attempts.set(item.sourceUrl, Number(attempts.get(item.sourceUrl) || 0) + 1);
                    log('open', { sourceUrl: item.sourceUrl, pending: pending.size });
                    await processSource(item);
                } catch (error) {
                    log('error', { sourceUrl: item.sourceUrl, error: String(error?.message ?? error) });
                } finally {
                    active.delete(item.sourceUrl);
                }
            }
        } finally {
            running = false;
            resolveIdle();
            if (pending.size) void drain();
        }
    };

    const schedule = ({ sourceUrl, screenName = '', postId = '' } = {}) => {
        const normalized = normalizeSourceUrl(sourceUrl);
        if (!isVkWallUrl(normalized)) return { scheduled: false, reason: 'not-vk-wall' };
        if (Number(attempts.get(normalized) || 0) >= Math.max(1, Number(maxAttemptsPerSource) || 1)) {
            return { scheduled: false, reason: 'attempt-limit' };
        }
        if (active.has(normalized)) return { scheduled: false, reason: 'duplicate-active' };
        if (pending.has(normalized)) {
            const current = pending.get(normalized);
            pending.set(normalized, { ...current, screenName: screenName || current.screenName, postId: postId || current.postId });
            return { scheduled: false, reason: 'duplicate-pending' };
        }
        if (pending.size >= Math.max(1, Number(maxPending) || 1)) return { scheduled: false, reason: 'queue-full' };
        pending.set(normalized, { sourceUrl: normalized, screenName: String(screenName || ''), postId: String(postId || '') });
        void drain();
        return { scheduled: true, sourceUrl: normalized };
    };

    const waitForIdle = () => running || pending.size
        ? new Promise((resolve) => idleWaiters.push(resolve))
        : Promise.resolve();

    return { schedule, waitForIdle, size: () => pending.size, isRunning: () => running };
}

