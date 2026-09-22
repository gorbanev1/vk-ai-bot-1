import {
    sourceTextSimilarity,
} from './sourcePostFingerprint.js';

function normalizeUrl(value) {
    const raw = String(value ?? '').trim();
    if (!raw) return '';
    try {
        const url = new URL(raw);
        url.hash = '';
        url.search = '';
        return `${url.hostname.toLowerCase()}${url.pathname.replace(/\/+$/u, '')}`;
    } catch {
        return raw.toLowerCase().replace(/[?#].*$/u, '').replace(/\/+$/u, '');
    }
}

function parseAttachments(value) {
    if (Array.isArray(value)) return value;
    try {
        const parsed = JSON.parse(String(value ?? '[]'));
        return Array.isArray(parsed) ? parsed : [];
    } catch {
        return [];
    }
}

function attachmentKey(value) {
    const raw = typeof value === 'string'
        ? value
        : String(value?.url ?? value?.src ?? value?.href ?? value?.photoId ?? value?.id ?? '');
    return normalizeUrl(raw);
}

function attachmentSimilarity(left, right) {
    const a = new Set(parseAttachments(left).map(attachmentKey).filter(Boolean));
    const b = new Set(parseAttachments(right).map(attachmentKey).filter(Boolean));
    if (!a.size && !b.size) return 1;
    if (!a.size || !b.size) return 0;
    let intersection = 0;
    for (const key of a) if (b.has(key)) intersection += 1;
    return intersection / Math.max(a.size, b.size);
}

function observedSimilarity(left, right) {
    const a = Number(left || 0);
    const b = Number(right || 0);
    if (!(a > 0 && b > 0)) return 0;
    const delta = Math.abs(a - b);
    if (delta <= 5 * 60) return 1;
    if (delta <= 60 * 60) return 0.9;
    if (delta <= 6 * 60 * 60) return 0.6;
    if (delta <= 24 * 60 * 60) return 0.35;
    return 0;
}

export function scoreManualParserSeenSimilarity(current = {}, previous = {}) {
    const textSimilarity = sourceTextSimilarity(current.rawText, previous.rawText);
    const sameSource = String(current.sourceId || '') === String(previous.sourceId || '');
    const sameItem = sameSource && String(current.itemId || '') === String(previous.itemId || '');
    const sameUrl = Boolean(normalizeUrl(current.sourceUrl) && normalizeUrl(current.sourceUrl) === normalizeUrl(previous.sourceUrl));
    const attachments = attachmentSimilarity(current.attachments, previous.attachmentsJson ?? previous.attachments);
    const observed = observedSimilarity(current.observedAt, previous.observedAt);

    let metadataSimilarity = 0;
    if (sameSource) metadataSimilarity += 0.40;
    if (sameItem) metadataSimilarity += 0.20;
    else if (sameUrl) metadataSimilarity += 0.20;
    metadataSimilarity += 0.20 * attachments;
    metadataSimilarity += 0.20 * observed;
    metadataSimilarity = Math.max(0, Math.min(1, metadataSimilarity));

    const similarity = Math.max(0, Math.min(1, (textSimilarity * 0.85) + (metadataSimilarity * 0.15)));
    return {
        similarity,
        textSimilarity,
        metadataSimilarity,
        sameSource,
        sameItem,
        sameUrl,
        attachmentSimilarity: attachments,
        observedSimilarity: observed,
    };
}

export function findProcessedNearDuplicate(current, rows, { threshold = 0.97 } = {}) {
    let best = null;
    for (const row of Array.isArray(rows) ? rows : []) {
        const score = scoreManualParserSeenSimilarity(current, row);
        if (!best || score.similarity > best.similarity) best = { ...score, row };
    }
    if (!best || best.similarity + Number.EPSILON < Number(threshold)) return null;
    return best;
}
