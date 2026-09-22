function clampInteger(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export function getManualParserProcessingConcurrency(env = process.env) {
    return clampInteger(
        env.MANUAL_PARSER_PROCESSING_CONCURRENCY,
        1,
        16,
        6,
    );
}


export function createManualParserLimiter(concurrency = getManualParserProcessingConcurrency()) {
    const limit = clampInteger(concurrency, 1, 16, 6);
    let active = 0;
    let waiterSequence = 0;
    let drainTimer = null;
    const waiters = [];

    function drainWaiters() {
        drainTimer = null;
        waiters.sort((left, right) => right.priority - left.priority || left.seq - right.seq);
        while (active < limit && waiters.length) {
            const next = waiters.shift();
            active += 1;
            next?.resolvePromise?.();
        }
    }

    function scheduleDrain(delayMs = 0) {
        if (drainTimer) return;
        drainTimer = setTimeout(drainWaiters, Math.max(0, Number(delayMs) || 0));
    }

    async function acquire(priority = 0) {
        const safePriority = Number.isFinite(Number(priority)) ? Number(priority) : 0;
        await new Promise((resolvePromise) => {
            waiters.push({ resolvePromise, priority: safePriority, seq: waiterSequence++ });
            // Tiny initial arbitration window lets parser-all sources enqueue their
            // strongest candidates before the first six slots are assigned. Without
            // it whichever source resumes first can monopolize all slots even when a
            // much stronger dated/wall/poster candidate is already ready elsewhere.
            scheduleDrain(active === 0 ? 20 : 0);
        });
    }

    function release() {
        active = Math.max(0, active - 1);
        if (waiters.length) scheduleDrain(0);
    }

    return {
        limit,
        async run(task, { priority = 0 } = {}) {
            if (typeof task !== 'function') {
                throw new TypeError('manual parser limiter task must be a function');
            }
            await acquire(priority);
            try {
                return await task();
            } finally {
                release();
            }
        },
        get active() {
            return active;
        },
        get queued() {
            return waiters.length;
        },
    };
}

async function safeItemState(onItemState, event) {
    if (typeof onItemState !== 'function') return;
    try {
        await onItemState(event);
    } catch (error) {
        // A telemetry failure is not a worker failure and must not trigger paid retries.
        console.warn('[MANUAL PARSER DIAGNOSTICS ERROR]', String(error?.message || error));
    }
}

export async function runManualParserPool(items, worker, {
    concurrency = getManualParserProcessingConcurrency(),
    onItemState = null,
    limiter = null,
    getPriority = null,
} = {}) {
    if (typeof worker !== 'function') {
        throw new TypeError('runManualParserPool: worker must be a function');
    }

    const source = Array.isArray(items) ? items : [];
    if (!source.length) return [];

    const results = new Array(source.length);
    let nextIndex = 0;
    const workerCount = Math.min(
        source.length,
        clampInteger(concurrency, 1, 16, 6),
    );

    const runners = Array.from({ length: workerCount }, async (_, workerIndex) => {
        while (true) {
            const index = nextIndex;
            nextIndex += 1;
            if (index >= source.length) return;

            const item = source[index];
            const queuedAt = Date.now();
            let priority = 0;
            try {
                const rawPriority = getPriority?.(item, index);
                priority = Number.isFinite(Number(rawPriority)) ? Number(rawPriority) : 0;
            } catch (error) {
                // One invalid item must not reject the entire parser run and
                // leave unrelated source records with a stale processing status.
                results[index] = { status: 'rejected', reason: error };
                await safeItemState(onItemState, {
                    type: 'rejected', item, index, workerIndex, error,
                    durationMs: Math.max(0, Date.now() - queuedAt), priority: 0,
                });
                continue;
            }
            await safeItemState(onItemState, { type: 'queued', item, index, workerIndex, queuedAt, priority });
            try {
                const execute = async () => {
                    const slotAcquiredAt = Date.now();
                    const queueWaitMs = Math.max(0, slotAcquiredAt - queuedAt);
                    await safeItemState(onItemState, {
                        type: 'slot',
                        item,
                        index,
                        workerIndex,
                        queuedAt,
                        slotAcquiredAt,
                        queueWaitMs,
                        limiterActive: Number(limiter?.active ?? 0),
                        limiterQueued: Number(limiter?.queued ?? 0),
                        limiterLimit: Number(limiter?.limit ?? concurrency),
                        priority,
                    });
                    await safeItemState(onItemState, {
                        type: 'start',
                        item,
                        index,
                        workerIndex,
                        queuedAt,
                        slotAcquiredAt,
                        queueWaitMs,
                        priority,
                    });
                    return worker(item, index, workerIndex);
                };
                const value = limiter && typeof limiter.run === 'function'
                    ? await limiter.run(execute, { priority })
                    : await execute();
                results[index] = { status: 'fulfilled', value };
                await safeItemState(onItemState, {
                    type: 'fulfilled',
                    item,
                    index,
                    workerIndex,
                    value,
                    durationMs: Math.max(0, Date.now() - queuedAt),
                    priority,
                });
            } catch (error) {
                results[index] = { status: 'rejected', reason: error };
                await safeItemState(onItemState, {
                    type: 'rejected',
                    item,
                    index,
                    workerIndex,
                    error,
                    durationMs: Math.max(0, Date.now() - queuedAt),
                    priority,
                });
            }
        }
    });

    await Promise.all(runners);
    return results;
}

export function parserCandidatePreview(value, maximum = 30) {
    const normalized = String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
    if (!normalized) return '(без текста)';
    const safeMaximum = clampInteger(maximum, 1, 200, 30);
    return normalized.length > safeMaximum
        ? `${normalized.slice(0, safeMaximum)}…`
        : normalized;
}

/**
 * Background-safe processing loop. The 10-minute owner status boundary lives
 * outside this function. Retryable AI work is allowed to recover, but V188.54
 * adds hard retry/elapsed ceilings so one bad provider cannot keep parser-all
 * alive for many hours. Exhausted unresolved items are returned as explicit
 * rejections instead of being silently retried forever.
 */
export async function runManualParserPoolUntilSettled(items, worker, {
    concurrency = getManualParserProcessingConcurrency(),
    onItemState = null,
    limiter = null,
    getPriority = null,
    isUnresolvedValue = (value) => Boolean(value?.unresolved),
    isRetryableFailure = () => false,
    retryDelayMs = 15_000,
    maxRetryCycles = 6,
    maxRetryElapsedMs = 2 * 60 * 60 * 1000,
    onRetryCycle = null,
    onRetryExhausted = null,
} = {}) {
    const source = Array.isArray(items) ? items : [];
    if (!source.length) return [];

    const finalResults = new Array(source.length);
    let pending = source.map((item, originalIndex) => ({ item, originalIndex, lastResult: null }));
    let cycle = 0;
    const startedAt = Date.now();
    const safeMaxCycles = clampInteger(maxRetryCycles, 1, 100, 6);
    const safeMaxElapsedMs = clampInteger(
        maxRetryElapsedMs,
        60_000,
        24 * 60 * 60 * 1000,
        2 * 60 * 60 * 1000,
    );

    while (pending.length) {
        cycle += 1;
        const batch = pending;
        const results = await runManualParserPool(
            batch.map((entry) => entry.item),
            worker,
            {
                concurrency,
                limiter,
                getPriority,
                onItemState: onItemState
                    ? (event) => onItemState({ ...event, retryCycle: cycle })
                    : null,
            },
        );

        const retry = [];
        for (let index = 0; index < batch.length; index += 1) {
            const entry = batch[index];
            const result = results[index];
            entry.lastResult = result;
            const unresolved = result?.status === 'fulfilled' && Boolean(
                isUnresolvedValue?.(result.value, entry.item, { cycle, result }),
            );
            const retryableFailure = result?.status === 'rejected' && Boolean(
                isRetryableFailure?.(result.reason, entry.item, { cycle, result }),
            );

            if (unresolved || retryableFailure) {
                retry.push(entry);
            } else {
                finalResults[entry.originalIndex] = result;
            }
        }

        if (!retry.length) break;

        const elapsedMs = Math.max(0, Date.now() - startedAt);
        const cycleLimitReached = cycle >= safeMaxCycles;
        const elapsedLimitReached = elapsedMs >= safeMaxElapsedMs;
        if (cycleLimitReached || elapsedLimitReached) {
            const reason = cycleLimitReached
                ? `retry-cycle-limit-${safeMaxCycles}`
                : `retry-elapsed-limit-${safeMaxElapsedMs}ms`;
            await onRetryExhausted?.({
                cycle,
                pending: retry.map((entry) => entry.item),
                pendingCount: retry.length,
                elapsedMs,
                reason,
            });
            for (const entry of retry) {
                const previous = entry.lastResult;
                if (previous?.status === 'rejected') {
                    finalResults[entry.originalIndex] = previous;
                    continue;
                }
                const error = new Error(
                    `Manual parser retry exhausted (${reason}); item remained unresolved after ${cycle} cycle(s).`,
                );
                error.code = 'MANUAL_PARSER_RETRY_EXHAUSTED';
                finalResults[entry.originalIndex] = {
                    status: 'rejected',
                    reason: error,
                };
            }
            break;
        }

        await onRetryCycle?.({
            cycle,
            pending: retry.map((entry) => entry.item),
            pendingCount: retry.length,
            elapsedMs,
            maxRetryCycles: safeMaxCycles,
            maxRetryElapsedMs: safeMaxElapsedMs,
        });
        const delay = clampInteger(retryDelayMs, 1_000, 5 * 60 * 1000, 15_000);
        await new Promise((resolvePromise) => {
            const timer = setTimeout(resolvePromise, delay);
            timer.unref?.();
        });
        pending = retry;
    }

    return finalResults;
}
