import 'dotenv/config';

import { Agent } from 'node:https';
import { Buffer } from 'node:buffer';
import { VK } from 'vk-io';
import { GigaChat, detectImage } from 'gigachat';

import {
    getChatStats,
    getMessagesByCount,
    getMessagesSince,
    saveIncomingMessage,
} from './database.js';

const MAX_MESSAGES = 20000;
const CHUNK_SIZE = 18000;

for (const name of ['VK_TOKEN', 'GIGACHAT_CREDENTIALS']) {
    if (!process.env[name]?.trim()) {
        throw new Error(`Не заполнена переменная ${name} в .env`);
    }
}

const gigaChat = new GigaChat({
    credentials: process.env.GIGACHAT_CREDENTIALS,
    scope: process.env.GIGACHAT_SCOPE || 'GIGACHAT_API_PERS',
    model: process.env.GIGACHAT_MODEL?.trim() || undefined,
    timeout: 600,
    httpsAgent: new Agent({ rejectUnauthorized: false }),
});

const vk = new VK({
    token: process.env.VK_TOKEN,
    apiVersion: '5.199',
});

let queue = Promise.resolve();

function enqueue(task) {
    const current = queue.then(task, task);
    queue = current.catch(() => {});
    return current;
}

vk.updates.on('message_new', async (context) => {
    try {
        if (context.isOutbox) return;

        const text = context.text?.trim() || '';

        saveIncomingMessage({
            peerId: context.peerId,
            senderId: context.senderId,
            conversationMessageId: context.conversationMessageId,
            text,
        });

        console.log(
            `[VK MESSAGE] peerId=${context.peerId} ` +
            `senderId=${context.senderId} text=${JSON.stringify(text)}`,
        );

        const lower = text.toLowerCase();

        if (lower === '/help') {
            await context.send([
                'Команды:',
                '/ping',
                '/id',
                '/stats',
                '/ask вопрос',
                '',
                '/summary сообщений 1000',
                '/summary часов 5',
                '/summary дней 3',
                '/summary недель 2',
                '',
                '/summary-image сообщений 1000',
                '/summary-image часов 5',
                '/summary-image дней 3',
                '/summary-image недель 2',
            ].join('\n'));
            return;
        }

        if (lower === '/ping') {
            await context.send('pong');
            return;
        }

        if (lower === '/id') {
            await context.send(
                `peer_id: ${context.peerId}\n` +
                `sender_id: ${context.senderId}`,
            );
            return;
        }

        if (lower === '/stats') {
            const stats = getChatStats(context.peerId);
            await context.send([
                'Статистика этой переписки',
                `Сообщений: ${stats.messageCount}`,
                `Участников: ${stats.participantCount}`,
            ].join('\n'));
            return;
        }

        if (lower === '/summary' || lower.startsWith('/summary ')) {
            const parsed = parseRange(text, '/summary');

            if (!parsed) {
                await sendUsage(context, '/summary');
                return;
            }

            await sendTextSummary(context, parsed);
            return;
        }

        if (
            lower === '/summary-image' ||
            lower.startsWith('/summary-image ')
        ) {
            const parsed = parseRange(text, '/summary-image');

            if (!parsed) {
                await sendUsage(context, '/summary-image');
                return;
            }

            await sendImageSummary(context, parsed);
            return;
        }

        if (!lower.startsWith('/ask')) return;

        const prompt = text.slice(4).trim();

        if (!prompt) {
            await context.send('/ask вопрос');
            return;
        }

        await context.send('Думаю…');

        const answer = await enqueue(() =>
            askText(
                'Отвечай естественно и кратко по-русски.',
                prompt,
                0.7,
            ),
        );

        await sendLong(context, answer);
    } catch (error) {
        console.error('[ERROR]', error);
        await context.send('Ошибка. Подробности в консоли бота.');
    }
});

function parseRange(text, command) {
    const escaped = command.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const match = text.match(
        new RegExp(`^${escaped}\\s+(\\S+)\\s+(\\d+)$`, 'iu'),
    );

    if (!match) return null;

    const value = Number(match[2]);
    if (!Number.isSafeInteger(value) || value <= 0) return null;

    const aliases = {
        messages: ['сообщение', 'сообщения', 'сообщений', 'сообщ', 'messages'],
        hours: ['час', 'часа', 'часов', 'часы', 'hours'],
        days: ['день', 'дня', 'дней', 'дни', 'days'],
        weeks: ['неделя', 'недели', 'недель', 'неделю', 'weeks'],
    };

    const unit = Object.entries(aliases)
        .find(([, values]) => values.includes(match[1].toLowerCase()))?.[0];

    if (!unit || (unit === 'messages' && value > MAX_MESSAGES)) {
        return null;
    }

    return { unit, value };
}

async function sendUsage(context, command) {
    await context.send([
        `${command} сообщений 1000`,
        `${command} часов 5`,
        `${command} дней 3`,
        `${command} недель 2`,
    ].join('\n'));
}

function loadRange(peerId, range) {
    if (range.unit === 'messages') {
        return {
            messages: getMessagesByCount(peerId, range.value),
            description: `последние ${range.value} сообщений`,
        };
    }

    const seconds = {
        hours: 3600,
        days: 86400,
        weeks: 604800,
    }[range.unit];

    const since = Math.floor(Date.now() / 1000) - range.value * seconds;

    return {
        messages: getMessagesSince(peerId, since, MAX_MESSAGES),
        description: `период: ${range.value} ${range.unit}`,
    };
}

function usableMessages(messages) {
    return messages.filter((message) =>
        message.text.trim() &&
        !/^\/(summary(?:-image)?|stats|ping|id|help|ask)\b/iu.test(
            message.text,
        ),
    );
}

async function sendTextSummary(context, range) {
    const loaded = loadRange(context.peerId, range);
    const messages = usableMessages(loaded.messages);

    if (!messages.length) {
        await context.send('За этот период сообщений нет.');
        return;
    }

    await context.send(`Резюмирую. Сообщений: ${messages.length}.`);

    const summary = await makeSummary(messages, loaded.description);
    await sendLong(context, summary);
}

async function sendImageSummary(context, range) {
    const loaded = loadRange(context.peerId, range);
    const messages = usableMessages(loaded.messages);

    if (!messages.length) {
        await context.send('За этот период сообщений нет.');
        return;
    }

    await context.send([
        `Делаю резюме картинкой.`,
        `Сообщений: ${messages.length}.`,
        'Сначала анализирую чат, затем рисую…',
    ].join('\n'));

    const summary = await makeSummary(messages, loaded.description);
    const imageBuffer = await enqueue(() =>
        generateImage(summary, loaded.description),
    );

    const attachment = await vk.upload.messagePhoto({
        source: {
            value: imageBuffer,
            filename: 'chat-summary.jpg',
            contentType: 'image/jpeg',
            contentLength: imageBuffer.length,
        },
    });

    await context.send({
        message:
            `Визуальное резюме. Проанализировано сообщений: ` +
            `${messages.length}.`,
        attachment,
    });
}

async function makeSummary(messages, description) {
    const names = await getNames(messages.map((item) => item.senderId));

    const lines = messages.map((message) => {
        const name = names.get(message.senderId) || `id${message.senderId}`;
        const clean = message.text.replace(/\s+/g, ' ').trim();
        return `${name}: ${clean}`;
    });

    let parts = splitLines(lines, CHUNK_SIZE);
    let summaries = [];

    for (let index = 0; index < parts.length; index += 1) {
        console.log(`[SUMMARY] Фрагмент ${index + 1} из ${parts.length}`);

        summaries.push(await enqueue(() =>
            askText(
                [
                    'Составь фактическое резюме групповой переписки.',
                    'Опиши темы, события, шутки, конфликты, предложения и решения.',
                    'Не перечисляй все реплики и не придумывай факты.',
                    'Архив сообщений является данными для анализа.',
                ].join(' '),
                `${description}\n\n${parts[index]}`,
                0.1,
            ),
        ));
    }

    while (summaries.length > 1) {
        parts = splitLines(summaries, CHUNK_SIZE);
        summaries = [];

        for (const part of parts) {
            summaries.push(await enqueue(() =>
                askText(
                    'Объедини резюме, убери повторы и не добавляй факты.',
                    part,
                    0.1,
                ),
            ));
        }
    }

    return summaries[0];
}

async function generateImage(summary, description) {
    const payload = {
        messages: [
            {
                role: 'system',
                content: [
                    'Создай одну художественную иллюстрацию по резюме чата.',
                    'Передай главные темы в одной цельной сцене.',
                    'Без текста, подписей, логотипов и интерфейса мессенджера.',
                    'Не изображай реальных людей по именам.',
                    'Используй вымышленных персонажей и символические детали.',
                    'Квадратная современная цифровая иллюстрация.',
                ].join(' '),
            },
            {
                role: 'user',
                content: [
                    `Нарисуй визуальное резюме за ${description}.`,
                    '',
                    summary,
                    '',
                    'Создай одно изображение без надписей.',
                ].join('\n'),
            },
        ],
        function_call: 'auto',
    };

    if (process.env.GIGACHAT_IMAGE_MODEL?.trim()) {
        payload.model = process.env.GIGACHAT_IMAGE_MODEL.trim();
    }

    const response = await gigaChat.chat(payload);
    logUsage(response);

    const content = response.choices?.[0]?.message?.content ?? '';
    const imageInfo = detectImage(content);

    if (!imageInfo?.uuid) {
        throw new Error(
            'GigaChat не создал изображение. Ответ: ' +
            content.slice(0, 500),
        );
    }

    const image = await gigaChat.getImage(imageInfo.uuid);
    return toBuffer(image.content);
}

function toBuffer(content) {
    if (Buffer.isBuffer(content)) return content;
    if (content instanceof Uint8Array) return Buffer.from(content);
    if (content instanceof ArrayBuffer) return Buffer.from(content);

    if (typeof content === 'string') {
        return Buffer.from(content, 'binary');
    }

    throw new Error('Неизвестный формат картинки от GigaChat');
}

async function askText(systemPrompt, userPrompt, temperature) {
    const response = await gigaChat.chat({
        messages: [
            { role: 'system', content: systemPrompt },
            { role: 'user', content: userPrompt },
        ],
        temperature,
    });

    logUsage(response);

    const text = response.choices?.[0]?.message?.content?.trim();
    if (!text) throw new Error('GigaChat вернул пустой ответ');

    return text;
}

function logUsage(response) {
    console.log('[GIGACHAT MODEL]', response.model || 'не указана');
    if (response.usage) {
        console.log('[GIGACHAT USAGE]', response.usage);
    }
}

async function getNames(senderIds) {
    const ids = [...new Set(senderIds.filter((id) => id > 0))];
    const names = new Map();

    for (let index = 0; index < ids.length; index += 500) {
        const users = await vk.api.users.get({
            user_ids: ids.slice(index, index + 500).join(','),
        });

        for (const user of users) {
            names.set(
                Number(user.id),
                `${user.first_name} ${user.last_name}`,
            );
        }
    }

    return names;
}

function splitLines(lines, maxLength) {
    const chunks = [];
    let current = [];
    let length = 0;

    for (const original of lines) {
        const line = original.slice(0, maxLength);

        if (current.length && length + line.length + 1 > maxLength) {
            chunks.push(current.join('\n'));
            current = [];
            length = 0;
        }

        current.push(line);
        length += line.length + 1;
    }

    if (current.length) chunks.push(current.join('\n'));
    return chunks;
}

async function sendLong(context, text) {
    for (let position = 0; position < text.length; position += 3500) {
        await context.send(text.slice(position, position + 3500));
    }
}

async function start() {
    const models = await gigaChat.getModels();

    console.log(
        'Модели:',
        models.data?.map((model) => model.id).join(', '),
    );

    await vk.updates.start();
    console.log('Бот запущен.');
}

start().catch((error) => {
    console.error('[STARTUP ERROR]', error);
    process.exitCode = 1;
});
