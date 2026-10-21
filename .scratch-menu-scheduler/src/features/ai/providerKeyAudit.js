import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const DEFAULT_TIMEOUT_MS = 20_000;

function clean(value) {
    return String(value ?? '').trim();
}

function maskSecret(value) {
    const key = clean(value);
    if (!key) return 'empty';
    if (key.length <= 12) return `${key.slice(0, 3)}…${key.slice(-3)}`;
    return `${key.slice(0, 7)}…${key.slice(-5)}`;
}

function uniqueBySecret(items) {
    const seen = new Set();
    return items.filter((item) => {
        const signature = `${item.provider}\u0000${item.secret}`;
        if (!item.secret || seen.has(signature)) return false;
        seen.add(signature);
        return true;
    });
}


export function getAiAuditExcludedEnvNames(env = process.env) {
    const configured = clean(env.AI_AUDIT_EXCLUDE_ENV_NAMES);
    const defaults = ['OPENAI_COMPAT_API_KEY'];
    const extra = configured
        ? configured.split(/[;,\s]+/u).map(clean).filter(Boolean)
        : [];
    return new Set([...defaults, ...extra]);
}

function isExcludedAiAuditEnvName(name, excluded) {
    const normalized = clean(name);
    return excluded.has(normalized) || /^OPENAI_COMPAT_API_KEY(?:_\d+)?$/u.test(normalized);
}

export function collectAuditableAiCredentials(env = process.env) {
    const excluded = getAiAuditExcludedEnvNames(env);
    return collectConfiguredAiCredentials(env).filter(
        (entry) => !isExcludedAiAuditEnvName(entry.name, excluded),
    );
}
function numberedEnvEntries(env, prefix) {
    return Object.entries(env || {})
        .filter(([name, value]) => new RegExp(`^${prefix}(?:_\\d+)?$`, 'u').test(name) && clean(value))
        .sort(([left], [right]) => left.localeCompare(right, 'en', { numeric: true }))
        .map(([name, secret]) => ({ name, secret: clean(secret) }));
}

export function collectConfiguredAiCredentials(env = process.env) {
    const credentials = [];

    for (const entry of numberedEnvEntries(env, 'OPENAI_API_KEY')) {
        credentials.push({ provider: 'openai', ...entry, baseUrl: clean(env.OPENAI_API_BASE_URL) || 'https://api.openai.com/v1' });
    }

    if (clean(env.OPENAI_DIRECT_API_KEY)) {
        credentials.push({
            provider: 'openai',
            name: 'OPENAI_DIRECT_API_KEY',
            secret: clean(env.OPENAI_DIRECT_API_KEY),
            baseUrl: clean(env.OPENAI_DIRECT_BASE_URL) || 'https://api.openai.com/v1',
        });
    }

    for (const entry of numberedEnvEntries(env, 'OPENAI_COMPAT_API_KEY')) {
        const suffix = entry.name.slice('OPENAI_COMPAT_API_KEY'.length);
        credentials.push({
            provider: 'openai-compatible',
            ...entry,
            baseUrl: clean(env[`OPENAI_COMPAT_BASE_URL${suffix}`] || env.OPENAI_COMPAT_BASE_URL) || 'https://router.cheap/v1',
        });
    }

    for (const entry of numberedEnvEntries(env, 'XAI_API_KEY')) {
        const suffix = entry.name.slice('XAI_API_KEY'.length);
        credentials.push({
            provider: 'xai',
            ...entry,
            baseUrl: clean(env[`XAI_BASE_URL${suffix}`] || env.XAI_BASE_URL) || 'https://api.x.ai/v1',
        });
    }

    for (const entry of numberedEnvEntries(env, 'ANTHROPIC_API_KEY')) {
        credentials.push({ provider: 'anthropic', ...entry, baseUrl: 'https://api.anthropic.com/v1' });
    }
    for (const entry of numberedEnvEntries(env, 'GEMINI_API_KEY')) {
        credentials.push({ provider: 'gemini', ...entry, baseUrl: 'https://generativelanguage.googleapis.com/v1beta' });
    }
    for (const entry of numberedEnvEntries(env, 'GROQ_API_KEY')) {
        credentials.push({ provider: 'groq', ...entry, baseUrl: 'https://api.groq.com/openai/v1' });
    }
    for (const entry of numberedEnvEntries(env, 'HUGGINGFACE_API_KEY')) {
        credentials.push({ provider: 'huggingface', ...entry, baseUrl: 'https://huggingface.co', inferenceBaseUrl: 'https://router.huggingface.co/v1' });
    }
    for (const entry of numberedEnvEntries(env, 'NVIDIA_API_KEY')) {
        credentials.push({ provider: 'nvidia', ...entry, baseUrl: 'https://integrate.api.nvidia.com/v1' });
    }

    return uniqueBySecret(credentials).map((entry, index) => ({
        ...entry,
        slot: index + 1,
        masked: maskSecret(entry.secret),
    }));
}

async function fetchJson(url, options = {}, timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch) {
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
            error: String(error?.message || error).slice(0, 500),
            payload: null,
        };
    }

    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = null; }
    return {
        ok: response.ok,
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        error: response.ok ? '' : clean(payload?.error?.message || payload?.message || payload?.detail || raw).slice(0, 500),
        payload,
    };
}

function normalizeModelList(provider, payload) {
    if (provider === 'gemini') {
        return (Array.isArray(payload?.models) ? payload.models : []).map((model) => ({
            id: clean(model?.name).replace(/^models\//u, ''),
            displayName: clean(model?.displayName),
            description: clean(model?.description),
            methods: Array.isArray(model?.supportedGenerationMethods) ? model.supportedGenerationMethods : [],
        }));
    }

    const source = Array.isArray(payload?.data)
        ? payload.data
        : Array.isArray(payload?.models)
            ? payload.models
            : [];

    return source.map((model) => ({
        id: clean(model?.id || model?.name),
        displayName: clean(model?.display_name || model?.displayName),
        description: clean(model?.description),
        methods: [],
    })).filter((model) => model.id);
}

export function classifyModelCapabilities(provider, model) {
    const id = clean(model?.id).toLowerCase();
    const description = `${clean(model?.displayName)} ${clean(model?.description)}`.toLowerCase();
    const methods = Array.isArray(model?.methods) ? model.methods.map((item) => clean(item)) : [];
    const joined = `${id} ${description}`;
    const caps = new Set();

    if (/(image|imagine|imagen|dall[\s_-]?e|flux|stable-diffusion|sdxl|gpt-image)/u.test(joined)) caps.add('image');
    if (/(guard|safeguard|moderation|content[\s_-]?safety|nemoguard)/u.test(joined)) caps.add('moderation');
    if (/(video|sora|veo)/u.test(joined)) caps.add('video');
    if (/(vision|multimodal|vlm|llava|paligemma|vila|gemini|claude|gpt-5|gpt-4o)/u.test(joined)) caps.add('vision');
    if (/(embed|embedding|retriev)/u.test(joined)) caps.add('embedding');
    if (/(rerank)/u.test(joined)) caps.add('rerank');
    if (/(audio|speech|tts|whisper|transcri)/u.test(joined)) caps.add('audio');
    if (/(code|coder|codex)/u.test(joined)) caps.add('code');

    if (provider === 'gemini') {
        if (methods.includes('generateContent')) caps.add('text');
        if (methods.includes('embedContent')) caps.add('embedding');
        if (methods.includes('predict') || methods.includes('predictLongRunning')) caps.add('generation');
    } else if (!caps.has('embedding') && !caps.has('rerank') && !caps.has('image') && !caps.has('video') && !caps.has('audio') && !caps.has('moderation')) {
        caps.add('text');
    }

    return [...caps];
}

async function probeCredential(credential, { timeoutMs = DEFAULT_TIMEOUT_MS, fetchImpl = globalThis.fetch } = {}) {
    const commonBearerHeaders = {
        Authorization: `Bearer ${credential.secret}`,
        'Content-Type': 'application/json',
    };
    let result;

    if (credential.provider === 'openai' || credential.provider === 'openai-compatible' || credential.provider === 'xai' || credential.provider === 'groq' || credential.provider === 'nvidia') {
        result = await fetchJson(`${credential.baseUrl.replace(/\/$/u, '')}/models`, {
            headers: commonBearerHeaders,
        }, timeoutMs, fetchImpl);
    } else if (credential.provider === 'anthropic') {
        result = await fetchJson(`${credential.baseUrl}/models?limit=100`, {
            headers: {
                'x-api-key': credential.secret,
                'anthropic-version': '2023-06-01',
                'Content-Type': 'application/json',
            },
        }, timeoutMs, fetchImpl);
    } else if (credential.provider === 'gemini') {
        result = await fetchJson(`${credential.baseUrl}/models?pageSize=1000&key=${encodeURIComponent(credential.secret)}`, {
            headers: { 'Content-Type': 'application/json' },
        }, timeoutMs, fetchImpl);
    } else if (credential.provider === 'huggingface') {
        const whoami = await fetchJson(`${credential.baseUrl}/api/whoami-v2`, {
            headers: commonBearerHeaders,
        }, timeoutMs, fetchImpl);
        if (!whoami.ok) {
            return {
                provider: credential.provider, envName: credential.name, masked: credential.masked,
                ok: false, status: whoami.status, elapsedMs: whoami.elapsedMs, error: whoami.error,
                models: [], account: '', note: '',
            };
        }
        const router = await fetchJson(`${credential.inferenceBaseUrl || 'https://router.huggingface.co/v1'}/models`, {
            headers: commonBearerHeaders,
        }, timeoutMs, fetchImpl);
        const models = router.ok
            ? normalizeModelList('openai', router.payload).map((model) => ({
                ...model, capabilities: classifyModelCapabilities('huggingface', model),
            }))
            : [];
        return {
            provider: credential.provider,
            envName: credential.name,
            masked: credential.masked,
            ok: true,
            status: 200,
            elapsedMs: whoami.elapsedMs + router.elapsedMs,
            error: '',
            models,
            account: clean(whoami.payload?.name || whoami.payload?.fullname || whoami.payload?.email),
            note: router.ok
                ? 'HF token принят; conversational catalog получен через router.huggingface.co/v1/models.'
                : `HF token принят, но router /v1/models не ответил: HTTP ${router.status || 0} ${router.error || ''}`.trim(),
        };
    } else {
        return { provider: credential.provider, envName: credential.name, masked: credential.masked, ok: false, status: 0, elapsedMs: 0, error: 'unsupported provider', models: [] };
    }

    const models = result.ok
        ? normalizeModelList(['openai-compatible', 'xai'].includes(credential.provider) ? 'openai' : credential.provider, result.payload)
            .map((model) => ({ ...model, capabilities: classifyModelCapabilities(credential.provider, model) }))
        : [];

    return {
        provider: credential.provider,
        envName: credential.name,
        masked: credential.masked,
        ok: result.ok,
        status: result.status,
        elapsedMs: result.elapsedMs,
        error: result.error,
        models,
        account: '',
        note: credential.provider === 'nvidia'
            ? 'GET /models проверяет hosted catalog. NVIDIA Visual GenAI endpoints тестируются отдельной командой графики.'
            : '',
    };
}

function normalizedConcurrency(value, fallback = 6, max = 32) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed) || parsed < 1) return fallback;
    return Math.min(max, parsed);
}

export async function runConfiguredAiKeyAudit({ env = process.env, timeoutMs = DEFAULT_TIMEOUT_MS, onProgress = null, concurrency = null, onlyEnvNames = null, includeExcluded = false, fetchImpl = globalThis.fetch } = {}) {
    const requestedNames = Array.isArray(onlyEnvNames) && onlyEnvNames.length ? new Set(onlyEnvNames.map(clean)) : null;
    const sourceCredentials = includeExcluded ? collectConfiguredAiCredentials(env) : collectAuditableAiCredentials(env);
    const credentials = requestedNames ? sourceCredentials.filter((row) => requestedNames.has(row.name)) : sourceCredentials;
    const results = new Array(credentials.length);
    const limit = normalizedConcurrency(concurrency ?? env.AI_AUDIT_KEY_CONCURRENCY, 8, 32);
    let cursor = 0;
    let completed = 0;

    async function worker() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= credentials.length) return;
            const credential = credentials[index];
            await onProgress?.({ stage: 'start', index: index + 1, total: credentials.length, provider: credential.provider, envName: credential.name, masked: credential.masked, concurrency: limit });
            const result = await probeCredential(credential, { timeoutMs, fetchImpl });
            results[index] = result;
            completed += 1;
            await onProgress?.({ stage: 'complete', index: index + 1, completed, total: credentials.length, provider: credential.provider, envName: credential.name, masked: credential.masked, concurrency: limit, ...result });
        }
    }

    await Promise.all(Array.from({ length: Math.min(limit, credentials.length) }, () => worker()));

    return {
        checkedAt: new Date().toISOString(),
        total: credentials.length,
        valid: results.filter((item) => item.ok).length,
        invalid: results.filter((item) => !item.ok).length,
        results,
    };
}

function capabilitySummary(models) {
    const counts = new Map();
    for (const model of models) {
        for (const cap of model.capabilities || []) counts.set(cap, (counts.get(cap) || 0) + 1);
    }
    return [...counts.entries()].sort((a, b) => b[1] - a[1]).map(([cap, count]) => `${cap}:${count}`).join(', ') || '—';
}

export function formatAiKeyAuditReport(audit, { includeModels = true } = {}) {
    const lines = [
        'AI KEY LIVE CHECK REPORT',
        `checked_at=${audit.checkedAt}`,
        `total=${audit.total} valid=${audit.valid} invalid=${audit.invalid}`,
        '',
    ];

    audit.results.forEach((result, index) => {
        lines.push(
            `${String(index + 1).padStart(2, '0')}. ${result.ok ? 'OK' : 'FAIL'} ${result.provider} ${result.envName} ${result.masked}`,
            `    HTTP=${result.status || 0} elapsedMs=${result.elapsedMs} models=${result.models.length}`,
            `    capabilities=${capabilitySummary(result.models)}`,
        );
        if (result.account) lines.push(`    account=${result.account}`);
        if (result.note) lines.push(`    note=${result.note}`);
        if (result.error) lines.push(`    error=${result.error}`);
        if (includeModels && result.models.length) {
            for (const model of result.models) {
                lines.push(`    - ${model.id}${model.capabilities?.length ? ` [${model.capabilities.join(',')}]` : ''}${model.description ? ` — ${model.description.replace(/\s+/gu, ' ').slice(0, 220)}` : ''}`);
            }
        }
        lines.push('');
    });

    return lines.join('\n').trimEnd() + '\n';
}

export async function writeAiKeyAuditReport(audit, { directory = process.cwd() } = {}) {
    const textPath = resolve(directory, 'AI_KEYS_LIVE_CHECK_REPORT.txt');
    const jsonPath = resolve(directory, 'AI_KEYS_LIVE_CHECK_REPORT.json');
    await writeFile(textPath, formatAiKeyAuditReport(audit, { includeModels: true }), 'utf8');
    await writeFile(jsonPath, JSON.stringify(audit, null, 2), 'utf8');
    return { textPath, jsonPath };
}
