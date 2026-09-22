import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { collectAuditableAiCredentials } from '../../src/features/ai/providerKeyAudit.js';
import { __FULL_AI_AUDIT_TESTING__, runFullAiAudit } from '../../src/features/ai/fullAiAudit.js';

function headers(contentType = 'application/json') {
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
function responseSse(text = 'GIGORAVE_AUDIT_OK') {
    const bytes = new TextEncoder().encode(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: text })}\n\ndata: [DONE]\n\n`);
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

const env = {
    OPENAI_API_KEY_1: 'TEST_OPENAI_KEY_REDACTED',
    OPENAI_API_KEY_2: 'TEST_OPENAI_KEY_REDACTED',
    OPENAI_COMPAT_API_KEY: 'TEST_OPENAI_KEY_REDACTED',
    OPENAI_COMPAT_BASE_URL: 'https://owner-router.invalid/v1',
};

const auditable = collectAuditableAiCredentials(env);
assert.deepEqual(auditable.map((row) => row.name).sort(), ['OPENAI_API_KEY_1', 'OPENAI_API_KEY_2']);
assert.equal(auditable.some((row) => row.name === 'OPENAI_COMPAT_API_KEY'), false);

assert.deepEqual(__FULL_AI_AUDIT_TESTING__.reasoningLevelsForModel('groq', 'openai/gpt-oss-120b'), ['low', 'medium', 'high']);
assert.deepEqual(__FULL_AI_AUDIT_TESTING__.reasoningLevelsForModel('groq', 'qwen/qwen3.6-27b'), ['none', 'default']);
assert.deepEqual(__FULL_AI_AUDIT_TESTING__.reasoningLevelsForModel('nvidia', 'meta/llama-3.3-70b-instruct'), []);
assert.equal(__FULL_AI_AUDIT_TESTING__.isExpectedAuditText('prefix GIGORAVE_AUDIT_OK suffix'), true);
assert.equal(__FULL_AI_AUDIT_TESTING__.isExpectedAuditText('some unrelated refusal'), false);
assert.equal(__FULL_AI_AUDIT_TESTING__.classifyFailure({ status: 401, error: 'invalid api key', provider: 'openai' }).definitiveDead, true);
assert.equal(__FULL_AI_AUDIT_TESTING__.classifyFailure({ status: 503, error: 'upstream unavailable', provider: 'openai' }).retryEligible, true);

const root = mkdtempSync(join(tmpdir(), 'gigorave-v121-second-round-'));
let keyAuditCalls = 0;
const keyAuditRunner = async () => {
    keyAuditCalls += 1;
    return {
        checkedAt: new Date().toISOString(),
        total: 2,
        valid: 1,
        invalid: 1,
        results: [
            {
                provider: 'openai', envName: 'OPENAI_API_KEY_1', masked: 'sk-fore…7890', ok: true,
                status: 200, elapsedMs: 1, error: '', account: '', note: '',
                models: [{ id: 'plain-model', capabilities: ['text'], description: '', displayName: '', methods: [] }],
            },
            {
                provider: 'openai', envName: 'OPENAI_API_KEY_2', masked: 'sk-dead…7890', ok: false,
                status: 401, elapsedMs: 1, error: 'Incorrect API key provided', account: '', note: '', models: [],
            },
        ],
    };
};
const visualAuditRunner = async ({ directory }) => ({
    outDir: join(directory, 'GRAPHICS_MATRIX_RESULTS', 'empty'),
    summaryPath: join(directory, 'graphics-summary.txt'),
    jsonlPath: join(directory, 'graphics-results.jsonl'),
    attempts: 0,
    results: [],
});

const seen = [];
const fakeFetch = async (url, options = {}) => {
    const target = String(url);
    let body = {};
    try { body = JSON.parse(options.body || '{}'); } catch { /* ignored */ }
    seen.push({ target, stream: body.stream === true, model: body.model });

    if (target.endsWith('/chat/completions') && body.model === 'plain-model') {
        return jsonResponse(503, { error: { message: 'temporary upstream failure' } });
    }
    if (target.endsWith('/responses') && body.model === 'plain-model') {
        return body.stream === true
            ? responseSse()
            : jsonResponse(200, { output_text: 'GIGORAVE_AUDIT_OK' });
    }
    return jsonResponse(404, { error: { message: 'unexpected endpoint in V121 test' } });
};

try {
    const report = await runFullAiAudit({
        env,
        directory: root,
        fetchImpl: fakeFetch,
        keyAuditRunner,
        visualAuditRunner,
        timeoutMs: 1_000,
        now: new Date('2026-08-24T14:00:00.000Z'),
    });

    assert.equal(keyAuditCalls, 1, 'definitive 401 key must not be pointlessly rechecked in round two');
    assert.equal(report.stats.secondRoundKeyAttempts, 0);
    assert.equal(report.stats.secondRoundTextAttempts, 2);
    assert.equal(report.stats.secondRoundTextRecovered, 2);
    assert.equal(report.stats.textModelsKept, 1);
    assert.equal(report.workingModes.length, 1);
    assert.equal(report.workingModes[0].model, 'plain-model');
    assert.equal(report.workingModes[0].preferredTransport, 'non_stream');
    assert.equal(report.workingModes[0].fallbackTransport, 'stream');
    assert.ok(seen.some((row) => row.target.endsWith('/responses') && row.stream === false));
    assert.ok(seen.some((row) => row.target.endsWith('/responses') && row.stream === true));
    assert.ok(report.retryCandidates.some((row) => row.kind === 'invalid_key' && row.definitiveDead === true));
} finally {
    rmSync(root, { recursive: true, force: true });
}

console.log('full AI audit V121 two-pass tests: ok');
