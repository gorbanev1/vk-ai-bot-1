import { withGigoraveIdentityUserPrompt } from './gigoraveIdentity.js';
import { collectConfiguredAiCredentials } from './providerKeyAudit.js';
import { executeRuntimeModelFailover } from './modelProviderFailover.js';
import { probeProviderVisualModel } from './allProviderVisualMatrixAudit.js';
import { recordAiTokenUsage } from './tokenUsageLogger.js';

function clean(value) { return String(value ?? '').trim(); }

function unavailableHealthFresh(row, env = process.env) {
    if (!row || row.status !== 'unavailable') return false;
    const parsed = Number.parseInt(String(env.AI_HEALTH_UNAVAILABLE_TTL_SECONDS ?? '900'), 10);
    const ttl = Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(86_400, parsed) : 900;
    const checkedAt = Number(row.checkedAt || 0);
    return checkedAt > 0 && (Math.floor(Date.now() / 1000) - checkedAt) < ttl;
}

export function normalizeExternalProvider(value) {
    const v = clean(value).toLowerCase();
    if (/^(?:openai-pool|openai_pool|openai-keys|опенаи-пул)$/u.test(v)) return 'openai';
    if (/^(?:gemini|гемини|google)$/u.test(v)) return 'gemini';
    if (/^(?:claude|клод|anthropic|антропик)$/u.test(v)) return 'anthropic';
    if (/^(?:xai|grok|грок)$/u.test(v)) return 'xai';
    if (/^(?:groq|грокью)$/u.test(v)) return 'groq';
    if (/^(?:huggingface|hugging-face|hf|хаггингфейс)$/u.test(v)) return 'huggingface';
    return '';
}

export function parseExternalProviderCommand(value) {
    const text = clean(value);
    const match = text.match(/^(openai-pool|openai_pool|openai-keys|опенаи-пул|gemini|гемини|google|claude|клод|anthropic|антропик|xai|grok|грок|groq|грокью|huggingface|hugging-face|hf|хаггингфейс)(?:\s+|$)([\s\S]*)$/iu);
    if (!match) return { matched: false };
    const provider = normalizeExternalProvider(match[1]);
    const tail = clean(match[2]);
    if (!tail || /^(?:помощь|help|команды)$/iu.test(tail)) return { matched: true, provider, action: 'help' };
    if (/^(?:модели|models|список)$/iu.test(tail)) return { matched: true, provider, action: 'models' };
    if (/^(?:проверить|проверка|тест|status|статус)$/iu.test(tail)) return { matched: true, provider, action: 'status' };
    if (provider === 'xai') {
        const imageThrough = tail.match(/^(?:нарисуй|рисуй|image|img|картин(?:ка|ку)|изображени(?:е|я)|сгенерируй\s+(?:картинку|изображение))\s+через\s+(\S+)\s+([\s\S]+)$/iu);
        if (imageThrough) return { matched: true, provider, action: 'image_generate', model: clean(imageThrough[1]), prompt: clean(imageThrough[2]) };
        const image = tail.match(/^(?:нарисуй|рисуй|image|img|картин(?:ка|ку)|изображени(?:е|я)|сгенерируй\s+(?:картинку|изображение))(?:\s+([\s\S]+))?$/iu);
        if (image) return { matched: true, provider, action: 'image_generate', model: 'auto', prompt: clean(image[1]) };
    }
    const through = tail.match(/^(?:через|model|модель)\s+(\S+)\s+([\s\S]+)$/iu);
    if (through) return { matched: true, provider, action: 'ask', model: clean(through[1]), prompt: clean(through[2]) };
    return { matched: true, provider, action: 'ask', model: 'auto', prompt: tail };
}

function providerCredentials(provider, env) {
    return collectConfiguredAiCredentials(env).filter((row) => row.provider === provider);
}

async function requestJson(url, options, timeoutMs = 30_000) {
    const startedAt = Date.now();
    let response;
    try {
        response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, error: String(error?.message || error), payload: null };
    }
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = null; }
    return { ok: response.ok, status: response.status, elapsedMs: Date.now() - startedAt, error: response.ok ? '' : clean(payload?.error?.message || payload?.message || raw).slice(0, 500), payload };
}

export async function listExternalProviderModels(provider, { env = process.env } = {}) {
    const credentials = providerCredentials(provider, env);
    const attempts = [];
    for (const credential of credentials) {
        let result;
        if (provider === 'gemini') {
            result = await requestJson(`https://generativelanguage.googleapis.com/v1beta/models?pageSize=1000&key=${encodeURIComponent(credential.secret)}`, { headers: { 'Content-Type': 'application/json' } });
            if (result.ok) {
                const models = (result.payload?.models || []).map((m) => ({ id: clean(m?.name).replace(/^models\//u, ''), description: clean(m?.description), methods: m?.supportedGenerationMethods || [] })).filter((m) => m.id);
                return { ok: true, provider, key: credential, models, attempts };
            }
        } else if (provider === 'anthropic') {
            result = await requestJson('https://api.anthropic.com/v1/models?limit=100', { headers: { 'x-api-key': credential.secret, 'anthropic-version': '2023-06-01' } });
            if (result.ok) {
                const models = (result.payload?.data || []).map((m) => ({ id: clean(m?.id), description: clean(m?.display_name), methods: ['messages'] })).filter((m) => m.id);
                return { ok: true, provider, key: credential, models, attempts };
            }
        } else if (provider === 'openai') {
            result = await requestJson('https://api.openai.com/v1/models', { headers: { Authorization: `Bearer ${credential.secret}` } });
            if (result.ok) {
                const models = (result.payload?.data || []).map((m) => ({ id: clean(m?.id), description: clean(m?.owned_by), methods: ['chat'] })).filter((m) => m.id);
                return { ok: true, provider, key: credential, models, attempts };
            }
        } else if (provider === 'xai') {
            result = await requestJson('https://api.x.ai/v1/models', { headers: { Authorization: `Bearer ${credential.secret}` } });
            if (result.ok) {
                const models = (result.payload?.data || []).map((m) => ({ id: clean(m?.id), description: clean(m?.owned_by), methods: ['chat'] })).filter((m) => m.id);
                return { ok: true, provider, key: credential, models, attempts };
            }
        } else if (provider === 'groq') {
            result = await requestJson('https://api.groq.com/openai/v1/models', { headers: { Authorization: `Bearer ${credential.secret}` } });
            if (result.ok) {
                const models = (result.payload?.data || []).map((m) => ({ id: clean(m?.id), description: clean(m?.owned_by), methods: ['chat'] })).filter((m) => m.id);
                return { ok: true, provider, key: credential, models, attempts };
            }
        } else if (provider === 'huggingface') {
            result = await requestJson('https://huggingface.co/api/whoami-v2', { headers: { Authorization: `Bearer ${credential.secret}` } });
            if (result.ok) return { ok: true, provider, key: credential, models: [], attempts, note: 'Hugging Face token valid; model access is repository/provider-specific.' };
        }
        attempts.push({ envName: credential.name, masked: credential.masked, status: result?.status || 0, error: result?.error || 'failed' });
    }
    return { ok: false, provider, models: [], attempts, error: credentials.length ? 'No working key in provider pool.' : 'No keys configured.' };
}

function scoreModel(provider, model) {
    const id = clean(model?.id).toLowerCase();
    let score = 0;
    const nums = [...id.matchAll(/\d+(?:\.\d+)?/gu)].map((m) => Number(m[0])).filter(Number.isFinite);
    if (nums.length) score += Math.max(...nums) * 100;
    if (provider === 'gemini') {
        if (!model?.methods?.includes('generateContent')) return -1e9;
        if (/pro/u.test(id)) score += 5000;
        if (/flash/u.test(id)) score += 1000;
        if (/image|imagen|embedding/u.test(id)) score -= 5000;
    } else if (provider === 'anthropic') {
        if (/opus/u.test(id)) score += 5000;
        else if (/sonnet/u.test(id)) score += 3000;
        else if (/haiku/u.test(id)) score += 1000;
    } else if (provider === 'openai') {
        if (/gpt-6(?:[-_.]astra)?/u.test(id)) score += 16000;
        else if (/gpt-5\.6-sol/u.test(id)) score += 10000;
        else if (/gpt-5\.6-terra/u.test(id)) score += 8000;
        else if (/gpt-5\.6-luna/u.test(id)) score += 7000;
        else if (/gpt-5\.4-mini/u.test(id)) score += 6000;
        if (/image|audio|realtime|embedding|moderation/u.test(id)) score -= 20000;
    } else if (provider === 'xai') {
        if (/grok-4\.6/u.test(id)) score += 12000;
        else if (/grok-4\.5/u.test(id)) score += 10000;
        else if (/grok-4\.3/u.test(id)) score += 9000;
        if (/image|imagine|voice|embedding/u.test(id)) score -= 20000;
    } else if (provider === 'groq') {
        if (/gpt-oss-120b/u.test(id)) score += 5000;
        if (/70b|120b/u.test(id)) score += 2500;
        if (/guard|safeguard|whisper|tts/u.test(id)) score -= 10000;
    }
    return score;
}

function selectModel(provider, models, requested) {
    const exact = clean(requested);
    if (exact && !/^(?:auto|авто)$/iu.test(exact)) {
        const found = models.find((m) => m.id === exact);
        if (!found) throw new Error(`Model ${exact} is not in the live catalog for ${provider}.`);
        return found;
    }
    return [...models].sort((a, b) => scoreModel(provider, b) - scoreModel(provider, a))[0] || null;
}

function runtimePolicyFor(runtimeModes, provider, envName, model) {
    return (Array.isArray(runtimeModes) ? runtimeModes : []).find((row) =>
        row?.capability === 'text' &&
        row?.provider === provider &&
        row?.envName === envName &&
        row?.model === model,
    ) || null;
}

function transportOrder(policy) {
    if (!policy) return ['non_stream'];
    if (policy.preferredTransport === 'stream') {
        return policy.fallbackTransport === 'non_stream_retry_once' || policy.fallbackTransport === 'non_stream'
            ? ['stream', 'non_stream']
            : ['stream'];
    }
    if (policy.preferredTransport === 'non_stream') {
        return policy.fallbackTransport === 'stream' ? ['non_stream', 'stream'] : ['non_stream'];
    }
    return ['non_stream'];
}

function mergeExternalStreamUsage(previous, payload, provider) {
    const existing = previous && typeof previous === 'object' ? previous : {};
    if (!payload || typeof payload !== 'object') return existing;

    if (provider === 'gemini') {
        return payload.usageMetadata && typeof payload.usageMetadata === 'object'
            ? { ...existing, ...payload.usageMetadata }
            : existing;
    }

    if (provider === 'anthropic') {
        const current = payload?.message?.usage || payload?.usage;
        if (!current || typeof current !== 'object') return existing;
        const numericKeys = [
            'input_tokens',
            'output_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
        ];
        const merged = { ...existing };
        for (const key of numericKeys) {
            const next = Number(current[key]);
            if (Number.isFinite(next) && next >= 0) {
                merged[key] = Math.max(Number(merged[key] || 0), next);
            }
        }
        return merged;
    }

    return payload.usage && typeof payload.usage === 'object'
        ? { ...existing, ...payload.usage }
        : existing;
}

async function requestSseText(url, options, provider, timeoutMs = 120_000) {
    const startedAt = Date.now();
    let response;
    try {
        response = await fetch(url, { ...options, signal: AbortSignal.timeout(timeoutMs) });
    } catch (error) {
        return { ok: false, status: 0, elapsedMs: Date.now() - startedAt, error: clean(error?.message || error), text: '' };
    }
    const contentType = clean(response.headers?.get?.('content-type')).toLowerCase();
    if (!response.ok) {
        const raw = await response.text();
        let payload = null; try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = null; }
        return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: clean(payload?.error?.message || payload?.message || raw).slice(0, 500), text: '' };
    }
    if (!contentType.includes('text/event-stream') && !contentType.includes('ndjson') && !contentType.includes('json-seq')) {
        return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: 'stream=true returned non-stream response', text: '' };
    }
    const reader = response.body?.getReader?.();
    if (!reader) return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: 'stream body unavailable', text: '' };
    const decoder = new TextDecoder();
    let pending = '';
    let text = '';
    let usage = null;
    const extract = (payload) => {
        if (provider === 'gemini') return (payload?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join('');
        if (provider === 'anthropic') return payload?.delta?.text || payload?.content_block?.text || '';
        const delta = payload?.choices?.[0]?.delta?.content;
        if (typeof delta === 'string') return delta;
        if (Array.isArray(delta)) return delta.map((p) => p?.text || '').join('');
        return '';
    };
    try {
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;
            pending += decoder.decode(value, { stream: true }).replace(/\r\n/gu, '\n');
            let pos;
            while ((pos = pending.indexOf('\n\n')) >= 0) {
                const block = pending.slice(0, pos); pending = pending.slice(pos + 2);
                for (const line of block.split('\n')) {
                    if (!line.startsWith('data:')) continue;
                    const raw = line.slice(5).trim();
                    if (!raw || raw === '[DONE]') continue;
                    try {
                        const payload = JSON.parse(raw);
                        text += extract(payload);
                        usage = mergeExternalStreamUsage(usage, payload, provider);
                    } catch { /* keepalive */ }
                }
            }
        }
    } catch (error) {
        return { ok: false, status: response.status, elapsedMs: Date.now() - startedAt, error: clean(error?.message || error), text: clean(text), usage };
    }
    return { ok: Boolean(clean(text)), status: response.status, elapsedMs: Date.now() - startedAt, error: clean(text) ? '' : 'stream completed without text', text: clean(text), usage };
}

async function callExternalModel(provider, credential, selected, prompt, transport) {
    const stream = transport === 'stream';
    const identityPrompt = withGigoraveIdentityUserPrompt(prompt);
    if (provider === 'gemini') {
        const method = stream ? 'streamGenerateContent' : 'generateContent';
        const suffix = stream ? '&alt=sse' : '';
        const url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(selected.id)}:${method}?key=${encodeURIComponent(credential.secret)}${suffix}`;
        const options = { method: 'POST', headers: { 'Content-Type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) }, body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: clean(identityPrompt) }] }] }) };
        if (stream) return requestSseText(url, options, provider, 120_000);
        const result = await requestJson(url, options, 120_000);
        return { ...result, text: result.ok ? (result.payload?.candidates?.[0]?.content?.parts || []).map((p) => p?.text || '').join('').trim() : '', usage: result.payload?.usageMetadata || null };
    }
    if (provider === 'anthropic') {
        const url = 'https://api.anthropic.com/v1/messages';
        const options = { method: 'POST', headers: { 'x-api-key': credential.secret, 'anthropic-version': '2023-06-01', 'content-type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) }, body: JSON.stringify({ model: selected.id, max_tokens: 1500, stream, messages: [{ role: 'user', content: clean(identityPrompt) }] }) };
        if (stream) return requestSseText(url, options, provider, 120_000);
        const result = await requestJson(url, options, 120_000);
        return { ...result, text: result.ok ? (result.payload?.content || []).map((p) => p?.text || '').join('').trim() : '', usage: result.payload?.usage || null };
    }
    if (provider === 'openai' || provider === 'groq' || provider === 'xai') {
        const url = provider === 'openai'
            ? 'https://api.openai.com/v1/chat/completions'
            : provider === 'xai'
                ? 'https://api.x.ai/v1/chat/completions'
                : 'https://api.groq.com/openai/v1/chat/completions';
        const options = { method: 'POST', headers: { Authorization: `Bearer ${credential.secret}`, 'content-type': 'application/json', ...(stream ? { Accept: 'text/event-stream' } : {}) }, body: JSON.stringify({ model: selected.id, messages: [{ role: 'user', content: clean(identityPrompt) }], stream, ...(provider === 'openai' || provider === 'xai' ? { max_completion_tokens: 1500 } : { max_tokens: 1500 }) }) };
        if (stream) return requestSseText(url, options, provider, 120_000);
        const result = await requestJson(url, options, 120_000);
        return { ...result, text: result.ok ? clean(result.payload?.choices?.[0]?.message?.content) : '', usage: result.payload?.usage || null };
    }
    return { ok: false, status: 0, elapsedMs: 0, error: 'unsupported provider transport', text: '' };
}


function imageHealthEligible({ provider, credential, model, healthRows, keyHealthRows, env }) {
    const keyRow = (Array.isArray(keyHealthRows) ? keyHealthRows : []).find((row) => row?.provider === provider && row?.envName === credential.name);
    if (keyRow && (keyRow.status === 'dead' || keyRow.status === 'no-working-models' || unavailableHealthFresh(keyRow, env))) return false;
    const modelRow = (Array.isArray(healthRows) ? healthRows : []).find((row) =>
        row?.provider === provider && row?.envName === credential.name && row?.model === model && row?.capability === 'image',
    );
    return !modelRow || (modelRow.status !== 'dead' && !unavailableHealthFresh(modelRow, env));
}

export async function runExternalProviderImage(provider, {
    prompt,
    model = 'auto',
    env = process.env,
    healthRows = [],
    keyHealthRows = [],
} = {}) {
    if (provider !== 'xai') throw new Error('Explicit external image route is currently supported for xAI/Grok only.');
    const cleanPrompt = clean(prompt);
    if (!cleanPrompt) throw new Error('После «грок нарисуй» нужно описание изображения.');

    const catalog = await listExternalProviderModels(provider, { env });
    if (!catalog.ok) throw new Error(catalog.error || 'No working xAI key.');
    const imageModels = catalog.models.filter((row) => /(?:grok-)?imagine|image/iu.test(row.id));
    const requested = clean(model);
    let selectedModel = '';
    if (requested && !/^(?:auto|авто)$/iu.test(requested)) {
        selectedModel = requested;
        if (catalog.models.length && !catalog.models.some((row) => row.id === requested)) {
            throw new Error(`Model ${requested} is not in the live xAI catalog.`);
        }
    } else {
        const configured = clean(env.XAI_IMAGE_MODEL);
        selectedModel = configured && catalog.models.some((row) => row.id === configured)
            ? configured
            : imageModels.find((row) => /grok-imagine-image-2\.0/iu.test(row.id))?.id
                || imageModels[0]?.id
                || configured
                || 'grok-imagine-image-2.0';
    }

    const credentials = providerCredentials(provider, env)
        .filter((credential) => imageHealthEligible({ provider, credential, model: selectedModel, healthRows, keyHealthRows, env }))
        .map((credential) => ({ ...credential, model: selectedModel, capability: 'image' }));
    if (!credentials.length) throw new Error(`No healthy xAI key/model combination for ${selectedModel}. Run «Гигорейв проверить рабочие модели».`);

    const attempts = [];
    const result = await executeRuntimeModelFailover({
        candidates: credentials,
        request: async (credential) => {
            const probe = await probeProviderVisualModel({
                credential,
                model: selectedModel,
                prompt: cleanPrompt,
                timeoutMs: Number.parseInt(env.XAI_IMAGE_TIMEOUT_MS || '120000', 10) || 120_000,
            });
            if (probe.ok && probe.image?.buffer?.length) return probe;
            attempts.push({ envName: credential.name, status: probe.status || 0, error: probe.error || 'no image' });
            const error = new Error(`xAI image API ${probe.status || 0}: ${probe.error || 'no image returned'}`);
            error.status = Number(probe.status || 0);
            throw error;
        },
    });
    return {
        provider,
        model: selectedModel,
        key: result.credential,
        buffer: result.value.image.buffer,
        mimeType: result.value.image.mimeType || 'image/png',
        status: result.value.status || 200,
        elapsedMs: result.value.elapsedMs || 0,
        attempts,
    };
}

export async function runExternalProviderChat(provider, { prompt, model = 'auto', env = process.env, runtimeModes = [], healthRows = [], keyHealthRows = [] } = {}) {
    if (provider === 'huggingface') throw new Error('Hugging Face has no single universal chat model endpoint for an arbitrary token. Choose a concrete Inference Provider/model first.');
    const catalog = await listExternalProviderModels(provider, { env });
    if (!catalog.ok) throw new Error(catalog.error || `No working ${provider} key.`);

    const auditedRows = (Array.isArray(runtimeModes) ? runtimeModes : []).filter((row) => row?.provider === provider && row?.capability === 'text');
    const auditedModelIds = new Set(auditedRows.map((row) => row.model));
    const selectableModels = auditedModelIds.size
        ? catalog.models.filter((row) => auditedModelIds.has(row.id))
        : catalog.models;
    const selected = selectModel(provider, selectableModels, model);
    if (!selected) throw new Error(`No audited chat-capable model found for ${provider}.`);

    const credentials = providerCredentials(provider, env);
    const ordered = [catalog.key, ...credentials.filter((row) => row.name !== catalog.key?.name)]
        .filter(Boolean)
        .sort((left, right) => {
            const lp = runtimePolicyFor(auditedRows, provider, left.name, selected.id);
            const rp = runtimePolicyFor(auditedRows, provider, right.name, selected.id);
            return Number(Boolean(rp)) - Number(Boolean(lp));
        });
    const attempts = [];
    const hasAuditedKeyForModel = auditedRows.some((row) => row.model === selected.id);
    const keyHealth = new Map((Array.isArray(keyHealthRows) ? keyHealthRows : []).map((row) => [`${row.provider}\u0000${row.envName}`, row]));
    const exactHealth = new Map((Array.isArray(healthRows) ? healthRows : []).map((row) => [`${row.provider}\u0000${row.envName}\u0000${row.model}\u0000${row.capability}`, row]));
    const eligibleCredentials = ordered.filter((credential) => {
        const keyRow = keyHealth.get(`${provider}\u0000${credential.name}`);
        if (keyRow && (keyRow.status === 'dead' || keyRow.status === 'no-working-models' || unavailableHealthFresh(keyRow, env))) return false;
        const modelRow = exactHealth.get(`${provider}\u0000${credential.name}\u0000${selected.id}\u0000text`);
        if (modelRow && (modelRow.status === 'dead' || unavailableHealthFresh(modelRow, env))) return false;
        const policy = runtimePolicyFor(auditedRows, provider, credential.name, selected.id);
        return !hasAuditedKeyForModel || Boolean(policy);
    }).map((credential) => ({ ...credential, baseUrl: credential.baseUrl || 'external://provider' }));

    const result = await executeRuntimeModelFailover({
        candidates: eligibleCredentials,
        request: async (credential) => {
            const policy = runtimePolicyFor(auditedRows, provider, credential.name, selected.id);
            let last = null;
            for (const transport of transportOrder(policy)) {
                const row = await callExternalModel(provider, credential, selected, prompt, transport);
                if (row.ok && clean(row.text)) {
                    return { row, transport };
                }
                attempts.push({ envName: credential.name, masked: credential.masked, transport, status: row?.status || 0, error: row?.error || 'failed' });
                last = row;
            }
            const failure = new Error(`External model API ${last?.status || 0}: ${last?.error || 'empty response'}`);
            failure.status = last?.status || 0;
            throw failure;
        },
    });
    const winner = result.value;
    const answerText = clean(winner.row.text);
    recordAiTokenUsage({
        operation: `external-provider:${provider}`,
        capability: 'text',
        provider,
        keyName: result.credential?.name || '',
        model: selected.id,
        transport: `external-${winner.transport || 'non_stream'}`,
        usage: winner.row?.usage,
        inputChars: withGigoraveIdentityUserPrompt(prompt).length,
        outputChars: answerText.length,
        durationMs: winner.row?.elapsedMs || 0,
        metadata: { explicitExternalProvider: true },
        userPrompt: prompt,
    });
    return {
        provider,
        model: selected.id,
        text: answerText,
        key: result.credential,
        transport: winner.transport,
        status: winner.row.status,
        elapsedMs: winner.row.elapsedMs,
        attempts,
    };
}
