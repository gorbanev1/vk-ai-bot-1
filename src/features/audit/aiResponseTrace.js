// Per-AI-POST forensic trace for owner TXT. No prompts, Authorization or model text
// appear in metadata/events; response.raw.bin is intentionally sensitive.
import { createHash } from 'node:crypto';
import { appendFile, mkdir, open, writeFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';

const safe = (value) => String(value ?? '').replace(/[^a-zA-Z0-9_.-]/gu, '_').slice(0, 100);
const time = () => new Date().toISOString();
const MONO = () => process.hrtime.bigint();
const allowedHeaders = ['content-type', 'cf-ray', 'x-request-id', 'x-correlation-id', 'server', 'date', 'content-encoding'];

function errorInfo(error, depth = 0) {
    if (!error || depth > 3) return null;
    return {
        name: String(error.name || 'Error').slice(0, 100),
        code: String(error.code || '').slice(0, 120),
        message: String(error.message || error).slice(0, 1400),
        status: Number(error.status || error.statusCode || 0) || null,
        providerEventType: String(error.providerEventType || '').slice(0, 120),
        providerPayload: error.providerPayload || null,
        stack: String(error.stack || '').slice(0, 3000),
        cause: errorInfo(error.cause, depth + 1),
    };
}

export async function createAiResponseTrace({ jobId, stage, attempt = 1, logicalRequestId = '',
    model = '', api = '', host = '', inputBytes = 0, root = resolve(process.env.GIGORAVE_TEXT_DATA_DIR || 'data', 'astra-text-jobs') }) {
    if (!/^[a-f0-9-]{36}$/iu.test(String(jobId))) throw new Error('AI_TRACE_INVALID_JOB_ID');
    const directory = join(root, jobId, safe(stage), `attempt-${Number(attempt) || 1}`, 'http-trace');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const handle = await open(join(directory, 'response.raw.bin'), 'w', 0o600);
    const started = MONO();
    const digest = createHash('sha256');
    let lastChunkAt = started;
    let offset = 0;
    let chunks = 0;
    let rawClosed = false;
    let finished = false;
    let httpStatus = null;
    let contentType = '';
    const eventsPath = join(directory, 'events.jsonl');
    let eventWrites = Promise.resolve();
    async function record(event, details = {}) {
        const entry = { at: time(), elapsedMs: Number(MONO() - started) / 1e6, event, ...details };
        // Serialize log writes even when an SSE handler and HTTP reader are active.
        eventWrites = eventWrites.then(() => appendFile(eventsPath, `${JSON.stringify(entry)}\n`, { mode: 0o600 }));
        await eventWrites;
    }
    await writeFile(join(directory, 'request-meta.json'), `${JSON.stringify({
        jobId, stage, attempt, logicalRequestId, model, api, host,
        inputBytes, createdAt: time(), responseRawIsSensitive: true,
        localRequestTimeout: 'none for owner TXT',
    }, null, 2)}\n`, { mode: 0o600 });
    await record('request-start');
    async function closeRaw() {
        if (rawClosed) return;
        rawClosed = true;
        await handle.close();
    }
    async function rawChunk(value) {
        const chunk = Buffer.from(value);
        if (!chunk.length) return;
        if (rawClosed) throw new Error('AI_TRACE_RAW_ALREADY_CLOSED');
        const start = offset;
        try {
            let written = 0;
            while (written < chunk.length) {
                const result = await handle.write(chunk, written, chunk.length - written, null);
                if (result.bytesWritten <= 0) throw new Error('AI_TRACE_SHORT_WRITE');
                written += result.bytesWritten;
            }
            offset += chunk.length;
            digest.update(chunk);
            chunks++;
            const now = MONO();
            await record('body-chunk', {
                chunkIndex: chunks, bytes: chunk.length, offsetStart: start, offsetEnd: offset,
                gapMs: Number(now - lastChunkAt) / 1e6, receivedBytes: offset,
            });
            lastChunkAt = now;
        } catch (error) {
            await record('raw-write-failure', { offsetStart: start, expectedBytes: chunk.length, cause: errorInfo(error) })
                .catch(() => {});
            throw error;
        }
    }
    async function receivedHeaders(response) {
        httpStatus = response.status;
        contentType = String(response.headers.get('content-type') || '').slice(0, 160);
        const headers = Object.fromEntries(allowedHeaders.filter(name => response.headers.has(name))
            .map(name => [name, String(response.headers.get(name) || '').slice(0, 260)]));
        await record('http-headers', { status: response.status, headers });
    }
    function wrap(response) {
        if (!response.body) return response;
        const reader = response.body.getReader();
        let bodyEnded = false;
        const body = new ReadableStream({
            async pull(controller) {
                try {
                    const { done, value } = await reader.read();
                    if (done) {
                        bodyEnded = true;
                        await record('body-eof', { bytes: offset, chunks });
                        await closeRaw();
                        controller.close();
                        return;
                    }
                    // Persist bytes BEFORE giving them to the SSE/JSON parser.
                    await rawChunk(value);
                    controller.enqueue(value);
                } catch (error) {
                    await record('body-read-error', { bytes: offset, chunks, cause: errorInfo(error) }).catch(() => {});
                    await closeRaw().catch(() => {});
                    controller.error(error);
                }
            },
            async cancel(reason) {
                await record('body-cancel', { bytes: offset, bodyEnded, reason: String(reason?.code || reason?.name || 'cancel').slice(0, 100) }).catch(() => {});
                await reader.cancel(reason).catch(() => {});
                await closeRaw().catch(() => {});
            },
        }, { highWaterMark: 0 });
        return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
    }
    async function finish(outcome, { error = null, responseId = '', completion = false } = {}) {
        if (finished) return;
        finished = true;
        await record('request-finished', { outcome, httpStatus, bytes: offset, chunks, responseId, completion, error: errorInfo(error) });
        await closeRaw();
        const summary = { jobId, stage, attempt, outcome, completed: completion,
            httpStatus, contentType, receivedBytes: offset, chunks, responseId,
            rawSha256: digest.digest('hex'), error: errorInfo(error),
            finishedAt: time(), elapsedMs: Number(MONO() - started) / 1e6,
            rawResponsePath: join(directory, 'response.raw.bin'),
            note: 'Bytes are HTTP response body actually read by this client; not upstream router/provider logs.',
        };
        await writeFile(join(directory, 'diagnosis.json'), `${JSON.stringify(summary, null, 2)}\n`, { mode: 0o600 });
        return summary;
    }
    return { directory, record, receivedHeaders, wrap, finish };
}
