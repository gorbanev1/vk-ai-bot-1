import {
    consumeOpenAIStream,
    extractOpenAIFinalText,
    extractOpenAIIncrementalText,
    extractOpenAIStreamUsage,
} from '../../src/features/ai/openAIStream.js';

function createResponse(chunks, contentType) {
    const encoder = new TextEncoder();
    let index = 0;

    return new Response(
        new ReadableStream({
            pull(controller) {
                if (index >= chunks.length) {
                    controller.close();
                    return;
                }

                controller.enqueue(encoder.encode(chunks[index]));
                index += 1;
            },
        }),
        {
            headers: {
                'content-type': contentType,
            },
        },
    );
}

async function testResponsesApiSse() {
    let streamedText = '';
    let finalText = '';
    let usage = null;
    const response = createResponse([
        'data: {"type":"response.output_text.delta","delta":"Привет, "}\n\n',
        'data: {"type":"response.output_text.delta","delta":"мир!"}\n\n',
        'data: {"type":"response.completed","response":{"output":[{"content":[{"type":"output_text","text":"Привет, мир!"}]}],"usage":{"total_tokens":5}}}\n\n',
        'data: [DONE]\n\n',
    ], 'text/event-stream; charset=utf-8');

    const eventCount = await consumeOpenAIStream(response, {
        onPayload(payload) {
            streamedText += extractOpenAIIncrementalText(payload);
            const completed = extractOpenAIFinalText(payload);

            if (Array.isArray(completed)) {
                finalText = completed.join('');
            } else if (completed) {
                finalText = completed;
            }

            usage = extractOpenAIStreamUsage(payload) || usage;
        },
    });

    if (
        streamedText !== 'Привет, мир!' ||
        finalText !== 'Привет, мир!' ||
        usage?.total_tokens !== 5 ||
        eventCount !== 3
    ) {
        throw new Error('Responses API SSE parsing failed.');
    }
}

async function testChatCompletionsNdjson() {
    let text = '';
    const response = createResponse([
        '{"choices":[{"delta":{"content":"A "}}]}\n',
        '{"choices":[{"delta":{"content":"B"}}]}\n',
    ], 'application/x-ndjson');

    await consumeOpenAIStream(response, {
        onPayload(payload) {
            text += extractOpenAIIncrementalText(payload);
        },
    });

    if (text !== 'A B') {
        throw new Error(`NDJSON parsing failed: ${JSON.stringify(text)}`);
    }
}

await testResponsesApiSse();
await testChatCompletionsNdjson();
console.log('openAIStream tests: OK');
