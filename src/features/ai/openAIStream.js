/**
 * Парсер SSE-потока OpenAI-compatible API. Собирает текст, usage и корректно замечает ошибку внутри уже начавшегося stream.
 */
function parseEventPayload(eventBlock, label) {
    const lines = String(eventBlock).split(/\r?\n/u);
    const dataLines = lines
        .filter((line) => line.startsWith('data:'))
        .map((line) => line.slice(5).trimStart());

    const raw = (dataLines.length ? dataLines.join('\n') : lines.join('\n')).trim();

    if (!raw || raw === '[DONE]' || raw.startsWith(':')) {
        return null;
    }

    try {
        return JSON.parse(raw);
    } catch {
        console.warn(`[${label} STREAM PARSE WARNING]`, raw.slice(0, 300));
        return null;
    }
}

/**
 * Reads an OpenAI-compatible SSE/NDJSON response and invokes onPayload for
 * every decoded JSON event. It deliberately does not accumulate the full raw
 * stream, so large image/base64 responses do not get duplicated in memory.
 */
export async function consumeOpenAIStream(response, {
    onPayload,
    onActivity,
    onChunk,
    onDone,
    onComment,
    label = 'GPT',
} = {}) {
    if (!response?.body) {
        throw new Error(`${label} API открыл поток без тела ответа.`);
    }

    const contentType = String(
        response.headers?.get?.('content-type') ?? '',
    ).toLowerCase();
    const eventStream = contentType.includes('text/event-stream');
    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    let eventCount = 0;

    const consume = async (block) => {
        if (/^\s*(?:data:\s*)?\[DONE\]\s*$/mu.test(block)) {
            await onDone?.();
            return;
        }
        // SSE comments are real inbound server events, not model text. Raw
        // bytes are already counted by onActivity; avoid double counting.
        if (eventStream && block.split(/\r?\n/u).every(line => !line.trim() || /^\s*:/u.test(line))) {
            if (block.includes(':')) await onComment?.({ bytes: Buffer.byteLength(block, 'utf8') });
            return;
        }
        const payload = parseEventPayload(block, label);

        if (!payload) {
            return;
        }

        eventCount += 1;
        await onPayload?.(payload);
    };

    while (true) {
        const { value, done } = await reader.read();
        if (value?.byteLength) {
            onActivity?.({ bytes: value.byteLength, eventCount });
            await onChunk?.(value);
        }
        buffer += decoder.decode(value ?? new Uint8Array(), {
            stream: !done,
        });

        if (eventStream) {
            let match;

            while ((match = /\r?\n\r?\n/u.exec(buffer))) {
                const block = buffer.slice(0, match.index);
                buffer = buffer.slice(match.index + match[0].length);
                await consume(block);
            }
        } else {
            let newlineIndex;

            while ((newlineIndex = buffer.indexOf('\n')) >= 0) {
                const line = buffer.slice(0, newlineIndex);
                buffer = buffer.slice(newlineIndex + 1);
                await consume(line);
            }
        }

        if (done) {
            break;
        }
    }

    if (buffer.trim()) {
        await consume(buffer);
    }

    return eventCount;
}


function stringifyTextContent(value) {
    if (typeof value === 'string') {
        return value;
    }

    if (!Array.isArray(value)) {
        if (value && typeof value === 'object') {
            return stringifyTextContent(
                value.text ?? value.content ?? value.delta ?? '',
            );
        }

        return '';
    }

    return value
        .map((part) => stringifyTextContent(part))
        .join('');
}

export function extractOpenAIIncrementalText(payload) {
    const choice = payload?.choices?.[0];
    const type = String(payload?.type ?? '').toLowerCase();

    if (choice?.delta?.content != null) {
        return stringifyTextContent(choice.delta.content);
    }

    if (type.endsWith('.delta') && payload?.delta != null) {
        return stringifyTextContent(payload.delta);
    }

    if (
        type.includes('output_text') &&
        payload?.text != null
    ) {
        return stringifyTextContent(payload.text);
    }

    return '';
}

export function extractOpenAIFinalText(payload) {
    const choice = payload?.choices?.[0];

    if (choice?.message?.content != null) {
        return choice.message.content;
    }

    if (choice?.text != null) {
        return choice.text;
    }

    if (payload?.output_text != null) {
        return payload.output_text;
    }

    const response = payload?.response;

    if (!response || !Array.isArray(response.output)) {
        return '';
    }

    const parts = [];

    for (const item of response.output) {
        if (!Array.isArray(item?.content)) {
            continue;
        }

        for (const content of item.content) {
            if (
                content?.text != null &&
                String(content?.type ?? '').toLowerCase().includes('text')
            ) {
                parts.push(content.text);
            }
        }
    }

    return parts;
}

export function extractOpenAIStreamUsage(payload) {
    return payload?.usage ?? payload?.response?.usage ?? null;
}
