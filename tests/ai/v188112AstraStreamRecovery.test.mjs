import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { consumeOpenAIStream } from '../../src/features/ai/openAIStream.js';
import { createProjectAuditStreamJournal } from '../../src/features/audit/projectAuditStreamJournal.js';

function streamingResponse(chunks, type = 'text/event-stream') {
    const encoder = new TextEncoder();
    let index = 0;
    return new Response(new ReadableStream({
        pull(controller) {
            if (index === chunks.length) { controller.close(); return; }
            controller.enqueue(encoder.encode(chunks[index++]));
        },
    }), { headers: { 'content-type': type } });
}

test('SSE heartbeat and incomplete JSON fragments count as real byte activity without visible output', async () => {
    const chunks = [
        ': ping\n\n',
        'data: {"type":"response.output_',
        'text.delta","delta":"hello"}\n\n',
        'data: {"type":"response.completed","response":{"id":"resp_1","status":"completed"}}\n\n',
    ];
    const activity = []; const events = []; const raw = [];
    const result = await consumeOpenAIStream(streamingResponse(chunks), {
        onActivity: (value) => activity.push(value.bytes),
        onChunk: (chunk) => raw.push(new TextDecoder().decode(chunk)),
        onPayload: async (event) => { await Promise.resolve(); events.push(event.type); },
    });
    assert.equal(result, 2);
    assert.deepEqual(events, ['response.output_text.delta', 'response.completed']);
    assert.equal(activity.length, chunks.length);
    assert.equal(raw.join(''), chunks.join(''));
    assert.ok(activity.every((bytes) => bytes > 0));
});

test('[DONE] is a terminal control, not an Astra answer', async () => {
    let done = 0;
    const events = [];
    await consumeOpenAIStream(streamingResponse([': ping\n\n', 'data: [DONE]\n\n']), {
        onPayload: (event) => events.push(event),
        onDone: () => { done += 1; },
    });
    assert.equal(done, 1);
    assert.deepEqual(events, []);
});

test('durable raw SSE journal keeps partial text separate from completion and records responseId', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-audit-stream-'));
    try {
        const journal = createProjectAuditStreamJournal('AUDIT-TEST', {
            rootDirectory: root, maxRawBytes: 500,
            progressIntervalMs: 0,
        });
        const raw = new TextEncoder().encode(': ping\n\ndata: {"type":"response.created"}\n\n');
        journal.recordChunk(raw);
        journal.recordEvent('response.created', 'resp_durable_1');
        journal.recordText('частичный текст, не готовый результат');
        const snapshot = journal.close('interrupted');
        assert.equal(snapshot.completed, false);
        assert.equal(snapshot.responseId, 'resp_durable_1');
        assert.equal(snapshot.receivedStreamBytes, raw.length);
        assert.equal(readFileSync(snapshot.rawPath, 'utf8'), new TextDecoder().decode(raw));
        assert.match(readFileSync(snapshot.partialAnswerPath, 'utf8'), /частичный текст/u);
        assert.match(readFileSync(snapshot.eventsPath, 'utf8'), /response\.created/u);
        assert.equal(JSON.parse(readFileSync(snapshot.progressPath, 'utf8')).status, 'interrupted');
        assert.equal(statSync(snapshot.rawPath).mode & 0o777, 0o600);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('truncated raw journal is flagged but does not stop streaming', () => {
    const root = mkdtempSync(join(tmpdir(), 'gigorave-audit-cap-'));
    try {
        const journal = createProjectAuditStreamJournal('AUDIT-LIMIT', { rootDirectory: root, maxRawBytes: 2 });
        journal.recordChunk(new TextEncoder().encode('abc'));
        const snapshot = journal.close('interrupted');
        assert.equal(snapshot.rawTruncated, true);
        assert.equal(snapshot.receivedStreamBytes, 3);
        assert.equal(readFileSync(snapshot.rawPath).length, 0);
    } finally { rmSync(root, { recursive: true, force: true }); }
});

test('project audit requires terminal SSE marker, saves partial stream and reuses known responseId', async () => {
    const code = readFileSync(new URL('../../src/app/botApplication.js', import.meta.url), 'utf8');
    assert.match(code, /PROJECT_AUDIT_STREAM_INCOMPLETE/u);
    assert.match(code, /if \(projectAuditStreaming && !streamCompleted\)/u);
    assert.match(code, /if \(knownStreamResponseId\) error\.responseId = knownStreamResponseId/u);
    assert.match(code, /responseId: knownStreamResponseId, requestBaseUrl/u);
    assert.match(code, /if \(error\?\.streamOutputStarted \|\| Number\(error\?\.streamBytesReceived \|\| 0\) > 0\)/u);
    assert.match(code, /store: backgroundResponse \|\| \(resolvedStreaming/u);
    assert.match(code, /createProjectAuditStreamJournal/u);
});
