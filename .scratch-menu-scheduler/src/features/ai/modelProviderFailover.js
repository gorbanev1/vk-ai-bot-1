import { setTimeout as sleepTimer } from 'node:timers/promises';
import { getCurrentOperationSignal } from '../../runtime/operationSupervisor.js';

function clean(value) {
    return String(value ?? '').trim();
}

// Diagnostics must never turn a successful paid inference into a retry.
// An async telemetry rejection is likewise independent from the model result.
function emitFailoverEvent(onEvent, event) {
    if (typeof onEvent !== 'function') return;
    try {
        const result = onEvent(event);
        if (result && typeof result.then === 'function') {
            void Promise.resolve(result).catch(() => {});
        }
    } catch {
        // Best-effort telemetry only.
    }
}

function positiveInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function nonNegativeInteger(value, fallback) {
    const parsed = Number.parseInt(value, 10);
    return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : fallback;
}

function collectNumberedEnvironment(env, prefix) {
    const rows = [];
    const seen = new Set();
    const push = (name, value) => {
        const secret = clean(value);
        if (!secret || seen.has(secret)) return;
        seen.add(secret);
        rows.push({ name, secret });
    };

    push(prefix, env?.[prefix]);
    for (let index = 1; index <= 20; index += 1) {
        push(`${prefix}_${index}`, env?.[`${prefix}_${index}`]);
    }
    return rows;
}

function normalizeBaseUrl(value, fallback) {
    return clean(value || fallback).replace(/\/$/u, '');
}

function providerOrder(env = process.env) {
    const explicit = clean(env.AI_PROVIDER_ORDER || env.AI_PRIMARY_PROVIDER)
        .toLowerCase()
        .split(/[;,\s]+/u)
        .map((item) => {
            if (/^(?:compat|openai-compatible|router)$/u.test(item)) return 'compat';
            if (/^(?:xai|grok)$/u.test(item)) return 'xai';
            return '';
        })
        .filter(Boolean);
    const unique = [...new Set(explicit)];
    for (const fallback of ['compat', 'xai']) {
        if (!unique.includes(fallback)) unique.push(fallback);
    }
    return unique;
}

export function collectRuntimeModelCredentials(env = process.env) {
    const credentials = [];

    for (const row of collectNumberedEnvironment(env, 'OPENAI_COMPAT_API_KEY')) {
        const suffix = row.name.slice('OPENAI_COMPAT_API_KEY'.length);
        credentials.push({
            provider: 'compat',
            name: row.name,
            secret: row.secret,
            baseUrl: normalizeBaseUrl(
                env?.[`OPENAI_COMPAT_BASE_URL${suffix}`] || env?.OPENAI_COMPAT_BASE_URL,
                'https://router.cheap/v1',
            ),
        });
    }

    for (const row of collectNumberedEnvironment(env, 'XAI_API_KEY')) {
        const suffix = row.name.slice('XAI_API_KEY'.length);
        credentials.push({
            provider: 'xai',
            name: row.name,
            secret: row.secret,
            baseUrl: normalizeBaseUrl(
                env?.[`XAI_BASE_URL${suffix}`] || env?.XAI_BASE_URL,
                'https://api.x.ai/v1',
            ),
        });
    }

    const order = providerOrder(env);
    return credentials.sort((left, right) => {
        const providerDelta = order.indexOf(left.provider) - order.indexOf(right.provider);
        if (providerDelta) return providerDelta;
        return left.name.localeCompare(right.name, 'en', { numeric: true });
    });
}

export function resolveProviderModel({
    credential,
    capability = 'text',
    mode = 'default',
    requestedModel = '',
    env = process.env,
} = {}) {
    const provider = clean(credential?.provider);
    if (provider !== 'xai') return clean(requestedModel);

    // GPT-6 Astra is an OpenAI model: never silently substitute Grok for an explicit Astra route.
    if (String(mode ?? '').trim() === 'astra') return '';

    if (capability === 'image') {
        return clean(env.XAI_IMAGE_MODEL) || 'grok-imagine-image-2.0';
    }
    if (capability === 'vision') {
        return clean(env.XAI_VISION_MODEL || env.XAI_MODEL_DEFAULT) || 'grok-4.6';
    }

    const suffix = {
        default: 'DEFAULT',
        gpt54: 'GPT54',
        gpt55: 'GPT55',
        pro: 'PRO',
        pro2: 'PRO2',
        pro3: 'PRO3',
    }[String(mode ?? '').trim()] || 'DEFAULT';
    return clean(env[`XAI_MODEL_${suffix}`] || env.XAI_MODEL_DEFAULT) || 'grok-4.6';
}

const credentialHealth = new Map();

function healthKey(credential) {
    // V188.58: health is model/capability scoped. A slow or broken model must
    // not quarantine the only provider credential for every later ladder step.
    // Credentials without a resolved model keep the legacy provider:key key,
    // preserving standalone credential-health semantics.
    const base = `${clean(credential?.provider)}:${clean(credential?.name)}`;
    const model = clean(credential?.model);
    const capability = clean(credential?.capability);
    return model ? `${base}:${capability || 'any'}:${model}` : base;
}

export function resetRuntimeModelCredentialHealth() {
    credentialHealth.clear();
}

function getHealth(credential) {
    const key = healthKey(credential);
    const current = credentialHealth.get(key) || {
        failures: 0,
        quarantinedUntil: 0,
        lastError: '',
    };
    credentialHealth.set(key, current);
    return current;
}

function markSuccess(credential) {
    const state = getHealth(credential);
    state.failures = 0;
    state.quarantinedUntil = 0;
    state.lastError = '';
}

function markFailure(credential, error, { failuresBeforeQuarantine, quarantineMs }) {
    const state = getHealth(credential);
    state.failures += 1;
    state.lastError = clean(error?.message || error).slice(0, 500);
    if (state.failures >= failuresBeforeQuarantine) {
        state.quarantinedUntil = Date.now() + quarantineMs;
        state.failures = 0;
        return true;
    }
    return false;
}

export function isTechnicalModelFailure(error) {
    if (error?.probeOnly) return false;
    // Never turn an ambiguous/started paid inference into another model POST.
    // A known responseId must be resumed/polled by the caller instead.
    if (
        error?.inferenceMayHaveStarted ||
        error?.streamOutputStarted ||
        error?.responseId ||
        error?.inferenceCompleted
    ) {
        return false;
    }
    if (error?.name === 'AbortError' || error?.code === 'OPERATION_ABORTED') {
        return false;
    }
    if (error?.code === 'EMPTY_MODEL_TEXT' || error?.retryable === true) {
        return true;
    }

    const message = clean(error?.message || error);
    if (!message) return true;

    if (/\b(?:401|403)\b/iu.test(message) && /(?:api|http|gpt|xai|model|key|unauthor|forbidden)/iu.test(message)) {
        return true;
    }
    if (/\b(?:408|409|425|429|500|502|503|504|520|521|522|523|524|525|526|527|529|530)\b/iu.test(message)) {
        return true;
    }
    if (/fetch failed|network|econn|etimedout|enotfound|eai_again|socket|timeout|abort|terminated|connection\s+(?:closed|reset|refused)|empty\s+(?:answer|response)|пуст(?:ой|ого)\s+ответ|поток\s+без\s+текст/iu.test(message)) {
        return true;
    }
    if (/upstream|temporar|capacity|busy|try\s+later|rate\s*limit|overload/iu.test(message)) {
        return true;
    }
    return false;
}

function retryDelayMs(attempt, env = process.env) {
    const base = positiveInteger(env.AI_KEY_RETRY_BASE_MS, 1_500);
    const maximum = positiveInteger(env.AI_KEY_RETRY_MAX_MS, 15_000);
    return Math.min(maximum, base * (2 ** Math.max(0, attempt - 1)));
}

function throwIfAborted(signal) {
    if (!signal?.aborted) return;
    const reason = signal.reason;
    if (reason instanceof Error) throw reason;
    const error = new Error('AI failover aborted by operation supervisor.');
    error.name = 'AbortError';
    error.code = 'OPERATION_ABORTED';
    throw error;
}

async function sleepWithSignal(milliseconds, sleep, signal) {
    throwIfAborted(signal);
    const delayPromise = Promise.resolve().then(() => sleep(milliseconds));
    if (!signal) return delayPromise;
    let removeAbortListener = null;
    const abortPromise = new Promise((_, reject) => {
        const onAbort = () => {
            try { throwIfAborted(signal); } catch (error) { reject(error); }
        };
        signal.addEventListener('abort', onAbort, { once: true });
        removeAbortListener = () => signal.removeEventListener('abort', onAbort);
    });
    try {
        return await Promise.race([delayPromise, abortPromise]);
    } finally {
        removeAbortListener?.();
    }
}

/**
 * Technical model failures are retried three times on the same credential,
 * then the credential is quarantined and the request moves to the next key.
 * If all configured credentials are temporarily unavailable, retryable
 * failures cycle again after the nearest quarantine expires. Configuration,
 * invalid-request and policy errors are not looped forever.
 */
export async function executeRuntimeModelFailover({
    candidates,
    request,
    shouldRetry = isTechnicalModelFailure,
    failuresBeforeQuarantine = positiveInteger(process.env.AI_KEY_FAILURES_BEFORE_ROTATE, 3),
    quarantineMs = positiveInteger(process.env.AI_KEY_QUARANTINE_SECONDS, 300) * 1000,
    maxRounds = nonNegativeInteger(process.env.AI_FAILOVER_MAX_ROUNDS, 0),
    useCredentialHealth = true,
    env = process.env,
    onEvent = null,
    signal = getCurrentOperationSignal(),
    sleep = (milliseconds) => sleepTimer(milliseconds),
} = {}) {
    if (typeof request !== 'function') throw new TypeError('request должен быть функцией.');
    const pool = (Array.isArray(candidates) ? candidates : []).filter((item) => item?.secret && item?.baseUrl);
    if (!pool.length) throw new Error('Не настроено ни одного ключа AI provider.');

    let round = 0;
    let lastError = null;

    while (maxRounds === 0 || round < maxRounds) {
        throwIfAborted(signal);
        round += 1;
        let attemptedThisRound = 0;
        let nearestQuarantine = Number.POSITIVE_INFINITY;

        for (const credential of pool) {
            throwIfAborted(signal);
            const state = useCredentialHealth ? getHealth(credential) : null;
            if (useCredentialHealth && state.quarantinedUntil > Date.now()) {
                nearestQuarantine = Math.min(nearestQuarantine, state.quarantinedUntil);
                if (!lastError && state.lastError) {
                    const quarantinedError = new Error(
                        `AI provider временно в карантине после предыдущей ошибки: ${state.lastError}`,
                    );
                    quarantinedError.code = 'AI_CREDENTIAL_QUARANTINED';
                    quarantinedError.provider = clean(credential?.provider);
                    quarantinedError.credentialName = clean(credential?.name);
                    quarantinedError.quarantinedUntil = state.quarantinedUntil;
                    lastError = quarantinedError;
                }
                emitFailoverEvent(onEvent, { type: 'skip-quarantined', credential, until: state.quarantinedUntil, round });
                continue;
            }

            for (let attempt = 1; attempt <= failuresBeforeQuarantine; attempt += 1) {
                throwIfAborted(signal);
                attemptedThisRound += 1;
                const attemptStartedAt = Date.now();
                try {
                    emitFailoverEvent(onEvent, { type: 'attempt-start', credential, attempt, round });
                    const value = await request(credential, { attempt, round });
                    if (useCredentialHealth) markSuccess(credential);
                    emitFailoverEvent(onEvent, { type: 'success', credential, attempt, round, durationMs: Math.max(0, Date.now() - attemptStartedAt) });
                    return { value, credential, attempt, round };
                } catch (error) {
                    lastError = error;
                    const retryable = Boolean(shouldRetry(error));
                    emitFailoverEvent(onEvent, { type: 'failure', credential, attempt, round, retryable, error, durationMs: Math.max(0, Date.now() - attemptStartedAt) });
                    if (!retryable) throw error;

                    if (!useCredentialHealth) {
                        if (attempt >= failuresBeforeQuarantine) {
                            emitFailoverEvent(onEvent, { type: 'rotate', credential, attempt, round, error });
                            break;
                        }
                        await sleepWithSignal(retryDelayMs(attempt, env), sleep, signal);
                        continue;
                    }

                    const quarantined = markFailure(credential, error, {
                        failuresBeforeQuarantine,
                        quarantineMs,
                    });
                    if (quarantined) {
                        emitFailoverEvent(onEvent, { type: 'rotate', credential, attempt, round, error });
                        break;
                    }
                    await sleepWithSignal(retryDelayMs(attempt, env), sleep, signal);
                }
            }
        }

        if (maxRounds > 0 && round >= maxRounds) break;

        const now = Date.now();
        const waitMs = Number.isFinite(nearestQuarantine)
            ? Math.max(500, nearestQuarantine - now)
            : (attemptedThisRound ? positiveInteger(env.AI_ALL_KEYS_RETRY_MS, 15_000) : 1_000);
        emitFailoverEvent(onEvent, { type: 'all-unavailable', round, waitMs, error: lastError });
        await sleepWithSignal(waitMs, sleep, signal);
    }

    throw lastError || new Error('Все AI provider/key завершились с ошибкой.');
}
