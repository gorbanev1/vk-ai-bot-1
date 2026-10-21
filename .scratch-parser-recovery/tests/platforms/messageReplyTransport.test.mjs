import assert from 'node:assert/strict';
import {
    buildTelegramReplyParameters,
    createVkIncomingReplyContext,
    getVkIncomingReplyTarget,
} from '../../src/shared/incomingReplyTransport.js';
import {
    TelegramBotApi,
    createTelegramContext,
    createTelegramPhotoAttachment,
} from '../../src/platforms/telegram/telegramBot.js';

assert.deepEqual(buildTelegramReplyParameters(42), { message_id: 42 });
assert.equal(buildTelegramReplyParameters(0), null);
assert.equal(buildTelegramReplyParameters('not-a-number'), null);

const vkCalls = [];
const vkContext = {
    peerId: 2_000_000_001,
    conversationMessageId: 777,
    async send(payload, params) {
        vkCalls.push({ method: 'send', payload, params });
        return { conversationMessageId: 900 };
    },
    async reply(payload, params) {
        vkCalls.push({ method: 'reply', payload, params, thisValue: this });
        return { conversationMessageId: 901 };
    },
};
const replyingVkContext = createVkIncomingReplyContext(vkContext);
const vkSent = await replyingVkContext.send({ message: 'ответ' });

assert.equal(replyingVkContext.peerId, vkContext.peerId);
assert.equal(vkCalls.length, 1);
assert.equal(vkCalls[0].method, 'reply');
assert.equal(vkCalls[0].thisValue, vkContext);
assert.deepEqual(vkCalls[0].payload, { message: 'ответ' });
assert.equal(vkSent.conversationMessageId, 901);
assert.equal(getVkIncomingReplyTarget(replyingVkContext), vkContext);
assert.equal(
    createVkIncomingReplyContext(replyingVkContext),
    replyingVkContext,
);

vkCalls.length = 0;
await replyingVkContext.send({
    message: 'ответ на старое сообщение',
    replyToConversationMessageId: 444,
});
assert.equal(vkCalls.length, 1);
assert.equal(vkCalls[0].method, 'send');
assert.deepEqual(vkCalls[0].payload, {
    message: 'ответ на старое сообщение',
});
assert.equal(vkCalls[0].params.reply_to, 444);
assert.equal('replyToConversationMessageId' in vkCalls[0].payload, false);

const telegramCalls = [];
const telegramApi = {
    async sendChatAction(payload) {
        telegramCalls.push({ method: 'sendChatAction', payload });
        return true;
    },
    async sendMessage(payload) {
        telegramCalls.push({ method: 'sendMessage', payload });
        return { message_id: 801 };
    },
    async sendPhoto(payload) {
        telegramCalls.push({ method: 'sendPhoto', payload });
        return { message_id: 802 };
    },
    async sendDocument(payload) {
        telegramCalls.push({ method: 'sendDocument', payload });
        return { message_id: 803 };
    },
};
const telegramMessage = {
    message_id: 123,
    date: 1_700_000_000,
    text: 'Гигорейв привет',
    chat: {
        id: -100500,
        type: 'supergroup',
    },
    from: {
        id: 555,
        is_bot: false,
        first_name: 'Иван',
    },
};
const telegramContext = createTelegramContext({
    api: telegramApi,
    message: telegramMessage,
    botUser: { id: 999, username: 'GigoraveBot' },
    resolvePeerId: () => -3_000_000_001,
    resolveUserId: () => 3_000_000_001,
});

await telegramContext.send('текстовый ответ');
const textSend = telegramCalls.find((call) => call.method === 'sendMessage');
assert.equal(textSend.payload.replyToMessageId, 123);

telegramCalls.length = 0;
await telegramContext.send({
    message: 'ответ с картинкой',
    attachment: createTelegramPhotoAttachment({
        buffer: Buffer.from([1, 2, 3]),
        filename: 'reply.png',
        mimeType: 'image/png',
    }),
});
const photoSend = telegramCalls.find((call) => call.method === 'sendPhoto');
assert.equal(photoSend.payload.replyToMessageId, 123);

telegramCalls.length = 0;
await telegramContext.send({
    message: 'ответ на сохранённое сообщение',
    replyToConversationMessageId: 456,
});
const explicitTextSend = telegramCalls.find(
    (call) => call.method === 'sendMessage',
);
assert.equal(explicitTextSend.payload.replyToMessageId, 456);


const originalFetch = globalThis.fetch;
const telegramWireCalls = [];

globalThis.fetch = async (url, options) => {
    telegramWireCalls.push({ url, options });

    return {
        ok: true,
        status: 200,
        async text() {
            return JSON.stringify({
                ok: true,
                result: { message_id: 999 },
            });
        },
    };
};

try {
    const wireApi = new TelegramBotApi('test-token');

    await wireApi.sendMessage({
        chatId: -100500,
        text: 'проверка',
        replyToMessageId: 321,
    });
    const jsonPayload = JSON.parse(telegramWireCalls[0].options.body);
    assert.deepEqual(jsonPayload.reply_parameters, { message_id: 321 });

    await wireApi.sendPhoto({
        chatId: -100500,
        photo: {
            buffer: Buffer.from([1, 2, 3]),
            filename: 'wire.png',
            mimeType: 'image/png',
        },
        replyToMessageId: 654,
    });
    assert.equal(
        telegramWireCalls[1].options.body.get('reply_parameters'),
        JSON.stringify({ message_id: 654 }),
    );
} finally {
    globalThis.fetch = originalFetch;
}

console.log('message reply transport tests: OK');
