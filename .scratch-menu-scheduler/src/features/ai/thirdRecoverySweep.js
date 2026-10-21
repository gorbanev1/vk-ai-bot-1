import { appendFile, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import {
    classifyModelCapabilities,
    collectAuditableAiCredentials,
    runConfiguredAiKeyAudit,
} from './providerKeyAudit.js';
import { isNoFundsCredentialResult } from './envKeyCleanup.js';
import {
    FULL_AI_AUDIT_DEFAULTS,
    probeAiRecoveryImageTransport,
    probeAiRecoveryTextTransport,
    classifyAiAuditFailure,
} from './fullAiAudit.js';

const clean = (value) => String(value ?? '').trim();
const sleep = (ms) => new Promise((resolveSleep) => setTimeout(resolveSleep, Math.max(0, Number(ms) || 0)));

const DEFAULT_TEXT_PER_UNCERTAIN_KEY = 6;
const DEFAULT_IMAGE_PER_UNCERTAIN_KEY = 2;
const DEFAULT_KEY_CONCURRENCY = 2;
const DEFAULT_TIMEOUT_MS = 150_000;
const DEFAULT_CATALOG_TIMEOUT_MS = 60_000;
const DEFAULT_CATALOG_RETRY_DELAY_MS = 2_500;

function boundedInt(value, fallback, min = 0, max = 1000) {
    const parsed = Number.parseInt(String(value ?? ''), 10);
    if (!Number.isFinite(parsed)) return fallback;
    return Math.max(min, Math.min(max, parsed));
}

function modeSignature(row = {}) {
    return [row.provider, row.envName, row.model, row.capability].map(clean).join('\u0000');
}

function keySignature(row = {}) {
    return [row.provider, row.envName].map(clean).join('\u0000');
}

function attemptSignature(prefix, row = {}) {
    return [prefix, row.provider, row.envName, row.capability || '', row.model || ''].map(clean).join('\u0000');
}

function transportName(value) {
    const normalized = clean(value);
    if (normalized.startsWith('stream')) return 'stream';
    if (normalized.startsWith('non_stream')) return 'non_stream';
    return '';
}

function oppositeTransport(value) {
    return value === 'stream' ? 'non_stream' : 'stream';
}

function unique(values = []) {
    return [...new Set((values || []).map(clean).filter(Boolean))];
}

function isTransientFailure(row = {}) {
    const failure = classifyAiAuditFailure(row);
    const status = Number(row.status || 0);
    if (isNoFundsCredentialResult(row)) return false;
    if (status === 429) return true;
    return ['network', 'server', 'other', 'payload_or_endpoint', 'model_or_endpoint'].includes(failure.kind)
        || status === 0 || status === 200 || status >= 500;
}

function isRateLimited(row = {}) {
    if (Number(row.status || 0) !== 429 || isNoFundsCredentialResult(row)) return false;
    const message = clean(row.error).toLowerCase();
    return /rate[ -]?limit|too many requests|requests per (?:minute|second)|rpm|tpm/u.test(message) || !message;
}

function classifyKeyStop(row = {}) {
    if (row?.ok) return '';
    if (isNoFundsCredentialResult(row)) return 'quota';
    const failure = classifyAiAuditFailure(row);
    if (failure.kind === 'invalid_key' || failure.definitiveDead && Number(row.status || 0) === 401) return 'invalid';
    if (isRateLimited(row)) return 'rate-limit';
    if (failure.kind === 'access_denied' || failure.kind === 'key_restricted' || failure.kind === 'terms_blocked') return 'blocked';
    return '';
}

function initialTransportOk(transport = {}) {
    if (transport?.firstRound) return Boolean(transport.firstRound.ok);
    if (transport?.secondRound || transport?.thirdRound) {
        return Boolean(transport?.firstRound?.ok);
    }
    return Boolean(transport?.ok);
}

function rowWasLateRecovered(row = {}) {
    if (!row?.keep) return false;
    const transports = [row?.transports?.non_stream, row?.transports?.stream].filter(Boolean);
    if (!transports.length) return false;
    const initiallyWorked = transports.some(initialTransportOk);
    const lateWorked = transports.some((transport) => Boolean(transport?.secondRound?.ok || transport?.thirdRound?.ok));
    return !initiallyWorked && lateWorked;
}

export function collectThirdRecoveryLateModes(report = {}) {
    const wanted = new Set();
    for (const mode of report?.keySecondSweep?.recoveredModes || []) wanted.add(modeSignature(mode));
    for (const row of report?.textResults || []) {
        if (rowWasLateRecovered(row)) wanted.add(modeSignature({ ...row, capability: 'text' }));
    }
    for (const row of report?.imageResults || []) {
        if (rowWasLateRecovered(row)) wanted.add(modeSignature({ ...row, capability: 'image' }));
    }
    return (report?.workingModes || []).filter((mode) => wanted.has(modeSignature(mode)));
}

function modelPriority(model, capability, attemptRows = [], live = false) {
    const id = clean(model).toLowerCase();
    let score = live ? 20 : 0;
    for (const row of attemptRows) {
        const status = Number(row.status || 0);
        const failure = classifyAiAuditFailure(row);
        if (status === 0) score += 45;
        else if (status >= 500) score += 40;
        else if (status === 200) score += 35;
        else if (['payload_or_endpoint', 'model_or_endpoint', 'other'].includes(failure.kind)) score += 20;
        if (isNoFundsCredentialResult(row) || failure.kind === 'invalid_key' || failure.kind === 'access_denied') score -= 100;
    }
    if (/(?:gpt-5|gpt-4o|claude|gemini|llama|qwen|mixtral|mistral|deepseek|gpt-oss)/u.test(id)) score += capability === 'text' ? 8 : 0;
    if (/(?:gpt-image|image|imagen|flux|stable|sdxl)/u.test(id)) score += capability === 'image' ? 8 : 0;
    return score;
}

export function buildThirdRecoveryModelCandidates({ sweepRow = {}, liveModels = [], textLimit = DEFAULT_TEXT_PER_UNCERTAIN_KEY, imageLimit = DEFAULT_IMAGE_PER_UNCERTAIN_KEY } = {}) {
    const bySignature = new Map();
    const attempts = Array.isArray(sweepRow?.attempts) ? sweepRow.attempts : [];
    for (const row of attempts) {
        const capability = clean(row.capability);
        const model = clean(row.model);
        if (!model || !['text', 'image'].includes(capability)) continue;
        const signature = `${capability}\u0000${model}`;
        if (!bySignature.has(signature)) bySignature.set(signature, { capability, model, attempts: [], live: false });
        bySignature.get(signature).attempts.push(row);
    }

    for (const model of liveModels || []) {
        const id = clean(model?.id);
        if (!id) continue;
        const caps = Array.isArray(model?.capabilities) && model.capabilities.length
            ? model.capabilities
            : classifyModelCapabilities(clean(sweepRow?.provider), model);
        const normalizedCaps = [];
        if (caps.includes('text')) normalizedCaps.push('text');
        if (caps.includes('image') || caps.includes('generation')) normalizedCaps.push('image');
        for (const capability of normalizedCaps) {
            const signature = `${capability}\u0000${id}`;
            if (!bySignature.has(signature)) bySignature.set(signature, { capability, model: id, attempts: [], live: true });
            else bySignature.get(signature).live = true;
        }
    }

    const ranked = [...bySignature.values()].map((row) => ({
        ...row,
        score: modelPriority(row.model, row.capability, row.attempts, row.live),
    })).sort((left, right) => right.score - left.score || left.model.localeCompare(right.model, 'en'));

    const text = ranked.filter((row) => row.capability === 'text').slice(0, Math.max(0, textLimit));
    const image = ranked.filter((row) => row.capability === 'image').slice(0, Math.max(0, imageLimit));
    return [...text, ...image];
}

function dedupeModes(rows = []) {
    const result = new Map();
    for (const row of rows || []) {
        const signature = modeSignature(row);
        if (!signature.replace(/\u0000/gu, '')) continue;
        result.set(signature, row);
    }
    return [...result.values()];
}

function recoveryModeFromProbe({ credential, model, capability, probe, previous = null } = {}) {
    const transport = transportName(probe?.transport);
    return {
        ...(previous || {}),
        provider: credential.provider,
        envName: credential.name,
        masked: credential.masked,
        model,
        capability,
        endpoint: clean(probe?.endpoint),
        preferredTransport: transport,
        fallbackTransport: '',
        fallbackEndpoint: '',
        nonStreamOk: transport === 'non_stream',
        streamOk: transport === 'stream',
        reasoningModes: Array.isArray(previous?.reasoningModes) ? previous.reasoningModes : [],
        reasoningPolicies: previous?.reasoningPolicies && typeof previous.reasoningPolicies === 'object' ? previous.reasoningPolicies : {},
        testedAt: Math.floor(Date.now() / 1000),
        recoveredBy: 'v145-third-recovery-sweep',
    };
}

async function probeCandidateMode({ credential, candidate, fetchImpl, timeoutMs, env }) {
    const attempts = [];
    const transports = ['non_stream', 'stream'];
    for (const transport of transports) {
        const probe = candidate.capability === 'image'
            ? await probeAiRecoveryImageTransport({
                fetchImpl,
                credential,
                model: candidate.model,
                transport,
                timeoutMs,
                nvidiaVisualBaseUrl: clean(env.NVIDIA_IMAGE_BASE_URL),
            })
            : await probeAiRecoveryTextTransport({
                fetchImpl,
                credential,
                model: candidate.model,
                transport,
                timeoutMs,
                reasoningLevel: '',
            });
        attempts.push(probe);
        if (probe.ok) return { ok: true, probe, attempts, stop: '' };
        const stop = classifyKeyStop({ ...probe, provider: credential.provider });
        if (stop) return { ok: false, probe, attempts, stop };
        if (!isTransientFailure({ ...probe, provider: credential.provider })) break;
    }
    return { ok: false, probe: attempts.at(-1) || null, attempts, stop: '' };
}

async function controlLateMode({ credential, mode, fetchImpl, timeoutMs, env }) {
    const preferred = transportName(mode.preferredTransport) || (mode.nonStreamOk ? 'non_stream' : mode.streamOk ? 'stream' : 'non_stream');
    const fallback = transportName(mode.fallbackTransport);
    const order = unique([preferred, fallback, oppositeTransport(preferred)]).slice(0, 2);
    const attempts = [];
    for (const transport of order) {
        const probe = mode.capability === 'image'
            ? await probeAiRecoveryImageTransport({
                fetchImpl,
                credential,
                model: mode.model,
                transport,
                timeoutMs,
                nvidiaVisualBaseUrl: clean(env.NVIDIA_IMAGE_BASE_URL),
            })
            : await probeAiRecoveryTextTransport({
                fetchImpl,
                credential,
                model: mode.model,
                transport,
                timeoutMs,
                reasoningLevel: '',
            });
        attempts.push(probe);
        if (probe.ok) {
            const controlled = recoveryModeFromProbe({ credential, model: mode.model, capability: mode.capability, probe, previous: mode });
            if (transport === preferred) {
                controlled.fallbackTransport = mode.fallbackTransport || '';
                controlled.fallbackEndpoint = mode.fallbackEndpoint || '';
                controlled.nonStreamOk = Boolean(mode.nonStreamOk || transport === 'non_stream');
                controlled.streamOk = Boolean(mode.streamOk || transport === 'stream');
            }
            return { status: transport === preferred ? 'stable' : 'transport-switched', mode: controlled, attempts, stop: '' };
        }
        const stop = classifyKeyStop({ ...probe, provider: credential.provider });
        if (stop) return { status: 'failed', mode, attempts, stop };
    }
    const definitiveModelFailure = attempts.length > 0 && attempts.every((probe) => {
        const failure = classifyAiAuditFailure({ ...probe, provider: credential.provider });
        return failure.kind === 'deprecated';
    });
    return { status: definitiveModelFailure ? 'remove-mode' : 'unstable-keep', mode, attempts, stop: '' };
}

async function runLimited(items, worker, limit = 1) {
    const results = new Array(items.length);
    let cursor = 0;
    async function loop() {
        while (true) {
            const index = cursor;
            cursor += 1;
            if (index >= items.length) return;
            results[index] = await worker(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(Math.max(1, limit), Math.max(1, items.length)) }, () => loop()));
    return results;
}

async function loadCompletedJsonl(path) {
    try {
        const text = await readFile(path, 'utf8');
        const rows = [];
        for (const line of text.split(/\r?\n/u)) {
            if (!line.trim()) continue;
            try { rows.push(JSON.parse(line)); } catch { /* keep valid rows */ }
        }
        return rows;
    } catch (error) {
        if (error?.code === 'ENOENT') return [];
        throw error;
    }
}

function resultSignature(row = {}) {
    return clean(row.signature);
}

function selectUncertainRows(report = {}) {
    return (report?.keySecondSweep?.results || []).filter((row) => clean(row?.verdict) === 'uncertain');
}

export async function runThirdRecoverySweep({
    report,
    sourceOutDir = report?.outDir || '',
    env = process.env,
    directory = process.cwd(),
    fetchImpl = globalThis.fetch,
    keyAuditRunner = runConfiguredAiKeyAudit,
    now = new Date(),
    onProgress = null,
    force = false,
} = {}) {
    if (!report || typeof report !== 'object') throw new Error('Для третьего обхода нужен report.json завершённого полного аудита.');
    const baseOutDir = clean(sourceOutDir) || clean(report.outDir) || directory;
    const outDir = resolve(baseOutDir, 'THIRD_RECOVERY_SWEEP_V145');
    const jsonlPath = resolve(outDir, 'results.jsonl');
    const statusPath = resolve(outDir, 'THIRD_SWEEP_STATUS.json');
    const summaryPath = resolve(outDir, 'third_recovery_sweep.json');
    const donePath = resolve(outDir, 'THIRD_SWEEP_DONE.json');
    if (force) await rm(outDir, { recursive: true, force: true });
    await mkdir(outDir, { recursive: true });

    if (!force) {
        try {
            const done = JSON.parse(await readFile(donePath, 'utf8'));
            const summary = JSON.parse(await readFile(summaryPath, 'utf8'));
            if (done?.status === 'completed' && summary?.status === 'completed') {
                return { ...summary, outDir, jsonlPath, statusPath, summaryPath, donePath, resumedCompleted: true };
            }
        } catch {
            // No complete sweep yet: resume from JSONL below.
        }
    }

    const config = {
        textPerUncertainKey: boundedInt(env.AI_THIRD_SWEEP_TEXT_MODELS_PER_KEY, DEFAULT_TEXT_PER_UNCERTAIN_KEY, 0, 30),
        imagePerUncertainKey: boundedInt(env.AI_THIRD_SWEEP_IMAGE_MODELS_PER_KEY, DEFAULT_IMAGE_PER_UNCERTAIN_KEY, 0, 10),
        keyConcurrency: boundedInt(env.AI_THIRD_SWEEP_KEY_CONCURRENCY, DEFAULT_KEY_CONCURRENCY, 1, 4),
        timeoutMs: boundedInt(env.AI_THIRD_SWEEP_TIMEOUT_MS, DEFAULT_TIMEOUT_MS, 30_000, 300_000),
        catalogTimeoutMs: boundedInt(env.AI_THIRD_SWEEP_CATALOG_TIMEOUT_MS, DEFAULT_CATALOG_TIMEOUT_MS, 15_000, 120_000),
        catalogRetryDelayMs: boundedInt(env.AI_THIRD_SWEEP_CATALOG_RETRY_DELAY_MS, DEFAULT_CATALOG_RETRY_DELAY_MS, 0, 30_000),
    };

    const credentials = collectAuditableAiCredentials(env);
    const credentialByKey = new Map(credentials.map((credential) => [keySignature({ provider: credential.provider, envName: credential.name }), credential]));
    const uncertainRows = selectUncertainRows(report);
    const lateModes = collectThirdRecoveryLateModes(report);
    const completedRows = await loadCompletedJsonl(jsonlPath);
    const completedBySignature = new Map(completedRows.map((row) => [resultSignature(row), row]).filter(([signature]) => signature));
    let writeChain = Promise.resolve();
    const append = (row) => {
        completedBySignature.set(row.signature, row);
        writeChain = writeChain.then(() => appendFile(jsonlPath, `${JSON.stringify(row)}\n`, 'utf8'));
        return writeChain;
    };
    const writeStatus = (payload) => writeFile(statusPath, JSON.stringify(payload, null, 2), 'utf8');

    await writeStatus({
        status: 'running',
        startedAt: now.toISOString(),
        sourceAuditCheckedAt: clean(report.checkedAt),
        sourceOutDir: baseOutDir,
        uncertainKeys: uncertainRows.length,
        lateModes: lateModes.length,
        config,
    });

    const recoveredModes = [];
    const controlledModeUpdates = [];
    const removeModeSignatures = new Set();
    const quotaEnvNames = new Set();
    const invalidEnvNames = new Set();
    const blockedEnvNames = new Set();
    const rateLimitedEnvNames = new Set();
    const stillUncertainEnvNames = new Set();
    const missingCredentialEnvNames = new Set();
    const catalogRows = [];
    const uncertainModelRows = [];
    const controlRows = [];

    await runLimited(uncertainRows, async (sweepRow, keyIndex) => {
        const keyId = keySignature(sweepRow);
        const credential = credentialByKey.get(keyId);
        if (!credential) {
            missingCredentialEnvNames.add(clean(sweepRow.envName));
            return;
        }

        const catalogSig = attemptSignature('catalog', sweepRow);
        let catalogRecord = completedBySignature.get(catalogSig) || null;
        if (!catalogRecord) {
            await onProgress?.({ stage: 'third-key-start', index: keyIndex + 1, total: uncertainRows.length, provider: sweepRow.provider, envName: sweepRow.envName, masked: sweepRow.masked });
            let liveAudit = await keyAuditRunner({
                env,
                onlyEnvNames: [credential.name],
                timeoutMs: config.catalogTimeoutMs,
                concurrency: 1,
                fetchImpl,
            });
            let live = liveAudit.results?.[0] || { ok: false, status: 0, error: 'catalog result missing', models: [] };
            if (!live.ok && isTransientFailure({ ...live, provider: credential.provider })) {
                await sleep(config.catalogRetryDelayMs);
                const retryAudit = await keyAuditRunner({
                    env,
                    onlyEnvNames: [credential.name],
                    timeoutMs: config.catalogTimeoutMs,
                    concurrency: 1,
                    fetchImpl,
                });
                const retry = retryAudit.results?.[0];
                if (retry) live = { ...retry, firstAttempt: live };
            }
            const stop = classifyKeyStop({ ...live, provider: credential.provider });
            catalogRecord = {
                signature: catalogSig,
                type: 'catalog',
                provider: credential.provider,
                envName: credential.name,
                masked: credential.masked,
                ok: Boolean(live.ok),
                status: Number(live.status || 0),
                error: clean(live.error),
                stop,
                models: (live.models || []).map((model) => ({ ...model, capabilities: model.capabilities || classifyModelCapabilities(credential.provider, model) })),
                completedAt: new Date().toISOString(),
            };
            await append(catalogRecord);
        }
        catalogRows.push(catalogRecord);
        if (catalogRecord.stop === 'quota') { quotaEnvNames.add(credential.name); return; }
        if (catalogRecord.stop === 'invalid') { invalidEnvNames.add(credential.name); return; }
        if (catalogRecord.stop === 'blocked') { blockedEnvNames.add(credential.name); return; }
        if (catalogRecord.stop === 'rate-limit') { rateLimitedEnvNames.add(credential.name); return; }
        if (!catalogRecord.ok) { stillUncertainEnvNames.add(credential.name); return; }

        const candidates = buildThirdRecoveryModelCandidates({
            sweepRow,
            liveModels: catalogRecord.models,
            textLimit: config.textPerUncertainKey,
            imageLimit: config.imagePerUncertainKey,
        });
        let recoveredForKey = 0;
        for (let modelIndex = 0; modelIndex < candidates.length; modelIndex += 1) {
            const candidate = candidates[modelIndex];
            const signature = attemptSignature('uncertain-model', { ...sweepRow, ...candidate });
            let row = completedBySignature.get(signature) || null;
            if (!row) {
                await onProgress?.({ stage: 'third-model-start', provider: credential.provider, envName: credential.name, masked: credential.masked, model: candidate.model, capability: candidate.capability, index: modelIndex + 1, total: candidates.length });
                const probed = await probeCandidateMode({ credential, candidate, fetchImpl, timeoutMs: config.timeoutMs, env });
                row = {
                    signature,
                    type: 'uncertain-model',
                    provider: credential.provider,
                    envName: credential.name,
                    masked: credential.masked,
                    model: candidate.model,
                    capability: candidate.capability,
                    ok: Boolean(probed.ok),
                    stop: probed.stop,
                    attempts: probed.attempts,
                    recoveredMode: probed.ok ? recoveryModeFromProbe({ credential, model: candidate.model, capability: candidate.capability, probe: probed.probe }) : null,
                    completedAt: new Date().toISOString(),
                };
                await append(row);
            }
            uncertainModelRows.push(row);
            if (row.ok && row.recoveredMode) {
                recoveredModes.push(row.recoveredMode);
                recoveredForKey += 1;
            }
            if (row.stop === 'quota') { quotaEnvNames.add(credential.name); break; }
            if (row.stop === 'invalid') { invalidEnvNames.add(credential.name); break; }
            if (row.stop === 'blocked') { blockedEnvNames.add(credential.name); break; }
            if (row.stop === 'rate-limit') { rateLimitedEnvNames.add(credential.name); break; }
        }
        if (!recoveredForKey && !quotaEnvNames.has(credential.name) && !invalidEnvNames.has(credential.name) && !blockedEnvNames.has(credential.name) && !rateLimitedEnvNames.has(credential.name)) {
            stillUncertainEnvNames.add(credential.name);
        }
        await onProgress?.({ stage: 'third-key-complete', index: keyIndex + 1, total: uncertainRows.length, provider: credential.provider, envName: credential.name, recoveredModes: recoveredForKey });
    }, config.keyConcurrency);

    const lateModesByKey = new Map();
    for (const mode of lateModes) {
        const keyId = keySignature(mode);
        if (!lateModesByKey.has(keyId)) lateModesByKey.set(keyId, []);
        lateModesByKey.get(keyId).push(mode);
    }
    const controlGroups = [...lateModesByKey.entries()];
    await runLimited(controlGroups, async ([keyId, modes], keyIndex) => {
        const credential = credentialByKey.get(keyId);
        if (!credential) {
            for (const mode of modes) missingCredentialEnvNames.add(clean(mode.envName));
            return;
        }
        if (quotaEnvNames.has(credential.name) || invalidEnvNames.has(credential.name)) return;
        for (let index = 0; index < modes.length; index += 1) {
            const mode = modes[index];
            const signature = attemptSignature('control', mode);
            let row = completedBySignature.get(signature) || null;
            if (!row) {
                await onProgress?.({ stage: 'third-control-start', keyIndex: keyIndex + 1, keyTotal: controlGroups.length, index: index + 1, total: modes.length, provider: mode.provider, envName: mode.envName, model: mode.model, capability: mode.capability });
                const controlled = await controlLateMode({ credential, mode, fetchImpl, timeoutMs: config.timeoutMs, env });
                row = {
                    signature,
                    type: 'control',
                    provider: mode.provider,
                    envName: mode.envName,
                    masked: mode.masked,
                    model: mode.model,
                    capability: mode.capability,
                    status: controlled.status,
                    stop: controlled.stop,
                    attempts: controlled.attempts,
                    controlledMode: ['stable', 'transport-switched'].includes(controlled.status) ? controlled.mode : null,
                    completedAt: new Date().toISOString(),
                };
                await append(row);
            }
            controlRows.push(row);
            if (row.controlledMode) controlledModeUpdates.push(row.controlledMode);
            if (row.status === 'remove-mode') removeModeSignatures.add(modeSignature(mode));
            if (row.stop === 'quota') { quotaEnvNames.add(credential.name); break; }
            if (row.stop === 'invalid') { invalidEnvNames.add(credential.name); break; }
            if (row.stop === 'blocked') { blockedEnvNames.add(credential.name); break; }
            if (row.stop === 'rate-limit') { rateLimitedEnvNames.add(credential.name); break; }
        }
    }, config.keyConcurrency);

    await writeChain;

    const keyRemovals = new Set([...quotaEnvNames, ...invalidEnvNames]);
    let updatedModes = (report.workingModes || []).filter((mode) => !keyRemovals.has(clean(mode.envName)) && !removeModeSignatures.has(modeSignature(mode)));
    const updatesBySignature = new Map(controlledModeUpdates.map((mode) => [modeSignature(mode), mode]));
    updatedModes = updatedModes.map((mode) => updatesBySignature.get(modeSignature(mode)) || mode);
    updatedModes = dedupeModes([...updatedModes, ...recoveredModes]);

    const summary = {
        status: 'completed',
        version: 'V145',
        startedAt: now.toISOString(),
        finishedAt: new Date().toISOString(),
        sourceAuditCheckedAt: clean(report.checkedAt),
        sourceOutDir: baseOutDir,
        config,
        selected: {
            uncertainKeys: uncertainRows.length,
            lateRecoveredModes: lateModes.length,
        },
        stats: {
            catalogChecks: catalogRows.length,
            uncertainModelCandidatesTested: uncertainModelRows.length,
            recoveredKeys: new Set(recoveredModes.map((mode) => `${mode.provider}:${mode.envName}`)).size,
            recoveredModes: recoveredModes.length,
            controlledLateModes: controlRows.length,
            stableLateModes: controlRows.filter((row) => row.status === 'stable').length,
            transportSwitched: controlRows.filter((row) => row.status === 'transport-switched').length,
            unstableLateModesKept: controlRows.filter((row) => row.status === 'unstable-keep').length,
            removedDeprecatedModes: removeModeSignatures.size,
            runtimeModesBefore: (report.workingModes || []).length,
            runtimeModesAfter: updatedModes.length,
        },
        quotaEnvNames: [...quotaEnvNames].sort(),
        invalidEnvNames: [...invalidEnvNames].sort(),
        blockedEnvNames: [...blockedEnvNames].sort(),
        rateLimitedEnvNames: [...rateLimitedEnvNames].sort(),
        stillUncertainEnvNames: [...stillUncertainEnvNames].sort(),
        missingCredentialEnvNames: [...missingCredentialEnvNames].sort(),
        recoveredModes,
        controlledModeUpdates,
        removedModeSignatures: [...removeModeSignatures],
        updatedWorkingModes: updatedModes,
        catalogResults: catalogRows,
        uncertainModelResults: uncertainModelRows,
        controlResults: controlRows,
    };
    await writeFile(summaryPath, JSON.stringify(summary, null, 2), 'utf8');
    await writeFile(donePath, JSON.stringify({
        status: 'completed',
        finishedAt: summary.finishedAt,
        sourceAuditCheckedAt: summary.sourceAuditCheckedAt,
        recoveredModes: summary.stats.recoveredModes,
        stillUncertainKeys: summary.stillUncertainEnvNames.length,
        quotaKeys: summary.quotaEnvNames.length,
        invalidKeys: summary.invalidEnvNames.length,
        outDir,
    }, null, 2), 'utf8');
    await writeStatus({ status: 'completed', finishedAt: summary.finishedAt, outDir, stats: summary.stats });
    await onProgress?.({ stage: 'third-complete', ...summary.stats });
    return { ...summary, outDir, jsonlPath, statusPath, summaryPath, donePath, resumedCompleted: false };
}

export const THIRD_RECOVERY_SWEEP_DEFAULTS = Object.freeze({
    textPerUncertainKey: DEFAULT_TEXT_PER_UNCERTAIN_KEY,
    imagePerUncertainKey: DEFAULT_IMAGE_PER_UNCERTAIN_KEY,
    keyConcurrency: DEFAULT_KEY_CONCURRENCY,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    catalogTimeoutMs: DEFAULT_CATALOG_TIMEOUT_MS,
    textPrompt: FULL_AI_AUDIT_DEFAULTS.textPrompt,
    imagePrompt: FULL_AI_AUDIT_DEFAULTS.imagePrompt,
});
