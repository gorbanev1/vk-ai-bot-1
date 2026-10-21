import {
    collectVkVoiceAttachments,
} from '../../features/ai/voiceTranscription.js';

/**
 * Нормализация содержимого VK-сообщений и вложений.
 *
 * VK может прислать сообщение с пустым message.text, хотя видимый текст
 * находится внутри wall_reply, wall, copy_history, reply_message либо
 * fwd_messages. Этот модуль извлекает семантическое содержимое один раз,
 * чтобы база, GPT, резюмирование и reply-анализ видели один и тот же текст.
 */

// Repost/forward chains must be followed to their real source. Depth is only a
// gross stack-safety guard; the practical limiter is the visited-node budget,
// so ordinary nested chains are never cut after an arbitrary 4/8 levels.
const MAX_DEPTH = 64;
const MAX_CONTENT_NODES = 256;
const MAX_TEXT_CHARS = 14000;
const MAX_SUMMARY_CHARS = 5000;
const MAX_REMOTE_WALL_REPLIES = 6;

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
    if (!object || typeof object !== 'object') {
        return undefined;
    }

    for (const field of fields) {
        if (object[field] !== undefined && object[field] !== null) {
            return object[field];
        }
    }

    return undefined;
}

function asInteger(value) {
    const number = Number(value);

    return Number.isSafeInteger(number) ? number : 0;
}

function toPlainObject(value) {
    if (!value || typeof value !== 'object') {
        return value;
    }

    if (typeof value.toJSON === 'function') {
        try {
            const json = value.toJSON();

            if (json && typeof json === 'object') {
                return json;
            }
        } catch {
            // Некоторые vk-io attachment-классы могут быть частично загружены.
        }
    }

    return value;
}

function getAttachmentType(attachment) {
    const source = toPlainObject(attachment);

    if (!source || typeof source !== 'object') {
        return '';
    }

    const explicit = compactLine(
        source.type ??
        source.attachmentType ??
        source.kind,
    ).toLowerCase();

    if (explicit) {
        return explicit.replace(/-/gu, '_');
    }

    const knownTypes = [
        'wall_reply',
        'wallReply',
        'audio_message',
        'wall',
        'link',
        'photo',
        'video',
        'audio',
        'doc',
        'document',
        'poll',
        'market',
        'market_album',
        'podcast',
        'graffiti',
        'sticker',
        'voice',
        'animation',
    ];

    const detected = knownTypes.find((type) => source[type] != null);

    return detected === 'wallReply' ? 'wall_reply' : (detected ?? '');
}

function getAttachmentPayload(attachment, type = getAttachmentType(attachment)) {
    const source = toPlainObject(attachment);

    if (!source || typeof source !== 'object') {
        return {};
    }

    const candidates = type === 'wall_reply'
        ? ['wall_reply', 'wallReply']
        : [type];

    for (const key of candidates) {
        const nested = source[key];

        if (nested && typeof nested === 'object') {
            return toPlainObject(nested);
        }
    }

    if (source.payload && typeof source.payload === 'object') {
        return toPlainObject(source.payload);
    }

    return source;
}

function buildWallUrl(ownerId, postId) {
    return ownerId && postId
        ? `https://vk.com/wall${ownerId}_${postId}`
        : '';
}

function buildWallReplyUrl(ownerId, postId, commentId) {
    const base = buildWallUrl(ownerId, postId);

    return base && commentId ? `${base}?reply=${commentId}` : base;
}

function formatAuthorName(payload) {
    return compactLine(
        firstDefined(payload, [
            'author_name',
            'authorName',
            'from_name',
            'fromName',
            'screen_name',
            'screenName',
        ]),
    );
}

function uniqueJoin(values, maximumCharacters) {
    const output = [];
    const seen = new Set();

    for (const value of values) {
        const clean = compactBlock(value);

        if (!clean || seen.has(clean)) {
            continue;
        }

        seen.add(clean);
        output.push(clean);
    }

    return output.join('\n\n').slice(0, maximumCharacters);
}

function createCollector() {
    const blocks = [];
    const summaries = [];
    const unresolvedWallReplies = [];
    const visited = new WeakSet();
    let visitedNodes = 0;
    const summarySeen = new Set();

    const addBlock = (value) => {
        const clean = compactBlock(value);

        if (clean) {
            blocks.push(clean);
        }
    };

    const addSummary = (value) => {
        const clean = compactLine(value);

        if (!clean || summarySeen.has(clean)) {
            return;
        }

        summarySeen.add(clean);
        summaries.push(clean);
    };

    const addUnresolvedWallReply = (descriptor) => {
        const key = [
            descriptor.ownerId,
            descriptor.postId,
            descriptor.commentId,
        ].join(':');

        if (
            !descriptor.commentId ||
            unresolvedWallReplies.some((item) => item.key === key)
        ) {
            return;
        }

        unresolvedWallReplies.push({
            ...descriptor,
            key,
        });
    };

    const enterNode = (value) => {
        if (!value || typeof value !== 'object' || visited.has(value)) {
            return false;
        }
        if (visitedNodes >= MAX_CONTENT_NODES) {
            return false;
        }
        visited.add(value);
        visitedNodes += 1;
        return true;
    };

    return {
        blocks,
        summaries,
        unresolvedWallReplies,
        visited,
        enterNode,
        addBlock,
        addSummary,
        addUnresolvedWallReply,
    };
}

function describeGenericAttachment(type, payload, collector) {
    const title = compactLine(firstDefined(payload, [
        'title',
        'name',
        'artist',
        'file_name',
        'fileName',
    ]));
    const description = compactBlock(firstDefined(payload, [
        'description',
        'caption',
        'text',
    ]));
    const url = compactLine(firstDefined(payload, [
        'url',
        'player',
        'external',
    ]));

    collector.addSummary([
        `type=${type || 'attachment'}`,
        title ? `title=${title}` : '',
        url ? `url=${url}` : '',
    ].filter(Boolean).join(' '));

    if (description) {
        collector.addBlock([
            `[Вложение VK: ${type || 'attachment'}]`,
            title ? `Название: ${title}` : '',
            description,
            url ? `Источник: ${url}` : '',
        ].filter(Boolean).join('\n'));
    } else if (type === 'link' && (title || url)) {
        collector.addBlock([
            '[Ссылка VK]',
            title ? `Название: ${title}` : '',
            url ? `Источник: ${url}` : '',
        ].filter(Boolean).join('\n'));
    }
}

function collectWallReply(payload, collector, depth, visitAttachments) {
    const ownerId = asInteger(firstDefined(payload, ['owner_id', 'ownerId']));
    const postId = asInteger(firstDefined(payload, ['post_id', 'postId']));
    const commentId = asInteger(firstDefined(payload, [
        'comment_id',
        'commentId',
        'id',
    ]));
    const authorId = asInteger(firstDefined(payload, [
        'from_id',
        'fromId',
        'author_id',
        'authorId',
    ]));
    const authorName = formatAuthorName(payload);
    const text = compactBlock(firstDefined(payload, [
        'text',
        'body',
        'caption',
    ]));
    const accessKey = compactLine(
        firstDefined(payload, ['access_key', 'accessKey']),
    );
    const sourceUrl = compactLine(
        firstDefined(payload, ['url', 'source_url', 'sourceUrl']),
    ) || buildWallReplyUrl(ownerId, postId, commentId);

    collector.addSummary([
        'type=wall_reply',
        ownerId ? `owner=${ownerId}` : '',
        postId ? `post=${postId}` : '',
        commentId ? `comment=${commentId}` : '',
        authorId ? `author=${authorId}` : '',
        text ? `text=${compactLine(text).slice(0, 320)}` : '',
        sourceUrl ? `url=${sourceUrl}` : '',
    ].filter(Boolean).join(' '));

    if (text) {
        collector.addBlock([
            '[Комментарий к посту VK]',
            authorName ? `Автор комментария: ${authorName}` : '',
            authorId ? `Индекс автора комментария: ${authorId}` : '',
            `Текст комментария:\n${text}`,
            sourceUrl ? `Источник: ${sourceUrl}` : '',
        ].filter(Boolean).join('\n'));
    } else {
        collector.addUnresolvedWallReply({
            ownerId,
            postId,
            commentId,
            authorId,
            sourceUrl,
            accessKey,
        });
    }

    visitAttachments(firstDefined(payload, [
        'attachments',
        'attachment',
    ]), depth + 1);

    const threadItems = firstDefined(payload, ['thread', 'replies'])?.items;

    if (Array.isArray(threadItems)) {
        for (const item of threadItems.slice(0, 20)) {
            collectWallReply(toPlainObject(item), collector, depth + 1, visitAttachments);
        }
    }
}

function collectWall(payload, collector, depth, visitAttachments, visitWall, repostDepth = 0) {
    const ownerId = asInteger(firstDefined(payload, ['owner_id', 'ownerId']));
    const postId = asInteger(firstDefined(payload, ['post_id', 'postId', 'id']));
    const authorId = asInteger(firstDefined(payload, ['from_id', 'fromId']));
    const text = compactBlock(firstDefined(payload, ['text', 'body', 'caption']));
    const sourceUrl = compactLine(
        firstDefined(payload, ['url', 'source_url', 'sourceUrl']),
    ) || buildWallUrl(ownerId, postId);

    collector.addSummary([
        'type=wall',
        ownerId ? `owner=${ownerId}` : '',
        postId ? `post=${postId}` : '',
        authorId ? `author=${authorId}` : '',
        text ? `text=${compactLine(text).slice(0, 320)}` : '',
        sourceUrl ? `url=${sourceUrl}` : '',
    ].filter(Boolean).join(' '));

    if (text) {
        collector.addBlock([
            repostDepth > 0
                ? `[Репост VK, уровень ${repostDepth}]`
                : '[Пост VK]',
            authorId ? `Индекс автора поста: ${authorId}` : '',
            `Текст поста:\n${text}`,
            sourceUrl ? `Источник: ${sourceUrl}` : '',
        ].filter(Boolean).join('\n'));
    }

    visitAttachments(firstDefined(payload, [
        'attachments',
        'attachment',
    ]), depth + 1);

    const copyHistory = firstDefined(payload, ['copy_history', 'copyHistory']);

    if (Array.isArray(copyHistory)) {
        for (const copiedPost of copyHistory.slice(0, 20)) {
            visitWall(toPlainObject(copiedPost), depth + 1, repostDepth + 1);
        }
    }
}

function extractProfileName(response, authorId) {
    if (!authorId || !response || typeof response !== 'object') {
        return '';
    }

    if (authorId > 0 && Array.isArray(response.profiles)) {
        const profile = response.profiles.find(
            (item) => asInteger(item?.id) === authorId,
        );

        if (profile) {
            return compactLine([
                profile.first_name,
                profile.last_name,
            ].filter(Boolean).join(' '));
        }
    }

    if (authorId < 0 && Array.isArray(response.groups)) {
        const group = response.groups.find(
            (item) => -Math.abs(asInteger(item?.id)) === authorId,
        );

        return compactLine(group?.name);
    }

    return '';
}

async function loadWallReply(vkApi, descriptor) {
    const wallApi = vkApi?.wall;

    if (!wallApi || !descriptor.commentId) {
        return null;
    }

    let response = null;

    if (typeof wallApi.getComment === 'function') {
        response = await wallApi.getComment({
            owner_id: descriptor.ownerId || undefined,
            comment_id: descriptor.commentId,
            extended: 1,
            access_key: descriptor.accessKey || undefined,
        });
    } else if (
        typeof wallApi.getComments === 'function' &&
        descriptor.ownerId &&
        descriptor.postId
    ) {
        response = await wallApi.getComments({
            owner_id: descriptor.ownerId,
            post_id: descriptor.postId,
            comment_id: descriptor.commentId,
            extended: 1,
            count: 1,
            access_key: descriptor.accessKey || undefined,
        });
    }

    const item =
        response?.items?.[0] ??
        response?.comment ??
        (response?.id ? response : null);

    if (!item || typeof item !== 'object') {
        return null;
    }

    const authorId = asInteger(firstDefined(item, ['from_id', 'fromId']));
    const authorName = extractProfileName(response, authorId);

    return {
        ...item,
        owner_id:
            firstDefined(item, ['owner_id', 'ownerId']) ??
            descriptor.ownerId,
        post_id:
            firstDefined(item, ['post_id', 'postId']) ??
            descriptor.postId,
        id:
            firstDefined(item, ['id', 'comment_id', 'commentId']) ??
            descriptor.commentId,
        author_name: authorName || undefined,
    };
}

/**
 * Синхронно извлекает всё содержимое, уже присутствующее в payload.
 */
export function extractVkMessageContent(rawMessage) {
    const collector = createCollector();
    let visitWall = null;

    const visitAttachments = (attachments, depth = 0) => {
        if (depth > MAX_DEPTH || attachments == null) {
            return;
        }

        const list = Array.isArray(attachments) ? attachments : [attachments];

        for (const rawAttachment of list.slice(0, 50)) {
            const attachment = toPlainObject(rawAttachment);

            if (!attachment || typeof attachment !== 'object') {
                continue;
            }

            const type = getAttachmentType(attachment);
            const payload = getAttachmentPayload(attachment, type);

            if (type === 'wall_reply') {
                collectWallReply(payload, collector, depth, visitAttachments);
                continue;
            }

            if (type === 'wall') {
                visitWall(payload, depth, 0);
                continue;
            }

            describeGenericAttachment(type, payload, collector);
        }
    };

    visitWall = (payload, depth = 0, repostDepth = 0) => {
        if (depth > MAX_DEPTH || !payload || typeof payload !== 'object') {
            return;
        }

        const source = toPlainObject(payload);
        if (!collector.enterNode(source)) {
            return;
        }

        collectWall(
            source,
            collector,
            depth,
            visitAttachments,
            visitWall,
            repostDepth,
        );
    };

    const visitMessage = (message, depth = 0, label = '') => {
        const source = toPlainObject(message);

        if (
            depth > MAX_DEPTH ||
            !source ||
            typeof source !== 'object'
        ) {
            return;
        }

        if (!collector.enterNode(source)) {
            return;
        }

        const text = compactBlock(firstDefined(source, [
            'text',
            'body',
            'caption',
        ]));

        if (text) {
            collector.addBlock(label
                ? `${label}\n${text}`
                : text);
        }

        visitAttachments(firstDefined(source, [
            'attachments',
            'attachment',
        ]), depth + 1);

        const replyMessage = firstDefined(source, [
            'reply_message',
            'replyMessage',
            'reply_to_message',
            'replyToMessage',
        ]);

        if (replyMessage && typeof replyMessage === 'object') {
            visitMessage(replyMessage, depth + 1, '[Сообщение, на которое ответили]');
        }

        const forwarded = firstDefined(source, [
            'fwd_messages',
            'fwdMessages',
            'forwarded_messages',
            'forwardedMessages',
        ]);

        if (Array.isArray(forwarded)) {
            for (const forwardedMessage of forwarded.slice(0, 30)) {
                visitMessage(
                    forwardedMessage,
                    depth + 1,
                    '[Пересланное сообщение VK]',
                );
            }
        }
    };

    visitMessage(rawMessage);

    // VK may provide a ready-made transcript inside audio_message. Treat it
    // as ordinary semantic message content so history, summaries and event
    // routing see the same words the user said. Missing transcripts are
    // resolved by the runtime STT fallback in botApplication.
    for (const voice of collectVkVoiceAttachments(rawMessage)) {
        if (!voice.transcript) continue;
        collector.addBlock([
            voice.isDirect ? '[Голосовое сообщение VK]' : '[Голосовое во вложении VK]',
            voice.transcript,
        ].join('\n'));
        collector.addSummary([
            'type=audio_message',
            voice.duration ? `duration=${voice.duration}` : '',
            voice.transcriptState ? `transcript_state=${voice.transcriptState}` : '',
            'transcript=present',
        ].filter(Boolean).join(' '));
    }

    return {
        directText: compactBlock(firstDefined(toPlainObject(rawMessage), [
            'text',
            'body',
            'caption',
        ])),
        text: uniqueJoin(collector.blocks, MAX_TEXT_CHARS),
        attachmentSummary: uniqueJoin(
            collector.summaries,
            MAX_SUMMARY_CHARS,
        ),
        unresolvedWallReplies: collector.unresolvedWallReplies.slice(
            0,
            MAX_REMOTE_WALL_REPLIES,
        ),
    };
}

/**
 * Догружает только те wall_reply, для которых VK прислал идентификаторы,
 * но не прислал текст. Ошибка сети не ломает обработку сообщения.
 */
export async function resolveVkMessageContent(rawMessage, {
    vkApi = null,
    onError = null,
} = {}) {
    const base = extractVkMessageContent(rawMessage);

    if (!base.unresolvedWallReplies.length || !vkApi) {
        return base;
    }

    const hydratedBlocks = [];
    const hydratedSummaries = [];
    const resolvedKeys = new Set();

    for (const descriptor of base.unresolvedWallReplies) {
        try {
            const payload = await loadWallReply(vkApi, descriptor);

            if (!payload) {
                continue;
            }

            const hydrated = extractVkMessageContent({
                attachments: [{
                    type: 'wall_reply',
                    wall_reply: payload,
                }],
            });

            if (hydrated.text) {
                hydratedBlocks.push(hydrated.text);
                resolvedKeys.add(descriptor.key);
            }

            if (hydrated.attachmentSummary) {
                hydratedSummaries.push(hydrated.attachmentSummary);
            }
        } catch (error) {
            if (typeof onError === 'function') {
                onError(error, descriptor);
            }
        }
    }

    return {
        ...base,
        text: uniqueJoin(
            [base.text, ...hydratedBlocks],
            MAX_TEXT_CHARS,
        ),
        attachmentSummary: uniqueJoin(
            [base.attachmentSummary, ...hydratedSummaries],
            MAX_SUMMARY_CHARS,
        ),
        unresolvedWallReplies: base.unresolvedWallReplies.filter(
            (item) => !resolvedKeys.has(item.key),
        ),
    };
}

export function getVkRawMessage(context) {
    return (
        context?.eventPayload?.object?.message ??
        context?.eventPayload?.object ??
        context?.message ??
        {}
    );
}
function collectDeepVkSemanticNodes(rawMessage) {
    const nodes = [];
    const visited = new WeakSet();
    let visitedCount = 0;

    const addNode = ({ kind, depth, text, sourceUrl = '', path = '' }) => {
        const clean = compactBlock(text);
        if (!clean) return;
        nodes.push({
            kind: String(kind || 'content'),
            depth: Math.max(0, Number(depth) || 0),
            text: clean,
            sourceUrl: compactLine(sourceUrl),
            path: String(path || ''),
        });
    };

    const enter = (value) => {
        if (!value || typeof value !== 'object' || visited.has(value) || visitedCount >= MAX_CONTENT_NODES) return false;
        visited.add(value);
        visitedCount += 1;
        return true;
    };

    let visitMessage;
    let visitWall;
    let visitAttachments;

    visitWall = (rawWall, depth, path) => {
        const wall = toPlainObject(rawWall);
        if (!enter(wall)) return;
        const ownerId = asInteger(firstDefined(wall, ['owner_id', 'ownerId']));
        const postId = asInteger(firstDefined(wall, ['post_id', 'postId', 'id']));
        const text = firstDefined(wall, ['text', 'body', 'caption']);
        addNode({
            kind: 'wall',
            depth,
            text,
            sourceUrl: compactLine(firstDefined(wall, ['url', 'source_url', 'sourceUrl'])) || buildWallUrl(ownerId, postId),
            path,
        });
        visitAttachments(firstDefined(wall, ['attachments', 'attachment']), depth + 1, `${path}.attachments`);
        const copies = firstDefined(wall, ['copy_history', 'copyHistory']);
        if (Array.isArray(copies)) {
            copies.slice(0, 30).forEach((item, index) => visitWall(item, depth + 1, `${path}.copy_history[${index}]`));
        }
    };

    visitAttachments = (rawAttachments, depth, path) => {
        const attachments = Array.isArray(rawAttachments) ? rawAttachments : rawAttachments ? [rawAttachments] : [];
        attachments.slice(0, 50).forEach((rawAttachment, index) => {
            const attachment = toPlainObject(rawAttachment);
            if (!attachment || typeof attachment !== 'object') return;
            const type = getAttachmentType(attachment);
            const payload = getAttachmentPayload(attachment, type);
            const itemPath = `${path}[${index}]:${type || 'attachment'}`;
            if (type === 'wall') {
                visitWall(payload, depth, itemPath);
                return;
            }
            if (type === 'wall_reply') {
                if (!enter(payload)) return;
                const ownerId = asInteger(firstDefined(payload, ['owner_id', 'ownerId']));
                const postId = asInteger(firstDefined(payload, ['post_id', 'postId']));
                const commentId = asInteger(firstDefined(payload, ['comment_id', 'commentId', 'id']));
                addNode({
                    kind: 'wall_reply',
                    depth,
                    text: firstDefined(payload, ['text', 'body', 'caption']),
                    sourceUrl: compactLine(firstDefined(payload, ['url', 'source_url', 'sourceUrl'])) || buildWallReplyUrl(ownerId, postId, commentId),
                    path: itemPath,
                });
                visitAttachments(firstDefined(payload, ['attachments', 'attachment']), depth + 1, `${itemPath}.attachments`);
                return;
            }
            if (!enter(payload)) return;
            const title = compactLine(firstDefined(payload, ['title', 'name', 'artist', 'file_name', 'fileName']));
            const description = compactBlock(firstDefined(payload, ['description', 'caption', 'text']));
            if (description || title) {
                addNode({
                    kind: type || 'attachment',
                    depth,
                    text: [title, description].filter(Boolean).join('\n'),
                    sourceUrl: compactLine(firstDefined(payload, ['url', 'player', 'external'])),
                    path: itemPath,
                });
            }
        });
    };

    visitMessage = (raw, depth = 0, path = 'message') => {
        const message = toPlainObject(raw);
        if (!enter(message)) return;
        addNode({
            kind: 'message',
            depth,
            text: firstDefined(message, ['text', 'body', 'caption']),
            path,
        });
        visitAttachments(firstDefined(message, ['attachments', 'attachment']), depth + 1, `${path}.attachments`);
        const reply = firstDefined(message, ['reply_message', 'replyMessage', 'reply_to_message', 'replyToMessage']);
        if (reply && typeof reply === 'object') visitMessage(reply, depth + 1, `${path}.reply`);
        const forwarded = firstDefined(message, ['fwd_messages', 'fwdMessages', 'forwarded_messages', 'forwardedMessages']);
        if (Array.isArray(forwarded)) forwarded.slice(0, 30).forEach((item, index) => visitMessage(item, depth + 1, `${path}.fwd[${index}]`));
    };

    visitMessage(rawMessage);
    return nodes;
}

export function extractDeepestVkAttachmentContent(rawMessage) {
    const nodes = collectDeepVkSemanticNodes(rawMessage);
    if (!nodes.length) return { text: '', nodes: [], depth: 0, sourceUrls: [] };

    // Prefer the deepest substantial semantic body. Tiny link titles are useful
    // metadata, but must not outrank the actual repost body above them.
    const substantial = nodes.filter((node) => node.text.length >= 40 || ['wall', 'wall_reply', 'message'].includes(node.kind));
    const pool = substantial.length ? substantial : nodes;
    const deepestDepth = Math.max(...pool.map((node) => node.depth));
    const deepest = pool.filter((node) => node.depth === deepestDepth);
    return {
        text: uniqueJoin(deepest.map((node) => node.text), MAX_TEXT_CHARS),
        nodes: deepest,
        depth: deepestDepth,
        sourceUrls: [...new Set(deepest.map((node) => node.sourceUrl).filter(Boolean))],
    };
}

async function hydrateWallForDeepContent(vkApi, wall) {
    const ownerId = asInteger(firstDefined(wall, ['owner_id', 'ownerId']));
    const postId = asInteger(firstDefined(wall, ['post_id', 'postId', 'id']));
    const accessKey = compactLine(firstDefined(wall, ['access_key', 'accessKey']));
    if (!ownerId || !postId || typeof vkApi?.wall?.getById !== 'function') return wall;
    const response = await vkApi.wall.getById({
        posts: `${ownerId}_${postId}${accessKey ? `_${accessKey}` : ''}`,
        extended: 1,
    });
    return response?.items?.[0] ?? (Array.isArray(response) ? response[0] : null) ?? wall;
}

export async function resolveDeepestVkAttachmentContent(rawMessage, {
    vkApi = null,
    onError = null,
} = {}) {
    if (!rawMessage || typeof rawMessage !== 'object') return extractDeepestVkAttachmentContent(rawMessage);
    if (!vkApi) return extractDeepestVkAttachmentContent(rawMessage);

    const root = toPlainObject(rawMessage);
    const seenWalls = new Set();
    const visited = new WeakSet();
    let visitedCount = 0;

    const walk = async (value, depth = 0) => {
        if (!value || typeof value !== 'object' || depth > MAX_DEPTH || visitedCount >= MAX_CONTENT_NODES) return value;
        const plain = toPlainObject(value);
        if (visited.has(plain)) return plain;
        visited.add(plain);
        visitedCount += 1;
        if (Array.isArray(plain)) {
            return Promise.all(plain.slice(0, 50).map((item) => walk(item, depth + 1)));
        }

        let current = { ...plain };
        const explicitType = getAttachmentType(current);
        if (explicitType === 'wall') {
            const wall = getAttachmentPayload(current, 'wall');
            const ownerId = asInteger(firstDefined(wall, ['owner_id', 'ownerId']));
            const postId = asInteger(firstDefined(wall, ['post_id', 'postId', 'id']));
            const key = `${ownerId}_${postId}`;
            if (ownerId && postId && !seenWalls.has(key)) {
                seenWalls.add(key);
                try {
                    const hydrated = await hydrateWallForDeepContent(vkApi, wall);
                    current.wall = await walk(hydrated, depth + 1);
                    current.type = 'wall';
                    return current;
                } catch (error) {
                    if (typeof onError === 'function') onError(error, { ownerId, postId });
                }
            }
        }

        for (const key of ['attachments', 'attachment', 'reply_message', 'replyMessage', 'reply_to_message', 'fwd_messages', 'forwarded_messages', 'copy_history', 'copyHistory']) {
            if (current[key] != null) current[key] = await walk(current[key], depth + 1);
        }
        return current;
    };

    const hydratedRoot = await walk(root);
    return extractDeepestVkAttachmentContent(hydratedRoot);
}

