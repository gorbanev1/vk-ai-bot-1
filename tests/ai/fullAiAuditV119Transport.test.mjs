import assert from 'node:assert/strict';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFullAiAudit } from '../../src/features/ai/fullAiAudit.js';
import { classifyModelCapabilities } from '../../src/features/ai/providerKeyAudit.js';

function headers(contentType) {
    return { get(name) { return String(name).toLowerCase() === 'content-type' ? contentType : ''; } };
}
function jsonResponse(status, payload) {
    return {
        ok: status >= 200 && status < 300,
        status,
        headers: headers('application/json'),
        async text() { return JSON.stringify(payload); },
        async arrayBuffer() { return new TextEncoder().encode(JSON.stringify(payload)).buffer; },
    };
}
function sseResponse(text = 'GIGORAVE_AUDIT_OK') {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: text } }] })}\n\ndata: [DONE]\n\n`);
    let sent = false;
    return {
        ok: true,
        status: 200,
        headers: headers('text/event-stream; charset=utf-8'),
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

assert.deepEqual(classifyModelCapabilities('groq', { id: 'meta-llama/llama-guard-4-12b', description: '' }), ['moderation']);

const root = mkdtempSync(join(tmpdir(), 'gigorave-v119-transport-'));
const staleRoot = join(root, 'AI_FULL_AUDIT_RESULTS');
mkdirSync(staleRoot, { recursive: true });
writeFileSync(join(staleRoot, 'STALE_V118.txt'), 'must disappear', 'utf8');

const env = {
    OPENAI_API_KEY: 'TEST_OPENAI_KEY_REDACTED',
    OPENAI_API_BASE_URL: 'https://audit.invalid/v1',
};
const models = ['model-both', 'model-stream-only', 'model-nonstream-only', 'model-dead'];
const keyAuditRunner = async () => ({
    checkedAt: new Date().toISOString(), total: 1, valid: 1, invalid: 0,
    results: [{
        provider: 'openai', envName: 'OPENAI_API_KEY', masked: 'sk-v119…7890', ok: true, status: 200, elapsedMs: 1, error: '', account: '', note: '',
        models: models.map((id) => ({ id, capabilities: ['text'], description: '', displayName: '', methods: [] })),
    }],
});
const visualAuditRunner = async ({ directory }) => ({
    outDir: join(directory, 'GRAPHICS_MATRIX_RESULTS', 'empty'),
    summaryPath: join(directory, 'graphics-summary.txt'), jsonlPath: join(directory, 'graphics-results.jsonl'), attempts: 0, results: [],
});

const fakeFetch = async (_url, options = {}) => {
    let body = {};
    try { body = JSON.parse(options.body || '{}'); } catch { /* ignore */ }
    const model = body.model || '';
    const stream = body.stream === true;

    if (model === 'model-both') return stream ? sseResponse() : jsonResponse(200, { choices: [{ message: { content: 'GIGORAVE_AUDIT_OK' } }] });
    if (model === 'model-stream-only') return stream ? sseResponse() : jsonResponse(504, { error: { message: 'non-stream timeout' } });
    if (model === 'model-nonstream-only') return stream ? jsonResponse(400, { error: { message: 'stream unsupported' } }) : jsonResponse(200, { choices: [{ message: { content: 'GIGORAVE_AUDIT_OK' } }] });
    if (model === 'model-dead') return jsonResponse(404, { error: { message: 'model unavailable' } });
    return jsonResponse(404, { error: { message: `unexpected model ${model}` } });
};

try {
    const report = await runFullAiAudit({
        env, directory: root, fetchImpl: fakeFetch, keyAuditRunner, visualAuditRunner,
        now: new Date('2026-08-24T10:00:00.000Z'), clearPrevious: true,
    });

    assert.equal(existsSync(join(staleRoot, 'STALE_V118.txt')), false, 'fresh V119 pass must clear previous audit root');
    assert.equal(existsSync(report.donePath), true, 'AUDIT_DONE.json must mark completion');
    assert.equal(JSON.parse(readFileSync(report.donePath, 'utf8')).status, 'completed');
    assert.equal(report.stats.textTransportAttempts, 8);
    assert.equal(report.stats.textModelsKept, 3);

    const byModel = new Map(report.textResults.map((row) => [row.model, row]));
    assert.deepEqual(
        { preferred: byModel.get('model-both').preferredTransport, fallback: byModel.get('model-both').fallbackTransport, state: byModel.get('model-both').transportState },
        { preferred: 'non_stream', fallback: 'stream', state: 'both' },
    );
    assert.deepEqual(
        { preferred: byModel.get('model-stream-only').preferredTransport, fallback: byModel.get('model-stream-only').fallbackTransport, state: byModel.get('model-stream-only').transportState },
        { preferred: 'stream', fallback: 'non_stream_retry_once', state: 'stream_only' },
    );
    assert.deepEqual(
        { preferred: byModel.get('model-nonstream-only').preferredTransport, fallback: byModel.get('model-nonstream-only').fallbackTransport, state: byModel.get('model-nonstream-only').transportState },
        { preferred: 'non_stream', fallback: '', state: 'non_stream_only' },
    );
    assert.equal(byModel.get('model-dead').keep, false);

    assert.ok(byModel.get('model-both').reasoningModesSupported.includes('default'));
    assert.ok(byModel.get('model-stream-only').reasoningModesSupported.includes('default'));
    assert.ok(byModel.get('model-nonstream-only').reasoningModesSupported.includes('default'));
    assert.deepEqual(byModel.get('model-both').reasoningPolicies.default.preferredTransport, 'non_stream');
    assert.deepEqual(byModel.get('model-stream-only').reasoningPolicies.default.preferredTransport, 'stream');
    assert.deepEqual(byModel.get('model-nonstream-only').reasoningPolicies.default.preferredTransport, 'non_stream');

    assert.equal(report.workingModes.length, 3);
    const streamOnlyRuntime = report.workingModes.find((row) => row.model === 'model-stream-only');
    assert.equal(streamOnlyRuntime.preferredTransport, 'stream');
    assert.equal(streamOnlyRuntime.fallbackTransport, 'non_stream_retry_once');
} finally {
    rmSync(root, { recursive: true, force: true });
}

console.log('full AI audit V119 transport matrix tests: ok');
