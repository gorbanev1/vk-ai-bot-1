import {
    executeRuntimeModelFailover,
    isTechnicalModelFailure,
} from './modelProviderFailover.js';

function clean(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function normalizeBaseUrl(value, fallback) {
    return clean(value || fallback).replace(/\/+$/u, '');
}

const MAX_IMAGE_BYTES = 24 * 1024 * 1024;

export const NVIDIA_VISUAL_MODELS = Object.freeze([
    {
        id: 'black-forest-labs/flux.2-klein-4b',
        aliases: ['flux.2-klein-4b', 'flux2-klein', 'klein', 'последняя', 'новая'],
        label: 'FLUX.2 Klein 4B',
        description: 'Самая новая hosted FLUX в текущем NVIDIA Visual каталоге; умеет генерацию и отдельный режим редактирования. Первый приоритет.',
        endpointPath: '/black-forest-labs/flux.2-klein-4b',
        buildPayload(prompt, options) {
            return {
                mode: 'Image Generation',
                prompt,
                width: options.width,
                height: options.height,
                seed: options.seed,
                steps: 4,
            };
        },
    },
    {
        id: 'black-forest-labs/flux.1-dev',
        aliases: ['flux.1-dev', 'flux-dev', 'dev', 'качество', 'quality'],
        label: 'FLUX.1 Dev',
        description: 'Качественная text-to-image модель; второй приоритет после FLUX.2 Klein.',
        endpointPath: '/black-forest-labs/flux.1-dev',
        buildPayload(prompt, options) {
            return {
                prompt,
                width: options.width,
                height: options.height,
                cfg_scale: 5,
                mode: 'base',
                samples: 1,
                seed: options.seed,
                steps: 28,
            };
        },
    },
    {
        id: 'stabilityai/stable-diffusion-3-medium',
        aliases: ['stable-diffusion-3-medium', 'sd3-medium', 'sd3'],
        label: 'Stable Diffusion 3 Medium',
        description: 'Качественная text-to-image модель третьего приоритета.',
        endpointPath: '/stabilityai/stable-diffusion-3-medium',
        buildPayload(prompt, options) {
            return {
                aspect_ratio: '1:1',
                cfg_scale: 5,
                mode: 'text-to-image',
                model: 'sd3',
                output_format: 'jpeg',
                prompt,
                seed: options.seed,
                steps: 28,
            };
        },
    },
    {
        id: 'black-forest-labs/flux.1-schnell',
        aliases: ['flux.1-schnell', 'flux-schnell', 'schnell', 'быстрый'],
        label: 'FLUX.1 Schnell',
        description: 'Быстрая text-to-image генерация; резервный вариант.',
        endpointPath: '/black-forest-labs/flux.1-schnell',
        buildPayload(prompt, options) {
            return {
                prompt,
                width: options.width,
                height: options.height,
                seed: options.seed,
                steps: 4,
            };
        },
    },
    {
        id: 'stabilityai/stable-diffusion-xl',
        aliases: ['stable-diffusion-xl', 'sdxl'],
        label: 'Stable Diffusion XL',
        description: 'Классическая text-to-image модель; последний резерв.',
        endpointPath: '/stabilityai/stable-diffusion-xl',
        buildPayload(prompt, options) {
            return {
                height: options.height,
                width: options.width,
                text_prompts: [{ text: prompt, weight: 1 }],
                cfg_scale: 5,
                clip_guidance_preset: 'NONE',
                sampler: 'K_DPM_2_ANCESTRAL',
                samples: 1,
                seed: options.seed,
                steps: 25,
                style_preset: 'none',
            };
        },
    },
]);

function collectNvidiaVisualKeys(env = process.env) {
    const rows = [];
    const seen = new Set();
    const push = (name) => {
        const secret = clean(env?.[name]);
        if (!secret || seen.has(secret)) return;
        seen.add(secret);
        rows.push({ name, secret });
    };
    push('NVIDIA_API_KEY');
    for (let index = 1; index <= 20; index += 1) push(`NVIDIA_API_KEY_${index}`);
    return rows;
}

export function getNvidiaVisualConfig(env = process.env) {
    const apiKeys = collectNvidiaVisualKeys(env);
    return {
        apiKey: apiKeys[0]?.secret || '',
        apiKeys,
        baseUrl: normalizeBaseUrl(
            env.NVIDIA_IMAGE_BASE_URL,
            'https://ai.api.nvidia.com/v1/genai',
        ),
        defaultModel: clean(env.NVIDIA_IMAGE_MODEL) || 'auto',
        attemptTimeoutMs: Number.isFinite(Number(env.NVIDIA_IMAGE_ATTEMPT_TIMEOUT_MS))
            ? Math.max(30_000, Number(env.NVIDIA_IMAGE_ATTEMPT_TIMEOUT_MS))
            : 360_000,
        totalTimeoutMs: Number.isFinite(Number(env.NVIDIA_IMAGE_TOTAL_TIMEOUT_MS || env.NVIDIA_IMAGE_TIMEOUT_MS))
            ? Math.max(60_000, Number(env.NVIDIA_IMAGE_TOTAL_TIMEOUT_MS || env.NVIDIA_IMAGE_TIMEOUT_MS))
            : 1_200_000,
    };
}

export function formatNvidiaVisualModels() {
    return [
        'NVIDIA-графика: облачные Visual NIM endpoints (автоперебор — от самой продвинутой модели к более лёгким)',
        '',
        ...NVIDIA_VISUAL_MODELS.flatMap((model, index) => [
            `#${index + 1} ${model.id}`,
            `  ${model.description}`,
        ]),
        '',
        'Команды:',
        '• Гигорейв nvidia нарисуй <описание> — сначала лучшая модель, затем автоперебор по нисходящей.',
        '• Гигорейв nvidia нарисуй через <model|#N> <описание> — конкретная модель.',
        '• Гигорейв nvidia графика проверить — создать тестовую картинку.',
        '• Гигорейв nvidia графика модели — этот список.',
    ].join('\n');
}

function resolveModelBySelector(selector) {
    const requested = clean(selector);

    if (!requested || /^(?:авто|auto)$/iu.test(requested)) {
        return null;
    }

    const numberMatch = requested.match(/^#?(\d+)$/u);
    if (numberMatch) {
        const index = Number(numberMatch[1]);
        if (!Number.isSafeInteger(index) || index < 1 || index > NVIDIA_VISUAL_MODELS.length) {
            throw new Error(`Номер NVIDIA image-модели ${requested} вне диапазона #1–#${NVIDIA_VISUAL_MODELS.length}.`);
        }
        return NVIDIA_VISUAL_MODELS[index - 1];
    }

    const lower = requested.toLowerCase();
    const exact = NVIDIA_VISUAL_MODELS.find((model) =>
        model.id.toLowerCase() === lower ||
        model.aliases.some((alias) => alias.toLowerCase() === lower),
    );

    if (exact) {
        return exact;
    }

    const matches = NVIDIA_VISUAL_MODELS.filter((model) =>
        model.id.toLowerCase().includes(lower) ||
        model.aliases.some((alias) => alias.toLowerCase().includes(lower)),
    );

    if (matches.length === 1) {
        return matches[0];
    }

    if (matches.length > 1) {
        throw new Error(
            `Селектор NVIDIA image-модели «${requested}» неоднозначен: ${matches.map((model) => model.id).join(', ')}.`,
        );
    }

    throw new Error(
        `NVIDIA image-модель «${requested}» неизвестна. Используй «Гигорейв nvidia графика модели».`,
    );
}

function classifyError(status, payload) {
    const message = clean(
        payload?.error?.message ||
        payload?.detail?.[0]?.msg ||
        payload?.detail ||
        payload?.message ||
        payload?.raw ||
        '',
    );

    if (status === 401 || status === 403) {
        return `ключ или доступ отклонён (${status})${message ? `: ${message}` : ''}`;
    }

    if (status === 429) {
        return `лимит или квота исчерпаны (429)${message ? `: ${message}` : ''}`;
    }

    if (status === 504) {
        return `шлюз NVIDIA не дождался генерации (504)${message ? `: ${message}` : ''}`;
    }

    return `HTTP ${status}${message ? `: ${message}` : ''}`;
}

function parseJsonBuffer(buffer) {
    const raw = buffer.toString('utf8');

    try {
        return raw ? JSON.parse(raw) : {};
    } catch {
        return { raw: raw.slice(0, 1000) };
    }
}

async function readResponseBuffer(response, onProgress) {
    if (!response.body || typeof response.body.getReader !== 'function') {
        const buffer = Buffer.from(await response.arrayBuffer());
        onProgress?.({ stage: 'response_chunk', bytes: buffer.length, totalBytes: buffer.length });
        return buffer;
    }

    const reader = response.body.getReader();
    const chunks = [];
    let totalBytes = 0;
    let chunkIndex = 0;

    while (true) {
        const { done, value } = await reader.read();
        if (done) {
            break;
        }

        const chunk = Buffer.from(value);
        chunks.push(chunk);
        totalBytes += chunk.length;
        chunkIndex += 1;
        onProgress?.({ stage: 'response_chunk', bytes: chunk.length, totalBytes, chunkIndex });
    }

    return Buffer.concat(chunks, totalBytes);
}

function detectMimeType(buffer, hinted = '') {
    const hint = clean(hinted).toLowerCase();
    if (/^image\/(?:png|jpeg|jpg|webp)$/u.test(hint)) {
        return hint === 'image/jpg' ? 'image/jpeg' : hint;
    }

    if (buffer.length >= 8 && buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))) {
        return 'image/png';
    }

    if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) {
        return 'image/jpeg';
    }

    if (buffer.length >= 12 && buffer.subarray(0, 4).toString('ascii') === 'RIFF' && buffer.subarray(8, 12).toString('ascii') === 'WEBP') {
        return 'image/webp';
    }

    return 'image/jpeg';
}

function decodeBase64Image(value, hintedMime = '') {
    const raw = clean(value).replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, '');

    if (!raw) {
        throw new Error('NVIDIA Visual API вернул пустое base64-изображение.');
    }

    const buffer = Buffer.from(raw, 'base64');

    if (!buffer.length) {
        throw new Error('NVIDIA Visual API вернул некорректное base64-изображение.');
    }

    if (buffer.length > MAX_IMAGE_BYTES) {
        throw new Error(`NVIDIA Visual API вернул слишком большой файл: ${buffer.length} байт.`);
    }

    return {
        buffer,
        mimeType: detectMimeType(buffer, hintedMime),
    };
}

async function extractImage(payload) {
    const artifact = Array.isArray(payload?.artifacts)
        ? payload.artifacts[0]
        : null;
    const openAIData = Array.isArray(payload?.data)
        ? payload.data[0]
        : null;
    const base64 =
        artifact?.base64 ||
        artifact?.b64_json ||
        openAIData?.b64_json ||
        openAIData?.base64 ||
        payload?.image ||
        payload?.base64;

    if (base64) {
        return {
            ...decodeBase64Image(
                base64,
                artifact?.mime_type || openAIData?.mime_type || payload?.mime_type,
            ),
            finishReason: clean(
                artifact?.finishReason ||
                artifact?.finish_reason ||
                payload?.finish_reason,
            ),
        };
    }

    const url = clean(openAIData?.url || artifact?.url || payload?.url);
    if (url) {
        const response = await fetch(url, {
            signal: AbortSignal.timeout(45_000),
        });

        if (!response.ok) {
            throw new Error(`Не удалось скачать изображение NVIDIA: HTTP ${response.status}.`);
        }

        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length || buffer.length > MAX_IMAGE_BYTES) {
            throw new Error(`Некорректный размер изображения NVIDIA: ${buffer.length} байт.`);
        }

        return {
            buffer,
            mimeType: detectMimeType(buffer, response.headers.get('content-type')),
            finishReason: clean(payload?.finish_reason),
        };
    }

    throw new Error('NVIDIA Visual API не вернул изображение в artifacts, data или url.');
}

function isAvailabilityError(error) {
    const status = Number(error?.status);
    const name = String(error?.name || '');
    const message = String(error?.message || '');
    return status === 404 ||
        status === 405 ||
        status === 408 ||
        status === 422 ||
        (status >= 500 && status <= 599) ||
        name === 'TimeoutError' ||
        /timeout|aborted due to timeout|gateway timeout/iu.test(message);
}

async function generateWithModel(config, model, prompt, options) {
    if (!config.apiKey) {
        throw new Error('NVIDIA Visual API: NVIDIA_API_KEY не указан в .env.');
    }

    const endpoint = `${config.baseUrl}${model.endpointPath}`;
    const startedAt = Date.now();
    const timeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Math.max(1_000, Number(options.timeoutMs))
        : Number(config.attemptTimeoutMs) || 360_000;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(new Error('NVIDIA Visual request timeout')), timeoutMs);
    const heartbeat = setInterval(() => {
        options.onProgress?.({
            stage: 'heartbeat',
            model: model.id,
            endpoint,
            elapsedMs: Date.now() - startedAt,
        });
    }, 10_000);

    options.onProgress?.({
        stage: 'request_started',
        model: model.id,
        endpoint,
        timeoutMs,
        elapsedMs: 0,
    });

    try {
        const response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${config.apiKey}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(model.buildPayload(prompt, options)),
            signal: controller.signal,
        });

        options.onProgress?.({
            stage: 'response_headers',
            model: model.id,
            endpoint,
            status: response.status,
            contentType: response.headers.get('content-type') || '',
            contentLength: response.headers.get('content-length') || '',
            elapsedMs: Date.now() - startedAt,
        });

        const responseBuffer = await readResponseBuffer(response, (event) => {
            options.onProgress?.({
                ...event,
                model: model.id,
                endpoint,
                elapsedMs: Date.now() - startedAt,
            });
        });
        const payload = parseJsonBuffer(responseBuffer);

        if (!response.ok) {
            const error = new Error(classifyError(response.status, payload));
            error.status = response.status;
            error.model = model.id;
            error.endpoint = endpoint;
            error.payload = payload;
            throw error;
        }

        const image = await extractImage(payload);
        options.onProgress?.({
            stage: 'response_complete',
            model: model.id,
            endpoint,
            status: response.status,
            responseBytes: responseBuffer.length,
            imageBytes: image.buffer.length,
            elapsedMs: Date.now() - startedAt,
        });

        return {
            ...image,
            model: model.id,
            label: model.label,
            endpoint,
            status: response.status,
            elapsedMs: Date.now() - startedAt,
            seed: options.seed,
        };
    } catch (error) {
        if (controller.signal.aborted) {
            const timeoutError = new Error(`NVIDIA Visual timeout after ${timeoutMs} ms`);
            timeoutError.name = 'TimeoutError';
            timeoutError.code = 'NVIDIA_IMAGE_TIMEOUT';
            timeoutError.model = model.id;
            timeoutError.endpoint = endpoint;
            throw timeoutError;
        }
        throw error;
    } finally {
        clearTimeout(timeout);
        clearInterval(heartbeat);
    }
}

async function generateNvidiaVisualImageWithKey(config, prompt, options = {}) {
    const cleanPrompt = clean(prompt);
    if (!cleanPrompt) {
        throw new Error('После команды «nvidia нарисуй» нужно описание изображения.');
    }

    const width = Number.isSafeInteger(options.width) ? options.width : 1024;
    const height = Number.isSafeInteger(options.height) ? options.height : 1024;
    const seed = Number.isSafeInteger(options.seed) && options.seed >= 0
        ? options.seed
        : 0;
    const selected = resolveModelBySelector(options.model || config.defaultModel);
    const candidates = selected
        ? [selected]
        : NVIDIA_VISUAL_MODELS;
    const attempts = [];
    const totalStartedAt = Date.now();
    const totalTimeoutMs = Number.isFinite(Number(options.totalTimeoutMs))
        ? Math.max(1_000, Number(options.totalTimeoutMs))
        : Number(config.totalTimeoutMs) || 1_200_000;
    const configuredAttemptTimeoutMs = Number.isFinite(Number(options.timeoutMs))
        ? Math.max(1_000, Number(options.timeoutMs))
        : Number(config.attemptTimeoutMs) || 360_000;

    for (let index = 0; index < candidates.length; index += 1) {
        const model = candidates[index];
        const elapsedBeforeAttempt = Date.now() - totalStartedAt;
        const remainingMs = totalTimeoutMs - elapsedBeforeAttempt;

        if (remainingMs <= 0) {
            const totalError = new Error(`NVIDIA Visual: общий лимит ожидания ${totalTimeoutMs} мс исчерпан.`);
            totalError.name = 'TimeoutError';
            totalError.code = 'NVIDIA_IMAGE_TOTAL_TIMEOUT';
            totalError.attempts = attempts;
            throw totalError;
        }

        const attemptTimeoutMs = Math.max(1_000, Math.min(configuredAttemptTimeoutMs, remainingMs));

        try {
            const result = await generateWithModel(
                config,
                model,
                cleanPrompt,
                { width, height, seed, timeoutMs: attemptTimeoutMs, onProgress: options.onProgress },
            );

            return {
                ...result,
                attempts,
                totalElapsedMs: Date.now() - totalStartedAt,
            };
        } catch (error) {
            const reason = clean(error?.message || error).slice(0, 300);
            const status = Number(error?.status) || null;
            options.onProgress?.({
                stage: 'model_failed',
                model: model.id,
                status,
                reason,
                elapsedMs: Date.now() - totalStartedAt,
            });
            attempts.push({
                model: model.id,
                status,
                reason,
            });

            if (selected || !isAvailabilityError(error)) {
                error.attempts = attempts;
                throw error;
            }

            const nextModel = candidates[index + 1];
            if (nextModel) {
                options.onProgress?.({
                    stage: 'model_fallback',
                    model: model.id,
                    nextModel: nextModel.id,
                    status,
                    reason,
                    remainingMs: Math.max(0, totalTimeoutMs - (Date.now() - totalStartedAt)),
                });
            }
        }
    }

    const error = new Error(
        `Ни один NVIDIA Visual endpoint не создал изображение за ${attempts.length} попыток.`,
    );
    error.status = attempts.at(-1)?.status || null;
    error.attempts = attempts;
    throw error;
}

export async function generateNvidiaVisualImage(config, prompt, options = {}) {
    const cleanPrompt = clean(prompt);
    if (!cleanPrompt) {
        throw new Error('После команды «nvidia нарисуй» нужно описание изображения.');
    }

    // Validate the selector before entering an endless provider retry loop.
    resolveModelBySelector(options.model || config.defaultModel);

    const keyRows = Array.isArray(config?.apiKeys) && config.apiKeys.length
        ? config.apiKeys
        : clean(config?.apiKey)
            ? [{ name: 'NVIDIA_API_KEY', secret: clean(config.apiKey) }]
            : [];

    if (!keyRows.length) {
        throw new Error('NVIDIA Visual API: NVIDIA_API_KEY не указан в .env.');
    }

    const candidates = keyRows.map((row, index) => ({
        provider: 'nvidia-visual',
        name: clean(row?.name) || `NVIDIA_API_KEY_${index + 1}`,
        secret: clean(row?.secret),
        baseUrl: clean(config?.baseUrl),
    })).filter((row) => row.secret && row.baseUrl);

    const result = await executeRuntimeModelFailover({
        candidates,
        shouldRetry(error) {
            return isTechnicalModelFailure(error) || isAvailabilityError(error);
        },
        request: (credential) => generateNvidiaVisualImageWithKey({
            ...config,
            apiKey: credential.secret,
        }, cleanPrompt, options),
        onEvent(event) {
            if (event.type === 'rotate') {
                console.warn(
                    '[NVIDIA IMAGE KEY ROTATE]',
                    `key=${event.credential?.name || 'unknown'}`,
                    'reason=three-failures',
                );
            } else if (event.type === 'success' && (event.attempt > 1 || event.round > 1)) {
                console.log(
                    '[NVIDIA IMAGE FAILOVER RECOVERED]',
                    `key=${event.credential?.name || 'unknown'}`,
                    `attempt=${event.attempt}`,
                    `round=${event.round}`,
                );
            }
        },
    });

    return result.value;
}
