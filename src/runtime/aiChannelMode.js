import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';

const STATE_PATH = resolve(process.env.AI_CHANNEL_MODE_STATE_PATH || 'data/ai-channel-mode.json');
const DEFAULT_STATE = Object.freeze({ mode: 'ordinary', modeSource: 'manual', detectedModel: '', detectedAt: 0, updatedAt: 0, lastProbeAt: 0, probeFailures: 0, lastError: '', lastSuccessfulModel: '', deferred: [] });

function normalize(value) {
    const source = value && typeof value === 'object' ? value : {};
    return {
        mode: String(source.mode || 'ordinary').toLowerCase() === 'astra' ? 'astra' : 'ordinary',
        modeSource: String(source.modeSource || 'manual').toLowerCase() === 'auto' ? 'auto' : 'manual',
        detectedModel: String(source.detectedModel || '').trim(),
        detectedAt: Number(source.detectedAt || 0),
        updatedAt: Number(source.updatedAt || 0),
        lastProbeAt: Number(source.lastProbeAt || 0),
        probeFailures: Math.max(0, Number(source.probeFailures || 0) | 0),
        lastError: String(source.lastError || '').trim().slice(0, 700),
        lastSuccessfulModel: String(source.lastSuccessfulModel || '').trim().slice(0, 120),
        deferred: Array.isArray(source.deferred) ? source.deferred.filter((item) => item && typeof item === 'object').slice(-100) : [],
    };
}

export function readAiChannelMode() {
    if (!existsSync(STATE_PATH)) return { ...DEFAULT_STATE, deferred: [] };
    try { return normalize(JSON.parse(readFileSync(STATE_PATH, 'utf8'))); } catch { return { ...DEFAULT_STATE, deferred: [] }; }
}

export function writeAiChannelMode(patch = {}) {
    const next = normalize({ ...readAiChannelMode(), ...patch, updatedAt: Date.now() });
    mkdirSync(dirname(STATE_PATH), { recursive: true });
    const temp = `${STATE_PATH}.tmp-${process.pid}-${Date.now()}`;
    writeFileSync(temp, `${JSON.stringify(next, null, 2)}\n`, 'utf8');
    renameSync(temp, STATE_PATH);
    return next;
}

export function setAiChannelMode(mode, details = {}) {
    return writeAiChannelMode({
        mode: String(mode).toLowerCase() === 'astra' ? 'astra' : 'ordinary',
        modeSource: String(details.modeSource || 'manual').toLowerCase() === 'auto' ? 'auto' : 'manual',
        ...details,
    });
}

export function isAstraChannelMode() { return readAiChannelMode().mode === 'astra'; }

export function shouldRouteChatAiToAstra({ channelMode = 'ordinary', operationCategory = '', tokenUsageOperation = '' } = {}) {
    return String(channelMode).toLowerCase() === 'astra' &&
        String(operationCategory) === 'user-request' &&
        !/^event(?:-|:)/u.test(String(tokenUsageOperation || ''));
}

export function isAstraUnavailableError(error) {
    const message = String(error?.message ?? error ?? '');
    const status = Number(error?.status ?? error?.statusCode ?? error?.code ?? 0);
    if (status !== 503 && !/(?:\b503\b|service unavailable)/iu.test(message)) return false;
    return /(?:special offer source|source\s*\/\s*channel|source.*(?:astra|team\/plus)|channel.*(?:astra|special offer)|switch (?:your )?(?:model )?source|try changing (?:the )?(?:model )?source|источник.*(?:astra|канал)|канал.*(?:astra|источник))/iu.test(message);
}

function isAstraModel(value) {
    return /(?:^|[\/_-])(?:gpt[\/_-]?6(?:[._-]1)?[\/_-]?astra|astra)(?:$|[\/_-])/iu.test(String(value || ''));
}

export function observeAiModelEvent({ model = '', eventType = '', error = null, capability = 'text', allowAuto = true, ladderExhausted = false } = {}) {
    if (!allowAuto || !['text', 'vision'].includes(String(capability))) return null;
    const current = readAiChannelMode();
    const modelId = String(model || '').trim();
    if (!modelId || isAstraModel(modelId)) return null;
    if (eventType === 'success') {
        if (current.mode === 'astra' && current.modeSource === 'auto') {
            const next = setAiChannelMode('ordinary', { modeSource: 'auto', detectedModel: modelId, detectedAt: Date.now(), probeFailures: 0, lastSuccessfulModel: modelId, lastError: '' });
            return { transition: 'ordinary', previous: current, next, reason: 'junior-model-recovered' };
        }
        if (current.probeFailures || current.lastSuccessfulModel !== modelId) writeAiChannelMode({ probeFailures: 0, lastSuccessfulModel: modelId, lastProbeAt: Date.now(), lastError: '' });
        return null;
    }
    // Auto Astra is a circuit breaker for a completely failed model ladder,
    // never a reaction to one junior-model attempt.
    if (eventType !== 'all-unavailable' || !ladderExhausted || !isAstraUnavailableError(error)) return null;
    const failures = current.probeFailures + 1;
    const details = String(error?.message ?? error ?? '').replace(/\s+/gu, ' ').trim().slice(0, 700);
    if (current.mode !== 'astra' && failures >= 1) {
        const next = setAiChannelMode('astra', { modeSource: 'auto', detectedModel: 'gpt-6-astra', detectedAt: Date.now(), probeFailures: failures, lastError: details });
        return { transition: 'astra', previous: current, next, reason: 'junior-model-unavailable' };
    }
    writeAiChannelMode({ probeFailures: failures, lastProbeAt: Date.now(), lastError: details });
    return null;
}

export function enqueueDeferredAiOperation(operation = {}) {
    const state = readAiChannelMode();
    const id = String(operation.id || `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
    const deferred = [...state.deferred.filter((item) => String(item.id) !== id), { ...operation, id, queuedAt: Date.now() }].slice(-100);
    return writeAiChannelMode({ deferred });
}

export function peekDeferredAiOperation() {
    return readAiChannelMode().deferred[0] || null;
}

export function removeDeferredAiOperation(id) {
    const key = String(id || '').trim();
    if (!key) return null;
    const state = readAiChannelMode();
    const removed = state.deferred.find((item) => String(item.id) === key) || null;
    if (!removed) return null;
    writeAiChannelMode({ deferred: state.deferred.filter((item) => String(item.id) !== key) });
    return removed;
}

export function markAiChannelProbeStarted(at = Date.now()) {
    return writeAiChannelMode({ lastProbeAt: Number(at) || Date.now() });
}

export function takeDeferredAiOperations() {
    const state = readAiChannelMode();
    // This is a peek for compatibility; operations leave the queue only after
    // an owner explicitly continues or dismisses them.
    return state.deferred;
}

export function aiChannelModeStatePath() { return STATE_PATH; }
