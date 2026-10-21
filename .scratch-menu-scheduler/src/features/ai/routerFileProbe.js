/**
 * Bounded, explicit compatibility probe for third-party OpenAI-like /files routers.
 * Uploads ONLY a tiny fixture supplied by the caller; it never uploads the real project.
 * A successful upload is not proof of Responses/input_file/Code Interpreter support.
 */
import { createHash, randomUUID } from 'node:crypto';
import { openAsBlob, readFileSync, writeFileSync, renameSync, mkdirSync, statSync, unlinkSync } from 'node:fs';
import { resolve, basename } from 'node:path';

const CACHE_DIR = resolve('data/audit-jobs/router-file-probe-cache');
const PROBE_VARIANTS = Object.freeze([
    { id: 'standard-user-data', purpose: 'user_data' },
    { id: 'multipart-model', purpose: 'user_data', formModel: 'model' },
    { id: 'multipart-model-query-model', purpose: 'user_data', formModel: 'model', queryModel: 'model' },
    { id: 'query-model', purpose: 'user_data', queryModel: 'model' },
    { id: 'multipart-model-name-query-model-name', purpose: 'user_data', formModel: 'model_name', queryModel: 'model_name' },
    { id: 'multipart-model-name', purpose: 'user_data', formModel: 'model_name' },
    { id: 'assistants-model', purpose: 'assistants', formModel: 'model' },
    { id: 'assistants-standard', purpose: 'assistants' },
]);
export const ROUTER_FILE_PROBE_VARIANTS = PROBE_VARIANTS;

export function getRouterFileVariant(id) {
    return PROBE_VARIANTS.find((variant) => variant.id === id) || null;
}

export function routerFileProbeCachePath({ baseUrl, model, credentialName = '', apiKey = '' }) {
    // Changes to credentials invalidate the cached capability without storing the secret.
    const key = createHash('sha256').update([baseUrl, model, credentialName, apiKey].join('\u0000')).digest('hex');
    return resolve(CACHE_DIR, `${key}.json`);
}

export function saveRouterFileProbeCache(identity, result) {
    const variant = getRouterFileVariant(result?.variantId);
    if (!variant || !result?.fileId) throw new Error('ROUTER_PROBE_NO_CONFIRMED_FILE_ID');
    const path = routerFileProbeCachePath(identity);
    mkdirSync(CACHE_DIR, { recursive: true, mode: 0o700 });
    const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
    try {
        writeFileSync(temporary, `${JSON.stringify({
            version: 1,
            variantId: variant.id,
            model: String(identity.model),
            confirmedAt: new Date().toISOString(),
        }, null, 2)}\n`, { mode: 0o600, flag: 'wx' });
        renameSync(temporary, path);
    } catch (error) {
        try { unlinkSync(temporary); } catch {}
        throw error;
    }
    return path;
}

export function loadRouterFileProbeCache(identity) {
    try {
        const payload = JSON.parse(readFileSync(routerFileProbeCachePath(identity), 'utf8'));
        return payload?.version === 1 && payload?.model === identity.model
            ? getRouterFileVariant(payload.variantId)
            : null;
    } catch {
        return null;
    }
}

export function buildRouterFileUploadRequest({ baseUrl, apiKey, model, fileBlob, filename, variant, idempotencyKey = '' }) {
    const selected = typeof variant === 'string' ? getRouterFileVariant(variant) : variant;
    if (!selected || !getRouterFileVariant(selected.id)) throw new Error('ROUTER_PROBE_UNKNOWN_UPLOAD_VARIANT');
    const modelName = String(model || '').trim();
    if (!modelName) throw new Error('ROUTER_PROBE_MODEL_MISSING');
    const url = new URL(`${String(baseUrl || '').replace(/\/+$/gu, '')}/files`);
    if (selected.queryModel) url.searchParams.set(selected.queryModel, modelName);
    const form = new FormData();
    if (selected.formModel) form.append(selected.formModel, modelName);
    form.append('purpose', selected.purpose);
    form.append('file', fileBlob, filename);
    return {
        url: url.toString(),
        options: {
            method: 'POST',
            headers: {
                Authorization: `Bearer ${apiKey}`,
                ...(idempotencyKey ? { 'Idempotency-Key': idempotencyKey } : {}),
            },
            body: form,
        },
    };
}

function errorText(payload, raw) {
    return String(payload?.error?.message || payload?.message || raw || '')
        .replace(/Bearer\s+\S+/giu, 'Bearer [redacted]')
        .slice(0, 250);
}

export async function probeRouterFileUploads({
    baseUrl,
    apiKey,
    model,
    fixturePath,
    filename = 'router-capability-probe.zip',
    variants = PROBE_VARIANTS,
    fetchImpl = fetch,
    signal,
    onAttempt = () => {},
    timeoutMs = 60_000,
}) {
    const bytes = statSync(fixturePath).size;
    if (bytes < 1 || bytes > 64 * 1024) throw new Error('ROUTER_PROBE_REQUIRES_TINY_FIXTURE_UNDER_64_KIB');
    const attempts = [];
    for (const candidate of variants.slice(0, PROBE_VARIANTS.length)) {
        const variant = getRouterFileVariant(candidate?.id || candidate);
        if (!variant) throw new Error('ROUTER_PROBE_UNKNOWN_UPLOAD_VARIANT');
        if (signal?.aborted) throw signal.reason || new Error('ROUTER_PROBE_ABORTED');
        const blob = await openAsBlob(fixturePath, { type: 'application/zip' });
        const { url, options } = buildRouterFileUploadRequest({
            baseUrl, apiKey, model, fileBlob: blob, filename, variant,
            idempotencyKey: `router-probe:${randomUUID()}:${variant.id}`,
        });
        const controller = new AbortController();
        const timer = setTimeout(() => controller.abort(new Error('ROUTER_PROBE_UPLOAD_TIMEOUT')), Math.max(5_000, timeoutMs));
        let response;
        try {
            response = await fetchImpl(url, {
                ...options,
                signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
            });
        } catch (error) {
            clearTimeout(timer);
            attempts.push({ variant: variant.id, outcome: 'ambiguous-network-error', error: String(error?.message || error).slice(0, 160) });
            onAttempt(attempts.at(-1));
            return { ok: false, stopReason: 'ambiguous-network-error', attempts };
        }
        let raw = '';
        try { raw = (await response.text()).slice(0, 10_000); } catch (error) {
            clearTimeout(timer);
            attempts.push({ variant: variant.id, httpStatus: response.status, outcome: 'ambiguous-response-body' });
            onAttempt(attempts.at(-1));
            return { ok: false, stopReason: 'ambiguous-response-body', attempts };
        }
        clearTimeout(timer);
        let payload = {};
        try { payload = raw ? JSON.parse(raw) : {}; } catch {}
        const fileId = String(payload?.id ?? payload?.file_id ?? payload?.data?.id ?? '').trim();
        const item = { variant: variant.id, httpStatus: response.status, outcome: '', message: '' };
        if (response.ok && fileId) {
            item.outcome = 'confirmed-file-id';
            attempts.push(item);
            onAttempt(item);
            return { ok: true, variantId: variant.id, fileId, attempts };
        }
        if (response.ok || fileId) {
            item.outcome = 'ambiguous-upload-acceptance';
            item.message = errorText(payload, raw);
            attempts.push(item);
            onAttempt(item);
            return { ok: false, stopReason: 'ambiguous-upload-acceptance', attempts };
        }
        item.message = errorText(payload, raw);
        item.outcome = 'rejected';
        attempts.push(item);
        onAttempt(item);
        // Only explicit client-side rejection is safe to advance. In particular,
        // never switch variants after 429, 5xx, unknown network status, or 2xx without file_id.
        if (![400, 404, 405, 415, 422].includes(response.status)) {
            return { ok: false, stopReason: `http-${response.status}`, attempts };
        }
        if ([404, 405].includes(response.status)) {
            return { ok: false, stopReason: `endpoint-unsupported-${response.status}`, attempts };
        }
    }
    return { ok: false, stopReason: 'known-variants-exhausted', attempts };
}

/** One opt-in small PAID inference, with NO retry or mode fallback. */
export async function probeRouterInputFileOnce({
    baseUrl, apiKey, model, fileId, fetchImpl = fetch, signal, timeoutMs = 180_000,
}) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error('ROUTER_PROBE_RESPONSE_TIMEOUT')), Math.max(5_000, timeoutMs));
    let response;
    try {
        response = await fetchImpl(`${String(baseUrl).replace(/\/+$/gu, '')}/responses`, {
            method: 'POST',
            headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json', 'Idempotency-Key': `router-probe-inference:${randomUUID()}` },
            body: JSON.stringify({
                model,
                store: true,
                stream: false,
                max_output_tokens: 512,
                input: [{ role: 'user', content: [
                    { type: 'input_text', text: 'Это короткая проверка совместимости input_file ZIP. Назови единственное имя файла внутри ZIP. Не проводи аудит проекта.' },
                    { type: 'input_file', file_id: fileId },
                ] }],
            }),
            signal: signal ? AbortSignal.any([signal, controller.signal]) : controller.signal,
        });
    } catch (error) {
        clearTimeout(timer);
        return { status: 'ambiguous-response-post', error: String(error?.message || error).slice(0, 180) };
    }
    let raw = '';
    try { raw = (await response.text()).slice(0, 100_000); } catch {
        clearTimeout(timer);
        return { status: 'ambiguous-response-body', httpStatus: response.status };
    }
    clearTimeout(timer);
    let payload = {};
    try { payload = JSON.parse(raw); } catch {}
    const responseId = String(payload?.id ?? payload?.response?.id ?? '').trim();
    if (!response.ok) return { status: 'rejected', httpStatus: response.status, message: errorText(payload, raw) };
    // HTTP 200 alone does not establish that the inference completed.
    return {
        status: responseId || payload?.output_text || Array.isArray(payload?.output) ? 'response-accepted' : 'unknown-accepted-response',
        httpStatus: response.status,
        responseId,
        responseStatus: String(payload?.status || 'unknown'),
        ...(payload?.usage ? { usage: payload.usage } : {}),
    };
}
