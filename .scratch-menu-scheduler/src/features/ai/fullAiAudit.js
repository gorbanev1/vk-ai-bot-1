import { appendFile, mkdir, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    collectConfiguredAiCredentials,
    collectAuditableAiCredentials,
    runConfiguredAiKeyAudit,
} from './providerKeyAudit.js';
import { probeProviderVisualModel, runAllProviderVisualMatrixAudit } from './allProviderVisualMatrixAudit.js';
import { NVIDIA_VISUAL_MODELS } from './nvidiaVisualGeneration.js';

const clean = (value) => String(value ?? '').trim();
const DEFAULT_TEXT_PROMPT = 'Ответь ровно одной строкой: GIGORAVE_AUDIT_OK';
const DEFAULT_IMAGE_PROMPT = 'A clean cinematic night city scene with one glowing geometric sphere, realistic lighting, no text, no logos';
const DEFAULT_TIMEOUT_MS = 120_000;
const DEFAULT_IMAGE_STREAM_TIMEOUT_MS = 360_000;
const REASONING_LEVELS = Object.freeze(['default', 'none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']);

const DEFAULT_MODEL_CONCURRENCY = 6;
const DEFAULT_PER_KEY_MODEL_CONCURRENCY = 1;
const DEFAULT_REASONING_CONCURRENCY = 2;
const DEFAULT_IMAGE_CONCURRENCY = 4;

function boundedInt(value, fallback, min = 1, max = 64) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function auditConcurrencyConfig(env = process.env) {
    return {
        keyConcurrency: boundedInt(env.AI_AUDIT_KEY_CONCURRENCY, 8, 1, 32),
        modelConcurrency: boundedInt(env.AI_AUDIT_MODEL_CONCURRENCY, DEFAULT_MODEL_CONCURRENCY, 1, 24),
        perKeyModelConcurrency: boundedInt(env.AI_AUDIT_PER_KEY_MODEL_CONCURRENCY, DEFAULT_PER_KEY_MODEL_CONCURRENCY, 1, 4),
        reasoningConcurrency: boundedInt(env.AI_AUDIT_REASONING_CONCURRENCY, DEFAULT_REASONING_CONCURRENCY, 1, 6),
        imageConcurrency: boundedInt(env.AI_AUDIT_IMAGE_CONCURRENCY, DEFAULT_IMAGE_CONCURRENCY, 1, 12),
        perKeyImageConcurrency: boundedInt(env.AI_AUDIT_PER_KEY_IMAGE_CONCURRENCY, 1, 1, 3),
    };
}

async function runConcurrentByKey(items, worker, {
    globalLimit = 1,
    perKeyLimit = 1,
    keyFn = (item) => String(item?.key ?? ''),
    onState = null,
} = {}) {
    const results = new Array(items.length);
    const pending = items.map((_, index) => index);
    const activeByKey = new Map();
    let active = 0;
    let completed = 0;

    return await new Promise((resolveRun, rejectRun) => {
        let rejected = false;

        const schedule = () => {
            if (rejected) return;
            if (completed >= items.length) {
                resolveRun(results);
                return;
            }

            let launched = false;
            while (active < globalLimit && pending.length) {
                let pendingPosition = -1;
                for (let i = 0; i < pending.length; i += 1) {
                    const index = pending[i];
                    const key = keyFn(items[index], index);
                    if ((activeByKey.get(key) || 0) < perKeyLimit) {
                        pendingPosition = i;
                        break;
                    }
                }
                if (pendingPosition < 0) break;

                const index = pending.splice(pendingPosition, 1)[0];
                const item = items[index];
                const key = keyFn(item, index);
                active += 1;
                activeByKey.set(key, (activeByKey.get(key) || 0) + 1);
                launched = true;
                void Promise.resolve(onState?.({ state: 'start', index, active, completed, total: items.length, key }));

                Promise.resolve()
                    .then(() => worker(item, index))
                    .then((result) => {
                        results[index] = result;
                    })
                    .catch((error) => {
                        rejected = true;
                        rejectRun(error);
                    })
                    .finally(() => {
                        active -= 1;
                        activeByKey.set(key, Math.max(0, (activeByKey.get(key) || 1) - 1));
                        completed += 1;
                        void Promise.resolve(onState?.({ state: 'complete', index, active, completed, total: items.length, key }));
                        schedule();
                    });
            }

            if (!launched && active === 0 && pending.length && !rejected) {
                const index = pending.shift();
                pending.unshift(index);
                rejectRun(new Error('AI audit scheduler deadlock'));
            }
        };

        if (!items.length) resolveRun([]);
        else schedule();
    });
}

async function runConcurrent(items, worker, limit = 1) {
    const results = new Array(items.length);
    let cursor = 0;
    async function workerLoop() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), items.length) }, () => workerLoop()));
    return results;
}

function stampNow(date = new Date()) {
    return date.toISOString().replace(/[:.]/gu, '-');
}

function safeError(payload, raw = '') {
    return clean(
        payload?.error?.message ||
        payload?.message ||
        payload?.detail ||
        raw,
    ).replace(/\s+/gu, ' ').slice(0, 1200);
}

function responseContentType(response) {
    return clean(response?.headers?.get?.('content-type')).toLowerCase();
}

function isStreamingContentType(value) {
    const contentType = clean(value).toLowerCase();
    return contentType.includes('text/event-stream') ||
        contentType.includes('application/x-ndjson') ||
        contentType.includes('application/ndjson') ||
        contentType.includes('application/json-seq');
}

async function readResponseText(response) {
    try {
        return await response.text();
    } catch (error) {
        const wrapped = new Error(clean(error?.message || error) || 'response body read failed');
        wrapped.cause = error;
        throw wrapped;
    }
}

async function requestJson(fetchImpl, url, options, timeoutMs = DEFAULT_TIMEOUT_MS) {
    const startedAt = Date.now();
    let response;
    try {
        response = await fetchImpl(url, {
            ...options,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        return {
            ok: false,
            status: 0,
            elapsedMs: Date.now() - startedAt,
            firstByteMs: 0,
            payload: null,
            raw: '',
            error: clean(error?.message || error).slice(0, 1200),
            observedTransport: 'none',
        };
    }

    let raw = '';
    try {
        raw = await readResponseText(response);
    } catch (error) {
        return {
            ok: false,
            status: Number(response.status || 0),
            elapsedMs: Date.now() - startedAt,
            firstByteMs: 0,
            payload: null,
            raw: '',
            error: clean(error?.message || error).slice(0, 1200),
            observedTransport: isStreamingContentType(responseContentType(response)) ? 'stream' : 'non_stream',
        };
    }

    let payload = null;
    try {
        payload = raw ? JSON.parse(raw) : {};
    } catch {
        payload = null;
    }

    return {
        ok: Boolean(response.ok),
        status: Number(response.status || 0),
        elapsedMs: Date.now() - startedAt,
        firstByteMs: 0,
        payload,
        raw,
        error: response.ok ? '' : safeError(payload, raw),
        observedTransport: isStreamingContentType(responseContentType(response)) ? 'stream' : 'non_stream',
    };
}

function textFromPart(part, depth = 0) {
    if (depth > 5 || part == null) return '';
    if (typeof part === 'string') return part;
    if (typeof part === 'number' || typeof part === 'boolean') return '';
    if (Array.isArray(part)) return part.map((item) => textFromPart(item, depth + 1)).filter(Boolean).join('');
    if (typeof part !== 'object') return '';
    for (const key of ['text', 'output_text', 'reasoning_content', 'reasoning', 'analysis', 'value']) {
        if (typeof part[key] === 'string' && clean(part[key])) return part[key];
    }
    for (const key of ['content', 'parts', 'summary', 'output', 'message', 'delta']) {
        const nested = textFromPart(part[key], depth + 1);
        if (nested) return nested;
    }
    return '';
}

function joinTextParts(parts) {
    return clean(textFromPart(parts));
}

function extractText(provider, payload) {
    if (provider === 'anthropic') {
        const text = joinTextParts(payload?.content || []);
        if (text) return text;
    }
    if (provider === 'gemini') {
        const text = joinTextParts(payload?.candidates?.[0]?.content?.parts || []);
        if (text) return text;
    }
    if (payload?.output_text) return clean(payload.output_text);
    if (Array.isArray(payload?.output)) {
        const chunks = [];
        for (const item of payload.output) {
            const content = joinTextParts(item?.content || []);
            if (content) chunks.push(content);
            if (item?.text) chunks.push(item.text);
            if (item?.output_text) chunks.push(item.output_text);
            if (item?.reasoning_content) chunks.push(item.reasoning_content);
            if (item?.analysis) chunks.push(item.analysis);
            const summary = joinTextParts(item?.summary || []);
            if (summary) chunks.push(summary);
        }
        const text = clean(chunks.join(''));
        if (text) return text;
    }
    const message = payload?.choices?.[0]?.message || {};
    const content = message?.content;
    if (typeof content === 'string' && clean(content)) return clean(content);
    if (Array.isArray(content) || (content && typeof content === 'object')) {
        const text = joinTextParts(content);
        if (text) return text;
    }
    for (const candidate of [message?.reasoning_content, message?.analysis, payload?.reasoning_content, payload?.analysis, payload?.text]) {
        if (clean(candidate)) return clean(candidate);
    }
    return '';
}

function extractStreamText(provider, payload) {
    if (!payload || typeof payload !== 'object') return '';

    if (provider === 'anthropic') {
        const direct = payload?.delta?.text || payload?.content_block?.text || '';
        if (direct) return String(direct);
    }
    if (provider === 'gemini') {
        return (payload?.candidates?.[0]?.content?.parts || [])
            .map((part) => part?.text || '')
            .join('');
    }

    const completionDelta = payload?.choices?.[0]?.text;
    if (typeof completionDelta === 'string') return completionDelta;

    const deltaObject = payload?.choices?.[0]?.delta || {};
    const chatDelta = deltaObject?.content;
    if (typeof chatDelta === 'string') return chatDelta;
    if (Array.isArray(chatDelta)) return chatDelta.map((part) => part?.text || part?.output_text || '').join('');
    if (typeof deltaObject?.reasoning_content === 'string') return deltaObject.reasoning_content;
    if (typeof deltaObject?.analysis === 'string') return deltaObject.analysis;
    if (typeof deltaObject?.reasoning === 'string') return deltaObject.reasoning;
    if (deltaObject?.content && typeof deltaObject.content === 'object') {
        const nested = joinTextParts(deltaObject.content);
        if (nested) return nested;
    }

    const responseDelta = payload?.delta;
    if (typeof responseDelta === 'string' && /output_text|text\.delta|response\.output_text/u.test(String(payload?.type || ''))) {
        return responseDelta;
    }
    if (typeof payload?.text === 'string' && /output_text|text\.delta/u.test(String(payload?.type || ''))) {
        return payload.text;
    }
    if (typeof payload?.output_text === 'string') return payload.output_text;
    return '';
}

function parseEventPayloads(buffer, mode = 'sse') {
    const items = [];
    const normalized = String(buffer ?? '').replace(/\r\n/gu, '\n');
    if (mode === 'ndjson') {
        for (const line of normalized.split('\n')) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try { items.push(JSON.parse(trimmed)); } catch { /* ignore protocol noise */ }
        }
        return items;
    }
    for (const block of normalized.split('\n\n')) {
        const dataLines = block.split('\n')
            .filter((line) => /^data:/u.test(line))
            .map((line) => line.replace(/^data:\s?/u, ''));
        if (!dataLines.length) continue;
        const data = dataLines.join('\n').trim();
        if (!data || data === '[DONE]') continue;
        try { items.push(JSON.parse(data)); } catch { /* ignore keepalives/non-json */ }
    }
    return items;
}

async function requestEventStream(fetchImpl, url, options, {
    timeoutMs = DEFAULT_TIMEOUT_MS,
    provider = '',
    extractChunkText = extractStreamText,
    onPayload = null,
} = {}) {
    const startedAt = Date.now();
    let response;
    try {
        response = await fetchImpl(url, {
            ...options,
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        return {
            ok: false,
            status: 0,
            elapsedMs: Date.now() - startedAt,
            firstByteMs: 0,
            text: '',
            chunks: 0,
            payloads: 0,
            error: clean(error?.message || error).slice(0, 1200),
            observedTransport: 'none',
        };
    }

    const contentType = responseContentType(response);
    const streaming = isStreamingContentType(contentType);
    if (!response.ok) {
        let raw = '';
        try { raw = await readResponseText(response); } catch (error) { raw = clean(error?.message || error); }
        let payload = null;
        try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = null; }
        return {
            ok: false,
            status: Number(response.status || 0),
            elapsedMs: Date.now() - startedAt,
            firstByteMs: 0,
            text: '',
            chunks: 0,
            payloads: 0,
            error: safeError(payload, raw),
            observedTransport: streaming ? 'stream' : 'non_stream',
        };
    }

    if (!streaming) {
        const raw = await readResponseText(response);
        let payload = null;
        try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = null; }
        return {
            ok: false,
            status: Number(response.status || 0),
            elapsedMs: Date.now() - startedAt,
            firstByteMs: 0,
            text: payload ? extractText(provider, payload) : '',
            chunks: 1,
            payloads: payload ? 1 : 0,
            error: 'stream=true принят, но endpoint вернул обычный non-stream ответ.',
            observedTransport: 'non_stream',
        };
    }

    const reader = response.body?.getReader?.();
    if (!reader) {
        return {
            ok: false,
            status: Number(response.status || 0),
            elapsedMs: Date.now() - startedAt,
            firstByteMs: 0,
            text: '',
            chunks: 0,
            payloads: 0,
            error: 'stream response has no readable body',
            observedTransport: 'stream',
        };
    }

    const decoder = new TextDecoder();
    let pending = '';
    let text = '';
    let chunks = 0;
    let payloads = 0;
    let firstByteMs = 0;
    let streamError = '';
    let rawSample = '';
    const ndjson = /ndjson|json-seq/u.test(contentType);

    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            if (!firstByteMs) firstByteMs = Date.now() - startedAt;
            chunks += 1;
            const decoded = decoder.decode(value, { stream: true });
            if (rawSample.length < 8000) rawSample += decoded.slice(0, 8000 - rawSample.length);
            pending += decoded;
            const delimiter = ndjson ? '\n' : '\n\n';
            let pos;
            while ((pos = pending.indexOf(delimiter)) >= 0) {
                const block = pending.slice(0, pos);
                pending = pending.slice(pos + delimiter.length);
                const parsed = parseEventPayloads(block + (ndjson ? '\n' : '\n\n'), ndjson ? 'ndjson' : 'sse');
                for (const payload of parsed) {
                    payloads += 1;
                    if (payload?.error) {
                        streamError = safeError(payload, JSON.stringify(payload));
                    }
                    const delta = extractChunkText(provider, payload);
                    if (delta) text += delta;
                    onPayload?.(payload);
                }
            }
        }
        pending += decoder.decode();
        if (pending.trim()) {
            const parsed = parseEventPayloads(pending + (ndjson ? '\n' : '\n\n'), ndjson ? 'ndjson' : 'sse');
            for (const payload of parsed) {
                payloads += 1;
                if (payload?.error) streamError = safeError(payload, JSON.stringify(payload));
                const delta = extractChunkText(provider, payload);
                if (delta) text += delta;
                onPayload?.(payload);
            }
        }
    } catch (error) {
        return {
            ok: false,
            status: Number(response.status || 0),
            elapsedMs: Date.now() - startedAt,
            firstByteMs,
            text: clean(text),
            chunks,
            payloads,
            error: clean(error?.message || error).slice(0, 1200),
            observedTransport: 'stream',
            rawSample: clean(rawSample).slice(0, 8000),
        };
    }

    const finalText = clean(text);
    return {
        ok: Boolean(!streamError && finalText),
        status: Number(response.status || 0),
        elapsedMs: Date.now() - startedAt,
        firstByteMs,
        text: finalText,
        chunks,
        payloads,
        error: streamError || (finalText ? '' : 'Поток завершился без текстового ответа.'),
        observedTransport: 'stream',
        rawSample: clean(rawSample).slice(0, 8000),
    };
}

function classifyFailure({ status = 0, error = '', provider = '', endpoint = '' } = {}) {
    const message = clean(error).toLowerCase();
    if (!status) return { kind: 'network', retryEligible: true, definitiveDead: false, retryStrategy: 'Второй круг с backoff; проверить DNS/TLS/прокси и альтернативный endpoint.' };
    if (status === 401 || /incorrect api key|api key is invalid|invalid api key|api key not valid/u.test(message)) {
        return { kind: 'invalid_key', retryEligible: false, definitiveDead: true, retryStrategy: 'Ключ окончательно исключить из runtime; повтор тем же ключом бессмысленен.' };
    }
    if (status === 403 && provider === 'gemini' && /has not been used|is disabled|referer.*blocked/u.test(message)) {
        return { kind: 'key_restricted', retryEligible: true, definitiveDead: false, retryStrategy: 'Повторить проверку ключа во втором круге; не обходить ограничения referer/API project.' };
    }
    if (status === 403) return { kind: 'access_denied', retryEligible: true, definitiveDead: false, retryStrategy: 'Один второй круг через альтернативный endpoint/повтор; права не обходить. Если 403 сохранится — исключить из runtime, но не считать ключ/модель мёртвыми.' };
    if (status === 429) return { kind: 'quota', retryEligible: true, definitiveDead: false, retryStrategy: 'Второй круг после cooldown; quota/rate-limit не считать смертью модели.' };
    if (status >= 500) return { kind: 'server', retryEligible: true, definitiveDead: false, retryStrategy: 'Второй круг с backoff и альтернативным endpoint; 5xx считать временной ошибкой.' };
    if (/requires terms acceptance|terms acceptance/u.test(message)) {
        return { kind: 'terms_blocked', retryEligible: false, definitiveDead: false, retryStrategy: 'Модель не мёртвая: требуется принятие условий аккаунтом. В runtime не использовать до принятия.' };
    }
    if (/deprecated and no longer supported|model is deprecated/u.test(message)) {
        return { kind: 'deprecated', retryEligible: false, definitiveDead: true, retryStrategy: 'Модель устарела/снята у этого provider route; удалить из runtime.' };
    }
    if (/stream=true.*non-stream|stream.*not supported|does not support streaming|accept type.*text\/event-stream.*not supported/u.test(message)) {
        return { kind: 'stream_unsupported', retryEligible: false, definitiveDead: false, retryStrategy: 'Модель оставить в non-stream, если обычный транспорт прошёл.' };
    }
    if (status === 404 || /not found|does not exist|unknown model|model.*(?:unavailable|unsupported)|function .*not found/u.test(message)) {
        return { kind: 'model_or_endpoint', retryEligible: true, definitiveDead: false, retryStrategy: 'Второй круг через альтернативные официальные endpoints/provider route; только после этого считать комбинацию недоступной.' };
    }
    if (status === 400 || status === 405 || status === 415 || status === 422) {
        return { kind: 'payload_or_endpoint', retryEligible: true, definitiveDead: false, retryStrategy: 'Второй круг с provider/model-specific payload и альтернативным endpoint.' };
    }
    return { kind: 'other', retryEligible: true, definitiveDead: false, retryStrategy: 'Повторить вторым кругом после анализа полного ответа провайдера.' };
}

function openAiLikeHeaders(credential, stream) {
    return {
        Authorization: `Bearer ${credential.secret}`,
        'Content-Type': 'application/json',
        Accept: stream ? 'text/event-stream' : 'application/json',
    };
}

function isExpectedAuditText(value) {
    return clean(value).toUpperCase().includes('GIGORAVE_AUDIT_OK');
}

function isMeaningfulAuditText(value) {
    return clean(value).length > 0;
}

function auditTextAssessment(value) {
    const text = clean(value);
    return {
        text,
        transportOk: isMeaningfulAuditText(text),
        instructionCompliant: isExpectedAuditText(text),
    };
}

function reasoningLevelsForModel(provider, model) {
    const id = clean(model).toLowerCase();
    if (provider === 'groq' || provider === 'huggingface') {
        if (/openai\/gpt-oss-(?:20b|120b)/u.test(id)) return ['low', 'medium', 'high'];
        if (/qwen\/qwen3(?:\.|[-_])/u.test(id) || /qwen3\.6/u.test(id)) return ['none', 'default'];
        return [];
    }
    if (provider === 'nvidia') {
        if (/openai\/gpt-oss-(?:20b|120b)/u.test(id)) return ['low', 'medium', 'high'];
        if (/qwen.*qwen3/u.test(id)) return ['none', 'default'];
        return [];
    }
    if (provider === 'openai' || provider === 'openai-compatible' || provider === 'xai') {
        if (/^gpt-(?:[5-9]|\d{2,})(?:[.\-_]|$)/u.test(id)) return ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'];
        if (/openai\/gpt-oss-(?:20b|120b)|gpt-oss-(?:20b|120b)/u.test(id)) return ['low', 'medium', 'high'];
        if (/^(?:o[134]|gpt-5)/u.test(id)) return ['low', 'medium', 'high'];
        return [];
    }
    if (provider === 'anthropic') {
        if (/claude-(?:opus|sonnet)-4/u.test(id)) return ['low', 'medium', 'high'];
        return [];
    }
    if (provider === 'gemini') {
        if (/gemini-3/u.test(id)) return ['low', 'medium', 'high'];
        return [];
    }
    return [];
}

function openAiLikeInferenceBaseUrl(credential) {
    return clean(credential?.inferenceBaseUrl) || clean(credential?.baseUrl);
}

function reasoningForEndpoint(endpoint, level) {
    if (!level || level === 'default') return {};
    if (endpoint === 'responses') return { reasoning: { effort: level } };
    return { reasoning_effort: level };
}

function chatTokenLimit(credential, value = 64) {
    return ['openai', 'xai'].includes(credential?.provider)
        ? { max_completion_tokens: value }
        : { max_tokens: value };
}

async function probeOpenAiLikeTransport({ fetchImpl, credential, model, prompt, timeoutMs, transport, reasoningLevel = '' }) {
    const baseUrl = openAiLikeInferenceBaseUrl(credential).replace(/\/$/u, '');
    const stream = transport === 'stream';
    const attempts = [];
    const chatBody = {
        model,
        messages: [{ role: 'user', content: prompt }],
        stream,
        ...chatTokenLimit(credential, 64),
        ...reasoningForEndpoint('chat/completions', reasoningLevel),
    };
    const chat = stream
        ? await requestEventStream(fetchImpl, `${baseUrl}/chat/completions`, {
            method: 'POST', headers: openAiLikeHeaders(credential, true), body: JSON.stringify(chatBody),
        }, { timeoutMs, provider: credential.provider })
        : await requestJson(fetchImpl, `${baseUrl}/chat/completions`, {
            method: 'POST', headers: openAiLikeHeaders(credential, false), body: JSON.stringify(chatBody),
        }, timeoutMs);
    const chatText = stream ? clean(chat.text) : extractText(credential.provider, chat.payload);
    const chatAssessment = auditTextAssessment(chatText);
    const chatValid = Boolean(chat.ok && chatAssessment.transportOk);
    attempts.push({
        transport, endpoint: 'chat/completions', ok: chatValid,
        instructionCompliant: chatAssessment.instructionCompliant,
        status: chat.status, elapsedMs: chat.elapsedMs, firstByteMs: chat.firstByteMs || 0,
        observedTransport: chat.observedTransport,
        textSample: chatAssessment.text.slice(0, 600), rawSample: clean(chat.rawSample || chat.raw).slice(0, 4000),
        error: chatValid ? '' : clean(chat.error || (chat.ok ? 'HTTP успешен, но текст не извлечён из ответа.' : '')),
    });
    if (chatValid) {
        return { ...chat, ok: true, instructionCompliant: chatAssessment.instructionCompliant, endpoint: 'chat/completions', text: chatAssessment.text, attempts };
    }

    if (['openai', 'openai-compatible', 'groq', 'nvidia', 'huggingface'].includes(credential.provider)) {
        const fallbackReason = classifyFailure({ status: chat.status, error: chat.error, provider: credential.provider, endpoint: 'chat/completions' });
        if (fallbackReason.retryEligible && ['model_or_endpoint', 'payload_or_endpoint'].includes(fallbackReason.kind)) {
            const responsesBody = {
                model,
                input: prompt,
                stream,
                max_output_tokens: 64,
                ...reasoningForEndpoint('responses', reasoningLevel),
            };
            const responses = stream
                ? await requestEventStream(fetchImpl, `${baseUrl}/responses`, {
                    method: 'POST', headers: openAiLikeHeaders(credential, true), body: JSON.stringify(responsesBody),
                }, { timeoutMs, provider: credential.provider })
                : await requestJson(fetchImpl, `${baseUrl}/responses`, {
                    method: 'POST', headers: openAiLikeHeaders(credential, false), body: JSON.stringify(responsesBody),
                }, timeoutMs);
            const responseText = stream ? clean(responses.text) : extractText(credential.provider, responses.payload);
            const responseAssessment = auditTextAssessment(responseText);
            const responseValid = Boolean(responses.ok && responseAssessment.transportOk);
            attempts.push({
                transport, endpoint: 'responses', ok: responseValid,
                instructionCompliant: responseAssessment.instructionCompliant,
                status: responses.status, elapsedMs: responses.elapsedMs, firstByteMs: responses.firstByteMs || 0,
                observedTransport: responses.observedTransport,
                textSample: responseAssessment.text.slice(0, 600), rawSample: clean(responses.rawSample || responses.raw).slice(0, 4000),
                error: responseValid ? '' : clean(responses.error || (responses.ok ? 'HTTP успешен, но текст не извлечён из ответа.' : '')),
            });
            return { ...responses, ok: responseValid, instructionCompliant: responseAssessment.instructionCompliant, endpoint: 'responses', text: responseAssessment.text, attempts };
        }
    }

    return { ...chat, ok: false, instructionCompliant: chatAssessment.instructionCompliant, endpoint: 'chat/completions', text: chatAssessment.text, attempts };
}

function secondRoundEndpointOrder(credential, model) {
    const provider = clean(credential?.provider);
    const id = clean(model).toLowerCase();
    if (provider === 'nvidia') return ['responses', 'chat/completions', 'completions'];
    if (provider === 'groq' || provider === 'huggingface') return ['responses', 'chat/completions'];
    if (provider === 'openai' || provider === 'openai-compatible' || provider === 'xai') {
        return /(?:instruct|davinci|babbage)/u.test(id)
            ? ['responses', 'chat/completions', 'completions']
            : ['responses', 'chat/completions'];
    }
    return [];
}

async function probeOpenAiLikeSpecificEndpoint({ fetchImpl, credential, model, prompt, timeoutMs, transport, reasoningLevel = '', endpoint }) {
    const baseUrl = openAiLikeInferenceBaseUrl(credential).replace(/\/$/u, '');
    const stream = transport === 'stream';
    let body;
    if (endpoint === 'responses') {
        body = { model, input: prompt, stream, max_output_tokens: 64, ...reasoningForEndpoint(endpoint, reasoningLevel) };
    } else if (endpoint === 'completions') {
        body = { model, prompt, stream, max_tokens: 64 };
    } else {
        body = {
            model,
            messages: [{ role: 'user', content: prompt }],
            stream,
            ...chatTokenLimit(credential, 64),
            ...reasoningForEndpoint('chat/completions', reasoningLevel),
        };
    }
    const url = `${baseUrl}/${endpoint}`;
    const result = stream
        ? await requestEventStream(fetchImpl, url, {
            method: 'POST', headers: openAiLikeHeaders(credential, true), body: JSON.stringify(body),
        }, { timeoutMs, provider: credential.provider })
        : await requestJson(fetchImpl, url, {
            method: 'POST', headers: openAiLikeHeaders(credential, false), body: JSON.stringify(body),
        }, timeoutMs);
    const text = stream
        ? clean(result.text)
        : endpoint === 'completions'
            ? clean(result.payload?.choices?.[0]?.text)
            : extractText(credential.provider, result.payload);
    const assessment = auditTextAssessment(text);
    const valid = Boolean(result.ok && assessment.transportOk);
    return {
        ...result,
        ok: valid,
        instructionCompliant: assessment.instructionCompliant,
        endpoint,
        text: assessment.text,
        error: valid ? '' : clean(result.error || (result.ok ? 'HTTP успешен, но текст не извлечён из ответа.' : '')),
        attempts: [{
            transport, endpoint, ok: valid, instructionCompliant: assessment.instructionCompliant,
            status: Number(result.status || 0), elapsedMs: Number(result.elapsedMs || 0),
            firstByteMs: Number(result.firstByteMs || 0), observedTransport: clean(result.observedTransport),
            textSample: assessment.text.slice(0, 600), rawSample: clean(result.rawSample || result.raw).slice(0, 4000),
            error: valid ? '' : clean(result.error || (result.ok ? 'HTTP успешен, но текст не извлечён из ответа.' : '')),
        }],
    };
}

async function probeTextTransportSecondRound({ fetchImpl, credential, model, prompt, timeoutMs, transport, reasoningLevel = '' }) {
    if (['openai', 'openai-compatible', 'groq', 'nvidia', 'huggingface'].includes(credential.provider)) {
        const attempts = [];
        let last = null;
        for (const endpoint of secondRoundEndpointOrder(credential, model)) {
            const probe = await probeOpenAiLikeSpecificEndpoint({
                fetchImpl, credential, model, prompt, timeoutMs, transport, reasoningLevel, endpoint,
            });
            attempts.push(...(probe.attempts || []));
            last = probe;
            if (probe.ok) return { ...probe, attempts };
            const failure = classifyFailure({ status: probe.status, error: probe.error, provider: credential.provider, endpoint });
            if (failure.definitiveDead || failure.kind === 'invalid_key') break;
            if (failure.kind === 'quota') break;
        }
        return { ...(last || {}), ok: false, attempts, endpoint: clean(last?.endpoint) || 'second-round' };
    }
    return probeTextTransport({ fetchImpl, credential, model, prompt, timeoutMs, transport, reasoningLevel });
}

function shouldSecondRoundRetry(row) {
    if (!row || row.ok) return false;
    const c = classifyFailure(row);
    return Boolean(c.retryEligible && !c.definitiveDead);
}

function mergeTransportAfterRetry(original, retryProbe, transport) {
    const retry = transportRow(retryProbe, transport);
    return {
        ...(retry.ok ? retry : original),
        secondRound: retry,
        firstRound: original,
    };
}

async function runTextSecondRound({ textResults, credentialById, fetchImpl, timeoutMs, concurrency, onProgress, appendResult, writeStatus, outDir }) {
    const tasks = [];
    for (const row of textResults) {
        const credential = credentialById.get(`${row.provider}:${row.envName}`);
        if (!credential) continue;
        for (const transport of ['non_stream', 'stream']) {
            const attempt = row.transports?.[transport];
            if (attempt && shouldSecondRoundRetry({ ...attempt, provider: row.provider })) {
                tasks.push({ type: 'baseline', row, credential, transport, reasoningLevel: '' });
            }
        }
        for (const reasoning of row.reasoningResults || []) {
            if (reasoning.level === 'default') continue;
            for (const transport of ['non_stream', 'stream']) {
                const attempt = reasoning.transports?.[transport];
                if (attempt && shouldSecondRoundRetry({ ...attempt, provider: row.provider })) {
                    tasks.push({ type: 'reasoning', row, reasoning, credential, transport, reasoningLevel: reasoning.level });
                }
            }
        }
    }
    let completed = 0;
    const started = Date.now();
    const results = await runConcurrentByKey(tasks, async (task, index) => {
        await onProgress?.({
            stage: 'second-round-start', index: index + 1, total: tasks.length,
            provider: task.row.provider, envName: task.row.envName, masked: task.row.masked,
            model: task.row.model, transport: task.transport, reasoningLevel: task.reasoningLevel || 'default',
        });
        const probe = await probeTextTransportSecondRound({
            fetchImpl,
            credential: task.credential,
            model: task.row.model,
            prompt: DEFAULT_TEXT_PROMPT,
            timeoutMs: task.reasoningLevel ? reasoningTimeout(task.reasoningLevel, timeoutMs) : timeoutMs,
            transport: task.transport,
            reasoningLevel: task.reasoningLevel,
        });
        const merged = mergeTransportAfterRetry(
            task.type === 'baseline' ? task.row.transports[task.transport] : task.reasoning.transports[task.transport],
            probe,
            task.transport,
        );
        if (task.type === 'baseline') task.row.transports[task.transport] = merged;
        else task.reasoning.transports[task.transport] = merged;
        await appendResult({
            capability: task.type === 'baseline' ? 'text-second-round' : 'text-reasoning-second-round',
            provider: task.row.provider, envName: task.row.envName, masked: task.row.masked, model: task.row.model,
            reasoningLevel: task.reasoningLevel || '', ...merged,
        });
        completed += 1;
        const elapsed = Date.now() - started;
        const etaSeconds = completed ? Math.max(0, Math.round((elapsed / completed) * (tasks.length - completed) / 1000)) : null;
        await writeStatus({
            status: 'running', stage: 'second-round-text', completed, total: tasks.length,
            activeLimit: concurrency.modelConcurrency, perKeyLimit: concurrency.perKeyModelConcurrency,
            etaSeconds, outDir, updatedAt: new Date().toISOString(),
        });
        await onProgress?.({
            stage: 'second-round-complete', index: index + 1, completed, total: tasks.length,
            provider: task.row.provider, envName: task.row.envName, model: task.row.model,
            transport: task.transport, reasoningLevel: task.reasoningLevel || 'default',
            ok: merged.ok, status: merged.status, endpoint: merged.endpoint, error: merged.error, etaSeconds,
        });
        return { task, merged };
    }, {
        globalLimit: concurrency.modelConcurrency,
        perKeyLimit: concurrency.perKeyModelConcurrency,
        keyFn: (task) => `${task.row.provider}:${task.row.envName}`,
    });

    for (const row of textResults) {
        const policy = chooseTransportPolicy(row.transports.non_stream, row.transports.stream);
        Object.assign(row, policy, {
            preferredEndpoint: policy.preferredTransport === 'stream' ? row.transports.stream.endpoint : row.transports.non_stream.endpoint,
            fallbackEndpoint: policy.fallbackTransport.startsWith('stream') ? row.transports.stream.endpoint : policy.fallbackTransport ? row.transports.non_stream.endpoint : '',
        });
        for (const reasoning of row.reasoningResults || []) {
            const rp = chooseTransportPolicy(reasoning.transports.non_stream, reasoning.transports.stream);
            Object.assign(reasoning, rp, {
                preferredEndpoint: rp.preferredTransport === 'stream' ? reasoning.transports.stream.endpoint : reasoning.transports.non_stream.endpoint,
                fallbackEndpoint: rp.fallbackTransport.startsWith('stream') ? reasoning.transports.stream.endpoint : rp.fallbackTransport ? reasoning.transports.non_stream.endpoint : '',
            });
        }
        row.reasoningModesSupported = (row.reasoningResults || []).filter((item) => item.keep).map((item) => item.level);
        row.reasoningPolicies = reasoningPoliciesFromResults(row.reasoningResults || []);
    }
    return { attempts: tasks.length, recovered: results.filter((item) => item?.merged?.ok).length };
}

function shouldTargetedThirdRound(row) {
    if (!row || row.ok) return false;
    const status = Number(row.status || 0);
    const failure = classifyFailure(row);
    if (failure.definitiveDead || ['invalid_key', 'quota', 'key_restricted', 'access_denied', 'terms_blocked', 'deprecated', 'stream_unsupported'].includes(failure.kind)) return false;
    return status === 0 || status === 200 || status >= 500 || ['other', 'server', 'network'].includes(failure.kind);
}

async function runTextTargetedThirdRound({ textResults, credentialById, fetchImpl, timeoutMs, concurrency, env, onProgress, appendResult, writeStatus, outDir }) {
    const maxModels = boundedInt(env.AI_AUDIT_TARGETED_RETRY_MAX_MODELS, 40, 0, 200);
    if (!maxModels) return { models: 0, attempts: 0, recoveredModels: 0 };
    const candidates = textResults
        .filter((row) => !row.keep && ['non_stream', 'stream'].some((transport) => shouldTargetedThirdRound({ ...row.transports?.[transport], provider: row.provider })))
        .slice(0, maxModels);
    if (!candidates.length) return { models: 0, attempts: 0, recoveredModels: 0 };

    await onProgress?.({ stage: 'targeted-third-round-start', total: candidates.length });
    let completed = 0;
    let attempts = 0;
    const started = Date.now();
    const thirdTimeout = boundedInt(env.AI_AUDIT_TARGETED_RETRY_TIMEOUT_MS, Math.max(120_000, timeoutMs), 30_000, 240_000);
    const results = await runConcurrentByKey(candidates, async (row, index) => {
        const credential = credentialById.get(`${row.provider}:${row.envName}`);
        if (!credential) return { row, recovered: false, attempts: 0 };
        const transports = ['non_stream', 'stream'].filter((transport) => shouldTargetedThirdRound({ ...row.transports?.[transport], provider: row.provider }));
        await onProgress?.({ stage: 'targeted-third-round-model-start', index: index + 1, total: candidates.length, provider: row.provider, envName: row.envName, model: row.model, transports });
        const probes = await Promise.all(transports.map(async (transport) => {
            const probe = await probeTextTransportSecondRound({ fetchImpl, credential, model: row.model, prompt: DEFAULT_TEXT_PROMPT, timeoutMs: thirdTimeout, transport, reasoningLevel: '' });
            attempts += 1;
            const merged = mergeTransportAfterRetry(row.transports[transport], probe, transport);
            merged.thirdRound = transportRow(probe, transport);
            row.transports[transport] = merged;
            await appendResult({ capability: 'text-targeted-third-round', provider: row.provider, envName: row.envName, masked: row.masked, model: row.model, ...merged });
            return { transport, merged };
        }));
        const policy = chooseTransportPolicy(row.transports.non_stream, row.transports.stream);
        Object.assign(row, policy, {
            preferredEndpoint: policy.preferredTransport === 'stream' ? row.transports.stream.endpoint : row.transports.non_stream.endpoint,
            fallbackEndpoint: policy.fallbackTransport.startsWith('stream') ? row.transports.stream.endpoint : policy.fallbackTransport ? row.transports.non_stream.endpoint : '',
        });
        completed += 1;
        const elapsed = Date.now() - started;
        const etaSeconds = completed ? Math.max(0, Math.round((elapsed / completed) * (candidates.length - completed) / 1000)) : null;
        await writeStatus({ status: 'running', stage: 'targeted-third-round-text', completed, total: candidates.length, activeLimit: Math.min(concurrency.modelConcurrency, 4), perKeyLimit: 1, etaSeconds, outDir, updatedAt: new Date().toISOString() });
        await onProgress?.({ stage: 'targeted-third-round-model-complete', index: index + 1, completed, total: candidates.length, provider: row.provider, envName: row.envName, model: row.model, keep: row.keep, preferredTransport: row.preferredTransport, probes, etaSeconds });
        return { row, recovered: row.keep, attempts: probes.length };
    }, {
        globalLimit: Math.min(concurrency.modelConcurrency, 4),
        perKeyLimit: 1,
        keyFn: (row) => `${row.provider}:${row.envName}`,
    });
    return { models: candidates.length, attempts, recoveredModels: results.filter((item) => item?.recovered).length };
}

function geminiReasoningConfig(level) {
    if (!level || level === 'none' || level === 'xhigh' || level === 'max') {
        if (level === 'none') return { thinkingConfig: { thinkingBudget: 0 } };
        return level ? { thinkingConfig: { thinkingLevel: level.toUpperCase() } } : {};
    }
    return { thinkingConfig: { thinkingLevel: level.toUpperCase() } };
}

async function probeTextTransport({ fetchImpl, credential, model, prompt, timeoutMs, transport, reasoningLevel = '' }) {
    if (['openai', 'openai-compatible', 'groq', 'nvidia', 'huggingface'].includes(credential.provider)) {
        return probeOpenAiLikeTransport({ fetchImpl, credential, model, prompt, timeoutMs, transport, reasoningLevel });
    }

    const stream = transport === 'stream';
    if (credential.provider === 'anthropic') {
        const url = `${credential.baseUrl.replace(/\/$/u, '')}/messages`;
        const body = {
            model,
            max_tokens: 64,
            stream,
            messages: [{ role: 'user', content: prompt }],
            ...(reasoningLevel ? { output_config: { effort: reasoningLevel } } : {}),
        };
        if (stream) {
            const result = await requestEventStream(fetchImpl, url, {
                method: 'POST',
                headers: {
                    'x-api-key': credential.secret,
                    'anthropic-version': '2023-06-01',
                    'Content-Type': 'application/json',
                    Accept: 'text/event-stream',
                },
                body: JSON.stringify(body),
            }, { timeoutMs, provider: 'anthropic' });
            const assessment = auditTextAssessment(result.text);
            const valid = Boolean(result.ok && assessment.transportOk);
            return { ...result, ok: valid, instructionCompliant: assessment.instructionCompliant, text: assessment.text, error: valid ? '' : clean(result.error || 'HTTP успешен, но текст не извлечён из ответа.'), endpoint: 'messages', attempts: [{ transport, endpoint: 'messages', ...result, ok: valid, instructionCompliant: assessment.instructionCompliant, textSample: assessment.text.slice(0, 600), rawSample: clean(result.rawSample).slice(0, 4000) }] };
        }
        const result = await requestJson(fetchImpl, url, {
            method: 'POST',
            headers: {
                'x-api-key': credential.secret,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
        }, timeoutMs);
        const text = extractText('anthropic', result.payload);
        const assessment = auditTextAssessment(text);
        const valid = Boolean(result.ok && assessment.transportOk);
        return { ...result, ok: valid, instructionCompliant: assessment.instructionCompliant, endpoint: 'messages', text: assessment.text, error: valid ? '' : clean(result.error || 'HTTP успешен, но текст не извлечён из ответа.'), attempts: [{ transport, endpoint: 'messages', ...result, payload: undefined, ok: valid, instructionCompliant: assessment.instructionCompliant, textSample: assessment.text.slice(0, 600), rawSample: clean(result.raw).slice(0, 4000) }] };
    }

    if (credential.provider === 'gemini') {
        const method = stream ? 'streamGenerateContent' : 'generateContent';
        const suffix = stream ? '&alt=sse' : '';
        const url = `${credential.baseUrl.replace(/\/$/u, '')}/models/${encodeURIComponent(model)}:${method}?key=${encodeURIComponent(credential.secret)}${suffix}`;
        const body = {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: {
                maxOutputTokens: 64,
                ...geminiReasoningConfig(reasoningLevel),
            },
        };
        if (stream) {
            const result = await requestEventStream(fetchImpl, url, {
                method: 'POST', headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' }, body: JSON.stringify(body),
            }, { timeoutMs, provider: 'gemini' });
            const assessment = auditTextAssessment(result.text);
            const valid = Boolean(result.ok && assessment.transportOk);
            return { ...result, ok: valid, instructionCompliant: assessment.instructionCompliant, text: assessment.text, error: valid ? '' : clean(result.error || 'HTTP успешен, но текст не извлечён из ответа.'), endpoint: 'streamGenerateContent', attempts: [{ transport, endpoint: 'streamGenerateContent', ...result, ok: valid, instructionCompliant: assessment.instructionCompliant, textSample: assessment.text.slice(0, 600), rawSample: clean(result.rawSample).slice(0, 4000) }] };
        }
        const result = await requestJson(fetchImpl, url, {
            method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
        }, timeoutMs);
        const text = extractText('gemini', result.payload);
        const assessment = auditTextAssessment(text);
        const valid = Boolean(result.ok && assessment.transportOk);
        return { ...result, ok: valid, instructionCompliant: assessment.instructionCompliant, endpoint: 'generateContent', text: assessment.text, error: valid ? '' : clean(result.error || 'HTTP успешен, но текст не извлечён из ответа.'), attempts: [{ transport, endpoint: 'generateContent', ...result, payload: undefined, ok: valid, instructionCompliant: assessment.instructionCompliant, textSample: assessment.text.slice(0, 600), rawSample: clean(result.raw).slice(0, 4000) }] };
    }

    return {
        ok: false,
        status: 0,
        elapsedMs: 0,
        firstByteMs: 0,
        error: 'No universal text inference adapter for this provider.',
        endpoint: 'unsupported',
        text: '',
        observedTransport: 'none',
        attempts: [],
    };
}

function isTextModel(model) {
    const capabilities = Array.isArray(model?.capabilities) ? model.capabilities : [];
    return capabilities.includes('text');
}

function chooseTransportPolicy(nonStream, stream) {
    if (nonStream?.ok && stream?.ok) {
        return { keep: true, preferredTransport: 'non_stream', fallbackTransport: 'stream', transportState: 'both' };
    }
    if (stream?.ok) {
        return { keep: true, preferredTransport: 'stream', fallbackTransport: 'non_stream_retry_once', transportState: 'stream_only' };
    }
    if (nonStream?.ok) {
        return { keep: true, preferredTransport: 'non_stream', fallbackTransport: '', transportState: 'non_stream_only' };
    }
    return { keep: false, preferredTransport: '', fallbackTransport: '', transportState: 'dead' };
}

function transportRow(probe, transport) {
    return {
        transport,
        ok: Boolean(probe?.ok && clean(probe?.text)),
        status: Number(probe?.status || 0),
        elapsedMs: Number(probe?.elapsedMs || 0),
        firstByteMs: Number(probe?.firstByteMs || 0),
        endpoint: clean(probe?.endpoint),
        observedTransport: clean(probe?.observedTransport),
        instructionCompliant: Boolean(probe?.instructionCompliant),
        textSample: clean(probe?.text).slice(0, 600),
        rawSample: clean(probe?.rawSample || probe?.raw).slice(0, 4000),
        error: probe?.ok && clean(probe?.text) ? '' : clean(probe?.error || (probe?.ok ? 'HTTP успешен, но текст ответа пуст.' : 'unknown error')),
        attempts: Array.isArray(probe?.attempts) ? probe.attempts : [],
    };
}

function reasoningTimeout(level, base) {
    if (level === 'high') return Math.max(base, 180_000);
    if (level === 'xhigh' || level === 'max') return Math.max(base, 240_000);
    if (level === 'medium') return Math.max(base, 150_000);
    return Math.max(base, 120_000);
}

async function probeReasoningMatrix({
    fetchImpl,
    credential,
    model,
    prompt,
    timeoutMs,
    baselineNonStream,
    baselineStream,
    reasoningConcurrency = DEFAULT_REASONING_CONCURRENCY,
    onProgress = null,
}) {
    const baselinePolicy = chooseTransportPolicy(baselineNonStream, baselineStream);
    const baseline = {
        level: 'default',
        transports: { non_stream: baselineNonStream, stream: baselineStream },
        ...baselinePolicy,
        preferredEndpoint: baselinePolicy.preferredTransport === 'stream' ? baselineStream.endpoint : baselineNonStream.endpoint,
        fallbackEndpoint: baselinePolicy.fallbackTransport.startsWith('stream') ? baselineStream.endpoint : baselinePolicy.fallbackTransport ? baselineNonStream.endpoint : '',
    };

    const levels = reasoningLevelsForModel(credential.provider, model).filter((level) => level !== 'default');
    const tested = await runConcurrent(levels, async (level, index) => {
        await onProgress?.({
            stage: 'reasoning-start', index: index + 1, total: levels.length,
            provider: credential.provider, envName: credential.name, masked: credential.masked,
            model, reasoningLevel: level, transport: 'both', reasoningConcurrency,
        });

        const [nonStreamProbe, streamProbe] = await Promise.all([
            probeTextTransport({
                fetchImpl,
                credential,
                model,
                prompt,
                timeoutMs: reasoningTimeout(level, timeoutMs),
                transport: 'non_stream',
                reasoningLevel: level,
            }),
            probeTextTransport({
                fetchImpl,
                credential,
                model,
                prompt,
                timeoutMs: reasoningTimeout(level, timeoutMs),
                transport: 'stream',
                reasoningLevel: level,
            }),
        ]);

        const transports = {
            non_stream: transportRow(nonStreamProbe, 'non_stream'),
            stream: transportRow(streamProbe, 'stream'),
        };
        for (const transport of ['non_stream', 'stream']) {
            await onProgress?.({
                stage: 'reasoning-transport-complete', provider: credential.provider,
                envName: credential.name, masked: credential.masked, model,
                reasoningLevel: level, ...transports[transport],
            });
        }
        const policy = chooseTransportPolicy(transports.non_stream, transports.stream);
        const row = {
            level,
            transports,
            ...policy,
            preferredEndpoint: policy.preferredTransport === 'stream' ? transports.stream.endpoint : transports.non_stream.endpoint,
            fallbackEndpoint: policy.fallbackTransport.startsWith('stream') ? transports.stream.endpoint : policy.fallbackTransport ? transports.non_stream.endpoint : '',
        };
        await onProgress?.({
            stage: 'reasoning-complete', provider: credential.provider, envName: credential.name,
            masked: credential.masked, model, reasoningLevel: level,
            keep: row.keep, preferredTransport: row.preferredTransport,
            fallbackTransport: row.fallbackTransport,
        });
        return row;
    }, reasoningConcurrency);

    return [baseline, ...tested];
}

async function runImageSecondRound({ imageResults, credentialById, fetchImpl, env, concurrency, onProgress, appendResult, writeStatus, outDir, visualOutDir }) {
    const tasks = [];
    for (const row of imageResults) {
        const credential = credentialById.get(`${row.provider}:${row.envName}`);
        if (!credential) continue;
        for (const transport of ['non_stream', 'stream']) {
            const attempt = row.transports?.[transport];
            if (attempt && shouldSecondRoundRetry({ ...attempt, provider: row.provider })) {
                tasks.push({ row, credential, transport });
            }
        }
    }
    let completed = 0;
    const started = Date.now();
    const results = await runConcurrentByKey(tasks, async (task, index) => {
        await onProgress?.({
            stage: 'image-second-round-start', index: index + 1, total: tasks.length,
            provider: task.row.provider, envName: task.row.envName, masked: task.row.masked,
            model: task.row.model, transport: task.transport,
        });
        let retry;
        if (task.transport === 'non_stream') {
            const raw = await probeProviderVisualModel({
                credential: task.credential, model: task.row.model, prompt: DEFAULT_IMAGE_PROMPT,
            });
            let imagePath = '';
            if (raw.ok && raw.image?.buffer?.length) {
                const safeName = `retry__${String(index + 1).padStart(4, '0')}__${task.row.provider.replace(/[^a-z0-9._-]+/giu, '_')}__${task.row.envName.replace(/[^a-z0-9._-]+/giu, '_')}__${task.row.model.replace(/[^a-z0-9._-]+/giu, '_')}.png`;
                imagePath = resolve(visualOutDir, safeName);
                await writeFile(imagePath, raw.image.buffer);
            }
            retry = {
                transport: 'non_stream', ok: Boolean(raw.ok), status: Number(raw.status || 0), elapsedMs: Number(raw.elapsedMs || 0),
                firstByteMs: 0, endpoint: clean(task.row.transports?.non_stream?.endpoint || 'provider-image-adapter'), observedTransport: 'non_stream',
                error: raw.ok ? '' : clean(raw.error), imagePath, imageBytes: Number(raw.image?.buffer?.length || 0), mimeType: clean(raw.image?.mimeType), attempts: [],
            };
        } else {
            const raw = await probeImageStream({
                fetchImpl, credential: task.credential, model: task.row.model, prompt: DEFAULT_IMAGE_PROMPT,
                timeoutMs: DEFAULT_IMAGE_STREAM_TIMEOUT_MS, nvidiaVisualBaseUrl: clean(env.NVIDIA_IMAGE_BASE_URL),
            });
            let imagePath = '';
            if (raw.ok && raw.image?.buffer?.length) {
                const safeName = `retry_stream__${String(index + 1).padStart(4, '0')}__${task.row.provider.replace(/[^a-z0-9._-]+/giu, '_')}__${task.row.envName.replace(/[^a-z0-9._-]+/giu, '_')}__${task.row.model.replace(/[^a-z0-9._-]+/giu, '_')}.png`;
                imagePath = resolve(visualOutDir, safeName);
                await writeFile(imagePath, raw.image.buffer);
            }
            retry = {
                transport: 'stream', ok: Boolean(raw.ok), status: Number(raw.status || 0), elapsedMs: Number(raw.elapsedMs || 0),
                firstByteMs: Number(raw.firstByteMs || 0), endpoint: clean(raw.endpoint), observedTransport: clean(raw.observedTransport),
                error: raw.ok ? '' : clean(raw.error), imagePath, imageBytes: Number(raw.image?.buffer?.length || 0), mimeType: clean(raw.image?.mimeType), attempts: raw.attempts || [],
            };
        }
        const original = task.row.transports[task.transport];
        const merged = { ...(retry.ok ? retry : original), firstRound: original, secondRound: retry };
        task.row.transports[task.transport] = merged;
        await appendResult({ capability: 'image-second-round', provider: task.row.provider, envName: task.row.envName, masked: task.row.masked, model: task.row.model, ...merged });
        completed += 1;
        const elapsed = Date.now() - started;
        const etaSeconds = completed ? Math.max(0, Math.round((elapsed / completed) * (tasks.length - completed) / 1000)) : null;
        await writeStatus({ status: 'running', stage: 'second-round-image', completed, total: tasks.length, etaSeconds, outDir, updatedAt: new Date().toISOString() });
        await onProgress?.({ stage: 'image-second-round-complete', index: index + 1, completed, total: tasks.length, provider: task.row.provider, envName: task.row.envName, model: task.row.model, transport: task.transport, ok: merged.ok, status: merged.status, endpoint: merged.endpoint, error: merged.error, etaSeconds });
        return merged;
    }, {
        globalLimit: concurrency.imageConcurrency,
        perKeyLimit: concurrency.perKeyImageConcurrency,
        keyFn: (task) => `${task.row.provider}:${task.row.envName}`,
    });
    for (const row of imageResults) {
        const policy = chooseTransportPolicy(row.transports.non_stream, row.transports.stream);
        Object.assign(row, policy, {
            preferredEndpoint: policy.preferredTransport === 'stream' ? row.transports.stream.endpoint : row.transports.non_stream.endpoint,
            fallbackEndpoint: policy.fallbackTransport.startsWith('stream') ? row.transports.stream.endpoint : policy.fallbackTransport ? row.transports.non_stream.endpoint : '',
        });
    }
    return { attempts: tasks.length, recovered: results.filter((row) => row?.ok).length };
}

function reasoningPoliciesFromResults(results = []) {
    const policies = {};
    for (const row of results) {
        if (!row?.level) continue;
        policies[row.level] = {
            keep: Boolean(row.keep),
            preferredTransport: clean(row.preferredTransport),
            fallbackTransport: clean(row.fallbackTransport),
            preferredEndpoint: clean(row.preferredEndpoint),
            fallbackEndpoint: clean(row.fallbackEndpoint),
            nonStreamOk: Boolean(row.transports?.non_stream?.ok),
            streamOk: Boolean(row.transports?.stream?.ok),
        };
    }
    return policies;
}

function parseImagePayload(payload) {
    const candidates = [];
    const walk = (value, depth = 0) => {
        if (depth > 7 || value == null) return;
        if (Array.isArray(value)) {
            for (const item of value) walk(item, depth + 1);
            return;
        }
        if (typeof value !== 'object') return;
        for (const [key, item] of Object.entries(value)) {
            const lower = key.toLowerCase();
            if (typeof item === 'string') {
                if (/(?:b64_json|base64|image_b64|partial_image_b64|image_base64|data)$/u.test(lower) && item.length > 100) {
                    candidates.push({ type: 'base64', value: item, mimeType: clean(value.mime_type || value.mimeType || 'image/png') });
                } else if ((lower === 'url' || lower.endsWith('_url')) && /^https?:\/\//iu.test(item)) {
                    candidates.push({ type: 'url', value: item, mimeType: '' });
                }
            } else {
                walk(item, depth + 1);
            }
        }
    };
    walk(payload);
    return candidates;
}

function decodeImageCandidate(candidate) {
    if (candidate?.type !== 'base64') return null;
    const raw = clean(candidate.value).replace(/^data:image\/[^;]+;base64,/iu, '');
    if (!raw) return null;
    try {
        const buffer = Buffer.from(raw, 'base64');
        return buffer.length ? { buffer, mimeType: candidate.mimeType || 'image/png' } : null;
    } catch {
        return null;
    }
}

async function downloadImageCandidate(fetchImpl, candidate, timeoutMs) {
    if (candidate?.type === 'base64') return decodeImageCandidate(candidate);
    if (candidate?.type !== 'url') return null;
    try {
        const response = await fetchImpl(candidate.value, { signal: AbortSignal.timeout(timeoutMs) });
        if (!response.ok) return null;
        const buffer = Buffer.from(await response.arrayBuffer());
        if (!buffer.length) return null;
        return { buffer, mimeType: clean(response.headers?.get?.('content-type')).split(';')[0] || 'image/png' };
    } catch {
        return null;
    }
}

function nvidiaVisualPayload(modelId, prompt) {
    const model = NVIDIA_VISUAL_MODELS.find((row) => row.id === modelId);
    if (!model) return { prompt, width: 1024, height: 1024, seed: 1, stream: true };
    return { ...model.buildPayload(prompt, { width: 1024, height: 1024, seed: 1 }), stream: true };
}

async function probeImageStream({ fetchImpl, credential, model, prompt, timeoutMs = DEFAULT_IMAGE_STREAM_TIMEOUT_MS, nvidiaVisualBaseUrl = '' }) {
    const attempts = [];

    async function run(url, body, endpoint, headers = {}) {
        const streamCandidates = [];
        const pushPayload = (payload) => streamCandidates.push(...parseImagePayload(payload));
        const result = await requestEventStream(fetchImpl, url, {
            method: 'POST',
            headers: {
                'Content-Type': 'application/json',
                Accept: 'text/event-stream',
                ...(credential.provider === 'gemini' ? {} : { Authorization: `Bearer ${credential.secret}` }),
                ...headers,
            },
            body: JSON.stringify(body),
        }, {
            timeoutMs,
            provider: credential.provider,
            extractChunkText: () => '',
            onPayload: pushPayload,
        });
        let image = null;
        for (const candidate of streamCandidates) {
            image = await downloadImageCandidate(fetchImpl, candidate, 45_000);
            if (image) break;
        }
        const ok = Boolean(result.status >= 200 && result.status < 300 && result.observedTransport === 'stream' && image?.buffer?.length);
        const row = {
            endpoint,
            ok,
            status: result.status,
            elapsedMs: result.elapsedMs,
            firstByteMs: result.firstByteMs || 0,
            observedTransport: result.observedTransport,
            chunks: result.chunks || 0,
            error: ok ? '' : clean(result.error || (result.observedTransport !== 'stream' ? 'endpoint did not stream' : 'stream contained no final image')),
            image,
        };
        attempts.push({ ...row, image: undefined });
        return row;
    }

    const baseUrl = credential.baseUrl.replace(/\/$/u, '');
    if (credential.provider === 'openai' || credential.provider === 'openai-compatible' || credential.provider === 'xai') {
        let row = await run(`${baseUrl}/images/generations`, { model, prompt, size: '1024x1024', n: 1, stream: true }, 'images/generations');
        if (row.ok) return { ...row, attempts };
        row = await run(`${baseUrl}/chat/completions`, {
            model,
            messages: [{ role: 'user', content: prompt }],
            stream: true,
        }, 'chat/completions');
        return { ...row, attempts };
    }
    if (credential.provider === 'gemini') {
        const url = `${baseUrl}/models/${encodeURIComponent(model)}:streamGenerateContent?key=${encodeURIComponent(credential.secret)}&alt=sse`;
        const row = await run(url, {
            contents: [{ role: 'user', parts: [{ text: prompt }] }],
            generationConfig: { responseModalities: ['IMAGE'] },
        }, 'streamGenerateContent');
        return { ...row, attempts };
    }
    if (credential.provider === 'huggingface') {
        const row = await run(`https://router.huggingface.co/hf-inference/models/${encodeURIComponent(model)}`, {
            inputs: prompt,
            parameters: { width: 1024, height: 1024, seed: 1 },
            stream: true,
        }, 'hf-inference-stream', { Accept: 'text/event-stream, image/png' });
        return { ...row, attempts };
    }
    if (credential.provider === 'nvidia') {
        const visualBase = clean(nvidiaVisualBaseUrl) || clean(process.env.NVIDIA_IMAGE_BASE_URL) || 'https://ai.api.nvidia.com/v1/genai';
        const row = await run(`${visualBase.replace(/\/$/u, '')}/${model}`, nvidiaVisualPayload(model, prompt), 'nvidia-visual-stream');
        return { ...row, attempts };
    }
    return { ok: false, status: 0, elapsedMs: 0, firstByteMs: 0, observedTransport: 'none', endpoint: 'unsupported', error: 'provider has no stream image adapter', attempts };
}

function sanitizeVisualResult(result) {
    return {
        index: result.index,
        total: result.total,
        provider: result.provider,
        envName: result.envName,
        masked: result.masked,
        model: result.model,
        ok: Boolean(result.ok),
        status: Number(result.status || 0),
        elapsedMs: Number(result.elapsedMs || 0),
        firstByteMs: 0,
        endpoint: 'provider-image-adapter',
        error: clean(result.error),
        imagePath: clean(result.imagePath),
        imageBytes: Number(result.imageBytes || 0),
        mimeType: clean(result.mimeType),
    };
}

function buildRetryCandidate(row) {
    const classification = classifyFailure(row);
    return {
        provider: row.provider,
        envName: row.envName,
        masked: row.masked,
        model: row.model,
        capability: row.capability,
        transport: row.transport || '',
        endpoint: row.endpoint || '',
        reasoningLevel: row.reasoningLevel || '',
        status: Number(row.status || 0),
        error: clean(row.error),
        kind: classification.kind,
        retryEligible: classification.retryEligible,
        retryStrategy: classification.retryStrategy,
        definitiveDead: Boolean(classification.definitiveDead),
        secondRoundAttempted: Boolean(row.secondRound),
        secondRoundStatus: Number(row.secondRound?.status || 0),
        secondRoundEndpoint: clean(row.secondRound?.endpoint),
        secondRoundError: clean(row.secondRound?.error),
    };
}

function formatTransportSummary(row) {
    const ns = row.transports?.non_stream || {};
    const st = row.transports?.stream || {};
    return `${row.keep ? 'KEEP' : 'REMOVE'} ${row.provider} ${row.envName} ${row.masked} model=${row.model} non_stream=${ns.ok ? 'OK' : `FAIL:${ns.status || 0}`} stream=${st.ok ? 'OK' : `FAIL:${st.status || 0}`} preferred=${row.preferredTransport || '-'} fallback=${row.fallbackTransport || '-'} reasoning=${(row.reasoningModesSupported || []).join(',') || '-'}`;
}

function formatReport(report) {
    const lines = [
        'GIGORAVE FULL AI MODEL AUDIT V144 — FINAL KEY SWEEP + QUOTA LIFECYCLE',
        `checked_at=${report.checkedAt}`,
        `directory=${report.outDir}`,
        `keys_total=${report.keyAudit.total} keys_valid=${report.keyAudit.valid} keys_invalid=${report.keyAudit.invalid}`,
        `second_round_keys=${report.stats.secondRoundKeyAttempts || 0} recovered=${report.stats.secondRoundKeysRecovered || 0} text_attempts=${report.stats.secondRoundTextAttempts || 0} text_recovered=${report.stats.secondRoundTextRecovered || 0} image_attempts=${report.stats.secondRoundImageAttempts || 0} image_recovered=${report.stats.secondRoundImageRecovered || 0}`,
        `full_second_key_sweep candidates=${report.stats.fullSecondSweepCandidates || 0} catalog_retested=${report.stats.fullSecondSweepCatalogRetested || 0} text_models=${report.stats.fullSecondSweepTextModels || 0} image_models=${report.stats.fullSecondSweepImageModels || 0} transport_attempts=${report.stats.fullSecondSweepTransportAttempts || 0} recovered_keys=${report.stats.fullSecondSweepRecoveredKeys || 0} dead_confirmed=${report.stats.fullSecondSweepConfirmedDeadKeys || 0} uncertain=${report.stats.fullSecondSweepUncertainKeys || 0}`,
        `concurrency key=${report.concurrency.keyConcurrency} model=${report.concurrency.modelConcurrency} per_key_model=${report.concurrency.perKeyModelConcurrency} reasoning_levels=${report.concurrency.reasoningConcurrency} image=${report.concurrency.imageConcurrency} per_key_image=${report.concurrency.perKeyImageConcurrency}`,
        `catalog_models=${report.stats.catalogModels}`,
        `text_models=${report.stats.textModels} text_transport_attempts=${report.stats.textTransportAttempts} text_models_kept=${report.stats.textModelsKept}`,
        `reasoning_transport_attempts=${report.stats.reasoningAttempts} reasoning_transport_ok=${report.stats.reasoningTransportOk} reasoning_modes_ok=${report.stats.reasoningModesOk}`,
        `image_models=${report.stats.imageModels} image_transport_attempts=${report.stats.imageTransportAttempts} image_models_kept=${report.stats.imageModelsKept}`,
        `working_runtime_modes=${report.workingModes.length}`,
        `retry_candidates=${report.retryCandidates.length}`,
        '',
        'TRANSPORT POLICY',
        'both => preferred non_stream, fallback stream',
        'stream_only => preferred stream, fallback non_stream_retry_once',
        'non_stream_only => preferred non_stream, no failed-stream fallback',
        'neither => remove from runtime registry',
        '',
        'KEYS',
        ...report.keyAudit.results.map((row, index) => `${index + 1}. ${row.ok ? 'OK' : 'FAIL'} ${row.provider} ${row.envName} ${row.masked} HTTP=${row.status || 0} models=${row.models?.length || 0}${row.error ? ` error=${row.error}` : ''}`),
        '',
        'FULL SECOND KEY SWEEP',
        ...((report.keySecondSweep?.results || []).map((row, index) => `${index + 1}. ${row.verdict} ${row.provider} ${row.envName} ${row.masked} text_models=${row.textModelsTested || 0} image_models=${row.imageModelsTested || 0} attempts=${row.modelTransportAttempts || 0} recovered_modes=${row.recoveredModes?.length || 0} reason=${row.reason || ''}`)),
        '',
        'TEXT MODEL MATRIX',
        ...report.textResults.map(formatTransportSummary),
        '',
        'IMAGE MODEL MATRIX',
        ...report.imageResults.map(formatTransportSummary),
        '',
        'RETRY PLAN',
        ...report.retryCandidates.map((row, index) => `${index + 1}. ${row.retryEligible ? 'RETRY' : 'HOLD'} ${row.provider} ${row.envName} model=${row.model} capability=${row.capability} transport=${row.transport || '-'} reasoning=${row.reasoningLevel || '-'} kind=${row.kind} HTTP=${row.status || 0} strategy=${row.retryStrategy}${row.error ? ` error=${row.error}` : ''}`),
    ];
    return `${lines.join('\n')}\n`;
}

export function buildCompactAuditFacts(report) {
    const topErrors = report.retryCandidates.slice(0, 12).map((row) => ({
        provider: row.provider,
        model: row.model,
        capability: row.capability,
        transport: row.transport,
        reasoningLevel: row.reasoningLevel,
        kind: row.kind,
        status: row.status,
        error: row.error.slice(0, 240),
    }));
    return {
        keys: { total: report.keyAudit.total, valid: report.keyAudit.valid, invalid: report.keyAudit.invalid },
        models: {
            catalog: report.stats.catalogModels,
            textModels: report.stats.textModels,
            textModelsKept: report.stats.textModelsKept,
            imageModels: report.stats.imageModels,
            imageModelsKept: report.stats.imageModelsKept,
            workingRuntimeModes: report.workingModes.length,
        },
        transports: report.stats.transportStates,
        secondRound: report.secondRound || {},
        keySecondSweep: {
            candidates: report.keySecondSweep?.candidates || 0,
            recoveredKeys: report.keySecondSweep?.recoveredKeys || 0,
            confirmedDeadKeys: report.keySecondSweep?.confirmedDeadKeys || 0,
            uncertainKeys: report.keySecondSweep?.uncertainKeys || 0,
            recoveredModes: report.keySecondSweep?.recoveredModes?.length || 0,
        },
        reasoning: {
            attempts: report.stats.reasoningAttempts,
            ok: report.stats.reasoningModesOk,
            transportOk: report.stats.reasoningTransportOk,
        },
        topErrors,
    };
}

export async function summarizeAuditWithSol({ report, env = process.env, fetchImpl = globalThis.fetch, timeoutMs = 180_000 } = {}) {
    const key = clean(env.OPENAI_COMPAT_API_KEY);
    if (!key) return { ok: false, error: 'OPENAI_COMPAT_API_KEY отсутствует; Sol summary пропущен.' };
    const baseUrl = clean(env.OPENAI_COMPAT_BASE_URL) || 'https://router.cheap/v1';
    const model = clean(env.GPT_MODEL_PRO3) || 'gpt-5.6-sol';
    const facts = buildCompactAuditFacts(report);
    const prompt = [
        'Ты GPT-5.6 Sol. Кратко проанализируй технический аудит AI-провайдеров бота Gigorave.',
        'Нужен русский отчёт максимум 10 коротких строк: рабочие модели, transport policy stream/non-stream, reasoning-режимы, основные ошибки и что перепроверить вторым кругом. Не выдумывай причины вне данных.',
        JSON.stringify(facts),
    ].join('\n');
    const credential = { provider: 'openai-compatible', secret: key, baseUrl, name: 'OPENAI_COMPAT_API_KEY' };
    const nonStream = await probeOpenAiLikeTransport({ fetchImpl, credential, model, prompt, timeoutMs, transport: 'non_stream' });
    if (!nonStream.ok || !clean(nonStream.text)) {
        const stream = await probeOpenAiLikeTransport({ fetchImpl, credential, model, prompt, timeoutMs, transport: 'stream' });
        if (!stream.ok || !clean(stream.text)) {
            return { ok: false, model, status: stream.status || nonStream.status || 0, error: stream.error || nonStream.error || 'Sol вернула пустой ответ.' };
        }
        return { ok: true, model, endpoint: stream.endpoint, transport: 'stream', status: stream.status, elapsedMs: stream.elapsedMs, text: clean(stream.text) };
    }
    return { ok: true, model, endpoint: nonStream.endpoint, transport: 'non_stream', status: nonStream.status, elapsedMs: nonStream.elapsedMs, text: clean(nonStream.text) };
}

function configuredFallbackModels(env) {
    return [...new Set(Object.entries(env || {})
        .filter(([name, value]) => /^(?:GPT_MODEL|OPENAI_DIRECT_MODEL|NVIDIA_MODEL_DEFAULT)/u.test(name) && clean(value))
        .map(([, value]) => clean(value))
        .filter(Boolean))];
}

function buildTextPlan({ keyAudit, credentials, env }) {
    const credentialById = new Map(credentials.map((row) => [`${row.provider}:${row.name}`, row]));
    const plan = [];
    for (const keyResult of keyAudit.results || []) {
        const credential = credentialById.get(`${keyResult.provider}:${keyResult.envName}`);
        if (!credential) continue;
        let models = keyResult.ok ? (keyResult.models || []).filter(isTextModel) : [];
        if (!keyResult.ok && ![401, 403].includes(Number(keyResult.status || 0)) && credential.provider === 'openai-compatible') {
            models = configuredFallbackModels(env).map((id) => ({ id, capabilities: ['text'] }));
        }
        for (const model of models) plan.push({ credential, keyResult, model });
    }
    return plan;
}


function auditKeyId(provider, envName) {
    return `${clean(provider)}:${clean(envName)}`;
}

function uniqueModelIds(values = []) {
    return [...new Set((values || []).map((value) => clean(value)).filter(Boolean))];
}

function imageModelFromCatalog(model = {}) {
    const capabilities = Array.isArray(model?.capabilities) ? model.capabilities : [];
    return capabilities.includes('image') || capabilities.includes('generation');
}

function compactConfirmationAttempt(attempt = {}) {
    return {
        capability: clean(attempt.capability),
        model: clean(attempt.model),
        transport: clean(attempt.transport),
        endpoint: clean(attempt.endpoint),
        ok: Boolean(attempt.ok),
        status: Number(attempt.status || 0),
        elapsedMs: Number(attempt.elapsedMs || 0),
        error: clean(attempt.error).slice(0, 1200),
    };
}

function providerReachedByModelAttempt(attempts = []) {
    return attempts.some((attempt) => {
        const status = Number(attempt?.status || 0);
        return status > 0 && status < 500;
    });
}

function runtimeModeSignature(row = {}) {
    return [row.provider, row.envName, row.model, row.capability].map(clean).join('\u0000');
}

function dedupeRuntimeModes(rows = []) {
    const bySignature = new Map();
    for (const row of rows || []) {
        const signature = runtimeModeSignature(row);
        if (!signature.replace(/\u0000/gu, '')) continue;
        const previous = bySignature.get(signature);
        if (!previous || (!previous.nonStreamOk && row.nonStreamOk) || (!previous.streamOk && row.streamOk)) {
            bySignature.set(signature, row);
        }
    }
    return [...bySignature.values()];
}

/**
 * V144 final key confirmation sweep (V142 algorithm retained, quota lifecycle handled by V144 cleanup).
 *
 * The normal audit already performs provider-aware retry rounds per failed
 * transport.  This extra sweep has a different purpose: take every foreign
 * key that still has ZERO verified runtime modes and run its COMPLETE known
 * text/image model set again.  Only after this sweep may such a key be marked
 * dead-confirmed and removed from .env.  Pure network/5xx failures remain
 * uncertain and are deliberately preserved.
 */
async function runSecondFullKeySweep({
    keyAudit,
    credentials,
    textResults,
    imageResults,
    env,
    fetchImpl,
    timeoutMs,
    keyAuditRunner,
    concurrency,
    onProgress,
    outDir,
    includeExcluded = false,
}) {
    const firstWorkingByKey = new Map();
    for (const row of [...(textResults || []), ...(imageResults || [])]) {
        if (!row?.keep) continue;
        const id = auditKeyId(row.provider, row.envName);
        firstWorkingByKey.set(id, (firstWorkingByKey.get(id) || 0) + 1);
    }

    const firstCatalogByKey = new Map(
        (keyAudit?.results || []).map((row) => [auditKeyId(row.provider, row.envName), row]),
    );
    const candidates = (credentials || []).filter((credential) => !firstWorkingByKey.get(auditKeyId(credential.provider, credential.name)));
    const definitive = [];
    const retestable = [];
    for (const credential of candidates) {
        const firstCatalog = firstCatalogByKey.get(auditKeyId(credential.provider, credential.name));
        const failure = classifyFailure({
            status: firstCatalog?.status,
            error: firstCatalog?.error,
            provider: credential.provider,
            endpoint: 'models/whoami',
        });
        if (firstCatalog && !firstCatalog.ok && failure.definitiveDead) definitive.push(credential);
        else retestable.push(credential);
    }

    let secondCatalogAudit = { total: 0, valid: 0, invalid: 0, results: [] };
    if (retestable.length) {
        await onProgress?.({ stage: 'key-full-second-sweep-catalog-start', total: retestable.length });
        secondCatalogAudit = await keyAuditRunner({
            env,
            onlyEnvNames: retestable.map((credential) => credential.name),
            timeoutMs: Math.min(Math.max(timeoutMs, 30_000), 60_000),
            concurrency: Math.min(concurrency.keyConcurrency, 4),
            onProgress: (event) => onProgress?.({ stage: 'key-full-second-sweep-catalog', ...event }),
            includeExcluded,
        });
    }
    const secondCatalogByKey = new Map(
        (secondCatalogAudit.results || []).map((row) => [auditKeyId(row.provider, row.envName), row]),
    );

    const states = new Map();
    for (const credential of candidates) {
        const id = auditKeyId(credential.provider, credential.name);
        const firstCatalog = firstCatalogByKey.get(id) || null;
        const secondCatalog = secondCatalogByKey.get(id) || null;
        const secondFailure = secondCatalog && !secondCatalog.ok
            ? classifyFailure({ status: secondCatalog.status, error: secondCatalog.error, provider: credential.provider, endpoint: 'models/whoami' })
            : null;
        const firstFailure = firstCatalog && !firstCatalog.ok
            ? classifyFailure({ status: firstCatalog.status, error: firstCatalog.error, provider: credential.provider, endpoint: 'models/whoami' })
            : null;

        const catalogModels = [];
        for (const row of [firstCatalog, secondCatalog]) {
            for (const model of row?.models || []) catalogModels.push(model);
        }
        const priorTextModels = (textResults || [])
            .filter((row) => auditKeyId(row.provider, row.envName) === id)
            .map((row) => row.model);
        const priorImageModels = (imageResults || [])
            .filter((row) => auditKeyId(row.provider, row.envName) === id)
            .map((row) => row.model);
        const textModels = uniqueModelIds([
            ...priorTextModels,
            ...catalogModels.filter(isTextModel).map((model) => model.id),
        ]);
        const imageModels = uniqueModelIds([
            ...priorImageModels,
            ...catalogModels.filter(imageModelFromCatalog).map((model) => model.id),
            ...(credential.provider === 'nvidia' ? NVIDIA_VISUAL_MODELS.map((model) => model.id) : []),
        ]);

        const explicitInvalid = Boolean(firstFailure?.definitiveDead || secondFailure?.definitiveDead);
        states.set(id, {
            id,
            credential,
            provider: credential.provider,
            envName: credential.name,
            masked: credential.masked,
            firstCatalog: firstCatalog ? { ok: Boolean(firstCatalog.ok), status: Number(firstCatalog.status || 0), error: clean(firstCatalog.error), models: Number(firstCatalog.models?.length || 0) } : null,
            secondCatalog: secondCatalog ? { ok: Boolean(secondCatalog.ok), status: Number(secondCatalog.status || 0), error: clean(secondCatalog.error), models: Number(secondCatalog.models?.length || 0) } : null,
            explicitInvalid,
            textModels,
            imageModels,
            attempts: [],
            recoveredModes: [],
        });
    }

    const textTasks = [];
    const imageTasks = [];
    for (const state of states.values()) {
        if (state.explicitInvalid) continue;
        for (const model of state.textModels) textTasks.push({ state, model });
        for (const model of state.imageModels) imageTasks.push({ state, model });
    }

    let completed = 0;
    const totalTasks = textTasks.length + imageTasks.length;
    const startedAt = Date.now();
    const progress = async (state, model, capability, ok) => {
        completed += 1;
        const elapsedMs = Date.now() - startedAt;
        const etaSeconds = completed ? Math.max(0, Math.round((elapsedMs / completed) * (totalTasks - completed) / 1000)) : null;
        await onProgress?.({
            stage: 'key-full-second-sweep-model-complete', completed, total: totalTasks,
            provider: state.provider, envName: state.envName, masked: state.masked,
            model, capability, ok, etaSeconds,
        });
    };

    await runConcurrentByKey(textTasks, async ({ state, model }) => {
        await onProgress?.({
            stage: 'key-full-second-sweep-model-start', completed, total: totalTasks,
            provider: state.provider, envName: state.envName, masked: state.masked,
            model, capability: 'text',
        });
        const [nonStreamProbe, streamProbe] = await Promise.all([
            probeTextTransportSecondRound({
                fetchImpl, credential: state.credential, model, prompt: DEFAULT_TEXT_PROMPT,
                timeoutMs, transport: 'non_stream', reasoningLevel: '',
            }),
            probeTextTransportSecondRound({
                fetchImpl, credential: state.credential, model, prompt: DEFAULT_TEXT_PROMPT,
                timeoutMs, transport: 'stream', reasoningLevel: '',
            }),
        ]);
        const nonStream = transportRow(nonStreamProbe, 'non_stream');
        const stream = transportRow(streamProbe, 'stream');
        const policy = chooseTransportPolicy(nonStream, stream);
        state.attempts.push(
            compactConfirmationAttempt({ capability: 'text', model, ...nonStream }),
            compactConfirmationAttempt({ capability: 'text', model, ...stream }),
        );
        if (policy.keep) {
            state.recoveredModes.push({
                provider: state.provider,
                envName: state.envName,
                masked: state.masked,
                model,
                capability: 'text',
                endpoint: policy.preferredTransport === 'stream' ? stream.endpoint : nonStream.endpoint,
                preferredTransport: policy.preferredTransport,
                fallbackTransport: policy.fallbackTransport,
                fallbackEndpoint: policy.fallbackTransport.startsWith('stream') ? stream.endpoint : policy.fallbackTransport ? nonStream.endpoint : '',
                nonStreamOk: Boolean(nonStream.ok),
                streamOk: Boolean(stream.ok),
                reasoningModes: [],
                reasoningPolicies: {},
                testedAt: Math.floor(Date.now() / 1000),
                recoveredBy: 'v144-final-full-key-sweep',
            });
        }
        await progress(state, model, 'text', policy.keep);
        return policy.keep;
    }, {
        globalLimit: concurrency.modelConcurrency,
        perKeyLimit: concurrency.perKeyModelConcurrency,
        keyFn: ({ state }) => state.id,
    });

    await runConcurrentByKey(imageTasks, async ({ state, model }) => {
        await onProgress?.({
            stage: 'key-full-second-sweep-model-start', completed, total: totalTasks,
            provider: state.provider, envName: state.envName, masked: state.masked,
            model, capability: 'image',
        });
        const [nativeProbe, streamProbe] = await Promise.all([
            probeProviderVisualModel({ credential: state.credential, model, prompt: DEFAULT_IMAGE_PROMPT, fetchImpl }),
            probeImageStream({
                fetchImpl,
                credential: state.credential,
                model,
                prompt: DEFAULT_IMAGE_PROMPT,
                timeoutMs: DEFAULT_IMAGE_STREAM_TIMEOUT_MS,
                nvidiaVisualBaseUrl: clean(env.NVIDIA_IMAGE_BASE_URL),
            }),
        ]);
        const nonStream = {
            transport: 'non_stream', ok: Boolean(nativeProbe.ok), status: Number(nativeProbe.status || 0),
            elapsedMs: Number(nativeProbe.elapsedMs || 0), firstByteMs: 0,
            endpoint: 'provider-image-adapter', observedTransport: 'non_stream',
            error: nativeProbe.ok ? '' : clean(nativeProbe.error),
        };
        const stream = transportRow(streamProbe, 'stream');
        const policy = chooseTransportPolicy(nonStream, stream);
        state.attempts.push(
            compactConfirmationAttempt({ capability: 'image', model, ...nonStream }),
            compactConfirmationAttempt({ capability: 'image', model, ...stream }),
        );
        if (policy.keep) {
            state.recoveredModes.push({
                provider: state.provider,
                envName: state.envName,
                masked: state.masked,
                model,
                capability: 'image',
                endpoint: policy.preferredTransport === 'stream' ? stream.endpoint : nonStream.endpoint,
                preferredTransport: policy.preferredTransport,
                fallbackTransport: policy.fallbackTransport,
                fallbackEndpoint: policy.fallbackTransport.startsWith('stream') ? stream.endpoint : policy.fallbackTransport ? nonStream.endpoint : '',
                nonStreamOk: Boolean(nonStream.ok),
                streamOk: Boolean(stream.ok),
                reasoningModes: [],
                reasoningPolicies: {},
                testedAt: Math.floor(Date.now() / 1000),
                recoveredBy: 'v144-final-full-key-sweep',
            });
        }
        await progress(state, model, 'image', policy.keep);
        return policy.keep;
    }, {
        globalLimit: concurrency.imageConcurrency,
        perKeyLimit: concurrency.perKeyImageConcurrency,
        keyFn: ({ state }) => state.id,
    });

    const results = [...states.values()].map((state) => {
        const modelCount = state.textModels.length + state.imageModels.length;
        const providerReached = providerReachedByModelAttempt(state.attempts);
        let verdict = 'uncertain';
        let reason = 'Только network/5xx/timeout: ключ сохранён, чтобы не удалить его из-за временного сбоя provider.';
        if (state.explicitInvalid) {
            verdict = 'dead-confirmed';
            reason = 'Provider явно подтвердил invalid credential; полный model sweep бессмысленен.';
        } else if (state.recoveredModes.length) {
            verdict = 'working-recovered';
            reason = `Во втором полном обходе подтверждено рабочих runtime-mode: ${state.recoveredModes.length}.`;
        } else if (!modelCount && (state.secondCatalog?.ok || state.firstCatalog?.ok)) {
            verdict = 'dead-confirmed';
            reason = 'Ключ авторизуется, но provider не даёт ни одной text/image модели, пригодной для этого бота.';
        } else if (providerReached) {
            verdict = 'dead-confirmed';
            reason = 'Все известные text/image модели повторно проверены; ни одна не дала рабочего ответа, provider при этом отвечал на model probes.';
        }
        return {
            provider: state.provider,
            envName: state.envName,
            masked: state.masked,
            verdict,
            reason,
            firstCatalog: state.firstCatalog,
            secondCatalog: state.secondCatalog,
            textModelsTested: state.textModels.length,
            imageModelsTested: state.imageModels.length,
            modelTransportAttempts: state.attempts.length,
            recoveredModes: state.recoveredModes,
            attempts: state.attempts,
        };
    });

    const recoveredModes = results.flatMap((row) => row.recoveredModes || []);
    const summary = {
        checkedAt: new Date().toISOString(),
        totalAuditableKeys: credentials.length,
        candidates: candidates.length,
        skippedAlreadyWorking: Math.max(0, credentials.length - candidates.length),
        catalogRetested: retestable.length,
        textModelsTested: results.reduce((sum, row) => sum + Number(row.textModelsTested || 0), 0),
        imageModelsTested: results.reduce((sum, row) => sum + Number(row.imageModelsTested || 0), 0),
        modelTransportAttempts: results.reduce((sum, row) => sum + Number(row.modelTransportAttempts || 0), 0),
        recoveredKeys: results.filter((row) => row.verdict === 'working-recovered').length,
        confirmedDeadKeys: results.filter((row) => row.verdict === 'dead-confirmed').length,
        uncertainKeys: results.filter((row) => row.verdict === 'uncertain').length,
        recoveredModes,
        results,
    };
    const path = resolve(outDir, 'key_second_full_sweep.json');
    await writeFile(path, JSON.stringify(summary, null, 2), 'utf8');
    return { ...summary, path };
}

export async function runFullAiAudit({
    env = process.env,
    directory = process.cwd(),
    fetchImpl = globalThis.fetch,
    timeoutMs = DEFAULT_TIMEOUT_MS,
    keyAuditRunner = runConfiguredAiKeyAudit,
    visualAuditRunner = runAllProviderVisualMatrixAudit,
    onProgress = null,
    now = new Date(),
    clearPrevious = true,
    includeExcluded = false,
} = {}) {
    const auditRoot = resolve(directory, 'AI_FULL_AUDIT_RESULTS');
    if (clearPrevious) await rm(auditRoot, { recursive: true, force: true });
    await mkdir(auditRoot, { recursive: true });
    const outDir = resolve(auditRoot, stampNow(now));
    await mkdir(outDir, { recursive: true });
    const resultsJsonlPath = resolve(outDir, 'results.jsonl');
    const statusPath = resolve(outDir, 'AUDIT_STATUS.json');
    const donePath = resolve(outDir, 'AUDIT_DONE.json');
    await writeFile(resultsJsonlPath, '', 'utf8');
    await writeFile(statusPath, JSON.stringify({ status: 'running', startedAt: now.toISOString(), outDir }, null, 2), 'utf8');

    const concurrency = auditConcurrencyConfig(env);
    let keyAudit = await keyAuditRunner({
        env,
        timeoutMs: Math.min(timeoutMs, 30_000),
        concurrency: concurrency.keyConcurrency,
        onProgress: (event) => onProgress?.({ stage: 'key', round: 1, ...event }),
        includeExcluded,
    });
    const uncertainKeyNames = (keyAudit.results || [])
        .filter((row) => !row.ok && classifyFailure({ status: row.status, error: row.error, provider: row.provider, endpoint: 'models/whoami' }).retryEligible)
        .map((row) => row.envName);
    let keySecondRound = { total: 0, recovered: 0, results: [] };
    if (uncertainKeyNames.length) {
        await onProgress?.({ stage: 'key-second-round-start', total: uncertainKeyNames.length });
        const retryAudit = await keyAuditRunner({
            env, onlyEnvNames: uncertainKeyNames,
            timeoutMs: Math.min(Math.max(timeoutMs, 30_000), 60_000),
            concurrency: Math.min(concurrency.keyConcurrency, 4),
            onProgress: (event) => onProgress?.({ stage: 'key', round: 2, ...event }),
            includeExcluded,
        });
        const retryByName = new Map((retryAudit.results || []).map((row) => [row.envName, row]));
        const firstByName = new Map((keyAudit.results || []).map((row) => [row.envName, row]));
        for (const name of uncertainKeyNames) {
            const retry = retryByName.get(name);
            const first = firstByName.get(name);
            if (retry) firstByName.set(name, retry.ok ? { ...retry, firstRound: first, recoveredSecondRound: true } : { ...first, secondRound: retry });
        }
        const mergedResults = (keyAudit.results || []).map((row) => firstByName.get(row.envName) || row);
        keySecondRound = {
            total: uncertainKeyNames.length,
            recovered: mergedResults.filter((row) => row.recoveredSecondRound).length,
            results: (retryAudit.results || []),
        };
        keyAudit = {
            ...keyAudit,
            results: mergedResults,
            valid: mergedResults.filter((row) => row.ok).length,
            invalid: mergedResults.filter((row) => !row.ok).length,
            secondRound: keySecondRound,
        };
    } else {
        keyAudit = { ...keyAudit, secondRound: keySecondRound };
    }
    const credentials = includeExcluded ? collectConfiguredAiCredentials(env) : collectAuditableAiCredentials(env);
    const credentialById = new Map(credentials.map((row) => [`${row.provider}:${row.name}`, row]));
    const textPlan = buildTextPlan({ keyAudit, credentials, env });
    let jsonlWriteChain = Promise.resolve();
    let statusWriteChain = Promise.resolve();
    const appendResult = (row) => {
        jsonlWriteChain = jsonlWriteChain.then(() => appendFile(resultsJsonlPath, `${JSON.stringify(row)}\n`, 'utf8'));
        return jsonlWriteChain;
    };
    const writeStatus = (payload) => {
        statusWriteChain = statusWriteChain.then(() => writeFile(statusPath, JSON.stringify(payload, null, 2), 'utf8'));
        return statusWriteChain;
    };

    const textStageStartedAt = Date.now();
    let textCompleted = 0;
    const textResults = await runConcurrentByKey(textPlan, async ({ credential, model }, index) => {
        await onProgress?.({
            stage: 'text-model-start', index: index + 1, total: textPlan.length,
            provider: credential.provider, envName: credential.name, masked: credential.masked,
            model: model.id, modelConcurrency: concurrency.modelConcurrency,
            perKeyModelConcurrency: concurrency.perKeyModelConcurrency,
        });

        /* Baseline stream + non-stream are deliberately sent at the same time. */
        const [nonStreamProbe, streamProbe] = await Promise.all([
            probeTextTransport({ fetchImpl, credential, model: model.id, prompt: DEFAULT_TEXT_PROMPT, timeoutMs, transport: 'non_stream' }),
            probeTextTransport({ fetchImpl, credential, model: model.id, prompt: DEFAULT_TEXT_PROMPT, timeoutMs, transport: 'stream' }),
        ]);
        const nonStream = transportRow(nonStreamProbe, 'non_stream');
        const stream = transportRow(streamProbe, 'stream');
        for (const transportRowValue of [nonStream, stream]) {
            await appendResult({ capability: 'text', provider: credential.provider, envName: credential.name, masked: credential.masked, model: model.id, ...transportRowValue });
            await onProgress?.({
                stage: 'text-transport-complete', index: index + 1, total: textPlan.length,
                provider: credential.provider, envName: credential.name, masked: credential.masked,
                model: model.id, ...transportRowValue,
            });
        }

        const policy = chooseTransportPolicy(nonStream, stream);
        const reasoningResults = await probeReasoningMatrix({
            fetchImpl,
            credential,
            model: model.id,
            prompt: DEFAULT_TEXT_PROMPT,
            timeoutMs,
            baselineNonStream: nonStream,
            baselineStream: stream,
            reasoningConcurrency: concurrency.reasoningConcurrency,
            onProgress,
        });
        for (const reasoning of reasoningResults) {
            if (reasoning.level === 'default') continue;
            for (const transport of ['non_stream', 'stream']) {
                await appendResult({
                    capability: 'text-reasoning', provider: credential.provider,
                    envName: credential.name, masked: credential.masked, model: model.id,
                    reasoningLevel: reasoning.level, ...reasoning.transports[transport],
                });
            }
        }
        const reasoningModesSupported = reasoningResults.filter((item) => item.keep).map((item) => item.level);
        const row = {
            capability: 'text',
            provider: credential.provider,
            envName: credential.name,
            masked: credential.masked,
            model: model.id,
            transports: { non_stream: nonStream, stream },
            ...policy,
            preferredEndpoint: policy.preferredTransport === 'stream' ? stream.endpoint : nonStream.endpoint,
            fallbackEndpoint: policy.fallbackTransport.startsWith('stream') ? stream.endpoint : policy.fallbackTransport ? nonStream.endpoint : '',
            reasoningResults,
            reasoningModesSupported,
            reasoningPolicies: reasoningPoliciesFromResults(reasoningResults),
        };
        textCompleted += 1;
        const elapsedMs = Date.now() - textStageStartedAt;
        const etaSeconds = textCompleted > 0
            ? Math.max(0, Math.round((elapsedMs / textCompleted) * (textPlan.length - textCompleted) / 1000))
            : null;
        await onProgress?.({
            stage: 'text-model-complete', index: index + 1, completed: textCompleted,
            total: textPlan.length, etaSeconds, ...row,
        });
        await writeStatus({
            status: 'running', stage: 'text', completed: textCompleted, total: textPlan.length,
            activeLimit: concurrency.modelConcurrency, perKeyLimit: concurrency.perKeyModelConcurrency,
            etaSeconds, outDir, updatedAt: new Date().toISOString(),
        });
        return row;
    }, {
        globalLimit: concurrency.modelConcurrency,
        perKeyLimit: concurrency.perKeyModelConcurrency,
        keyFn: ({ credential }) => `${credential.provider}:${credential.name}`,
        onState: (state) => onProgress?.({ stage: 'text-pool-state', ...state, globalLimit: concurrency.modelConcurrency, perKeyLimit: concurrency.perKeyModelConcurrency }),
    });
    await jsonlWriteChain;
    await statusWriteChain;

    const textSecondRound = await runTextSecondRound({
        textResults, credentialById, fetchImpl, timeoutMs, concurrency, onProgress,
        appendResult, writeStatus, outDir,
    });
    await jsonlWriteChain;
    await statusWriteChain;

    const textThirdRound = await runTextTargetedThirdRound({
        textResults, credentialById, fetchImpl, timeoutMs, concurrency, env, onProgress,
        appendResult, writeStatus, outDir,
    });
    await jsonlWriteChain;
    await statusWriteChain;

    const visualAudit = await visualAuditRunner({
        env,
        prompt: DEFAULT_IMAGE_PROMPT,
        directory: outDir,
        retainBuffers: false,
        keyAudit,
        credentials,
        concurrency: concurrency.imageConcurrency,
        perKeyConcurrency: concurrency.perKeyImageConcurrency,
        onProgress: (event) => onProgress?.({ stage: `image-native-${event.stage}`, ...event }),
        fetchImpl,
    });
    const nativeImageResults = (visualAudit.results || []).map(sanitizeVisualResult);
    let imageCompleted = 0;
    const imageStageStartedAt = Date.now();
    const imageResults = await runConcurrentByKey(nativeImageResults, async (native, index) => {
        const credential = credentialById.get(`${native.provider}:${native.envName}`);
        const nonStream = {
            transport: 'non_stream',
            ok: native.ok,
            status: native.status,
            elapsedMs: native.elapsedMs,
            firstByteMs: native.firstByteMs,
            endpoint: native.endpoint,
            observedTransport: 'non_stream',
            error: native.error,
            imagePath: native.imagePath,
            imageBytes: native.imageBytes,
            mimeType: native.mimeType,
            attempts: [],
        };
        let stream = { transport: 'stream', ok: false, status: 0, elapsedMs: 0, firstByteMs: 0, endpoint: 'unsupported', observedTransport: 'none', error: 'credential unavailable', attempts: [] };
        if (credential) {
            await onProgress?.({
                stage: 'image-stream-start', index: index + 1, total: nativeImageResults.length,
                provider: native.provider, envName: native.envName, masked: native.masked,
                model: native.model, imageConcurrency: concurrency.imageConcurrency,
                perKeyImageConcurrency: concurrency.perKeyImageConcurrency,
            });
            const streamProbe = await probeImageStream({
                fetchImpl,
                credential,
                model: native.model,
                prompt: DEFAULT_IMAGE_PROMPT,
                timeoutMs: DEFAULT_IMAGE_STREAM_TIMEOUT_MS,
                nvidiaVisualBaseUrl: clean(env.NVIDIA_IMAGE_BASE_URL),
            });
            let imagePath = '';
            if (streamProbe.ok && streamProbe.image?.buffer?.length) {
                const safeName = `${String(index + 1).padStart(4, '0')}__${native.provider.replace(/[^a-z0-9._-]+/giu, '_')}__${native.envName.replace(/[^a-z0-9._-]+/giu, '_')}__${native.model.replace(/[^a-z0-9._-]+/giu, '_')}__stream.png`;
                imagePath = resolve(visualAudit.outDir, safeName);
                await writeFile(imagePath, streamProbe.image.buffer);
            }
            stream = {
                transport: 'stream',
                ok: Boolean(streamProbe.ok),
                status: Number(streamProbe.status || 0),
                elapsedMs: Number(streamProbe.elapsedMs || 0),
                firstByteMs: Number(streamProbe.firstByteMs || 0),
                endpoint: clean(streamProbe.endpoint),
                observedTransport: clean(streamProbe.observedTransport),
                error: streamProbe.ok ? '' : clean(streamProbe.error),
                imagePath,
                imageBytes: Number(streamProbe.image?.buffer?.length || 0),
                mimeType: clean(streamProbe.image?.mimeType),
                attempts: streamProbe.attempts || [],
            };
            await onProgress?.({
                stage: 'image-stream-complete', index: index + 1, total: nativeImageResults.length,
                provider: native.provider, envName: native.envName, masked: native.masked,
                model: native.model, ...stream,
            });
        }
        const policy = chooseTransportPolicy(nonStream, stream);
        const row = {
            capability: 'image',
            provider: native.provider,
            envName: native.envName,
            masked: native.masked,
            model: native.model,
            transports: { non_stream: nonStream, stream },
            ...policy,
            preferredEndpoint: policy.preferredTransport === 'stream' ? stream.endpoint : nonStream.endpoint,
            fallbackEndpoint: policy.fallbackTransport.startsWith('stream') ? stream.endpoint : policy.fallbackTransport ? nonStream.endpoint : '',
            reasoningResults: [],
            reasoningModesSupported: [],
            reasoningPolicies: {},
        };
        imageCompleted += 1;
        const elapsedMs = Date.now() - imageStageStartedAt;
        const etaSeconds = imageCompleted > 0
            ? Math.max(0, Math.round((elapsedMs / imageCompleted) * (nativeImageResults.length - imageCompleted) / 1000))
            : null;
        await appendResult(row);
        await writeStatus({
            status: 'running', stage: 'image-stream', completed: imageCompleted,
            total: nativeImageResults.length, activeLimit: concurrency.imageConcurrency,
            perKeyLimit: concurrency.perKeyImageConcurrency, etaSeconds, outDir,
            updatedAt: new Date().toISOString(),
        });
        return row;
    }, {
        globalLimit: concurrency.imageConcurrency,
        perKeyLimit: concurrency.perKeyImageConcurrency,
        keyFn: (native) => `${native.provider}:${native.envName}`,
        onState: (state) => onProgress?.({ stage: 'image-pool-state', ...state, globalLimit: concurrency.imageConcurrency, perKeyLimit: concurrency.perKeyImageConcurrency }),
    });
    await jsonlWriteChain;
    await statusWriteChain;

    const imageSecondRound = await runImageSecondRound({
        imageResults, credentialById, fetchImpl, env, concurrency, onProgress,
        appendResult, writeStatus, outDir, visualOutDir: visualAudit.outDir,
    });
    await jsonlWriteChain;
    await statusWriteChain;

    const keySecondSweep = await runSecondFullKeySweep({
        keyAudit,
        credentials,
        textResults,
        imageResults,
        env,
        fetchImpl,
        timeoutMs,
        keyAuditRunner,
        concurrency,
        onProgress,
        outDir,
        includeExcluded,
    });

    const firstPassWorkingModes = [...textResults, ...imageResults]
        .filter((row) => row.keep)
        .map((row) => ({
            provider: row.provider,
            envName: row.envName,
            masked: row.masked,
            model: row.model,
            capability: row.capability,
            endpoint: row.preferredEndpoint,
            preferredTransport: row.preferredTransport,
            fallbackTransport: row.fallbackTransport,
            fallbackEndpoint: row.fallbackEndpoint,
            nonStreamOk: Boolean(row.transports.non_stream.ok),
            streamOk: Boolean(row.transports.stream.ok),
            reasoningModes: row.reasoningModesSupported,
            reasoningPolicies: row.reasoningPolicies || {},
            testedAt: Math.floor(now.getTime() / 1000),
        }));
    const workingModes = dedupeRuntimeModes([
        ...firstPassWorkingModes,
        ...(keySecondSweep.recoveredModes || []),
    ]);

    const failures = [];
    for (const row of textResults) {
        for (const transport of ['non_stream', 'stream']) {
            const attempt = row.transports[transport];
            if (!attempt.ok) failures.push({ capability: 'text', provider: row.provider, envName: row.envName, masked: row.masked, model: row.model, transport, ...attempt });
        }
        for (const reasoning of row.reasoningResults || []) {
            if (reasoning.level === 'default') continue;
            for (const transport of ['non_stream', 'stream']) {
                const attempt = reasoning.transports?.[transport];
                if (attempt && !attempt.ok) failures.push({
                    capability: 'text-reasoning', provider: row.provider, envName: row.envName,
                    masked: row.masked, model: row.model, transport,
                    endpoint: attempt.endpoint, reasoningLevel: reasoning.level,
                    status: attempt.status, error: attempt.error,
                });
            }
        }
    }
    for (const row of imageResults) {
        for (const transport of ['non_stream', 'stream']) {
            const attempt = row.transports[transport];
            if (!attempt.ok) failures.push({ capability: 'image', provider: row.provider, envName: row.envName, masked: row.masked, model: row.model, transport, ...attempt });
        }
    }
    failures.push(...(keyAudit.results || []).filter((row) => !row.ok).map((row) => ({
        capability: 'key/catalog', provider: row.provider, envName: row.envName, masked: row.masked,
        model: '', transport: '', endpoint: 'models/whoami', status: row.status, error: row.error,
    })));
    const recoveredModeSignatures = new Set((keySecondSweep.recoveredModes || []).map(runtimeModeSignature));
    const recoveredKeyIds = new Set((keySecondSweep.results || [])
        .filter((row) => row.verdict === 'working-recovered')
        .map((row) => auditKeyId(row.provider, row.envName)));
    const remainingFailures = failures.filter((row) => {
        const keyId = auditKeyId(row.provider, row.envName);
        if (row.capability === 'key/catalog' && recoveredKeyIds.has(keyId)) return false;
        if (row.capability === 'text' && recoveredModeSignatures.has(runtimeModeSignature({ ...row, capability: 'text' }))) return false;
        if (row.capability === 'image' && recoveredModeSignatures.has(runtimeModeSignature({ ...row, capability: 'image' }))) return false;
        return true;
    });
    const retryCandidates = remainingFailures.map(buildRetryCandidate);
    const catalogModels = (keyAudit.results || []).reduce((sum, row) => sum + Number(row.models?.length || 0), 0);
    const transportStates = CounterFromRows([...textResults, ...imageResults].map((row) => row.transportState));
    const reasoningRows = textResults.flatMap((row) => (row.reasoningResults || []).filter((item) => item.level !== 'default'));
    const reasoningTransportRows = reasoningRows.flatMap((row) => ['non_stream', 'stream'].map((transport) => row.transports?.[transport]).filter(Boolean));
    const report = {
        checkedAt: now.toISOString(),
        outDir,
        keyAudit,
        secondRound: { keys: keySecondRound, text: textSecondRound, targetedText: textThirdRound, image: imageSecondRound },
        keySecondSweep,
        textResults,
        imageResults,
        workingModes,
        retryCandidates,
        concurrency,
        visualAudit: {
            outDir: visualAudit.outDir,
            summaryPath: visualAudit.summaryPath,
            jsonlPath: visualAudit.jsonlPath,
            attempts: visualAudit.attempts,
        },
        stats: {
            catalogModels,
            textModels: textResults.length,
            textTransportAttempts: textResults.length * 2,
            textModelsKept: textResults.filter((row) => row.keep).length,
            secondRoundTextAttempts: textSecondRound.attempts,
            secondRoundTextRecovered: textSecondRound.recovered,
            targetedThirdRoundTextModels: textThirdRound.models,
            targetedThirdRoundTextAttempts: textThirdRound.attempts,
            targetedThirdRoundTextRecovered: textThirdRound.recoveredModels,
            secondRoundKeyAttempts: keySecondRound.total,
            secondRoundKeysRecovered: keySecondRound.recovered,
            secondRoundImageAttempts: imageSecondRound.attempts,
            secondRoundImageRecovered: imageSecondRound.recovered,
            fullSecondSweepCandidates: keySecondSweep.candidates,
            fullSecondSweepCatalogRetested: keySecondSweep.catalogRetested,
            fullSecondSweepTextModels: keySecondSweep.textModelsTested,
            fullSecondSweepImageModels: keySecondSweep.imageModelsTested,
            fullSecondSweepTransportAttempts: keySecondSweep.modelTransportAttempts,
            fullSecondSweepRecoveredKeys: keySecondSweep.recoveredKeys,
            fullSecondSweepConfirmedDeadKeys: keySecondSweep.confirmedDeadKeys,
            fullSecondSweepUncertainKeys: keySecondSweep.uncertainKeys,
            fullSecondSweepRecoveredModes: keySecondSweep.recoveredModes.length,
            reasoningAttempts: reasoningTransportRows.length,
            reasoningModesOk: reasoningRows.filter((row) => row.keep).length,
            reasoningTransportOk: reasoningTransportRows.filter((row) => row.ok).length,
            imageModels: imageResults.length,
            imageTransportAttempts: imageResults.length * 2,
            imageModelsKept: imageResults.filter((row) => row.keep).length,
            transportStates,
            // compatibility with V118 summaries/tests
            textAttempts: textResults.length,
            textOk: textResults.filter((row) => row.keep).length,
            textFailed: textResults.filter((row) => !row.keep).length,
            imageAttempts: imageResults.length,
            imageOk: imageResults.filter((row) => row.keep).length,
            imageFailed: imageResults.filter((row) => !row.keep).length,
        },
    };

    const textPath = resolve(outDir, 'report.txt');
    const jsonPath = resolve(outDir, 'report.json');
    const retryPath = resolve(outDir, 'retry_candidates.json');
    await writeFile(textPath, formatReport(report), 'utf8');
    await writeFile(jsonPath, JSON.stringify(report, null, 2), 'utf8');
    await writeFile(retryPath, JSON.stringify(retryCandidates, null, 2), 'utf8');
    const finishedAt = new Date();
    const done = {
        status: 'completed',
        startedAt: now.toISOString(),
        finishedAt: finishedAt.toISOString(),
        durationSec: Math.max(0, Math.round((finishedAt.getTime() - now.getTime()) / 1000)),
        keysTotal: keyAudit.total,
        catalogModels,
        workingRuntimeModes: workingModes.length,
        textModelsKept: report.stats.textModelsKept,
        imageModelsKept: report.stats.imageModelsKept,
        retryCandidates: retryCandidates.length,
        secondRound: {
            keyAttempts: keySecondRound.total, keyRecovered: keySecondRound.recovered,
            textAttempts: textSecondRound.attempts, textRecovered: textSecondRound.recovered,
            targetedTextModels: textThirdRound.models, targetedTextAttempts: textThirdRound.attempts, targetedTextRecovered: textThirdRound.recoveredModels,
            imageAttempts: imageSecondRound.attempts, imageRecovered: imageSecondRound.recovered,
        },
        keySecondSweep: {
            candidates: keySecondSweep.candidates,
            catalogRetested: keySecondSweep.catalogRetested,
            textModelsTested: keySecondSweep.textModelsTested,
            imageModelsTested: keySecondSweep.imageModelsTested,
            transportAttempts: keySecondSweep.modelTransportAttempts,
            recoveredKeys: keySecondSweep.recoveredKeys,
            confirmedDeadKeys: keySecondSweep.confirmedDeadKeys,
            uncertainKeys: keySecondSweep.uncertainKeys,
            recoveredModes: keySecondSweep.recoveredModes.length,
            reportPath: keySecondSweep.path,
        },
        concurrency,
        outDir,
    };
    await writeFile(statusPath, JSON.stringify(done, null, 2), 'utf8');
    await writeFile(donePath, JSON.stringify(done, null, 2), 'utf8');

    return { ...report, textPath, jsonPath, retryPath, resultsJsonlPath, statusPath, donePath };
}

function CounterFromRows(values) {
    const result = {};
    for (const value of values) {
        const key = clean(value) || 'unknown';
        result[key] = Number(result[key] || 0) + 1;
    }
    return result;
}


export function classifyAiAuditFailure(row = {}) {
    return classifyFailure(row);
}


export async function probeAiFastTextTransport({
    fetchImpl = globalThis.fetch,
    credential,
    model,
    transport = 'non_stream',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    reasoningLevel = '',
} = {}) {
    const probe = await probeTextTransport({
        fetchImpl, credential, model, prompt: DEFAULT_TEXT_PROMPT, timeoutMs, transport, reasoningLevel,
    });
    return transportRow(probe, transport);
}

export async function probeAiRecoveryTextTransport({
    fetchImpl = globalThis.fetch,
    credential,
    model,
    transport = 'non_stream',
    timeoutMs = DEFAULT_TIMEOUT_MS,
    reasoningLevel = '',
} = {}) {
    const probe = await probeTextTransportSecondRound({
        fetchImpl, credential, model, prompt: DEFAULT_TEXT_PROMPT, timeoutMs, transport, reasoningLevel,
    });
    return transportRow(probe, transport);
}

export async function probeAiRecoveryImageTransport({
    fetchImpl = globalThis.fetch,
    credential,
    model,
    transport = 'non_stream',
    timeoutMs = DEFAULT_IMAGE_STREAM_TIMEOUT_MS,
    nvidiaVisualBaseUrl = '',
} = {}) {
    if (transport === 'stream') {
        const probe = await probeImageStream({
            fetchImpl, credential, model, prompt: DEFAULT_IMAGE_PROMPT, timeoutMs, nvidiaVisualBaseUrl,
        });
        return transportRow(probe, 'stream');
    }
    const probe = await probeProviderVisualModel({
        credential, model, prompt: DEFAULT_IMAGE_PROMPT, fetchImpl,
    });
    return {
        transport: 'non_stream',
        ok: Boolean(probe.ok),
        status: Number(probe.status || 0),
        elapsedMs: Number(probe.elapsedMs || 0),
        firstByteMs: 0,
        endpoint: 'provider-image-adapter',
        observedTransport: 'non_stream',
        error: probe.ok ? '' : clean(probe.error),
    };
}

export const FULL_AI_AUDIT_DEFAULTS = Object.freeze({
    textPrompt: DEFAULT_TEXT_PROMPT,
    imagePrompt: DEFAULT_IMAGE_PROMPT,
    reasoningLevels: REASONING_LEVELS,
    textTransports: Object.freeze(['non_stream', 'stream']),
    concurrency: Object.freeze({
        key: 8,
        model: DEFAULT_MODEL_CONCURRENCY,
        perKeyModel: DEFAULT_PER_KEY_MODEL_CONCURRENCY,
        reasoningLevels: DEFAULT_REASONING_CONCURRENCY,
        image: DEFAULT_IMAGE_CONCURRENCY,
        perKeyImage: 1,
    }),
});

export const __FULL_AI_AUDIT_TESTING__ = Object.freeze({
    chooseTransportPolicy,
    probeTextTransport,
    transportRow,
    classifyFailure,
    reasoningLevelsForModel,
    isExpectedAuditText,
    auditTextAssessment,
    probeTextTransportSecondRound,
});
