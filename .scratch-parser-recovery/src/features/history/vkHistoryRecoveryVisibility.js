function normalizePositiveInteger(value) {
    const numeric = Number(value);
    return Number.isSafeInteger(numeric) && numeric > 0 ? numeric : 0;
}

export function getVkHistoryResponseConversationMessageIds(response) {
    const items = Array.isArray(response?.items) ? response.items : [];
    return new Set(items
        .map((item) => normalizePositiveInteger(
            item?.conversation_message_id ??
            item?.conversationMessageId ??
            item?.id,
        ))
        .filter(Boolean));
}

export function assertVkHistoryBatchVisibility(response, expectedKnownCmids = [], {
    method = 'unknown',
    peerId = 0,
} = {}) {
    const expected = [...new Set((Array.isArray(expectedKnownCmids) ? expectedKnownCmids : [])
        .map(normalizePositiveInteger)
        .filter(Boolean))];

    if (!expected.length) return response;

    const visible = getVkHistoryResponseConversationMessageIds(response);
    if (expected.some((cmid) => visible.has(cmid))) return response;

    const error = new Error(
        `VK ${method} returned no locally-known messages for peer ${Number(peerId) || 0}; ` +
        `known cmids in requested batch: ${expected.slice(0, 12).join(',')}${expected.length > 12 ? ',…' : ''}`,
    );
    error.code = 'VK_HISTORY_RECOVERY_FALSE_EMPTY';
    error.peerId = Number(peerId) || 0;
    error.method = String(method || 'unknown');
    error.expectedKnownCmids = expected;
    throw error;
}
