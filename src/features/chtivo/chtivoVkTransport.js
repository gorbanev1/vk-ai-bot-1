import { randomInt } from 'node:crypto';
import { buildChtivoReplyForward, resolveChtivoConversationMessageId } from './chtivoReplyTarget.js';

export async function sendChtivoVkMessage(api, { peerId, message, replyTo = 0, randomId = 0 }) {
    const peer = Number(peerId);
    if (!Number.isSafeInteger(peer) || peer <= 0) throw new Error('Invalid reading peer');
    const stableRandomId = Number(randomId);
    const forward = buildChtivoReplyForward(peer, replyTo);
    // peer_ids returns the conversation ID in the delivery receipt. A scalar
    // peer_id response can be 0 for community messages, which breaks the chain.
    const response = await api.messages.send({
        peer_ids: [peer],
        random_id: Number.isSafeInteger(stableRandomId) && stableRandomId > 0 && stableRandomId <= 2_147_483_647
            ? stableRandomId : randomInt(1, 2_147_483_647),
        message: String(message),
        ...(forward ? { forward } : {}),
    });
    const sent = Array.isArray(response)
        ? response.find(item => Number(item?.peer_id) === peer)
        : response;
    if (sent?.error || sent?.error_code) {
        const detail = sent.error || sent;
        const error = new Error(detail.error_msg || detail.message || 'VK reading delivery failed');
        error.code = detail.error_code || detail.code;
        throw error;
    }
    const messageId = Number(sent?.message_id ?? sent?.id ?? (typeof sent === 'number' ? sent : 0));
    return {
        message_id: Number.isSafeInteger(messageId) && messageId > 0 ? messageId : 0,
        conversation_message_id: await resolveChtivoConversationMessageId(api, sent),
    };
}
