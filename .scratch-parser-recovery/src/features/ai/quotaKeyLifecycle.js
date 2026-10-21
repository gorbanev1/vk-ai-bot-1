import { createHash } from 'node:crypto';
import { collectAuditableAiCredentials, runConfiguredAiKeyAudit } from './providerKeyAudit.js';
import { probeProviderVisualModel } from './allProviderVisualMatrixAudit.js';
import { __FULL_AI_AUDIT_TESTING__ } from './fullAiAudit.js';
import { isDefinitiveInvalidCredentialResult, isNoFundsCredentialResult } from './envKeyCleanup.js';

const clean = (value) => String(value ?? '').trim();

export const AI_QUOTA_LIFECYCLE_TASK_KEY = 'ai_quota_key_lifecycle_v144';
export const AI_QUOTA_RETEST_DAYS = Object.freeze([5, 20]);
export const AI_QUOTA_MAX_PASSES = 5;
export const AI_QUOTA_RETEST_TIME_ZONE = 'Europe/Moscow';

function localDateParts(date = new Date(), timeZone = AI_QUOTA_RETEST_TIME_ZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone,
        year: 'numeric',
        month: '2-digit',
        day: '2-digit',
    }).formatToParts(date);
    const byType = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    return {
        year: Number(byType.year),
        month: Number(byType.month),
        day: Number(byType.day),
    };
}

function pad2(value) {
    return String(value).padStart(2, '0');
}

function slotId(year, month, day) {
    return `${year}-${pad2(month)}-${pad2(day)}`;
}

function previousMonth(year, month) {
    if (month > 1) return { year, month: month - 1 };
    return { year: year - 1, month: 12 };
}

export function latestQuotaRetestSlot(date = new Date(), timeZone = AI_QUOTA_RETEST_TIME_ZONE) {
    const local = localDateParts(date, timeZone);
    const eligible = AI_QUOTA_RETEST_DAYS.filter((day) => day <= local.day);
    if (eligible.length) return slotId(local.year, local.month, eligible.at(-1));
    const previous = previousMonth(local.year, local.month);
    return slotId(previous.year, previous.month, AI_QUOTA_RETEST_DAYS.at(-1));
}

export function localDateId(date = new Date(), timeZone = AI_QUOTA_RETEST_TIME_ZONE) {
    const local = localDateParts(date, timeZone);
    return slotId(local.year, local.month, local.day);
}

function fingerprint(secret) {
    return createHash('sha256').update(clean(secret)).digest('hex').slice(0, 20);
}

export function normalizeQuotaLifecycleState(raw = {}) {
    const input = raw && typeof raw === 'object' ? raw : {};
    const keys = input.keys && typeof input.keys === 'object' ? input.keys : {};
    return {
        version: 1,
        scheduleDays: [...AI_QUOTA_RETEST_DAYS],
        maxPasses: AI_QUOTA_MAX_PASSES,
        timeZone: AI_QUOTA_RETEST_TIME_ZONE,
        keys: Object.fromEntries(Object.entries(keys).map(([envName, row]) => [envName, {
            envName,
            provider: clean(row?.provider),
            fingerprint: clean(row?.fingerprint),
            quarantinedAt: clean(row?.quarantinedAt),
            quarantinedDate: clean(row?.quarantinedDate),
            passCount: Math.max(0, Number(row?.passCount || 0)),
            lastCompletedSlot: clean(row?.lastCompletedSlot),
            inProgressSlot: clean(row?.inProgressSlot),
            lastCheckedAt: clean(row?.lastCheckedAt),
            lastStatus: clean(row?.lastStatus),
            lastError: clean(row?.lastError).slice(0, 500),
        }])),
        history: Array.isArray(input.history) ? input.history.slice(-200) : [],
    };
}

export function registerQuotaKeys(stateInput, entries = [], { now = new Date(), providers = new Map() } = {}) {
    const state = normalizeQuotaLifecycleState(stateInput);
    const date = localDateId(now);
    for (const entry of entries) {
        const envName = clean(entry?.envName);
        const secret = clean(entry?.secret);
        if (!envName || !secret) continue;
        const fp = fingerprint(secret);
        const current = state.keys[envName];
        if (current && current.fingerprint === fp) continue;
        state.keys[envName] = {
            envName,
            provider: clean(providers.get(envName) || entry?.provider),
            fingerprint: fp,
            quarantinedAt: now.toISOString(),
            quarantinedDate: date,
            passCount: 0,
            lastCompletedSlot: '',
            inProgressSlot: '',
            lastCheckedAt: '',
            lastStatus: 'quarantined',
            lastError: '',
        };
        state.history.push({ at: now.toISOString(), envName, action: 'quarantined', passCount: 0 });
    }
    state.history = state.history.slice(-200);
    return state;
}

export function quotaKeysDueForSlot(stateInput, entries = [], { now = new Date() } = {}) {
    const state = normalizeQuotaLifecycleState(stateInput);
    const currentSlot = latestQuotaRetestSlot(now, state.timeZone);
    const secretByName = new Map(entries.map((entry) => [clean(entry?.envName), clean(entry?.secret)]));
    return Object.values(state.keys)
        .filter((row) => secretByName.has(row.envName))
        .filter((row) => row.quarantinedDate && currentSlot >= row.quarantinedDate)
        .filter((row) => row.lastCompletedSlot !== currentSlot)
        .map((row) => ({ ...row, slotId: currentSlot, secret: secretByName.get(row.envName) }));
}

function classifyProbe(row = {}) {
    if (row?.ok) return 'working';
    if (isDefinitiveInvalidCredentialResult(row)) return 'invalid';
    if (isNoFundsCredentialResult(row)) return 'quota';
    return 'uncertain';
}

function mergeProbeStatuses(rows = []) {
    const statuses = rows.map(classifyProbe);
    if (statuses.includes('working')) return 'working';
    if (statuses.includes('invalid')) return 'invalid';
    if (statuses.includes('quota')) return 'quota';
    return 'uncertain';
}

export async function probeQuotaKeyRecovery({
    envName,
    secret,
    baseEnv = process.env,
    fetchImpl = globalThis.fetch,
    timeoutMs = 30_000,
} = {}) {
    const name = clean(envName);
    const value = clean(secret);
    if (!name || !value) return { status: 'invalid', envName: name, error: 'missing quarantined credential', attempts: [] };
    const env = { ...baseEnv, [name]: value };
    const keyAudit = await runConfiguredAiKeyAudit({
        env,
        onlyEnvNames: [name],
        timeoutMs,
        concurrency: 1,
        fetchImpl,
    });
    const catalog = keyAudit.results?.[0] || { ok: false, status: 0, error: 'credential not discovered', models: [] };
    const credential = collectAuditableAiCredentials(env).find((row) => row.name === name);
    const attempts = [{ capability: 'catalog', model: '', ok: Boolean(catalog.ok), status: Number(catalog.status || 0), error: clean(catalog.error) }];
    const catalogStatus = classifyProbe(catalog);
    if (catalogStatus === 'invalid' || catalogStatus === 'quota') {
        return { status: catalogStatus, envName: name, provider: clean(catalog.provider || credential?.provider), attempts, error: clean(catalog.error) };
    }
    if (!catalog.ok || !credential) {
        return { status: 'uncertain', envName: name, provider: clean(catalog.provider || credential?.provider), attempts, error: clean(catalog.error || 'catalog unavailable') };
    }

    const textModels = (catalog.models || [])
        .filter((model) => Array.isArray(model.capabilities) && model.capabilities.includes('text'))
        .map((model) => clean(model.id))
        .filter(Boolean)
        .slice(0, 3);
    const imageModels = (catalog.models || [])
        .filter((model) => Array.isArray(model.capabilities) && (model.capabilities.includes('image') || model.capabilities.includes('generation')))
        .map((model) => clean(model.id))
        .filter(Boolean)
        .slice(0, 1);

    for (const model of textModels) {
        const raw = await __FULL_AI_AUDIT_TESTING__.probeTextTransport({
            fetchImpl,
            credential,
            model,
            prompt: 'Reply exactly: GIGORAVE_AUDIT_OK',
            timeoutMs,
            transport: 'non_stream',
        });
        const row = { provider: credential.provider, envName: name, capability: 'text', model, ok: Boolean(raw.ok), status: Number(raw.status || 0), error: clean(raw.error), transport: 'non_stream' };
        attempts.push(row);
        if (row.ok) {
            return {
                status: 'working', envName: name, provider: credential.provider, attempts,
                recoveredMode: {
                    provider: credential.provider,
                    envName: name,
                    masked: credential.masked,
                    model,
                    capability: 'text',
                    endpoint: clean(raw.endpoint),
                    preferredTransport: 'non_stream',
                    fallbackTransport: '',
                    fallbackEndpoint: '',
                    nonStreamOk: true,
                    streamOk: false,
                    reasoningModes: [],
                    reasoningPolicies: {},
                    testedAt: Math.floor(Date.now() / 1000),
                },
            };
        }
    }

    if (!textModels.length) {
        for (const model of imageModels) {
            const raw = await probeProviderVisualModel({
                credential,
                model,
                prompt: 'Simple black square on white background',
                fetchImpl,
            });
            const row = { provider: credential.provider, envName: name, capability: 'image', model, ok: Boolean(raw.ok), status: Number(raw.status || 0), error: clean(raw.error), transport: 'non_stream' };
            attempts.push(row);
            if (row.ok) {
                return {
                    status: 'working', envName: name, provider: credential.provider, attempts,
                    recoveredMode: {
                        provider: credential.provider,
                        envName: name,
                        masked: credential.masked,
                        model,
                        capability: 'image',
                        endpoint: 'provider-image-adapter',
                        preferredTransport: 'non_stream',
                        fallbackTransport: '',
                        fallbackEndpoint: '',
                        nonStreamOk: true,
                        streamOk: false,
                        reasoningModes: [],
                        reasoningPolicies: {},
                        testedAt: Math.floor(Date.now() / 1000),
                    },
                };
            }
        }
    }

    const modelAttempts = attempts.filter((row) => row.capability !== 'catalog');
    const status = mergeProbeStatuses(modelAttempts.length ? modelAttempts : attempts);
    return {
        status,
        envName: name,
        provider: credential.provider,
        attempts,
        error: clean(modelAttempts.find((row) => row.error)?.error || catalog.error),
    };
}

export function applyQuotaProbeResult(stateInput, {
    envName,
    slotId: checkedSlot,
    result,
    now = new Date(),
} = {}) {
    const state = normalizeQuotaLifecycleState(stateInput);
    const name = clean(envName);
    const row = state.keys[name];
    if (!row) return { state, action: 'missing', passCount: 0 };
    const status = clean(result?.status) || 'uncertain';
    row.inProgressSlot = '';
    row.lastCompletedSlot = clean(checkedSlot);
    row.lastCheckedAt = now.toISOString();
    row.lastStatus = status;
    row.lastError = clean(result?.error).slice(0, 500);

    let action = 'keep';
    if (status === 'working') {
        action = 'restore';
    } else if (status === 'invalid') {
        action = 'delete-invalid';
    } else if (status === 'quota') {
        row.passCount += 1;
        if (row.passCount >= AI_QUOTA_MAX_PASSES) action = 'delete-after-five';
    }

    state.history.push({
        at: now.toISOString(),
        envName: name,
        slotId: clean(checkedSlot),
        status,
        action,
        passCount: row.passCount,
    });
    state.history = state.history.slice(-200);
    return { state, action, passCount: row.passCount };
}

export function removeQuotaLifecycleKey(stateInput, envName, { now = new Date(), action = 'removed' } = {}) {
    const state = normalizeQuotaLifecycleState(stateInput);
    const name = clean(envName);
    const row = state.keys[name];
    if (row) {
        state.history.push({ at: now.toISOString(), envName: name, action, passCount: row.passCount });
        delete state.keys[name];
    }
    state.history = state.history.slice(-200);
    return state;
}
