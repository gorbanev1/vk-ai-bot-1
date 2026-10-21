import assert from 'node:assert/strict';

import { consumeOpenAIStream } from '../../src/features/ai/openAIStream.js';
import { OpenAIImageStreamCollector } from '../../src/features/ai/openAIImageStream.js';

// 1x1 PNG. The Markdown data URL is deliberately split across SSE events.
const pngBase64 =
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=';
const fragments = [
    '![Image](data:image/png;base64,',
    pngBase64.slice(0, 25),
    pngBase64.slice(25, 67),
    pngBase64.slice(67),
    ')',
];

const sseBlocks = [
    ':PING\n\n',
    'data: {"choices":[{"delta":{"role":"assistant"},"finish_reason":null,"index":0}]}\n\n',
    ...fragments.map((fragment) =>
        `data: ${JSON.stringify({
            choices: [{
                delta: { content: fragment },
                finish_reason: null,
                index: 0,
            }],
        })}\n\n`,
    ),
    'data: {"choices":[{"delta":{},"finish_reason":"stop","index":0}]}\n\n',
    'data: [DONE]\n\n',
];

const encoder = new TextEncoder();
const response = new Response(new ReadableStream({
    start(controller) {
        for (const block of sseBlocks) {
            controller.enqueue(encoder.encode(block));
        }
        controller.close();
    },
}), {
    headers: {
        'content-type': 'text/event-stream',
    },
});

const collector = new OpenAIImageStreamCollector({
    maxImageBytes: 1024 * 1024,
});

await consumeOpenAIStream(response, {
    label: 'GPT IMAGE TEST',
    onPayload(payload) {
        collector.push(payload);
    },
});

const result = collector.finish();
assert.equal(result.payloadCount, 7);
assert.equal(result.candidates.length, 1);
assert.equal(result.candidates[0].type, 'buffer');
assert.equal(result.candidates[0].mimeType, 'image/png');
assert.equal(result.candidates[0].value, pngBase64);

const decoded = Buffer.from(result.candidates[0].value, 'base64');
assert.equal(decoded.subarray(1, 4).toString('ascii'), 'PNG');

console.log('openAIImageStream tests: OK');
