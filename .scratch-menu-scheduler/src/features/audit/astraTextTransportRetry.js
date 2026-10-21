import { appendTelegramTextTransferLog } from './telegramTextTransferLog.js';
import { createHash, randomUUID } from 'node:crypto';
import { appendFile, mkdir, readFile, writeFile, rename } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

const hash = (value) => createHash('sha256').update(String(value), 'utf8').digest('hex');
const safeName = (value) => String(value).replace(/[^a-z0-9._-]/giu, '_').slice(0, 100);

export function isRetryableAstraTextTransportError(error) {
    const status = Number(error?.status ?? error?.statusCode ?? 0);
    if ([400, 401, 403, 404, 413, 415, 422].includes(status)) return false;
    if (status && ![408, 409, 429, 500, 502, 503, 504, 524].includes(status)) return false;
    if (error?.name === 'AbortError' || error?.code === 'OPERATION_ABORTED') return false;
    if (status) return true;
    const message = `${String(error?.code || '')} ${String(error?.message || '')}`;
    return /stream_read_error|STREAM_INCOMPLETE|ECONNRESET|ETIMEDOUT|fetch failed|socket hang up|connection (?:closed|reset)|premature|terminated|HTTP\s*(?:408|409|429|500|502|503|504|524)|GPT API (?:408|409|429|500|502|503|504|524)/iu.test(message);
}

// One owner for retry; the inner credential/key/transport failovers MUST be disabled.
// The same Idempotency-Key is passed on each POST, but third-party router deduplication
// is UNVERIFIED. An ambiguous repost without responseId MAY produce another paid inference.
export async function runAstraTextStageWithRetry({
    stage, jobId = randomUUID(), prompt, systemPrompt, maxTokens,
    requestModel, onProgress = () => {}, journalRoot = resolve(process.env.GIGORAVE_TEXT_DATA_DIR || 'data', 'astra-text-jobs'),
    maxAttempts = 3, wait = sleep, allowAmbiguousRepost = false, recoverResponse = null, jobSignal = null,
    model = 'gpt-5.4-mini', reasoningEffort = 'medium',
}) {
    if (typeof requestModel !== 'function') throw new TypeError('requestModel is required');
    const stageName = safeName(stage);
    const logicalRequestId = `astra-text:${safeName(jobId)}:${stageName}`;
    const idempotencyKey = logicalRequestId;
    const directory = join(journalRoot, safeName(jobId), stageName);
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const statePath = join(directory, 'state.json');
    const answerPath = join(directory, 'answer.txt');
    const inputSha256 = hash(`${model}\n${reasoningEffort}\n${systemPrompt}\n${prompt}`);
    const attempts = Math.min(3, Math.max(1, Number(maxAttempts) || 1));
    let state;
    try { state = JSON.parse(await readFile(statePath, 'utf8')); } catch { state = null; }
    if (state?.status === 'completed' && state?.inputSha256 === inputSha256) {
        const answer = await readFile(answerPath, 'utf8');
        if (hash(answer) === state.outputSha256) return answer;
        throw new Error('ASTRA_TEXT_COMPLETED_STAGE_HASH_MISMATCH');
    }
    // Model fully returned and the answer was atomically saved, but a process
    // may have died before the final completed-state checkpoint.
    if (['model-returned', 'unknown'].includes(state?.status) && state?.inputSha256 === inputSha256 && state.outputSha256) {
        try {
            const saved = await readFile(answerPath, 'utf8');
            if (saved.trim() && hash(saved) === state.outputSha256) {
                const completed = { ...state, status: 'completed', completedAt: new Date().toISOString(),
                    recoveryMethod: 'local-answer-sha256' };
                const temp = `${statePath}.${process.pid}.local-recovered.tmp`;
                await writeFile(temp, `${JSON.stringify(completed, null, 2)}\n`, { mode: 0o600 });
                await rename(temp, statePath);
                await appendTelegramTextTransferLog({ jobId, event: { stage: 'stage-recovered-local', chars: saved.length } }).catch(() => {});
                return saved;
            }
        } catch { /* A missing/truncated answer is ambiguous, never a reason to POST. */ }
    }
    // An incomplete stage from another process/restart is ambiguous: do not
    // silently create a new paid POST as though the first one never happened.
    if (state && state.inputSha256 === inputSha256 &&
        ['request-started', 'stream-running', 'model-returned', 'unknown', 'retry-scheduled'].includes(state.status)) {
        // GET by the exact old Responses ID only. Chat Completions streams
        // generally have no retrievable ID, and a partial stream is NOT an answer.
        if (state.responseId && typeof recoverResponse === 'function' && !jobSignal?.aborted) {
            try {
                const recovered = await recoverResponse({ jobId, stage: stageName, responseId: state.responseId, state, jobSignal });
                if (typeof recovered === 'string' && recovered.trim()) {
                    const answer = recovered.trim();
                    await writeFile(answerPath, answer, { mode: 0o600 });
                    const checkpoint = { ...state, status: 'completed', outputSha256: hash(answer),
                        outputChars: answer.length, recoveredAt: new Date().toISOString() };
                    const temp = `${statePath}.${process.pid}.recovered.tmp`;
                    await writeFile(temp, `${JSON.stringify(checkpoint, null, 2)}\n`, { mode: 0o600 });
                    await rename(temp, statePath);
                    await appendTelegramTextTransferLog({ jobId, event: { stage: 'stage-recovered-by-get',
                        responseId: state.responseId, chars: answer.length } }).catch(() => {});
                    try { await onProgress({ stage: 'stage-recovered-by-get', responseId: state.responseId,
                        chars: answer.length }); } catch {}
                    return answer;
                }
            } catch (recoveryError) {
                await appendTelegramTextTransferLog({ jobId, event: { stage: 'stage-get-unavailable',
                    code: recoveryError?.code || recoveryError?.name || 'unknown', responseId: state.responseId } }).catch(() => {});
            }
        }
        const error = new Error('ASTRA_TEXT_PREVIOUS_ATTEMPT_UNKNOWN: inspect stage journal before a new paid request.');
        error.responseId = state.responseId || '';
        error.inferenceMayHaveStarted = true;
        throw error;
    }
    if (state && state.inputSha256 !== inputSha256) {
        throw new Error('ASTRA_TEXT_STAGE_INPUT_CHANGED: cannot reuse stage identifier for different input.');
    }
    const notify = async (event) => {
        try { await appendTelegramTextTransferLog({ jobId, event }); }
        catch { /* Logging never cancels an already-paid inference. */ }
        try { await onProgress(event); } catch { /* diagnostic only */ }
    };
    const persist = async (patch) => {
        state = { ...(state || {}), logicalRequestId, idempotencyKey, inputSha256,
            stage: stageName, ...(patch || {}), updatedAt: new Date().toISOString() };
        const temporary = `${statePath}.${process.pid}.tmp`;
        await writeFile(temporary, `${JSON.stringify(state, null, 2)}\n`, { mode: 0o600 });
        await rename(temporary, statePath);
    };
    for (let attempt = 1; attempt <= attempts; attempt++) {
        const partialPath = join(directory, `attempt-${attempt}.partial.txt`);
        let partialChars = 0;
        let firstChunkAt = '';
        let responseId = '';
        // Batch SSE deltas to avoid thousands of tiny appendFile operations on
        // Windows. A pending fragment is flushed periodically and always before
        // a successful checkpoint or an error is handled. A write failure is
        // captured immediately so it cannot become an unhandled rejection while
        // the provider is still streaming.
        let writes = Promise.resolve();
        let pendingText = '';
        let writeFailure = null;
        const flushPartial = () => {
            if (!pendingText) return;
            // SSE can split UTF-16 surrogate pairs between callbacks. Never
            // encode the high surrogate alone at a filesystem flush boundary.
            let chunk = pendingText;
            pendingText = '';
            if (/[\uD800-\uDBFF]$/u.test(chunk)) {
                pendingText = chunk.slice(-1);
                chunk = chunk.slice(0, -1);
            }
            if (!chunk) return;
            writes = writes.then(async () => {
                if (writeFailure) return;
                try { await appendFile(partialPath, chunk, { mode: 0o600 }); }
                catch (error) { writeFailure = error; }
            });
        };
        const flushTimer = setInterval(flushPartial, 2_000);
        flushTimer.unref?.();
        const attemptStartedMs = Date.now();
        let lastTextDeltaMs = 0;
        let lastNetworkByteMs = 0;
        let streamBytesReceived = 0;
        let lastLoggedByteMs = 0;
        let headersReceivedAtMs = 0;
        let httpStatus = 0;
        let contentType = '';
        let sseComments = 0;
        // Local diagnostic only; this is NOT proof that the remote model is alive.
        const heartbeat = setInterval(() => {
            void notify({ stage: 'request-waiting', logicalRequestId, attempt, model,
                elapsedSec: Math.round((Date.now() - attemptStartedMs) / 1000),
                firstTextReceived: Boolean(firstChunkAt),
                secondsSinceText: lastTextDeltaMs ? Math.round((Date.now() - lastTextDeltaMs) / 1000) : null,
                responseId, streamBytesReceived, headersReceived: Boolean(headersReceivedAtMs),
                httpStatus, contentType, sseComments,
                secondsSinceNetworkByte: lastNetworkByteMs
                    ? Math.round((Date.now() - lastNetworkByteMs) / 1000) : null });
        }, 30_000);
        heartbeat.unref?.();
        if (jobSignal?.aborted) {
            clearInterval(flushTimer);
            clearInterval(heartbeat);
            throw jobSignal.reason || new Error('TEXT_JOB_STOPPED');
        }
        await persist({ status: 'request-started', attempt, maxAttempts: attempts,
            partialChars: 0, partialOutput: false, responseId: '', startedAt: new Date().toISOString() });
        await notify({ stage: 'retry-attempt-start', logicalRequestId, attempt, maxAttempts: attempts });
        try {
            const answer = String(await requestModel({
                systemPrompt, userPrompt: prompt, inputFiles: [], streamOverride: true,
                textJobAbortSignal: jobSignal,
                tokenUsageMetadata: { jobId, stage: stageName, attempt, logicalRequestId },
                disableTransportFallback: true, backgroundResponse: false,
                skipIncomingMessageContext: true, disableProviderRetry: true,
                reasoningEffort, verbosity: 'high', maxTokens,
                inferenceIdempotencyKey: idempotencyKey,
                onBackgroundResponseCreated: async (metadata) => {
                    responseId = String(metadata?.responseId || '').trim();
                    if (responseId) await persist({ status: 'stream-running', attempt, responseId,
                        credentialName: String(metadata?.credentialName || ''),
                        requestBaseUrl: String(metadata?.requestBaseUrl || ''), model,
                        firstResponseEventAt: new Date().toISOString() });
                },
                onTextDelta: (delta, metadata) => {
                    if (metadata?.transportEvent === 'trace-ready') {
                        void notify({ stage: 'request-trace-ready', logicalRequestId,
                            attempt, traceDirectory: metadata.traceDirectory });
                        return;
                    }
                    if (metadata?.transportEvent === 'http-headers') {
                        headersReceivedAtMs = Date.now();
                        httpStatus = Number(metadata.httpStatus) || 0;
                        contentType = String(metadata.contentType || '').slice(0, 70);
                        void notify({ stage: 'http-response-headers', logicalRequestId, attempt,
                            httpStatus, contentType,
                            elapsedSec: Math.round((headersReceivedAtMs - attemptStartedMs) / 1000),
                            streamBytesReceived });
                        return;
                    }
                    if (metadata?.transportEvent === 'sse-comment') {
                        sseComments++;
                        // SSE comment is a router response event, not visible model text.
                        void notify({ stage: 'sse-comment-received', logicalRequestId, attempt,
                            sseComments, streamBytesReceived,
                            elapsedSec: Math.round((Date.now() - attemptStartedMs) / 1000) });
                        return;
                    }
                    if (metadata?.streamActivity && metadata?.bytes > 0) {
                        streamBytesReceived += Number(metadata.bytes) || 0;
                        lastNetworkByteMs = Date.now();
                        if (!lastLoggedByteMs || lastNetworkByteMs - lastLoggedByteMs >= 30_000) {
                            lastLoggedByteMs = lastNetworkByteMs;
                            void notify({ stage: 'network-bytes-received', logicalRequestId,
                                attempt, streamBytesReceived, secondsSinceNetworkByte: 0,
                                elapsedSec: Math.round((lastNetworkByteMs - attemptStartedMs) / 1000) });
                        }
                        return;
                    }
                    if (!metadata?.streaming || !delta) return;
                    const text = String(delta);
                    if (!firstChunkAt) firstChunkAt = new Date().toISOString();
                    partialChars += text.length;
                    lastTextDeltaMs = Date.now();
                    pendingText += text;
                    if (pendingText.length >= 8_192) flushPartial();
                },
            }) || '').trim();
            await notify({ stage: 'request-model-returned', logicalRequestId, attempt,
                responseId, chars: answer.length, elapsedSec: Math.round((Date.now() - attemptStartedMs) / 1000) });
            flushPartial();
            await writes;
            if (writeFailure) {
                writeFailure.inferenceMayHaveStarted = true;
                throw writeFailure;
            }
            await persist({ status: 'model-returned', attempt, responseId,
                partialChars, outputChars: answer.length, outputSha256: hash(answer), firstChunkAt });
            await notify({ stage: 'request-partial-flushed', logicalRequestId, attempt,
                responseId, chars: partialChars });
            if (!answer) {
                const empty = new Error('Модель не вернула текстового ответа; пустой TXT не отправляется.');
                empty.inferenceMayHaveStarted = true;
                throw empty;
            }
            const answerTemporary = `${answerPath}.${process.pid}.tmp`;
            await writeFile(answerTemporary, answer, { mode: 0o600 });
            await rename(answerTemporary, answerPath);
            await persist({ status: 'completed', attempt, responseId,
                outputSha256: hash(answer), outputChars: answer.length, partialChars,
                firstChunkAt, completedAt: new Date().toISOString() });
            await notify({ stage: 'retry-attempt-complete', logicalRequestId, attempt,
                responseId, chars: answer.length, elapsedSec: Math.round((Date.now() - attemptStartedMs) / 1000) });
            return answer;
        } catch (error) {
            flushPartial();
            await writes;
            // Preserve the original model/transport error if the diagnostic
            // partial-output journal also failed; neither is permission to POST.
            if (writeFailure && error !== writeFailure) error.partialWriteError = String(writeFailure?.message || writeFailure).slice(0, 200);
            const knownId = String(error?.responseId || responseId || '').trim();
            await notify({ stage: 'transport-error-detail', logicalRequestId, attempt,
                code: String(error?.code || error?.name || 'unknown').slice(0, 80),
                sourceErrorType: String(error?.providerEventType || error?.name || '').slice(0, 90),
                sourceErrorCode: String(error?.cause?.code || error?.providerPayload?.code || '').slice(0, 100),
                traceDirectory: String(error?.traceDirectory || '').slice(0, 250),
                signalAborted: Boolean(jobSignal?.aborted),
                streamBytesReceived, partialChars, responseId: knownId,
                headersReceived: Boolean(headersReceivedAtMs), httpStatus, contentType, sseComments,
                secondsSinceNetworkByte: lastNetworkByteMs
                    ? Math.round((Date.now() - lastNetworkByteMs) / 1000) : null });
            // Propagate locally observed deltas to the caller so an explicit
            // context-error-looking message cannot trigger another POST after
            // any actual streamed output was received.
            if (partialChars > 0) error.streamOutputStarted = true;
            const retryable = isRetryableAstraTextTransportError(error);
            // A numerical provider-side context rejection is definitively NOT
            // a running inference, even when the router wrapped it as a stream
            // error and pessimistically set inferenceMayHaveStarted=true.
            const explicitContextRefusal = !knownId && !partialChars && !error?.streamOutputStarted &&
                /context_length_exceeded.{0,300}maximum context length is\s*\d+\s*tokens.{0,200}request requires\s*\d+/iu.test(String(error?.message || ''));
            const unknown = !explicitContextRefusal && Boolean(knownId || error?.inferenceMayHaveStarted ||
                error?.streamOutputStarted || partialChars);
            const canRetry = retryable && attempt < attempts && !knownId &&
                (!unknown || allowAmbiguousRepost);
            await persist({ status: canRetry ? 'retry-scheduled' : unknown ? 'unknown' : 'failed',
                attempt, responseId: knownId, partialChars, partialOutput: partialChars > 0,
                firstChunkAt, outcome: unknown ? 'unknown' : 'rejected',
                possibleDuplicateInference: unknown && canRetry,
                errorCode: String(error?.code || '').slice(0, 80),
                errorMessage: String(error?.message || error).slice(0, 350) });
            await notify({ stage: 'retry-attempt-error', logicalRequestId, attempt,
                responseId: knownId, partialOutput: partialChars > 0,
                outcome: unknown ? 'unknown' : 'rejected', possibleDuplicateInference: unknown && canRetry });
            if (!canRetry) {
                error.logicalRequestId = logicalRequestId;
                if (knownId) error.responseId = knownId;
                throw error;
            }
            const delayMs = attempt === 1 ? 8_000 : 25_000;
            await notify({ stage: 'retry-scheduled', logicalRequestId,
                attempt: attempt + 1, delayMs, sameIdempotencyKey: true,
                possibleDuplicateInference: unknown });
            await wait(delayMs);
        } finally {
            clearInterval(flushTimer);
            clearInterval(heartbeat);
        }
    }
    throw new Error('ASTRA_TEXT_RETRY_EXHAUSTED');
}
