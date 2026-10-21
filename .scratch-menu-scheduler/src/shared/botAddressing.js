function numericSenderId(value) {
    const senderId = Number(
        value?.from_id ??
        value?.fromId ??
        value?.senderId ??
        value?.sender_id ??
        0,
    );

    return Number.isSafeInteger(senderId) ? senderId : 0;
}

function appendChildren(queue, value, depth) {
    if (!value || typeof value !== 'object') {
        return;
    }

    for (const child of [
        value.reply_message,
        value.replyMessage,
    ]) {
        if (child && typeof child === 'object') {
            queue.push({ value: child, depth: depth + 1 });
        }
    }

    for (const collection of [
        value.fwd_messages,
        value.forwardedMessages,
        value.forwards,
    ]) {
        if (!Array.isArray(collection)) {
            continue;
        }

        for (const child of collection) {
            if (child && typeof child === 'object') {
                queue.push({ value: child, depth: depth + 1 });
            }
        }
    }
}

/**
 * Возвращает true, когда входящее VK-сообщение является ответом на сообщение
 * сообщества или содержит его в цепочке цитат/пересланных сообщений.
 * Само корневое входящее сообщение намеренно не проверяется: его from_id —
 * отправитель-пользователь, а не адресат.
 */
export function vkContextReferencesGroupBot(context, groupId, {
    maxDepth = 7,
} = {}) {
    const normalizedGroupId = Math.abs(Number(groupId));

    if (!Number.isSafeInteger(normalizedGroupId) || normalizedGroupId <= 0) {
        return false;
    }

    const botSenderId = -normalizedGroupId;
    const rawMessage = context?.message ?? {};
    const queue = [];

    for (const root of [
        context?.replyMessage,
        rawMessage.reply_message,
        rawMessage.replyMessage,
    ]) {
        if (root && typeof root === 'object') {
            queue.push({ value: root, depth: 0 });
        }
    }

    for (const collection of [
        context?.forwards,
        context?.forwardedMessages,
        rawMessage.fwd_messages,
        rawMessage.forwardedMessages,
        rawMessage.forwards,
    ]) {
        if (!Array.isArray(collection)) {
            continue;
        }

        for (const root of collection) {
            if (root && typeof root === 'object') {
                queue.push({ value: root, depth: 0 });
            }
        }
    }

    const visited = new WeakSet();

    while (queue.length) {
        const current = queue.shift();
        const value = current?.value;
        const depth = Number(current?.depth ?? 0);

        if (
            !value ||
            typeof value !== 'object' ||
            depth > maxDepth ||
            visited.has(value)
        ) {
            continue;
        }

        visited.add(value);

        if (numericSenderId(value) === botSenderId) {
            return true;
        }

        appendChildren(queue, value, depth);
    }

    return false;
}
