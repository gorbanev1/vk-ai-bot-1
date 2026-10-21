/**
 * Единая привязка исходящих ответов к конкретному входящему сообщению в VK и Telegram.
 */

const vkReplyContextTargets = new WeakMap();
const INTERNAL_REPLY_FIELDS = Object.freeze([
    'replyToConversationMessageId',
    'replyToMessageId',
]);

function normalizeMessageId(value) {
    const number = Number(value);

    return Number.isSafeInteger(number) && number > 0
        ? number
        : null;
}

function getExplicitReplyMessageId(payload, params) {
    for (const source of [payload, params]) {
        if (!source || typeof source !== 'object') {
            continue;
        }

        for (const field of INTERNAL_REPLY_FIELDS) {
            const normalized = normalizeMessageId(source[field]);

            if (normalized) {
                return normalized;
            }
        }
    }

    return null;
}

function removeInternalReplyFields(value) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        return value;
    }

    const copy = { ...value };

    for (const field of INTERNAL_REPLY_FIELDS) {
        delete copy[field];
    }

    return copy;
}

/**
 * Telegram Bot API принимает нативный reply через reply_parameters.
 */
function buildTelegramReplyParameters(messageId) {
    const normalized = normalizeMessageId(messageId);

    return normalized
        ? { message_id: normalized }
        : null;
}

/**
 * По умолчанию VK-ответ привязывается к текущему входящему сообщению через
 * MessageContext.reply(). Если обработчик явно передал индекс старого
 * сообщения из базы, вызываем исходный send() с reply_to этого cmid.
 */
function createVkIncomingReplyContext(context) {
    if (
        !context ||
        typeof context !== 'object' ||
        vkReplyContextTargets.has(context) ||
        typeof context.reply !== 'function'
    ) {
        return context;
    }

    const reply = context.reply.bind(context);
    const send = typeof context.send === 'function'
        ? context.send.bind(context)
        : null;
    const proxy = new Proxy(context, {
        get(target, property) {
            if (property === 'send') {
                return (payload, params) => {
                    const explicitReplyId = getExplicitReplyMessageId(
                        payload,
                        params,
                    );

                    if (explicitReplyId && send) {
                        return send(
                            removeInternalReplyFields(payload),
                            {
                                ...removeInternalReplyFields(params),
                                reply_to: explicitReplyId,
                            },
                        );
                    }

                    return reply(
                        removeInternalReplyFields(payload),
                        removeInternalReplyFields(params),
                    );
                };
            }

            const value = Reflect.get(target, property, target);

            return typeof value === 'function'
                ? value.bind(target)
                : value;
        },
        set(target, property, value) {
            return Reflect.set(target, property, value, target);
        },
    });

    vkReplyContextTargets.set(proxy, context);

    return proxy;
}

function getVkIncomingReplyTarget(context) {
    return vkReplyContextTargets.get(context) ?? context;
}

export {
    buildTelegramReplyParameters,
    createVkIncomingReplyContext,
    getExplicitReplyMessageId,
    getVkIncomingReplyTarget,
    normalizeMessageId,
    removeInternalReplyFields,
};
