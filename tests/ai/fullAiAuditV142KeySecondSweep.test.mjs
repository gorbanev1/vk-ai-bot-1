import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { runFullAiAudit } from '../../src/features/ai/fullAiAudit.js';

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
function sseResponse(text = 'GIGORAVE_AUDIT_OK') {
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

test('V142 does a complete second key sweep across all models and recovers a key before cleanup', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gigorave-v142-key-sweep-'));
    const env = {
        OPENAI_API_KEY_1: 'TEST_OPENAI_KEY_REDACTED',
        AI_AUDIT_TARGETED_RETRY_MAX_MODELS: '0',
        AI_AUDIT_MODEL_CONCURRENCY: '2',
        AI_AUDIT_PER_KEY_MODEL_CONCURRENCY: '1',
    };
    let catalogCalls = 0;
    const keyAuditRunner = async ({ onlyEnvNames = null } = {}) => {
        catalogCalls += 1;
        if (onlyEnvNames) assert.deepEqual(onlyEnvNames, ['OPENAI_API_KEY_1']);
        return {
            checkedAt: new Date().toISOString(),
            total: 1,
            valid: 1,
            invalid: 0,
            results: [{
                provider: 'openai', envName: 'OPENAI_API_KEY_1', masked: 'sk-fore…flaky',
                ok: true, status: 200, elapsedMs: 1, error: '', account: '', note: '',
                models: [
                    { id: 'recover-model', capabilities: ['text'], description: '', displayName: '', methods: [] },
                    { id: 'still-dead-model', capabilities: ['text'], description: '', displayName: '', methods: [] },
                ],
            }],
        };
    };
    const visualAuditRunner = async ({ directory }) => ({
        outDir: join(directory, 'GRAPHICS_MATRIX_RESULTS', 'empty'),
        summaryPath: join(directory, 'graphics-summary.txt'),
        jsonlPath: join(directory, 'graphics-results.jsonl'),
        attempts: 0,
        results: [],
    });

    const responsesCalls = new Map();
    const allModelsSeen = new Set();
    const fakeFetch = async (url, options = {}) => {
        const target = String(url);
        let body = {};
        try { body = JSON.parse(options.body || '{}'); } catch { /* ignored */ }
        const model = String(body.model || '');
        if (model) allModelsSeen.add(model);

        if (target.endsWith('/chat/completions')) {
            return jsonResponse(429, { error: { message: 'quota on baseline route' } });
        }
        if (target.endsWith('/responses')) {
            const key = `${model}:${body.stream === true ? 'stream' : 'non_stream'}`;
            const count = (responsesCalls.get(key) || 0) + 1;
            responsesCalls.set(key, count);
            if (model === 'recover-model' && count >= 2) {
                return body.stream === true
                    ? sseResponse()
                    : jsonResponse(200, { output_text: 'GIGORAVE_AUDIT_OK' });
            }
            return jsonResponse(429, { error: { message: 'quota still unavailable' } });
        }
        return jsonResponse(404, { error: { message: 'unexpected endpoint' } });
    };

    try {
        const report = await runFullAiAudit({
            env,
            directory: dir,
            fetchImpl: fakeFetch,
            keyAuditRunner,
            visualAuditRunner,
            timeoutMs: 1_000,
            now: new Date('2026-09-03T12:00:00.000Z'),
        });

        assert.equal(catalogCalls, 2, 'zero-working key must get a fresh catalog pass before final cleanup sweep');
        assert.equal(report.keySecondSweep.candidates, 1);
        assert.equal(report.keySecondSweep.catalogRetested, 1);
        assert.equal(report.keySecondSweep.textModelsTested, 2);
        assert.equal(report.keySecondSweep.imageModelsTested, 0);
        assert.equal(report.keySecondSweep.modelTransportAttempts, 4);
        assert.equal(report.keySecondSweep.recoveredKeys, 1);
        assert.equal(report.keySecondSweep.confirmedDeadKeys, 0);
        assert.equal(report.keySecondSweep.uncertainKeys, 0);
        assert.equal(report.keySecondSweep.results[0].verdict, 'working-recovered');
        assert.deepEqual([...allModelsSeen].sort(), ['recover-model', 'still-dead-model']);
        assert.ok(report.keySecondSweep.results[0].attempts.some((row) => row.model === 'still-dead-model'));
        assert.ok(report.workingModes.some((row) => row.envName === 'OPENAI_API_KEY_1' && row.model === 'recover-model' && row.capability === 'text'));
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});

test('V142 marks a key dead-confirmed only after the full second model sweep still has zero working modes', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'gigorave-v142-key-dead-'));
    const env = {
        OPENAI_API_KEY_1: 'TEST_OPENAI_KEY_REDACTED',
        AI_AUDIT_TARGETED_RETRY_MAX_MODELS: '0',
    };
    const keyAuditRunner = async () => ({
        checkedAt: new Date().toISOString(),
        total: 1,
        valid: 1,
        invalid: 0,
        results: [{
            provider: 'openai', envName: 'OPENAI_API_KEY_1', masked: 'sk-fore…dead',
            ok: true, status: 200, elapsedMs: 1, error: '', account: '', note: '',
            models: [{ id: 'quota-model', capabilities: ['text'], description: '', displayName: '', methods: [] }],
        }],
    });
    const visualAuditRunner = async ({ directory }) => ({
        outDir: join(directory, 'GRAPHICS_MATRIX_RESULTS', 'empty'),
        summaryPath: join(directory, 'graphics-summary.txt'),
        jsonlPath: join(directory, 'graphics-results.jsonl'),
        attempts: 0,
        results: [],
    });
    const fakeFetch = async () => jsonResponse(429, { error: { message: 'quota unavailable on every model route' } });

    try {
        const report = await runFullAiAudit({
            env,
            directory: dir,
            fetchImpl: fakeFetch,
            keyAuditRunner,
            visualAuditRunner,
            timeoutMs: 1_000,
            now: new Date('2026-09-03T12:30:00.000Z'),
        });
        assert.equal(report.keySecondSweep.candidates, 1);
        assert.equal(report.keySecondSweep.textModelsTested, 1);
        assert.equal(report.keySecondSweep.recoveredKeys, 0);
        assert.equal(report.keySecondSweep.confirmedDeadKeys, 1);
        assert.equal(report.keySecondSweep.results[0].verdict, 'dead-confirmed');
        assert.equal(report.workingModes.length, 0);
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
