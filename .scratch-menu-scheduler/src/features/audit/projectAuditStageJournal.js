/**
 * Durable checkpoints for *paid* text-audit stages. A non-completed stage is
 * never a license to issue another Responses POST after a process restart.
 * The stream journal captures raw SSE; this journal owns validated JSON output.
 */
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream, existsSync, mkdirSync, openSync, writeFileSync, fsyncSync, closeSync, renameSync, readFileSync } from 'node:fs';
import { once } from 'node:events';
import { resolve } from 'node:path';

function safeSegment(value) {
    const clean = String(value || '').replace(/[^a-z0-9._-]+/giu, '_').slice(0, 180);
    if (!clean || clean === '.' || clean === '..') throw new Error('Invalid audit stage path');
    return clean;
}

export function auditStageInputHash({ model, systemPrompt, userPrompt, maxTokens }) {
    return createHash('sha256').update(JSON.stringify([model, systemPrompt, userPrompt, maxTokens])).digest('hex');
}

function atomicWrite(filePath, data) {
    const temporaryPath = `${filePath}.${randomUUID()}.tmp`;
    const fd = openSync(temporaryPath, 'wx', 0o600);
    try {
        writeFileSync(fd, data);
        fsyncSync(fd);
    } finally { closeSync(fd); }
    renameSync(temporaryPath, filePath);
}

export function createAuditStageJournal({ jobId, stage, inputSha256, inputChars, model, inferenceIdempotencyKey, rootDirectory = resolve('data/audit-jobs') }) {
    const directory = resolve(rootDirectory, safeSegment(jobId), 'stages', safeSegment(stage));
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const statePath = resolve(directory, 'state.json');
    const answerPath = resolve(directory, 'answer.txt');
    const eventsPath = resolve(directory, 'events.ndjson');
    const old = existsSync(statePath) ? JSON.parse(readFileSync(statePath, 'utf8')) : null;
    if (old && old.inputSha256 !== inputSha256) {
        throw new Error(`PROJECT_AUDIT_STAGE_INPUT_MISMATCH: ${stage}; refusing to reuse or overwrite paid inference`);
    }
    let state = old || {
        jobId, stage, status: 'pending', inputSha256, inputChars,
        responseId: '', inferenceIdempotencyKey, model,
        providerBaseUrl: '', providerCredentialName: '',
        answerChars: 0, findings: null, startedAt: null, completedAt: null,
    };
    let output = null;
    let events = null;
    let ioFailure = null;
    const writeState = (changes) => {
        state = { ...state, ...changes, updatedAt: new Date().toISOString() };
        atomicWrite(statePath, `${JSON.stringify(state, null, 2)}\n`);
        return { ...state };
    };
    const event = (type, metadata = {}) => {
        if (!events) return;
        events.write(`${JSON.stringify({ at: new Date().toISOString(), type, ...metadata })}\n`);
    };
    const openStreams = () => {
        if (output) return;
        output = createWriteStream(answerPath, { flags: 'a', mode: 0o600 });
        events = createWriteStream(eventsPath, { flags: 'a', mode: 0o600 });
        output.on('error', (error) => { ioFailure = error; });
        events.on('error', (error) => { ioFailure = error; });
    };
    const endStreams = async () => {
        for (const stream of [output, events]) {
            if (!stream) continue;
            if (!stream.destroyed && !stream.writableFinished) {
                stream.end();
                await Promise.race([once(stream, 'finish'), once(stream, 'close')]);
            }
        }
        output = null;
        events = null;
        if (ioFailure) throw ioFailure;
    };
    return {
        paths: { statePath, answerPath, eventsPath },
        read: () => ({ ...state }),
        cachedAnswer() {
            if (state.status !== 'completed') return null;
            if (!existsSync(answerPath)) throw new Error(`PROJECT_AUDIT_STAGE_ANSWER_MISSING: ${stage}`);
            const answer = readFileSync(answerPath, 'utf8');
            const digest = createHash('sha256').update(answer).digest('hex');
            if (digest !== state.answerSha256) throw new Error(`PROJECT_AUDIT_STAGE_ANSWER_HASH_MISMATCH: ${stage}`);
            return answer;
        },
        start() {
            if (state.status !== 'pending') throw new Error(`PROJECT_AUDIT_STAGE_REPOST_BLOCKED: ${stage} ${state.status}`);
            writeState({ status: 'starting', startedAt: new Date().toISOString() });
            openStreams();
            event('starting');
        },
        responseCreated({ responseId, model: selectedModel, credentialName, requestBaseUrl, inferenceIdempotencyKey: key, partialStreamPath, partialAnswerPath, streamProgressPath }) {
            if (!responseId) return;
            // Persist before accepting any further paid output; storage failures are fatal.
            writeState({ status: 'stream-running', responseId, model: selectedModel || state.model,
                providerBaseUrl: requestBaseUrl || '', providerCredentialName: credentialName || '',
                inferenceIdempotencyKey: key || state.inferenceIdempotencyKey,
                partialStreamPath: partialStreamPath || '', partialAnswerPath: partialAnswerPath || '',
                streamProgressPath: streamProgressPath || '' });
            event('response.created', { responseId });
        },
        delta(text) {
            if (!text) return;
            openStreams();
            if (!output.write(String(text))) { /* node stream queues writes without blocking the SSE reader */ }
            state.answerChars += String(text).length;
            event('output.delta', { chars: String(text).length, receivedTextChars: state.answerChars });
        },
        async complete(answer, findings = null) {
            await endStreams();
            // A complete JSON answer supersedes possibly duplicated/interrupted SSE deltas.
            atomicWrite(answerPath, String(answer));
            const fd = openSync(answerPath, 'r');
            try { fsyncSync(fd); } finally { closeSync(fd); }
            return writeState({ status: 'completed', answerChars: String(answer).length,
                answerSha256: createHash('sha256').update(String(answer)).digest('hex'),
                findings, completedAt: new Date().toISOString() });
        },
        async interrupt(error) {
            try { event('interrupted', { code: String(error?.code || ''), responseId: String(error?.responseId || state.responseId || '') });
                await endStreams(); } catch { /* Preserve the paid responseId even when journaling fails. */ }
            return writeState({ status: state.responseId || error?.responseId ? 'interrupted' : 'ambiguous',
                responseId: String(error?.responseId || state.responseId || ''),
                failureCode: String(error?.code || 'MODEL_STAGE_INTERRUPTED').slice(0, 128) });
        },
    };
}
