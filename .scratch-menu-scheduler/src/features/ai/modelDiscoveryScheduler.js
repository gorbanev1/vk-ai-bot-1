import { appendFile, mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { collectConfiguredAiCredentials, runConfiguredAiKeyAudit } from './providerKeyAudit.js';
import { runFullAiAudit } from './fullAiAudit.js';
import {
    getMaintenanceState,
    setMaintenanceState,
    recordAiModelDiscoveries,
    getAiModelDiscoveryRows,
    saveAiModelQualification,
} from '../../infrastructure/database/index.js';

export const AI_MODEL_DISCOVERY_STATE_KEY = 'ai-model-discovery-v18849';
export const AI_MODEL_DISCOVERY_TIME_ZONE = 'Europe/Moscow';
export const AI_MODEL_DISCOVERY_HOUR = 3;
export const AI_MODEL_DISCOVERY_DAILY_DAYS = 14;
export const AI_MODEL_DISCOVERY_WEEKDAY = 1; // Monday, ISO-like JS local weekday mapping below.
export const AI_MODEL_DISCOVERY_TICK_MS = 15 * 60 * 1000;

function clean(value) { return String(value ?? '').trim(); }

function localParts(date = new Date(), timeZone = AI_MODEL_DISCOVERY_TIME_ZONE) {
    const parts = new Intl.DateTimeFormat('en-CA', {
        timeZone, year: 'numeric', month: '2-digit', day: '2-digit', weekday: 'short',
        hour: '2-digit', minute: '2-digit', hourCycle: 'h23',
    }).formatToParts(date);
    const map = Object.fromEntries(parts.map((part) => [part.type, part.value]));
    const weekdayMap = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 };
    return {
        dateKey: `${map.year}-${map.month}-${map.day}`,
        hour: Number(map.hour || 0),
        minute: Number(map.minute || 0),
        weekday: weekdayMap[map.weekday] ?? -1,
    };
}

function weekKey(date = new Date(), timeZone = AI_MODEL_DISCOVERY_TIME_ZONE) {
    const p = localParts(date, timeZone);
    const anchor = new Date(`${p.dateKey}T12:00:00Z`);
    const day = p.weekday < 0 ? anchor.getUTCDay() : p.weekday;
    anchor.setUTCDate(anchor.getUTCDate() - ((day + 6) % 7));
    return anchor.toISOString().slice(0, 10);
}

export function resolveAiModelDiscoverySchedule({ now = new Date(), state = {} } = {}) {
    const nowMs = now.getTime();
    const startedAt = Number(state?.startedAt || 0) || nowMs;
    const elapsedDays = Math.floor(Math.max(0, nowMs - startedAt) / 86_400_000);
    const local = localParts(now);
    if (local.hour < AI_MODEL_DISCOVERY_HOUR) {
        return { due: false, phase: elapsedDays < AI_MODEL_DISCOVERY_DAILY_DAYS ? 'daily' : 'weekly', startedAt, local };
    }
    if (elapsedDays < AI_MODEL_DISCOVERY_DAILY_DAYS) {
        return {
            due: clean(state?.lastDailyDate) !== local.dateKey,
            phase: 'daily', startedAt, local, slotKey: local.dateKey,
        };
    }
    const currentWeek = weekKey(now);
    return {
        due: local.weekday === AI_MODEL_DISCOVERY_WEEKDAY && clean(state?.lastWeeklyKey) !== currentWeek,
        phase: 'weekly', startedAt, local, slotKey: currentWeek,
    };
}

async function appendDiscoveryLog(directory, row) {
    const date = new Date().toISOString().slice(0, 10);
    const logDirectory = resolve(directory, 'data', 'logs', 'model-discovery');
    await mkdir(logDirectory, { recursive: true });
    const path = resolve(logDirectory, `${date}.jsonl`);
    await appendFile(path, `${JSON.stringify({ ts: new Date().toISOString(), ...row })}\n`, 'utf8');
    return path;
}

function flattenCatalogRows(keyAudit) {
    const rows = [];
    for (const key of keyAudit?.results || []) {
        for (const model of key?.models || []) {
            const id = clean(model?.id);
            if (!id) continue;
            rows.push({
                provider: clean(key.provider), envName: clean(key.envName), masked: clean(key.masked),
                model: id, capabilities: Array.isArray(model.capabilities) ? model.capabilities.map(String) : [],
            });
        }
    }
    return rows;
}

const AUDIT_PIXEL_DATA_URL = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Wl2n1cAAAAASUVORK5CYII=';

async function readJsonResponse(response) {
    const raw = await response.text();
    let payload = null;
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = null; }
    return { raw, payload };
}

function openAiLikeCredential(credential) {
    return ['openai', 'openai-compatible', 'xai', 'groq', 'nvidia'].includes(clean(credential?.provider));
}

async function probeDiscoveryChatMode({ credential, model, mode, timeoutMs = 30_000 }) {
    if (!credential || !openAiLikeCredential(credential)) {
        return { tested: false, ok: false, status: 0, mode, error: 'provider probe unsupported' };
    }
    const body = {
        model,
        messages: [{ role: 'user', content: 'GIGORAVE qualification probe. Follow the requested API mode exactly.' }],
        stream: false,
    };
    if (mode === 'vision') {
        body.messages = [{
            role: 'user',
            content: [
                { type: 'text', text: 'Reply with GIGORAVE_VISION_OK if you can inspect this image.' },
                { type: 'image_url', image_url: { url: AUDIT_PIXEL_DATA_URL, detail: 'low' } },
            ],
        }];
    } else if (mode === 'json') {
        body.messages = [{ role: 'user', content: 'Return a JSON object with exactly one boolean field named ok set to true.' }];
        body.response_format = { type: 'json_object' };
    } else if (mode === 'tools') {
        body.messages = [{ role: 'user', content: 'Call audit_ok with value GIGORAVE_TOOL_OK.' }];
        body.tools = [{ type: 'function', function: { name: 'audit_ok', description: 'Qualification tool', parameters: { type: 'object', properties: { value: { type: 'string' } }, required: ['value'], additionalProperties: false } } }];
        body.tool_choice = { type: 'function', function: { name: 'audit_ok' } };
    } else if (String(mode).startsWith('reasoning:')) {
        const level = String(mode).slice('reasoning:'.length);
        body.messages = [{ role: 'user', content: 'Reply with GIGORAVE_REASONING_OK.' }];
        body.reasoning_effort = level;
    }
    const startedAt = Date.now();
    try {
        const response = await fetch(`${clean(credential.baseUrl).replace(/\/$/u, '')}/chat/completions`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${credential.secret}`, 'Content-Type': 'application/json', Accept: 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
        const { raw, payload } = await readJsonResponse(response);
        let ok = Boolean(response.ok);
        if (ok && mode === 'vision') {
            const text = JSON.stringify(payload?.choices?.[0]?.message?.content ?? '');
            ok = /GIGORAVE_VISION_OK/iu.test(text);
        } else if (ok && mode === 'json') {
            const content = payload?.choices?.[0]?.message?.content;
            try { ok = Boolean(JSON.parse(typeof content === 'string' ? content : JSON.stringify(content))?.ok); } catch { ok = false; }
        } else if (ok && mode === 'tools') {
            ok = Array.isArray(payload?.choices?.[0]?.message?.tool_calls) && payload.choices[0].message.tool_calls.length > 0;
        } else if (ok && String(mode).startsWith('reasoning:')) {
            const text = JSON.stringify(payload?.choices?.[0]?.message?.content ?? '');
            ok = /GIGORAVE_REASONING_OK/iu.test(text);
        }
        return {
            tested: true, ok, status: Number(response.status || 0), mode,
            elapsedMs: Date.now() - startedAt,
            error: ok ? '' : clean(payload?.error?.message || payload?.message || raw).slice(0, 1000),
        };
    } catch (error) {
        return { tested: true, ok: false, status: 0, mode, elapsedMs: Date.now() - startedAt, error: clean(error?.message || error).slice(0, 1000) };
    }
}

async function runDiscoverySpecialModeTests(discovery, credential) {
    const tests = {};
    if ((discovery.capabilities || []).includes('vision')) {
        tests.vision = await probeDiscoveryChatMode({ credential, model: discovery.model, mode: 'vision' });
    }
    if ((discovery.capabilities || []).includes('text')) {
        tests.json = await probeDiscoveryChatMode({ credential, model: discovery.model, mode: 'json' });
        tests.tools = await probeDiscoveryChatMode({ credential, model: discovery.model, mode: 'tools' });
        tests.intelligence = {};
        for (const level of ['none', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max']) {
            tests.intelligence[level] = await probeDiscoveryChatMode({ credential, model: discovery.model, mode: `reasoning:${level}` });
        }
    }
    return tests;
}

function isTemporaryProbeFailure(probe) {
    if (!probe || probe.ok || probe.keep) return false;
    const status = Number(probe.status || 0);
    if (!status || [408, 409, 425, 429].includes(status) || status >= 500) return true;
    return /timeout|timed out|abort|network|socket|fetch|econn|etimedout|temporar|rate limit|overload|unavailable/iu.test(clean(probe.error));
}

function auditRowHasTemporaryFailure(row) {
    if (!row || row.keep) return false;
    const attempts = [
        row.nonStream,
        row.stream,
        ...(Array.isArray(row.reasoningResults) ? row.reasoningResults.flatMap((item) => [item.nonStream, item.stream, item]) : []),
    ].filter(Boolean);
    return attempts.some(isTemporaryProbeFailure);
}

function runtimeAutoPromotionSupported(provider) {
    return ['openai-compatible', 'xai'].includes(clean(provider));
}

function qualificationForModel(discovery, audit, specialTests = {}) {
    const match = (row) => row?.provider === discovery.provider && row?.envName === discovery.envName && row?.model === discovery.model;
    const text = (audit?.textResults || []).find(match) || null;
    const image = (audit?.imageResults || []).find(match) || null;
    const capabilities = Array.isArray(discovery.capabilities) ? discovery.capabilities : [];
    const required = capabilities.filter((cap) => cap === 'text' || cap === 'image' || cap === 'vision');
    const results = {
        text: text ? {
            tested: true, keep: Boolean(text.keep), preferredTransport: clean(text.preferredTransport),
            fallbackTransport: clean(text.fallbackTransport), reasoningModesSupported: text.reasoningModesSupported || [],
            reasoningResults: (text.reasoningResults || []).map((item) => ({
                level: item.level, keep: Boolean(item.keep), preferredTransport: clean(item.preferredTransport), fallbackTransport: clean(item.fallbackTransport),
            })),
        } : { tested: false, keep: false },
        image: image ? {
            tested: true, keep: Boolean(image.keep), preferredTransport: clean(image.preferredTransport), fallbackTransport: clean(image.fallbackTransport),
        } : { tested: false, keep: false },
        vision: specialTests.vision ? { tested: Boolean(specialTests.vision.tested), keep: Boolean(specialTests.vision.ok), ...specialTests.vision } : { tested: false, keep: false },
        json: specialTests.json || { tested: false, ok: false },
        tools: specialTests.tools || { tested: false, ok: false },
        intelligence: specialTests.intelligence || {},
    };
    const supportedRequired = required.filter((cap) => results[cap]?.tested);
    const allRequiredTested = required.length > 0 && required.every((cap) => results[cap]?.tested);
    const allPassed = allRequiredTested && required.every((cap) => results[cap]?.keep);
    const textPassed = capabilities.includes('text') && Boolean(results.text?.keep);
    const specialTemporary = [
        specialTests.vision,
        specialTests.json,
        specialTests.tools,
        ...Object.values(specialTests.intelligence || {}),
    ].filter(Boolean).some(isTemporaryProbeFailure);
    const auditTemporary = auditRowHasTemporaryFailure(text) || auditRowHasTemporaryFailure(image);
    const temporaryFailure = !allPassed && (specialTemporary || auditTemporary);
    const status = allPassed
        ? 'qualified'
        : temporaryFailure
            ? 'pending'
            : supportedRequired.length
                ? 'failed'
                : 'unsupported';
    const promoted = allPassed && textPassed && runtimeAutoPromotionSupported(discovery.provider);
    return {
        status,
        promoted,
        details: {
            capabilities,
            requiredCapabilities: required,
            testedCapabilities: supportedRequired,
            tests: results,
            temporaryFailure,
            runtimeAutoPromotionSupported: runtimeAutoPromotionSupported(discovery.provider),
            runtimePromotionReason: promoted
                ? 'qualified-and-runtime-adapter-supported'
                : allPassed && textPassed
                    ? 'qualified-but-runtime-failover-adapter-not-supported'
                    : 'not-qualified-for-runtime-promotion',
            auditOutDir: clean(audit?.outDir),
            auditJsonPath: clean(audit?.jsonPath),
            testedAt: new Date().toISOString(),
        },
    };
}

export function formatModelDiscoveryOwnerReport(result) {
    const lines = [
        `🧭 AI model discovery: ${result.phase === 'weekly' ? 'недельный полный обход' : 'ежедневный обход'}.`,
        `Ключей: ${result.keyAudit?.total || 0}; catalog OK: ${result.keyAudit?.valid || 0}; FAIL: ${result.keyAudit?.invalid || 0}.`,
        `Моделей в каталогах: ${result.catalogRows?.length || 0}; новых: ${result.newModels?.length || 0}.`,
    ];
    if (result.fullAudit) {
        lines.push(
            `Полный qualification: text ${result.fullAudit.stats?.textModelsKept || 0}/${result.fullAudit.stats?.textModels || 0}; image ${result.fullAudit.stats?.imageModelsKept || 0}/${result.fullAudit.stats?.imageModels || 0}; reasoning OK=${result.fullAudit.stats?.reasoningModesOk || 0}.`,
        );
    }
    const qualificationRows = (result.qualified || []).filter((row) => row.isNew || row.status !== 'qualified');
    const displayRows = result.phase === 'weekly' ? qualificationRows.slice(0, 40) : (result.qualified || []);
    for (const row of displayRows) {
        lines.push(`${row.status === 'qualified' ? '✅' : row.status === 'pending' ? '⏳' : row.status === 'unsupported' ? '➖' : '❌'} ${row.isNew ? '[NEW] ' : ''}${row.provider}/${row.envName}: ${row.model} — ${row.status}${row.promoted ? ' · добавлена в failover ladder' : ''}`);
        if (row.status === 'qualified' && !row.promoted && row.details?.runtimePromotionReason === 'qualified-but-runtime-failover-adapter-not-supported') {
            lines.push('   квалификация пройдена; в общий failover не добавлена: для provider нет безопасного runtime-adapter этой лестницы.');
        }
        const intelligence = row.details?.tests?.intelligence || {};
        const testedLevels = Object.entries(intelligence).filter(([, probe]) => probe?.tested);
        if (testedLevels.length) {
            const okLevels = testedLevels.filter(([, probe]) => probe?.ok).map(([level]) => level);
            const failedLevels = testedLevels.filter(([, probe]) => !probe?.ok).map(([level]) => level);
            lines.push(`   intelligence OK: ${okLevels.join(', ') || '—'}${failedLevels.length ? `; unsupported/FAIL: ${failedLevels.join(', ')}` : ''}`);
        } else {
            const modes = row.details?.tests?.text?.reasoningModesSupported || [];
            if (modes.length) lines.push(`   intelligence/reasoning: ${modes.join(', ')}`);
        }
        const tests = row.details?.tests || {};
        const extras = ['vision', 'json', 'tools']
            .filter((name) => tests?.[name]?.tested)
            .map((name) => `${name}=${(tests[name].keep ?? tests[name].ok) ? 'OK' : 'FAIL'}`);
        if (extras.length) lines.push(`   modes: ${extras.join(', ')}`);
    }
    if (result.phase === 'weekly' && qualificationRows.length > displayRows.length) {
        lines.push(`Ещё проблемных/новых моделей в полном логе: ${qualificationRows.length - displayRows.length}.`);
    }
    lines.push(`Лог: ${result.logPath || 'не создан'}`);
    if (result.fullAudit?.outDir) lines.push(`Полный audit: ${result.fullAudit.outDir}`);
    return lines.join('\n');
}

export async function runAiModelDiscoveryCycle({
    env = process.env,
    directory = process.cwd(),
    now = new Date(),
    force = false,
    forceWeekly = false,
    onProgress = null,
    onRuntimeModes = null,
} = {}) {
    const previous = getMaintenanceState(AI_MODEL_DISCOVERY_STATE_KEY)?.details || {};
    const decision = forceWeekly
        ? { due: true, phase: 'weekly', startedAt: Number(previous.startedAt || now.getTime()), slotKey: weekKey(now), local: localParts(now) }
        : resolveAiModelDiscoverySchedule({ now, state: previous });
    if (!force && !decision.due) return { skipped: true, decision };

    const stateBase = { ...previous, startedAt: decision.startedAt || Number(previous.startedAt || now.getTime()) };
    let logPath = await appendDiscoveryLog(directory, { type: 'cycle.start', phase: decision.phase, slotKey: decision.slotKey || '', state: stateBase });
    const keyAudit = await runConfiguredAiKeyAudit({
        env, includeExcluded: true,
        timeoutMs: 30_000,
        concurrency: 8,
        onProgress: async (event) => {
            await appendDiscoveryLog(directory, { type: 'catalog.progress', event });
            await onProgress?.({ stage: 'catalog', ...event });
        },
    });
    const catalogRows = flattenCatalogRows(keyAudit);
    const seenAt = Math.floor(now.getTime() / 1000);
    const newModels = recordAiModelDiscoveries(catalogRows, seenAt);
    await appendDiscoveryLog(directory, { type: 'catalog.complete', keys: keyAudit.total, valid: keyAudit.valid, invalid: keyAudit.invalid, catalogModels: catalogRows.length, newModels });

    let fullAudit = null;
    const qualified = [];
    const catalogSignatures = new Set(catalogRows.map((row) => `${row.provider}\u0000${row.envName}\u0000${row.model}`));
    const pendingModels = getAiModelDiscoveryRows({ status: 'pending' }).filter((row) => catalogSignatures.has(`${row.provider}\u0000${row.envName}\u0000${row.model}`));
    if (decision.phase === 'weekly' || newModels.length > 0 || pendingModels.length > 0) {
        fullAudit = await runFullAiAudit({
            env, directory, now, clearPrevious: false, includeExcluded: true,
            onProgress: async (event) => {
                await appendDiscoveryLog(directory, { type: 'qualification.progress', event });
                await onProgress?.({ stage: 'qualification', ...event });
            },
        });
        await onRuntimeModes?.(fullAudit.workingModes || []);
        const targets = decision.phase === 'weekly'
            ? getAiModelDiscoveryRows().filter((row) => catalogSignatures.has(`${row.provider}\u0000${row.envName}\u0000${row.model}`))
            : [...newModels, ...pendingModels].filter((row, index, values) => values.findIndex((item) => item.provider === row.provider && item.envName === row.envName && item.model === row.model) === index);
        const newSignatures = new Set(newModels.map((row) => `${row.provider}\u0000${row.envName}\u0000${row.model}`));
        const credentials = collectConfiguredAiCredentials(env);
        for (const row of targets) {
            const current = row.qualificationStatus ? row : (getAiModelDiscoveryRows({ provider: row.provider, envName: row.envName, model: row.model })[0] || row);
            const credential = credentials.find((item) => item.provider === current.provider && item.name === current.envName) || null;
            const specialTests = await runDiscoverySpecialModeTests(current, credential);
            await appendDiscoveryLog(directory, { type: 'model.special-modes', provider: current.provider, envName: current.envName, model: current.model, tests: specialTests });
            const verdict = qualificationForModel(current, fullAudit, specialTests);
            saveAiModelQualification({
                provider: current.provider, envName: current.envName, model: current.model,
                status: verdict.status, details: verdict.details, promoted: verdict.promoted, qualifiedAt: Math.floor(Date.now() / 1000),
            });
            const saved = { ...current, ...verdict, isNew: newSignatures.has(`${current.provider}\u0000${current.envName}\u0000${current.model}`) };
            qualified.push(saved);
            await appendDiscoveryLog(directory, { type: 'model.qualification', provider: current.provider, envName: current.envName, model: current.model, status: verdict.status, promoted: verdict.promoted, details: verdict.details });
        }
    }

    const nextState = {
        ...stateBase,
        lastRunAt: now.getTime(),
        lastPhase: decision.phase,
        lastCatalogModels: catalogRows.length,
        lastNewModels: newModels.length,
        lastLogPath: logPath,
        ...(decision.phase === 'daily' ? { lastDailyDate: decision.slotKey || localParts(now).dateKey } : {}),
        ...(decision.phase === 'weekly' ? { lastWeeklyKey: decision.slotKey || weekKey(now) } : {}),
    };
    setMaintenanceState(AI_MODEL_DISCOVERY_STATE_KEY, { details: nextState, lastRunAt: seenAt });
    const result = { skipped: false, phase: decision.phase, decision, keyAudit, catalogRows, newModels, qualified, fullAudit, logPath };
    logPath = await appendDiscoveryLog(directory, { type: 'cycle.complete', phase: decision.phase, catalogModels: catalogRows.length, newModels: newModels.length, qualified: qualified.map((row) => ({ provider: row.provider, envName: row.envName, model: row.model, status: row.status, promoted: row.promoted })), auditOutDir: fullAudit?.outDir || '' });
    result.logPath = logPath;
    return result;
}
