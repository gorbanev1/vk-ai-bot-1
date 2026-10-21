const DEFAULT_MAX_DEPTH = 20;
const DEFAULT_MAX_IMAGES = 64;
const DEFAULT_MAX_NODES = 512;

// Legacy bounded preview helper kept for scraper compatibility. The V188.51
// request pipeline does not use this 12-item preview cap: collectIncomingMediaContext()
// performs the authoritative recursive traversal up to its explicit operation limit.
function uniquePush(urls, value, maximum = 12) {
    const clean = compactLine(value);
    if (clean && !urls.includes(clean) && urls.length < maximum) urls.push(clean);
}

function collectLegacyVkPreviewUrls(value, urls, depth = 0, visited = new WeakSet()) {
    if (depth > 12 || value == null || urls.length >= 12) return;
    if (typeof value === 'string') {
        if (looksLikeImageUrl(value)) uniquePush(urls, value, 12);
        return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    if (Array.isArray(value)) {
        for (const item of value) collectLegacyVkPreviewUrls(item, urls, depth + 1, visited);
        return;
    }
    const largest = selectLargestImageUrl(value);
    if (largest) uniquePush(urls, largest, 12);
    for (const child of Object.values(value)) {
        collectLegacyVkPreviewUrls(child, urls, depth + 1, visited);
        if (urls.length >= 12) break;
    }
}

function compactLine(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function compactBlock(value) {
    return String(value ?? '')
        .replace(/\r\n?/gu, '\n')
        .replace(/[ \t]+\n/gu, '\n')
        .replace(/\n[ \t]+/gu, '\n')
        .replace(/\n{3,}/gu, '\n\n')
        .trim();
}

function firstDefined(object, fields) {
    if (!object || typeof object !== 'object') return undefined;
    for (const field of fields) {
        if (object[field] !== undefined && object[field] !== null) return object[field];
    }
    return undefined;
}

function asArray(value) {
    if (Array.isArray(value)) return value;
    return value == null ? [] : [value];
}

function toPlainObject(value) {
    if (!value || typeof value !== 'object') return value;
    if (typeof value.toJSON === 'function') {
        try {
            const json = value.toJSON();
            if (json && typeof json === 'object') return json;
        } catch {
            // Some platform attachment wrappers are only partially hydrated.
        }
    }
    return value;
}

function looksLikeImageUrl(value) {
    const url = compactLine(value);
    return /^https?:\/\//iu.test(url) && (
        /\.(?:jpe?g|png|webp|gif|bmp|avif)(?:\?|$)/iu.test(url) ||
        /(?:userapi|vkuser|vkcdn|sun\d+-\d+\.userapi|telegram\.org\/file\/bot|api\.telegram\.org\/file\/bot)/iu.test(url)
    );
}

function canonicalizeUrl(value) {
    const raw = compactLine(value);
    if (!raw) return '';
    try {
        const parsed = new URL(raw);
        parsed.hash = '';
        for (const key of ['utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content']) {
            parsed.searchParams.delete(key);
        }
        return parsed.toString();
    } catch {
        return raw;
    }
}

function selectLargestImageUrl(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return '';

    const candidates = [];
    const add = (url, score = 0) => {
        const clean = compactLine(url);
        if (looksLikeImageUrl(clean)) {
            candidates.push({ url: clean, score: Number(score) || 0, order: candidates.length });
        }
    };

    if (Array.isArray(payload.sizes)) {
        for (const size of payload.sizes) {
            const width = Number(size?.width ?? 0);
            const height = Number(size?.height ?? 0);
            add(size?.url ?? size?.src, width * height);
        }
    }

    add(payload.orig_photo?.url, Number.MAX_SAFE_INTEGER - 1);
    add(payload.max_size_url, Number.MAX_SAFE_INTEGER);

    for (const [key, value] of Object.entries(payload)) {
        const match = key.match(/^(?:photo|src)_(\d+)$/iu);
        if (match) add(value, Number(match[1]));
    }

    return candidates.sort((left, right) => right.score - left.score || right.order - left.order)[0]?.url ?? '';
}

function getVkAttachmentType(attachment) {
    const source = toPlainObject(attachment);
    if (!source || typeof source !== 'object') return '';
    const explicit = compactLine(source.type ?? source.attachmentType ?? source.kind)
        .toLowerCase()
        .replace(/-/gu, '_');
    if (explicit) return explicit;

    const known = [
        'wall_reply', 'wallReply', 'wall', 'photo', 'doc', 'document', 'link',
        'video', 'audio_message', 'audio', 'graffiti', 'sticker', 'animation',
    ].find((key) => source[key] != null);
    return known === 'wallReply' ? 'wall_reply' : (known || '');
}

function getVkAttachmentPayload(attachment, type = getVkAttachmentType(attachment)) {
    const source = toPlainObject(attachment);
    if (!source || typeof source !== 'object') return {};
    const keys = type === 'wall_reply' ? ['wall_reply', 'wallReply'] : [type];
    for (const key of keys) {
        if (key && source[key] && typeof source[key] === 'object') return toPlainObject(source[key]);
    }
    if (source.payload && typeof source.payload === 'object') return toPlainObject(source.payload);
    return source;
}

function isVkImageDocument(payload) {
    const mime = compactLine(firstDefined(payload, ['mime_type', 'mimeType'])).toLowerCase();
    const ext = compactLine(payload?.ext).toLowerCase();
    const title = compactLine(firstDefined(payload, ['title', 'name', 'file_name', 'fileName'])).toLowerCase();
    return /^image\//u.test(mime) || /^(?:jpe?g|png|webp|gif|bmp|avif)$/u.test(ext) || /\.(?:jpe?g|png|webp|gif|bmp|avif)$/u.test(title);
}

function attachmentIdentity(platform, type, payload, fallback = '') {
    if (!payload || typeof payload !== 'object') return fallback;
    if (platform === 'telegram') {
        return compactLine(payload.file_unique_id || payload.file_id || fallback);
    }
    const owner = firstDefined(payload, ['owner_id', 'ownerId']);
    const id = firstDefined(payload, ['id', 'photo_id', 'photoId', 'doc_id', 'docId']);
    const accessKey = firstDefined(payload, ['access_key', 'accessKey']);
    if (owner != null && id != null) return `${type}:${owner}:${id}${accessKey ? `:${accessKey}` : ''}`;
    if (id != null) return `${type}:${id}`;
    return fallback;
}

function messageIdentity(platform, message, fallbackPath = '') {
    if (!message || typeof message !== 'object') return '';
    if (platform === 'telegram') {
        const chatId = firstDefined(message?.chat, ['id']) ?? firstDefined(message, ['chat_id', 'chatId']);
        const messageId = firstDefined(message, ['message_id', 'messageId', 'id']);
        return messageId != null ? `telegram:${chatId ?? ''}:${messageId}` : '';
    }
    const peerId = firstDefined(message, ['peer_id', 'peerId']);
    const cmid = firstDefined(message, ['conversation_message_id', 'conversationMessageId']);
    const id = firstDefined(message, ['id', 'message_id', 'messageId']);
    if (cmid != null) return `vk:${peerId ?? ''}:cmid:${cmid}`;
    if (id != null) return `vk:${peerId ?? ''}:id:${id}`;
    return fallbackPath ? '' : '';
}

function createTraversalState({ platform, maxDepth, maxImages, maxNodes, onEvent }) {
    const images = [];
    const textNodes = [];
    const visitedObjects = new WeakSet();
    const visitedMessageIds = new Set();
    const visitedAttachmentIds = new Set();
    const seenUrls = new Set();
    const events = [];
    const stats = {
        nodesVisited: 0,
        imagesDiscovered: 0,
        duplicateImagesSkipped: 0,
        cyclesSkipped: 0,
        depthLimitHits: 0,
        nodeLimitHits: 0,
        imageLimitHits: 0,
    };

    const emit = (type, data = {}) => {
        const event = { type, ...data };
        events.push(event);
        if (typeof onEvent === 'function') onEvent(event);
    };

    const enterObject = (value, { path, depth, messageId = '' } = {}) => {
        if (!value || typeof value !== 'object') return false;
        if (depth > maxDepth) {
            stats.depthLimitHits += 1;
            emit('depth-limit', { path, depth, maxDepth });
            return false;
        }
        if (stats.nodesVisited >= maxNodes) {
            stats.nodeLimitHits += 1;
            emit('node-limit', { path, depth, maxNodes });
            return false;
        }
        if (messageId && visitedMessageIds.has(messageId)) {
            stats.cyclesSkipped += 1;
            emit('message-cycle', { path, depth, messageId });
            return false;
        }
        if (visitedObjects.has(value)) {
            stats.cyclesSkipped += 1;
            emit('object-cycle', { path, depth });
            return false;
        }
        visitedObjects.add(value);
        if (messageId) visitedMessageIds.add(messageId);
        stats.nodesVisited += 1;
        return true;
    };

    const addText = ({ text, path, depth, sourceMessageId = '', kind = 'message' }) => {
        const clean = compactBlock(text);
        if (!clean) return;
        textNodes.push({ text: clean, path, depth, sourceMessageId, kind, order: textNodes.length + 1 });
    };

    const addImage = (image) => {
        if (images.length >= maxImages) {
            stats.imageLimitHits += 1;
            emit('image-limit', { path: image.sourcePath, maxImages });
            return;
        }
        const attachmentId = compactLine(image.attachmentId);
        const canonicalUrl = canonicalizeUrl(image.url);
        const attachmentKey = attachmentId ? `${platform}:${attachmentId}` : '';
        const urlKey = canonicalUrl ? `${platform}:url:${canonicalUrl}` : '';
        if ((attachmentKey && visitedAttachmentIds.has(attachmentKey)) || (urlKey && seenUrls.has(urlKey))) {
            stats.duplicateImagesSkipped += 1;
            emit('image-duplicate', {
                sourcePath: image.sourcePath,
                attachmentId,
                url: canonicalUrl,
            });
            return;
        }
        if (attachmentKey) visitedAttachmentIds.add(attachmentKey);
        if (urlKey) seenUrls.add(urlKey);
        const normalized = {
            ...image,
            order: images.length + 1,
            url: compactLine(image.url),
            canonicalUrl,
            attachmentId,
            sourceMessageId: compactLine(image.sourceMessageId),
            sourcePath: String(image.sourcePath || ''),
            nestingDepth: Math.max(0, Number(image.nestingDepth) || 0),
            attachmentIndex: Math.max(0, Number(image.attachmentIndex) || 0),
            attachmentCount: Math.max(0, Number(image.attachmentCount) || 0),
            caption: compactBlock(image.caption),
        };
        images.push(normalized);
        stats.imagesDiscovered += 1;
        emit('image-discovered', normalized);
    };

    return {
        platform,
        images,
        textNodes,
        events,
        stats,
        emit,
        enterObject,
        addText,
        addImage,
        visitedMessageIds,
        visitedAttachmentIds,
    };
}

function annotateGroupPositions(images) {
    const groups = new Map();
    for (const image of images) {
        const key = image.groupPath || image.sourcePath.replace(/\[[0-9]+\](?::[^.]*)?$/u, '');
        if (!groups.has(key)) groups.set(key, []);
        groups.get(key).push(image);
    }
    for (const group of groups.values()) {
        const total = group.length;
        group.forEach((image, index) => {
            image.imageIndexInGroup = index + 1;
            image.imageCountInGroup = total;
        });
    }
}

function collectVkContext(rawMessage, state) {
    let visitMessage;
    let visitWall;
    let visitAttachments;

    const messageText = (message) => firstDefined(message, ['text', 'body', 'caption']);

    visitAttachments = (rawAttachments, depth, path, sourceMessageId = '', caption = '') => {
        if (depth > state.maxDepth) {
            state.stats.depthLimitHits += 1;
            state.emit('depth-limit', { path, depth, maxDepth: state.maxDepth });
            return;
        }
        const list = asArray(rawAttachments);
        const imageAttachmentCount = list.filter((raw) => {
            const attachment = toPlainObject(raw);
            const type = getVkAttachmentType(attachment);
            const payload = getVkAttachmentPayload(attachment, type);
            return type === 'photo' || ((type === 'doc' || type === 'document') && isVkImageDocument(payload));
        }).length;
        let imageAttachmentIndex = 0;

        list.slice(0, 100).forEach((rawAttachment, index) => {
            const attachment = toPlainObject(rawAttachment);
            if (!attachment || typeof attachment !== 'object') return;
            const type = getVkAttachmentType(attachment);
            const payload = getVkAttachmentPayload(attachment, type);
            const itemPath = `${path}[${index}]${type ? `:${type}` : ''}`;

            if (type === 'photo') {
                imageAttachmentIndex += 1;
                const url = selectLargestImageUrl(payload);
                state.addImage({
                    platform: 'vk',
                    attachmentType: 'photo',
                    attachmentId: attachmentIdentity('vk', 'photo', payload, itemPath),
                    attachmentIndex: imageAttachmentIndex,
                    attachmentCount: imageAttachmentCount,
                    sourceMessageId,
                    sourcePath: itemPath,
                    groupPath: path,
                    nestingDepth: depth,
                    url,
                    caption: firstDefined(payload, ['text', 'caption']) || caption,
                    rawReference: {
                        ownerId: firstDefined(payload, ['owner_id', 'ownerId']),
                        id: firstDefined(payload, ['id', 'photo_id', 'photoId']),
                    },
                });
                return;
            }

            if ((type === 'doc' || type === 'document') && isVkImageDocument(payload)) {
                imageAttachmentIndex += 1;
                state.addImage({
                    platform: 'vk',
                    attachmentType: 'document-image',
                    attachmentId: attachmentIdentity('vk', 'doc', payload, itemPath),
                    attachmentIndex: imageAttachmentIndex,
                    attachmentCount: imageAttachmentCount,
                    sourceMessageId,
                    sourcePath: itemPath,
                    groupPath: path,
                    nestingDepth: depth,
                    url: firstDefined(payload, ['url', 'preview_url', 'previewUrl']) || selectLargestImageUrl(payload?.preview || {}),
                    caption: firstDefined(payload, ['title', 'name', 'caption']) || caption,
                    rawReference: {
                        ownerId: firstDefined(payload, ['owner_id', 'ownerId']),
                        id: firstDefined(payload, ['id', 'doc_id', 'docId']),
                    },
                });
                return;
            }

            if (type === 'wall') {
                visitWall(payload, depth, itemPath, sourceMessageId);
                return;
            }

            if (type === 'wall_reply') {
                const replyId = attachmentIdentity('vk', 'wall_reply', payload, itemPath);
                if (!state.enterObject(payload, { path: itemPath, depth, messageId: replyId })) return;
                state.addText({
                    text: firstDefined(payload, ['text', 'body', 'caption']),
                    path: itemPath,
                    depth,
                    sourceMessageId: replyId || sourceMessageId,
                    kind: 'wall_reply',
                });
                visitAttachments(
                    firstDefined(payload, ['attachments', 'attachment']),
                    depth,
                    `${itemPath}.attachments`,
                    replyId || sourceMessageId,
                    firstDefined(payload, ['text', 'body', 'caption']) || caption,
                );
                const threadItems = firstDefined(payload, ['thread', 'replies'])?.items;
                if (Array.isArray(threadItems)) {
                    threadItems.slice(0, 50).forEach((item, threadIndex) => {
                        visitMessage(item, depth + 1, `${itemPath}.thread[${threadIndex}]`);
                    });
                }
                return;
            }

            if (payload && typeof payload === 'object') {
                state.addText({
                    text: [
                        firstDefined(payload, ['title', 'name', 'file_name', 'fileName']),
                        firstDefined(payload, ['description', 'caption', 'text']),
                    ].filter(Boolean).join('\n'),
                    path: itemPath,
                    depth,
                    sourceMessageId,
                    kind: type || 'attachment',
                });
                // Some platform wrappers put nested attachments inside generic payloads.
                for (const key of ['attachments', 'attachment', 'copy_history', 'copyHistory', 'fwd_messages', 'forwarded_messages']) {
                    if (payload[key] != null) {
                        if (/copy_history|copyHistory/u.test(key)) {
                            asArray(payload[key]).slice(0, 50).forEach((item, nestedIndex) => visitWall(item, depth + 1, `${itemPath}.${key}[${nestedIndex}]`, sourceMessageId));
                        } else if (/fwd|forwarded/u.test(key)) {
                            asArray(payload[key]).slice(0, 50).forEach((item, nestedIndex) => visitMessage(item, depth + 1, `${itemPath}.${key}[${nestedIndex}]`));
                        } else {
                            visitAttachments(payload[key], depth + 1, `${itemPath}.${key}`, sourceMessageId, caption);
                        }
                    }
                }
            }
        });
    };

    visitWall = (rawWall, depth, path, parentMessageId = '') => {
        const wall = toPlainObject(rawWall);
        const owner = firstDefined(wall, ['owner_id', 'ownerId']);
        const id = firstDefined(wall, ['post_id', 'postId', 'id']);
        const wallId = owner != null && id != null ? `vk:wall:${owner}:${id}` : '';
        if (!state.enterObject(wall, { path, depth, messageId: wallId })) return;
        const text = messageText(wall);
        state.addText({ text, path, depth, sourceMessageId: wallId || parentMessageId, kind: 'wall' });
        visitAttachments(
            firstDefined(wall, ['attachments', 'attachment']),
            depth,
            `${path}.attachments`,
            wallId || parentMessageId,
            text,
        );
        const copies = firstDefined(wall, ['copy_history', 'copyHistory']);
        asArray(copies).slice(0, 50).forEach((copy, index) => {
            visitWall(copy, depth + 1, `${path}.repost[${index}]`, wallId || parentMessageId);
        });
    };

    visitMessage = (raw, depth = 0, path = 'message') => {
        const message = toPlainObject(raw);
        const id = messageIdentity('vk', message, path);
        if (!state.enterObject(message, { path, depth, messageId: id })) return;
        const text = messageText(message);
        state.addText({ text, path, depth, sourceMessageId: id, kind: 'message' });
        visitAttachments(
            firstDefined(message, ['attachments', 'attachment']),
            depth,
            `${path}.attachments`,
            id,
            text,
        );

        const reply = firstDefined(message, ['reply_message', 'replyMessage', 'reply_to_message', 'replyToMessage']);
        if (reply && typeof reply === 'object') visitMessage(reply, depth + 1, `${path}.reply`);

        const forwarded = firstDefined(message, ['fwd_messages', 'fwdMessages', 'forwarded_messages', 'forwardedMessages', 'forward_message', 'forwardMessage']);
        asArray(forwarded).slice(0, 50).forEach((item, index) => {
            visitMessage(item, depth + 1, `${path}.forward[${index}]`);
        });

        const reposted = firstDefined(message, ['repost', 'reposted_message', 'repostedMessage', 'shared_message', 'sharedMessage']);
        asArray(reposted).slice(0, 50).forEach((item, index) => {
            if (!item || typeof item !== 'object') return;
            const plain = toPlainObject(item);
            if (plain?.copy_history || plain?.copyHistory || plain?.post_id || plain?.postId) {
                visitWall(plain, depth + 1, `${path}.repost[${index}]`, id);
            } else {
                visitMessage(plain, depth + 1, `${path}.repost[${index}]`);
            }
        });
    };

    visitMessage(rawMessage);
}

function collectTelegramContext(rawMessage, state) {
    const visitMessage = (raw, depth = 0, path = 'message') => {
        const message = toPlainObject(raw);
        const id = messageIdentity('telegram', message, path);
        if (!state.enterObject(message, { path, depth, messageId: id })) return;

        const text = firstDefined(message, ['text', 'caption']);
        state.addText({ text, path, depth, sourceMessageId: id, kind: 'message' });

        const photo = Array.isArray(message?.photo) ? message.photo.at(-1) : null;
        if (photo?.file_id) {
            state.addImage({
                platform: 'telegram',
                attachmentType: 'photo',
                attachmentId: attachmentIdentity('telegram', 'photo', photo, `${path}.photo`),
                attachmentIndex: 1,
                attachmentCount: 1,
                sourceMessageId: id,
                sourcePath: `${path}.photo`,
                groupPath: `${path}.photo`,
                nestingDepth: depth,
                fileId: compactLine(photo.file_id),
                fileUniqueId: compactLine(photo.file_unique_id),
                caption: message.caption || '',
                url: '',
            });
        }

        const document = message?.document;
        if (document?.file_id && /^image\//iu.test(String(document.mime_type ?? ''))) {
            state.addImage({
                platform: 'telegram',
                attachmentType: 'document-image',
                attachmentId: attachmentIdentity('telegram', 'document', document, `${path}.document`),
                attachmentIndex: 1,
                attachmentCount: 1,
                sourceMessageId: id,
                sourcePath: `${path}.document`,
                groupPath: `${path}.document`,
                nestingDepth: depth,
                fileId: compactLine(document.file_id),
                fileUniqueId: compactLine(document.file_unique_id),
                caption: message.caption || document.file_name || '',
                url: '',
            });
        }

        const animation = message?.animation;
        if (animation?.file_id && /^image\//iu.test(String(animation.mime_type ?? 'image/gif'))) {
            state.addImage({
                platform: 'telegram',
                attachmentType: 'animation-image',
                attachmentId: attachmentIdentity('telegram', 'animation', animation, `${path}.animation`),
                attachmentIndex: 1,
                attachmentCount: 1,
                sourceMessageId: id,
                sourcePath: `${path}.animation`,
                groupPath: `${path}.animation`,
                nestingDepth: depth,
                fileId: compactLine(animation.file_id),
                fileUniqueId: compactLine(animation.file_unique_id),
                caption: message.caption || '',
                url: '',
            });
        }

        const reply = firstDefined(message, ['reply_to_message', 'reply_message', 'replyToMessage', 'replyMessage']);
        if (reply && typeof reply === 'object') visitMessage(reply, depth + 1, `${path}.reply`);

        const forwarded = firstDefined(message, [
            'forwarded_messages', 'forwardedMessages', 'fwd_messages', 'fwdMessages',
            'forward_message', 'forwardMessage', 'repost', 'reposted_message',
        ]);
        asArray(forwarded).slice(0, 50).forEach((item, index) => {
            if (item && typeof item === 'object') visitMessage(item, depth + 1, `${path}.forward[${index}]`);
        });
    };

    visitMessage(rawMessage);
}

async function resolveTelegramUrls(images, api, state) {
    if (!api || typeof api.getFile !== 'function' || typeof api.buildFileUrl !== 'function') return;
    const cache = new Map();
    for (const image of images) {
        if (!image.fileId || image.url) continue;
        try {
            let url = cache.get(image.fileId);
            if (!url) {
                const file = await api.getFile(image.fileId);
                const filePath = compactLine(file?.file_path);
                url = filePath ? compactLine(api.buildFileUrl(filePath)) : '';
                if (url) cache.set(image.fileId, url);
            }
            image.url = url;
            image.canonicalUrl = canonicalizeUrl(url);
            state.emit('image-url-resolved', {
                sourcePath: image.sourcePath,
                attachmentId: image.attachmentId,
                url: image.canonicalUrl,
            });
        } catch (error) {
            image.resolveError = String(error?.message ?? error).slice(0, 1000);
            state.emit('image-url-error', {
                sourcePath: image.sourcePath,
                attachmentId: image.attachmentId,
                error: image.resolveError,
            });
        }
    }
}

function getRawMessage(rawContext, platform) {
    if (platform === 'telegram') return rawContext?.message ?? rawContext ?? {};
    return rawContext?.eventPayload?.object?.message ?? rawContext?.eventPayload?.object ?? rawContext?.message ?? rawContext ?? {};
}

export async function collectIncomingMediaContext(rawContext, {
    maxDepth = DEFAULT_MAX_DEPTH,
    maxImages = DEFAULT_MAX_IMAGES,
    maxNodes = DEFAULT_MAX_NODES,
    onEvent = null,
} = {}) {
    const platform = String(rawContext?.platform ?? '').toLowerCase() === 'telegram' || rawContext?.telegramApi
        ? 'telegram'
        : 'vk';
    const state = createTraversalState({ platform, maxDepth, maxImages, maxNodes, onEvent });
    state.maxDepth = maxDepth;
    const rawMessage = getRawMessage(rawContext, platform);

    if (platform === 'telegram') collectTelegramContext(rawMessage, state);
    else collectVkContext(rawMessage, state);

    annotateGroupPositions(state.images);
    if (platform === 'telegram') await resolveTelegramUrls(state.images, rawContext?.telegramApi, state);

    return {
        platform,
        rawMessage,
        images: state.images,
        textNodes: state.textNodes,
        events: state.events,
        stats: {
            ...state.stats,
            textNodes: state.textNodes.length,
            imagesDiscovered: state.images.length,
        },
        limits: { maxDepth, maxImages, maxNodes },
    };
}

function collectUrlsRecursively(value, urls, visited, traversal = { nodes: 0 }, depth = 0) {
    if (value == null || traversal.nodes >= DEFAULT_MAX_NODES || depth > DEFAULT_MAX_DEPTH) return;
    if (typeof value === 'string') {
        if (looksLikeImageUrl(value) && !urls.includes(value)) urls.push(value);
        return;
    }
    if (typeof value !== 'object' || visited.has(value)) return;
    visited.add(value);
    traversal.nodes += 1;

    if (Array.isArray(value)) {
        for (const item of value.slice(0, 100)) collectUrlsRecursively(item, urls, visited, traversal, depth + 1);
        return;
    }

    const largestImageUrl = selectLargestImageUrl(value);
    if (largestImageUrl && !urls.includes(largestImageUrl)) urls.push(largestImageUrl);

    for (const [key, child] of Object.entries(value)) {
        if (/^(?:access_key|hash|date|id|owner_id|from_id|random_id)$/iu.test(key)) continue;
        if (
            /^(?:url|src|preview|image|images|photo|thumb|first_frame|cover)$/iu.test(key) ||
            /^(?:attachments|attachment|reply_message|replyMessage|replyToMessage|reply_to_message|fwd_messages|fwdMessages|forwarded_messages|forwardedMessages|forward_message|forwardMessage|copy_history|copyHistory|wall|wall_reply|wallReply|thread|replies|repost|reposted_message|repostedMessage|shared_message|sharedMessage)$/iu.test(key) ||
            typeof child === 'string'
        ) {
            collectUrlsRecursively(child, urls, visited, traversal, depth + 1);
        }
    }
}

export function extractVkImageTargets(rawMessage) {
    const state = createTraversalState({
        platform: 'vk',
        maxDepth: DEFAULT_MAX_DEPTH,
        maxImages: DEFAULT_MAX_IMAGES,
        maxNodes: DEFAULT_MAX_NODES,
        onEvent: null,
    });
    state.maxDepth = DEFAULT_MAX_DEPTH;
    collectVkContext(rawMessage, state);
    return state.images
        .map((image) => compactLine(image.url))
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, DEFAULT_MAX_IMAGES);
}

function collectTelegramFileIds(message, fileIds, depth = 0, visited = new WeakSet()) {
    if (depth > DEFAULT_MAX_DEPTH || !message || typeof message !== 'object' || visited.has(message)) return;
    visited.add(message);
    const add = (fileId) => {
        const clean = compactLine(fileId);
        if (clean && !fileIds.includes(clean) && fileIds.length < DEFAULT_MAX_IMAGES) fileIds.push(clean);
    };
    const photo = Array.isArray(message.photo) ? message.photo.at(-1) : null;
    if (photo?.file_id) add(photo.file_id);
    if (message.document?.file_id && /^image\//iu.test(String(message.document.mime_type ?? ''))) add(message.document.file_id);
    if (message.animation?.file_id) add(message.animation.file_id);
    for (const key of ['reply_to_message', 'reply_message', 'replyToMessage', 'replyMessage', 'forwarded_messages', 'forwardedMessages', 'fwd_messages', 'fwdMessages', 'forward_message', 'forwardMessage', 'repost']) {
        const nested = message[key];
        for (const item of asArray(nested)) {
            if (item && typeof item === 'object') collectTelegramFileIds(item, fileIds, depth + 1, visited);
        }
    }
}

export async function extractTelegramImageTargets(message, api) {
    if (!api || typeof api.getFile !== 'function' || typeof api.buildFileUrl !== 'function') return [];
    const fileIds = [];
    collectTelegramFileIds(message, fileIds);
    const urls = [];
    for (const fileId of fileIds) {
        try {
            const file = await api.getFile(fileId);
            const filePath = compactLine(file?.file_path);
            const url = filePath ? compactLine(api.buildFileUrl(filePath)) : '';
            if (url && !urls.includes(url)) urls.push(url);
        } catch {
            // A single unavailable Telegram file must not hide other images.
        }
    }
    return urls;
}

export async function resolveIncomingImageTargets(rawContext) {
    const context = await collectIncomingMediaContext(rawContext);
    return context.images
        .map((image) => compactLine(image.url))
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .slice(0, DEFAULT_MAX_IMAGES);
}
