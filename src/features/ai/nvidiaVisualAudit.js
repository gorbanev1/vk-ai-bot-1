import { Buffer } from 'node:buffer';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
    NVIDIA_VISUAL_MODELS,
    generateNvidiaVisualImage,
    getNvidiaVisualConfig,
} from './nvidiaVisualGeneration.js';

export const NVIDIA_VISUAL_AUDIT_CATALOG = Object.freeze([
    {
        id: 'black-forest-labs/flux.2-klein-4b',
        label: 'FLUX.2 Klein 4B',
        generation: true,
        editing: true,
        note: 'Unified text-to-image + image editing/multi-reference editing.',
    },
    {
        id: 'black-forest-labs/flux.1-dev',
        label: 'FLUX.1 Dev',
        generation: true,
        editing: false,
        note: 'Quality text-to-image.',
    },
    {
        id: 'stabilityai/stable-diffusion-3-medium',
        label: 'Stable Diffusion 3 Medium',
        generation: true,
        editing: false,
        note: 'Text-to-image.',
    },
    {
        id: 'black-forest-labs/flux.1-schnell',
        label: 'FLUX.1 Schnell',
        generation: true,
        editing: false,
        note: 'Fast text-to-image.',
    },
    {
        id: 'stabilityai/stable-diffusion-xl',
        label: 'Stable Diffusion XL',
        generation: true,
        editing: false,
        note: 'Text-to-image.',
    },
    {
        id: 'black-forest-labs/flux.1-kontext-dev',
        label: 'FLUX.1 Kontext Dev',
        generation: false,
        editing: true,
        note: 'In-context image editing, consistency, inpainting/style transfer. NVIDIA preview may restrict image inputs.',
    },
]);

function clean(value) {
    return String(value ?? '').trim();
}

function parseImageFromPayload(payload) {
    const artifact = Array.isArray(payload?.artifacts) ? payload.artifacts[0] : null;
    const data = Array.isArray(payload?.data) ? payload.data[0] : null;
    const encoded = artifact?.base64 || artifact?.b64_json || data?.base64 || data?.b64_json || payload?.image || payload?.base64;
    if (!encoded) return null;
    const raw = clean(encoded).replace(/^data:image\/[a-z0-9.+-]+;base64,/iu, '');
    const buffer = Buffer.from(raw, 'base64');
    if (!buffer.length) return null;
    const mimeType = buffer[0] === 0xff && buffer[1] === 0xd8
        ? 'image/jpeg'
        : buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
            ? 'image/png'
            : 'image/jpeg';
    return { buffer, mimeType };
}

async function callEditEndpoint({ apiKey, modelId, prompt, imageDataUrl, timeoutMs }) {
    const endpoint = `https://ai.api.nvidia.com/v1/genai/${modelId}`;
    const body = modelId === 'black-forest-labs/flux.2-klein-4b'
        ? {
            mode: 'Image Editing',
            prompt,
            image: imageDataUrl,
            width: 1024,
            height: 1024,
            seed: 1,
            steps: 4,
        }
        : {
            prompt,
            image: imageDataUrl,
            width: 1024,
            height: 1024,
            cfg_scale: 3.5,
            samples: 1,
            seed: 1,
            steps: 30,
        };
    const startedAt = Date.now();
    let response;
    try {
        response = await fetch(endpoint, {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                Accept: 'application/json',
                'Content-Type': 'application/json',
            },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(timeoutMs),
        });
    } catch (error) {
        return {
            ok: false,
            model: modelId,
            operation: 'edit',
            status: 0,
            elapsedMs: Date.now() - startedAt,
            error: String(error?.message || error).slice(0, 600),
            buffer: null,
            mimeType: '',
        };
    }

    const raw = await response.text();
    let payload = {};
    try { payload = raw ? JSON.parse(raw) : {}; } catch { payload = { raw: raw.slice(0, 1000) }; }
    const image = response.ok ? parseImageFromPayload(payload) : null;
    const error = response.ok && image
        ? ''
        : clean(payload?.detail?.[0]?.msg || payload?.detail || payload?.error?.message || payload?.message || payload?.raw || (response.ok ? 'image missing in response' : `HTTP ${response.status}`)).slice(0, 600);

    return {
        ok: Boolean(response.ok && image),
        model: modelId,
        operation: 'edit',
        status: response.status,
        elapsedMs: Date.now() - startedAt,
        error,
        buffer: image?.buffer || null,
        mimeType: image?.mimeType || '',
    };
}

export async function runNvidiaVisualGenerationAudit({
    config = getNvidiaVisualConfig(),
    prompt,
    onProgress = null,
} = {}) {
    const results = [];
    const requestedPrompt = clean(prompt) || 'A cinematic cyberpunk night in Voronezh, neon reflections on wet asphalt, dramatic architecture, highly detailed, no text';
    const models = NVIDIA_VISUAL_AUDIT_CATALOG.filter((model) => model.generation);

    for (let index = 0; index < models.length; index += 1) {
        const model = models[index];
        onProgress?.({ stage: 'start', operation: 'generation', index: index + 1, total: models.length, model: model.id });
        const startedAt = Date.now();
        try {
            const generated = await generateNvidiaVisualImage(config, requestedPrompt, { model: model.id });
            const result = {
                ok: true,
                model: model.id,
                operation: 'generation',
                status: generated.status || 200,
                elapsedMs: generated.elapsedMs || Date.now() - startedAt,
                error: '',
                buffer: generated.buffer,
                mimeType: generated.mimeType,
            };
            results.push(result);
            onProgress?.({ stage: 'complete', ...result, buffer: undefined });
        } catch (error) {
            const result = {
                ok: false,
                model: model.id,
                operation: 'generation',
                status: Number(error?.status || 0),
                elapsedMs: Date.now() - startedAt,
                error: String(error?.message || error).slice(0, 600),
                buffer: null,
                mimeType: '',
            };
            results.push(result);
            onProgress?.({ stage: 'complete', ...result, buffer: undefined });
        }
    }

    return { operation: 'generation', prompt: requestedPrompt, results };
}

export async function runNvidiaVisualEditingAudit({
    config = getNvidiaVisualConfig(),
    prompt,
    imageDataUrl,
    onProgress = null,
} = {}) {
    const results = [];
    const instruction = clean(prompt) || 'Keep the composition and subject recognizable, change the scene to a cinematic rainy cyberpunk night, add subtle neon lighting, no text';
    const timeoutMs = Number(config?.attemptTimeoutMs || 360_000);

    for (let index = 0; index < NVIDIA_VISUAL_AUDIT_CATALOG.length; index += 1) {
        const model = NVIDIA_VISUAL_AUDIT_CATALOG[index];
        if (!model.editing) {
            const skipped = {
                ok: false,
                unsupported: true,
                model: model.id,
                operation: 'edit',
                status: 0,
                elapsedMs: 0,
                error: 'editing not declared by this hosted endpoint',
                buffer: null,
                mimeType: '',
            };
            results.push(skipped);
            onProgress?.({ stage: 'complete', ...skipped, buffer: undefined });
            continue;
        }

        onProgress?.({ stage: 'start', operation: 'edit', index: index + 1, total: NVIDIA_VISUAL_AUDIT_CATALOG.length, model: model.id });
        const result = await callEditEndpoint({
            apiKey: config.apiKey,
            modelId: model.id,
            prompt: instruction,
            imageDataUrl,
            timeoutMs,
        });
        results.push(result);
        onProgress?.({ stage: 'complete', ...result, buffer: undefined });
    }

    return { operation: 'edit', prompt: instruction, results };
}

export function formatNvidiaVisualAuditReport(audits) {
    const items = Array.isArray(audits) ? audits : [audits];
    const lines = [
        'NVIDIA VISUAL LIVE TEST REPORT',
        `checked_at=${new Date().toISOString()}`,
        'Tests are sequential. Same prompt is used for every model in each operation.',
        '',
    ];
    for (const audit of items.filter(Boolean)) {
        lines.push(`${String(audit.operation || '').toUpperCase()} prompt=${audit.prompt}`);
        for (const result of audit.results || []) {
            lines.push(
                `${result.ok ? 'OK' : result.unsupported ? 'SKIP' : 'FAIL'} ${result.model} status=${result.status || 0} elapsedMs=${result.elapsedMs}${result.buffer ? ` imageBytes=${result.buffer.length}` : ''}${result.error ? ` error=${result.error}` : ''}`,
            );
        }
        lines.push('');
    }
    return lines.join('\n').trimEnd() + '\n';
}

export async function writeNvidiaVisualAuditReport(audits, { directory = process.cwd() } = {}) {
    const textPath = resolve(directory, 'NVIDIA_VISUAL_LIVE_TEST_REPORT.txt');
    const serializable = (Array.isArray(audits) ? audits : [audits]).map((audit) => ({
        ...audit,
        results: (audit?.results || []).map(({ buffer, ...result }) => ({ ...result, imageBytes: buffer?.length || 0 })),
    }));
    const jsonPath = resolve(directory, 'NVIDIA_VISUAL_LIVE_TEST_REPORT.json');
    await writeFile(textPath, formatNvidiaVisualAuditReport(audits), 'utf8');
    await writeFile(jsonPath, JSON.stringify({ checkedAt: new Date().toISOString(), audits: serializable }, null, 2), 'utf8');
    return { textPath, jsonPath };
}

export function getNvidiaGenerationModelIds() {
    const configured = new Set(NVIDIA_VISUAL_MODELS.map((model) => model.id));
    return NVIDIA_VISUAL_AUDIT_CATALOG.filter((model) => model.generation && configured.has(model.id)).map((model) => model.id);
}
