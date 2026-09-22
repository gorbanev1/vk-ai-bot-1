/**
 * VK photo attachment identity helpers.
 *
 * VK's web UI virtualizes gallery cells and can temporarily serialize the
 * previous neighbour's currentSrc for a different photo anchor.  The anchor
 * identity (photo<owner>_<id>) is stable, so resolve the bytes/URL by that id
 * through photos.getById instead of trusting a recycled <img> node.
 */

export function normalizeVkPhotoAttachmentKey(value) {
    const match = String(value ?? '').trim().match(/photo(-?\d+)_(\d+)/iu);
    if (!match) return '';
    return `photo${Number(match[1])}_${Number(match[2])}`.toLowerCase();
}

export function vkApiPhotoIdFromAttachmentKey(value) {
    const key = normalizeVkPhotoAttachmentKey(value);
    return key ? key.slice('photo'.length) : '';
}

export function vkPhotoAttachmentKeyFromPayload(value) {
    const payload = value?.photo && typeof value.photo === 'object' ? value.photo : value;
    const ownerId = Number(payload?.owner_id ?? payload?.ownerId ?? 0);
    const id = Number(payload?.id ?? payload?.photo_id ?? payload?.photoId ?? 0);
    if (!Number.isFinite(ownerId) || ownerId === 0 || !Number.isFinite(id) || id <= 0) return '';
    return `photo${ownerId}_${id}`.toLowerCase();
}

function validHttpUrl(value) {
    const url = String(value ?? '').trim();
    return /^https?:\/\//iu.test(url) ? url : '';
}

export function bestVkPhotoPayloadUrl(value) {
    const payload = value?.photo && typeof value.photo === 'object' ? value.photo : value;
    if (!payload || typeof payload !== 'object') return '';

    const candidates = [];
    const add = (url, width = 0, height = 0, preference = 0) => {
        const clean = validHttpUrl(url);
        if (!clean) return;
        const w = Math.max(0, Number(width) || 0);
        const h = Math.max(0, Number(height) || 0);
        candidates.push({
            url: clean,
            width: w,
            height: h,
            score: preference + Math.min(1_000_000_000, w * h) + Math.max(w, h),
        });
    };

    for (const size of Array.isArray(payload.sizes) ? payload.sizes : []) {
        add(size?.url ?? size?.src, size?.width, size?.height, 20_000_000_000);
    }
    add(
        payload?.orig_photo?.url,
        payload?.orig_photo?.width ?? payload?.width,
        payload?.orig_photo?.height ?? payload?.height,
        30_000_000_000,
    );
    add(payload?.max_size_url, payload?.width, payload?.height, 25_000_000_000);

    for (const [key, raw] of Object.entries(payload)) {
        const match = key.match(/^(?:photo|src)_(\d+)$/iu);
        if (!match) continue;
        const side = Number(match[1]) || 0;
        add(raw, side, side, 10_000_000_000);
    }

    candidates.sort((left, right) => right.score - left.score);
    return candidates[0]?.url || '';
}

export function collectVkPhotoApiIdsFromMedia(media, { limit = 100 } = {}) {
    const ids = [];
    const seen = new Set();
    for (const item of Array.isArray(media) ? media : []) {
        const id = vkApiPhotoIdFromAttachmentKey(item?.attachmentKey);
        if (!id || seen.has(id)) continue;
        seen.add(id);
        ids.push(id);
        if (ids.length >= Math.max(1, Math.min(1000, Number(limit) || 100))) break;
    }
    return ids;
}

export function mapVkApiPhotosByAttachmentKey(apiPhotos) {
    const result = new Map();
    for (const item of Array.isArray(apiPhotos) ? apiPhotos : []) {
        const key = vkPhotoAttachmentKeyFromPayload(item);
        const url = bestVkPhotoPayloadUrl(item);
        if (!key || !url) continue;
        result.set(key, { key, url, photo: item });
    }
    return result;
}

export function resolveVkPhotoMediaByAttachmentKey(media, apiPhotos) {
    const byKey = apiPhotos instanceof Map
        ? apiPhotos
        : mapVkApiPhotosByAttachmentKey(apiPhotos);
    let resolvedCount = 0;
    const result = [];
    const seenIdentity = new Set();

    for (const raw of Array.isArray(media) ? media : []) {
        const attachmentKey = normalizeVkPhotoAttachmentKey(raw?.attachmentKey);
        const resolved = attachmentKey ? byKey.get(attachmentKey) : null;
        const url = resolved?.url || validHttpUrl(raw?.url);
        if (!url) continue;
        if (resolved?.url) resolvedCount += 1;
        const identity = attachmentKey ? `attachment:${attachmentKey}` : `url:${url}`;
        if (seenIdentity.has(identity)) continue;
        seenIdentity.add(identity);
        result.push({
            ...raw,
            url,
            attachmentKey,
            resolvedByPhotoId: Boolean(resolved?.url),
            mediaHint: resolved?.url ? 'vk-photo-id-api' : String(raw?.mediaHint || ''),
        });
    }

    return { media: result, resolvedCount };
}
