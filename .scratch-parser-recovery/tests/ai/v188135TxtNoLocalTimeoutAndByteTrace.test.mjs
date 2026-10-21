import test from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { beginTelegramTextJob, observeTelegramTextJob, finishTelegramTextJob,
    telegramTextJobStatus } from '../../src/features/audit/telegramTextJobControl.js';
import { consumeOpenAIStream } from '../../src/features/ai/openAIStream.js';

test('TXT remains running after many hours of silence; explicit /txt_stop still aborts', async () => {
    const job = beginTelegramTextJob({ jobId: randomUUID() });
    try {
        const now = Date.now();
        await observeTelegramTextJob(job, { stage: 'retry-attempt-start' }, now);
        await observeTelegramTextJob(job, { stage: 'request-waiting', elapsedSec: 24 * 3600,
            secondsSinceNetworkByte: 24 * 3600, streamBytesReceived: 0 }, now + 24 * 3600_000);
        assert.equal(job.controller.signal.aborted, false);
        await observeTelegramTextJob(job, { stage: 'http-response-headers', httpStatus: 200 });
        await observeTelegramTextJob(job, { stage: 'sse-comment-received', sseComments: 1 });
        await observeTelegramTextJob(job, { stage: 'network-bytes-received', streamBytesReceived: 42 });
        const status = await telegramTextJobStatus(job.jobId);
        assert.equal(status.running, true);
        assert.equal(status.bytes, 42);
        assert.equal(status.headersReceived, true);
        assert.equal(status.httpStatus, 200);
        assert.equal(status.sseComments, 1);
        job.controller.abort(new Error('TEXT_JOB_STOPPED_BY_OWNER'));
        assert.equal(job.controller.signal.aborted, true);
    } finally { await finishTelegramTextJob(job); }
});

test('SSE comment counted as real response body bytes without becoming model text', async () => {
    const encoder = new TextEncoder();
    const chunks = [': heartbeat\n\n',
        'data: {"type":"response.output_text.delta","delta":"Готово"}\n\n',
        'data: [DONE]\n\n'];
    const response = new Response(new ReadableStream({
        start(controller) { for (const chunk of chunks) controller.enqueue(encoder.encode(chunk)); controller.close(); },
    }), { headers: { 'content-type': 'text/event-stream' } });
    let bytes = 0, comments = 0, done = 0;
    const output = [];
    await consumeOpenAIStream(response, {
        onActivity: ({ bytes: received }) => { bytes += received; },
        onComment: () => { comments++; },
        onDone: () => { done++; },
        onPayload: payload => output.push(payload.delta),
    });
    assert.equal(bytes, chunks.reduce((sum, chunk) => sum + encoder.encode(chunk).length, 0));
    assert.equal(comments, 1);
    assert.equal(done, 1);
    assert.deepEqual(output, ['Готово']);
});