/**
 * Безопасное накопление повторных DOM-наблюдений VK-беседы в рамках одного прохода.
 * Никаких сетевых запросов, доступа к БД или AI в этом модуле нет.
 */
function text(value) {
    return String(value ?? '').trim();
}

function list(value) {
    return Array.isArray(value) ? value : [];
}

function uniqueStrings(values) {
    return [...new Set(values.map((value) => text(value)).filter(Boolean))];
}

function mediaFrom(message) {
    const media = list(message?.imageMedia)
        .filter((item) => item && typeof item === 'object' && text(item.url))
        .map((item) => ({ ...item, url: text(item.url) }));
    const represented = new Set(media.map((item) => item.url));
    for (const url of uniqueStrings(list(message?.imageUrls))) {
        if (represented.has(url)) continue;
        media.push({ url, origin: 'attachment', repostDepth: 0 });
        represented.add(url);
    }
    return media;
}

function mediaKey(item) {
    const stableId = text(item?.attachmentKey || item?.vkPhotoId).toLowerCase();
    // URL регистрозависим; происхождение репоста нельзя смешивать с внешним сообщением.
    return JSON.stringify([
        text(item?.origin) || 'attachment',
        Number(item?.repostDepth) || 0,
        stableId ? 'stable-id' : 'url',
        stableId || text(item?.url),
    ]);
}

/** Stable identity for capture rechecks: photo URL variants do not change
 * the identity of a proven VK attachment. Unidentified URLs remain distinct;
 * origin/depth prevent reusing evidence from a neighboring repost layer.
 * This describes observed media, NOT proof that Vision processed every image.
 */
export function vkChatSourceMediaFingerprint(message) {
    return [...new Set(mediaFrom(message).map((item) => mediaKey(item)))].sort();
}

function mergeMedia(previous, incoming) {
    const byKey = new Map();
    for (const item of [...mediaFrom(previous), ...mediaFrom(incoming)]) {
        const key = mediaKey(item);
        const stored = byKey.get(key);
        byKey.set(key, stored ? { ...stored, ...item } : { ...item });
    }
    return [...byKey.values()];
}

function observationSignature(message) {
    return JSON.stringify({
        contentText: message?.contentText ?? '',
        repostText: message?.repostText ?? message?.embeddedText ?? '',
        text: message?.text ?? '',
        senderId: message?.senderId ?? 0,
        createdAt: message?.createdAt ?? 0,
        stable: message?.hasStableConversationMessageId === true,
        links: list(message?.links),
        repostUrls: list(message?.repostUrls),
        attachmentLinks: list(message?.attachmentLinks),
        media: mediaFrom(message).map((item) => ({
            key: mediaKey(item), url: item.url,
            width: item.width ?? 0, height: item.height ?? 0,
        })),
    });
}

function copyObservation(message) {
    const copy = { ...message };
    delete copy.captureObservations;
    return copy;
}

/**
 * Собственный текст и текст репоста НЕ склеиваются по разным версиям.
 * Новая непустая версия поля заменяет прежнюю; старые версии — только в истории.
 * Отсутствие поля при частичной отрисовке не доказывает удаление.
 */
export function mergeVkChatCaptureEvidence(previous, incoming) {
    const contentText = (text(incoming?.contentText) || text(previous?.contentText)).slice(0, 12_000);
    const repostText = (
        text(incoming?.repostText || incoming?.embeddedText) ||
        text(previous?.repostText || previous?.embeddedText)
    ).slice(0, 10_000);
    const imageMedia = mergeMedia(previous, incoming);
    const structuredText = [
        contentText,
        repostText && !contentText.includes(repostText)
            ? `[Репост/вложенный пост VK]\n${repostText}` : '',
    ].filter(Boolean).join('\n\n');
    return {
        ...previous,
        ...incoming,
        conversationMessageId: previous.conversationMessageId,
        hasStableConversationMessageId: Boolean(
            previous.hasStableConversationMessageId || incoming.hasStableConversationMessageId
        ),
        senderId: Number(incoming.senderId || previous.senderId || 0),
        createdAt: Number(incoming.createdAt || previous.createdAt || 0),
        contentText,
        repostText,
        embeddedText: repostText,
        text: (structuredText || text(incoming.text) || text(previous.text)).slice(0, 12_000),
        hasRepostEvidence: Boolean(previous.hasRepostEvidence || incoming.hasRepostEvidence || repostText),
        links: uniqueStrings([...list(previous.links), ...list(incoming.links)]),
        repostUrls: uniqueStrings([...list(previous.repostUrls), ...list(incoming.repostUrls)]),
        attachmentLinks: uniqueStrings([...list(previous.attachmentLinks), ...list(incoming.attachmentLinks)]),
        imageMedia,
        imageUrls: uniqueStrings(imageMedia.map((item) => item.url)),
    };
}

/**
 * true — новый CMID, false — уже учтённый CMID (его объект изменяется на месте).
 * Поэтому capturedMessages сохраняет ссылку на дополненный объект и не растёт
 * от повторной отрисовки того же сообщения.
 */
export function captureVkChatObservation(byId, incoming) {
    const id = Number(incoming?.conversationMessageId ?? 0);
    if (!Number.isSafeInteger(id) || id <= 0) return false;
    const previous = byId.get(id);
    if (!previous) {
        byId.set(id, incoming);
        return true;
    }
    const last = previous.captureObservations?.at(-1) || previous;
    if (observationSignature(last) === observationSignature(incoming)) return false;
    // Ограничиваем память длинной беседы; первые/предыдущие версии остаются
    // доступны в raw forensic cache, но не попадают в AI как склеенный текст.
    const previousHistory = list(previous.captureObservations);
    const observations = [
        ...(previousHistory.length
            ? previousHistory.slice(-29)
            : [copyObservation(previous)]),
        copyObservation(incoming),
    ];
    Object.assign(previous, mergeVkChatCaptureEvidence(previous, incoming), {
        captureObservations: observations,
    });
    return false;
}

export function assertVkChatSessionActive(active) {
    if (active) return;
    const error = new Error('VK chat session stopped; message was not processed.');
    error.code = 'MANUAL_SESSION_INACTIVE';
    throw error;
}

export function assertResolvedVkChatAiResult(result) {
    const events = Array.isArray(result) ? result : result?.events;
    const valid = result != null && result.unresolved !== true &&
        result.ok !== false && !result.error && Array.isArray(events) &&
        events.every((event) => event && typeof event === 'object' && !Array.isArray(event));
    if (valid) return result;
    const error = new Error('AI returned an unresolved or invalid event extraction result.');
    error.code = 'EVENT_AI_UNRESOLVED';
    throw error;
}

/** Only real VK conversation IDs may become a history frontier. */
export function stableVkChatMessageId(message) {
    if (message?.hasStableConversationMessageId !== true) return 0;
    const id = Number(message?.conversationMessageId ?? 0);
    return Number.isSafeInteger(id) && id > 0 ? id : 0;
}

/** Merge exact snapshot and later adaptive evidence without admitting avatar noise.
 * An unmatched adaptive image must identify a real attachment/photo. Preserve
 * exact order; update URLs of matching stable photos and append newly loaded ones.
 */
export function mergeVkChatSnapshotMedia(exact = {}, adaptive = {}) {
    const base = list(exact.imageMedia)
        .filter((item) => text(item?.url))
        .map((item) => ({ ...item }));
    const incoming = list(adaptive.imageMedia)
        .filter((item) => text(item?.url));
    const identity = (item) => text(item?.attachmentKey || item?.vkPhotoId).toLowerCase();
    const sameLayer = (left, right) => (
        (!text(left?.origin) || !text(right?.origin) || text(left.origin) === text(right.origin)) &&
        (left?.repostDepth == null || right?.repostDepth == null ||
            Number(left.repostDepth) === Number(right.repostDepth))
    );

    // Without an exact photo, unverified adaptive images can be avatars/UI.
    // A proven attachmentKey is sufficient to add a late-loaded image.
    for (const item of incoming) {
        const id = identity(item);
        if (!id) continue;
        const index = base.findIndex((previous) => identity(previous) === id && sameLayer(previous, item));
        if (index < 0) {
            base.push({ ...item });
        } else {
            const previous = base[index];
            base[index] = { ...previous, ...item, snapshotUrl: previous.snapshotUrl || previous.url };
        }
    }
    return base;
}
