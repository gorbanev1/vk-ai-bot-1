import assert from 'node:assert/strict';
import { runCompactAiHealthAudit, __COMPACT_AI_HEALTH_TESTING__ } from '../../src/features/ai/compactAiHealthAudit.js';
import { parseProviderCommand } from '../../src/features/ai/providerDiagnostics.js';

assert.equal(parseProviderCommand('проверить рабочие модели').action, 'compact_models_audit');
assert.equal(parseProviderCommand('ключи и модели проверить').action, 'compact_models_audit');
assert.equal(parseProviderCommand('тест всех моделей').action, 'full_models_audit');

assert.deepEqual(
    __COMPACT_AI_HEALTH_TESTING__.chooseTextPolicy({ ok: true }, { ok: true }),
    { status: 'working', preferredTransport: 'non_stream' },
);
assert.equal(
    __COMPACT_AI_HEALTH_TESTING__.chooseTextPolicy({ ok: false, status: 503 }, { ok: false, status: 503 }).status,
    'unavailable',
);
assert.equal(
    __COMPACT_AI_HEALTH_TESTING__.chooseTextPolicy({ ok: false, status: 404 }, { ok: false, status: 404 }).status,
    'dead',
);

const encoder = new TextEncoder();
const fetchImpl = async (url, options = {}) => {
    const target = String(url);
    if (target.endsWith('/models')) {
        return new Response(JSON.stringify({ data: [{ id: 'gpt-good' }, { id: 'gpt-dead' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    if (target.endsWith('/chat/completions') || target.endsWith('/responses')) {
        const body = JSON.parse(String(options.body || '{}'));
        if (body.model === 'gpt-dead') {
            return new Response(JSON.stringify({ error: { message: 'model not found' } }), {
                status: 404,
                headers: { 'content-type': 'application/json' },
            });
        }
        if (body.stream) {
            const payload = 'data: {"choices":[{"delta":{"content":"GIGORAVE_AUDIT_OK"}}]}\n\ndata: [DONE]\n\n';
            return new Response(encoder.encode(payload), {
                status: 200,
                headers: { 'content-type': 'text/event-stream' },
            });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'GIGORAVE_AUDIT_OK' } }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    throw new Error(`unexpected URL ${target}`);
};

const audit = await runCompactAiHealthAudit({
    env: {
        OPENAI_COMPAT_API_KEY: 'secret-test-key',
        OPENAI_COMPAT_BASE_URL: 'https://mock.example/v1',
        AI_HEALTH_KEY_TIMEOUT_MS: '2000',
        AI_HEALTH_MODEL_TIMEOUT_MS: '3000',
        AI_HEALTH_KEY_CONCURRENCY: '8',
        AI_HEALTH_MODEL_CONCURRENCY: '8',
        AI_HEALTH_PER_KEY_CONCURRENCY: '4',
        AI_HEALTH_MAX_TEXT_MODELS_PER_KEY: '8',
        AI_HEALTH_MAX_IMAGE_MODELS_PER_KEY: '2',
    },
    fetchImpl,
});

assert.equal(audit.stats.keys, 1);
assert.equal(audit.stats.workingKeys, 1);
assert.equal(audit.stats.modelsTested, 2);
assert.equal(audit.stats.workingModels, 1);
assert.equal(audit.models.find((row) => row.model === 'gpt-good')?.status, 'working');
assert.equal(audit.models.find((row) => row.model === 'gpt-good')?.nonStreamOk, true);
assert.equal(audit.models.find((row) => row.model === 'gpt-good')?.streamOk, true);
assert.equal(audit.models.find((row) => row.model === 'gpt-dead')?.status, 'dead');
assert.equal(audit.workingRows[0].model, 'gpt-good');

console.log('compact AI health V188.4: ok');
