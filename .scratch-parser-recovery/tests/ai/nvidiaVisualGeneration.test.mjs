import assert from 'node:assert/strict';
import test from 'node:test';

import {
    NVIDIA_VISUAL_MODELS,
    formatNvidiaVisualModels,
    generateNvidiaVisualImage,
    getNvidiaVisualConfig,
} from '../../src/features/ai/nvidiaVisualGeneration.js';

const ONE_PIXEL_PNG = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAusB9Y9Zl9sAAAAASUVORK5CYII=';

test('visual config uses the NVIDIA hosted visual base URL', () => {
    const config = getNvidiaVisualConfig({
        NVIDIA_API_KEY: 'secret',
    });

    assert.equal(config.apiKey, 'secret');
    assert.equal(config.baseUrl, 'https://ai.api.nvidia.com/v1/genai');
    assert.equal(config.defaultModel, 'auto');
    assert.equal(config.attemptTimeoutMs, 360_000);
    assert.equal(config.totalTimeoutMs, 1_200_000);
});

test('visual model guide includes ready-to-copy commands', () => {
    const output = formatNvidiaVisualModels();

    assert.match(output, /flux\.1-schnell/u);
    assert.match(output, /nvidia нарисуй <описание>/u);
    assert.match(output, /графика проверить/u);
    assert.equal(NVIDIA_VISUAL_MODELS.length >= 5, true);
});

test('automatic image generation skips unavailable endpoint and returns the next image', async () => {
    const originalFetch = globalThis.fetch;
    const urls = [];

    globalThis.fetch = async (url) => {
        urls.push(String(url));

        if (urls.length === 1) {
            return new Response(JSON.stringify({
                detail: 'Function not found for account',
            }), {
                status: 404,
                headers: { 'content-type': 'application/json' },
            });
        }

        return new Response(JSON.stringify({
            artifacts: [
                {
                    base64: ONE_PIXEL_PNG,
                    finishReason: 'SUCCESS',
                },
            ],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const result = await generateNvidiaVisualImage(
            getNvidiaVisualConfig({ NVIDIA_API_KEY: 'secret' }),
            'ночной Воронеж в стиле киберпанка',
            { model: 'auto' },
        );

        assert.equal(result.model, 'black-forest-labs/flux.1-dev');
        assert.equal(result.mimeType, 'image/png');
        assert.equal(result.buffer.length > 0, true);
        assert.equal(result.attempts.length, 1);
        assert.deepEqual(urls, [
            'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.2-klein-4b',
            'https://ai.api.nvidia.com/v1/genai/black-forest-labs/flux.1-dev',
        ]);
    } finally {
        globalThis.fetch = originalFetch;
    }
});


test('automatic image generation treats HTTP 504 as retryable and continues with the next model', async () => {
    const originalFetch = globalThis.fetch;
    const urls = [];
    const progress = [];

    globalThis.fetch = async (url) => {
        urls.push(String(url));

        if (urls.length === 1) {
            return new Response('', {
                status: 504,
            });
        }

        return new Response(JSON.stringify({
            artifacts: [
                {
                    base64: ONE_PIXEL_PNG,
                    finishReason: 'SUCCESS',
                },
            ],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const result = await generateNvidiaVisualImage(
            getNvidiaVisualConfig({ NVIDIA_API_KEY: 'secret' }),
            'ночной Воронеж в стиле киберпанка',
            {
                model: 'auto',
                onProgress: (event) => progress.push(event),
            },
        );

        assert.equal(result.model, 'black-forest-labs/flux.1-dev');
        assert.equal(result.attempts.length, 1);
        assert.equal(result.attempts[0].status, 504);
        assert.equal(progress.some((event) => event.stage === 'model_fallback' && event.nextModel === 'black-forest-labs/flux.1-dev'), true);
        assert.equal(urls.length, 2);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('legacy NVIDIA_IMAGE_TIMEOUT_MS remains an alias for the total command budget', () => {
    const config = getNvidiaVisualConfig({
        NVIDIA_API_KEY: 'secret',
        NVIDIA_IMAGE_TIMEOUT_MS: '420000',
    });

    assert.equal(config.attemptTimeoutMs, 360_000);
    assert.equal(config.totalTimeoutMs, 420_000);
});

test('explicit image model selector keeps the model but rotates key after three failures', async () => {
    const originalFetch = globalThis.fetch;
    const calls = [];

    globalThis.fetch = async (url, options = {}) => {
        const authorization = String(options?.headers?.Authorization || '');
        calls.push({ url: String(url), authorization });
        if (authorization === 'Bearer first-key') {
            return new Response(JSON.stringify({ detail: 'forbidden' }), {
                status: 403,
                headers: { 'content-type': 'application/json' },
            });
        }
        return new Response(JSON.stringify({
            artifacts: [{ base64: ONE_PIXEL_PNG, finishReason: 'SUCCESS' }],
        }), {
            status: 200,
            headers: { 'content-type': 'application/json' },
        });
    };

    try {
        const result = await generateNvidiaVisualImage(
            getNvidiaVisualConfig({
                NVIDIA_API_KEY: 'first-key',
                NVIDIA_API_KEY_2: 'second-key',
            }),
            'test',
            { model: 'flux.1-schnell' },
        );
        assert.equal(result.model, 'black-forest-labs/flux.1-schnell');
        assert.equal(calls.filter((row) => row.authorization === 'Bearer first-key').length, 3);
        assert.equal(calls.filter((row) => row.authorization === 'Bearer second-key').length, 1);
        assert.equal(new Set(calls.map((row) => row.url)).size, 1);
    } finally {
        globalThis.fetch = originalFetch;
    }
});

test('missing NVIDIA key fails before the network request', async () => {
    const originalFetch = globalThis.fetch;
    let called = false;
    globalThis.fetch = async () => {
        called = true;
        throw new Error('must not be called');
    };

    try {
        await assert.rejects(
            generateNvidiaVisualImage(
                getNvidiaVisualConfig({}),
                'test',
            ),
            /NVIDIA_API_KEY/u,
        );
        assert.equal(called, false);
    } finally {
        globalThis.fetch = originalFetch;
    }
});
