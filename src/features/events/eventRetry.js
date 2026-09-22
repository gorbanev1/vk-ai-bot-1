/**
 * V186: единый пяти-круговый retry-контур event-ingest.
 *
 * Повторяется только упавшая операция, а не весь пост: успешный vision не
 * вызывается заново из-за последующей ошибки SQLite. Каждый exception получает
 * круги 1..5; логический результат `not_event` исключением не является.
 */

export const EVENT_OPERATION_MAX_ATTEMPTS = 5;

const DEFAULT_BASE_DELAY_MS = 500;
const DEFAULT_MAX_DELAY_MS = 4_000;

function clampInteger(value, minimum, maximum, fallback) {
    const parsed = Number(value);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.min(maximum, Math.max(minimum, Math.trunc(parsed)));
}

export function eventRetryDelayMs(failedAttempt, {
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maximumDelayMs = DEFAULT_MAX_DELAY_MS,
} = {}) {
    const attempt = Math.max(1, Number(failedAttempt) || 1);
    const base = clampInteger(baseDelayMs, 0, 60_000, DEFAULT_BASE_DELAY_MS);
    const maximum = clampInteger(maximumDelayMs, base, 120_000, DEFAULT_MAX_DELAY_MS);
    return Math.min(maximum, base * (2 ** Math.max(0, attempt - 1)));
}

function sleep(milliseconds) {
    const delay = Math.max(0, Number(milliseconds) || 0);
    if (!delay) return Promise.resolve();
    return new Promise((resolve) => setTimeout(resolve, delay));
}

function errorMessage(error) {
    return String(error?.message ?? error ?? 'unknown error').slice(0, 2000);
}

export async function runEventOperationWithRetries(operation, {
    label = 'event-operation',
    maxAttempts = EVENT_OPERATION_MAX_ATTEMPTS,
    baseDelayMs = DEFAULT_BASE_DELAY_MS,
    maximumDelayMs = DEFAULT_MAX_DELAY_MS,
    sleepFn = sleep,
    shouldRetry = () => true,
    onAttemptError = null,
    onRecovered = null,
    logger = console,
} = {}) {
    if (typeof operation !== 'function') {
        throw new TypeError('runEventOperationWithRetries: operation must be a function');
    }

    const attempts = clampInteger(
        maxAttempts,
        1,
        EVENT_OPERATION_MAX_ATTEMPTS,
        EVENT_OPERATION_MAX_ATTEMPTS,
    );
    let lastError = null;

    for (let attempt = 1; attempt <= attempts; attempt += 1) {
        try {
            const value = await operation({ attempt, maxAttempts: attempts });
            if (attempt > 1) {
                logger?.log?.(
                    '[EVENT RETRY RECOVERED]',
                    `stage=${label}`,
                    `attempt=${attempt}/${attempts}`,
                );
                await onRecovered?.({
                    label,
                    attempt,
                    round: attempt,
                    maxAttempts: attempts,
                    maxRounds: attempts,
                });
            }
            return value;
        } catch (error) {
            lastError = error;
            const retryable = Boolean(shouldRetry?.(error, { attempt, maxAttempts: attempts }));
            const willRetry = retryable && attempt < attempts;
            const delayMs = willRetry
                ? eventRetryDelayMs(attempt, { baseDelayMs, maximumDelayMs })
                : 0;
            const details = {
                label,
                attempt,
                round: attempt,
                maxAttempts: attempts,
                maxRounds: attempts,
                retryable,
                willRetry,
                delayMs,
                error,
                errorMessage: errorMessage(error),
            };

            logger?.warn?.(
                '[EVENT RETRY ERROR]',
                `stage=${label}`,
                `attempt=${attempt}/${attempts}`,
                `retry=${willRetry ? 'yes' : 'no'}`,
                details.errorMessage,
            );
            await onAttemptError?.(details);

            if (!willRetry) {
                try {
                    Object.defineProperties(error, {
                        eventRetryAttempts: { value: attempt, configurable: true },
                        eventRetryLabel: { value: label, configurable: true },
                    });
                } catch {}
                throw error;
            }

            await sleepFn(delayMs);
        }
    }

    throw lastError ?? new Error(`${label}: failed after ${attempts} attempts`);
}
