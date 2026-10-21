/**
 * Политика восстановления текстовых запросов к OpenAI-compatible router.
 * Первый временный отказ повторяется той же моделью через случайные 5–30 секунд.
 * После второго отказа вызывающий код может перейти к следующему более сильному режиму.
 */
export const GPT_MODEL_ADVANCEMENT_ORDER = Object.freeze([
    'default',
    'gpt54',
    'gpt55',
    'pro',
    'pro2',
    'pro3',
]);

export const OPENAI_RETRY_DELAY_MIN_MS = 5_000;
export const OPENAI_RETRY_DELAY_MAX_MS = 30_000;

function normalizeRandomUnit(value) {
    const number = Number(value);

    if (!Number.isFinite(number)) {
        return 0;
    }

    return Math.min(0.999999999, Math.max(0, number));
}

export function selectOpenAIRetryDelayMs(random = Math.random, {
    minimumMs = OPENAI_RETRY_DELAY_MIN_MS,
    maximumMs = OPENAI_RETRY_DELAY_MAX_MS,
} = {}) {
    const minimum = Math.max(0, Math.floor(Number(minimumMs) || 0));
    const maximum = Math.max(minimum, Math.floor(Number(maximumMs) || minimum));
    const unit = normalizeRandomUnit(random());

    return minimum + Math.floor(unit * (maximum - minimum + 1));
}

export function getNextAdvancedGptModes(currentMode) {
    const index = GPT_MODEL_ADVANCEMENT_ORDER.indexOf(String(currentMode ?? ''));

    if (index < 0) {
        return [...GPT_MODEL_ADVANCEMENT_ORDER];
    }

    return GPT_MODEL_ADVANCEMENT_ORDER.slice(index + 1);
}

export function isRetryableOpenAITextError(error) {
    const message = String(error?.message ?? error ?? '');
    const normalized = message.toLowerCase();

    if (!normalized) {
        return false;
    }

    if (
        /fetch failed|econnreset|etimedout|enotfound|eai_again|socket|network|aborterror|terminated|connection\s+(?:closed|reset|refused)/iu.test(
            message,
        )
    ) {
        return true;
    }

    if (
        /gpt(?:\s+vision)?\s+api 404/iu.test(message) &&
        /model|not\s+available|unavailable|not\s+found|does\s+not\s+exist|list\s+available\s+models/iu.test(message)
    ) {
        return true;
    }

    if (
        /gpt(?:\s+vision)?\s+api (?:408|409|425|429|500|502|503|504|520|521|522|523|524|525|526|527|529|530)\b/iu.test(
            message,
        )
    ) {
        return true;
    }

    if (
        /gpt vision api 400[^\n]*(?:image|multimodal|unsupported|not\s+support|invalid\s+content|content\s+type|image_url)/iu.test(message)
    ) {
        return true;
    }

    return /gpt stream error|upstream_stream_incomplete|currently\s+at\s+capacity|capacity|overload|upstream_error|temporar|busy|try\s+later|завершил\s+поток\s+без\s+текстового\s+ответа|вернул\s+пустой\s+ответ/iu.test(
        message,
    );
}

/**
 * Выполняет ограниченную схему восстановления без знания HTTP-клиента:
 * исходная попытка → задержанный повтор той же модели → одна следующая модель.
 */
export async function executeOpenAITextRecovery({
    initialModel,
    request,
    resolveFallback,
    sleep = (milliseconds) => new Promise((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
    }),
    random = Math.random,
    onEvent = null,
} = {}) {
    if (typeof request !== 'function') {
        throw new TypeError('request должен быть функцией.');
    }

    const model = String(initialModel ?? '').trim();

    try {
        return {
            value: await request(model),
            model,
            mode: '',
            recovery: 'none',
        };
    } catch (firstError) {
        if (!isRetryableOpenAITextError(firstError)) {
            throw firstError;
        }

        const delayMs = selectOpenAIRetryDelayMs(random);
        onEvent?.({
            type: 'retry',
            model,
            delayMs,
            error: firstError,
        });
        await sleep(delayMs);

        try {
            return {
                value: await request(model),
                model,
                mode: '',
                recovery: 'same-model-retry',
            };
        } catch (secondError) {
            if (!isRetryableOpenAITextError(secondError)) {
                throw secondError;
            }

            const fallback = typeof resolveFallback === 'function'
                ? await resolveFallback(model, secondError)
                : null;
            const fallbackModel = String(fallback?.model ?? '').trim();

            if (!fallbackModel || fallbackModel === model) {
                throw secondError;
            }

            onEvent?.({
                type: 'fallback',
                model,
                fallback,
                error: secondError,
            });

            return {
                value: await request(fallbackModel),
                model: fallbackModel,
                mode: String(fallback?.mode ?? ''),
                recovery: 'advanced-model-fallback',
            };
        }
    }
}


/**
 * Последовательно перебирает цепочку моделей. Каждая модель получает две
 * попытки: исходную и задержанный повтор через 5–30 секунд. После второго
 * временного отказа управление переходит к следующей модели цепочки.
 */
export async function executeOpenAIModelChainRecovery({
    candidates,
    request,
    sleep = (milliseconds) => new Promise((resolvePromise) => {
        setTimeout(resolvePromise, milliseconds);
    }),
    random = Math.random,
    onEvent = null,
} = {}) {
    if (typeof request !== 'function') {
        throw new TypeError('request должен быть функцией.');
    }

    const normalizedCandidates = (Array.isArray(candidates) ? candidates : [])
        .map((candidate) => ({
            mode: String(candidate?.mode ?? ''),
            model: String(candidate?.model ?? '').trim(),
            source: String(candidate?.source ?? ''),
        }))
        .filter((candidate, index, values) => (
            candidate.model &&
            values.findIndex((item) => item.model === candidate.model) === index
        ));

    if (!normalizedCandidates.length) {
        throw new Error('Не задана ни одна модель для GPT-запроса.');
    }

    let lastError = null;

    for (let index = 0; index < normalizedCandidates.length; index += 1) {
        const candidate = normalizedCandidates[index];

        try {
            return {
                value: await request(candidate.model, candidate),
                model: candidate.model,
                mode: candidate.mode,
                recovery: index === 0 ? 'none' : 'model-chain-fallback',
            };
        } catch (firstError) {
            lastError = firstError;

            if (!isRetryableOpenAITextError(firstError)) {
                throw firstError;
            }

            const delayMs = selectOpenAIRetryDelayMs(random);
            onEvent?.({
                type: 'retry',
                candidate,
                model: candidate.model,
                mode: candidate.mode,
                attempt: 2,
                delayMs,
                error: firstError,
            });
            await sleep(delayMs);

            try {
                return {
                    value: await request(candidate.model, candidate),
                    model: candidate.model,
                    mode: candidate.mode,
                    recovery: index === 0
                        ? 'same-model-retry'
                        : 'model-chain-fallback-retry',
                };
            } catch (secondError) {
                lastError = secondError;

                if (!isRetryableOpenAITextError(secondError)) {
                    throw secondError;
                }

                const nextCandidate = normalizedCandidates[index + 1] ?? null;

                if (nextCandidate) {
                    onEvent?.({
                        type: 'fallback',
                        candidate,
                        nextCandidate,
                        model: candidate.model,
                        mode: candidate.mode,
                        error: secondError,
                    });
                }
            }
        }
    }

    throw lastError ?? new Error('Все модели цепочки завершились с ошибкой.');
}
