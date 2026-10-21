import {
    extractVkMessageContent,
} from '../../platforms/vk/vkMessageContent.js';

/**
 * Извлекает сообщение-цель штатного reply из нормализованных контекстов
 * VK/Telegram. Модуль не обращается к сети и не разрешает VK-имена: он
 * возвращает устойчивые индексы, текст и доступное описание вложений.
 */

function asPositiveIndex(value) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0 ? number : 0;
}

function asParticipantIndex(value) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number !== 0 ? number : 0;
}

function compactLine(value) {
    return String(value ?? '')
        .replace(/\s+/gu, ' ')
        .trim();
}

function getAttachmentType(attachment) {
    if (!attachment || typeof attachment !== 'object') {
        return '';
    }

    if (attachment.type) {
        return compactLine(attachment.type);
    }

    const knownTypes = [
        'photo',
        'video',
        'audio',
        'doc',
        'document',
        'link',
        'wall',
        'wall_reply',
        'poll',
        'sticker',
        'voice',
        'animation',
    ];

    return knownTypes.find((type) => attachment[type]) ?? '';
}

export function formatTelegramReplyAuthor(rawReply) {
    const sender = rawReply?.from;

    if (!sender || typeof sender !== 'object') {
        return '';
    }

    const fullName = [sender.first_name, sender.last_name]
        .map(compactLine)
        .filter(Boolean)
        .join(' ');
    const username = compactLine(sender.username);

    if (fullName && username) {
        return `${fullName} (@${username})`;
    }

    return fullName || (username ? `@${username}` : '');
}

export function summarizeReplyTargetAttachments(rawReply) {
    const lines = [];
    const seen = new Set();
    const add = (value) => {
        const clean = compactLine(value);

        if (!clean || seen.has(clean)) {
            return;
        }

        seen.add(clean);
        lines.push(clean);
    };

    const attachments = Array.isArray(rawReply?.attachments)
        ? rawReply.attachments
        : [];

    for (const attachment of attachments.slice(0, 20)) {
        const type = getAttachmentType(attachment) || 'attachment';
        const payload = attachment?.[type] ?? attachment;
        const title = compactLine(
            payload?.title ??
            payload?.name ??
            payload?.artist,
        );
        const url = compactLine(
            payload?.url ??
            payload?.link?.url,
        );

        add([
            `type=${type}`,
            title ? `title=${title}` : '',
            url ? `url=${url}` : '',
        ].filter(Boolean).join(' '));
    }

    const telegramFields = [
        ['photo', rawReply?.photo],
        ['video', rawReply?.video],
        ['audio', rawReply?.audio],
        ['voice', rawReply?.voice],
        ['document', rawReply?.document],
        ['animation', rawReply?.animation],
        ['sticker', rawReply?.sticker],
    ];

    for (const [type, payload] of telegramFields) {
        if (!payload) {
            continue;
        }

        const value = Array.isArray(payload) ? payload.at(-1) : payload;
        const fileName = compactLine(value?.file_name);
        const mimeType = compactLine(value?.mime_type);

        add([
            `type=${type}`,
            fileName ? `file=${fileName}` : '',
            mimeType ? `mime=${mimeType}` : '',
        ].filter(Boolean).join(' '));
    }

    if (rawReply?.venue) {
        const title = compactLine(rawReply.venue.title);
        add(`type=venue${title ? ` title=${title}` : ''}`);
    }

    if (rawReply?.location) {
        add('type=location');
    }

    const vkContent = extractVkMessageContent(rawReply);

    for (const line of String(vkContent.attachmentSummary ?? '').split('\n')) {
        add(line);
    }

    return lines.join('\n').slice(0, 3000);
}

export function extractIncomingReplyTarget(rawContext) {
    const rawReply = rawContext?.message?.reply_message ?? null;
    const normalizedReply = rawContext?.replyMessage ?? null;

    if (!rawReply && !normalizedReply) {
        return null;
    }

    const messageIndex = asPositiveIndex(
        normalizedReply?.conversationMessageId ??
        rawReply?.conversation_message_id ??
        rawReply?.message_id ??
        rawReply?.id,
    );
    const participantIndex = asParticipantIndex(
        normalizedReply?.senderId ??
        rawReply?.from_id ??
        rawReply?.sender_id ??
        rawReply?.from?.id,
    );
    const directMessageText = [
        normalizedReply?.text,
        normalizedReply?.body,
        rawReply?.text,
        rawReply?.caption,
        rawReply?.body,
    ].map((value) => String(value ?? '').trim()).find(Boolean) ?? '';
    const vkContent = rawContext?.platform === 'vk'
        ? extractVkMessageContent(rawReply)
        : null;
    const messageText = String(
        vkContent?.text || directMessageText,
    ).trim();
    const attachments = [
        summarizeReplyTargetAttachments(rawReply),
        vkContent?.attachmentSummary,
    ].map((value) => String(value ?? '').trim())
        .filter(Boolean)
        .filter((value, index, values) => values.indexOf(value) === index)
        .join('\n')
        .slice(0, 3000);

    if (!messageIndex && !messageText && !attachments) {
        return null;
    }

    return {
        messageIndex,
        participantIndex,
        participantNameHint: rawContext?.platform === 'telegram'
            ? formatTelegramReplyAuthor(rawReply)
            : '',
        messageText,
        attachments,
    };
}
