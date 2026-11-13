import { explainRecentOrFuturePost } from './recentEventPassPolicy.js';

const itemIdOf = (item) => String(
    item?.itemId ??
    item?.postId ??
    item?.conversationMessageId ??
    item?.messageId ??
    item?.id ??
    '',
).trim();

const staleReason = (item) => String(
    item?.aiAdmission?.rejectionReason ??
    item?.rejectionReason ??
    item?.evidence?.recency?.reason ??
    (Array.isArray(item?.reasons) ? item.reasons.find((reason) => String(reason) === 'stale-post-outside-recent-window') : '') ??
    '',
).trim();

const HARD_STALE_REASONS = new Set([
    'stale-post-outside-recent-window',
    'parser-post-older-than-six-months',
]);

export function buildStaleParserItemKeys(captures = []) {
    const keys = new Set();
    for (const row of Array.isArray(captures) ? captures : []) {
        const sourceId = String(row?.sourceId ?? '').trim();
        if (!sourceId) continue;
        for (const item of Array.isArray(row?.prefilterPreviews) ? row.prefilterPreviews : []) {
            if (!HARD_STALE_REASONS.has(staleReason(item))) continue;
            const itemId = itemIdOf(item);
            if (itemId) keys.add(sourceId + '\u0000' + itemId);
        }
    }
    return keys;
}

export function isStaleParserItem(staleKeys, sourceId, item) {
    const id = itemIdOf(item);
    return Boolean(id && staleKeys?.has(String(sourceId ?? '').trim() + '\u0000' + id));
}

export function isStaleParserPreview(staleKeys, sourceId, preview) {
    return isStaleParserItem(staleKeys, sourceId, preview);
}
export function isParserItemOlderThanMaxAge(item, referenceNow = new Date()) {
    const result = explainRecentOrFuturePost({
        publishedAt: Number(item?.publishedAt || item?.observedAt || 0),
        updatedAt: Number(item?.updatedAt || 0),
        text: String(item?.text || item?.rawText || ''),
        referenceNow,
        recentDays: 0,
    });
    return result.reason === 'parser-post-older-than-six-months';
}
