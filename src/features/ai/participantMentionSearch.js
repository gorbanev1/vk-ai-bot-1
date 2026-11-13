import { Worker } from 'node:worker_threads';
import { performance } from 'node:perf_hooks';

// Search the entire history in a worker; allow up to one hour.
export const PARTICIPANT_MENTION_SEARCH_TIMEOUT_MS = 60 * 60 * 1000;
const BATCH_MESSAGES = 128;
const BATCH_CHARACTERS = 256 * 1024;

export function createParticipantMentionSearch({
    workerUrl = new URL('./participantMentionWorker.js', import.meta.url),
    maxActive = 1,
    maxQueued = 2,
} = {}) {
    let active = 0;
    const queue = [];
    const pump = () => {
        while (active < maxActive && queue.length) queue.shift().start();
    };

    return function search(messages, participant, matchedPhrase = '', {
        minimumScore = 0.8,
        excludeTargetAuthor = true,
        timeoutMs = PARTICIPANT_MENTION_SEARCH_TIMEOUT_MS,
        signal,
    } = {}) {
        const source = Array.isArray(messages) ? messages : [];
        const startedAt = performance.now();
        return new Promise(resolve => {
            let worker;
            let done = false;
            let started = false;
            let timer;
            let nextBatch;
            let cursor = source.length;
            let scannedCount = 0;
            const indexedMatches = [];
            const finish = (reason, error) => {
                if (done) return;
                done = true;
                clearTimeout(timer);
                clearImmediate(nextBatch);
                signal?.removeEventListener('abort', abort);
                const queuedIndex = queue.indexOf(job);
                if (queuedIndex >= 0) queue.splice(queuedIndex, 1);
                const result = {
                    matches: indexedMatches.sort((a, b) => a.index - b.index)
                        .map(({index, ...match}) => ({message: source[index], ...match})),
                    complete: reason === 'complete', reason, scannedCount,
                    totalCount: source.length, elapsedMs: Math.round(performance.now() - startedAt),
                    ...(error ? {error: String(error.message || error)} : {}),
                };
                // Keep the slot until the worker has really stopped. A timeout
                // must terminate CPU work, not merely abandon its promise.
                Promise.resolve(worker?.terminate()).catch(() => {}).finally(() => {
                    if (started) active -= 1;
                    resolve(result);
                    pump();
                });
            };
            const abort = () => finish('aborted');
            const sendBatch = () => {
                if (done) return;
                if (!cursor) { finish('complete'); return; }
                const batch = [];
                let characters = 0;
                // Scan newest first so a bounded/partial result stays useful.
                // Send only matching fields and indices, never the full archive.
                while (cursor > 0 && batch.length < BATCH_MESSAGES && characters < BATCH_CHARACTERS) {
                    const index = --cursor;
                    const message = source[index];
                    const text = String(message?.text ?? '');
                    batch.push({index, senderId: message?.senderId, text});
                    characters += text.length;
                }
                try { worker.postMessage({messages: batch}); }
                catch (error) { finish('worker-error', error); }
            };
            const job = {start() {
                if (done) return;
                started = true;
                active += 1;
                try {
                    worker = new Worker(workerUrl, {
                        workerData: {participant, matchedPhrase, options: {minimumScore, excludeTargetAuthor}},
                        // Do not inherit the bot's --import database preflight.
                        execArgv: [],
                        resourceLimits: {maxOldGenerationSizeMb: 128, maxYoungGenerationSizeMb: 16},
                    });
                    worker.on('message', packet => {
                        if (done) return;
                        if (packet.type === 'batch') {
                            scannedCount += packet.scanned;
                            for (const match of packet.matches) indexedMatches.push(match);
                        }
                        if (packet.type === 'ready' || packet.type === 'batch') {
                            if (scannedCount === source.length) finish('complete');
                            else nextBatch = setImmediate(sendBatch);
                        }
                    });
                    worker.on('error', error => finish('worker-error', error));
                    worker.on('exit', code => { if (!done) finish('worker-exit', new Error(`Worker exited: ${code}`)); });
                } catch (error) { finish('worker-error', error); }
            }};
            if (signal?.aborted) { finish('aborted'); return; }
            if (!source.length) { finish('complete'); return; }
            if (active >= maxActive && queue.length >= maxQueued) { finish('busy'); return; }
            signal?.addEventListener('abort', abort, {once: true});
            timer = setTimeout(() => finish('timeout'), Math.max(1, Math.min(
                PARTICIPANT_MENTION_SEARCH_TIMEOUT_MS, Number(timeoutMs) || PARTICIPANT_MENTION_SEARCH_TIMEOUT_MS,
            )));
            queue.push(job);
            pump();
        });
    };
}

export const findParticipantMentionMatchesAsync = createParticipantMentionSearch();
