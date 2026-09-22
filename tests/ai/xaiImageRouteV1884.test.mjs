import assert from 'node:assert/strict';
import { parseExternalProviderCommand } from '../../src/features/ai/externalProviderRouting.js';
import { probeProviderVisualModel } from '../../src/features/ai/allProviderVisualMatrixAudit.js';

const parsed = parseExternalProviderCommand('грок нарисуй кота в космосе');
assert.equal(parsed.matched, true);
assert.equal(parsed.provider, 'xai');
assert.equal(parsed.action, 'image_generate');
assert.equal(parsed.model, 'auto');
assert.equal(parsed.prompt, 'кота в космосе');

const parsedModel = parseExternalProviderCommand('xai нарисуй через grok-imagine-image-2.0 ворона');
assert.equal(parsedModel.action, 'image_generate');
assert.equal(parsedModel.model, 'grok-imagine-image-2.0');

const imageBytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10, 1, 2, 3, 4]);
const fetchImpl = async (url) => {
    const target = String(url);
    if (target.endsWith('/images/generations')) {
        return new Response(JSON.stringify({ data: [{ url: 'https://cdn.example/test.png' }] }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    }
    if (target === 'https://cdn.example/test.png') {
        return new Response(imageBytes, {
            status: 200,
            headers: { 'content-type': 'image/png' },
        });
    }
    throw new Error(`unexpected URL ${target}`);
};

const probe = await probeProviderVisualModel({
    credential: { provider: 'xai', secret: 'xai-test', baseUrl: 'https://api.x.ai/v1' },
    model: 'grok-imagine-image-2.0',
    prompt: 'test',
    fetchImpl,
    timeoutMs: 3000,
});
assert.equal(probe.ok, true);
assert.equal(probe.image.mimeType, 'image/png');
assert.equal(probe.image.buffer.length, imageBytes.length);

console.log('xAI image route V188.4: ok');
