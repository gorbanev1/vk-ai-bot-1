import {
    readdirSync,
    readFileSync,
    renameSync,
    writeFileSync,
} from 'node:fs';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { AsyncLocalStorage } from 'node:async_hooks';
import { join, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { classifyInterruptedOperation } from './operationRecoveryPolicy.js';

export const DEFAULT_OPERATION_TIMEOUT_MS = 2 * 60 * 60 * 1000;
export const MAX_OPERATION_TIMEOUT_MS = Math.max(
    DEFAULT_OPERATION_TIMEOUT_MS,
    Math.min(72 * 60 * 60 * 1000, (Number(process.env.OPERATION_MAX_TIMEOUT_HOURS) || 72) * 60 * 60 * 1000),
);
export const STOP_HANDLER_TIMEOUT_MS = 15_000;
export const OPERATION_LOG_DIRECTORY = resolve('data/logs/operations');
export const OPERATION_CHECKPOINT_DIRECTORY = resolve('data/operation-checkpoints');

const operationStorage = new AsyncLocalStorage();
const activeOperations = new Map();
const auditWriteTails = new Map();
const auditWriteErrors = new Map();
const CHECKPOINT_DEFER_MS = 1_500;

function isoNow() {
    return new Date().toISOString();
}

function dayKey(date = new Date()) {
    return date.toISOString().slice(0, 10);
}

function redactAuditString(value) {
    return String(value ?? '')
        .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [redacted]')
        .replace(/\bsk-[A-Za-z0-9_-]{12,}\b/gu, 'sk-[redacted]')
        .replace(/\bAIza[A-Za-z0-9_-]{20,}\b/gu, 'AIza[redacted]')
        .replace(/\b\d{6,}:[A-Za-z0-9_-]{20,}\b/gu, '[telegram-token-redacted]')
        .replace(/((?:api[_-]?key|secret|password|access[_-]?token|refresh[_-]?token|authorization)\s*[=:]\s*)[^\s,;]+/giu, '$1[redacted]');
}

function normalizeError(error) {
    if (!error) return null;
    return {
        name: redactAuditString(error?.name || 'Error').slice(0, 120),
        code: redactAuditString(error?.code || '').slice(0, 160),
        message: redactAuditString(error?.message || error).replace(/\s+/gu, ' ').slice(0, 4000),
        stack: redactAuditString(error?.stack || '').slice(0, 12000),
    };
}

function jsonSafe(value, depth = 0, seen = new WeakSet()) {
    if (value == null) return value;
    if (depth > 7) return '[max-depth]';
    if (typeof value === 'string') return redactAuditString(value).slice(0, 16000);
    if (typeof value === 'number' || typeof value === 'boolean') return value;
    if (typeof value === 'bigint') return String(value);
    if (value instanceof Error) return normalizeError(value);
    if (Array.isArray(value)) return value.slice(0, 200).map((item) => jsonSafe(item, depth + 1, seen));
    if (typeof value !== 'object') return String(value).slice(0, 4000);
    if (seen.has(value)) return '[circular]';
    seen.add(value);
    const output = {};
    for (const [key, child] of Object.entries(value).slice(0, 300)) {
        if (/^(?:secret|api[_-]?key|authorization|cookie|cookies|password|credentials?|access[_-]?token|refresh[_-]?token|bearer)$/iu.test(key)) {
            output[key] = '[redacted]';
            continue;
        }
        output[key] = jsonSafe(child, depth + 1, seen);
    }
    return output;
}

function appendAuditRow(row) {
    try {
        const path = join(OPERATION_LOG_DIRECTORY, `${dayKey()}.jsonl`);
        const previous = auditWriteTails.get(path) || Promise.resolve();
        const serialized = `${JSON.stringify(row)}\n`;
        const write = previous
            .then(async () => {
                await mkdir(OPERATION_LOG_DIRECTORY, { recursive: true });
                await appendFile(path, serialized, 'utf8');
            })
            .catch((error) => {
                const count = Number(auditWriteErrors.get(path) || 0) + 1;
                auditWriteErrors.set(path, count);
                if (count === 1 || count % 100 === 0) {
                    setImmediate(() => process.stderr.write(
                        `[OPERATION AUDIT WRITE ERROR] path=${path} count=${count} ${error?.code || ''} ${error?.message || error}\n`,
                    ));
                }
            });
        auditWriteTails.set(path, write);
        return write;
    } catch (error) {
        // Logging must never break the bot. Avoid console here to prevent recursion.
        void error;
        return Promise.resolve(false);
    }
}

function compactAuditSnapshot(value) {
    if (!value || typeof value !== 'object') return value ?? null;
    const output = {};
    for (const key of [
        'kind', 'phase', 'partyPool', 'sourceId', 'sourceCount', 'total', 'totalCandidates',
        'completed', 'completedCandidates', 'candidateCount', 'completedPosterGateRequests',
        'totalPosterGateRequests', 'phaseTwoModels', 'tracePath', 'runId', 'error', 'reason',
        'status', 'stopped', 'turboMode',
    ]) {
        if (!Object.prototype.hasOwnProperty.call(value, key)) continue;
        if (key === 'phaseTwoModels') {
            const models = value.phaseTwoModels?.models || {};
            output.phaseTwoModels = {
                stopped: Boolean(value.phaseTwoModels?.stopped),
                lunaFailureRatio: Number(value.phaseTwoModels?.lunaFailureRatio || 0),
                terraFailureRatio: Number(value.phaseTwoModels?.terraFailureRatio || 0),
                models: Object.fromEntries(Object.entries(models).map(([model, row]) => [model, {
                    attempts: Number(row?.attempts || 0),
                    completed: Number(row?.completed || 0),
                    successes: Number(row?.successes || 0),
                    failures: Number(row?.failures || 0),
                    capabilities: Object.fromEntries(Object.entries(row?.capabilities || {}).map(([capability, stats]) => [capability, {
                        attempts: Number(stats?.attempts || 0),
                        successes: Number(stats?.successes || 0),
                        failures: Number(stats?.failures || 0),
                    }])),
                }])) ,
            };
        } else {
            output[key] = jsonSafe(value[key]);
        }
    }
    if (!Object.keys(output).length) {
        output.keys = Object.keys(value).slice(0, 40);
    }
    return output;
}

function compactAuditResult(value) {
    if (value == null || typeof value !== 'object') return jsonSafe(value);
    if (Array.isArray(value)) return { type: 'array', length: value.length };
    const summary = compactAuditSnapshot(value);
    summary.keys = Object.keys(value).slice(0, 60);
    for (const key of ['results', 'items', 'events', 'sources', 'failures']) {
        if (Array.isArray(value[key])) summary[`${key}Count`] = value[key].length;
    }
    if (typeof value.message === 'string') summary.messageChars = value.message.length;
    return summary;
}

function collectRuntimeDiagnostics() {
    let activeResources = [];
    try {
        activeResources = typeof process.getActiveResourcesInfo === 'function'
            ? process.getActiveResourcesInfo().slice(0, 300)
            : [];
    } catch {
        activeResources = [];
    }
    let memory = {};
    try {
        memory = process.memoryUsage();
    } catch {
        memory = {};
    }
    return {
        pid: process.pid,
        uptimeSeconds: Math.round(process.uptime()),
        memory,
        activeResources,
    };
}

function firstFiniteNumber(...values) {
    for (const value of values) {
        const number = Number(value);
        if (Number.isFinite(number)) return number;
    }
    return null;
}

function buildUnfinishedState(record) {
    const progress = record?.progress && typeof record.progress === 'object' ? record.progress : {};
    const checkpoint = record?.checkpoint && typeof record.checkpoint === 'object' ? record.checkpoint : {};
    const total = firstFiniteNumber(
        progress.totalCandidates, progress.totalRecipients, progress.totalItems, progress.total,
        checkpoint.totalCandidates, checkpoint.totalRecipients, checkpoint.totalItems, checkpoint.total,
    );
    const completed = firstFiniteNumber(
        progress.completedCandidates, progress.completedRecipients, progress.completedItems, progress.completed,
        checkpoint.completedCandidates, checkpoint.completedRecipients, checkpoint.completedItems, checkpoint.completed,
    );
    const explicitRemaining = firstFiniteNumber(
        progress.unfinishedCandidates, progress.remainingRecipients, progress.remainingItems, progress.remaining,
        checkpoint.unfinishedCandidates, checkpoint.remainingRecipients, checkpoint.remainingItems, checkpoint.remaining,
    );
    const remaining = explicitRemaining ?? (total != null && completed != null ? Math.max(0, total - completed) : null);
    return jsonSafe({
        phase: progress.phase || checkpoint.phase || '',
        total,
        completed,
        remaining,
        lastCandidate: progress.lastCandidate || checkpoint.lastCandidate || null,
        pendingCount: firstFiniteNumber(checkpoint.pendingCount, checkpoint.unfinishedCandidates, progress.unfinishedCandidates),
        pendingCandidates: Array.isArray(checkpoint.pendingCandidates) ? checkpoint.pendingCandidates : [],
        failures: Array.isArray(checkpoint.failures) ? checkpoint.failures : [],
        tracePath: checkpoint.tracePath || '',
    });
}

function operationSnapshot(record, { includeCheckpoint = true } = {}) {
    return {
        id: record.id,
        name: record.name,
        category: record.category,
        status: record.status,
        startedAt: record.startedAt,
        deadlineAt: record.deadlineAt,
        updatedAt: record.updatedAt,
        finishedAt: record.finishedAt || '',
        elapsedMs: Math.max(0, Date.now() - record.startedAtMs),
        metadata: jsonSafe(record.metadata),
        progress: jsonSafe(record.progress),
        ...(includeCheckpoint ? { checkpoint: jsonSafe(record.checkpoint) } : {}),
        stopReason: record.stopReason || '',
        timedOut: Boolean(record.timedOut),
        abortRequested: Boolean(record.abortRequested),
        underlyingSettled: Boolean(record.underlyingSettled),
    };
}

function persistCheckpoint(record, reason = 'update') {
    if (record.checkpointWriteTimer) {
        clearTimeout(record.checkpointWriteTimer);
        record.checkpointWriteTimer = null;
    }
    const target = join(OPERATION_CHECKPOINT_DIRECTORY, `${record.id}.json`);
    const temporary = `${target}.tmp-${process.pid}-${randomUUID()}`;
    const payload = {
        version: 2,
        reason,
        savedAt: isoNow(),
        recovery: classifyInterruptedOperation(record),
        operation: operationSnapshot(record),
    };
    const serialized = `${JSON.stringify(payload, null, 2)}\n`;
    const previous = record.checkpointWriteTail || Promise.resolve();
    const write = previous
        .then(async () => {
            await mkdir(OPERATION_CHECKPOINT_DIRECTORY, { recursive: true });
            await writeFile(temporary, serialized, 'utf8');
            await rename(temporary, target);
        })
        .catch((error) => {
            setImmediate(() => process.stderr.write(
                `[OPERATION CHECKPOINT WRITE ERROR] id=${record.id} ${error?.code || ''} ${error?.message || error}\n`,
            ));
            return '';
        });
    record.checkpointWriteTail = write;
    return target;
}

function scheduleCheckpointPersistence(record, reason) {
    if (!record.checkpointWriteTimer) {
        record.checkpointWriteTimer = setTimeout(() => {
            record.checkpointWriteTimer = null;
            persistCheckpoint(record, reason);
        }, CHECKPOINT_DEFER_MS);
        record.checkpointWriteTimer.unref?.();
    }
    return join(OPERATION_CHECKPOINT_DIRECTORY, `${record.id}.json`);
}

export async function flushOperationCheckpoints() {
    const records = [...activeOperations.values()];
    for (const record of records) {
        if (record.checkpointWriteTimer) persistCheckpoint(record, 'shutdown-flush');
    }
    await Promise.all(records.map((record) => record.checkpointWriteTail));
}

export class OperationTimeoutError extends Error {
    constructor(message, operationId = '') {
        super(message);
        this.name = 'OperationTimeoutError';
        this.code = 'OPERATION_TIMEOUT';
        this.operationId = operationId;
    }
}

export class OperationCancelledError extends Error {
    constructor(message, operationId = '') {
        super(message);
        this.name = 'OperationCancelledError';
        this.code = 'OPERATION_CANCELLED';
        this.operationId = operationId;
    }
}

export function getCurrentOperation() {
    return operationStorage.getStore() || null;
}

export function getCurrentOperationSignal() {
    return getCurrentOperation()?.controller?.signal || null;
}

export function auditRuntimeEvent(type, data = {}, { level = 'info', operation = null } = {}) {
    const current = operation || getCurrentOperation();
    const row = {
        ts: isoNow(),
        level,
        type: String(type || 'runtime.event'),
        operationId: current?.id || '',
        operationName: current?.name || '',
        operationCategory: current?.category || '',
        data: jsonSafe(data),
    };
    return appendAuditRow(row);
}

export async function flushRuntimeAudit() {
    await Promise.all([...auditWriteTails.values()]);
}

export function updateOperationProgress(progress = {}, { checkpoint = false, event = 'operation.progress' } = {}) {
    const record = getCurrentOperation();
    if (!record) return null;
    record.progress = {
        ...(record.progress && typeof record.progress === 'object' ? record.progress : {}),
        ...(progress && typeof progress === 'object' ? jsonSafe(progress) : { value: jsonSafe(progress) }),
    };
    record.updatedAt = isoNow();
    auditRuntimeEvent(event, { progress: compactAuditSnapshot(record.progress) }, { operation: record });
    if (checkpoint) persistCheckpoint(record, event);
    return operationSnapshot(record, { includeCheckpoint: false });
}

export function saveOperationCheckpoint(checkpoint = {}, { event = 'operation.checkpoint', deferPersist = false } = {}) {
    const record = getCurrentOperation();
    if (!record) return null;
    record.checkpoint = deferPersist ? { ...checkpoint } : jsonSafe(checkpoint);
    record.updatedAt = isoNow();
    const path = deferPersist
        ? scheduleCheckpointPersistence(record, event)
        : persistCheckpoint(record, event);
    auditRuntimeEvent(event, { checkpoint: compactAuditSnapshot(record.checkpoint), path }, { operation: record });
    if (deferPersist) return { id: record.id, checkpointPath: path, deferred: true };
    return { ...operationSnapshot(record), checkpointPath: path };
}

export function registerOperationStopHandler(handler) {
    const record = getCurrentOperation();
    if (!record || typeof handler !== 'function') return () => {};
    record.stopHandlers.add(handler);
    return () => record.stopHandlers.delete(handler);
}

async function invokeStopHandlers(record, reason) {
    const handlers = [...record.stopHandlers];
    if (!handlers.length) return [];

    const runOne = (handler, index) => {
        let timeoutHandle = null;
        const handlerPromise = operationStorage.run(
            record,
            () => Promise.resolve().then(() => handler({
                reason,
                operationId: record.id,
                signal: record.controller.signal,
                checkpoint: record.checkpoint,
                progress: record.progress,
            })),
        );
        const timeoutPromise = new Promise((_, reject) => {
            timeoutHandle = setTimeout(() => {
                const error = new Error(`Stop handler ${index + 1} exceeded ${STOP_HANDLER_TIMEOUT_MS} ms`);
                error.name = 'StopHandlerTimeoutError';
                error.code = 'STOP_HANDLER_TIMEOUT';
                reject(error);
            }, STOP_HANDLER_TIMEOUT_MS);
            timeoutHandle.unref?.();
        });
        return Promise.race([handlerPromise, timeoutPromise]).finally(() => {
            if (timeoutHandle) clearTimeout(timeoutHandle);
        });
    };

    const results = await Promise.allSettled(handlers.map(runOne));
    const rejected = results
        .filter((row) => row.status === 'rejected')
        .map((row) => normalizeError(row.reason));
    auditRuntimeEvent('operation.stop-handlers.finished', {
        reason,
        count: handlers.length,
        timeoutMs: STOP_HANDLER_TIMEOUT_MS,
        fulfilled: results.filter((row) => row.status === 'fulfilled').length,
        rejected,
        timedOut: rejected.filter((error) => error?.code === 'STOP_HANDLER_TIMEOUT').length,
    }, {
        level: rejected.length ? 'warn' : 'info',
        operation: record,
    });
    return results;
}

function abortRecord(record, reason, { timedOut = false } = {}) {
    if (!record || record.abortRequested) return;
    record.abortRequested = true;
    record.timedOut = Boolean(timedOut);
    record.stopReason = String(reason || (timedOut ? 'timeout' : 'stop-requested'));
    record.status = timedOut ? 'timed-out-stopping' : 'stopping';
    record.updatedAt = isoNow();
    const error = timedOut
        ? new OperationTimeoutError(`Operation ${record.id} exceeded ${record.timeoutMs} ms`, record.id)
        : new OperationCancelledError(`Operation ${record.id} cancelled: ${record.stopReason}`, record.id);
    try {
        record.controller.abort(error);
    } catch {
        // ignore
    }
    persistCheckpoint(record, timedOut ? 'timeout' : 'stop-requested');
    auditRuntimeEvent(timedOut ? 'operation.timeout' : 'operation.stop-requested', {
        reason: record.stopReason,
        timeoutMs: record.timeoutMs,
        startedAt: record.startedAt,
        deadlineAt: record.deadlineAt,
        elapsedMs: Math.max(0, Date.now() - record.startedAtMs),
        metadata: record.metadata,
        progress: compactAuditSnapshot(record.progress),
        checkpoint: compactAuditSnapshot(record.checkpoint),
        unfinished: buildUnfinishedState(record),
        stopHandlerCount: record.stopHandlers.size,
        runtime: collectRuntimeDiagnostics(),
    }, { level: timedOut ? 'error' : 'warn', operation: record });
}


export function listActiveOperations({ includeTimedOut = true } = {}) {
    return [...activeOperations.values()]
        .filter((record) => includeTimedOut || !record.timedOut)
        .map(operationSnapshot)
        .sort((left, right) => Date.parse(left.startedAt) - Date.parse(right.startedAt));
}

export function getOperation(operationId) {
    const record = activeOperations.get(String(operationId || '').trim());
    return record ? operationSnapshot(record) : null;
}

export function reconcileInterruptedOperationCheckpoints({
    directory = OPERATION_CHECKPOINT_DIRECTORY,
    now = new Date(),
    writeAudit = true,
    maxFiles = Number(process.env.OPERATION_RECONCILE_MAX_FILES) || 5000,
} = {}) {
    const finishedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
    const recovered = [];
    let files = [];
    try {
        files = readdirSync(directory).filter((name) => name.endsWith('.json'));
    } catch {
        return recovered;
    }

    // Checkpoint files are append-only operation snapshots. Older releases
    // left tens of thousands of settled files in this directory; parsing all
    // of them synchronously made startup appear frozen before Telegram/VK were
    // connected. Operation ids begin with a monotonic base36 timestamp, so the
    // newest names are the only useful candidates after a process restart.
    const safeMaxFiles = Math.max(100, Math.min(50_000, Number(maxFiles) || 5000));
    const candidates = files.length > safeMaxFiles
        ? files.sort((left, right) => right.localeCompare(left)).slice(0, safeMaxFiles)
        : files;
    if (files.length > candidates.length) {
        console.warn(
            '[OPERATION CHECKPOINT RECONCILE BOUNDED]',
            `files=${files.length}`,
            `scanned=${candidates.length}`,
            `skipped=${files.length - candidates.length}`,
        );
    }

    for (const name of candidates) {
        const path = join(directory, name);
        try {
            const payload = JSON.parse(readFileSync(path, 'utf8'));
            const operation = payload?.operation;
            if (!operation || !['running', 'stopping', 'timed-out-stopping'].includes(String(operation.status || ''))) continue;
            // VK message handlers are short user requests, not resumable jobs.
            // Older checkpoints for them had no phase and were incorrectly reported after restart.
            if (String(operation.name || '') === 'vk-message' || String(operation.category || '') === 'user-request' || String(operation.category || '').startsWith('test')) {
                operation.status = 'abandoned';
                operation.stopReason = String(operation.category || '').startsWith('test')
                    ? 'test-artifact-ignored-on-restart'
                    : 'non-resumable-short-request';
                operation.finishedAt = finishedAt;
                operation.updatedAt = finishedAt;
                operation.underlyingSettled = true;
                payload.recovery = classifyInterruptedOperation(operation);
                payload.reason = String(operation.category || '').startsWith('test')
                    ? 'ignored-test-artifact'
                    : 'ignored-non-resumable-request';
                payload.savedAt = finishedAt;
                const temporary = path + '.tmp-' + process.pid + '-' + Date.now();
                writeFileSync(temporary, JSON.stringify(payload, null, 2) + '\n', 'utf8');
                renameSync(temporary, path);
                continue;
            }
            operation.status = 'interrupted';
            operation.stopReason = operation.stopReason || 'process-restarted-before-operation-settled';
            operation.finishedAt = finishedAt;
            operation.updatedAt = finishedAt;
            operation.underlyingSettled = false;
            payload.version = 2;
            payload.reason = 'process-restarted';
            payload.savedAt = finishedAt;
            payload.recovery = classifyInterruptedOperation(operation);
            const temporary = `${path}.tmp-${process.pid}-${Date.now()}`;
            writeFileSync(temporary, `${JSON.stringify(payload, null, 2)}\n`, 'utf8');
            renameSync(temporary, path);
            recovered.push({
                id: String(operation.id || name.replace(/\.json$/u, '')),
                name: String(operation.name || ''),
                category: String(operation.category || ''),
                checkpoint: operation.checkpoint || {},
                progress: operation.progress || {},
                recovery: payload.recovery,
            });
            if (writeAudit) {
                appendAuditRow({ ts: finishedAt, level: 'error', type: 'operation.interrupted-after-restart', operationId: operation.id || '', operationName: operation.name || '', operationCategory: operation.category || '', data: { stopReason: operation.stopReason, checkpoint: compactAuditSnapshot(operation.checkpoint || {}), progress: compactAuditSnapshot(operation.progress || {}) } });
            }
        } catch {
            // One damaged checkpoint must not block bot startup or other recoveries.
        }
    }
    return recovered;
}

export async function requestOperationStop(operationId, { reason = 'owner-command' } = {}) {
    const id = String(operationId || '').trim();
    const record = activeOperations.get(id);
    if (!record) return { ok: false, reason: 'not-found', operation: null };
    if (record.abortRequested) {
        return { ok: true, reason: 'already-stopping', operation: operationSnapshot(record) };
    }
    abortRecord(record, reason, { timedOut: false });
    await invokeStopHandlers(record, reason);
    return { ok: true, reason: 'stop-requested', operation: operationSnapshot(record) };
}

export async function requestStopWhere(predicate, { reason = 'owner-command' } = {}) {
    const rows = [...activeOperations.values()].filter((record) => {
        try { return predicate(record); } catch { return false; }
    });
    return Promise.all(rows.map((record) => requestOperationStop(record.id, { reason })));
}

export async function runSupervisedOperation({
    name = 'operation',
    category = 'algorithm',
    timeoutMs = DEFAULT_OPERATION_TIMEOUT_MS,
    metadata = {},
} = {}, task) {
    if (typeof task !== 'function') throw new TypeError('task must be a function');
    const safeTimeoutMs = Math.max(1_000, Math.min(MAX_OPERATION_TIMEOUT_MS, Number(timeoutMs) || DEFAULT_OPERATION_TIMEOUT_MS));
    const controller = new AbortController();
    const startedAtMs = Date.now();
    const id = `${startedAtMs.toString(36)}-${randomUUID().slice(0, 8)}`;
    const record = {
        id,
        name: String(name || 'operation').slice(0, 180),
        category: String(category || 'algorithm').slice(0, 120),
        timeoutMs: safeTimeoutMs,
        startedAtMs,
        startedAt: new Date(startedAtMs).toISOString(),
        deadlineAt: new Date(startedAtMs + safeTimeoutMs).toISOString(),
        updatedAt: new Date(startedAtMs).toISOString(),
        finishedAt: '',
        status: 'running',
        metadata: jsonSafe(metadata),
        progress: {},
        checkpoint: {},
        controller,
        stopHandlers: new Set(),
        abortRequested: false,
        timedOut: false,
        stopReason: '',
        underlyingSettled: false,
        checkpointWriteTimer: null,
        checkpointWriteTail: Promise.resolve(),
    };
    activeOperations.set(id, record);
    persistCheckpoint(record, 'start');
    auditRuntimeEvent('operation.start', {
        timeoutMs: safeTimeoutMs,
        deadlineAt: record.deadlineAt,
        metadata: record.metadata,
    }, { operation: record });

    let timeoutHandle = null;
    let raceSettled = false;
    const taskPromise = operationStorage.run(record, () => Promise.resolve().then(() => task({
        id,
        signal: controller.signal,
        updateProgress,
        saveCheckpoint,
        onStop: registerOperationStopHandler,
        audit: auditRuntimeEvent,
    })));

    function updateProgress(progress, options = {}) {
        return operationStorage.run(record, () => updateOperationProgress(progress, options));
    }
    function saveCheckpoint(checkpoint, options = {}) {
        return operationStorage.run(record, () => saveOperationCheckpoint(checkpoint, options));
    }

    let removeOperationAbortListener = null;
    const operationAbortPromise = new Promise((_, reject) => {
        const onAbort = () => {
            const reason = controller.signal.reason instanceof Error
                ? controller.signal.reason
                : new OperationCancelledError(`Operation ${id} aborted`, id);
            reject(reason);
        };
        if (controller.signal.aborted) {
            onAbort();
            return;
        }
        controller.signal.addEventListener('abort', onAbort, { once: true });
        removeOperationAbortListener = () => controller.signal.removeEventListener('abort', onAbort);
    });

    taskPromise.then(
        (value) => {
            record.underlyingSettled = true;
            if (raceSettled && record.abortRequested) {
                record.status = record.timedOut
                    ? 'timed-out-late-complete'
                    : 'cancelled-late-complete';
                record.finishedAt = isoNow();
                record.updatedAt = record.finishedAt;
                const event = record.timedOut
                    ? 'operation.late-completion-after-timeout'
                    : 'operation.late-completion-after-cancel';
                auditRuntimeEvent(event, {
                    stopReason: record.stopReason,
                    progress: compactAuditSnapshot(record.progress),
                    checkpoint: compactAuditSnapshot(record.checkpoint),
                    result: compactAuditResult(value),
                }, { level: 'warn', operation: record });
                persistCheckpoint(record, record.timedOut
                    ? 'late-completion-after-timeout'
                    : 'late-completion-after-cancel');
                activeOperations.delete(id);
            }
            return value;
        },
        (error) => {
            record.underlyingSettled = true;
            if (raceSettled && (record.timedOut || record.abortRequested)) {
                record.status = record.timedOut ? 'timed-out-stopped' : 'cancelled-stopped';
                record.finishedAt = isoNow();
                auditRuntimeEvent('operation.underlying-stopped', {
                    error: normalizeError(error),
                    progress: compactAuditSnapshot(record.progress),
                    checkpoint: compactAuditSnapshot(record.checkpoint),
                }, { level: 'warn', operation: record });
                persistCheckpoint(record, 'underlying-stopped');
                activeOperations.delete(id);
            }
        },
    );

    const timeoutPromise = new Promise((_, reject) => {
        timeoutHandle = setTimeout(() => {
            abortRecord(record, `hard-timeout-${safeTimeoutMs}ms`, { timedOut: true });
            void invokeStopHandlers(record, record.stopReason);
            reject(new OperationTimeoutError(
                `Алгоритм превысил жёсткий лимит ${Math.round(safeTimeoutMs / 1000)} секунд.`,
                id,
            ));
        }, safeTimeoutMs);
        timeoutHandle.unref?.();
    });

    try {
        const result = await Promise.race([taskPromise, timeoutPromise, operationAbortPromise]);
        raceSettled = true;
        record.status = record.abortRequested ? 'cancelled' : 'completed';
        record.finishedAt = isoNow();
        record.updatedAt = record.finishedAt;
        const completionAudit = auditRuntimeEvent('operation.complete', {
            durationMs: Date.now() - startedAtMs,
            progress: compactAuditSnapshot(record.progress),
            checkpoint: compactAuditSnapshot(record.checkpoint),
            result: compactAuditResult(result),
        }, { operation: record });
        persistCheckpoint(record, 'complete');
        await record.checkpointWriteTail;
        await completionAudit;
        activeOperations.delete(id);
        return result;
    } catch (error) {
        raceSettled = true;
        const timedOut = error?.code === 'OPERATION_TIMEOUT' || record.timedOut;
        const cancelled = error?.code === 'OPERATION_CANCELLED' || (record.abortRequested && !timedOut);
        record.status = timedOut
            ? (record.underlyingSettled ? 'timed-out-stopped' : 'timed-out-stopping')
            : cancelled
                ? (record.underlyingSettled ? 'cancelled' : 'stopping')
                : 'failed';
        record.finishedAt = record.underlyingSettled || (!timedOut && !cancelled) ? isoNow() : '';
        record.updatedAt = isoNow();
        const failureAudit = auditRuntimeEvent(timedOut ? 'operation.timeout-result' : cancelled ? 'operation.cancelled' : 'operation.failed', {
            error: normalizeError(error),
            durationMs: Date.now() - startedAtMs,
            startedAt: record.startedAt,
            deadlineAt: record.deadlineAt,
            metadata: record.metadata,
            progress: compactAuditSnapshot(record.progress),
            checkpoint: compactAuditSnapshot(record.checkpoint),
            unfinished: buildUnfinishedState(record),
            underlyingSettled: record.underlyingSettled,
            runtime: collectRuntimeDiagnostics(),
        }, { level: 'error', operation: record });
        persistCheckpoint(record, timedOut ? 'timeout-result' : cancelled ? 'cancelled' : 'failed');
        await record.checkpointWriteTail;
        await failureAudit;
        if (record.underlyingSettled || (!timedOut && !cancelled)) {
            activeOperations.delete(id);
        }
        throw error;
    } finally {
        if (timeoutHandle) clearTimeout(timeoutHandle);
        removeOperationAbortListener?.();
    }
}


let globalAuditHandlersInstalled = false;
let consoleAuditInstalled = false;

function installConsoleAuditBridge() {
    if (consoleAuditInstalled) return;
    consoleAuditInstalled = true;
    const originalError = console.error.bind(console);
    const originalWarn = console.warn.bind(console);
    console.error = (...args) => {
        try {
            auditRuntimeEvent('console.error', { args: args.map((value) => jsonSafe(value)) }, { level: 'error' });
        } catch {
            // Best-effort audit only.
        }
        originalError(...args);
    };
    console.warn = (...args) => {
        try {
            auditRuntimeEvent('console.warn', { args: args.map((value) => jsonSafe(value)) }, { level: 'warn' });
        } catch {
            // Best-effort audit only.
        }
        originalWarn(...args);
    };
}

export function installGlobalRuntimeAuditHandlers() {
    if (globalAuditHandlersInstalled) return false;
    globalAuditHandlersInstalled = true;
    installConsoleAuditBridge();

    process.on('unhandledRejection', (reason, promise) => {
        auditRuntimeEvent('process.unhandled-rejection', {
            reason: normalizeError(reason instanceof Error ? reason : new Error(String(reason))),
            promise: String(promise || '').slice(0, 1000),
        }, { level: 'error' });
    });
    process.on('uncaughtExceptionMonitor', (error, origin) => {
        auditRuntimeEvent('process.uncaught-exception', {
            origin: String(origin || ''),
            error: normalizeError(error),
        }, { level: 'error' });
    });
    process.on('warning', (warning) => {
        auditRuntimeEvent('process.warning', {
            warning: normalizeError(warning),
        }, { level: 'warn' });
    });
    process.on('exit', (code) => {
        auditRuntimeEvent('process.exit', {
            code: Number(code || 0),
            activeOperations: listActiveOperations().map((operation) => ({
                id: operation.id, name: operation.name, status: operation.status,
                phase: operation.progress?.phase || operation.checkpoint?.phase || '',
            })),
        }, { level: Number(code || 0) === 0 ? 'info' : 'error' });
    });
    return true;
}
