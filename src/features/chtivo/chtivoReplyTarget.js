import { escapeRegExp } from '../../shared/regex.js';

export function buildChtivoReplyForward(peerId, messageId) {
    const normalizedPeerId = Number(peerId);
    const normalizedMessageId = Number(messageId);
    if (!Number.isSafeInteger(normalizedPeerId) || normalizedPeerId <= 0) return '';
    if (!Number.isSafeInteger(normalizedMessageId) || normalizedMessageId <= 0) return '';
    return JSON.stringify({
        conversation_message_ids: normalizedMessageId,
        peer_id: normalizedPeerId,
        is_reply: true,
    });
}

export async function resolveChtivoConversationMessageId(api, sent) {
    if (Array.isArray(sent)) sent = sent.length === 1 ? sent[0] : null;
    const directId = Number(sent?.conversationMessageId ?? sent?.conversation_message_id ?? 0);
    if (Number.isSafeInteger(directId) && directId > 0) return directId;

    const messageId = Number(sent?.id ?? sent?.message_id ?? sent?.messageId ?? (typeof sent === 'number' ? sent : 0));
    if (!Number.isSafeInteger(messageId) || messageId <= 0 || typeof api?.messages?.getById !== 'function') return 0;

    try {
        const response = await api.messages.getById({ message_ids: messageId });
        const item = Array.isArray(response?.items) ? response.items[0] : Array.isArray(response) ? response[0] : response;
        const conversationMessageId = Number(item?.conversation_message_id ?? item?.conversationMessageId ?? 0);
        return Number.isSafeInteger(conversationMessageId) && conversationMessageId > 0 ? conversationMessageId : 0;
    } catch {
        return 0;
    }
}

export function findLatestChtivoPartConversationMessageId(items, chapterTitle, { partNumber = 0, body = '', bookTitle = '' } = {}) {
    const title = String(chapterTitle ?? '').trim();
    if (!title) return 0;
    const header = new RegExp(
        `^(?:«[^»]+»\\n)?${escapeRegExp(title)}\\n(?:Гигорейв чтиво — продолжение за сегодня\\n)?Часть \\d+\\n\\n`,
        'iu',
    );
    for (const item of Array.isArray(items) ? items : []) {
        const text = String(item?.text ?? '').replace(/\r/gu, '');
        if (Number(item?.out ?? item?.is_outbox ?? 0) !== 1 || !header.test(text)) continue;
        if (partNumber && !text.split('\n\n')[0].endsWith('Часть ' + partNumber)) continue;
        if (body && !text.endsWith(String(body).replace(/\r/gu, ''))) continue;
        if (bookTitle && text.startsWith('«') && !text.startsWith('«' + bookTitle + '»\n')) continue;
        const messageId = Number(item?.conversation_message_id ?? item?.conversationMessageId ?? 0);
        if (Number.isSafeInteger(messageId) && messageId > 0) return messageId;
    }
    return 0;
}
