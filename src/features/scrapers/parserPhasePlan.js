import { readFileSync } from 'node:fs';

/** Plan phase two from the exact capture generation, without opening sources. */
export function buildDateFreePhasePlan(captures, readCache = (path) => JSON.parse(readFileSync(path, 'utf8'))) {
    const cacheRows = new Map();
    const reservedImageUrls = new Set();
    const failures = [];
    for (const row of captures || []) {
        // Reserve phase-one images from ALL chats, even where phase two is off.
        for (const item of row.prefilterPreviews || []) {
            if (item.visionPhase === 'phase1') for (const url of item.imageUrls || []) reservedImageUrls.add(url);
        }
        if (row.kind === 'vk-chat' && row.sourceId !== 'chat:2000000022') continue;
        const ids = new Set((row.prefilterPreviews || [])
            .filter((item) => item.visionPhase === 'phase2-date-free-image' && item.imageUrls?.length && !item.incrementalKnown)
            .map((item) => String(item.itemId)));
        if (!ids.size) continue;
        try {
            const payload = readCache(row.cachePath);
            if (!Array.isArray(payload.items)) throw new Error('Invalid raw cache');
            const items = payload.items.filter((item) => ids.has(String(item.postId ?? item.conversationMessageId ?? item.messageId ?? '')));
            if (items.length !== ids.size) throw new Error('Date-free items missing from raw cache');
            cacheRows.set(row.sourceId, { path: row.cachePath, items, itemCount: items.length });
        } catch (error) {
            failures.push({ sourceId: row.sourceId, error: String(error.message || error) });
        }
    }
    return { cacheRows, reservedImageUrls: [...reservedImageUrls], failures };
}

export function serializeDateFreePhasePlan({ cacheRows, reservedImageUrls, rawImageCache = new Map() }) {
    return {
        captures: [...cacheRows].map(([sourceId, row]) => ({ sourceId, cachePath: row.path, itemIds: row.items.map((item) => String(item.postId ?? item.conversationMessageId ?? item.messageId ?? '')) })),
        reservedImageUrls,
        rawImageCache: [...rawImageCache],
    };
}

export function restoreDateFreePhasePlan(plan, readCache = (path) => JSON.parse(readFileSync(path, 'utf8'))) {
    const cacheRows = new Map();
    for (const row of plan.captures || []) {
        const payload = readCache(row.cachePath);
        const ids = new Set(row.itemIds);
        const items = payload.items.filter((item) => ids.has(String(item.postId ?? item.conversationMessageId ?? item.messageId ?? '')));
        if (items.length !== ids.size) throw new Error(`Phase-two cache incomplete: ${row.sourceId}`);
        cacheRows.set(row.sourceId, { path: row.cachePath, items, itemCount: items.length });
    }
    return { cacheRows, reservedImageUrls: plan.reservedImageUrls || [], rawImageCache: new Map(plan.rawImageCache || []) };
}
