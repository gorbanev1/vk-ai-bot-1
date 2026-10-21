/**
 * Best-effort, private stream forensic journal. Raw SSE is not a completed
 * model result; only response.completed/[DONE] can close a paid stage.
 * Never let a diagnostic write failure abort an already-started inference.
 */
import { appendFileSync, closeSync, fsyncSync, mkdirSync, openSync, renameSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export function createProjectAuditStreamJournal(jobId, {
    rootDirectory = resolve('data/audit-jobs'),
    stage = 'single-shot',
    maxRawBytes = 512 * 1024 * 1024,
    progressIntervalMs = 10_000,
} = {}) {
    const safeJobId = String(jobId || '').replace(/[^a-z0-9._-]+/giu, '_').slice(0, 180);
    if (!safeJobId || safeJobId === '.' || safeJobId === '..') throw new Error('Invalid project audit journal job id');
    const directory = resolve(rootDirectory, safeJobId, 'stream');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const attemptId = `${Date.now()}-${randomUUID()}`;
    const prefix = resolve(directory, attemptId);
    const rawPath = `${prefix}.sse`;
    const partialAnswerPath = `${prefix}.partial-answer.txt`;
    const eventsPath = `${prefix}.events.ndjson`;
    const progressPath = `${prefix}.progress.json`;
    const rawFd = openSync(rawPath, 'ax', 0o600);
    const answerFd = openSync(partialAnswerPath, 'ax', 0o600);
    const eventsFd = openSync(eventsPath, 'ax', 0o600);
    const descriptors = [rawFd, answerFd, eventsFd];
    const state = {
        jobId: String(jobId), stage: String(stage), attemptId,
        status: 'streaming', responseId: '', receivedStreamBytes: 0,
        receivedTextChars: 0, lastEventType: '', lastActivityAt: new Date().toISOString(),
        journalError: '', rawTruncated: false, completed: false,
        rawPath, partialAnswerPath, eventsPath, progressPath,
    };
    let closed = false;
    let lastProgressAt = 0;
    const diagnose = (error) => {
        state.journalError = String(error?.message ?? error).slice(0, 400);
    };
    const flush = (force = false) => {
        if (closed) return;
        const now = Date.now();
        if (!force && now - lastProgressAt < progressIntervalMs) return;
        try {
            const temporary = `${progressPath}.${randomUUID()}.tmp`;
            const fd = openSync(temporary, 'wx', 0o600);
            try {
                writeFileSync(fd, `${JSON.stringify(state, null, 2)}\n`, 'utf8');
                fsyncSync(fd);
            } finally { closeSync(fd); }
            renameSync(temporary, progressPath);
            lastProgressAt = now;
        } catch (error) { diagnose(error); }
    };
    flush(true);
    return {
        paths: { rawPath, partialAnswerPath, eventsPath, progressPath },
        snapshot: () => ({ ...state }),
        recordChunk(chunk) {
            if (closed || !chunk?.byteLength) return;
            state.lastActivityAt = new Date().toISOString();
            state.receivedStreamBytes += chunk.byteLength;
            try {
                if (!state.rawTruncated) {
                    // Do not silently accumulate an unbounded SSE log (e.g. base64 artifacts).
                    if (state.receivedStreamBytes <= maxRawBytes) {
                        appendFileSync(rawFd, chunk);
                    } else {
                        state.rawTruncated = true;
                        appendFileSync(eventsFd, `${JSON.stringify({ type: 'raw-journal-limit', at: state.lastActivityAt })}\n`);
                    }
                }
            } catch (error) { diagnose(error); }
            flush();
        },
        recordEvent(type, responseId = '') {
            if (closed) return;
            state.lastEventType = String(type || 'unknown').slice(0, 128);
            state.lastActivityAt = new Date().toISOString();
            if (responseId) state.responseId = String(responseId).slice(0, 256);
            try {
                appendFileSync(eventsFd, `${JSON.stringify({ type: state.lastEventType, responseId: state.responseId || undefined, at: state.lastActivityAt })}\n`);
            } catch (error) { diagnose(error); }
            flush(Boolean(responseId));
        },
        recordText(delta) {
            if (closed || !delta) return;
            state.receivedTextChars += String(delta).length;
            try { appendFileSync(answerFd, String(delta), 'utf8'); }
            catch (error) { diagnose(error); }
            flush();
        },
        close(status = 'interrupted') {
            if (closed) return { ...state };
            state.status = String(status);
            state.completed = status === 'completed';
            // Persist raw bytes and parsed deltas before a progress snapshot can
            // claim the stage was completed (also matters on OS/power failure).
            for (const fd of descriptors) {
                try { fsyncSync(fd); } catch (error) { diagnose(error); }
                try { closeSync(fd); } catch (error) { diagnose(error); }
            }
            flush(true);
            closed = true;
            return { ...state };
        },
    };
}
