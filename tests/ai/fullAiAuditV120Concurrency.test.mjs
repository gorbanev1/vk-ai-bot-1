import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFullAiAudit } from '../../src/features/ai/fullAiAudit.js';

function headers(contentType) {
    return { get(name) { return String(name).toLowerCase() === 'content-type' ? contentType : ''; } };
}
function jsonResponse(payload) {
    return {
        ok: true,
        status: 200,
        headers: headers('application/json'),
        async text() { return JSON.stringify(payload); },
    };
}
function sseResponse(text = 'GIGORAVE_AUDIT_OK') {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers: headers('text/event-stream'),
        body: {
            getReader() {
                return {
                    async read() {
                        if (sent) return { done: true, value: undefined };
                        sent = true;
                        return { done: false, value: bytes };
                    },
                };
            },
        },
        async text() { return ''; },
    };
}

const root = mkdtempSync(join(tmpdir(), 'gigorave-v120-concurrency-'));
const env = {
    OPENAI_API_KEY: 'sk-v120-a-1234567890',
    OPENAI_API_KEY_2: 'sk-v120-b-1234567890',
    OPENAI_API_KEY_3: 'sk-v120-c-1234567890',
    OPENAI_API_BASE_URL: 'https://audit.invalid/v1',
    AI_AUDIT_MODEL_CONCURRENCY: '3',
    AI_AUDIT_PER_KEY_MODEL_CONCURRENCY: '1',
    AI_AUDIT_REASONING_CONCURRENCY: '2',
};
const keyRows = [
    ['OPENAI_API_KEY', 'model-a'],
    ['OPENAI_API_KEY_2', 'model-b'],
    ['OPENAI_API_KEY_3', 'model-c'],
];
const keyAuditRunner = async () => ({
    checkedAt: new Date().toISOString(), total: 3, valid: 3, invalid: 0,
    results: keyRows.map(([envName, model], index) => ({
        provider: 'openai', envName, masked: `key-${index + 1}`, ok: true, status: 200,
        elapsedMs: 1, error: '', account: '', note: '',
        models: [{ id: model, capabilities: ['text'], description: '', displayName: '', methods: [] }],
    })),
});
const visualAuditRunner = async ({ directory }) => ({
    outDir: join(directory, 'GRAPHICS_MATRIX_RESULTS', 'empty'),
    summaryPath: join(directory, 'graphics-summary.txt'), jsonlPath: join(directory, 'graphics-results.jsonl'),
    attempts: 0, results: [],
});

let active = 0;
let maxActive = 0;
let calls = 0;
const fakeFetch = async (_url, options = {}) => {
    active += 1;
    calls += 1;
    maxActive = Math.max(maxActive, active);
    await new Promise((resolve) => setTimeout(resolve, 20));
    active -= 1;
    let body = {};
    try { body = JSON.parse(options.body || '{}'); } catch { /* noop */ }
    return body.stream === true
        ? sseResponse()
        : jsonResponse({ choices: [{ message: { content: 'GIGORAVE_AUDIT_OK' } }] });
};

try {
    const report = await runFullAiAudit({
        env, directory: root, fetchImpl: fakeFetch, keyAuditRunner, visualAuditRunner,
        now: new Date('2026-08-24T12:00:00.000Z'), clearPrevious: true,
    });
    assert.equal(report.textResults.length, 3);
    assert.ok(calls >= 6, 'baseline plus reasoning calls must be issued');
    assert.ok(maxActive >= 4, `expected concurrent network requests, observed maxActive=${maxActive}`);
    assert.ok(report.textResults.every((row) => row.transports.non_stream.ok && row.transports.stream.ok));
} finally {
    rmSync(root, { recursive: true, force: true });
}

console.log(`full AI audit V120 concurrency tests: ok (maxActive=${maxActive})`);
