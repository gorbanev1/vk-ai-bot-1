/**
 * Collects consecutive image-generation prompt fragments from one platform,
 * chat and sender. The timer is reset after every fragment; a flush happens
 * only after the configured quiet period.
 */
export function createImagePromptBatcher({ delayMs = 5_000, maxCharacters = 100_000, maxParts = 100, onFlush } = {}) {
    if (typeof onFlush !== 'function') throw new TypeError('onFlush must be a function');

    const pending = new Map();

    const normalizeKey = (value) => String(value ?? '').trim();

    const clearTimer = (entry) => {
        if (entry?.timer) clearTimeout(entry.timer);
        if (entry) entry.timer = null;
    };

    const schedule = (key, entry) => {
        clearTimer(entry);
        entry.timer = setTimeout(() => {
            void flush(key).catch((error) => {
                console.error('[IMAGE PROMPT BATCH FLUSH ERROR]', error);
            });
        }, Math.max(0, Number(delayMs) || 0));
        entry.timer.unref?.();
    };

    async function flush(key) {
        const normalizedKey = normalizeKey(key);
        const entry = pending.get(normalizedKey);
        if (!entry) return null;
        pending.delete(normalizedKey);
        clearTimer(entry);
        const text = entry.parts.map((part) => String(part ?? '').trim()).filter(Boolean).join('\n\n');
        if (!text) return null;
        return onFlush({ ...entry, key: normalizedKey, text, parts: [...entry.parts] });
    }

    return {
        enqueue({ key, text, context, commandCandidates = null, metadata = {} } = {}) {
            const normalizedKey = normalizeKey(key);
            const part = String(text ?? '').trim();
            if (!normalizedKey || !part) return { queued: false, count: 0 };
            const existing = pending.get(normalizedKey);
            const entry = existing || { key: normalizedKey, context, commandCandidates, metadata, parts: [], timer: null, createdAt: Date.now() };
            const characterCount = entry.parts.reduce((total, value) => total + value.length, 0);
            if (entry.parts.length >= maxParts) {
                return { queued: false, reason: 'limit', count: entry.parts.length };
            }
            // Keep one oversized item intact. Rejecting it here makes callers
            // bypass batching and can send separate fragments as separate jobs.
            if (characterCount + part.length > maxCharacters && existing) {
                return { queued: false, reason: 'limit', count: entry.parts.length };
            }
            if (!existing) pending.set(normalizedKey, entry);
            entry.parts.push(part);
            if (!entry.context?.hasAttachment || context?.hasAttachment) entry.context = context || entry.context;
            if (metadata && typeof metadata === 'object') {
                entry.metadata = {
                    ...entry.metadata,
                    ...metadata,
                    commandPrefix: entry.metadata?.commandPrefix || metadata.commandPrefix || '',
                };
            }
            schedule(normalizedKey, entry);
            return { queued: true, count: entry.parts.length, first: !existing };
        },
        has(key) { return pending.has(normalizeKey(key)); },
        count(key) { return pending.get(normalizeKey(key))?.parts.length || 0; },
        metadata(key) { return pending.get(normalizeKey(key))?.metadata || null; },
        async flush(key) { return flush(key); },
        cancel(key) {
            const normalizedKey = normalizeKey(key);
            const entry = pending.get(normalizedKey);
            if (!entry) return false;
            pending.delete(normalizedKey);
            clearTimer(entry);
            return true;
        },
        size() { return pending.size; },
    };
}

export function imagePromptBatchKey({ platform = '', peerId = '', senderId = '' } = {}) {
    return [platform, peerId, senderId].map((value) => String(value ?? '').trim()).join(':');
}

export async function fitImagePromptForModel({ text, maxCharacters = 12_000, summarize } = {}) {
    const source = String(text ?? '').trim();
    const limit = Math.max(1, Number(maxCharacters) || 12_000);
    if (source.length <= limit) {
        return { text: source, compressed: false, originalCharacters: source.length };
    }
    if (typeof summarize !== 'function') {
        throw new TypeError('A summarizer is required for an oversized image prompt.');
    }
    const compact = String(await summarize(source) ?? '').trim();
    if (!compact) throw new Error('The image prompt summarizer returned empty text.');
    return { text: compact, compressed: true, originalCharacters: source.length };
}
