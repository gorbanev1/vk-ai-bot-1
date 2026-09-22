import {
    collectConfiguredAiCredentials,
    runConfiguredAiKeyAudit,
} from './providerKeyAudit.js';
import {
    classifyAiAuditFailure,
    probeAiFastTextTransport,
} from './fullAiAudit.js';
import {
    probeProviderVisualModel,
} from './allProviderVisualMatrixAudit.js';

function clean(value) {
    return String(value ?? '').trim();
}

function boundedInteger(value, fallback, minimum, maximum) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isSafeInteger(parsed)) return fallback;
    return Math.max(minimum, Math.min(maximum, parsed));
}

function keyId(provider, envName) {
    return `${clean(provider)}\u0000${clean(envName)}`;
}

function modelId(provider, envName, model, capability) {
    return `${keyId(provider, envName)}\u0000${clean(model)}\u0000${clean(capability)}`;
}

function providerModelScore(provider, model) {
    const id = clean(model?.id || model).toLowerCase();
    let score = 0;
    if (/gpt-5\.6|gpt-5\.5|gpt-5\.4/u.test(id)) score += 30_000;
    if (/grok-4\.6|grok-4\.3/u.test(id)) score += 29_000;
    if (/claude-(?:opus|sonnet)-4/u.test(id)) score += 28_000;
    if (/gemini-(?:3|2\.5)/u.test(id)) score += 27_000;
    if (/llama-4|llama-3\.3|qwen3|deepseek|mistral|nemotron/u.test(id)) score += 20_000;
    if (/mini|flash|small|fast/u.test(id)) score += 1_000;
    if (/latest|preview/u.test(id)) score += 800;
    if (/deprecated|legacy|guard|moderation|embed|rerank/u.test(id)) score -= 50_000;
    if (provider === 'xai' && /grok/u.test(id)) score += 5_000;
    return score;
}

function configuredModelNames(env = process.env) {
    const names = new Set();
    for (const [name, value] of Object.entries(env || {})) {
        if (!/(?:MODEL|MODELS)$/u.test(name)) continue;
        for (const item of String(value ?? '').split(/[;,]/u)) {
            const model = clean(item);
            if (model && !/^https?:/iu.test(model)) names.add(model);
        }
    }
    return names;
}

function selectModels({ provider, catalogModels, capability, existingModes, env, limit }) {
    const current = new Set(
        (Array.isArray(existingModes) ? existingModes : [])
            .filter((row) => row?.provider === provider && row?.capability === capability)
            .map((row) => clean(row.model))
            .filter(Boolean),
    );
    const configured = configuredModelNames(env);
    const rows = (Array.isArray(catalogModels) ? catalogModels : [])
        .filter((row) => Array.isArray(row?.capabilities) && row.capabilities.includes(capability))
        .map((row) => ({ ...row, id: clean(row.id) }))
        .filter((row) => row.id);

    rows.sort((left, right) => {
        const leftPinned = current.has(left.id) || configured.has(left.id);
        const rightPinned = current.has(right.id) || configured.has(right.id);
        if (leftPinned !== rightPinned) return rightPinned - leftPinned;
        return providerModelScore(provider, right) - providerModelScore(provider, left)
            || right.id.localeCompare(left.id, 'en', { numeric: true });
    });

    if (limit <= 0 || rows.length <= limit) return { selected: rows, skipped: 0 };
    return { selected: rows.slice(0, limit), skipped: rows.length - limit };
}

function createLimiter(limit) {
    const max = Math.max(1, Number(limit || 1));
    let active = 0;
    const queue = [];
    const next = () => {
        if (active >= max || !queue.length) return;
        active += 1;
        const item = queue.shift();
        Promise.resolve()
            .then(item.fn)
            .then(item.resolve, item.reject)
            .finally(() => {
                active -= 1;
                next();
            });
    };
    return (fn) => new Promise((resolve, reject) => {
        queue.push({ fn, resolve, reject });
        next();
    });
}

function summarizeError(nonStream, stream) {
    const parts = [];
    if (nonStream && !nonStream.ok) parts.push(`non-stream HTTP ${nonStream.status || 0}: ${clean(nonStream.error)}`);
    if (stream && !stream.ok) parts.push(`stream HTTP ${stream.status || 0}: ${clean(stream.error)}`);
    return parts.join(' | ').slice(0, 1500);
}

function isTemporaryTransportFailure(row) {
    if (!row || row.ok) return false;
    const status = Number(row.status || 0);
    if (!status || status === 408 || status === 409 || status === 425 || status === 429 || status >= 500) return true;
    const message = clean(row.error).toLowerCase();
    return /timeout|network|econn|temporar|upstream|capacity|overload|rate\s*limit/u.test(message);
}

function chooseTextPolicy(nonStream, stream) {
    if (nonStream?.ok && stream?.ok) return { status: 'working', preferredTransport: 'non_stream' };
    if (stream?.ok) return { status: 'working', preferredTransport: 'stream' };
    if (nonStream?.ok) return { status: 'working', preferredTransport: 'non_stream' };
    if (isTemporaryTransportFailure(nonStream) || isTemporaryTransportFailure(stream)) {
        return { status: 'unavailable', preferredTransport: '' };
    }
    return { status: 'dead', preferredTransport: '' };
}

/**
 * V188.4 compact health pass.
 *
 * - key catalogs are checked in parallel;
 * - every selected text model is probed with stream + non-stream concurrently;
 * - image models receive one real generation probe;
 * - there is no long retry ladder here: this command describes what works NOW;
 * - caller persists all rows and atomically rebuilds ai_runtime_modes from
 *   workingRows, so failed combinations disappear from the active pool.
 */
export async function runCompactAiHealthAudit({
    env = process.env,
    existingRuntimeModes = [],
    fetchImpl = globalThis.fetch,
    onProgress = null,
} = {}) {
    const startedAt = Date.now();
    const keyTimeoutMs = boundedInteger(env.AI_HEALTH_KEY_TIMEOUT_MS, 8_000, 2_000, 30_000);
    const modelTimeoutMs = boundedInteger(env.AI_HEALTH_MODEL_TIMEOUT_MS, 12_000, 3_000, 45_000);
    const keyConcurrency = boundedInteger(env.AI_HEALTH_KEY_CONCURRENCY, 16, 1, 32);
    const modelConcurrency = boundedInteger(env.AI_HEALTH_MODEL_CONCURRENCY, 24, 1, 64);
    const perKeyConcurrency = boundedInteger(env.AI_HEALTH_PER_KEY_CONCURRENCY, 6, 1, 12);
    const maxTextModels = boundedInteger(env.AI_HEALTH_MAX_TEXT_MODELS_PER_KEY, 64, 1, 250);
    const maxImageModels = boundedInteger(env.AI_HEALTH_MAX_IMAGE_MODELS_PER_KEY, 8, 1, 40);

    const credentials = collectConfiguredAiCredentials(env);
    const credentialByKey = new Map(credentials.map((row) => [keyId(row.provider, row.name), row]));
    const keyAudit = await runConfiguredAiKeyAudit({
        env,
        timeoutMs: keyTimeoutMs,
        concurrency: keyConcurrency,
        includeExcluded: true,
        fetchImpl,
        onProgress: (event) => onProgress?.({ ...event, phase: 'keys' }),
    });

    const globalLimit = createLimiter(modelConcurrency);
    const perKeyLimits = new Map();
    const withLimits = (credential, fn) => {
        const id = keyId(credential.provider, credential.name);
        if (!perKeyLimits.has(id)) perKeyLimits.set(id, createLimiter(perKeyConcurrency));
        return globalLimit(() => perKeyLimits.get(id)(fn));
    };

    const keyRows = [];
    const modelRows = [];
    const workingRows = [];
    const tasks = [];
    let plannedModels = 0;
    let skippedCatalogModels = 0;
    let completedModels = 0;

    for (const result of keyAudit.results || []) {
        const credential = credentialByKey.get(keyId(result.provider, result.envName));
        if (!credential) continue;
        const failure = result.ok ? null : classifyAiAuditFailure({
            status: result.status,
            error: result.error,
            provider: result.provider,
        });
        const keyRow = {
            provider: result.provider,
            envName: result.envName,
            masked: result.masked,
            status: result.ok ? 'catalog-ok' : failure?.definitiveDead ? 'dead' : 'unavailable',
            catalogStatus: result.status || 0,
            catalogLatencyMs: result.elapsedMs || 0,
            modelsSeen: Array.isArray(result.models) ? result.models.length : 0,
            workingModels: 0,
            selectedModels: 0,
            unavailableModels: 0,
            lastError: result.error || '',
        };
        keyRows.push(keyRow);
        if (!result.ok) continue;

        const text = selectModels({
            provider: result.provider,
            catalogModels: result.models,
            capability: 'text',
            existingModes: existingRuntimeModes,
            env,
            limit: maxTextModels,
        });
        const image = selectModels({
            provider: result.provider,
            catalogModels: result.models,
            capability: 'image',
            existingModes: existingRuntimeModes,
            env,
            limit: maxImageModels,
        });
        skippedCatalogModels += text.skipped + image.skipped;
        keyRow.selectedModels = text.selected.length + image.selected.length;

        for (const row of text.selected) {
            plannedModels += 1;
            tasks.push(withLimits(credential, async () => {
                await onProgress?.({ phase: 'models', stage: 'start', capability: 'text', provider: credential.provider, envName: credential.name, model: row.id, completed: completedModels, total: plannedModels });
                const [nonStream, stream] = await Promise.all([
                    probeAiFastTextTransport({ fetchImpl, credential, model: row.id, transport: 'non_stream', timeoutMs: modelTimeoutMs }),
                    probeAiFastTextTransport({ fetchImpl, credential, model: row.id, transport: 'stream', timeoutMs: modelTimeoutMs }),
                ]);
                const policy = chooseTextPolicy(nonStream, stream);
                const health = {
                    provider: credential.provider,
                    envName: credential.name,
                    masked: credential.masked,
                    model: row.id,
                    capability: 'text',
                    status: policy.status,
                    nonStreamOk: Boolean(nonStream?.ok),
                    streamOk: Boolean(stream?.ok),
                    nonStreamStatus: Number(nonStream?.status || 0),
                    streamStatus: Number(stream?.status || 0),
                    nonStreamLatencyMs: Number(nonStream?.elapsedMs || 0),
                    streamLatencyMs: Number(stream?.elapsedMs || 0),
                    preferredTransport: policy.preferredTransport,
                    lastError: summarizeError(nonStream, stream),
                };
                modelRows.push(health);
                if (policy.status === 'unavailable') keyRow.unavailableModels += 1;
                if (policy.status === 'working') {
                    workingRows.push({
                        provider: credential.provider,
                        envName: credential.name,
                        masked: credential.masked,
                        model: row.id,
                        capability: 'text',
                        endpoint: policy.preferredTransport === 'stream' ? clean(stream?.endpoint) : clean(nonStream?.endpoint),
                        preferredTransport: policy.preferredTransport,
                        fallbackTransport: nonStream?.ok && stream?.ok ? (policy.preferredTransport === 'stream' ? 'non_stream' : 'stream') : '',
                        fallbackEndpoint: nonStream?.ok && stream?.ok ? (policy.preferredTransport === 'stream' ? clean(nonStream?.endpoint) : clean(stream?.endpoint)) : '',
                        nonStreamOk: Boolean(nonStream?.ok),
                        streamOk: Boolean(stream?.ok),
                        reasoningModes: [],
                        reasoningPolicies: {},
                    });
                    keyRow.workingModels += 1;
                }
                completedModels += 1;
                await onProgress?.({ phase: 'models', stage: 'complete', capability: 'text', provider: credential.provider, envName: credential.name, model: row.id, completed: completedModels, ok: policy.status === 'working', nonStreamOk: Boolean(nonStream?.ok), streamOk: Boolean(stream?.ok) });
            }));
        }

        for (const row of image.selected) {
            plannedModels += 1;
            tasks.push(withLimits(credential, async () => {
                await onProgress?.({ phase: 'models', stage: 'start', capability: 'image', provider: credential.provider, envName: credential.name, model: row.id, completed: completedModels, total: plannedModels });
                const probe = await probeProviderVisualModel({
                    credential,
                    model: row.id,
                    prompt: 'Simple black square on white background, no text',
                    fetchImpl,
                    timeoutMs: modelTimeoutMs,
                });
                const health = {
                    provider: credential.provider,
                    envName: credential.name,
                    masked: credential.masked,
                    model: row.id,
                    capability: 'image',
                    status: probe?.ok ? 'working' : (isTemporaryTransportFailure(probe) ? 'unavailable' : 'dead'),
                    nonStreamOk: Boolean(probe?.ok),
                    streamOk: false,
                    nonStreamStatus: Number(probe?.status || 0),
                    streamStatus: 0,
                    nonStreamLatencyMs: Number(probe?.elapsedMs || 0),
                    streamLatencyMs: 0,
                    preferredTransport: probe?.ok ? 'non_stream' : '',
                    lastError: probe?.ok ? '' : clean(probe?.error).slice(0, 1500),
                };
                modelRows.push(health);
                if (health.status === 'unavailable') keyRow.unavailableModels += 1;
                if (probe?.ok) {
                    workingRows.push({
                        provider: credential.provider,
                        envName: credential.name,
                        masked: credential.masked,
                        model: row.id,
                        capability: 'image',
                        endpoint: 'provider-image-adapter',
                        preferredTransport: 'non_stream',
                        fallbackTransport: '',
                        fallbackEndpoint: '',
                        nonStreamOk: true,
                        streamOk: false,
                        reasoningModes: [],
                        reasoningPolicies: {},
                    });
                    keyRow.workingModels += 1;
                }
                completedModels += 1;
                await onProgress?.({ phase: 'models', stage: 'complete', capability: 'image', provider: credential.provider, envName: credential.name, model: row.id, completed: completedModels, ok: Boolean(probe?.ok) });
            }));
        }
    }

    await Promise.all(tasks);

    for (const row of keyRows) {
        if (row.status !== 'catalog-ok') continue;
        if (row.workingModels > 0) row.status = 'working';
        else if (row.unavailableModels > 0) row.status = 'unavailable';
        else row.status = 'no-working-models';
    }

    const deadEnvNames = keyRows
        .filter((row) => row.status === 'dead')
        .map((row) => row.envName);

    return {
        checkedAt: new Date().toISOString(),
        durationMs: Date.now() - startedAt,
        settings: {
            keyTimeoutMs,
            modelTimeoutMs,
            keyConcurrency,
            modelConcurrency,
            perKeyConcurrency,
            maxTextModels,
            maxImageModels,
        },
        keyAudit,
        keys: keyRows,
        models: modelRows,
        workingRows,
        deadEnvNames,
        plannedModels,
        skippedCatalogModels,
        stats: {
            keys: keyRows.length,
            workingKeys: keyRows.filter((row) => row.status === 'working').length,
            unavailableKeys: keyRows.filter((row) => row.status === 'unavailable').length,
            deadKeys: keyRows.filter((row) => row.status === 'dead' || row.status === 'no-working-models').length,
            modelsTested: modelRows.length,
            workingModels: workingRows.length,
            deadModels: modelRows.filter((row) => row.status === 'dead').length,
            unavailableModels: modelRows.filter((row) => row.status === 'unavailable').length,
            textBoth: modelRows.filter((row) => row.capability === 'text' && row.nonStreamOk && row.streamOk).length,
            textNonStreamOnly: modelRows.filter((row) => row.capability === 'text' && row.nonStreamOk && !row.streamOk).length,
            textStreamOnly: modelRows.filter((row) => row.capability === 'text' && !row.nonStreamOk && row.streamOk).length,
        },
    };
}

export function formatCompactAiHealthSummary(result, { maxModels = 30 } = {}) {
    const seconds = Math.max(0, Math.round(Number(result?.durationMs || 0) / 1000));
    const working = (result?.models || []).filter((row) => row.status === 'working');
    const lines = [
        `AI health: ${seconds} сек. Ключи ${result?.stats?.workingKeys || 0}/${result?.stats?.keys || 0}; рабочие model/key ${result?.stats?.workingModels || 0}/${result?.stats?.modelsTested || 0}.`,
        `Text transport: both=${result?.stats?.textBoth || 0}, non-stream-only=${result?.stats?.textNonStreamOnly || 0}, stream-only=${result?.stats?.textStreamOnly || 0}.`,
    ];
    if (result?.skippedCatalogModels) lines.push(`Каталог слишком большой: ${result.skippedCatalogModels} низкоприоритетных моделей пропущено компактной проверкой.`);
    const deadKeys = (result?.keys || []).filter((row) => row.status !== 'working');
    if (deadKeys.length) lines.push(`Из рабочего пула ключей исключено: ${deadKeys.map((row) => `${row.provider}/${row.envName}:${row.status}`).join(', ')}`);
    lines.push('Рабочие модели:');
    for (const row of working.slice(0, maxModels)) {
        const transports = row.capability === 'text'
            ? `${row.nonStreamOk ? 'N' : '-'}${row.streamOk ? 'S' : '-'}`
            : 'IMG';
        lines.push(`• ${row.provider}/${row.envName} · ${row.model} · ${transports}`);
    }
    if (working.length > maxModels) lines.push(`…ещё ${working.length - maxModels}. Полный список сохранён в SQLite.`);
    return lines.join('\n');
}

export const __COMPACT_AI_HEALTH_TESTING__ = Object.freeze({
    chooseTextPolicy,
    selectModels,
    providerModelScore,
    isTemporaryTransportFailure,
});
