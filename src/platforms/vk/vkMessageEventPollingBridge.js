import { MessageEventContext, UpdateSource } from 'vk-io';

/**
 * vk-io does not currently map community Long Poll type 80 (message_event)
 * into a Context. Inline VK callback buttons use that update, so adapt it to
 * the same MessageEventContext used by Callback API before it reaches users.
 */
export function installVkMessageEventPollingBridge(updates, { role = '', logger = console } = {}) {
    if (!updates || typeof updates.handlePollingUpdate !== 'function' || typeof updates.dispatchMiddleware !== 'function') {
        throw new TypeError('VK updates instance must support polling updates and middleware dispatch');
    }
    if (updates.__gigoraveMessageEventBridge) return false;

    const originalHandlePollingUpdate = updates.handlePollingUpdate.bind(updates);
    updates.handlePollingUpdate = update => {
        const updateType = Array.isArray(update) ? update[0] : update?.type;
        if (Number(updateType) !== 80 && String(updateType) !== 'message_event') {
            return originalHandlePollingUpdate(update);
        }

        const payload = Array.isArray(update)
            ? (update[1] && typeof update[1] === 'object'
                ? update[1]
                : (() => {
                    // VK has emitted both positional layouts over API versions:
                    // payload/message_id and message_id/payload. Detect the
                    // payload by shape instead of silently swapping the fields.
                    const fourth = update[4];
                    const fifth = update[5];
                    const fourthLooksLikePayload = typeof fourth === 'object' ||
                        (typeof fourth === 'string' && /[\{\[]/u.test(fourth.trim()));
                    const callbackPayload = fourthLooksLikePayload ? fourth : fifth;
                    const conversationMessageId = fourthLooksLikePayload ? fifth : fourth;
                    return {
                        event_id: update[1],
                        user_id: update[2],
                        peer_id: update[3],
                        payload: callbackPayload,
                        conversation_message_id: conversationMessageId,
                    };
                })())
            : (update?.object || update?.payload || update);
        logger.info?.('[VK MESSAGE EVENT POLLING BRIDGE]', 'role=' + role,
            'peer=' + (payload?.peer_id || 0), 'user=' + (payload?.user_id || 0));
        const context = new MessageEventContext({
            api: updates.api,
            upload: updates.upload,
            payload,
            updateType: 'message_event',
            source: UpdateSource.POLLING,
        });
        return updates.dispatchMiddleware(context);
    };
    updates.__gigoraveMessageEventBridge = true;
    logger.info?.('[VK MESSAGE EVENT POLLING BRIDGE READY]', 'role=' + role);
    return true;
}
